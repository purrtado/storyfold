import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import {
  headersWith,
  makeConfigDirectory,
  openAiChatCompletionSse,
  removeDirectory,
  startTestServer,
  type TestServer,
} from "./helpers";

const API_KEY = "sk-zai-stream-test-key";
const TRUSTED_ORIGIN = "http://localhost:5173";
const ZAI_CHAT_COMPLETIONS_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions";

let server: TestServer;
let configDirectory: string;

beforeAll(async () => {
  configDirectory = await makeConfigDirectory();
  server = await startTestServer({ configDirectory });
  const created = await fetch(`${server.url}/api/provider`, {
    method: "PUT",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify({ model: "glm-5.3", api_key: API_KEY }),
  });
  expect(created.status).toBe(200);
});

afterAll(async () => {
  await server?.stop();
  if (configDirectory) await removeDirectory(configDirectory);
});

function chatRequest(base: string, messages: Array<{ role: string; content: string }>): Promise<Response> {
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify({ messages }),
  });
}

function parseSseEvents(raw: string): StreamChunk[] {
  return raw
    .split("\n\n")
    .flatMap((frame) => frame.split("\n").filter((line) => line.startsWith("data: ")))
    .map((line) => line.slice("data: ".length))
    .filter((data) => data.length > 0 && data !== "[DONE]")
    .map((data) => JSON.parse(data) as StreamChunk);
}

describe("Z.AI chat-completions streaming", () => {
  test("streams to the fixed Z.AI chat-completions endpoint with stored key and model", async () => {
    const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
    const upstream = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input, init });
      return new Response(openAiChatCompletionSse("glm-5.3", ["Hello", " world"]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const serverWithUpstream = await startTestServer({ configDirectory, upstreamFetch: upstream });
    try {
      const response = await chatRequest(serverWithUpstream.url, [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello there" },
        { role: "user", content: "say hello world" },
      ]);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");

      expect(calls.length).toBe(1);
      const { input, init } = calls[0];
      expect(String(input)).toBe(ZAI_CHAT_COMPLETIONS_URL);
      const upstreamHeaders = new Headers(init?.headers);
      expect(upstreamHeaders.get("authorization")).toBe(`Bearer ${API_KEY}`);

      const raw = await response.text();
      expect(raw).not.toContain(API_KEY);
      const events = parseSseEvents(raw);
      const types = events.map((event) => event.type);
      expect(types[0]).toBe(EventType.RUN_STARTED);
      expect(types).toContain(EventType.TEXT_MESSAGE_START);
      expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
      expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
      const text = events
        .filter(
          (event): event is Extract<StreamChunk, { type: "TEXT_MESSAGE_CONTENT" }> =>
            event.type === "TEXT_MESSAGE_CONTENT",
        )
        .map((event) => event.delta)
        .join("");
      expect(text).toBe("Hello world");
    } finally {
      await serverWithUpstream.stop();
    }
  });

  test("upstream failures end with one redacted RUN_ERROR and never a normal finish", async () => {
    for (const status of [401, 429, 500]) {
      const upstream = (async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(`{"error":{"message":"upstream-secret-detail key=${API_KEY}"}}`, {
          status,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      const serverWithUpstream = await startTestServer({ configDirectory, upstreamFetch: upstream });
      try {
        const response = await chatRequest(serverWithUpstream.url, [{ role: "user", content: "hi" }]);
        expect(response.status).toBe(200);
        const raw = await response.text();
        expect(raw).not.toContain(API_KEY);
        expect(raw).not.toContain("upstream-secret-detail");

        const events = parseSseEvents(raw);
        expect(events[events.length - 1].type).toBe(EventType.RUN_ERROR);
        expect(events.some((event) => event.type === "RUN_FINISHED")).toBe(false);
      } finally {
        await serverWithUpstream.stop();
      }
    }
  });

  test("client disconnect aborts the upstream request", async () => {
    const abortObserved = Promise.withResolvers<void>();
    let upstreamSignal: AbortSignal | null | undefined;
    const roleFrame = `data: ${JSON.stringify({
      id: "chatcmpl-hang",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model: "glm-5.3",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}\n\n`;
    const upstream = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamSignal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(roleFrame));
          // Pending until aborted: resolution proves the cancellation chain.
          init?.signal?.addEventListener(
            "abort",
            () => {
              controller.close();
              abortObserved.resolve();
            },
            { once: true },
          );
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const serverWithUpstream = await startTestServer({ configDirectory, upstreamFetch: upstream });
    try {
      const response = await chatRequest(serverWithUpstream.url, [{ role: "user", content: "hi" }]);
      expect(response.status).toBe(200);

      const reader = response.body!.getReader();
      await reader.cancel();
      await abortObserved.promise;
      expect(upstreamSignal?.aborted).toBe(true);
    } finally {
      await serverWithUpstream.stop();
    }
  });
});
