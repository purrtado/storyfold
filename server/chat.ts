import { chat, EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import type { ReasoningLevel } from "../shared/domain";
import type { ProviderApi } from "./providers";
import { adapterThinks } from "./reasoning";

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
  /context(_| )?(length|window|limit)|maximum context|too many (tokens|messages)|input.*(too long|exceeds)|prompt (is )?too long|token limit/i;

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
  // Anthropic's max_tokens stop is a cut-off reply, not a context overflow.
  if (code === "max_tokens") {
    return { message: "The narrator's reply was cut off before it finished. Try again.", code: "incomplete_generation" };
  }
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
  /** The chat id; the SDK's conversation id and prompt cache key. */
  threadId: string;
  api: ProviderApi;
  baseUrl: string;
  model: string;
  /** null for keyless local servers; no credential header is sent. */
  apiKey: string | null;
  /** Anthropic only; omitted means the model does not think. */
  reasoning?: ReasoningLevel;
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
function withoutCredentials(upstreamFetch: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("x-api-key");
    return upstreamFetch(input, { ...init, headers });
  }) as typeof fetch;
}

/**
 * Adaptive thinking for models outside the adapter's reasoning table: the
 * adapter ignores `chat({ reasoning })` for them and drops `thinking` from
 * modelOptions, so the fields go onto the Messages request body here.
 */
function withAdaptiveThinking(upstreamFetch: typeof fetch, effort: ReasoningLevel): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body !== "string") return upstreamFetch(input, init);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    const outputConfig = typeof body.output_config === "object" ? body.output_config : {};
    return upstreamFetch(input, {
      ...init,
      body: JSON.stringify({ ...body, thinking: { type: "adaptive", display: "summarized" }, output_config: { ...outputConfig, effort } }),
    });
  }) as typeof fetch;
}

function textAdapter(request: NarrationRunRequest) {
  const upstreamFetch = request.upstreamFetch ?? fetch;
  // The SDKs fall back to ambient env keys when none is given; a placeholder
  // keeps those secrets away from arbitrary provider hosts.
  const apiKey = request.apiKey ?? "keyless";
  const fetchImpl = request.apiKey === null ? withoutCredentials(upstreamFetch) : upstreamFetch;
  if (request.api === "anthropic") {
    const adapterReasoning = adapterThinks(request.model);
    return {
      adapter: createAnthropicChat(request.model as Parameters<typeof createAnthropicChat>[0], apiKey, {
        baseURL: request.baseUrl,
        // Stored keys are API keys; never reinterpret one as an OAuth token.
        auth: "api-key",
        maxRetries: 0,
        fetch: request.reasoning !== undefined && !adapterReasoning ? withAdaptiveThinking(fetchImpl, request.reasoning) : fetchImpl,
      }),
      reasoning: adapterReasoning ? request.reasoning : undefined,
    };
  }
  return {
    adapter: openaiCompatibleText(request.model, {
      baseURL: request.baseUrl,
      apiKey,
      api: "chat-completions",
      maxRetries: 0,
      fetch: fetchImpl,
    }),
    reasoning: undefined,
  };
}

/** Starts a sanitized chat-completions or Messages run for server-side consumption. */
export function startNarrationRun(request: NarrationRunRequest): NarrationRun {
  const abortController = request.abortController ?? new AbortController();
  const disconnectSignal = request.disconnectSignal;
  const abortFromDisconnect = () => abortController.abort(disconnectSignal?.reason);
  if (disconnectSignal?.aborted) {
    abortFromDisconnect();
  } else {
    disconnectSignal?.addEventListener("abort", abortFromDisconnect, { once: true });
  }

  const { adapter, reasoning } = textAdapter(request);

  const stream = chat({
    adapter,
    threadId: request.threadId,
    messages: request.messages,
    ...(request.systemPrompt !== undefined ? { systemPrompts: [request.systemPrompt] } : {}),
    ...(reasoning !== undefined ? { reasoning: { level: reasoning, summary: true } } : {}),
    stream: true,
    abortController,
    debug: false,
  });

  return {
    stream: sanitizeRunStream(stream, abortController),
    abortController,
  };
}
