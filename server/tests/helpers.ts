import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamChunk } from "@tanstack/ai";
import { createApp, type CreateAppOptions } from "../app";
import { SERVER_PORT } from "../runtime";

export interface TestServer {
  url: string;
  stop: () => Promise<void>;
}

export async function startTestServer(options: CreateAppOptions = {}): Promise<TestServer> {
  // No test may touch the real workspace: when the caller provides no database
  // placement at all, the server gets a throwaway file that stop() removes.
  let ownedDirectory: string | null = null;
  const placement = {
    ...(options.database ? { database: options.database } : {}),
    ...(options.databasePath ? { databasePath: options.databasePath } : {}),
    ...(options.dataDirectory ? { dataDirectory: options.dataDirectory } : {}),
  };
  if (Object.keys(placement).length === 0) {
    ownedDirectory = await makeConfigDirectory();
    placement.databasePath = join(ownedDirectory, "test.db");
  }

  const app = createApp({ ...options, ...placement });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Match the production server: SSE responses may sit unconsumed or pause.
    idleTimeout: 0,
    fetch: app.fetch,
  });
  return {
    // Bun exposes Server.url as a URL with a trailing slash; the origin keeps
    // call sites concatenation-safe.
    url: server.url.origin,
    stop: async () => {
      await server.stop(true);
      app.close();
      if (ownedDirectory) await removeDirectory(ownedDirectory);
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
  return { host: `127.0.0.1:${SERVER_PORT}`, ...extra };
}

/** Adds one keyed provider and selects `model` on it; returns the provider id. */
export async function configureProvider(serverUrl: string, apiKey: string, model = "glm-5.3"): Promise<string> {
  const headers = headersWith({ origin: "http://localhost:5173", "content-type": "application/json" });
  const created = await fetch(`${serverUrl}/api/providers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Test provider", base_url: "https://provider.test/v1", api_key: apiKey }),
  });
  if (created.status !== 201) throw new Error(`provider setup failed: HTTP ${created.status}`);
  const { provider } = (await created.json()) as { provider: { id: string } };
  const selected = await fetch(`${serverUrl}/api/model-selection`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ provider_id: provider.id, model }),
  });
  if (selected.status !== 200) throw new Error(`model selection failed: HTTP ${selected.status}`);
  return provider.id;
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
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_tokens_details: { cached_tokens: 2 } },
    },
  ];
  const sse = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return `${sse}data: [DONE]\n\n`;
}

/** Parses a TanStack AI SSE response body back into its chunk objects. */
export function parseSseEvents(raw: string): StreamChunk[] {
  return raw
    .split("\n\n")
    .flatMap((frame) => frame.split("\n").filter((line) => line.startsWith("data: ")))
    .map((line) => line.slice("data: ".length))
    .filter((data) => data.length > 0 && data !== "[DONE]")
    .map((data) => JSON.parse(data) as StreamChunk);
}

/**
 * Raw chat-completions SSE with an explicit terminal shape: finish "stop" or
 * "length" ends with a finish_reason frame plus [DONE]; null ends the stream
 * cleanly with neither, simulating a truncated upstream.
 */
export function openAiChatCompletionSseRaw(
  model: string,
  deltas: string[],
  finish: "stop" | "length" | null,
): string {
  const frame = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
  const parts = [
    frame({
      id: "chatcmpl-raw",
      object: "chat.completion.chunk",
      created: 1_700_000_000,
      model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }),
    ...deltas.map((content) =>
      frame({
        id: "chatcmpl-raw",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      }),
    ),
  ];
  if (finish !== null) {
    parts.push(
      frame({
        id: "chatcmpl-raw",
        object: "chat.completion.chunk",
        created: 1_700_000_000,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
      }),
      "data: [DONE]\n\n",
    );
  }
  return parts.join("");
}

/** Protocol-real Anthropic Messages SSE body for one streamed reply. */
export function anthropicMessagesSse(model: string, deltas: string[], stopReason: "end_turn" | "max_tokens" = "end_turn"): string {
  const event = (type: string, body: unknown) => `event: ${type}\ndata: ${JSON.stringify({ type, ...(body as object) })}\n\n`;
  return [
    event("message_start", {
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 2, output_tokens: 1 },
      },
    }),
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
    ...deltas.map((text) => event("content_block_delta", { index: 0, delta: { type: "text_delta", text } })),
    event("content_block_stop", { index: 0 }),
    event("message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 3 } }),
    event("message_stop", {}),
  ].join("");
}

