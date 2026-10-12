import { describe, expect, test } from "bun:test";
import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { startZaiRun } from "../chat";
import { openAiChatCompletionSse, openAiChatCompletionSseRaw } from "./helpers";

const API_KEY = "sk-zai-transport-test-key";
const ZAI_CHAT_COMPLETIONS_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions";

function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  return (async () => {
    const events: StreamChunk[] = [];
    for await (const event of stream) events.push(event);
    return events;
  })();
}

function textOf(events: StreamChunk[]): string {
  return events
    .filter((event): event is Extract<StreamChunk, { type: "TEXT_MESSAGE_CONTENT" }> => event.type === "TEXT_MESSAGE_CONTENT")
    .map((event) => event.delta)
    .join("");
}

describe("Z.AI transport (startZaiRun)", () => {
  test("streams from the fixed chat-completions endpoint with bearer key and full grounding", async () => {
    const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
    const upstream = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(openAiChatCompletionSse("glm-5.3", ["Hello", " world"]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const run = startZaiRun({
      model: "glm-5.3",
      apiKey: API_KEY,
      systemPrompt: "You are the narrator. World — Veloria.",
      messages: [
        { role: "user", content: "Begin the opening scene." },
        { role: "assistant", content: "Dawn broke over the harbor." },
        { role: "user", content: "I scan the docks." },
      ],
      upstreamFetch: upstream,
    });
    const events = await collect(run.stream);

    expect(calls.length).toBe(1);
    expect(String(calls[0].input)).toBe(ZAI_CHAT_COMPLETIONS_URL);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    const body = JSON.parse(String(calls[0].init?.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("glm-5.3");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Veloria");
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "I scan the docks." });

    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(textOf(events)).toBe("Hello world");
  });

  test("upstream failures end with one redacted safe RUN_ERROR and never a finish", async () => {
    for (const status of [401, 429, 500]) {
      const upstream = (async (
        _input: string | URL | Request,
        _init?: RequestInit,
      ) =>
        new Response(`{"error":{"message":"upstream-secret-detail key=${API_KEY}"}}`, {
          status,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      const run = startZaiRun({
        model: "glm-5.3",
        apiKey: API_KEY,
        messages: [{ role: "user", content: "hi" }],
        upstreamFetch: upstream,
      });
      const events = await collect(run.stream);
      expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
      const last = events.at(-1) as Extract<StreamChunk, { type: typeof EventType.RUN_ERROR }>;
      expect(last.message).not.toContain(API_KEY);
      expect(last.message).not.toContain("upstream-secret-detail");
      expect(events.some((event) => event.type === "RUN_FINISHED")).toBe(false);
    }
  });

  test("context-limit failures classify specifically; generic 400s stay generic", async () => {
    const contextUpstream = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      new Response(
        `{"error":{"message":"This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens."}}`,
        { status: 400, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const contextRun = startZaiRun({
      model: "glm-5.3",
      apiKey: API_KEY,
      messages: [{ role: "user", content: "hi" }],
      upstreamFetch: contextUpstream,
    });
    const contextEvents = await collect(contextRun.stream);
    const contextError = contextEvents.at(-1) as Extract<StreamChunk, { type: typeof EventType.RUN_ERROR }>;
    expect(contextError.code).toBe("context_limit");

    const genericUpstream = (async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) =>
      new Response(`{"error":{"message":"something was invalid"}}`, {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const genericRun = startZaiRun({
      model: "glm-5.3",
      apiKey: API_KEY,
      messages: [{ role: "user", content: "hi" }],
      upstreamFetch: genericUpstream,
    });
    const genericEvents = await collect(genericRun.stream);
    const genericError = genericEvents.at(-1) as Extract<StreamChunk, { type: typeof EventType.RUN_ERROR }>;
    expect(genericError.code).toBe("upstream_error");
  });

  // Disconnect abort propagation is proven end-to-end in play.test.ts, which
  // consumes the SSE response the way the browser does.

  test("aborted runs end silently without a terminal event", async () => {
    const disconnect = new AbortController();
    const upstream = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const run = startZaiRun({
      model: "glm-5.3",
      apiKey: API_KEY,
      messages: [{ role: "user", content: "hi" }],
      disconnectSignal: disconnect.signal,
      upstreamFetch: upstream,
    });
    const events = await (async () => {
      const draining = collect(run.stream);
      disconnect.abort();
      return draining;
    })();
    expect(events.at(-1)?.type).not.toBe(EventType.RUN_ERROR);
    expect(events.at(-1)?.type).not.toBe(EventType.RUN_FINISHED);
  });
});

describe("completion evidence (raw protocol)", () => {
  async function eventsFor(sse: string): Promise<StreamChunk[]> {
    const upstream = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const run = startZaiRun({
      model: "glm-5.3",
      apiKey: API_KEY,
      messages: [{ role: "user", content: "hi" }],
      upstreamFetch: upstream,
    });
    return collect(run.stream);
  }

  test("clean truncated EOF with partial text never completes: failed with safe terminal", async () => {
    const events = await eventsFor(openAiChatCompletionSseRaw("glm-5.3", ["The door", " creaks"], null));
    const text = textOf(events);
    expect(text).toBe("The door creaks");
    const last = events.at(-1) as Extract<StreamChunk, { type: typeof EventType.RUN_ERROR }>;
    // The SDK surfaces a clean mid-stream EOF as an error, so the wrapper
    // guarantees a failed terminal either way; never RUN_FINISHED.
    expect(last.type).toBe(EventType.RUN_ERROR);
    expect(["incomplete_generation", "upstream_error"].includes(last.code ?? "")).toBe(true);
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
  });

  test("finish_reason length is not a normal finish: incomplete RUN_ERROR", async () => {
    const events = await eventsFor(openAiChatCompletionSseRaw("glm-5.3", ["Once upon"], "length"));
    const last = events.at(-1);
    expect(last?.type).toBe(EventType.RUN_ERROR);
    expect((last as Extract<StreamChunk, { type: typeof EventType.RUN_ERROR }>).code).toBe("incomplete_generation");
    expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
  });

  test("finish_reason stop with [DONE] completes normally", async () => {
    const events = await eventsFor(openAiChatCompletionSseRaw("glm-5.3", ["All quiet."], "stop"));
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(textOf(events)).toBe("All quiet.");
  });
});
