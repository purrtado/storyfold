import { chat, toServerSentEventsResponse, EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { openaiCompatibleText } from "@tanstack/ai-openai/compatible";
import { ZAI_BASE_URL } from "./config";

export const MAX_CHAT_MESSAGES = 256;
export const MAX_MESSAGE_CHARS = 100_000;

export interface WireMessage {
  role: "user" | "assistant";
  content: string;
}

export type ChatMessagesResult =
  | { ok: true; messages: WireMessage[] }
  | { ok: false; error: string };

export function validateChatMessages(value: unknown): ChatMessagesResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, error: "Body must be an object with a messages array" };
  }
  const messages = (value as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: "messages must be a non-empty array" };
  }
  if (messages.length > MAX_CHAT_MESSAGES) {
    return { ok: false, error: `messages must contain at most ${MAX_CHAT_MESSAGES} items` };
  }

  const parsed: WireMessage[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) {
      return { ok: false, error: "each message must be an object" };
    }
    const { role, content } = message as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") {
      return { ok: false, error: "message role must be 'user' or 'assistant'" };
    }
    if (typeof content !== "string" || content.length === 0) {
      return { ok: false, error: "message content must be a non-empty string" };
    }
    if (content.length > MAX_MESSAGE_CHARS) {
      return { ok: false, error: `message content must be at most ${MAX_MESSAGE_CHARS} characters` };
    }
    parsed.push({ role, content });
  }
  if (parsed[parsed.length - 1].role !== "user") {
    return { ok: false, error: "the last message must be from the user" };
  }
  return { ok: true, messages: parsed };
}

interface SafeErrorPayload {
  message: string;
  code: string;
}

/**
 * Maps upstream failures to actionable-but-safe status classes. Messages are
 * constants: request URLs, response bodies and the stored API key can never
 * reach the client, whatever the provider returned.
 */
function classifyUpstreamError(status?: number, code?: string): SafeErrorPayload {
  // The SDK flattens HTTP statuses into string codes (e.g. "401").
  const statusFromCode = code !== undefined && /^\d{3}$/.test(code) ? Number(code) : undefined;
  const effectiveStatus = status ?? statusFromCode;
  const codeHint = code?.toLowerCase() ?? "";
  if (effectiveStatus === 401 || effectiveStatus === 403 || /auth|credential|permission|invalid_api_key/.test(codeHint)) {
    return {
      message: "The stored API key was rejected. Update it in Settings.",
      code: "credentials_rejected",
    };
  }
  if (effectiveStatus === 402 || effectiveStatus === 429 || /rate|quota|billing|usage_limit/.test(codeHint)) {
    return {
      message: "The provider is rate limited or out of quota. Try again later.",
      code: "quota_or_rate_limit",
    };
  }
  if ((effectiveStatus !== undefined && effectiveStatus >= 500) || /timeout|connection|network|unavailable/.test(codeHint)) {
    return {
      message: "The AI service is unavailable. Try again later.",
      code: "upstream_unavailable",
    };
  }
  return { message: "The AI request failed. Please try again.", code: "upstream_error" };
}

function errorDetail(error: unknown): { status?: number; code?: string } {
  if (typeof error !== "object" || error === null) return {};
  const detail: { status?: number; code?: string } = {};
  if ("status" in error && typeof error.status === "number") detail.status = error.status;
  if ("code" in error && typeof error.code === "string") detail.code = error.code;
  return detail;
}

function isAbortSignalError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "APIUserAbortError" || error.name === "RequestAbortedError")
  );
}

/**
 * Wraps the SDK run so the client only ever sees safe RUN_ERROR events: raw
 * provider errors are replaced with status-class messages, never forwarded,
 * and never logged (debug:false silences the SDK's default error logger).
 */
async function* sanitizeRunStream(
  inner: AsyncIterable<StreamChunk>,
  abortController: AbortController,
  onDone: () => void,
): AsyncGenerator<StreamChunk> {
  try {
    try {
      for await (const chunk of inner) {
        if (chunk.type === "RUN_ERROR") {
          const { message, code } = classifyUpstreamError(undefined, chunk.code ?? chunk.error?.code);
          yield { type: chunk.type, message, code, timestamp: chunk.timestamp ?? Date.now() };
          return;
        }
        yield chunk;
      }
    } catch (error) {
      if (abortController.signal.aborted || isAbortSignalError(error)) return;
      const detail = errorDetail(error);
      const { message, code } = classifyUpstreamError(detail.status, detail.code);
      yield { type: EventType.RUN_ERROR, message, code, timestamp: Date.now() };
    }
  } finally {
    onDone();
  }
}

export interface ZaiChatRequest {
  model: string;
  apiKey: string;
  messages: WireMessage[];
  /** Aborted when the HTTP client disconnects, cancelling the upstream call. */
  disconnectSignal?: AbortSignal;
  /** Injection point for tests; production uses the platform fetch. */
  upstreamFetch?: typeof fetch;
}

export function streamZaiChat(request: ZaiChatRequest): Response {
  const abortController = new AbortController();
  const disconnectSignal = request.disconnectSignal;
  const abortFromDisconnect = () => abortController.abort(disconnectSignal?.reason);
  if (disconnectSignal?.aborted) {
    abortFromDisconnect();
  } else {
    disconnectSignal?.addEventListener("abort", abortFromDisconnect, { once: true });
  }

  const adapter = openaiCompatibleText(request.model, {
    name: "zai",
    baseURL: ZAI_BASE_URL,
    apiKey: request.apiKey,
    api: "chat-completions",
    maxRetries: 0,
    ...(request.upstreamFetch ? { fetch: request.upstreamFetch } : {}),
  });

  const stream = chat({
    adapter,
    messages: request.messages,
    stream: true,
    abortController,
    debug: false,
  });

  return toServerSentEventsResponse(
    sanitizeRunStream(stream, abortController, () =>
      disconnectSignal?.removeEventListener("abort", abortFromDisconnect),
    ),
    { abortController, debug: false },
  );
}
