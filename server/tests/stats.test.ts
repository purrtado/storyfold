import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Character, Relationship, StatDefinition, World } from "../../shared/domain";
import { openDatabase } from "../db";
import { createChat } from "../chats";
import { chatSystemPrompt } from "../grounding";
import { createRelationship, parseRelationshipPatch, updateRelationship } from "../relationships";
import {
  STAT_COUNT_LIMIT,
  createCharacter,
  createStatDefinition,
  createWorld,
  listStatDefinitions,
  parseCharacterInput,
  parseStatInput,
  updateCharacter,
} from "../worlds";
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

const API_KEY = "sk-zai-stats-test-key";
const TRUSTED_ORIGIN = "http://localhost:5173";

let configDirectory: string;
let databasePath: string;
let base: TestServer;

beforeAll(async () => {
  configDirectory = await makeConfigDirectory();
  databasePath = join(configDirectory, "stats.db");
  base = await startTestServer({ configDirectory, databasePath });
  await configureProvider(base.url, API_KEY);
});

afterAll(async () => {
  await base?.stop();
  if (configDirectory) await removeDirectory(configDirectory);
});

async function json(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base.url}${path}`, {
    method,
    headers: headersWith({ origin: TRUSTED_ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) }),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function statFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    applies_to: "character",
    label: "Grit",
    description: "Plain stubbornness under pressure.",
    low_label: "spent",
    high_label: "unbreakable",
    min: 0,
    max: 10,
    default_value: 5,
    color: "red",
    ...overrides,
  };
}

async function createdStat(response: Response): Promise<StatDefinition> {
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { stat: StatDefinition };
  return payload.stat;
}

async function postWorld(body: Record<string, unknown>): Promise<World> {
  const response = await json("POST", "/api/worlds", body);
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { world: World };
  return payload.world;
}

async function listWorldStats(worldId: string): Promise<StatDefinition[]> {
  const response = await json("GET", `/api/worlds/${worldId}/stats`);
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { stats: StatDefinition[] };
  return payload.stats;
}

async function listWorldCharacters(worldId: string): Promise<Character[]> {
  const response = await json("GET", `/api/worlds/${worldId}/characters`);
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { characters: Character[] };
  return payload.characters;
}

async function listWorldRelationships(worldId: string): Promise<Relationship[]> {
  const response = await json("GET", `/api/worlds/${worldId}/relationships`);
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { relationships: Relationship[] };
  return payload.relationships;
}

/** A world holding one character stat (Grit, default 5), one relationship stat (Rapport, default 2), and two characters. */
async function seedWorld(): Promise<{
  world: World;
  grit: StatDefinition;
  rapport: StatDefinition;
  mira: Character;
  oren: Character;
}> {
  const world = await postWorld({ name: "Seeded", setting_brief: "A quiet harbor." });
  const grit = await createdStat(await json("POST", `/api/worlds/${world.id}/stats`, statFields()));
  const rapport = await createdStat(
    await json("POST", `/api/worlds/${world.id}/stats`, statFields({
      applies_to: "relationship",
      label: "Rapport",
      default_value: 2,
      color: "teal",
    })),
  );
  const characters: Character[] = [];
  for (const name of ["Mira", "Oren"]) {
    const response = await json("POST", `/api/worlds/${world.id}/characters`, {
      name,
      description: `A quiet sailor named ${name}.`,
    });
    expect(response.status).toBe(201);
    characters.push(((await response.json()) as { character: Character }).character);
  }
  return { world, grit, rapport, mira: characters[0]!, oren: characters[1]! };
}

async function completeTurn(chatId: string, content: string, reply: string): Promise<void> {
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
    const response = await fetch(`${server.url}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ content }),
    });
    expect(response.status).toBe(200);
    expect(parseSseEvents(await response.text()).length).toBeGreaterThan(0);
  } finally {
    await server.stop();
  }
}

describe("stat bank seed", () => {
  test("a fresh database seeds the 8 bank stats; reopening does not duplicate them", () => {
    const directory = mkdtempSync(join(tmpdir(), "storyfold-stats-seed-"));
    try {
      const path = join(directory, "storyfold.db");
      const first = openDatabase(path);
      const seeded = listStatDefinitions(first, null);
      expect(seeded.map((stat) => [stat.applies_to, stat.label, stat.min, stat.max])).toEqual([
        ["character", "Health", 0, 10],
        ["character", "Stamina", 0, 10],
        ["character", "Stress", 0, 10],
        ["character", "Morale", 0, 10],
        ["relationship", "Trust", 0, 10],
        ["relationship", "Affection", 0, 10],
        ["relationship", "Respect", 0, 10],
        ["relationship", "Tension", 0, 10],
      ]);
      expect(seeded.every((stat) => stat.world_id === null)).toBe(true);
      first.close();
      const reopened = openDatabase(path);
      expect(listStatDefinitions(reopened, null)).toHaveLength(8);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("stat definition validation", () => {
  test("rejects bad fields, keeps labels unique per kind, and fixes applies_to", async () => {
    expect((await json("POST", "/api/stats", statFields({ min: 5, max: 5 }))).status).toBe(400);
    expect((await json("POST", "/api/stats", statFields({ default_value: 11 }))).status).toBe(400);
    expect((await json("POST", "/api/stats", statFields({ color: "chartreuse" }))).status).toBe(400);

    const grit = await createdStat(await json("POST", "/api/stats", statFields({ label: "Validation Grit" })));
    const otherKind = await createdStat(
      await json("POST", "/api/stats", statFields({ applies_to: "relationship", label: "Validation Grit" })),
    );
    expect((await json("POST", "/api/stats", statFields({ label: "VALIDATION GRIT" }))).status).toBe(400);
    expect((await json("PATCH", `/api/stats/${grit.id}`, { applies_to: "relationship" })).status).toBe(400);
    const patched = await json("PATCH", `/api/stats/${grit.id}`, { max: 12 });
    expect(patched.status).toBe(200);
    const patchPayload = (await patched.json()) as { stat: StatDefinition };
    expect([patchPayload.stat.max, patchPayload.stat.applies_to]).toEqual([12, "character"]);
    expect((await json("DELETE", `/api/stats/${grit.id}`)).status).toBe(200);
    expect((await json("DELETE", `/api/stats/${otherKind.id}`)).status).toBe(200);
  });

  test("a scope holds at most 12 stats per kind", async () => {
    const world = await postWorld({ name: "Capped", setting_brief: "b" });
    for (let index = 0; index < STAT_COUNT_LIMIT; index++) {
      expect((await json("POST", `/api/worlds/${world.id}/stats`, statFields({ label: `Capped ${index}` }))).status).toBe(201);
    }
    expect((await json("POST", `/api/worlds/${world.id}/stats`, statFields({ label: "One too many" }))).status).toBe(400);
    expect(
      (await json("POST", `/api/worlds/${world.id}/stats`, statFields({ applies_to: "relationship", label: "Still fits" }))).status,
    ).toBe(201);
  });

  test("the same label may exist in the bank and a world, and bank routes reach world stats", async () => {
    const bank = await createdStat(await json("POST", "/api/stats", statFields({ label: "Shared Grit" })));
    const world = await postWorld({ name: "Shared", setting_brief: "b" });
    const copy = await createdStat(await json("POST", `/api/worlds/${world.id}/stats`, statFields({ label: "Shared Grit" })));
    expect((await json("POST", `/api/worlds/${world.id}/stats`, statFields({ label: "shared grit" }))).status).toBe(400);

    const patched = await json("PATCH", `/api/stats/${copy.id}`, { description: "World copy." });
    expect(patched.status).toBe(200);
    expect((await listWorldStats(world.id)).map((stat) => [stat.label, stat.description])).toEqual([
      ["Shared Grit", "World copy."],
    ]);
    expect((await json("DELETE", `/api/stats/${copy.id}`)).status).toBe(200);
    expect(await listWorldStats(world.id)).toHaveLength(0);
    expect((await json("DELETE", `/api/stats/${bank.id}`)).status).toBe(200);
  });
});

describe("world creation", () => {
  test("copies the chosen bank stats, independent afterwards", async () => {
    const bearing = await createdStat(await json("POST", "/api/stats", statFields({ label: "Bearing" })));
    const bankPayload = (await (await json("GET", "/api/stats")).json()) as { stats: StatDefinition[] };
    const trust = bankPayload.stats.find((stat) => stat.label === "Trust")!;

    const world = await postWorld({
      name: "Copied",
      setting_brief: "Cliffs over a cold sea.",
      stat_ids: [bearing.id, trust.id],
    });
    const copied = await listWorldStats(world.id);
    expect(copied.map((stat) => [stat.applies_to, stat.label, stat.world_id])).toEqual([
      ["character", "Bearing", world.id],
      ["relationship", "Trust", world.id],
    ]);
    const trustCopy = copied[1]!;
    expect(trustCopy.id).not.toBe(trust.id);
    await json("PATCH", `/api/stats/${trustCopy.id}`, { label: "Renamed" });
    const afterBank = (await (await json("GET", "/api/stats")).json()) as { stats: StatDefinition[] };
    expect(afterBank.stats.find((stat) => stat.id === trust.id)!.label).toBe("Trust");
  });

  test("a non-bank or unknown stat id is refused and creates no world", async () => {
    const world = await postWorld({ name: "Nonbank host", setting_brief: "b" });
    const worldOnly = await createdStat(await json("POST", `/api/worlds/${world.id}/stats`, statFields({ label: "World only" })));
    const before = (await (await json("GET", "/api/worlds")).json()) as { worlds: World[] };
    expect((await json("POST", "/api/worlds", { name: "Ghost", setting_brief: "b", stat_ids: ["nope"] })).status).toBe(404);
    expect((await json("POST", "/api/worlds", { name: "Ghost", setting_brief: "b", stat_ids: [worldOnly.id] })).status).toBe(404);
    const after = (await (await json("GET", "/api/worlds")).json()) as { worlds: World[] };
    expect(after.worlds).toHaveLength(before.worlds.length);
  });
});

describe("character stats", () => {
  test("new characters start off; opt-in fills defaults, opt-out clears, and values are validated", async () => {
    const { grit, mira } = await seedWorld();
    expect([mira.stats_enabled, mira.stats]).toEqual([false, {}]);
    const patch = (body: Record<string, unknown>) => json("PATCH", `/api/characters/${mira.id}`, body);
    const reload = async () => {
      const response = await json("GET", `/api/characters/${mira.id}`);
      return ((await response.json()) as { character: Character }).character;
    };

    expect((await patch({ stats: { [grit.id]: 3 } })).status).toBe(400);
    expect((await patch({ stats_enabled: true })).status).toBe(200);
    expect((await reload()).stats).toEqual({ [grit.id]: 5 });
    expect((await patch({ stats: { [grit.id]: 11 } })).status).toBe(400);
    expect((await patch({ stats: { "not-a-stat": 1 } })).status).toBe(400);
    expect((await patch({ stats: { [grit.id]: 2.5 } })).status).toBe(400);
    expect((await patch({ stats: { [grit.id]: 9 } })).status).toBe(200);
    expect((await reload()).stats).toEqual({ [grit.id]: 9 });

    expect((await patch({ stats_enabled: false })).status).toBe(200);
    const cleared = await reload();
    expect([cleared.stats_enabled, cleared.stats]).toEqual([false, {}]);
    expect((await patch({ stats: { [grit.id]: 2 } })).status).toBe(400);
    expect((await reload()).stats).toEqual({});
  });

  test("a relationship stat key is not accepted as a character value", async () => {
    const { rapport, mira } = await seedWorld();
    await json("PATCH", `/api/characters/${mira.id}`, { stats_enabled: true });
    expect((await json("PATCH", `/api/characters/${mira.id}`, { stats: { [rapport.id]: 2 } })).status).toBe(400);
  });
});

describe("world stat writes", () => {
  test("adding a stat fills defaults for the opted in and every relationship; range edits clamp; deletes remove keys", async () => {
    const { world, grit, rapport, mira, oren } = await seedWorld();
    expect((await json("PATCH", `/api/characters/${mira.id}`, { stats_enabled: true })).status).toBe(200);

    const relationshipResponse = await json("POST", `/api/worlds/${world.id}/relationships`, {
      source_id: mira.id,
      target_id: oren.id,
      how_met: "At sea.",
    });
    expect(relationshipResponse.status).toBe(201);
    const created = ((await relationshipResponse.json()) as { relationship: Relationship }).relationship;
    expect(created.stats).toEqual({ [rapport.id]: 2 });

    const luck = await createdStat(
      await json("POST", `/api/worlds/${world.id}/stats`, statFields({ label: "Luck", default_value: 7, color: "green" })),
    );
    const bond = await createdStat(
      await json("POST", `/api/worlds/${world.id}/stats`, statFields({
        applies_to: "relationship",
        label: "Bond",
        default_value: 1,
        color: "teal",
      })),
    );

    let characters = await listWorldCharacters(world.id);
    expect(characters[0]!.stats).toEqual({ [grit.id]: 5, [luck.id]: 7 });
    expect(characters[1]!.stats).toEqual({});
    expect((await listWorldRelationships(world.id))[0]!.stats).toEqual({ [rapport.id]: 2, [bond.id]: 1 });

    const setValue = (value: number) =>
      json("PATCH", `/api/characters/${mira.id}`, { stats: { [grit.id]: value } });
    expect((await setValue(9)).status).toBe(200);
    expect((await json("PATCH", `/api/stats/${grit.id}`, { max: 8 })).status).toBe(200);
    expect((await listWorldCharacters(world.id))[0]!.stats[grit.id]).toBe(8);
    expect((await setValue(1)).status).toBe(200);
    expect((await json("PATCH", `/api/stats/${grit.id}`, { min: 4 })).status).toBe(200);
    expect((await listWorldCharacters(world.id))[0]!.stats[grit.id]).toBe(4);

    expect((await json("PATCH", `/api/worlds/${world.id}/relationships/${created.id}`, { stats: { [rapport.id]: 9 } })).status).toBe(200);
    expect((await json("PATCH", `/api/stats/${rapport.id}`, { max: 6 })).status).toBe(200);
    expect((await listWorldRelationships(world.id))[0]!.stats[rapport.id]).toBe(6);

    expect((await json("DELETE", `/api/stats/${luck.id}`)).status).toBe(200);
    expect((await json("DELETE", `/api/stats/${bond.id}`)).status).toBe(200);
    characters = await listWorldCharacters(world.id);
    expect(characters[0]!.stats).toEqual({ [grit.id]: 4 });
    expect(characters[1]!.stats).toEqual({});
    expect((await listWorldStats(world.id)).map((stat) => stat.id).sort()).toEqual([grit.id, rapport.id].sort());
    expect((await listWorldRelationships(world.id))[0]!.stats).toEqual({ [rapport.id]: 6 });
  });

  test("a stat only ever touches the characters and relationships of its own world", async () => {
    const first = await seedWorld();
    const second = await seedWorld();
    for (const seeded of [first, second]) {
      await json("PATCH", `/api/characters/${seeded.mira.id}`, { stats_enabled: true });
      await json("POST", `/api/worlds/${seeded.world.id}/relationships`, {
        source_id: seeded.mira.id,
        target_id: seeded.oren.id,
      });
    }

    const luck = await createdStat(await json("POST", `/api/worlds/${first.world.id}/stats`, statFields({ label: "Luck" })));
    expect((await listWorldCharacters(second.world.id))[0]!.stats).toEqual({ [second.grit.id]: 5 });
    expect((await json("DELETE", `/api/stats/${first.grit.id}`)).status).toBe(200);
    expect((await json("DELETE", `/api/stats/${first.rapport.id}`)).status).toBe(200);

    expect((await listWorldCharacters(first.world.id))[0]!.stats).toEqual({ [luck.id]: 5 });
    expect((await listWorldRelationships(first.world.id))[0]!.stats).toEqual({});
    expect((await listWorldCharacters(second.world.id))[0]!.stats).toEqual({ [second.grit.id]: 5 });
    expect((await listWorldRelationships(second.world.id))[0]!.stats).toEqual({ [second.rapport.id]: 2 });
  });
});

describe("bank import", () => {
  async function bankIds(...labels: string[]): Promise<StatDefinition[]> {
    const bankPayload = (await (await json("GET", "/api/stats")).json()) as { stats: StatDefinition[] };
    return labels.map((label) => bankPayload.stats.find((stat) => stat.label === label)!);
  }

  test("imports bank stats into the world, even after a chat has messages", async () => {
    const world = await postWorld({ name: "Importing", setting_brief: "b" });
    const heroResponse = await json("POST", `/api/worlds/${world.id}/characters`, {
      name: "Import Hero",
      description: "Fresh off the boat.",
    });
    const hero = ((await heroResponse.json()) as { character: Character }).character;
    expect((await json("PATCH", `/api/characters/${hero.id}`, { stats_enabled: true })).status).toBe(200);

    const [health, trust, stamina] = await bankIds("Health", "Trust", "Stamina");
    const imported = await json("POST", `/api/worlds/${world.id}/stats/import`, { stat_ids: [health!.id, trust!.id] });
    expect(imported.status).toBe(201);
    const importedStats = ((await imported.json()) as { stats: StatDefinition[] }).stats;
    expect(importedStats.map((stat) => [stat.applies_to, stat.label])).toEqual([
      ["character", "Health"],
      ["relationship", "Trust"],
    ]);
    expect(importedStats.every((stat) => stat.world_id === world.id && stat.id !== health!.id)).toBe(true);
    expect((await listWorldCharacters(world.id))[0]!.stats).toEqual({ [importedStats[0]!.id]: 10 });

    const chatResponse = await json("POST", `/api/worlds/${world.id}/chats`, { protagonist_id: hero.id, opening: "Fresh start." });
    expect(chatResponse.status).toBe(201);
    const chat = ((await chatResponse.json()) as { chat: { id: string } }).chat;
    await completeTurn(chat.id, "I set sail.", "The harbor opens.");

    const later = await json("POST", `/api/worlds/${world.id}/stats/import`, { stat_ids: [stamina!.id] });
    expect(later.status).toBe(201);
    expect((await listWorldStats(world.id)).map((stat) => stat.label)).toEqual(["Health", "Stamina", "Trust"]);
  });

  test("refuses non-bank and unknown ids, duplicate labels, repeated ids, and a full kind without importing anything", async () => {
    const { world, grit } = await seedWorld();
    const [health, stamina] = await bankIds("Health", "Stamina");
    const importIds = (stat_ids: unknown) => json("POST", `/api/worlds/${world.id}/stats/import`, { stat_ids });

    expect((await importIds(["nope"])).status).toBe(404);
    expect((await importIds([grit.id])).status).toBe(404);
    expect((await importIds([health!.id, "nope"])).status).toBe(404);
    expect((await importIds([health!.id, health!.id])).status).toBe(400);
    expect((await importIds("Health")).status).toBe(400);
    expect((await json("POST", "/api/worlds/no-such-world/stats/import", { stat_ids: [health!.id] })).status).toBe(404);
    expect((await listWorldStats(world.id)).map((stat) => stat.label)).toEqual(["Grit", "Rapport"]);

    expect((await importIds([health!.id])).status).toBe(201);
    const duplicate = await importIds([stamina!.id, health!.id]);
    expect(duplicate.status).toBe(400);
    expect(((await duplicate.json()) as { code?: string }).code).toBe("invalid_input");
    expect((await listWorldStats(world.id)).map((stat) => stat.label)).toEqual(["Grit", "Health", "Rapport"]);

    const characterStats = (await listWorldStats(world.id)).filter((stat) => stat.applies_to === "character");
    for (let index = characterStats.length; index < STAT_COUNT_LIMIT; index++) {
      await createdStat(await json("POST", `/api/worlds/${world.id}/stats`, statFields({ label: `Filler ${index}` })));
    }
    const full = await importIds([stamina!.id]);
    expect(full.status).toBe(400);
    const afterFull = await listWorldStats(world.id);
    expect(afterFull.filter((stat) => stat.applies_to === "character")).toHaveLength(STAT_COUNT_LIMIT);
  });
});

describe("narration prompt", () => {
  test("the legend renders once, values for opted-in characters and relationships, none for the rest", () => {
    const directory = mkdtempSync(join(tmpdir(), "storyfold-stats-prompt-"));
    try {
      const db = openDatabase(join(directory, "storyfold.db"));
      const world = createWorld(db, { name: "Prompted", setting_brief: "A rain-soaked harbor." });
      const health = createStatDefinition(db, world.id, parseStatInput(statFields({
        label: "Health",
        description: "Physical condition.",
        low_label: "dying",
        high_label: "unharmed",
        default_value: 10,
      })));
      const trust = createStatDefinition(db, world.id, parseStatInput(statFields({
        applies_to: "relationship",
        label: "Trust",
        description: "Reliance on word and intent.",
        low_label: "none",
        high_label: "complete",
        default_value: 5,
        color: "teal",
      })));
      const mira = createCharacter(db, world.id, parseCharacterInput({ name: "Mira", description: "A careful sailor." }))!;
      const oren = createCharacter(db, world.id, parseCharacterInput({ name: "Oren", description: "A retired navigator." }))!;
      updateCharacter(db, mira.id, { stats_enabled: true, stats: { [health.id]: 7 } });
      updateCharacter(db, oren.id, { context_mode: "always" });
      const relationship = createRelationship(
        db,
        world.id,
        mira.id,
        oren.id,
        parseRelationshipPatch({ how_met: "At sea.", status: "wary", known_facts: ["Keeps a brass compass."] }, listStatDefinitions(db, world.id)),
      );
      updateRelationship(db, world.id, relationship.id, { stats: { [trust.id]: 4 } });
      const chat = createChat(db, world.id, { protagonist_id: mira.id, opening: "A storm approaches." })!;

      const prompt = chatSystemPrompt(db, chat, false);
      expect(prompt.match(/<stats_legend>/g)).toHaveLength(1);
      expect(prompt).toContain(`<stat name="Health" applies_to="character" scale="0–10" low="0: dying" high="10: unharmed">${health.description}</stat>`);
      expect(prompt).toContain(`<stat name="Trust" applies_to="relationship" scale="0–10" low="0: none" high="10: complete">${trust.description}</stat>`);
      expect(prompt).toContain('<protagonist>\n<character name="Mira">\n  <description>A careful sailor.</description>\n  <stats>Health 7/10</stats>\n</character>\n</protagonist>');
      expect(prompt).toContain('<character name="Oren">\n  <description>A retired navigator.</description>\n</character>');
      expect(prompt).toContain(
        '<relationship from="Mira" to="Oren">\n  <status>wary</status>\n  <how_met>At sea.</how_met>\n  <known_facts>- Keeps a brass compass.</known_facts>\n  <stats>Trust 4/10</stats>\n</relationship>',
      );
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
