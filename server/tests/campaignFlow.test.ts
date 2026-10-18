import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Campaign, Message, Session } from "../../shared/domain";
import { openDatabase } from "../db";
import {
  beginNextSession,
  createCampaign,
  createCharacter,
  createWorld,
  getCampaign,
  SessionClosedError,
} from "../library";
import { AlreadyOpenedError, HISTORY_CHARACTER_LIMIT, PlayService } from "../play";
import {
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

async function transcript(serverBase: string, sessionId: string): Promise<Message[]> {
  const response = await fetch(`${serverBase}/api/sessions/${sessionId}/messages`, { headers: headersWith() });
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { messages: Message[] };
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

  test("rejects malformed items and unknown references without saving", async () => {
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
      category: "attribute",
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
      expect(prompt).toContain("attribute — Sable's cut: A fresh gash across the left palm.");
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
      const fork = await json(`/api/sessions/${seeded.session.id}/fork`, "POST", { name: "Fork while pending" });
      expect(fork.status).toBe(409);
      const forkError = (await fork.json()) as { code?: string };
      expect(forkError.code).toBe("busy");

      expect(await stateItems(seeded.campaign.id)).toHaveLength(1);
      expect(await campaignSessions(seeded.campaign.id)).toHaveLength(1);

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

describe("forking completed sessions", () => {
  test("fork copies checkpoint state, definitions, and handoff into an independent campaign", async () => {
    const seeded = await seedCampaign("ForkOrigin", "Fork origin situation.");
    const firstItem = (await (
      await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
        category: "goal",
        subject: "Find the ledger",
        content: "Checkpoint content.",
      })
    ).json()) as { id: string; created_at: string };
    const secondItem = (await (
      await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
        category: "journal",
        subject: "First night",
        content: "Slept aboard the ferry.",
      })
    ).json()) as { id: string; created_at: string };

    await completeTurn(base.url, seeded.session.id, "I scout the pier.", "The fog swallows the pier.");
    const closed = await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
      title: "The northern road",
      handoff: "The party reached the northern pass at dusk.",
    });
    expect(closed.status).toBe(201);

    // Campaign state moves on after the boundary; the fork must not see it.
    await json(`/api/campaigns/${seeded.campaign.id}/state/${firstItem.id}`, "PATCH", {
      content: "Edited after the boundary.",
    });
    await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
      category: "internal",
      subject: "Post-boundary doubt",
      content: "Added after the boundary.",
    });
    await json(`/api/campaigns/${seeded.campaign.id}/state/${secondItem.id}`, "DELETE");

    const forked = await json(`/api/sessions/${seeded.session.id}/fork`, "POST", { name: "The southern road" });
    expect(forked.status).toBe(201);
    const fork = (await forked.json()) as { campaign: Campaign; session: Session };
    expect(fork.campaign.name).toBe("The southern road");
    expect(fork.campaign.forked_from_campaign_id).toBe(seeded.campaign.id);
    expect(fork.campaign.forked_from_session_id).toBe(seeded.session.id);
    expect(fork.campaign.world_snapshot).toEqual(seeded.campaign.world_snapshot);
    expect(fork.campaign.protagonist_snapshot).toEqual(seeded.campaign.protagonist_snapshot);
    expect(fork.campaign.cast).toEqual(seeded.campaign.cast);
    expect(fork.campaign.starting_situation).toBe(seeded.campaign.starting_situation);
    expect(fork.campaign.active_session_id).toBe(fork.session.id);
    expect(fork.session.handoff).toBe("The party reached the northern pass at dusk.");
    expect(fork.session.closed_at).toBeNull();
    expect(fork.session.title).toBe("Opening session");

    // Checkpoint values, not the live edited state; journal chronology survives.
    const items = (await stateItems(fork.campaign.id)) as Array<{
      category: string;
      subject: string;
      content: string;
      created_at: string;
    }>;
    expect(items).toEqual([
      expect.objectContaining({ category: "goal", subject: "Find the ledger", content: "Checkpoint content." }),
      expect.objectContaining({ category: "journal", subject: "First night", content: "Slept aboard the ferry." }),
    ]);
    expect(items.map((item) => item.created_at)).toEqual([firstItem.created_at, secondItem.created_at]);

    // The origin keeps its later state and sessions; the fork starts fresh.
    const originItems = (await stateItems(seeded.campaign.id)) as Array<{ content: string }>;
    expect(originItems.map((item) => item.content)).toEqual([
      "Edited after the boundary.",
      "Added after the boundary.",
    ]);
    expect(await campaignSessions(fork.campaign.id)).toHaveLength(1);

    // Opening the fork continues from the handoff and checkpoint, not the situation.
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
      const opening = await fetch(`${server.url}/api/sessions/${fork.session.id}/opening`, {
        method: "POST",
        headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(opening.status).toBe(200);
      await opening.body?.cancel();
      const history = calls[0].messages as Array<{ role: string; content: string }>;
      const prompt = history[0].content;
      expect(prompt).toContain("Handoff from the previous session: The party reached the northern pass at dusk.");
      expect(prompt).toContain("goal — Find the ledger: Checkpoint content.");
      expect(prompt).not.toContain("Edited after the boundary.");
      expect(prompt).not.toContain(seeded.situation);
      expect(history.slice(1)).toEqual([{ role: "user", content: "Begin the opening scene." }]);
    } finally {
      await server.stop();
    }
  });

  test("only completed sessions can fork", async () => {
    const seeded = await seedCampaign("ForkGuard", "Fork guard situation.");
    const open = await json(`/api/sessions/${seeded.session.id}/fork`, "POST", { name: "Too early" });
    expect(open.status).toBe(409);
    const openError = (await open.json()) as { code?: string };
    expect(openError.code).toBe("session_not_closed");
    const unknown = await json("/api/sessions/nope/fork", "POST", { name: "Nowhere" });
    expect(unknown.status).toBe(404);
    const malformed = await json(`/api/sessions/${seeded.session.id}/fork`, "POST", {});
    expect(malformed.status).toBe(400);
  });
});

describe("history context boundary", () => {
  test("input that would pass the completed-history limit is refused with nothing saved", async () => {
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
      const first = await postMessage(server.url, seeded.session.id, "a".repeat(HISTORY_CHARACTER_LIMIT - 100));
      expect(first.status).toBe(200);
      await first.body?.cancel();

      const before = await transcript(server.url, seeded.session.id);
      const over = await postMessage(server.url, seeded.session.id, "b".repeat(200));
      expect(over.status).toBe(413);
      const body = (await over.json()) as { code?: string; accepted?: boolean; error?: string };
      expect(body.code).toBe("context_limit");
      expect(body.accepted).toBe(false);
      expect(body.error).toContain("begin the next session");
      expect(await transcript(server.url, seeded.session.id)).toEqual(before);
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
      const character = createCharacter(db, { name: "Sable", description: "Ferrywoman spy." });
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
      const character = createCharacter(db, { name: "Sable", description: "Ferrywoman spy." });
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

      // A draft (interrupted) keeps the retry path open: on a second session,
      // an interrupted first attempt still allows exactly one more opening.
      beginNextSession(db, campaign.id, { title: "Next", handoff: "Race handoff." });
      const second = getCampaign(db, campaign.id)!;
      const draft = play.reserveOpening(second.active_session_id);
      expect(play.settlePending(draft.pendingId, "interrupted", "Half a dawn.")).toBe(true);
      const retry = play.reserveOpening(second.active_session_id);
      expect(retry.pendingId).not.toBeNull();
      expect(play.transcript(second.active_session_id).map((message) => message.status)).toEqual([
        "interrupted",
        "pending",
      ]);
    } finally {
      db.close();
      await removeDirectory(directory);
    }
  });
});

describe("state subject references", () => {
  test("subjects may reference captured snapshots or stay free-text labels", async () => {
    const world = await json("/api/worlds", "POST", {
      name: "Ref World",
      setting_brief: "Harbor kingdom.",
      suggested_starting_situation: "",
    });
    const worldId = ((await world.json()) as { world: { id: string } }).world.id;
    const entry = await json(`/api/worlds/${worldId}/entries`, "POST", {
      kind: "lore",
      name: "Drowned bell",
      description: "Rings beneath the pier at slack tide.",
    });
    const entryId = ((await entry.json()) as { entry: { id: string } }).entry.id;
    const protagonist = await json("/api/characters", "POST", {
      name: "Sable",
      description: "Ferrywoman spy.",
    });
    const protagonistId = ((await protagonist.json()) as { character: { id: string } }).character.id;
    const castMember = await json("/api/characters", "POST", {
      name: "Mira",
      description: "Harbormaster.",
    });
    const castId = ((await castMember.json()) as { character: { id: string } }).character.id;
    // A library character never captured by this campaign.
    const outsider = await json("/api/characters", "POST", {
      name: "Outsider",
      description: "Never captured.",
    });
    const outsiderId = ((await outsider.json()) as { character: { id: string } }).character.id;
    const created = await json("/api/campaigns", "POST", {
      world_id: worldId,
      protagonist_id: protagonistId,
      cast_character_ids: [castId],
      entry_ids: [entryId],
      starting_situation: "Ref situation.",
    });
    const campaign = ((await created.json()) as { campaign: Campaign }).campaign;

    const label = await json(`/api/campaigns/${campaign.id}/state`, "POST", {
      category: "internal",
      subject: "Sable's doubt",
      content: "She no longer trusts the harbormaster.",
    });
    expect(label.status).toBe(201);
    await label.body?.cancel();
    const listed = ((await (
      await json(`/api/campaigns/${campaign.id}/state`, "GET")
    ).json()) as { items: Array<{ subject_kind: string | null; subject_id: string | null }> }).items;
    expect(listed[0].subject_kind).toBeNull();
    expect(listed[0].subject_id).toBeNull();

    const characterRef = await json(`/api/campaigns/${campaign.id}/state`, "POST", {
      category: "goal",
      subject: "Mira",
      content: "Warily cooperative.",
      subject_kind: "character",
      subject_id: castId,
    });
    expect(characterRef.status).toBe(201);
    const refItem = (await characterRef.json()) as { subject_kind: string; subject_id: string };
    expect(refItem.subject_kind).toBe("character");
    expect(refItem.subject_id).toBe(castId);

    const entryRef = await json(`/api/campaigns/${campaign.id}/state`, "POST", {
      category: "knowledge",
      subject: "Drowned bell",
      content: "Its ring marks the smuggler's tide.",
      subject_kind: "entry",
      subject_id: entryId,
    });
    expect(entryRef.status).toBe(201);

    for (const body of [
      { category: "goal", subject: "X", content: "Y", subject_kind: "character", subject_id: outsiderId },
      { category: "goal", subject: "X", content: "Y", subject_kind: "character", subject_id: "nope" },
      { category: "goal", subject: "X", content: "Y", subject_kind: "entry", subject_id: castId },
      { category: "goal", subject: "X", content: "Y", subject_kind: "character", subject_id: entryId },
      { category: "goal", subject: "X", content: "Y", subject_kind: "character" },
      { category: "goal", subject: "X", content: "Y", subject_id: castId },
      { category: "goal", subject: "X", content: "Y", subject_kind: "deity", subject_id: "z" },
    ]) {
      const refused = await json(`/api/campaigns/${campaign.id}/state`, "POST", body);
      expect(refused.status).toBe(400);
    }

    // PATCH: half updates on a label refuse; the pair sets and clears together.
    const items = ((await (
      await json(`/api/campaigns/${campaign.id}/state`, "GET")
    ).json()) as { items: Array<{ id: string }> }).items;
    const labelId = items[0].id;
    const halfId = await json(`/api/campaigns/${campaign.id}/state/${labelId}`, "PATCH", {
      subject_id: castId,
    });
    expect(halfId.status).toBe(400);
    const halfKind = await json(`/api/campaigns/${campaign.id}/state/${labelId}`, "PATCH", {
      subject_kind: "entry",
    });
    expect(halfKind.status).toBe(400);
    const setPair = await json(`/api/campaigns/${campaign.id}/state/${labelId}`, "PATCH", {
      subject_kind: "character",
      subject_id: protagonistId,
    });
    expect(setPair.status).toBe(200);
    const setItem = (await setPair.json()) as { subject_kind: string; subject_id: string };
    expect(setItem.subject_kind).toBe("character");
    expect(setItem.subject_id).toBe(protagonistId);
    const clearPair = await json(`/api/campaigns/${campaign.id}/state/${labelId}`, "PATCH", {
      subject_kind: null,
      subject_id: null,
    });
    expect(clearPair.status).toBe(200);
    const cleared = (await clearPair.json()) as { subject_kind: string | null; subject_id: string | null };
    expect(cleared.subject_kind).toBeNull();
    expect(cleared.subject_id).toBeNull();

    // Refs survive the boundary checkpoint and the fork.
    await json(`/api/campaigns/${campaign.id}/sessions`, "POST", {
      title: "Next",
      handoff: "Handoff with references.",
    });
    const forked = await json(`/api/sessions/${campaign.active_session_id}/fork`, "POST", { name: "Ref fork" });
    const fork = (await forked.json()) as { campaign: Campaign };
    const forkItems = ((await (
      await json(`/api/campaigns/${fork.campaign.id}/state`, "GET")
    ).json()) as { items: Array<{ subject_kind: string | null; subject_id: string | null; subject: string }> }).items;
    expect(forkItems.map((item) => [item.subject, item.subject_kind, item.subject_id])).toContainEqual([
      "Mira",
      "character",
      castId,
    ]);
    expect(forkItems.map((item) => [item.subject, item.subject_kind, item.subject_id])).toContainEqual([
      "Drowned bell",
      "entry",
      entryId,
    ]);
  });
});

describe("restart and persistence", () => {
  test("state, sessions, checkpoints, and fork provenance survive a restart", async () => {
    const seeded = await seedCampaign("Restart", "Restart situation.");
    await json(`/api/campaigns/${seeded.campaign.id}/state`, "POST", {
      category: "knowledge",
      subject: "Hidden ledger",
      content: "Stored beneath the pier.",
    });
    await json(`/api/campaigns/${seeded.campaign.id}/sessions`, "POST", {
      title: "After the storm",
      handoff: "The party sheltered in the lighthouse.",
    });
    const fork = (await (
      await json(`/api/sessions/${seeded.session.id}/fork`, "POST", { name: "Restarted fork" })
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

test("directional relationship API validates subjects, revisions, and session events", async () => {
  const { campaign, session } = await seedCampaign("Relationship API", "A meeting at the harbor.");
  const subjectsResponse = await json(`/api/campaigns/${campaign.id}/relationships`, "GET");
  expect(subjectsResponse.status).toBe(200);
  const subjects = (await subjectsResponse.json()) as { subjects: Array<{ id: string; kind: string }> };
  expect(subjects.subjects.some((subject) => subject.id === campaign.protagonist_snapshot.id)).toBe(true);
  const createdSubject = await json(`/api/campaigns/${campaign.id}/relationship-subjects`, "POST", { name: "Aven" });
  expect(createdSubject.status).toBe(201);
  const target = ((await createdSubject.json()) as { subject: { id: string } }).subject.id;
  const document = { how_met: "At the harbor.", status: "cautious", stats: {}, known_facts: [], sections: [] };
  const created = await json(`/api/campaigns/${campaign.id}/relationships`, "POST", {
    source_id: campaign.protagonist_snapshot.id,
    target_id: target,
    document,
  });
  expect(created.status).toBe(201);
  const relationship = ((await created.json()) as { relationship: { id: string; revision: number } }).relationship;
  expect((await json(`/api/campaigns/${campaign.id}/relationships`, "POST", {
    source_id: campaign.protagonist_snapshot.id,
    target_id: target,
    document,
  })).status).toBe(400);
  expect((await json(`/api/campaigns/${campaign.id}/relationships`, "POST", {
    source_id: campaign.protagonist_snapshot.id,
    target_id: target,
    document: { ...document, hidden: "field" },
  })).status).toBe(400);
  const updated = await json(`/api/campaigns/${campaign.id}/relationships/${relationship.id}`, "PATCH", {
    document: { ...document, status: "trusting" },
    revision: relationship.revision,
  });
  expect(updated.status).toBe(200);
  expect((await json(`/api/campaigns/${campaign.id}/relationships/${relationship.id}`, "PATCH", {
    document,
    revision: relationship.revision,
  })).status).toBe(409);
  const eventResponse = await json(`/api/campaigns/${campaign.id}/relationships/${relationship.id}/events`, "POST", {
    description: "Aven offered a map.",
  });
  expect(eventResponse.status).toBe(201);
  const event = ((await eventResponse.json()) as { event: { session_id: string; description: string } }).event;
  expect(event.session_id).toBe(session.id);
  expect(event.description).toBe("Aven offered a map.");
  const events = await json(`/api/campaigns/${campaign.id}/relationships/${relationship.id}/events`, "GET");
  expect(((await events.json()) as { events: unknown[] }).events).toHaveLength(1);
});
