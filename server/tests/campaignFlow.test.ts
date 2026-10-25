import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { protagonistOf, type Campaign, type Message, type Session } from "../../shared/domain";
import { NARRATION_CHARACTER_BUDGET } from "../../shared/narration";
import { openDatabase } from "../db";
import {
  beginNextSession,
  createCampaign,
  createCharacter,
  createWorld,
  getCampaign,
  parseCharacterInput,
  SessionClosedError,
} from "../library";
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

const API_KEY = "sk-zai-campaign-flow-test-key";
const TRUSTED_ORIGIN = "http://localhost:5173";

let configDirectory: string;
let databasePath: string;
let base: TestServer;

beforeAll(async () => {
  configDirectory = await makeConfigDirectory();
  databasePath = join(configDirectory, "campaign-flow.db");
  base = await startTestServer({ configDirectory, databasePath });
  await configureProvider(base.url, API_KEY);
});

afterAll(async () => {
  await base?.stop();
  if (configDirectory) await removeDirectory(configDirectory);
});

async function json(url: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${base.url}${url}`, {
    method,
    headers: headersWith({ origin: TRUSTED_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

interface Seeded {
  campaign: Campaign;
  session: Session;
  situation: string;
}

async function seedCampaign(name: string, situation: string): Promise<Seeded> {
  const world = await json("/api/worlds", "POST", {
    name: `World ${name}`,
    setting_brief: "A rain-soaked harbor kingdom.",
    suggested_starting_situation: "A murder at the docks.",
  });
  expect(world.status).toBe(201);
  const worldPayload = (await world.json()) as { world: { id: string } };
  const protagonist = await json("/api/characters", "POST", {
    name: `Sable of ${name}`,
    description: "A cynical ferrywoman spy.",
    speaking_style: "Clipped, sarcastic.",
  });
  expect(protagonist.status).toBe(201);
  const protagonistPayload = (await protagonist.json()) as { character: { id: string } };
  const created = await json("/api/campaigns", "POST", {
    world_id: worldPayload.world.id,
    protagonist_id: protagonistPayload.character.id,
    starting_situation: situation,
  });
  expect(created.status).toBe(201);
  const createdPayload = (await created.json()) as { campaign: Campaign; session: Session };
  return { situation, campaign: createdPayload.campaign, session: createdPayload.session };
}

function postMessage(serverBase: string, sessionId: string, content: string): Promise<Response> {
  return fetch(`${serverBase}/api/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify({ content }),
  });
}

/** Wire transcript row: the trailing narration carries its alternates. */
interface TranscriptRow extends Message {
  variant_ids: string[];
  variant_index: number;
}

async function transcript(serverBase: string, sessionId: string): Promise<TranscriptRow[]> {
  const response = await fetch(`${serverBase}/api/sessions/${sessionId}/messages`, { headers: headersWith() });
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { messages: TranscriptRow[] };
  return payload.messages;
}

async function completeTurn(serverBase: string, sessionId: string, content: string, reply: string): Promise<void> {
  const server = await startTestServer({
    configDirectory,
    databasePath,
    upstreamFetch: (async (_input: string | URL | Request) =>
      new Response(openAiChatCompletionSse("glm-5.3", [reply]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch,
  });
  try {
    const response = await postMessage(serverBase === server.url ? serverBase : server.url, sessionId, content);
    expect(response.status).toBe(200);
    expect(parseSseEvents(await response.text()).length).toBeGreaterThan(0);
  } finally {
    await server.stop();
  }
}

/** Streams a distinctive partial prefix, then holds until the server Stop settles it. */
function heldUpstream(model: string, deltas: string[]): typeof fetch {
  const encoder = new TextEncoder();
  const full = openAiChatCompletionSse(model, deltas)
    .split("\n\n")
    .filter((frame) => frame.length > 0);
  const finishIndex = full.findIndex((frame) => frame.includes('"finish_reason":"stop"'));
  const prefix = full.slice(0, finishIndex).map((frame) => `${frame}\n\n`);
  return (async (_input: string | URL | Request) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of prefix) controller.enqueue(encoder.encode(frame));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    )) as typeof fetch;
}

/** A JSON body the server can only finish reading once the test releases it. */
function stalledJsonBody(payload: unknown): { body: ReadableStream<Uint8Array>; release: () => void } {
  const text = JSON.stringify(payload);
  const encoder = new TextEncoder();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(text.slice(0, 1)));
      await gate;
      controller.enqueue(encoder.encode(text.slice(1)));
      controller.close();
    },
  });
  return { body, release };
}

function sendStalled(url: string, method: string, body: ReadableStream<Uint8Array>): Promise<Response> {
  return fetch(`${base.url}${url}`, {
    method,
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body,
    // `duplex` is required for streaming request bodies but missing from the TS lib type.
    duplex: "half",
  } as RequestInit);
}

async function stopRun(serverBase: string, sessionId: string): Promise<void> {
  const response = await fetch(`${serverBase}/api/sessions/${sessionId}/stop`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN }),
  });
  expect(response.status).toBe(200);
  await response.body?.cancel();
}

async function stateItems(campaignId: string): Promise<unknown[]> {
  const response = await json(`/api/campaigns/${campaignId}/state`, "GET");
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { items: unknown[] };
  return payload.items;
}

async function campaignSessions(campaignId: string): Promise<Session[]> {
  const response = await json(`/api/campaigns/${campaignId}/sessions`, "GET");
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { sessions: Session[] };
  return payload.sessions;
}

describe("campaign state items", () => {
  test("create, list, edit, and delete campaign-owned state", async () => {
    const { campaign } = await seedCampaign("State", "State situation one.");
    const created = await json(`/api/campaigns/${campaign.id}/state`, "POST", {
      category: "goal",
      subject: "Mira the harbormaster",
      content: "Warily cooperative after the ledger was returned.",
    });
    expect(created.status).toBe(201);
    const item = (await created.json()) as {
      id: string;
      campaign_id: string;
      category: string;
      subject: string;
      content: string;
      created_at: string;
      updated_at: string;
    };
    expect(item.campaign_id).toBe(campaign.id);
    expect(item.category).toBe("goal");
    expect(item.subject).toBe("Mira the harbormaster");
    expect(item.created_at).toBe(item.updated_at);
    expect((await json(`/api/campaigns/${campaign.id}/state`, "POST", {
      category: "relationship",
      subject: "Mira",
      content: "This belongs in directional relationship state.",
    })).status).toBe(400);

    const journal = await json(`/api/campaigns/${campaign.id}/state`, "POST", {
      category: "journal",
      subject: "First night",
      content: "Sable slept aboard the ferry.",
    });
    expect(journal.status).toBe(201);

    const listed = await stateItems(campaign.id);
    expect(listed).toHaveLength(2);

    const patched = await json(`/api/campaigns/${campaign.id}/state/${item.id}`, "PATCH", {
      content: "Openly allied; shares dock schedules.",
    });
    expect(patched.status).toBe(200);
    const edited = (await patched.json()) as { content: string; created_at: string; updated_at: string };
    expect(edited.content).toBe("Openly allied; shares dock schedules.");
    expect(edited.created_at).toBe(item.created_at);
    expect(edited.updated_at).not.toBe(item.updated_at);

    const deleted = await json(`/api/campaigns/${campaign.id}/state/${item.id}`, "DELETE");
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect(await stateItems(campaign.id)).toHaveLength(1);
  });

  test("rejects malformed items without saving", async () => {
    const { campaign } = await seedCampaign("StateGuard", "State situation two.");
    for (const body of [
      { category: "mood", subject: "X", content: "Y" },
      { category: "goal", subject: "", content: "Y" },
      { category: "goal", subject: "X", content: " " },
      { subject: "X", content: "Y" },
    ]) {
      const response = await json(`/api/campaigns/${campaign.id}/state`, "POST", body);
      expect(response.status).toBe(400);
      const error = (await response.json()) as { code?: string };
      expect(error.code).toBe("invalid_input");
    }
    const missingCampaign = await json("/api/campaigns/nope/state", "POST", {
      category: "goal",
      subject: "X",
      content: "Y",
    });
    expect(missingCampaign.status).toBe(404);
    const foreign = await json(`/api/campaigns/${campaign.id}/state/does-not-exist`, "PATCH", {
      content: "nope",
    });
    expect(foreign.status).toBe(404);
    const emptyPatch = await json(`/api/campaigns/${campaign.id}/state/does-not-exist`, "PATCH", {});
    expect(emptyPatch.status).toBe(400);
  });

  test("item ids only resolve inside their own campaign", async () => {
    const first = await seedCampaign("IsolationA", "First campaign situation.");
    const second = await seedCampaign("IsolationB", "Second campaign situation.");
    const created = await json(`/api/campaigns/${first.campaign.id}/state`, "POST", {
      category: "knowledge",
      subject: "Hidden ledger",
      content: "Its location is known only to Sable.",
    });
    const item = (await created.json()) as { id: string };

    expect(await stateItems(second.campaign.id)).toEqual([]);
    const crossPatch = await json(`/api/campaigns/${second.campaign.id}/state/${item.id}`, "PATCH", {
      content: "Stolen.",
    });
    expect(crossPatch.status).toBe(404);
    const crossDelete = await json(`/api/campaigns/${second.campaign.id}/state/${item.id}`, "DELETE");
    expect(crossDelete.status).toBe(404);

    // The other campaign's state never reaches its narration prompt.
    const calls: Array<Record<string, unknown>> = [];
    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(openAiChatCompletionSse("glm-5.3", ["Quiet."]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch,
    });
    try {
      const response = await postMessage(server.url, second.session.id, "Look around.");
      expect(response.status).toBe(200);
      await response.body?.cancel();
      const history = calls[0].messages as Array<{ role: string; content: string }>;
      expect(JSON.stringify(history)).not.toContain("Hidden ledger");
      expect(JSON.stringify(history)).not.toContain("First campaign situation.");
    } finally {
      await server.stop();
    }
  });
});

describe("sequential sessions and handoffs", () => {
  test("closing a session records handoff and checkpoint, and moves the active session", async () => {
    const seeded = await seedCampaign("Sequence", "Sequence opening situation.");
    await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
      category: "goal",
      subject: "Find the ledger",
      content: "Recover the harbor ledger before the equinox.",
    });

    const closed = await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
      title: "After the storm",
      handoff: "The party reached the northern pass at dusk.",
    });
    expect(closed.status).toBe(201);
    const closedPayload = (await closed.json()) as { session: Session };
    const next = closedPayload.session;
    expect(next.title).toBe("After the storm");
    expect(next.handoff).toBeNull();
    expect(next.closed_at).toBeNull();

    const detail = (await (await json(`/api/campaigns/${seeded.campaign.id}`, "GET")).json()) as {
      campaign: Campaign;
    };
    expect(detail.campaign.active_session_id).toBe(next.id);
    expect(detail.campaign.forked_from_campaign_id).toBeNull();
    expect(detail.campaign.forked_from_session_id).toBeNull();

    const sessions = await campaignSessions(seeded.campaign.id);
    expect(sessions.map((session) => [session.title, session.handoff !== null, session.closed_at !== null])).toEqual([
      ["Opening session", true, true],
      ["After the storm", false, false],
    ]);
    expect(sessions[0].handoff).toBe("The party reached the northern pass at dusk.");
  });

  test("past sessions are read-only: play and opening are refused", async () => {
    const seeded = await seedCampaign("ReadOnly", "Read-only situation.");
    const closed = await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
      title: "Next",
      handoff: "Moving on.",
    });
    expect(closed.status).toBe(201);

    const play = await postMessage(base.url, seeded.session.id, "Keep playing here.");
    expect(play.status).toBe(409);
    const playError = (await play.json()) as { code?: string };
    expect(playError.code).toBe("session_closed");
    expect(await transcript(base.url, seeded.session.id)).toEqual([]);

    const closedOpening = await json(`/api/sessions/${seeded.session.id}/opening`, "POST", {});
    expect(closedOpening.status).toBe(409);
    const openingError = (await closedOpening.json()) as { code?: string };
    expect(openingError.code).toBe("session_closed");

    const malformed = await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", { title: "Only title" });
    expect(malformed.status).toBe(400);
    const unknown = await json("/api/campaigns/nope/sessions", "POST", { title: "T", handoff: "H" });
    expect(unknown.status).toBe(404);
  });

  test("each new session opens once from its handoff and then accepts play", async () => {
    const seeded = await seedCampaign("OpenFlow", "Opening flow situation.");
    await completeTurn(base.url, seeded.session.id, "I scout the pier.", "The fog swallows the pier.");
    const closed = await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
      title: "The northern road",
      handoff: "The party reached the northern pass at dusk.",
    });
    const next = ((await closed.json()) as { session: Session }).session;

    const calls: Array<Record<string, unknown>> = [];
    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(openAiChatCompletionSse("glm-5.3", ["The pass widens."]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch,
    });
    try {
      const opening = await fetch(`${server.url}/api/sessions/${next.id}/opening`, {
        method: "POST",
        headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(opening.status).toBe(200);
      await opening.text();
      const history = calls[0].messages as Array<{ role: string; content: string }>;
      const prompt = history[0].content;
      expect(prompt).toContain("Handoff from the previous session: The party reached the northern pass at dusk.");
      expect(prompt).not.toContain("Starting situation:");
      expect(prompt).not.toContain(seeded.situation);
      expect(history.slice(1)).toEqual([{ role: "user", content: "Begin the opening scene." }]);

      // The completed opening unblocks the composer: player turns are accepted.
      const turn = await postMessage(server.url, next.id, "I walk on.");
      expect(turn.status).toBe(200);
      await turn.text();

      const again = await fetch(`${server.url}/api/sessions/${next.id}/opening`, {
        method: "POST",
        headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(again.status).toBe(409);
      const againError = (await again.json()) as { code?: string };
      expect(againError.code).toBe("already_opened");
    } finally {
      await server.stop();
    }
  });

  test("the next session's prompt carries handoff and current state, never the old situation or history", async () => {
    const seeded = await seedCampaign("Prompt", "Sable docks at dawn while the harbor bells ring.");
    await completeTurn(base.url, seeded.session.id, "I scout the pier.", "The fog swallows the pier.");
    await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
      category: "goal",
      subject: "Find the ledger",
      content: "Recover the harbor ledger.",
    });
    await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
      category: "journal",
      subject: "First night",
      content: "Slept aboard the ferry.",
    });
    const closed = await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
      title: "The northern road",
      handoff: "The party reached the northern pass at dusk.",
    });
    const closedPayload = (await closed.json()) as { session: Session };
    const next = closedPayload.session;
    await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
      category: "internal",
      subject: "Sable's doubt",
      content: "She no longer trusts the harbormaster.",
    });

    const calls: Array<Record<string, unknown>> = [];
    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(openAiChatCompletionSse("glm-5.3", ["Lanterns flare."]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch,
    });
    try {
      const response = await postMessage(server.url, next.id, "Light the lantern.");
      expect(response.status).toBe(200);
      await response.body?.cancel();
      expect(calls).toHaveLength(1);
      const history = calls[0].messages as Array<{ role: string; content: string }>;
      const system = history[0];
      expect(system.role).toBe("system");

      // Exact history: this session's turns only — never the closed session's.
      expect(history.filter((message) => message.role !== "system")).toEqual([
        { role: "user", content: "Light the lantern." },
      ]);
      expect(JSON.stringify(history)).not.toContain("I scout the pier.");
      expect(JSON.stringify(history)).not.toContain("The fog swallows the pier.");

      // Grounding, handoff, and current state — no old starting situation.
      const prompt = system.content;
      expect(prompt).toContain("Handoff from the previous session: The party reached the northern pass at dusk.");
      expect(prompt).not.toContain("Starting situation:");
      expect(prompt).not.toContain(seeded.situation);
      expect(prompt).toContain("goal — Find the ledger: Recover the harbor ledger.");
      expect(prompt).toContain("journal — First night: Slept aboard the ferry.");
      expect(prompt).toContain("internal — Sable's doubt: She no longer trusts the harbormaster.");
    } finally {
      await server.stop();
    }
  });

  test("the initial session's prompt still grounds on the starting situation", async () => {
    const seeded = await seedCampaign("FirstPrompt", "Sable docks at dawn while the harbor bells ring.");
    await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
      category: "internal",
      subject: "Sable's cut",
      content: "A fresh gash across the left palm.",
    });
    const calls: Array<Record<string, unknown>> = [];
    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(openAiChatCompletionSse("glm-5.3", ["The bells ring."]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch,
    });
    try {
      const response = await postMessage(server.url, seeded.session.id, "I scout the pier.");
      expect(response.status).toBe(200);
      await response.body?.cancel();
      const history = calls[0].messages as Array<{ role: string; content: string }>;
      const prompt = history[0].content;
      expect(prompt).toContain(`Starting situation: ${seeded.situation}`);
      expect(prompt).not.toContain("Handoff from the previous session:");
      expect(prompt).toContain("internal — Sable's cut: A fresh gash across the left palm.");
    } finally {
      await server.stop();
    }
  });
});

describe("pending-run exclusivity", () => {
  test("state edits, transitions, forks, and extra play are refused while narration is pending", async () => {
    const seeded = await seedCampaign("Pending", "Pending situation.");
    const item = (await (
      await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
        category: "goal",
        subject: "Original goal",
        content: "Unchanged.",
      })
    ).json()) as { id: string };

    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: heldUpstream("glm-5.3", ["Half", " a reply."]),
    });
    try {
      // The SSE response stays open unconsumed: cancelling it would count as a
      // disconnect and settle the pending run before the guards are exercised.
      const response = await postMessage(server.url, seeded.session.id, "I act while it streams.");
      expect(response.status).toBe(200);

      const secondPlay = await postMessage(server.url, seeded.session.id, "Double submit.");
      expect(secondPlay.status).toBe(409);
      expect(((await secondPlay.json()) as { code?: string }).code).toBe("busy");

      const create = await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
        category: "goal",
        subject: "New goal",
        content: "Should not save.",
      });
      expect(create.status).toBe(409);
      const patch = await json(`/api/campaigns/${seeded.campaign.id}/state/${item.id}`, "PATCH", {
        content: "Should not save.",
      });
      expect(patch.status).toBe(409);
      const remove = await json(`/api/campaigns/${seeded.campaign.id}/state/${item.id}`, "DELETE");
      expect(remove.status).toBe(409);
      const transition = await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
        title: "Next while pending",
        handoff: "Should not close.",
      });
      expect(transition.status).toBe(409);

      const protagonistId = seeded.campaign.characters[0]!.id;
      const castCreate = await json(`/api/campaigns/${seeded.campaign.id}/characters`, "POST", {
        name: "Late arrival",
        description: "Should not save.",
      });
      expect(castCreate.status).toBe(409);
      const castPatch = await json(`/api/campaigns/${seeded.campaign.id}/characters/${protagonistId}`, "PATCH", {
        name: "Should not save.",
      });
      expect(castPatch.status).toBe(409);
      const castDelete = await json(`/api/campaigns/${seeded.campaign.id}/characters/${protagonistId}`, "DELETE");
      expect(castDelete.status).toBe(409);

      const statCreate = await json(`/api/campaigns/${seeded.campaign.id}/stats`, "POST", {
        applies_to: "character",
        label: "While pending",
        description: "Should not save.",
        low_label: "low",
        high_label: "high",
        min: 0,
        max: 10,
        default_value: 5,
        color: "red",
      });
      expect(statCreate.status).toBe(409);
      expect(((await statCreate.json()) as { code?: string }).code).toBe("busy");
      const statPatch = await json(`/api/campaigns/${seeded.campaign.id}/stats/nope`, "PATCH", { label: "Should not save." });
      expect(statPatch.status).toBe(409);
      const statDelete = await json(`/api/campaigns/${seeded.campaign.id}/stats/nope`, "DELETE");
      expect(statDelete.status).toBe(409);
      const statImport = await json(`/api/campaigns/${seeded.campaign.id}/stats/import`, "POST", { stat_ids: ["nope"] });
      expect(statImport.status).toBe(409);

      expect(await stateItems(seeded.campaign.id)).toHaveLength(1);
      expect(await campaignSessions(seeded.campaign.id)).toHaveLength(1);
      const characters = (await (
        await json(`/api/campaigns/${seeded.campaign.id}/characters`, "GET")
      ).json()) as { characters: Array<{ name: string }> };
      expect(characters.characters.map((character) => character.name)).toEqual(["Sable of Pending"]);

      await stopRun(server.url, seeded.session.id);
      const after = await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
        title: "After the draft",
        handoff: "The draft settled interrupted.",
      });
      expect(after.status).toBe(201);
    } finally {
      await server.stop();
    }
  });
});

describe("stale busy guards", () => {
  test("state writes re-check pending narration after their body is read", async () => {
    const seeded = await seedCampaign("StateRace", "State race situation.");
    const item = (await (
      await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
        category: "goal",
        subject: "Original goal",
        content: "Unchanged.",
      })
    ).json()) as { id: string };

    // Hold both mutating bodies mid-flight: the routes have already captured
    // the campaign (and its active session) before the body read.
    const create = stalledJsonBody({ category: "goal", subject: "Raced create", content: "Should not save." });
    const patch = stalledJsonBody({ content: "Should not save." });
    const createResponse = sendStalled(`/api/campaigns/${seeded.campaign.id}/state`, "POST", create.body);
    const patchResponse = sendStalled(`/api/campaigns/${seeded.campaign.id}/state/${item.id}`, "PATCH", patch.body);
    // Real delay, not fake timers: Bun.serve exposes no signal for "the route
    // captured the campaign and is now awaiting the body", and the pass-after
    // assertion below holds for any interleaving — this wait only widens the
    // pre-fix window so the regression is actually exercised.
    await Bun.sleep(100);

    // While the bodies are stalled, close the session and start pending
    // narration on the new active session.
    const closed = await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
      title: "Next",
      handoff: "Closed mid-body.",
    });
    expect(closed.status).toBe(201);
    const closedPayload = (await closed.json()) as { session: Session }; // JSON API envelope
    const next = closedPayload.session;

    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: heldUpstream("glm-5.3", ["Half", " a reply."]),
    });
    try {
      // The SSE response stays open unconsumed so the run stays pending.
      const pending = await postMessage(server.url, next.id, "Narrate while the bodies stall.");
      expect(pending.status).toBe(200);

      create.release();
      patch.release();
      const created = await createResponse;
      expect(created.status).toBe(409);
      const createdError = (await created.json()) as { code?: string }; // JSON API error envelope
      expect(createdError.code).toBe("busy");
      const patched = await patchResponse;
      expect(patched.status).toBe(409);
      const patchedError = (await patched.json()) as { code?: string }; // JSON API error envelope
      expect(patchedError.code).toBe("busy");

      const items = (await stateItems(seeded.campaign.id)) as Array<{ subject: string; content: string }>;
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual(expect.objectContaining({ subject: "Original goal", content: "Unchanged." }));

      await stopRun(server.url, next.id);
    } finally {
      await server.stop();
    }
  });

  test("a session close re-checks pending narration after its body is read", async () => {
    const seeded = await seedCampaign("CloseRace", "Close race situation.");

    // Hold the close's body mid-flight: the route has already captured the
    // campaign's then-active session.
    const close = stalledJsonBody({ title: "Next", handoff: "Should not close." });
    const closeResponse = sendStalled(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", close.body);
    // Real delay, not fake timers: Bun.serve exposes no signal for "the route
    // captured the campaign and is now awaiting the body", and the pass-after
    // assertion below holds for any interleaving — this wait only widens the
    // pre-fix window so the regression is actually exercised.
    await Bun.sleep(100);

    // While the body is stalled, close that session and start pending
    // narration on the new active session.
    const closed = await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
      title: "Intermediate",
      handoff: "Closed before the stalled body lands.",
    });
    expect(closed.status).toBe(201);
    const closedPayload = (await closed.json()) as { session: Session }; // JSON API envelope
    const next = closedPayload.session;

    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: heldUpstream("glm-5.3", ["Half", " a reply."]),
    });
    try {
      // The SSE response stays open unconsumed so the run stays pending.
      const pending = await postMessage(server.url, next.id, "Narrate while the close stalls.");
      expect(pending.status).toBe(200);

      close.release();
      const response = await closeResponse;
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code?: string }).code).toBe("busy");

      const sessions = await campaignSessions(seeded.campaign.id);
      expect(sessions).toHaveLength(2);
      expect(sessions[sessions.length - 1]).toEqual(
        expect.objectContaining({ id: next.id, closed_at: null, handoff: null }),
      );

      await stopRun(server.url, next.id);
    } finally {
      await server.stop();
    }
  });
});

describe("forking from a message", () => {
  test("fork from the open session cuts the transcript and copies current state, independent afterwards", async () => {
    const seeded = await seedCampaign("MsgFork", "Message fork situation.");
    const item = (await (
      await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
        category: "goal",
        subject: "Find the ledger",
        content: "Before the cut.",
      })
    ).json()) as { id: string };

    await completeTurn(base.url, seeded.session.id, "I scout the pier.", "The fog swallows the pier.");
    const cutAt = (await transcript(base.url, seeded.session.id)).at(-1)!;
    await json(`/api/campaigns/${seeded.campaign.id}/state/${item.id}`, "PATCH", {
      content: "Edited mid-session.",
    });
    await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
      category: "journal",
      subject: "First night",
      content: "Slept aboard the ferry.",
    });
    await completeTurn(base.url, seeded.session.id, "I press on.", "The road climbs.");

    const forked = await json(
      `/api/sessions/${seeded.session.id}/messages/${cutAt.id}/fork`,
      "POST",
      { name: "From the pier" },
    );
    expect(forked.status).toBe(201);
    const fork = (await forked.json()) as { campaign: Campaign; session: Session };
    expect(fork.campaign.name).toBe("From the pier");
    expect(fork.campaign.forked_from_campaign_id).toBe(seeded.campaign.id);
    expect(fork.campaign.forked_from_session_id).toBe(seeded.session.id);
    expect(fork.campaign.world_snapshot).toEqual(seeded.campaign.world_snapshot);
    expect(fork.campaign.characters.map((character) => [character.role, character.name, character.speaking_style])).toEqual(
      seeded.campaign.characters.map((character) => [character.role, character.name, character.speaking_style]),
    );
    expect(fork.campaign.starting_situation).toBe(seeded.campaign.starting_situation);
    expect(fork.campaign.active_session_id).toBe(fork.session.id);
    expect(fork.session.closed_at).toBeNull();
    expect(fork.session.handoff).toBeNull();

    const messages = await transcript(base.url, fork.session.id);
    const source = await transcript(base.url, seeded.session.id);
    expect(messages.map((message) => [message.role, message.content, message.position])).toEqual([
      ["user", "I scout the pier.", 1],
      ["assistant", "The fog swallows the pier.", 2],
    ]);
    expect(messages.map((message) => message.created_at)).toEqual(
      source.slice(0, 2).map((message) => message.created_at),
    );
    expect(messages.every((message) => message.session_id === fork.session.id)).toBe(true);

    // Current values, not any checkpoint.
    const items = (await stateItems(fork.campaign.id)) as Array<{ id: string; subject: string; content: string }>;
    expect(items).toEqual([
      expect.objectContaining({ subject: "Find the ledger", content: "Edited mid-session." }),
      expect.objectContaining({ subject: "First night", content: "Slept aboard the ferry." }),
    ]);

    // The campaigns never touch each other again.
    await json(`/api/campaigns/${fork.campaign.id}/state/${items[0]!.id}`, "PATCH", {
      content: "Edited in the fork.",
    });
    await json(`/api/campaigns/${seeded.campaign.id}/state/${item.id}`, "PATCH", {
      content: "Edited in the origin.",
    });
    const forkItems = (await stateItems(fork.campaign.id)) as Array<{ content: string }>;
    const originItems = (await stateItems(seeded.campaign.id)) as Array<{ content: string }>;
    expect(forkItems.map((row) => row.content)).toEqual([
      "Edited in the fork.",
      "Slept aboard the ferry.",
    ]);
    expect(originItems.map((row) => row.content)).toEqual([
      "Edited in the origin.",
      "Slept aboard the ferry.",
    ]);
    expect(source.map((message) => message.content)).toEqual([
      "I scout the pier.",
      "The fog swallows the pier.",
      "I press on.",
      "The road climbs.",
    ]);
  });

  test("a message fork from a closed opening session has no incoming handoff and restores its checkpoint", async () => {
    const seeded = await seedCampaign("MsgForkClosed", "Closed fork situation.");
    await completeTurn(base.url, seeded.session.id, "I scout the pier.", "The fog swallows the pier.");
    const message = (await transcript(base.url, seeded.session.id))[0]!;
    const checkpointed = (await (
      await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
        category: "goal",
        subject: "Find the ledger",
        content: "Checkpoint content.",
      })
    ).json()) as { id: string; created_at: string };
    const closed = await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
      title: "The northern road",
      handoff: "The party reached the northern pass at dusk.",
    });
    expect(closed.status).toBe(201);
    await json(`/api/campaigns/${seeded.campaign.id}/state/${checkpointed.id}`, "PATCH", {
      content: "Edited after the close.",
    });
    await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
      category: "internal",
      subject: "Post-close doubt",
      content: "Added after the close.",
    });

    const forked = await json(
      `/api/sessions/${seeded.session.id}/messages/${message.id}/fork`,
      "POST",
      { name: "From the pier" },
    );
    expect(forked.status).toBe(201);
    const fork = (await forked.json()) as { campaign: Campaign; session: Session };
    expect(fork.session.handoff).toBeNull();
    expect(fork.session.closed_at).toBeNull();
    expect(fork.session.title).toBe(seeded.session.title);
    const forkItems = (await stateItems(fork.campaign.id)) as Array<{ subject: string; content: string; created_at: string }>;
    expect(forkItems.map((row) => [row.subject, row.content, row.created_at])).toEqual([
      ["Find the ledger", "Checkpoint content.", checkpointed.created_at],
    ]);
  });

  test("a message fork from a closed session is grounded by its incoming handoff, not its outgoing one", async () => {
    const seeded = await seedCampaign("MsgForkGround", "Grounded fork situation.");
    await completeTurn(base.url, seeded.session.id, "I scout the pier.", "The fog swallows the pier.");
    const closed = await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
      title: "The northern road",
      handoff: "The party reached the northern pass at dusk.",
    });
    const closedPayload = (await closed.json()) as { session: Session };
    const second = closedPayload.session;
    await completeTurn(base.url, second.id, "I climb the ridge.", "The valley opens below.");
    const secondMessage = (await transcript(base.url, second.id))[0]!;
    await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
      title: "The southern road",
      handoff: "The party crossed the southern bridge at dawn.",
    });

    const forked = await json(
      `/api/sessions/${second.id}/messages/${secondMessage.id}/fork`,
      "POST",
      { name: "From the ridge" },
    );
    expect(forked.status).toBe(201);
    const fork = (await forked.json()) as { campaign: Campaign; session: Session };
    expect(fork.session.closed_at).toBeNull();
    expect(fork.session.handoff).toBe("The party reached the northern pass at dusk.");
  });

  test("a message fork from an open fork session keeps the inherited handoff", async () => {
    const seeded = await seedCampaign("MsgForkInherited", "Inherited fork situation.");
    await completeTurn(base.url, seeded.session.id, "I scout the pier.", "The fog swallows the pier.");
    const next = (await (
      await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
        title: "The northern road",
        handoff: "The party reached the northern pass at dusk.",
      })
    ).json()) as { session: Session };

    await completeTurn(base.url, next.session.id, "I make camp.", "The fire catches.");
    const camp = (await transcript(base.url, next.session.id)).at(-1)!;
    const first = await json(`/api/sessions/${next.session.id}/messages/${camp.id}/fork`, "POST", { name: "Camp fork" });
    expect(first.status).toBe(201);
    const boundaryFork = (await first.json()) as { campaign: Campaign; session: Session };
    expect(boundaryFork.session.handoff).toBe("The party reached the northern pass at dusk.");

    await completeTurn(base.url, boundaryFork.session.id, "I climb the ridge.", "The valley opens below.");
    const message = (await transcript(base.url, boundaryFork.session.id)).at(-1)!;
    const forked = await json(
      `/api/sessions/${boundaryFork.session.id}/messages/${message.id}/fork`,
      "POST",
      { name: "From the ridge" },
    );
    expect(forked.status).toBe(201);
    const fork = (await forked.json()) as { campaign: Campaign; session: Session };
    expect(fork.session.closed_at).toBeNull();
    expect(fork.session.handoff).toBe("The party reached the northern pass at dusk.");
  });

  test("the cut excludes swipes and drafts, renumbers from 1, and may end on a player message", async () => {
    const seeded = await seedCampaign("MsgForkCut", "Cut fork situation.");
    await completeTurn(base.url, seeded.session.id, "I scout the pier.", "The fog swallows the pier.");
    // Regenerating the trailing narration leaves the first reply as an unselected swipe.
    const swipeServer = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: (async (_input: string | URL | Request) =>
        new Response(openAiChatCompletionSse("glm-5.3", ["The fog deepens."]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    });
    try {
      const regenerate = await fetch(`${swipeServer.url}/api/sessions/${seeded.session.id}/regenerate`, {
        method: "POST",
        headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(regenerate.status).toBe(200);
      expect(parseSseEvents(await regenerate.text()).length).toBeGreaterThan(0);
    } finally {
      await swipeServer.stop();
    }
    const withSwipe = await transcript(base.url, seeded.session.id);
    const narration = withSwipe[1]!;
    expect(narration.content).toBe("The fog deepens.");
    expect(narration.variant_ids).toHaveLength(2);

    await completeTurn(base.url, seeded.session.id, "I press on.", "The road climbs.");
    const draftServer = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: heldUpstream("glm-5.3", ["Half", " a reply."]),
    });
    try {
      const response = await postMessage(draftServer.url, seeded.session.id, "I hesitate.");
      expect(response.status).toBe(200);
      await stopRun(draftServer.url, seeded.session.id);
    } finally {
      await draftServer.stop();
    }
    const rows = await transcript(base.url, seeded.session.id);
    expect(rows.map((row) => [row.position, row.role, row.status])).toEqual([
      [1, "user", "complete"],
      [2, "assistant", "complete"],
      [3, "user", "complete"],
      [4, "assistant", "complete"],
      [5, "user", "complete"],
      [6, "assistant", "interrupted"],
    ]);

    const atNarration = await json(
      `/api/sessions/${seeded.session.id}/messages/${narration.id}/fork`,
      "POST",
      { name: "At the narration" },
    );
    expect(atNarration.status).toBe(201);
    const narrationFork = (await atNarration.json()) as { session: Session };
    expect(
      (await transcript(base.url, narrationFork.session.id)).map((row) => [row.position, row.content]),
    ).toEqual([
      [1, "I scout the pier."],
      [2, "The fog deepens."],
    ]);

    const atPlayer = await json(
      `/api/sessions/${seeded.session.id}/messages/${rows[2]!.id}/fork`,
      "POST",
      { name: "At the player turn" },
    );
    expect(atPlayer.status).toBe(201);
    const playerFork = (await atPlayer.json()) as { session: Session };
    expect(
      (await transcript(base.url, playerFork.session.id)).map((row) => [row.position, row.content]),
    ).toEqual([
      [1, "I scout the pier."],
      [2, "The fog deepens."],
      [3, "I press on."],
    ]);
  });

  test("fork from a message is refused while a reply is pending and for foreign messages", async () => {
    const seeded = await seedCampaign("MsgForkGuard", "Guard fork situation.");
    await completeTurn(base.url, seeded.session.id, "I arrive.", "The gate opens.");
    const narration = (await transcript(base.url, seeded.session.id)).at(-1)!;
    const other = await seedCampaign("MsgForkOther", "Other fork situation.");

    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: heldUpstream("glm-5.3", ["Half", " a reply."]),
    });
    try {
      const response = await postMessage(server.url, seeded.session.id, "I act while it streams.");
      expect(response.status).toBe(200);
      const busy = await json(
        `/api/sessions/${seeded.session.id}/messages/${narration.id}/fork`,
        "POST",
        { name: "While pending" },
      );
      expect(busy.status).toBe(409);
      const busyError = (await busy.json()) as { code?: string };
      expect(busyError.code).toBe("busy");
      await stopRun(server.url, seeded.session.id);

      const afterDraft = await json(
        `/api/sessions/${seeded.session.id}/messages/${narration.id}/fork`,
        "POST",
        { name: "After the draft" },
      );
      expect(afterDraft.status).toBe(201);
      const draftFork = (await afterDraft.json()) as { session: Session };
      expect(
        (await transcript(base.url, draftFork.session.id)).map((row) => row.content),
      ).toEqual(["I arrive.", "The gate opens."]);
      const draft = (await transcript(base.url, seeded.session.id)).at(-1)!;
      expect(draft.status).toBe("interrupted");
      const atDraft = await json(
        `/api/sessions/${seeded.session.id}/messages/${draft.id}/fork`,
        "POST",
        { name: "At the draft" },
      );
      expect(atDraft.status).toBe(404);
    } finally {
      await server.stop();
    }

    const foreign = await json(
      `/api/sessions/${other.session.id}/messages/${narration.id}/fork`,
      "POST",
      { name: "Cross-session" },
    );
    expect(foreign.status).toBe(404);
    const unknown = await json(`/api/sessions/${seeded.session.id}/messages/nope/fork`, "POST", { name: "Nowhere" });
    expect(unknown.status).toBe(404);
    const unknownSession = await json("/api/sessions/nope/messages/nope/fork", "POST", { name: "Nowhere" });
    expect(unknownSession.status).toBe(404);
    const malformed = await json(
      `/api/sessions/${seeded.session.id}/messages/${narration.id}/fork`,
      "POST",
      {},
    );
    expect(malformed.status).toBe(400);
  });
});

describe("narration budget", () => {
  test("a request that would pass the budget is refused with nothing saved; one that fits is accepted", async () => {
    const seeded = await seedCampaign("ContextLimit", "Context limit situation.");
    const server = await startTestServer({
      configDirectory,
      databasePath,
      upstreamFetch: (async (_input: string | URL | Request) =>
        new Response(openAiChatCompletionSse("glm-5.3", ["Short."]), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    });
    try {
      const first = await postMessage(server.url, seeded.session.id, "a".repeat(100_000));
      expect(first.status).toBe(200);
      await first.text();

      const db = openDatabase(databasePath);
      const prompt = new PlayService(db).systemPrompt(seeded.session.id).length;
      db.close();
      const room = NARRATION_CHARACTER_BUDGET - prompt - 100_000 - "Short.".length;

      const before = await transcript(server.url, seeded.session.id);
      const over = await postMessage(server.url, seeded.session.id, "b".repeat(room + 1));
      expect(over.status).toBe(413);
      const body = (await over.json()) as { code?: string; accepted?: boolean; error?: string };
      expect(body.code).toBe("context_limit");
      expect(body.accepted).toBe(false);
      expect(body.error).toContain("begin the next session");
      expect(await transcript(server.url, seeded.session.id)).toEqual(before);

      const fits = await postMessage(server.url, seeded.session.id, "b".repeat(room));
      expect(fits.status).toBe(200);
      await fits.text();
    } finally {
      await server.stop();
    }
  });
});

describe("closed-session race guard", () => {
  test("a close landing inside a play request's await window cannot write into the closed session", async () => {
    const directory = await makeConfigDirectory();
    const db = openDatabase(join(directory, "race.db"));
    try {
      const world = createWorld(db, { name: "Race", setting_brief: "Harbor.", suggested_starting_situation: "" });
      const character = createCharacter(db, parseCharacterInput({ name: "Sable", description: "Ferrywoman spy." }));
      const { campaign, session } = createCampaign(db, {
        world_id: world.id,
        protagonist_id: character.id,
        starting_situation: "Race situation.",
      });
      const play = new PlayService(db);

      // Simulates the interleaving: another browser closes the session while a
      // play request sits between its early route check and its reservation.
      beginNextSession(db, campaign.id, { title: "Next", handoff: "Raced ahead." });

      expect(() => play.reservePlayerTurn(session.id, "hello", "Sable")).toThrow(SessionClosedError);
      expect(play.transcript(session.id)).toEqual([]);
      expect(() => play.reserveOpening(session.id)).toThrow(SessionClosedError);

      // The new active session still accepts turns.
      const moved = getCampaign(db, campaign.id)!;
      const reserved = play.reservePlayerTurn(moved.active_session_id, "hello", "Sable");
      expect(reserved.playerId).not.toBeNull();
      expect(play.transcript(moved.active_session_id)).toHaveLength(2);
    } finally {
      db.close();
      await removeDirectory(directory);
    }
  });

  test("a second opening cannot reserve after the first settled complete", async () => {
    const directory = await makeConfigDirectory();
    const db = openDatabase(join(directory, "opening-race.db"));
    try {
      const world = createWorld(db, { name: "OpeningRace", setting_brief: "Harbor.", suggested_starting_situation: "" });
      const character = createCharacter(db, parseCharacterInput({ name: "Sable", description: "Ferrywoman spy." }));
      const { campaign, session } = createCampaign(db, {
        world_id: world.id,
        protagonist_id: character.id,
        starting_situation: "Opening race situation.",
      });
      const play = new PlayService(db);

      // Request A reserves and its narration settles complete before request
      // B's reservation runs — B must find the completed row in-transaction.
      const first = play.reserveOpening(session.id);
      expect(play.settlePending(first.pendingId, "complete", "The dawn breaks over the pier.")).toBe(true);
      expect(() => play.reserveOpening(session.id)).toThrow(AlreadyOpenedError);
      expect(play.transcript(session.id)).toHaveLength(1);

      // A draft (interrupted) closes /opening too: retries go through
      // regeneration, which discards the draft from the same position.
      beginNextSession(db, campaign.id, { title: "Next", handoff: "Race handoff." });
      const second = getCampaign(db, campaign.id)!;
      const draft = play.reserveOpening(second.active_session_id);
      expect(play.settlePending(draft.pendingId, "interrupted", "Half a dawn.")).toBe(true);
      expect(() => play.reserveOpening(second.active_session_id)).toThrow(AlreadyOpenedError);
      const retry = play.reserveRegeneration(second.active_session_id);
      expect(retry.pendingId).not.toBeNull();
      expect(retry.playerId).toBeNull();
      expect(play.transcript(second.active_session_id).map((message) => message.status)).toEqual(["pending"]);
    } finally {
      db.close();
      await removeDirectory(directory);
    }
  });
});

describe("restart and persistence", () => {
  test("state, sessions, checkpoints, and fork provenance survive a restart", async () => {
    const seeded = await seedCampaign("Restart", "Restart situation.");
    await completeTurn(base.url, seeded.session.id, "I scout the pier.", "The fog swallows the pier.");
    await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
      category: "knowledge",
      subject: "Hidden ledger",
      content: "Stored beneath the pier.",
    });
    await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
      title: "After the storm",
      handoff: "The party sheltered in the lighthouse.",
    });
    const cutAt = (await transcript(base.url, seeded.session.id)).at(-1)!;
    const fork = (await (
      await json(`/api/sessions/${seeded.session.id}/messages/${cutAt.id}/fork`, "POST", { name: "Restarted fork" })
    ).json()) as { campaign: Campaign; session: Session };

    const restarted = await startTestServer({ configDirectory, databasePath });
    try {
      const detail = (await (
        await fetch(`${restarted.url}/api/campaigns/${fork.campaign.id}`, { headers: headersWith() })
      ).json()) as { campaign: Campaign };
      expect(detail.campaign.forked_from_campaign_id).toBe(seeded.campaign.id);
      expect(detail.campaign.active_session_id).toBe(fork.session.id);

      const items = (await (
        await fetch(`${restarted.url}/api/campaigns/${fork.campaign.id}/state`, { headers: headersWith() })
      ).json()) as { items: Array<{ content: string }> };
      expect(items.items.map((item) => item.content)).toEqual(["Stored beneath the pier."]);

      const sessions = (await (
        await fetch(`${restarted.url}/api/campaigns/${seeded.campaign.id}/sessions`, { headers: headersWith() })
      ).json()) as { sessions: Session[] };
      expect(sessions.sessions).toHaveLength(2);
      expect(sessions.sessions[0].closed_at).not.toBeNull();
      expect(sessions.sessions[0].handoff).toBe("The party sheltered in the lighthouse.");

      const play = await postMessage(restarted.url, seeded.session.id, "Play into the past.");
      expect(play.status).toBe(409);
      const playError = (await play.json()) as { code?: string };
      expect(playError.code).toBe("session_closed");
    } finally {
      await restarted.stop();
    }
  });
});

test("campaign relationship API validates campaign characters and the last save wins", async () => {
  const { campaign } = await seedCampaign("Relationship API", "A meeting at the harbor.");
  const protagonistId = protagonistOf(campaign).id;
  const outsider = await json("/api/characters", "POST", { name: "Outsider", description: "Not in this campaign." });
  expect(outsider.status).toBe(201);
  const outsiderId = ((await outsider.json()) as { character: { id: string } }).character.id;
  const companion = await json(`/api/campaigns/${campaign.id}/characters`, "POST", {
    name: "Aven",
    description: "A harbor pilot.",
  });
  expect(companion.status).toBe(201);
  const target = ((await companion.json()) as { character: { id: string } }).character.id;

  const created = await json(`/api/campaigns/${campaign.id}/relationships`, "POST", {
    source_id: protagonistId,
    target_id: target,
    how_met: "At the harbor.",
    status: "cautious",
  });
  expect(created.status).toBe(201);
  const createdPayload = (await created.json()) as { relationship: { id: string; status: string } };
  expect(createdPayload.relationship.status).toBe("cautious");
  const relationship = createdPayload.relationship;
  expect((await json(`/api/campaigns/${campaign.id}/relationships`, "POST", {
    source_id: protagonistId,
    target_id: target,
    how_met: "At the harbor.",
  })).status).toBe(400);
  expect((await json(`/api/campaigns/${campaign.id}/relationships`, "POST", {
    source_id: protagonistId,
    target_id: outsiderId,
    how_met: "At the harbor.",
  })).status).toBe(400);
  for (const status of ["trusting", "wary"]) {
    const updated = await json(`/api/campaigns/${campaign.id}/relationships/${relationship.id}`, "PATCH", {
      status,
    });
    expect(updated.status).toBe(200);
  }
  const listed = (await (await json(`/api/campaigns/${campaign.id}/relationships`, "GET")).json()) as {
    relationships: Array<{ status: string }>;
  };
  expect(listed.relationships[0]!.status).toBe("wary");
});
