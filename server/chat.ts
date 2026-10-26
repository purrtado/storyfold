import { chat, EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";

export const MAX_MESSAGE_CHARS = 100_000;

/** One history entry for the model: player input or completed narration. */
export interface NarrationMessage {
  role: "user" | "assistant";
  content: string;
}

interface SafeErrorPayload {
  message: string;
  code: string;
}

const CONTEXT_HINTS =
  /context(_| )?(length|window|limit)|maximum context|too many (tokens|messages)|input.*(too long|exceeds)|prompt too long|token limit/i;

/**
 * Maps upstream failures to actionable-but-safe status classes. Messages are
 * constants: request URLs, response bodies and the stored API key can never
 * reach the client, whatever the provider returned. Context-limit errors are
 * matched specifically (by code or provider message), never inferred from a
 * bare HTTP 400.
 */
function classifyUpstreamError(status?: number, code?: string, text?: string): SafeErrorPayload {
  // The SDK flattens HTTP statuses into string codes (e.g. "401").
  const statusFromCode = code !== undefined && /^\d{3}$/.test(code) ? Number(code) : undefined;
  const effectiveStatus = status ?? statusFromCode;
  const hint = `${code ?? ""} ${text ?? ""}`;
  if (CONTEXT_HINTS.test(hint)) {
    return {
      message:
        "This story no longer fits the model's context window. Choose a model with a larger context in Settings, or start a new chat.",
      code: "context_limit",
    };
  }
  if (effectiveStatus === 401 || effectiveStatus === 403 || /auth|credential|permission|invalid_api_key/.test(hint.toLowerCase())) {
    return {
      message: "The stored API key was rejected. Update it in Settings.",
      code: "credentials_rejected",
    };
  }
  if (effectiveStatus === 402 || effectiveStatus === 429 || /rate|quota|billing|usage_limit/.test(hint.toLowerCase())) {
    return {
      message: "The provider is rate limited or out of quota. Try again later.",
      code: "quota_or_rate_limit",
    };
  }
  if ((effectiveStatus !== undefined && effectiveStatus >= 500) || /timeout|connection|network|unavailable/.test(hint.toLowerCase())) {
    return {
      message: "The AI service is unavailable. Try again later.",
      code: "upstream_unavailable",
    };
  }
  return { message: "The AI request failed. Please try again.", code: "upstream_error" };
}

function errorDetail(error: unknown): { status?: number; code?: string; message?: string } {
  if (typeof error !== "object" || error === null) return {};
  const detail: { status?: number; code?: string; message?: string } = {};
  if ("status" in error && typeof error.status === "number") detail.status = error.status;
  if ("code" in error && typeof error.code === "string") detail.code = error.code;
  if ("message" in error && typeof error.message === "string") detail.message = error.message;
  return detail;
}

function isAbortSignalError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "APIUserAbortError" || error.name === "RequestAbortedError")
  );
}

/**
 * Consumer-visible finish reason. This SDK version moves the adapter's finish
 * reason into `metadata.tanstack` rather than the chunk field, so read it with
 * runtime guards and fall back to the typed field for future versions.
 */
function runFinishReason(chunk: StreamChunk): string | undefined {
  if (chunk.type !== EventType.RUN_FINISHED) return undefined;
  if (typeof chunk.finishReason === "string") return chunk.finishReason;
  const metadata = chunk.metadata;
  if (typeof metadata !== "object" || metadata === null || !("tanstack" in metadata)) return undefined;
  const tanstack = metadata.tanstack;
  if (typeof tanstack !== "object" || tanstack === null || !("finishReason" in tanstack)) return undefined;
  const finishReason = tanstack.finishReason;
  return typeof finishReason === "string" ? finishReason : undefined;
}

/**
 * Wraps the SDK run so the consumer only ever sees safe RUN_ERROR events: raw
 * provider errors are replaced with status-class messages, never forwarded,
 * and never logged (debug:false silences the SDK's default error logger).
 *
 * Terminal evidence: the adapter validates the raw stream itself — a clean
 * truncation or a [DONE] without finish_reason surfaces as RUN_ERROR, never as
 * a synthesized finish. A RUN_FINISHED still needs finishReason "stop": length,
 * content_filter and tool_calls finishes are rewritten to a safe
 * incomplete-generation RUN_ERROR so partial narration can never complete.
 */
async function* sanitizeRunStream(
  inner: AsyncIterable<StreamChunk>,
  abortController: AbortController,
): AsyncGenerator<StreamChunk> {
  try {
    for await (const chunk of inner) {
      if (chunk.type === "RUN_ERROR") {
        const { message, code } = classifyUpstreamError(
          undefined,
          chunk.code ?? chunk.error?.code,
          chunk.message ?? chunk.error?.message,
        );
        yield { type: chunk.type, message, code, timestamp: chunk.timestamp ?? Date.now() };
        return;
      }
      if (chunk.type === EventType.RUN_FINISHED) {
        if (runFinishReason(chunk) === "stop") {
          yield chunk;
          return;
        }
        yield {
          type: EventType.RUN_ERROR,
          message: "The narrator's reply was cut off before it finished. Try again.",
          code: "incomplete_generation",
          timestamp: Date.now(),
        };
        return;
      }
      yield chunk;
    }
  } catch (error) {
    if (abortController.signal.aborted || isAbortSignalError(error)) return;
    const detail = errorDetail(error);
    const { message, code } = classifyUpstreamError(detail.status, detail.code, detail.message);
    yield { type: EventType.RUN_ERROR, message, code, timestamp: Date.now() };
  }
}

export interface NarrationRunRequest {
  baseUrl: string;
  model: string;
  /** null for keyless local servers; no Authorization header is sent. */
  apiKey: string | null;
  /** Fixed grounding instructions; prepended via the SDK's systemPrompts. */
  systemPrompt?: string;
  messages: NarrationMessage[];
  /** Aborted when the HTTP client disconnects, cancelling the upstream call. */
  disconnectSignal?: AbortSignal;
  /** Shared lifecycle controller (Stop/disconnect/SSE); created when omitted. */
  abortController?: AbortController;
  /** Injection point for tests; production uses the platform fetch. */
  upstreamFetch?: typeof fetch;
}

export interface NarrationRun {
  stream: AsyncIterable<StreamChunk>;
  abortController: AbortController;
}

/** Strips the placeholder credential the SDK insists on for keyless providers. */
function withoutAuthorization(upstreamFetch: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    return upstreamFetch(input, { ...init, headers });
  }) as typeof fetch;
}

/** Starts a sanitized OpenAI-compatible chat-completions run for server-side consumption. */
export function startNarrationRun(request: NarrationRunRequest): NarrationRun {
  const abortController = request.abortController ?? new AbortController();
  const disconnectSignal = request.disconnectSignal;
  const abortFromDisconnect = () => abortController.abort(disconnectSignal?.reason);
  if (disconnectSignal?.aborted) {
    abortFromDisconnect();
  } else {
    disconnectSignal?.addEventListener("abort", abortFromDisconnect, { once: true });
  }

  const upstreamFetch = request.upstreamFetch ?? fetch;
  const adapter = openaiCompatibleText(request.model, {
    baseURL: request.baseUrl,
    // The SDK falls back to OPENAI_API_KEY when no key is given; a placeholder
    // keeps that ambient secret away from arbitrary provider hosts.
    apiKey: request.apiKey ?? "keyless",
    api: "chat-completions",
    maxRetries: 0,
    fetch: request.apiKey === null ? withoutAuthorization(upstreamFetch) : upstreamFetch,
  });

  const stream = chat({
    adapter,
    messages: request.messages,
    ...(request.systemPrompt !== undefined ? { systemPrompts: [request.systemPrompt] } : {}),
    stream: true,
    abortController,
    debug: false,
  });

  return {
    stream: sanitizeRunStream(stream, abortController),
    abortController,
  };
}
