import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import type { Chat, Message } from "../../shared/domain";
import { openingMessage } from "../../shared/narration";
import { openDatabase } from "../db";
import { AlreadyOpenedError, PlayService } from "../play";
import {
  configureProvider,
  headersWith,
  makeConfigDirectory,
  openAiChatCompletionSse,
  parseSseEvents,
  removeDirectory,
  startTestServer,
  type TestServer,
} from "./helpers";

const API_KEY = "sk-zai-play-test-key";
const TRUSTED_ORIGIN = "http://localhost:5173";

let configDirectory: string;
let databasePath: string;
let base: TestServer;
let providerId: string;

beforeAll(async () => {
  configDirectory = await makeConfigDirectory();
  databasePath = join(configDirectory, "play.db");
  base = await startTestServer({ configDirectory, databasePath });
  providerId = await configureProvider(base.url, API_KEY);
});

afterAll(async () => {
  await base?.stop();
  if (configDirectory) await removeDirectory(configDirectory);
});

const OPENING_TEXT = "Sable docks at dawn while the harbor bells ring.";

function jsonRequest(serverBase: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${serverBase}${path}`, {
    method,
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function seedStory(
  serverBase: string,
): Promise<{ chat: Chat; worldId: string; protagonistId: string }> {
  const world = await jsonRequest(serverBase, "POST", "/api/worlds", {
    name: "Veloria",
    setting_brief: "A rain-soaked harbor kingdom of rival ferries.",
  });
  expect(world.status).toBe(201);
  const { world: created } = (await world.json()) as { world: { id: string } };
  const protagonist = await jsonRequest(serverBase, "POST", `/api/worlds/${created.id}/characters`, {
    name: "Sable",
    description: "A cynical ferrywoman spy.",
    thoughts: "Never trust a man who pays in advance.",
  });
  expect(protagonist.status).toBe(201);
  const { character } = (await protagonist.json()) as { character: { id: string } };
  const chat = await jsonRequest(serverBase, "POST", `/api/worlds/${created.id}/chats`, {
    protagonist_id: character.id,
    opening: OPENING_TEXT,
  });
  expect(chat.status).toBe(201);
  return {
    chat: ((await chat.json()) as { chat: Chat }).chat,
    worldId: created.id,
    protagonistId: character.id,
  };
}

function postMessage(serverBase: string, chatId: string, body: unknown): Promise<Response> {
  return fetch(`${serverBase}/api/chats/${chatId}/messages`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

function postOpening(serverBase: string, chatId: string, body: unknown = {}): Promise<Response> {
  return fetch(`${serverBase}/api/chats/${chatId}/opening`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

function postRegenerate(serverBase: string, chatId: string, body: unknown = {}): Promise<Response> {
  return fetch(`${serverBase}/api/chats/${chatId}/regenerate`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

function selectVariant(serverBase: string, chatId: string, messageId: string): Promise<Response> {
  return fetch(`${serverBase}/api/chats/${chatId}/messages/${messageId}/select`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN }),
  });
}

function deleteMessage(
  serverBase: string,
  chatId: string,
  messageId: string,
  scope?: "variant" | "after",
): Promise<Response> {
  return fetch(`${serverBase}/api/chats/${chatId}/messages/${messageId}${scope ? `?scope=${scope}` : ""}`, {
    method: "DELETE",
    headers: headersWith({ origin: TRUSTED_ORIGIN }),
  });
}

function patchMessage(
  serverBase: string,
  chatId: string,
  messageId: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${serverBase}/api/chats/${chatId}/messages/${messageId}`, {
    method: "PATCH",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

/** Completes every call immediately; request i receives replies[i] (last repeats). */
function scriptedUpstream(
  model: string,
  replies: string[][],
): { fetch: typeof fetch; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const fetchStub = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const deltas = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(openAiChatCompletionSse(model, deltas), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

/** Wire transcript row: the trailing narration carries its alternates. */
interface TranscriptRow extends Message {
  variant_ids: string[];
  variant_index: number;
}

async function transcript(serverBase: string, chatId: string): Promise<TranscriptRow[]> {
  const response = await fetch(`${serverBase}/api/chats/${chatId}/messages`, {
    headers: headersWith(),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { messages: TranscriptRow[] }).messages;
}

async function stopRun(serverBase: string, chatId: string): Promise<{ pending: boolean; message: Message | null }> {
  const response = await fetch(`${serverBase}/api/chats/${chatId}/stop`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { pending: boolean; message: Message | null };
}

function sseStub(frames: string[]): typeof fetch {
  return (async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(frames.join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
}

async function readSse(response: Response): Promise<StreamChunk[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  return parseSseEvents(await response.text());
}

/** Complete, individually terminated SSE frames for one full streamed reply. */
function replyFrames(model: string, deltas: string[]): string[] {
  return openAiChatCompletionSse(model, deltas)
    .split("\n\n")
    .filter((frame) => frame.length > 0)
    .map((frame) => `${frame}\n\n`);
}

/** The streamed prefix only: role + content deltas, never a terminal. */
function partialFrames(model: string, deltas: string[]): string[] {
  const finishIndex = replyFrames(model, deltas).findIndex((frame) => frame.includes('"finish_reason":"stop"'));
  return replyFrames(model, deltas).slice(0, finishIndex);
}

/** finish_reason:"stop" + [DONE] frames only, to close a held stream normally. */
function finishFrames(model: string): string[] {
  return replyFrames(model, []).filter(
    (frame) => frame.includes('"finish_reason":"stop"') || frame.includes("[DONE]"),
  );
}

interface GatedCall {
  seen: Promise<void>;
  release: (tail?: string[]) => void;
}

/**
 * Per-call upstream: request i streams prefixes[i] (the last prefix repeats),
 * then holds. release() appends the tail (default: a normal stop) and closes;
 * release([]) closes with no terminal, simulating an abandoned connection.
 * Cancel-safe: after the consumer cancels the body, nothing is enqueued.
 */
function gatedUpstream(model: string, prefixes: string[][]): {
  fetch: typeof fetch;
  calls: GatedCall[];
  aborts: Promise<boolean>[];
} {
  const encoder = new TextEncoder();
  const calls: GatedCall[] = [];
  const aborts: Promise<boolean>[] = [];
  const fetchStub = (async (_input: string | URL | Request, init?: RequestInit) => {
    const prefix = partialFrames(model, prefixes[Math.min(calls.length, prefixes.length - 1)]);
    const gate = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<boolean>();
    const signal = init?.signal ?? null;
    const tail: string[] = [];
    let released = false;
    let cancelled = false;
    const call: GatedCall = {
      seen: Promise.resolve(),
      release: (tailFrames = finishFrames(model)) => {
        if (released) return;
        released = true;
        tail.push(...tailFrames);
        gate.resolve();
      },
    };
    signal?.addEventListener("abort", () => aborted.resolve(true), { once: true });
    calls.push(call);
    aborts.push(aborted.promise);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of prefix) controller.enqueue(encoder.encode(frame));
        void gate.promise.then(() => {
          if (cancelled) return;
          try {
            for (const frame of tail) controller.enqueue(encoder.encode(frame));
            controller.close();
          } catch {
            // The consumer went away (abort/cancel): nothing to deliver.
          }
        });
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetch: fetchStub, calls, aborts };
}

/**
 * Streams a distinctive partial prefix, then holds. releaseError() errors the
 * stream only after the caller has observed the partial persisted, so the
 * failed draft genuinely retains nonempty content.
 */
function failingUpstream(model: string, deltas: string[]): {
  fetch: typeof fetch;
  releaseError: () => void;
} {
  const encoder = new TextEncoder();
  const prefix = partialFrames(model, deltas);
  const gate = Promise.withResolvers<"error" | "close">();
  const fetchStub = (async (_input: string | URL | Request, _init?: RequestInit) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of prefix) controller.enqueue(encoder.encode(frame));
        void gate.promise.then((mode) => {
          if (cancelled) return;
          try {
            if (mode === "error") controller.error(new Error("stub failure"));
            else controller.close();
          } catch {
            // Already gone.
          }
        });
      },
      cancel() {
        cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetch: fetchStub, releaseError: () => gate.resolve("error") };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("opening narration", () => {
  test("streams real narration, stores it complete as Narrator, and appends no player input", async () => {
    const { chat } = await seedStory(base.url);
    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: sseStub(replyFrames("glm-5.3", ["Rain", " fell on Veloria."])),
    });
    try {
      const response = await postOpening(server.url, chat.id);
      expect(response.headers.get("x-storyfold-accepted")).toBe("true");
      expect(response.headers.get("x-storyfold-player-message-id")).toBeNull();
      const pendingId = response.headers.get("x-storyfold-pending-message-id");
      if (!pendingId) throw new Error("missing pending id header");

      const events = await readSse(response);
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      const narration = events
        .filter((event): event is Extract<StreamChunk, { type: "TEXT_MESSAGE_CONTENT" }> => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => event.delta)
        .join("");
      expect(narration).toBe("Rain fell on Veloria.");

      const messages = await transcript(server.url, chat.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe(pendingId);
      expect(messages[0].role).toBe("assistant");
      expect(messages[0].speaker_name).toBe("Narrator");
      expect(messages[0].status).toBe("complete");
      expect(messages[0].content).toBe(narration);
      expect(messages[0].position).toBe(1);
    } finally {
      await server.stop();
    }
  });

  test("rejects direct and HTTP duplicate reservations after narration completes (already_opened)", async () => {
    const { chat } = await seedStory(base.url);
    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: sseStub(replyFrames("glm-5.3", ["The bells."])),
    });
    try {
      const first = await postOpening(server.url, chat.id);
      const events = await readSse(first);
      // Drain to completion so the second attempt sees settled state, not a
      // still-pending reply.
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      // Exercise the reservation guard directly rather than relying on the route.
      const db = openDatabase(databasePath);
      try {
        expect(() => new PlayService(db).reserveOpening(chat.id)).toThrow(AlreadyOpenedError);
      } finally {
        db.close();
      }
      const second = await postOpening(server.url, chat.id);
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe("already_opened");
      expect(await transcript(server.url, chat.id)).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  test("a failed opening retries through regenerate, which discards the failed draft", async () => {
    const { chat } = await seedStory(base.url);
    const failing = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('{"error":{"message":"boom"}}', { status: 500 })) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: failing });
    try {
      const first = await postOpening(server.url, chat.id);
      expect(first.status).toBe(200);
      const events = await readSse(first);
      expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
      expect((await transcript(server.url, chat.id))[0].status).toBe("failed");

      // The chat is no longer empty, so /opening is closed for good and
      // retries go through regeneration.
      const opening = await postOpening(server.url, chat.id);
      expect(opening.status).toBe(409);
      const openingBody = (await opening.json()) as { code: string };
      expect(openingBody.code).toBe("already_opened");

      const retryServer = await startTestServer({
        configDirectory,
        databasePath,
        upstreamFetch: sseStub(replyFrames("glm-5.3", ["Dawn."])),
      });
      try {
        const retry = await postRegenerate(retryServer.url, chat.id);
        expect(retry.status).toBe(200);
        await readSse(retry);
        const messages = await transcript(retryServer.url, chat.id);
        expect(messages.map((message) => message.status)).toEqual(["complete"]);
        expect(messages[0].position).toBe(1);
        expect(messages[0].content).toBe("Dawn.");
        expect(messages[0].variant_ids).toEqual([messages[0].id]);
      } finally {
        await retryServer.stop();
      }
    } finally {
      await server.stop();
    }
  });

  test("/opening is refused on a non-empty chat; regeneration continues with full history", async () => {
    const { chat } = await seedStory(base.url);
    const draftText = "A doomed distinct narration, cut off mid-sentence";
    const { fetch: failing, releaseError } = failingUpstream("glm-5.3", [draftText]);
    const failServer = await startTestServer({ configDirectory, databasePath, upstreamFetch: failing });
    let playerId: string;
    try {
      const turn = await postMessage(failServer.url, chat.id, { content: "I scout ahead alone." });
      const id = turn.headers.get("x-storyfold-player-message-id");
      if (!id) throw new Error("missing player id header");
      playerId = id;
      await waitFor(
        async () => (await transcript(failServer.url, chat.id)).at(-1)?.content === draftText,
        "distinct partial to persist",
      );
      releaseError();
      await waitFor(
        async () => (await transcript(failServer.url, chat.id)).at(-1)?.status === "failed",
        "draft to settle failed",
      );
    } finally {
      releaseError();
      await failServer.stop();
    }

    const calls: Array<Record<string, unknown>> = [];
    const upstream = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(openAiChatCompletionSse("glm-5.3", ["Recovered."]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const refused = await postOpening(server.url, chat.id);
      expect(refused.status).toBe(409);
      const refusedBody = (await refused.json()) as { code: string };
      expect(refusedBody.code).toBe("already_opened");

      const retry = await postRegenerate(server.url, chat.id);
      expect(retry.status).toBe(200);
      expect(retry.headers.get("x-storyfold-player-message-id")).toBe(playerId);
      const events = await readSse(retry);
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);

      const history = calls[0].messages as Array<{ role: string; content: string }>;
      expect(history[0].role).toBe("system");
      // Accepted player input is retained verbatim, joined to the opening
      // message it followed; the discarded failed draft is excluded.
      expect(history.filter((message) => message.role !== "system")).toEqual([
        { role: "user", content: `${openingMessage(OPENING_TEXT)}\n\nI scout ahead alone.` },
      ]);

      const rows = await transcript(server.url, chat.id);
      expect(rows.map((row) => [row.role, row.status])).toEqual([
        ["user", "complete"],
        ["assistant", "complete"],
      ]);
      expect(rows[1].position).toBe(2);
      expect(rows[1].variant_ids).toEqual([rows[1].id]);
    } finally {
      await server.stop();
    }
  });

  test("a per-run provider override routes to that provider's endpoint, keyless without Authorization", async () => {
    const { chat } = await seedStory(base.url);
    const headers = headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" });
    const created = await fetch(`${base.url}/api/providers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Local", base_url: "http://127.0.0.1:11434/v1/" }),
    });
    const { provider } = (await created.json()) as { provider: { id: string } };
    const calls: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
    const upstream = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(openAiChatCompletionSse("llama3.3:70b", ["Local."]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const opened = await postOpening(server.url, chat.id, { provider_id: provider.id, model: "llama3.3:70b" });
      await readSse(opened);
      expect(calls[0].url).toBe("http://127.0.0.1:11434/v1/chat/completions");
      expect(calls[0].authorization).toBeNull();
      expect(calls[0].body.model).toBe("llama3.3:70b");
      expect((await transcript(server.url, chat.id))[0].status).toBe("complete");
    } finally {
      await server.stop();
      await fetch(`${base.url}/api/providers/${provider.id}`, { method: "DELETE", headers });
    }
  });
});

describe("player turns", () => {
  test("commits accepted input and narration atomically; full SSE text equals the stored row", async () => {
    const { chat } = await seedStory(base.url);
    const calls: Array<Record<string, unknown>> = [];
    const upstream = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(openAiChatCompletionSse("glm-5.3", ["The harbour", " answers."]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const response = await postMessage(server.url, chat.id, { content: "I watch the docks." });
      expect(response.headers.get("x-storyfold-accepted")).toBe("true");
      const playerId = response.headers.get("x-storyfold-player-message-id");
      const pendingId = response.headers.get("x-storyfold-pending-message-id");
      if (!playerId || !pendingId) throw new Error("missing acceptance id headers");

      const events = await readSse(response);
      const narration = events
        .filter((event): event is Extract<StreamChunk, { type: "TEXT_MESSAGE_CONTENT" }> => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => event.delta)
        .join("");
      const messages = await transcript(server.url, chat.id);
      expect(messages.map((message) => message.position)).toEqual([1, 2]);
      expect(messages[0].id).toBe(playerId);
      expect(messages[0].role).toBe("user");
      expect(messages[0].speaker_name).toBe("Sable");
      expect(messages[0].content).toBe("I watch the docks.");
      expect(messages[0].status).toBe("complete");
      expect(messages[1].id).toBe(pendingId);
      expect(messages[1].content).toBe(narration);
      expect(messages[1].status).toBe("complete");

      const history = calls[0].messages as Array<{ role: string; content: string }>;
      expect(history[0].role).toBe("system");
      expect(history[0].content).toContain("Veloria");
      expect(history[0].content).toContain("Sable");
      expect(history.at(-1)).toEqual({ role: "user", content: `${openingMessage(OPENING_TEXT)}\n\nI watch the docks.` });
    } finally {
      await server.stop();
    }
  });

  test("streamed reasoning is stored on the reply and never sent back as history", async () => {
    const { chat } = await seedStory(base.url);
    const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const [first, ...rest] = openAiChatCompletionSse("deepseek-reasoner", ["The tide turns."]).split("\n\n");
    const thinking = ["Sable wants", " the docks."].map((reasoning_content) =>
      `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1_700_000_000, model: "deepseek-reasoner", choices: [{ index: 0, delta: { reasoning_content }, finish_reason: null }] })}`);
    const sse = [first, ...thinking, ...rest].join("\n\n");
    const upstream = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      await readSse(await postMessage(server.url, chat.id, { content: "I watch the docks." }));
      const reply = (await transcript(server.url, chat.id)).at(-1)!;
      expect(reply.reasoning).toBe("Sable wants the docks.");
      expect(reply.content).toBe("The tide turns.");

      await readSse(await postMessage(server.url, chat.id, { content: "I wait." }));
      expect(JSON.stringify(calls[1].messages)).not.toContain("Sable wants");
    } finally {
      await server.stop();
    }
  });

  test("busy rejects concurrent submissions without saving the extra input", async () => {
    const { chat } = await seedStory(base.url);
    const { fetch: upstream, calls } = gatedUpstream("glm-5.3", [["Slow"]]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const first = postMessage(server.url, chat.id, { content: "First action." });
      const firstResponse = await first;
      if (!firstResponse.body) throw new Error("missing SSE body");
      const firstBody = firstResponse.body.getReader();
      // Real browsers keep the SSE stream flowing while issuing other requests.
      void firstBody.read();
      await waitFor(() => calls.length === 1, "first run to reach upstream");
      const second = await postMessage(server.url, chat.id, { content: "Second action." });
      expect(second.status).toBe(409);
      const body = (await second.json()) as { code: string; accepted: boolean; error: string };
      expect(body.code).toBe("busy");
      expect(body.accepted).toBe(false);
      expect(typeof body.error).toBe("string");
      const rows = await transcript(server.url, chat.id);
      expect(rows.filter((message) => message.role === "user")).toHaveLength(1);
      expect(rows.some((message) => message.content === "Second action.")).toBe(false);

      calls[0].release();
      expect(firstResponse.status).toBe(200);
      await waitFor(async () => (await transcript(server.url, chat.id))[1]?.status === "complete", "first run to settle");
      await firstBody.cancel().catch(() => {});
      const again = await postMessage(server.url, chat.id, { content: "Third action." });
      expect(again.status).toBe(200);
      // The slot is usable again: a fresh pending run holds it.
      await waitFor(
        async () => (await transcript(server.url, chat.id)).at(-1)?.status === "pending",
        "third run to hold the pending slot",
      );
      await again.body?.cancel();
    } finally {
      for (const call of calls) call.release();
      await server.stop();
    }
  });

  test("server Stop settles interrupted with persisted partial, cancels the real upstream, and late chunks cannot overwrite", async () => {
    const { chat } = await seedStory(base.url);
    const { fetch: upstream, calls, aborts } = gatedUpstream("glm-5.3", [["Partial "], ["New "]]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const response = await postMessage(server.url, chat.id, { content: "I head into the fog." });
      expect(response.status).toBe(200);
      await waitFor(() => calls.length === 1, "run to reach upstream");

      const stopped = await stopRun(server.url, chat.id);
      expect(stopped.pending).toBe(true);
      expect(stopped.message?.status).toBe("interrupted");
      expect(stopped.message?.content).toBe("Partial ");
      await waitFor(async () => aborts.length > 0 && (await aborts[0]) === true, "upstream to observe abort");

      // Release with NO terminal frames: an abandoned connection must not
      // resurrect or complete the settled row.
      calls[0].release([]);
      await waitFor(async () => (await transcript(server.url, chat.id))[1]?.content === "Partial ", "row to stay partial");

      // Same server, same PlayService: a new run starts, is stoppable, and the
      // idempotent second Stop reports nothing pending.
      const second = postMessage(server.url, chat.id, { content: "Again." });
      await waitFor(() => calls.length === 2, "second run to reach upstream");
      const stoppedAgain = await stopRun(server.url, chat.id);
      expect(stoppedAgain.pending).toBe(true);
      expect(stoppedAgain.message?.status).toBe("interrupted");
      const idempotent = await stopRun(server.url, chat.id);
      expect(idempotent.pending).toBe(false);
      expect((await second).status).toBe(200);

      const rows = await transcript(server.url, chat.id);
      expect(rows.map((row) => row.status)).toEqual([
        "complete",
        "interrupted",
        "complete",
        "interrupted",
      ]);
      expect(rows[1].content).toBe("Partial ");
      expect(rows[3].content).toBe("New ");
    } finally {
      for (const call of calls) call.release();
      await server.stop();
    }
  });

  test("client disconnect settles interrupted promptly even when the upstream ignores aborts", async () => {
    const { chat } = await seedStory(base.url);
    const encoder = new TextEncoder();
    const ignoresAbort = (async (_input: string | URL | Request, _init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of partialFrames("glm-5.3", ["Ignores "])) controller.enqueue(encoder.encode(frame));
          // Never finishes and never closes, whatever the abort signal says.
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: ignoresAbort });
    try {
      const response = await postMessage(server.url, chat.id, { content: "I cut the line." });
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      await waitFor(async () => (await transcript(server.url, chat.id))[1]?.status === "interrupted", "disconnect to settle interrupted");
      const rows = await transcript(server.url, chat.id);
      expect(rows[1].content).toBe("Ignores ");
      expect(rows[0].role).toBe("user");

      // The slot is free: a normal run completes right after.
      const next = await startTestServer({
        configDirectory,
        databasePath,
        upstreamFetch: sseStub(replyFrames("glm-5.3", ["Fresh."])),
      });
      try {
        const follow = await postMessage(next.url, chat.id, { content: "I try again." });
        expect(follow.status).toBe(200);
        await waitFor(async () => (await transcript(next.url, chat.id)).at(-1)?.status === "complete", "follow-up run to complete");
      } finally {
        await next.stop();
      }
    } finally {
      await server.stop();
    }
  });

  test("upstream failure settles the draft failed while the player input stays saved", async () => {
    const { chat } = await seedStory(base.url);
    const failing = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('{"error":{"message":"boom-secret"}}', { status: 500 })) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: failing });
    try {
      const response = await postMessage(server.url, chat.id, { content: "I light a torch." });
      const playerId = response.headers.get("x-storyfold-player-message-id");
      if (!playerId) throw new Error("missing player id header");
      const events = await readSse(response);
      expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
      expect(JSON.stringify(events)).not.toContain("boom-secret");
      const rows = await transcript(server.url, chat.id);
      expect(rows[0].id).toBe(playerId);
      expect(rows[0].status).toBe("complete");
      expect(rows[0].content).toBe("I light a torch.");
      expect(rows[1].status).toBe("failed");
    } finally {
      await server.stop();
    }
  });

  test("empty normal-stop narration fails the draft and reports an error, never success", async () => {
    const { chat } = await seedStory(base.url);
    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: sseStub(replyFrames("glm-5.3", [])),
    });
    try {
      const response = await postMessage(server.url, chat.id, { content: "Say nothing." });
      const events = await readSse(response);
      expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
      expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
      expect((await transcript(server.url, chat.id))[1].status).toBe("failed");
    } finally {
      await server.stop();
    }
  });

  test("model history keeps accepted input and complete narration in order, excluding drafts", async () => {
    const { chat } = await seedStory(base.url);
    const opening = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: sseStub(replyFrames("glm-5.3", ["The fog rolls in."])),
    });
    try {
      expect((await postOpening(opening.url, chat.id)).status).toBe(200);
      await waitFor(async () => (await transcript(opening.url, chat.id))[0]?.status === "complete", "opening to settle");
    } finally {
      await opening.stop();
    }

    const draftText = "A doomed distinct narration, cut off mid-sentence";
    const { fetch: failing, releaseError } = failingUpstream("glm-5.3", [draftText]);
    const failServer = await startTestServer({ configDirectory, databasePath, upstreamFetch: failing });
    try {
      const failed = await postMessage(failServer.url, chat.id, { content: "A doomed distinct action." });
      const playerId = failed.headers.get("x-storyfold-player-message-id");
      if (!playerId) throw new Error("missing player id header");
      // The distinct partial must be persisted while the run is still failing.
      await waitFor(
        async () => (await transcript(failServer.url, chat.id)).at(-1)?.content === draftText,
        "distinct partial to persist",
      );
      releaseError();
      await waitFor(async () => (await transcript(failServer.url, chat.id)).at(-1)?.status === "failed", "draft to settle failed");
      const rows = await transcript(failServer.url, chat.id);
      expect(rows.at(-1)?.status).toBe("failed");
      expect(rows.at(-1)?.content).toBe(draftText);
      expect(rows.at(-2)?.content).toBe("A doomed distinct action.");
    } finally {
      releaseError();
      await failServer.stop();
    }

    const calls: Array<Record<string, unknown>> = [];
    const upstream = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(openAiChatCompletionSse("glm-5.3", ["Fine."]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const good = await postMessage(server.url, chat.id, { content: "This succeeds." });
      await readSse(good);
      const history = calls[0].messages as Array<{ role: string; content: string }>;
      const nonSystem = history.filter((message) => message.role !== "system");
      expect(nonSystem.map((message) => [message.role, message.content])).toEqual([
        ["user", openingMessage(OPENING_TEXT)],
        ["assistant", "The fog rolls in."],
        ["user", "A doomed distinct action."],
        ["user", "This succeeds."],
      ]);
      expect(JSON.stringify(history)).not.toContain("Fine.");
      expect(JSON.stringify(history)).not.toContain(draftText);
    } finally {
      await server.stop();
    }
  });

  test("a turn past the narration budget is refused with nothing saved and points to a new chat", async () => {
    const { chat } = await seedStory(base.url);
    const server = await startTestServer({ configDirectory, databasePath });
    try {
      const response = await postMessage(server.url, chat.id, { content: "7 ".repeat(25_000) });
      expect(response.status).toBe(413);
      const body = (await response.json()) as { code: string; accepted: boolean; error: string };
      expect(body.code).toBe("context_limit");
      expect(body.accepted).toBe(false);
      expect(body.error).toContain("start a new chat");
      expect(await transcript(server.url, chat.id)).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});

describe("missing provider", () => {
  test("accepts and saves the turn, settles the draft failed, and reports no_provider", async () => {
    const emptyConfig = await makeConfigDirectory();
    const server = await startTestServer({
      configDirectory: emptyConfig,
      databasePath: join(emptyConfig, "play.db"),
    });
    try {
      const { chat } = await seedStory(server.url);
      const response = await postMessage(server.url, chat.id, { content: "The lamp flickers." });
      expect(response.status).toBe(400);
      const body = (await response.json()) as {
        code: string;
        accepted: boolean;
        player_message_id: string;
        pending_message_id: string;
        error: string;
      };
      expect(body.code).toBe("no_provider");
      expect(body.accepted).toBe(true);
      expect(body.player_message_id).toBeTruthy();
      expect(body.pending_message_id).toBeTruthy();
      const rows = await transcript(server.url, chat.id);
      expect(rows.map((row) => [row.id, row.role, row.status])).toEqual([
        [body.player_message_id, "user", "complete"],
        [body.pending_message_id, "assistant", "failed"],
      ]);
      expect(rows[0].content).toBe("The lamp flickers.");

      // A fresh empty chat still reaches the missing provider on /opening;
      // this chat is no longer empty, so /opening is refused before that.
      const refused = await postOpening(server.url, chat.id);
      expect(refused.status).toBe(409);
      const refusedBody = (await refused.json()) as { code: string };
      expect(refusedBody.code).toBe("already_opened");

      const fresh = await seedStory(server.url);
      const opening = await postOpening(server.url, fresh.chat.id);
      expect(opening.status).toBe(400);
      const openingBody = (await opening.json()) as { code: string; accepted: boolean; player_message_id?: string };
      expect(openingBody.code).toBe("no_provider");
      expect(openingBody.accepted).toBe(true);
      expect(openingBody.player_message_id).toBeUndefined();
    } finally {
      await server.stop();
      await removeDirectory(emptyConfig);
    }
  });

  test("retrying after configuring the provider completes the chat, upstream injected throughout", async () => {
    const emptyConfig = await makeConfigDirectory();
    const server = await startTestServer({
      configDirectory: emptyConfig,
      databasePath: join(emptyConfig, "play.db"),
      upstreamFetch: sseStub(replyFrames("glm-5.3", ["Now it works."])),
    });
    try {
      const { chat } = await seedStory(server.url);
      const rejected = await postMessage(server.url, chat.id, { content: "Untyped input." });
      expect(rejected.status).toBe(400);
      await rejected.text();

      await configureProvider(server.url, API_KEY);
      const retry = await postMessage(server.url, chat.id, { content: "Typed input." });
      expect(retry.status).toBe(200);
      await retry.text();
      const rows = await transcript(server.url, chat.id);
      expect(rows.map((row) => row.status)).toEqual(["complete", "failed", "complete", "complete"]);
      expect(rows[3].speaker_name).toBe("Narrator");
      expect(rows[3].content).toBe("Now it works.");
    } finally {
      await server.stop();
      await removeDirectory(emptyConfig);
    }
  });
});

describe("regeneration, swipes, edits, and deletes", () => {
  test("regenerating an empty chat is refused with nothing saved", async () => {
    const { chat } = await seedStory(base.url);
    const server = await startTestServer({ configDirectory, databasePath });
    try {
      const response = await postRegenerate(server.url, chat.id);
      expect(response.status).toBe(409);
      const body = (await response.json()) as { code: string };
      expect(body.code).toBe("nothing_to_regenerate");
      expect(await transcript(server.url, chat.id)).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  test("regeneration keeps complete alternates as swipes and discards drafts", async () => {
    const { chat } = await seedStory(base.url);
    const { fetch: upstream, calls } = scriptedUpstream("glm-5.3", [
      ["First dawn."],
      ["Second dawn."],
      ["Third dawn."],
    ]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      await readSse(await postOpening(server.url, chat.id));
      const first = (await transcript(server.url, chat.id))[0];
      expect(first.variant_ids).toEqual([first.id]);
      expect(first.variant_index).toBe(0);

      await readSse(await postRegenerate(server.url, chat.id));
      const modelOverride = await postRegenerate(server.url, chat.id, { provider_id: providerId, model: "glm-5.3-flash" });
      await readSse(modelOverride);
      expect(calls[2].model).toBe("glm-5.3-flash");

      const swipes = await transcript(server.url, chat.id);
      expect(swipes).toHaveLength(1);
      expect(swipes[0].content).toBe("Third dawn.");
      expect(swipes[0].variant_ids).toHaveLength(3);
      expect(swipes[0].variant_ids[0]).toBe(first.id);
      expect(new Set(swipes[0].variant_ids).size).toBe(3);
      expect(swipes[0].variant_index).toBe(2);

      // A stopped regeneration leaves the draft selected beside the swipes.
      const { fetch: draftUpstream, calls: draftCalls } = gatedUpstream("glm-5.3", [["Draft "]]);
      const draftServer = await startTestServer({ configDirectory, databasePath, upstreamFetch: draftUpstream });
      try {
        const run = await postRegenerate(draftServer.url, chat.id);
        await waitFor(() => draftCalls.length === 1, "regeneration to reach upstream");
        await stopRun(draftServer.url, chat.id);
        await run.body?.cancel().catch(() => {});
        await waitFor(
          async () => (await transcript(draftServer.url, chat.id))[0]?.status === "interrupted",
          "draft to settle interrupted",
        );
        const draftRows = await transcript(draftServer.url, chat.id);
        expect(draftRows).toHaveLength(1);
        expect(draftRows[0].content).toBe("Draft ");
        expect(draftRows[0].variant_ids).toHaveLength(4);
        expect(draftRows[0].variant_index).toBe(3);

        // Regenerating again discards the interrupted draft.
        const again = await postRegenerate(draftServer.url, chat.id);
        await waitFor(() => draftCalls.length === 2, "second regeneration to reach upstream");
        draftCalls[1].release();
        await again.body?.cancel().catch(() => {});
        await waitFor(
          async () => (await transcript(draftServer.url, chat.id))[0]?.status === "complete",
          "second draft to settle",
        );
        const settled = await transcript(draftServer.url, chat.id);
        expect(settled).toHaveLength(1);
        expect(settled[0].content).toBe("Draft ");
        expect(settled[0].variant_ids).toHaveLength(4);
        expect(settled[0].variant_ids).not.toContain(draftRows[0].id);
      } finally {
        for (const call of draftCalls) call.release();
        await draftServer.stop();
      }
    } finally {
      await server.stop();
    }
  });

  test("selection switches the shown swipe and deletes a left-behind draft", async () => {
    const { chat } = await seedStory(base.url);
    const { fetch: upstream } = scriptedUpstream("glm-5.3", [["First."], ["Second."], ["Third."]]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      await readSse(await postOpening(server.url, chat.id));
      const firstId = (await transcript(server.url, chat.id))[0].id;
      await readSse(await postRegenerate(server.url, chat.id));
      await readSse(await postRegenerate(server.url, chat.id));

      const select = await selectVariant(server.url, chat.id, firstId);
      expect(select.status).toBe(200);
      const selected = ((await select.json()) as { messages: TranscriptRow[] }).messages;
      expect(selected).toHaveLength(1);
      expect(selected[0].id).toBe(firstId);
      expect(selected[0].content).toBe("First.");
      expect(selected[0].variant_index).toBe(0);

      // Selecting away from an interrupted draft deletes the draft.
      const { fetch: draftUpstream, calls: draftCalls } = gatedUpstream("glm-5.3", [["Draft "]]);
      const draftServer = await startTestServer({ configDirectory, databasePath, upstreamFetch: draftUpstream });
      try {
        const run = await postRegenerate(draftServer.url, chat.id);
        await waitFor(() => draftCalls.length === 1, "regeneration to reach upstream");
        await stopRun(draftServer.url, chat.id);
        await run.body?.cancel().catch(() => {});
        await waitFor(
          async () => (await transcript(draftServer.url, chat.id))[0]?.status === "interrupted",
          "draft to settle interrupted",
        );
        const draftRows = await transcript(draftServer.url, chat.id);
        expect(draftRows[0].variant_ids).toHaveLength(4);

        const back = await selectVariant(draftServer.url, chat.id, firstId);
        expect(back.status).toBe(200);
        const kept = ((await back.json()) as { messages: TranscriptRow[] }).messages;
        expect(kept[0].id).toBe(firstId);
        expect(kept[0].variant_ids).toHaveLength(3);
        expect(kept[0].variant_ids).not.toContain(draftRows[0].id);
      } finally {
        for (const call of draftCalls) call.release();
        await draftServer.stop();
      }

      // Once later turns exist the old narration is no longer a swipe target.
      const turn = await postMessage(server.url, chat.id, { content: "I press on." });
      expect(turn.status).toBe(200);
      await readSse(turn);
      const stale = await selectVariant(server.url, chat.id, firstId);
      expect(stale.status).toBe(409);
      const staleBody = (await stale.json()) as { code: string };
      expect(staleBody.code).toBe("not_trailing");
      const missing = await selectVariant(server.url, chat.id, "no-such-message");
      expect(missing.status).toBe(404);
    } finally {
      await server.stop();
    }
  });

  test("swipe deletion selects the newest remaining and refuses the sole alternate", async () => {
    const { chat } = await seedStory(base.url);
    const { fetch: upstream } = scriptedUpstream("glm-5.3", [["First."], ["Second."]]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      await readSse(await postOpening(server.url, chat.id));
      const sole = (await transcript(server.url, chat.id))[0];
      const only = await deleteMessage(server.url, chat.id, sole.id, "variant");
      expect(only.status).toBe(409);
      const onlyBody = (await only.json()) as { code: string };
      expect(onlyBody.code).toBe("sole_variant");

      await readSse(await postRegenerate(server.url, chat.id));
      const two = await transcript(server.url, chat.id);
      expect(two[0].variant_ids).toEqual([sole.id, two[0].id]);

      // Deleting the shown swipe falls back to the newest remaining.
      const removed = await deleteMessage(server.url, chat.id, two[0].id, "variant");
      expect(removed.status).toBe(200);
      const after = ((await removed.json()) as { messages: TranscriptRow[] }).messages;
      expect(after).toHaveLength(1);
      expect(after[0].id).toBe(sole.id);
      expect(after[0].content).toBe("First.");
      expect(after[0].variant_ids).toEqual([sole.id]);

      // Older narration is not a swipe target once later turns exist.
      const turn = await postMessage(server.url, chat.id, { content: "Onward." });
      expect(turn.status).toBe(200);
      await readSse(turn);
      const stale = await deleteMessage(server.url, chat.id, sole.id, "variant");
      expect(stale.status).toBe(409);
      const staleBody = (await stale.json()) as { code: string };
      expect(staleBody.code).toBe("not_trailing");
    } finally {
      await server.stop();
    }
  });

  test("deletes cascade across alternates and later turns; positions continue after the highest survivor", async () => {
    const { chat } = await seedStory(base.url);
    const { fetch: upstream } = scriptedUpstream("glm-5.3", [
      ["Opening."],
      ["Opening swipe."],
      ["Reply."],
      ["Reply swipe."],
    ]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      await readSse(await postOpening(server.url, chat.id));
      await readSse(await postRegenerate(server.url, chat.id));
      const turn = await postMessage(server.url, chat.id, { content: "I act." });
      const playerId = turn.headers.get("x-storyfold-player-message-id");
      if (!playerId) throw new Error("missing player id header");
      await readSse(turn);
      await readSse(await postRegenerate(server.url, chat.id));

      const rows = await transcript(server.url, chat.id);
      expect(rows.map((row) => row.position)).toEqual([1, 2, 3]);
      expect(rows[2].variant_ids).toHaveLength(2);

      // Default delete removes the message and all its alternates.
      const one = await deleteMessage(server.url, chat.id, rows[2].id);
      expect(one.status).toBe(200);
      const afterOne = ((await one.json()) as { messages: TranscriptRow[] }).messages;
      expect(afterOne.map((row) => row.position)).toEqual([1, 2]);

      // Delete from the player message onward: it and everything after go.
      const cut = await deleteMessage(server.url, chat.id, playerId, "after");
      expect(cut.status).toBe(200);
      const remaining = ((await cut.json()) as { messages: TranscriptRow[] }).messages;
      expect(remaining.map((row) => row.position)).toEqual([1]);
      expect(remaining[0].variant_ids).toHaveLength(2);

      // The next turn continues after the highest survivor; no gap is reused.
      const next = await postMessage(server.url, chat.id, { content: "Fresh start." });
      expect(next.status).toBe(200);
      await readSse(next);
      expect((await transcript(server.url, chat.id)).map((row) => row.position)).toEqual([1, 2, 3]);
    } finally {
      await server.stop();
    }
  });

  test("edits change complete messages in place and refuse drafts", async () => {
    const { chat } = await seedStory(base.url);
    const { fetch: upstream } = scriptedUpstream("glm-5.3", [["First."], ["Second."]]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      await readSse(await postOpening(server.url, chat.id));
      const swipeId = (await transcript(server.url, chat.id))[0].id;
      await readSse(await postRegenerate(server.url, chat.id));

      const narration = (await transcript(server.url, chat.id))[0];
      const edited = await patchMessage(server.url, chat.id, narration.id, { content: "Edited opening." });
      expect(edited.status).toBe(200);
      const message = ((await edited.json()) as { message: Message }).message;
      expect(message.id).toBe(narration.id);
      expect(message.content).toBe("Edited opening.");
      expect(message.role).toBe("assistant");
      expect(message.speaker_name).toBe("Narrator");
      expect(message.position).toBe(1);

      // Only the edited alternate changed: the swipe keeps its original text.
      const swipe = await selectVariant(server.url, chat.id, swipeId);
      expect(swipe.status).toBe(200);
      const shown = ((await swipe.json()) as { messages: TranscriptRow[] }).messages;
      expect(shown[0].content).toBe("First.");
      expect(shown[0].variant_ids).toEqual([swipeId, narration.id]);
      expect(shown[0].variant_index).toBe(0);
      const back = await selectVariant(server.url, chat.id, narration.id);
      expect(back.status).toBe(200);

      const turn = await postMessage(server.url, chat.id, { content: "I act." });
      const playerId = turn.headers.get("x-storyfold-player-message-id");
      if (!playerId) throw new Error("missing player id header");
      await readSse(turn);

      const playerEdit = await patchMessage(server.url, chat.id, playerId, { content: "I act decisively." });
      expect(playerEdit.status).toBe(200);
      expect(((await playerEdit.json()) as { message: Message }).message.speaker_name).toBe("Sable");

      const invalid = await patchMessage(server.url, chat.id, playerId, { content: "   " });
      expect(invalid.status).toBe(400);
      const invalidBody = (await invalid.json()) as { code: string };
      expect(invalidBody.code).toBe("invalid_input");
      const missing = await patchMessage(server.url, chat.id, "no-such-message", { content: "x" });
      expect(missing.status).toBe(404);

      // Drafts are not editable.
      const { fetch: draftUpstream, calls: draftCalls } = gatedUpstream("glm-5.3", [["Draft "]]);
      const draftServer = await startTestServer({ configDirectory, databasePath, upstreamFetch: draftUpstream });
      try {
        const run = await postRegenerate(draftServer.url, chat.id);
        await waitFor(() => draftCalls.length === 1, "regeneration to reach upstream");
        await stopRun(draftServer.url, chat.id);
        await run.body?.cancel().catch(() => {});
        await waitFor(
          async () => (await transcript(draftServer.url, chat.id)).at(-1)?.status === "interrupted",
          "draft to settle interrupted",
        );
        const draftRows = await transcript(draftServer.url, chat.id);
        expect(draftRows.at(-1)?.status).toBe("interrupted");
        const refused = await patchMessage(draftServer.url, chat.id, draftRows.at(-1)!.id, { content: "Nope." });
        expect(refused.status).toBe(409);
        const refusedBody = (await refused.json()) as { code: string };
        expect(refusedBody.code).toBe("not_editable");
      } finally {
        for (const call of draftCalls) call.release();
        await draftServer.stop();
      }
    } finally {
      await server.stop();
    }
  });

  test("model history and the narration budget count only the selected alternate", async () => {
    const { chat } = await seedStory(base.url);
    const big = "A".repeat(100_000);
    const { fetch: upstream, calls } = scriptedUpstream("glm-5.3", [[big], ["Short."]]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      await readSse(await postOpening(server.url, chat.id));
      await readSse(await postRegenerate(server.url, chat.id));
      // The 100k swipe is the oldest alternate; unselected after the regenerate.
      const swipeId = (await transcript(server.url, chat.id))[0].variant_ids[0];

      // The unselected 100k swipe does not count: a 60k input still fits.
      const turn = await postMessage(server.url, chat.id, { content: "B".repeat(60_000) });
      expect(turn.status).toBe(200);
      const events = await readSse(turn);
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      const history = calls[2].messages as Array<{ role: string; content: string }>;
      const nonSystem = history.filter((message) => message.role !== "system");
      expect(nonSystem.slice(0, 2)).toEqual([
        { role: "user", content: openingMessage(OPENING_TEXT) },
        { role: "assistant", content: "Short." },
      ]);
      expect(nonSystem.at(-1)).toEqual({ role: "user", content: "B".repeat(60_000) });
      expect(JSON.stringify(history)).not.toContain(big);

      // But the budget still binds: growth past it is refused, standing still is not.
      const rows = await transcript(server.url, chat.id);
      const oversized = await patchMessage(server.url, chat.id, rows[0].id, { content: "C".repeat(100_000) });
      expect(oversized.status).toBe(413);
      const oversizedBody = (await oversized.json()) as { code: string };
      expect(oversizedBody.code).toBe("context_limit");
      const kept = await patchMessage(server.url, chat.id, rows[0].id, { content: "Shout." });
      expect(kept.status).toBe(200);

      // An unselected alternate feeds no model history: growing it is uncapped.
      const swipeEdit = await patchMessage(server.url, chat.id, swipeId, {
        content: "D".repeat(100_000),
      });
      expect(swipeEdit.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  test("a direction steers only its own reply and stays on that alternate", async () => {
    const { chat } = await seedStory(base.url);
    const { fetch: upstream, calls } = scriptedUpstream("glm-5.3", [["Night."], ["Vex snarls."], ["Vex shrugs."], ["Dawn."]]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    const lastUser = (index: number) =>
      (calls[index].messages as Array<{ role: string; content: string }>).at(-1);
    try {
      await readSse(await postOpening(server.url, chat.id, { direction: "  Open at night.  " }));
      expect(lastUser(0)).toEqual({ role: "user", content: `${openingMessage(OPENING_TEXT)}\n\n<ooc>Open at night.</ooc>` });

      await readSse(await postMessage(server.url, chat.id, { content: "I greet Vex.", direction: "Make Vex angry." }));
      expect(lastUser(1)).toEqual({ role: "user", content: "I greet Vex.\n\n<ooc>Make Vex angry.</ooc>" });
      const directed = (await transcript(server.url, chat.id)).at(-1)!;
      expect(directed.direction).toBe("Make Vex angry.");

      // Plain regenerate carries no direction; the directed swipe keeps its own.
      await readSse(await postRegenerate(server.url, chat.id, { direction: "   " }));
      expect(lastUser(2)).toEqual({ role: "user", content: "I greet Vex." });
      expect((await transcript(server.url, chat.id)).at(-1)!.direction).toBeNull();
      expect((await selectVariant(server.url, chat.id, directed.id)).status).toBe(200);
      expect((await transcript(server.url, chat.id)).at(-1)!.direction).toBe("Make Vex angry.");

      // Later turns never see earlier directions.
      await readSse(await postMessage(server.url, chat.id, { content: "I leave." }));
      const laterHistory = (calls[3].messages as Array<{ role: string; content: string }>).filter((message) => message.role !== "system");
      expect(JSON.stringify(laterHistory)).not.toContain("<ooc>");

      const invalid = await postRegenerate(server.url, chat.id, { direction: 7 });
      expect(invalid.status).toBe(400);
      const explicitNull = await postRegenerate(server.url, chat.id, { direction: null });
      expect(explicitNull.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  test("every message operation is refused busy while a reply is pending", async () => {
    const { chat } = await seedStory(base.url);
    const { fetch: upstream, calls } = gatedUpstream("glm-5.3", [["Slow "]]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const run = await postMessage(server.url, chat.id, { content: "I begin." });
      expect(run.status).toBe(200);
      await waitFor(() => calls.length === 1, "run to reach upstream");
      const rows = await transcript(server.url, chat.id);

      const regenerate = await postRegenerate(server.url, chat.id);
      expect(regenerate.status).toBe(409);
      const regenerateBody = (await regenerate.json()) as { code: string };
      expect(regenerateBody.code).toBe("busy");
      const select = await selectVariant(server.url, chat.id, rows[0].id);
      expect(select.status).toBe(409);
      const selectBody = (await select.json()) as { code: string };
      expect(selectBody.code).toBe("busy");
      const remove = await deleteMessage(server.url, chat.id, rows[0].id);
      expect(remove.status).toBe(409);
      const removeBody = (await remove.json()) as { code: string };
      expect(removeBody.code).toBe("busy");
      const edit = await patchMessage(server.url, chat.id, rows[0].id, { content: "Edited." });
      expect(edit.status).toBe(409);
      const editBody = (await edit.json()) as { code: string };
      expect(editBody.code).toBe("busy");

      calls[0].release();
      await run.body?.cancel().catch(() => {});
      await waitFor(
        async () => (await transcript(server.url, chat.id))[1]?.status === "complete",
        "run to settle",
      );
    } finally {
      for (const call of calls) call.release();
      await server.stop();
    }
  });

  test("message ids from another chat are missing", async () => {
    const mine = await seedStory(base.url);
    const other = await seedStory(base.url);
    const { fetch: upstream } = scriptedUpstream("glm-5.3", [["First."]]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const opened = await postOpening(server.url, other.chat.id);
      expect(opened.status).toBe(200);
      await readSse(opened);
      const foreign = (await transcript(server.url, other.chat.id))[0];

      // The id exists, but only its own chat can see it.
      const self = await selectVariant(server.url, other.chat.id, foreign.id);
      expect(self.status).toBe(200);
      const select = await selectVariant(server.url, mine.chat.id, foreign.id);
      expect(select.status).toBe(404);
      const remove = await deleteMessage(server.url, mine.chat.id, foreign.id);
      expect(remove.status).toBe(404);
      const edit = await patchMessage(server.url, mine.chat.id, foreign.id, { content: "x" });
      expect(edit.status).toBe(404);
      expect(await transcript(server.url, other.chat.id)).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });
});

function systemPrompt(call: Record<string, unknown>): string {
  const first = (call.messages as Array<{ role: string; content: string }>)[0];
  expect(first.role).toBe("system");
  return first.content;
}

describe("grounding", () => {
  test("every call starts with the same system prompt and opening message", async () => {
    const { chat } = await seedStory(base.url);
    const { fetch: upstream, calls } = scriptedUpstream("glm-5.3", [["The bells."], ["Onward."]]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      await readSse(await postOpening(server.url, chat.id));
      await readSse(await postMessage(server.url, chat.id, { content: "I step ashore." }));
      const [first, second] = calls.map((call) => call.messages as Array<{ role: string; content: string }>);
      expect(second!.slice(0, 2)).toEqual(first!.slice(0, 2));
      expect(first![1]).toEqual({ role: "user", content: openingMessage(OPENING_TEXT) });
      expect(systemPrompt(calls[0]!)).not.toContain(OPENING_TEXT);

      const reply = (await transcript(server.url, chat.id)).at(-1)!;
      expect(reply.usage?.provider).toEqual({ prompt_tokens: 5, cached_tokens: 2, completion_tokens: 3 });
      expect(reply.usage?.estimate.context).toBe(0);
      expect(reply.usage?.estimate.history).toBeGreaterThan(0);
    } finally {
      await server.stop();
    }
  });

  test("every reply reads the world, its characters and its entries as they are now", async () => {
    const { chat, worldId, protagonistId } = await seedStory(base.url);
    const entryResponse = await jsonRequest(base.url, "POST", `/api/worlds/${worldId}/entries`, {
      kind: "lore",
      name: "Tide Bell",
      description: "Rings once for each drowned ferry.",
    });
    expect(entryResponse.status).toBe(201);
    const { entry } = (await entryResponse.json()) as { entry: { id: string } };

    const { fetch: upstream, calls } = scriptedUpstream("glm-5.3", [["First."], ["Second."]]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      await readSse(await postOpening(server.url, chat.id));
      const before = systemPrompt(calls[0]);
      expect(before).toContain("A rain-soaked harbor kingdom of rival ferries.");
      expect(before).toContain("A cynical ferrywoman spy.");
      expect(before).toContain("Rings once for each drowned ferry.");

      const edits = [
        await jsonRequest(base.url, "PATCH", `/api/characters/${protagonistId}`, {
          description: "A ferrywoman turned lighthouse keeper.",
        }),
        await jsonRequest(base.url, "PATCH", `/api/worlds/${worldId}`, {
          setting_brief: "A drowned harbor kingdom lit by a single lighthouse.",
        }),
        await jsonRequest(base.url, "PATCH", `/api/worlds/${worldId}/entries/${entry.id}`, {
          description: "Rings twice when the tide turns.",
        }),
      ];
      for (const edit of edits) expect(edit.status).toBe(200);

      await readSse(await postMessage(server.url, chat.id, { content: "I climb the stairs." }));
      const after = systemPrompt(calls[1]);
      expect(after).toContain("A ferrywoman turned lighthouse keeper.");
      expect(after).toContain("A drowned harbor kingdom lit by a single lighthouse.");
      expect(after).toContain("Rings twice when the tide turns.");
      expect(after).not.toContain("A cynical ferrywoman spy.");
      expect(after).not.toContain("A rain-soaked harbor kingdom of rival ferries.");
      expect(after).not.toContain("Rings once for each drowned ferry.");
    } finally {
      await server.stop();
    }
  });
});
