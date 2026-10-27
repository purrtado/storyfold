import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventType } from "@tanstack/ai";
import type { Character, Chat, Relationship, World } from "../../shared/domain";
import { DEFAULT_PROMPT_CARDS } from "../../shared/narration";
import { createChat } from "../chats";
import { openDatabase } from "../db";
import { chatSystemPrompt } from "../grounding";
import { createCharacter, createWorld, parseCharacterInput, updateCharacter } from "../worlds";
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
  databasePath = join(configDirectory, "characters.db");
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

async function createWorldViaApi(name: string): Promise<World> {
  const response = await json("POST", "/api/worlds", { name, setting_brief: "b" });
  expect(response.status).toBe(201);
  return ((await response.json()) as { world: World }).world;
}

async function createWorldCharacter(worldId: string, body: Record<string, unknown>): Promise<Character> {
  const response = await json("POST", `/api/worlds/${worldId}/characters`, body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { character: Character }).character;
}

async function getCharacter(id: string): Promise<Character> {
  const response = await json("GET", `/api/characters/${id}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { character: Character }).character;
}

async function listCharacters(worldId: string): Promise<Character[]> {
  const response = await json("GET", `/api/worlds/${worldId}/characters`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { characters: Character[] }).characters;
}

async function createChatViaApi(worldId: string, body: Record<string, unknown>): Promise<Chat> {
  const response = await json("POST", `/api/worlds/${worldId}/chats`, body);
  expect(response.status).toBe(201);
  return ((await response.json()) as { chat: Chat }).chat;
}

describe("world characters API", () => {
  test("characters live in their world, carry knowledge, and are edited and deleted via /api/characters/:id", async () => {
    const world = await createWorldViaApi("Ember Coast");
    const other = await createWorldViaApi("Other Coast");
    const brann = await createWorldCharacter(world.id, {
      name: "Brann",
      description: "Harbormaster.",
      personality: "Gruff.",
      knowledge: "Knows the smugglers' tide table.",
    });
    expect(brann.world_id).toBe(world.id);
    expect(brann.knowledge).toBe("Knows the smugglers' tide table.");
    expect([brann.context_mode, brann.sticky, brann.summary, brann.aliases]).toEqual(["in_scene", 4, "", []]);
    expect([brann.stats_enabled, brann.stats, brann.avatar_id]).toEqual([false, {}, null]);

    const plain = await createWorldCharacter(world.id, { name: "Moro", description: "A cartographer." });
    expect([plain.appearance, plain.personality, plain.intimacy, plain.knowledge, plain.memories, plain.thoughts]).toEqual(["", "", "", "", "", ""]);

    expect((await listCharacters(world.id)).map((character) => character.id)).toEqual([brann.id, plain.id]);
    expect(await listCharacters(other.id)).toEqual([]);
    expect(await getCharacter(brann.id)).toEqual(brann);

    const patched = await json("PATCH", `/api/characters/${brann.id}`, { name: "Brann the Elder", knowledge: "" });
    expect(patched.status).toBe(200);
    const patchedCharacter = ((await patched.json()) as { character: Character }).character;
    expect([patchedCharacter.name, patchedCharacter.knowledge, patchedCharacter.description]).toEqual([
      "Brann the Elder",
      "",
      "Harbormaster.",
    ]);
    expect(await getCharacter(brann.id)).toEqual(patchedCharacter);

    const removed = await json("DELETE", `/api/characters/${brann.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await json("GET", `/api/characters/${brann.id}`)).status).toBe(404);
    expect((await json("PATCH", `/api/characters/${brann.id}`, { name: "Gone" })).status).toBe(404);
    expect((await json("DELETE", `/api/characters/${brann.id}`)).status).toBe(404);
    expect((await listCharacters(world.id)).map((character) => character.id)).toEqual([plain.id]);
  });

  test("validates profile input on create and patch", async () => {
    const world = await createWorldViaApi("Validation");
    const create = (body: Record<string, unknown>) => json("POST", `/api/worlds/${world.id}/characters`, body);

    for (const body of [{ description: "No name." }, { name: "No description" }, { name: "  ", description: "Blank." }]) {
      const response = await create(body);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code?: string }).code).toBe("invalid_input");
    }
    expect((await create({ name: "Typed", description: "d", knowledge: 7 })).status).toBe(400);
    expect((await json("POST", "/api/worlds/no-such-world/characters", { name: "Ghost", description: "d" })).status).toBe(404);
    expect(await listCharacters(world.id)).toEqual([]);

    const character = await createWorldCharacter(world.id, { name: "Maera", description: "Keeper of the light." });
    expect((await json("PATCH", `/api/characters/${character.id}`, {})).status).toBe(400);
    expect((await json("PATCH", `/api/characters/${character.id}`, { name: "" })).status).toBe(400);
    expect((await json("PATCH", `/api/characters/${character.id}`, { knowledge: 7 })).status).toBe(400);
    expect(await getCharacter(character.id)).toEqual(character);
  });

  test("there is no global character list, library creation, or copy route", async () => {
    const world = await createWorldViaApi("No Library");
    const character = await createWorldCharacter(world.id, { name: "Maera", description: "Keeper of the light." });

    expect((await json("GET", "/api/characters")).status).toBe(404);
    expect((await json("POST", "/api/characters", { name: "Loose", description: "Belongs nowhere." })).status).toBe(404);
    for (const path of [
      `/api/characters/${character.id}/copy-to-library`,
      `/api/campaigns/any/characters/${character.id}/save-to-world`,
    ]) {
      expect((await json("POST", path)).status).toBeGreaterThanOrEqual(400);
    }
    expect((await listCharacters(world.id)).map((entry) => entry.id)).toEqual([character.id]);
  });

  test("scene fields default sensibly, are validated, and can be set on create and patch", async () => {
    const world = await createWorldViaApi("Scenes");
    const created = await createWorldCharacter(world.id, {
      name: "Oren",
      description: "A retired navigator.",
      context_mode: "mentioned",
      summary: "  Old navigator.  ",
      aliases: ["Navigator", "navigator", " Old Sea Dog "],
      sticky: 0,
    });
    expect([created.context_mode, created.summary, created.aliases, created.sticky]).toEqual([
      "mentioned",
      "Old navigator.",
      ["Navigator", "Old Sea Dog"],
      0,
    ]);

    const patch = (body: Record<string, unknown>) => json("PATCH", `/api/characters/${created.id}`, body);
    const sceneOnly = await patch({ context_mode: "always" });
    expect(sceneOnly.status).toBe(200);
    const updated = ((await sceneOnly.json()) as { character: Character }).character;
    expect([updated.context_mode, updated.name, updated.summary, updated.sticky]).toEqual([
      "always",
      "Oren",
      "Old navigator.",
      0,
    ]);
    expect((await patch({ sticky: 12, aliases: [] })).status).toBe(200);
    expect((await getCharacter(created.id)).aliases).toEqual([]);

    const invalid: Array<Record<string, unknown>> = [
      { context_mode: "sometimes" },
      { summary: "two\nlines" },
      { summary: "x".repeat(201) },
      { summary: 3 },
      { aliases: "Navigator" },
      { aliases: [""] },
      { sticky: -1 },
      { sticky: 51 },
      { sticky: 1.5 },
    ];
    for (const body of invalid) {
      expect((await patch(body)).status).toBe(400);
      expect((await json("POST", `/api/worlds/${world.id}/characters`, { name: "Bad", description: "d", ...body })).status).toBe(400);
    }
    const unchanged = await getCharacter(created.id);
    expect([unchanged.context_mode, unchanged.sticky, unchanged.summary]).toEqual(["always", 12, "Old navigator."]);
    expect(await listCharacters(world.id)).toHaveLength(1);
  });

  test("a protagonist cannot be deleted until its chats are gone; other deletions cascade relationships", async () => {
    const world = await createWorldViaApi("Cast World");
    const hero = await createWorldCharacter(world.id, { name: "Player One", description: "The played character." });
    const companion = await createWorldCharacter(world.id, { name: "Maera", description: "Keeper of the light." });
    const relationship = await json("POST", `/api/worlds/${world.id}/relationships`, {
      source_id: hero.id,
      target_id: companion.id,
      how_met: "At the pier.",
    });
    expect(relationship.status).toBe(201);
    const chat = await createChatViaApi(world.id, { protagonist_id: hero.id, opening: "A storm approaches." });

    const refused = await json("DELETE", `/api/characters/${hero.id}`);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code?: string }).code).toBe("conflict");
    expect(await getCharacter(hero.id)).toEqual(hero);
    const intact = (await (await json("GET", `/api/worlds/${world.id}/relationships`)).json()) as {
      relationships: Relationship[];
    };
    expect(intact.relationships).toHaveLength(1);

    expect((await json("DELETE", `/api/chats/${chat.id}`)).status).toBe(200);
    expect((await json("DELETE", `/api/characters/${hero.id}`)).status).toBe(200);
    const after = (await (await json("GET", `/api/worlds/${world.id}/relationships`)).json()) as {
      relationships: Relationship[];
    };
    expect(after.relationships).toEqual([]);
    expect((await listCharacters(world.id)).map((character) => character.id)).toEqual([companion.id]);
  });
});

describe("character edits reach narration", () => {
  test("a live edit shows in the next system prompt and the player speaks with the current name", async () => {
    await configureProvider(base.url, "test-key-world-characters");

    const world = await createWorldViaApi("Prompt World");
    const hero = await createWorldCharacter(world.id, { name: "Stale Name", description: "The played character." });
    const chat = await createChatViaApi(world.id, { protagonist_id: hero.id, opening: "A storm approaches." });

    const patched = await json("PATCH", `/api/characters/${hero.id}`, {
      name: "Current Name",
      personality: "Fearless, loudly.",
      knowledge: "The ferry schedule by heart.",
    });
    expect(patched.status).toBe(200);

    const calls: Array<Record<string, unknown>> = [];
    const upstream = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(openAiChatCompletionSse("glm-5.3", ["Narration."]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const response = await fetch(`${server.url}/api/chats/${chat.id}/messages`, {
        method: "POST",
        headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
        body: JSON.stringify({ content: "I watch the docks." }),
      });
      expect(response.status).toBe(200);
      const events = parseSseEvents(await response.text());
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);

      const history = calls[0]!.messages as Array<{ role: string; content: string }>;
      expect(history[0]!.role).toBe("system");
      expect(history[0]!.content).toContain("Current Name");
      expect(history[0]!.content).not.toContain("Stale Name");
      expect(history[0]!.content).toContain("Fearless, loudly.");
      expect(history[0]!.content).toContain("The played character.");
      expect(history[0]!.content).toContain("<knows>The ferry schedule by heart.</knows>");

      const transcriptResponse = await fetch(`${server.url}/api/chats/${chat.id}/messages`, { headers: headersWith() });
      const transcript = (await transcriptResponse.json()) as {
        messages: Array<{ role: string; speaker_name: string }>;
      };
      expect(transcript.messages.find((message) => message.role === "user")?.speaker_name).toBe("Current Name");
    } finally {
      await server.stop();
    }
  });
});

describe("knowledge in the system prompt", () => {
  test("Knows shows for the protagonist and always-sent cast only, under the knowledge boundaries card", () => {
    const directory = mkdtempSync(join(tmpdir(), "storyfold-knowledge-"));
    try {
      const db = openDatabase(join(directory, "storyfold.db"));
      const world = createWorld(db, { name: "Secrets", setting_brief: "A harbor of rumors." });
      const add = (name: string, knowledge: string) =>
        createCharacter(db, world.id, parseCharacterInput({ name, description: `${name} of the harbor.`, knowledge }))!;
      const mira = add("Mira", "Where the ledger is hidden.");
      const oren = add("Oren", "The captain's real name.");
      const tamsin = add("Tamsin", "Who sank the Marigold.");
      updateCharacter(db, oren.id, { context_mode: "always" });
      updateCharacter(db, tamsin.id, { context_mode: "in_scene", summary: "Dockhand." });
      const chat = createChat(db, world.id, { protagonist_id: mira.id, opening: "Dawn." })!;

      const prompt = chatSystemPrompt(db, chat);
      expect(prompt).toContain('<character name="Mira">\n  <description>Mira of the harbor.</description>\n  <knows>Where the ledger is hidden.</knows>\n</character>');
      expect(prompt).toContain('<character name="Oren">\n  <description>Oren of the harbor.</description>\n  <knows>The captain\'s real name.</knows>\n</character>');
      expect(prompt).toContain("- Tamsin: Dockhand.");
      expect(prompt).not.toContain("Who sank the Marigold.");

      const card = DEFAULT_PROMPT_CARDS.find((candidate) => candidate.title === "Knowledge boundaries");
      expect(card).toBeDefined();
      expect(prompt).toContain(card!.body);
      expect(prompt.indexOf(card!.body)).toBeGreaterThan(prompt.indexOf("<knows>The captain's real name.</knows>"));
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
