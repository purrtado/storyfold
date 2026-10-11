import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type CreateAppOptions } from "../app";

export interface TestServer {
  url: string;
  stop: () => Promise<void>;
}

export async function startTestServer(options: CreateAppOptions = {}): Promise<TestServer> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createApp(options),
  });
  return {
    // Bun exposes Server.url as a URL with a trailing slash; the origin keeps
    // call sites concatenation-safe.
    url: server.url.origin,
    stop: async () => {
      await server.stop(true);
    },
  };
}

export async function makeConfigDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "storyfold-test-"));
}

export async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

/**
 * Every test request must present a Host inside the server allowlist; without
 * this Bun sends 127.0.0.1:<ephemeral port>, which the app rightly rejects.
 */
export function headersWith(extra: Record<string, string> = {}): Record<string, string> {
  return { host: "127.0.0.1:3001", ...extra };
}

/** Protocol-real OpenAI chat-completions SSE body for one streamed reply. */
export function openAiChatCompletionSse(model: string, deltas: string[]): string {
  const frames = [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    },
    ...deltas.map((content) => ({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    })),
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    },
  ];
  const sse = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return `${sse}data: [DONE]\n\n`;
}

