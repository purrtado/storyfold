import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventType } from "@tanstack/ai";
import { join } from "node:path";
import type { Character, Chat, Message, World, WorldEntry } from "../../shared/domain";
import type { CharacterPrompt } from "../../shared/narration";
import { DEFAULT_PROMPT_CARDS, NARRATION_TOKEN_BUDGET, narratorSystemPrompt } from "../../shared/narration";
import { countTokens } from "../../shared/tokens";
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

const TRUSTED_ORIGIN = "http://localhost:5173";

let configDirectory: string;
let databasePath: string;
let base: TestServer;

beforeAll(async () => {
  configDirectory = await makeConfigDirectory();
  databasePath = join(configDirectory, "world-entries.db");
  base = await startTestServer({ configDirectory, databasePath });
});

afterAll(async () => {
  await base?.stop();
  if (configDirectory) await removeDirectory(configDirectory);
});

function json(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base.url}${path}`, {
    method,
    headers: headersWith({ "content-type": "application/json", origin: TRUSTED_ORIGIN }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function createWorld(body: Record<string, unknown>): Promise<World> {
  const response = await json("POST", "/api/worlds", body);
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { world: World };
  return payload.world;
}

async function createCharacter(worldId: string, body: Record<string, unknown>): Promise<Character> {
  const response = await json("POST", `/api/worlds/${worldId}/characters`, body);
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { character: Character };
  return payload.character;
}

interface ApiResult {
  status: number;
  entry?: WorldEntry;
  chat?: Chat;
  error?: string;
  code?: string;
}

async function createEntry(worldId: string, body: Record<string, unknown>): Promise<ApiResult> {
  const response = await json("POST", `/api/worlds/${worldId}/entries`, body);
  return { status: response.status, ...(await response.json()) };
}

async function patchEntry(
  worldId: string,
  entryId: string,
  body: Record<string, unknown>,
): Promise<ApiResult> {
  const response = await json("PATCH", `/api/worlds/${worldId}/entries/${entryId}`, body);
  return { status: response.status, ...(await response.json()) };
}

async function createChat(worldId: string, body: Record<string, unknown>): Promise<ApiResult> {
  const response = await json("POST", `/api/worlds/${worldId}/chats`, body);
  return { status: response.status, ...(await response.json()) };
}

describe("world entries API", () => {
  test("creates, lists, patches and deletes entries with ISO timestamps", async () => {
    const world = await createWorld({ name: "Ember Coast", setting_brief: "Tide-locked cliffs." });

    const created = await createEntry(world.id, {
      kind: "  location  ",
      name: "  Maera  ",
      description: "Keeper of the drowned lighthouse.",
    });
    expect(created.status).toBe(201);
    expect(created.entry?.kind).toBe("location");
    expect(created.entry?.name).toBe("Maera");
    expect(created.entry?.world_id).toBe(world.id);
    expect(Number.isNaN(Date.parse(created.entry!.created_at))).toBe(false);
    expect(Number.isNaN(Date.parse(created.entry!.updated_at))).toBe(false);
    expect(created.entry?.created_at).toBe(created.entry?.updated_at);

    const scene = await createEntry(world.id, {
      kind: "scene",
      name: "Ashfall landing",
      description: "The ferry scrapes ashore as cinders drift like snow.",
    });
    expect(scene.status).toBe(201);

    const listResponse = await json("GET", `/api/worlds/${world.id}/entries`);
    const list = (await listResponse.json()) as { entries: WorldEntry[] };
    // Same-millisecond inserts make (created_at, id) order UUID-dependent, so
    // assert members, not sequence.
    expect(list.entries.map((entry) => entry.name).sort()).toEqual(["Ashfall landing", "Maera"]);

    const patched = await patchEntry(world.id, created.entry!.id, { name: "Maera Vane" });
    expect(patched.status).toBe(200);
    expect(patched.entry?.name).toBe("Maera Vane");
    expect(patched.entry?.kind).toBe("location");
    expect(patched.entry?.description).toBe("Keeper of the drowned lighthouse.");
    expect(patched.entry?.created_at).toBe(created.entry?.created_at);

    const removed = await json("DELETE", `/api/worlds/${world.id}/entries/${created.entry!.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await json("DELETE", `/api/worlds/${world.id}/entries/${created.entry!.id}`)).status).toBe(404);
  });

  test("entry deletion requires a trusted Origin and preserves entries on rejection", async () => {
    const world = await createWorld({ name: "Protected", setting_brief: "b" });
    const entry = (await createEntry(world.id, { kind: "lore", name: "Protected lore", description: "Keep this." })).entry!;
    const path = `/api/worlds/${world.id}/entries/${entry.id}`;
    for (const origin of [null, "https://attacker.example"]) {
      const response = await fetch(`${base.url}${path}`, {
        method: "DELETE",
        headers: headersWith(origin === null ? {} : { origin }),
      });
      expect(response.status).toBe(403);
      const listed = await (await json("GET", `/api/worlds/${world.id}/entries`)).json() as { entries: WorldEntry[] };
      expect(listed.entries.map(({ id }) => id)).toContain(entry.id);
    }
    expect((await json("DELETE", path)).status).toBe(200);
    const listed = await (await json("GET", `/api/worlds/${world.id}/entries`)).json() as { entries: WorldEntry[] };
    expect(listed.entries.map(({ id }) => id)).not.toContain(entry.id);
  });

  test("rejects invalid payloads with invalid_input and unknown routes with not_found", async () => {
    const world = await createWorld({ name: "Validation", setting_brief: "b" });

    for (const body of [
      {},
      { kind: "monster", name: "n", description: "d" },
      { kind: "lore", name: "  ", description: "d" },
      { kind: "lore", name: "n", description: "" },
    ]) {
      const result = await createEntry(world.id, body);
      expect(result.status).toBe(400);
      expect(result.code).toBe("invalid_input");
    }

    expect((await createEntry("no-such-world", { kind: "lore", name: "n", description: "d" })).status).toBe(404);
    expect((await json("GET", "/api/worlds/no-such-world/entries")).status).toBe(404);

    const entry = (await createEntry(world.id, { kind: "lore", name: "n", description: "d" })).entry!;
    expect((await patchEntry(world.id, entry.id, {})).status).toBe(400);
    expect((await patchEntry(world.id, entry.id, { kind: "faction" })).status).toBe(400);
    expect((await patchEntry(world.id, "no-such-entry", { name: "x" })).status).toBe(404);
    expect((await patchEntry(world.id, entry.id, { name: "kept" })).status).toBe(200);
  });

  test("entries are world-scoped: another world's entry is just missing", async () => {
    const worldA = await createWorld({ name: "World A", setting_brief: "a" });
    const worldB = await createWorld({ name: "World B", setting_brief: "b" });
    const entry = (await createEntry(worldA.id, { kind: "location", name: "Sunken Archive", description: "d" })).entry!;

    const listResponse = await json("GET", `/api/worlds/${worldB.id}/entries`);
    const listB = (await listResponse.json()) as { entries: WorldEntry[] };
    expect(listB.entries).toEqual([]);
    expect((await patchEntry(worldB.id, entry.id, { name: "Hijacked" })).status).toBe(404);
    expect((await json("DELETE", `/api/worlds/${worldB.id}/entries/${entry.id}`)).status).toBe(404);
    expect((await patchEntry(worldA.id, entry.id, { name: "Renamed" })).status).toBe(200);
  });
});

describe("opening prompt budget", () => {
  test("chat creation is refused exactly when the opening prompt passes the budget", async () => {
    const brief = "b".repeat(100_000);
    const entryDescription = "l".repeat(40_000);
    const protagonistPrompt = (description: string): CharacterPrompt => ({
      id: "p", name: "P", description, appearance: "", personality: "", background: "",
      baseline_motivations: "", speaking_style: "", knowledge: "", stats_enabled: false, stats: {},
    });
    const promptTokens = (descriptionLength: number) => countTokens(narratorSystemPrompt(DEFAULT_PROMPT_CARDS.map((card) => ({ ...card, enabled: true })), {
      world: { name: "Boundary", setting_brief: brief, entries: [{ kind: "lore", name: "Compact", description: entryDescription, keywords: [] }] },
      opening: "s",
      stats: [],
      protagonist: protagonistPrompt("d".repeat(descriptionLength)),
      cast: [],
      relationships: [],
      has_history: false,
    }));
    // Longest description whose prompt still fits; one more character passes the budget.
    let low = 1;
    let high = 100_000;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (promptTokens(middle) <= NARRATION_TOKEN_BUDGET) low = middle;
      else high = middle - 1;
    }
    expect(promptTokens(low)).toBe(NARRATION_TOKEN_BUDGET);
    expect(promptTokens(low + 1)).toBe(NARRATION_TOKEN_BUDGET + 1);

    const worldWithProtagonist = async (descriptionLength: number) => {
      const world = await createWorld({ name: "Boundary", setting_brief: brief });
      await createEntry(world.id, { kind: "lore", name: "Compact", description: entryDescription });
      const protagonist = await createCharacter(world.id, { name: "P", description: "d".repeat(descriptionLength) });
      return { world, protagonist };
    };
    const exact = await worldWithProtagonist(low);
    const over = await worldWithProtagonist(low + 1);

    const fits = await createChat(exact.world.id, { protagonist_id: exact.protagonist.id, opening: "s" });
    expect(fits.status).toBe(201);
    const refused = await createChat(over.world.id, { protagonist_id: over.protagonist.id, opening: "s" });
    expect(refused.status).toBe(400);
    expect(refused.code).toBe("invalid_input");
    expect(refused.error).toContain(String(NARRATION_TOKEN_BUDGET));
    const listed = (await (await json("GET", `/api/worlds/${over.world.id}/chats`)).json()) as { chats: Chat[] };
    expect(listed.chats).toEqual([]);
  });
});

describe("live world grounding", () => {
  test("narration reads the world as it is now; scenes never reach the narrator", async () => {
    await configureProvider(base.url, "test-key-world-entries");

    const world = await createWorld({ name: "Veloria", setting_brief: "A rain-soaked harbor kingdom." });
    const other = await createWorld({ name: "Other", setting_brief: "o" });
    const protagonist = await createCharacter(world.id, { name: "Sable", description: "A cynical ferrywoman spy." });
    const kept = (await createEntry(world.id, { kind: "lore", name: "Maera", description: "Lighthouse keeper." })).entry!;
    await createEntry(world.id, { kind: "scene", name: "Dawn docking", description: "The ferry scrapes ashore." });
    await createEntry(other.id, { kind: "lore", name: "Foreign", description: "Another world's lore." });

    const chat = await createChat(world.id, { protagonist_id: protagonist.id, opening: "Sable docks at dawn." });
    expect(chat.status).toBe(201);
    await createEntry(world.id, { kind: "location", name: "Quarantine", description: "Off-limits pier." });
    await patchEntry(world.id, kept.id, { description: "Lighthouse keeper, newly widowed." });

    const calls: Array<Record<string, unknown>> = [];
    const upstream = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(openAiChatCompletionSse("glm-5.3", ["The lighthouse answers."]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const response = await fetch(`${server.url}/api/chats/${chat.chat!.id}/opening`, {
        method: "POST",
        headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(200);
      const events = parseSseEvents(await response.text());
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);

      const history = calls[0]!.messages as Array<{ role: string; content: string }>;
      const system = history[0]!;
      expect(system.role).toBe("system");
      expect(system.content).toContain("Lighthouse keeper, newly widowed.");
      expect(system.content).toContain("Quarantine");
      expect(system.content).toContain("Off-limits pier");
      expect(system.content).toContain("Veloria");
      expect(system.content).toContain("Sable");
      expect(system.content).toContain("Sable docks at dawn.");
      expect(system.content).not.toContain("Dawn docking");
      expect(system.content).not.toContain("The ferry scrapes ashore.");
      expect(system.content).not.toContain("Another world's lore.");
    } finally {
      await server.stop();
    }
  });

  test("keyword entries and in-scene cast join only replies whose recent messages mention them, after the player's input", async () => {
    await configureProvider(base.url, "test-key-world-entries");

    const world = await createWorld({ name: "Widow's Bay", setting_brief: "A fog-bound fishing town." });
    const protagonist = await createCharacter(world.id, { name: "Sable", description: "A new student." });
    await createEntry(world.id, { kind: "location", name: "Harbor", description: "Always-known docks." });
    await createEntry(world.id, { kind: "location", name: "Widow High", description: "The town's only high school.", keywords: ["school"] });
    await createCharacter(world.id, { name: "Ria", description: "Sable's lab partner, always sketching." });
    const created = await createChat(world.id, { protagonist_id: protagonist.id, opening: "Sable arrives in town." });
    const chatId = created.chat!.id;

    const calls: Array<Array<{ role: string; content: string }>> = [];
    const upstream = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push((JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> }).messages);
      return new Response(openAiChatCompletionSse("glm-5.3", ["Fog rolls in."]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    const play = async (path: string, body: Record<string, unknown>) => {
      const response = await fetch(`${server.url}/api/chats/${chatId}/${path}`, {
        method: "POST",
        headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(parseSseEvents(await response.text()).at(-1)?.type).toBe(EventType.RUN_FINISHED);
    };
    try {
      await play("opening", {});
      await play("messages", { content: "I walk to school with Ria.", direction: "Keep it short." });
      await play("messages", { content: "I wait." });

      const [opening, school, later] = calls;
      for (const messages of calls) {
        expect(messages[0]!.content).toContain("Always-known docks.");
        expect(messages[0]!.content).toContain("Elsewhere — not in the current scene:\n- Ria\n");
        expect(messages[0]!.content).not.toContain("The town's only high school.");
        expect(messages[0]!.content).not.toContain("always sketching");
      }
      expect(opening!.at(-1)!.content).not.toContain("Context for this reply");
      expect(school!.at(-1)!.content).toBe(
        "I walk to school with Ria.\n\n(Context for this reply, not part of the player's message:\n" +
          "Characters present or mentioned:\n- Ria: Sable's lab partner, always sketching.\n" +
          "World lore:\n- location: Widow High — The town's only high school.)\n\n(OOC: Keep it short.)",
      );
      // Ria stays for 4 more messages after her mention; the school does not.
      const laterText = later!.map((message) => message.content).join("\n");
      expect(laterText).toContain("- Ria: Sable's lab partner, always sketching.");
      expect(laterText).not.toContain("The town's only high school.");

      const response = await fetch(`${server.url}/api/chats/${chatId}/messages`, { headers: headersWith() });
      const { messages } = (await response.json()) as { messages: Message[] };
      expect(messages.filter((message) => message.role === "assistant").map((message) => message.lore)).toEqual([
        null,
        { used: ["Ria", "Widow High"], dropped: [] },
        { used: ["Ria"], dropped: [] },
      ]);
    } finally {
      await server.stop();
    }
  });
});
