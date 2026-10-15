import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import type { Campaign, Message, Session } from "../../shared/domain";
import {
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

beforeAll(async () => {
  configDirectory = await makeConfigDirectory();
  databasePath = join(configDirectory, "play.db");
  base = await startTestServer({ configDirectory, databasePath });
  const created = await fetch(`${base.url}/api/provider`, {
    method: "PUT",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify({ model: "glm-5.3", api_key: API_KEY }),
  });
  expect(created.status).toBe(200);
});

afterAll(async () => {
  await base?.stop();
  if (configDirectory) await removeDirectory(configDirectory);
});

async function seedStory(serverBase: string): Promise<{ campaign: Campaign; session: Session }> {
  const world = await fetch(`${serverBase}/api/worlds`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify({
      name: "Veloria",
      setting_brief: "A rain-soaked harbor kingdom of rival ferries.",
      suggested_starting_situation: "A murder at the docks at dawn.",
    }),
  });
  expect(world.status).toBe(201);
  const worldPayload = (await world.json()) as { world: { id: string } };
  const protagonist = await fetch(`${serverBase}/api/characters`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify({
      name: "Sable",
      description: "A cynical ferrywoman spy.",
      speaking_style: "Clipped, sarcastic.",
    }),
  });
  expect(protagonist.status).toBe(201);
  const protagonistPayload = (await protagonist.json()) as { character: { id: string } };
  const created = await fetch(`${serverBase}/api/campaigns`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify({
      world_id: worldPayload.world.id,
      protagonist_id: protagonistPayload.character.id,
      starting_situation: "Sable docks at dawn while the harbor bells ring.",
    }),
  });
  expect(created.status).toBe(201);
  return (await created.json()) as { campaign: Campaign; session: Session };
}

function postMessage(serverBase: string, sessionId: string, body: unknown): Promise<Response> {
  return fetch(`${serverBase}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

function postOpening(serverBase: string, sessionId: string, body: unknown = {}): Promise<Response> {
  return fetch(`${serverBase}/api/sessions/${sessionId}/opening`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

async function transcript(serverBase: string, sessionId: string): Promise<Message[]> {
  const response = await fetch(`${serverBase}/api/sessions/${sessionId}/messages`, {
    headers: headersWith(),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { messages: Message[] }).messages;
}

async function stopRun(serverBase: string, sessionId: string): Promise<{ pending: boolean; message: Message | null }> {
  const response = await fetch(`${serverBase}/api/sessions/${sessionId}/stop`, {
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

describe("campaign creation", () => {
  test("binds snapshots and the opening session in one committed response", async () => {
    const { campaign, session } = await seedStory(base.url);
    expect(campaign.world_snapshot.name).toBe("Veloria");
    expect(campaign.protagonist_snapshot.name).toBe("Sable");
    expect(campaign.protagonist_snapshot.speaking_style).toBe("Clipped, sarcastic.");
    expect(campaign.cast).toEqual([]);
    expect(campaign.active_session_id).toBe(session.id);
    expect(session.campaign_id).toBe(campaign.id);
    const detail = await fetch(`${base.url}/api/campaigns/${campaign.id}`, { headers: headersWith() });
    expect(detail.status).toBe(200);
  });

  test("unknown world or protagonist references roll back without creating rows", async () => {
    const before = await (await fetch(`${base.url}/api/campaigns`, { headers: headersWith() })).json();
    const response = await fetch(`${base.url}/api/campaigns`, {
      method: "POST",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ world_id: "nope", protagonist_id: "nope", starting_situation: "x" }),
    });
    expect(response.status).toBe(404);
    const after = (await (await fetch(`${base.url}/api/campaigns`, { headers: headersWith() })).json()) as {
      campaigns: Campaign[];
    };
    expect(after.campaigns.map((campaign) => campaign.id)).toEqual(
      ((before as { campaigns: Campaign[] }).campaigns).map((campaign) => campaign.id),
    );
  });

  test("captured snapshots never change when the library is edited", async () => {
    const { campaign } = await seedStory(base.url);
    await fetch(`${base.url}/api/worlds/${campaign.world_id}`, {
      method: "PATCH",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ name: "Veloria Prime", setting_brief: "Rewritten entirely." }),
    });
    await fetch(`${base.url}/api/characters/${campaign.protagonist_id}`, {
      method: "PATCH",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ name: "Sable II", description: "Rewritten." }),
    });
    const detail = (await (
      await fetch(`${base.url}/api/campaigns/${campaign.id}`, { headers: headersWith() })
    ).json()) as { campaign: Campaign };
    expect(detail.campaign.world_snapshot.name).toBe("Veloria");
    expect(detail.campaign.world_snapshot.setting_brief).toBe("A rain-soaked harbor kingdom of rival ferries.");
    expect(detail.campaign.protagonist_snapshot.name).toBe("Sable");
    const fresh = await fetch(`${base.url}/api/campaigns`, {
      method: "POST",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({
        world_id: campaign.world_id,
        protagonist_id: campaign.protagonist_id,
        starting_situation: "New morning.",
      }),
    });
    const freshBody = (await fresh.json()) as { campaign: Campaign };
    expect(freshBody.campaign.world_snapshot.name).toBe("Veloria Prime");
    expect(freshBody.campaign.protagonist_snapshot.name).toBe("Sable II");
  });
});

describe("opening narration", () => {
  test("streams real narration, stores it complete as Narrator, and appends no player input", async () => {
    const { session } = await seedStory(base.url);
    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: sseStub(replyFrames("glm-5.3", ["Rain", " fell on Veloria."])),
    });
    try {
      const response = await postOpening(server.url, session.id);
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

      const messages = await transcript(server.url, session.id);
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

  test("rejects a second opening once narration completed (already_opened)", async () => {
    const { session } = await seedStory(base.url);
    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: sseStub(replyFrames("glm-5.3", ["The bells."])),
    });
    try {
      const first = await postOpening(server.url, session.id);
      const events = await readSse(first);
      // Drain to completion so the second attempt sees settled state, not a
      // still-pending reply.
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);
      const second = await postOpening(server.url, session.id);
      expect(second.status).toBe(409);
      expect(((await second.json()) as { code: string }).code).toBe("already_opened");
      expect(await transcript(server.url, session.id)).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  test("a failed opening can be retried and keeps the failed draft", async () => {
    const { session } = await seedStory(base.url);
    const failing = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('{"error":{"message":"boom"}}', { status: 500 })) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: failing });
    try {
      const first = await postOpening(server.url, session.id);
      expect(first.status).toBe(200);
      const events = await readSse(first);
      expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
      expect((await transcript(server.url, session.id))[0].status).toBe("failed");

      const retryServer = await startTestServer({
        configDirectory,
        databasePath,
        upstreamFetch: sseStub(replyFrames("glm-5.3", ["Dawn."])),
      });
      try {
        const retry = await postOpening(retryServer.url, session.id);
        expect(retry.status).toBe(200);
        await readSse(retry);
        const messages = await transcript(retryServer.url, session.id);
        expect(messages.map((message) => message.status)).toEqual(["failed", "complete"]);
        expect(messages.every((message) => message.speaker_name === "Narrator")).toBe(true);
      } finally {
        await retryServer.stop();
      }
    } finally {
      await server.stop();
    }
  });

  test("an opening retried after accepted player input continues with full history", async () => {
    const { session } = await seedStory(base.url);
    const draftText = "A doomed distinct narration, cut off mid-sentence";
    const { fetch: failing, releaseError } = failingUpstream("glm-5.3", [draftText]);
    const failServer = await startTestServer({ configDirectory, databasePath, upstreamFetch: failing });
    try {
      const turn = await postMessage(failServer.url, session.id, { content: "I scout ahead alone." });
      const playerId = turn.headers.get("x-storyfold-player-message-id");
      if (!playerId) throw new Error("missing player id header");
      await waitFor(
        async () => (await transcript(failServer.url, session.id)).at(-1)?.content === draftText,
        "distinct partial to persist",
      );
      releaseError();
      await waitFor(
        async () => (await transcript(failServer.url, session.id)).at(-1)?.status === "failed",
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
      const retry = await postOpening(server.url, session.id);
      expect(retry.status).toBe(200);
      const events = await readSse(retry);
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);

      const history = calls[0].messages as Array<{ role: string; content: string }>;
      expect(history[0].role).toBe("system");
      // Accepted player input is retained verbatim; the failed draft is
      // excluded; no synthetic seed row replaces real history.
      expect(history.filter((message) => message.role !== "system")).toEqual([
        { role: "user", content: "I scout ahead alone." },
      ]);
      expect(JSON.stringify(history)).not.toContain("Begin the opening scene.");

      const rows = await transcript(server.url, session.id);
      expect(rows.map((row) => [row.role, row.status])).toEqual([
        ["user", "complete"],
        ["assistant", "failed"],
        ["assistant", "complete"],
      ]);
    } finally {
      await server.stop();
    }
  });

  test("openings accept a per-run model override", async () => {
    const { session } = await seedStory(base.url);
    const calls: Array<Record<string, unknown>> = [];
    const upstream = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(openAiChatCompletionSse("glm-5.3-flash", ["Flash."]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const opened = await postOpening(server.url, session.id, { model: "glm-5.3-flash" });
      await readSse(opened);
      expect(calls[0].model).toBe("glm-5.3-flash");
      expect((await transcript(server.url, session.id))[0].status).toBe("complete");
    } finally {
      await server.stop();
    }
  });
});

describe("player turns", () => {
  test("commits accepted input and narration atomically; full SSE text equals the stored row", async () => {
    const { session } = await seedStory(base.url);
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
      const response = await postMessage(server.url, session.id, { content: "I watch the docks." });
      expect(response.headers.get("x-storyfold-accepted")).toBe("true");
      const playerId = response.headers.get("x-storyfold-player-message-id");
      const pendingId = response.headers.get("x-storyfold-pending-message-id");
      if (!playerId || !pendingId) throw new Error("missing acceptance id headers");

      const events = await readSse(response);
      const narration = events
        .filter((event): event is Extract<StreamChunk, { type: "TEXT_MESSAGE_CONTENT" }> => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => event.delta)
        .join("");
      const messages = await transcript(server.url, session.id);
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
      expect(history.at(-1)).toEqual({ role: "user", content: "I watch the docks." });
    } finally {
      await server.stop();
    }
  });

  test("busy rejects concurrent submissions without saving the extra input", async () => {
    const { session } = await seedStory(base.url);
    const { fetch: upstream, calls } = gatedUpstream("glm-5.3", [["Slow"]]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const first = postMessage(server.url, session.id, { content: "First action." });
      const firstResponse = await first;
      if (!firstResponse.body) throw new Error("missing SSE body");
      const firstBody = firstResponse.body.getReader();
      // Real browsers keep the SSE stream flowing while issuing other requests.
      void firstBody.read();
      await waitFor(() => calls.length === 1, "first run to reach upstream");
      const second = await postMessage(server.url, session.id, { content: "Second action." });
      expect(second.status).toBe(409);
      const body = (await second.json()) as { code: string; accepted: boolean; error: string };
      expect(body.code).toBe("busy");
      expect(body.accepted).toBe(false);
      expect(typeof body.error).toBe("string");
      const rows = await transcript(server.url, session.id);
      expect(rows.filter((message) => message.role === "user")).toHaveLength(1);
      expect(rows.some((message) => message.content === "Second action.")).toBe(false);

      calls[0].release();
      expect(firstResponse.status).toBe(200);
      await waitFor(async () => (await transcript(server.url, session.id))[1]?.status === "complete", "first run to settle");
      await firstBody.cancel().catch(() => {});
      const again = await postMessage(server.url, session.id, { content: "Third action." });
      expect(again.status).toBe(200);
      // The slot is usable again: a fresh pending run holds it.
      await waitFor(
        async () => (await transcript(server.url, session.id)).at(-1)?.status === "pending",
        "third run to hold the pending slot",
      );
      await again.body?.cancel();
    } finally {
      for (const call of calls) call.release();
      await server.stop();
    }
  });

  test("server Stop settles interrupted with persisted partial, cancels the real upstream, and late chunks cannot overwrite", async () => {
    const { session } = await seedStory(base.url);
    const { fetch: upstream, calls, aborts } = gatedUpstream("glm-5.3", [["Partial "], ["New "]]);
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const response = await postMessage(server.url, session.id, { content: "I head into the fog." });
      expect(response.status).toBe(200);
      await waitFor(() => calls.length === 1, "run to reach upstream");

      const stopped = await stopRun(server.url, session.id);
      expect(stopped.pending).toBe(true);
      expect(stopped.message?.status).toBe("interrupted");
      expect(stopped.message?.content).toBe("Partial ");
      await waitFor(async () => aborts.length > 0 && (await aborts[0]) === true, "upstream to observe abort");

      // Release with NO terminal frames: an abandoned connection must not
      // resurrect or complete the settled row.
      calls[0].release([]);
      await waitFor(async () => (await transcript(server.url, session.id))[1]?.content === "Partial ", "row to stay partial");

      // Same server, same PlayService: a new run starts, is stoppable, and the
      // idempotent second Stop reports nothing pending.
      const second = postMessage(server.url, session.id, { content: "Again." });
      await waitFor(() => calls.length === 2, "second run to reach upstream");
      const stoppedAgain = await stopRun(server.url, session.id);
      expect(stoppedAgain.pending).toBe(true);
      expect(stoppedAgain.message?.status).toBe("interrupted");
      const idempotent = await stopRun(server.url, session.id);
      expect(idempotent.pending).toBe(false);
      expect((await second).status).toBe(200);

      const rows = await transcript(server.url, session.id);
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
    const { session } = await seedStory(base.url);
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
      const response = await postMessage(server.url, session.id, { content: "I cut the line." });
      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      await waitFor(async () => (await transcript(server.url, session.id))[1]?.status === "interrupted", "disconnect to settle interrupted");
      const rows = await transcript(server.url, session.id);
      expect(rows[1].content).toBe("Ignores ");
      expect(rows[0].role).toBe("user");

      // The slot is free: a normal run completes right after.
      const next = await startTestServer({
        configDirectory,
        databasePath,
        upstreamFetch: sseStub(replyFrames("glm-5.3", ["Fresh."])),
      });
      try {
        const follow = await postMessage(next.url, session.id, { content: "I try again." });
        expect(follow.status).toBe(200);
        await waitFor(async () => (await transcript(next.url, session.id)).at(-1)?.status === "complete", "follow-up run to complete");
      } finally {
        await next.stop();
      }
    } finally {
      await server.stop();
    }
  });

  test("upstream failure settles the draft failed while the player input stays saved", async () => {
    const { session } = await seedStory(base.url);
    const failing = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response('{"error":{"message":"boom-secret"}}', { status: 500 })) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: failing });
    try {
      const response = await postMessage(server.url, session.id, { content: "I light a torch." });
      const playerId = response.headers.get("x-storyfold-player-message-id");
      if (!playerId) throw new Error("missing player id header");
      const events = await readSse(response);
      expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
      expect(JSON.stringify(events)).not.toContain("boom-secret");
      const rows = await transcript(server.url, session.id);
      expect(rows[0].id).toBe(playerId);
      expect(rows[0].status).toBe("complete");
      expect(rows[0].content).toBe("I light a torch.");
      expect(rows[1].status).toBe("failed");
    } finally {
      await server.stop();
    }
  });

  test("empty normal-stop narration fails the draft and reports an error, never success", async () => {
    const { session } = await seedStory(base.url);
    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: sseStub(replyFrames("glm-5.3", [])),
    });
    try {
      const response = await postMessage(server.url, session.id, { content: "Say nothing." });
      const events = await readSse(response);
      expect(events.at(-1)?.type).toBe(EventType.RUN_ERROR);
      expect(events.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false);
      expect((await transcript(server.url, session.id))[1].status).toBe("failed");
    } finally {
      await server.stop();
    }
  });

  test("model history keeps accepted input and complete narration in order, excluding drafts", async () => {
    const { session } = await seedStory(base.url);
    const opening = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: sseStub(replyFrames("glm-5.3", ["The fog rolls in."])),
    });
    try {
      expect((await postOpening(opening.url, session.id)).status).toBe(200);
      await waitFor(async () => (await transcript(opening.url, session.id))[0]?.status === "complete", "opening to settle");
    } finally {
      await opening.stop();
    }

    const draftText = "A doomed distinct narration, cut off mid-sentence";
    const { fetch: failing, releaseError } = failingUpstream("glm-5.3", [draftText]);
    const failServer = await startTestServer({ configDirectory, databasePath, upstreamFetch: failing });
    try {
      const failed = await postMessage(failServer.url, session.id, { content: "A doomed distinct action." });
      const playerId = failed.headers.get("x-storyfold-player-message-id");
      if (!playerId) throw new Error("missing player id header");
      // The distinct partial must be persisted while the run is still failing.
      await waitFor(
        async () => (await transcript(failServer.url, session.id)).at(-1)?.content === draftText,
        "distinct partial to persist",
      );
      releaseError();
      await waitFor(async () => (await transcript(failServer.url, session.id)).at(-1)?.status === "failed", "draft to settle failed");
      const rows = await transcript(failServer.url, session.id);
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
      const good = await postMessage(server.url, session.id, { content: "This succeeds." });
      await readSse(good);
      const history = calls[0].messages as Array<{ role: string; content: string }>;
      const nonSystem = history.filter((message) => message.role !== "system");
      expect(nonSystem.map((message) => [message.role, message.content])).toEqual([
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
});

describe("missing provider", () => {
  test("accepts and saves the turn, settles the draft failed, and reports no_provider", async () => {
    const emptyConfig = await makeConfigDirectory();
    const server = await startTestServer({
      configDirectory: emptyConfig,
      databasePath: join(emptyConfig, "play.db"),
    });
    try {
      const { session } = await seedStory(server.url);
      const response = await postMessage(server.url, session.id, { content: "The lamp flickers." });
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
      const rows = await transcript(server.url, session.id);
      expect(rows.map((row) => [row.id, row.role, row.status])).toEqual([
        [body.player_message_id, "user", "complete"],
        [body.pending_message_id, "assistant", "failed"],
      ]);
      expect(rows[0].content).toBe("The lamp flickers.");

      const opening = await postOpening(server.url, session.id);
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

  test("retrying after configuring the provider completes the session, upstream injected throughout", async () => {
    const emptyConfig = await makeConfigDirectory();
    const server = await startTestServer({
      configDirectory: emptyConfig,
      databasePath: join(emptyConfig, "play.db"),
      upstreamFetch: sseStub(replyFrames("glm-5.3", ["Now it works."])),
    });
    try {
      const { session } = await seedStory(server.url);
      const rejected = await postMessage(server.url, session.id, { content: "Untyped input." });
      expect(rejected.status).toBe(400);
      await rejected.text();

      await fetch(`${server.url}/api/provider`, {
        method: "PUT",
        headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
        body: JSON.stringify({ model: "glm-5.3", api_key: API_KEY }),
      });
      const retry = await postMessage(server.url, session.id, { content: "Typed input." });
      expect(retry.status).toBe(200);
      await retry.text();
      const rows = await transcript(server.url, session.id);
      expect(rows.map((row) => row.status)).toEqual(["complete", "failed", "complete", "complete"]);
      expect(rows[3].speaker_name).toBe("Narrator");
      expect(rows[3].content).toBe("Now it works.");
    } finally {
      await server.stop();
      await removeDirectory(emptyConfig);
    }
  });
});
