import { describe, expect, test } from "bun:test";
import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import type { ReasoningLevel } from "../../shared/domain";
import { startNarrationRun } from "../chat";
import { anthropicMessagesSse, openAiChatCompletionSseRaw } from "./helpers";

const API_KEY = "sk-zai-transport-test-key";

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

describe("provider transport (startNarrationRun)", () => {
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
      const run = startNarrationRun({
        threadId: "chat-test",
        api: "openai",
        baseUrl: "https://provider.test/v1",
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
    const contextRun = startNarrationRun({
      threadId: "chat-test",
      api: "openai",
      baseUrl: "https://provider.test/v1",
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
    const genericRun = startNarrationRun({
      threadId: "chat-test",
      api: "openai",
      baseUrl: "https://provider.test/v1",
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
    const run = startNarrationRun({
      threadId: "chat-test",
      api: "openai",
      baseUrl: "https://provider.test/v1",
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
    const run = startNarrationRun({
      threadId: "chat-test",
      api: "openai",
      baseUrl: "https://provider.test/v1",
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

describe("Anthropic Messages transport", () => {
  function anthropicRun(sse: string, apiKey: string | null, reasoning?: ReasoningLevel) {
    const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    const upstream = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const run = startNarrationRun({
      threadId: "chat-test",
      api: "anthropic",
      baseUrl: "https://anthropic.test",
      model: "claude-haiku-5-5",
      apiKey,
      reasoning,
      systemPrompt: "You narrate.",
      messages: [
        { role: "user", content: "I open the door." },
        { role: "assistant", content: "It creaks." },
        { role: "user", content: "I step inside." },
      ],
      upstreamFetch: upstream,
    });
    return { calls, events: collect(run.stream) };
  }

  test("streams from /v1/messages with the key and caches the system prompt and conversation", async () => {
    const { calls, events } = anthropicRun(anthropicMessagesSse("claude-haiku-5-5", ["The hall", " is dark."]), API_KEY);
    const received = await events;
    expect(received.at(-1)?.type).toBe(EventType.RUN_FINISHED);
    expect(textOf(received)).toBe("The hall is dark.");

    expect(calls[0].url.split("?")[0]).toBe("https://anthropic.test/v1/messages");
    expect(calls[0].headers.get("x-api-key")).toBe(API_KEY);
    expect(calls[0].headers.get("authorization")).toBeNull();
    const body = calls[0].body as {
      system: Array<{ type: string; text: string; cache_control?: unknown }>;
      messages: Array<{ role: string; content: Array<{ text: string; cache_control?: unknown }> }>;
    };
    expect(body.system).toEqual([{ type: "text", text: "You narrate.", cache_control: { type: "ephemeral" } }]);
    const last = body.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content.at(-1)).toMatchObject({ text: "I step inside.", cache_control: { type: "ephemeral" } });
  });

  test("keyless providers send no credential header", async () => {
    const { calls, events } = anthropicRun(anthropicMessagesSse("claude-haiku-5-5", ["Hi."]), null);
    await events;
    expect(calls[0].headers.get("x-api-key")).toBeNull();
    expect(calls[0].headers.get("authorization")).toBeNull();
  });

  test("a max_tokens stop is an incomplete reply, not a context overflow", async () => {
    const { events } = anthropicRun(anthropicMessagesSse("claude-haiku-5-5", ["Once upon"], "max_tokens"), API_KEY);
    const received = await events;
    const last = received.at(-1) as Extract<StreamChunk, { type: typeof EventType.RUN_ERROR }>;
    expect(last.type).toBe(EventType.RUN_ERROR);
    expect(last.code).toBe("incomplete_generation");
  });

  test("a thinking level asks for summarized thinking; none sends no thinking field", async () => {
    const thinking = anthropicRun(anthropicMessagesSse("claude-haiku-5-5", ["Hi."]), API_KEY, "high");
    await thinking.events;
    expect(thinking.calls[0].body.thinking).toEqual({ type: "adaptive", display: "summarized" });

    const plain = anthropicRun(anthropicMessagesSse("claude-haiku-5-5", ["Hi."]), API_KEY);
    await plain.events;
    expect(plain.calls[0].body).not.toHaveProperty("thinking");
  });
});
