import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  protagonistOf,
  type Campaign,
  type CampaignStat,
  type Session,
  type StatDefinition,
  type World,
} from "../../shared/domain";
import { newId, nowIso, openDatabase } from "../db";
import {
  STAT_COUNT_LIMIT,
  beginNextSession,
  createCampaign,
  createCharacter,
  createStatDefinition,
  createWorld,
  forkCampaignFromMessage,
  listCampaignCharacters,
  listCampaignStats,
  listStatDefinitions,
  parseCampaignInput,
  parseCharacterInput,
  parseStatInput,
  parseWorldInput,
  updateCampaignCharacter,
  updateCampaignStat,
} from "../library";
import { PlayService } from "../play";
import { createRelationship, listRelationships, parseRelationshipPatch, updateRelationship } from "../relationships";
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

async function fetchCampaign(id: string): Promise<Campaign> {
  const response = await json("GET", `/api/campaigns/${id}`);
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { campaign: Campaign };
  return payload.campaign;
}

/** A campaign over a world holding one character stat (Grit, default 5) and one relationship stat (Rapport, default 2). */
async function seedCampaign(): Promise<{
  world: World;
  characterStat: StatDefinition;
  relationshipStat: StatDefinition;
  campaign: Campaign;
  session: Session;
}> {
  const world = await postWorld({ name: "Seeded", setting_brief: "A quiet harbor.", suggested_starting_situation: "" });
  const characterStat = await createdStat(await json("POST", `/api/worlds/${world.id}/stats`, statFields()));
  const relationshipStat = await createdStat(
    await json("POST", `/api/worlds/${world.id}/stats`, statFields({
      applies_to: "relationship",
      label: "Rapport",
      default_value: 2,
      color: "teal",
    })),
  );
  const characterIds: string[] = [];
  for (const name of ["Mira", "Oren"]) {
    const response = await json("POST", "/api/characters", { name, description: `A quiet sailor named ${name}.` });
    expect(response.status).toBe(201);
    const payload = (await response.json()) as { character: { id: string } };
    characterIds.push(payload.character.id);
  }
  const created = await json("POST", "/api/campaigns", {
    world_id: world.id,
    protagonist_id: characterIds[0],
    cast_character_ids: [characterIds[1]],
    starting_situation: "A storm approaches.",
  });
  expect(created.status).toBe(201);
  const payload = (await created.json()) as { campaign: Campaign; session: Session };
  return { world, characterStat, relationshipStat, campaign: payload.campaign, session: payload.session };
}

/** Direct-database campaign whose world defines Health (character) and Trust (relationship). */
function seedStatCampaign(db: Database): { campaign: Campaign; health: StatDefinition; trust: StatDefinition } {
  const world = createWorld(db, parseWorldInput({
    name: "Prompted",
    setting_brief: "A rain-soaked harbor.",
    suggested_starting_situation: "",
  }));
  const health = createStatDefinition(db, world.id, parseStatInput(statFields({
    label: "Health",
    description: "Physical condition.",
    low_label: "dying",
    high_label: "unharmed",
    default_value: 10,
    color: "red",
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
  const mira = createCharacter(db, parseCharacterInput({ name: "Mira", description: "A careful sailor." }));
  const oren = createCharacter(db, parseCharacterInput({ name: "Oren", description: "A retired navigator." }));
  const { campaign } = createCampaign(db, parseCampaignInput({
    world_id: world.id,
    protagonist_id: mira.id,
    cast_character_ids: [oren.id],
    starting_situation: "A storm approaches.",
  }));
  return { campaign, health, trust };
}

function addMessage(db: Database, sessionId: string, position: number, content: string): string {
  const id = newId();
  db.query(
    "INSERT INTO messages (id, session_id, position, role, speaker_name, content, status, selected, created_at, updated_at) VALUES (?, ?, ?, 'assistant', 'Narrator', ?, 'complete', 1, ?, ?)",
  ).run(id, sessionId, position, content, nowIso(), nowIso());
  return id;
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
    const response = await fetch(`${serverBase}/api/sessions/${sessionId}/messages`, {
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
    const world = await postWorld({ name: "Capped", setting_brief: "b", suggested_starting_situation: "" });
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
    const world = await postWorld({ name: "Shared", setting_brief: "b", suggested_starting_situation: "" });
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
      suggested_starting_situation: "",
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
    const world = await postWorld({ name: "Nonbank host", setting_brief: "b", suggested_starting_situation: "" });
    const worldOnly = await createdStat(await json("POST", `/api/worlds/${world.id}/stats`, statFields({ label: "World only" })));
    const before = (await (await json("GET", "/api/worlds")).json()) as { worlds: World[] };
    expect((await json("POST", "/api/worlds", {
      name: "Ghost",
      setting_brief: "b",
      suggested_starting_situation: "",
      stat_ids: ["nope"],
    })).status).toBe(404);
    expect((await json("POST", "/api/worlds", {
      name: "Ghost",
      setting_brief: "b",
      suggested_starting_situation: "",
      stat_ids: [worldOnly.id],
    })).status).toBe(404);
    const after = (await (await json("GET", "/api/worlds")).json()) as { worlds: World[] };
    expect(after.worlds).toHaveLength(before.worlds.length);
  });
});

describe("campaign stat copies", () => {
  test("creation copies world stats; the protagonist starts opted in, cast starts off; edits stay local", async () => {
    const seeded = await seedCampaign();
    expect(seeded.campaign.stats.map((stat) => [stat.applies_to, stat.label])).toEqual([
      ["character", "Grit"],
      ["relationship", "Rapport"],
    ]);
    const grit = seeded.campaign.stats[0]!;
    expect(grit.id).not.toBe(seeded.characterStat.id);
    const [protagonist, cast] = seeded.campaign.characters;
    expect([protagonist!.stats_enabled, protagonist!.stats]).toEqual([true, { [grit.id]: 5 }]);
    expect([cast!.stats_enabled, cast!.stats]).toEqual([false, {}]);

    const patched = await json("PATCH", `/api/campaigns/${seeded.campaign.id}/stats/${grit.id}`, {
      label: "Renamed Grit",
      max: 8,
    });
    expect(patched.status).toBe(200);
    expect((await listWorldStats(seeded.world.id)).map((stat) => [stat.id, stat.label, stat.max])).toEqual([
      [seeded.characterStat.id, "Grit", 10],
      [seeded.relationshipStat.id, "Rapport", 10],
    ]);
  });
});

describe("character stats", () => {
  test("opt-in fills defaults, opt-out clears, and values are validated", async () => {
    const seeded = await seedCampaign();
    const grit = seeded.campaign.stats[0]!;
    const cast = seeded.campaign.characters[1]!;
    const patch = (body: Record<string, unknown>) =>
      json("PATCH", `/api/campaigns/${seeded.campaign.id}/characters/${cast.id}`, body);

    expect((await patch({ stats_enabled: true })).status).toBe(200);
    expect((await fetchCampaign(seeded.campaign.id)).characters[1]!.stats).toEqual({ [grit.id]: 5 });
    expect((await patch({ stats: { [grit.id]: 11 } })).status).toBe(400);
    expect((await patch({ stats: { "not-a-stat": 1 } })).status).toBe(400);

    expect((await patch({ stats_enabled: false })).status).toBe(200);
    const cleared = (await fetchCampaign(seeded.campaign.id)).characters[1]!;
    expect([cleared.stats_enabled, cleared.stats]).toEqual([false, {}]);
    expect((await patch({ stats: { [grit.id]: 2 } })).status).toBe(400);
    expect((await fetchCampaign(seeded.campaign.id)).characters[1]!.stats).toEqual({});
  });
});

describe("campaign stat writes", () => {
  test("adding a stat fills defaults for the opted in and every relationship; range edits clamp; deletes remove keys", async () => {
    const seeded = await seedCampaign();
    const grit = seeded.campaign.stats.find((stat) => stat.applies_to === "character")!;
    const rapport = seeded.campaign.stats.find((stat) => stat.applies_to === "relationship")!;
    const [protagonist, cast] = seeded.campaign.characters;

    const relationshipResponse = await json("POST", `/api/campaigns/${seeded.campaign.id}/relationships`, {
      source_id: protagonist!.id,
      target_id: cast!.id,
      how_met: "At sea.",
    });
    expect(relationshipResponse.status).toBe(201);
    const relationshipPayload = (await relationshipResponse.json()) as {
      relationship: { id: string; stats: Record<string, number> };
    };
    expect(relationshipPayload.relationship.stats).toEqual({ [rapport.id]: 2 });

    const luck = await createdStat(
      await json("POST", `/api/campaigns/${seeded.campaign.id}/stats`, statFields({ label: "Luck", default_value: 7, color: "green" })),
    );
    const bond = await createdStat(
      await json("POST", `/api/campaigns/${seeded.campaign.id}/stats`, statFields({
        applies_to: "relationship",
        label: "Bond",
        default_value: 1,
        color: "teal",
      })),
    );

    let campaign = await fetchCampaign(seeded.campaign.id);
    expect(campaign.characters[0]!.stats).toEqual({ [grit.id]: 5, [luck.id]: 7 });
    expect(campaign.characters[1]!.stats).toEqual({});
    let relationships = (await (await json("GET", `/api/campaigns/${seeded.campaign.id}/relationships`)).json()) as {
      relationships: Array<{ stats: Record<string, number> }>;
    };
    expect(relationships.relationships[0]!.stats).toEqual({ [rapport.id]: 2, [bond.id]: 1 });

    const setValues = (body: Record<string, unknown>) =>
      json("PATCH", `/api/campaigns/${seeded.campaign.id}/characters/${protagonist!.id}`, { stats: body });
    expect((await setValues({ [grit.id]: 9 })).status).toBe(200);
    expect((await json("PATCH", `/api/campaigns/${seeded.campaign.id}/stats/${grit.id}`, { max: 8 })).status).toBe(200);
    expect((await fetchCampaign(seeded.campaign.id)).characters[0]!.stats[grit.id]).toBe(8);
    expect((await setValues({ [grit.id]: 1 })).status).toBe(200);
    expect((await json("PATCH", `/api/campaigns/${seeded.campaign.id}/stats/${grit.id}`, { min: 4 })).status).toBe(200);
    expect((await fetchCampaign(seeded.campaign.id)).characters[0]!.stats[grit.id]).toBe(4);

    expect((await json("DELETE", `/api/campaigns/${seeded.campaign.id}/stats/${luck.id}`)).status).toBe(200);
    expect((await json("DELETE", `/api/campaigns/${seeded.campaign.id}/stats/${bond.id}`)).status).toBe(200);
    campaign = await fetchCampaign(seeded.campaign.id);
    expect(campaign.characters[0]!.stats).toEqual({ [grit.id]: 4 });
    expect(campaign.characters[1]!.stats).toEqual({});
    expect(campaign.stats.map((stat) => stat.id).sort()).toEqual([grit.id, rapport.id].sort());
    relationships = (await (await json("GET", `/api/campaigns/${seeded.campaign.id}/relationships`)).json()) as {
      relationships: Array<{ stats: Record<string, number> }>;
    };
    expect(relationships.relationships[0]!.stats).toEqual({ [rapport.id]: 2 });
  });
});

describe("bank import", () => {
  test("imports bank stats before the story begins and is refused once a message exists", async () => {
    const world = await postWorld({ name: "Importing", setting_brief: "b", suggested_starting_situation: "" });
    const hero = await json("POST", "/api/characters", { name: "Import Hero", description: "Fresh off the boat." });
    expect(hero.status).toBe(201);
    const heroPayload = (await hero.json()) as { character: { id: string } };
    const created = await json("POST", "/api/campaigns", {
      world_id: world.id,
      protagonist_id: heroPayload.character.id,
      starting_situation: "Fresh start.",
    });
    expect(created.status).toBe(201);
    const campaignPayload = (await created.json()) as { campaign: Campaign; session: Session };
    expect(campaignPayload.campaign.story_begun).toBe(false);

    const bankPayload = (await (await json("GET", "/api/stats")).json()) as { stats: StatDefinition[] };
    const health = bankPayload.stats.find((stat) => stat.label === "Health")!;
    const trust = bankPayload.stats.find((stat) => stat.label === "Trust")!;
    const imported = await json("POST", `/api/campaigns/${campaignPayload.campaign.id}/stats/import`, {
      stat_ids: [health.id, trust.id],
    });
    expect(imported.status).toBe(201);
    const importedPayload = (await imported.json()) as { stats: CampaignStat[] };
    expect(importedPayload.stats.map((stat) => [stat.applies_to, stat.label])).toEqual([
      ["character", "Health"],
      ["relationship", "Trust"],
    ]);
    expect(importedPayload.stats.every((stat) => stat.campaign_id === campaignPayload.campaign.id)).toBe(true);
    expect((await fetchCampaign(campaignPayload.campaign.id)).characters[0]!.stats).toEqual({
      [importedPayload.stats[0]!.id]: 10,
    });

    await completeTurn(base.url, campaignPayload.session.id, "I set sail.", "The harbor opens.");
    expect((await fetchCampaign(campaignPayload.campaign.id)).story_begun).toBe(true);
    const refused = await json("POST", `/api/campaigns/${campaignPayload.campaign.id}/stats/import`, {
      stat_ids: [health.id],
    });
    expect(refused.status).toBe(400);
    const refusedPayload = (await refused.json()) as { code?: string };
    expect(refusedPayload.code).toBe("invalid_input");
  });
});

describe("narration prompt", () => {
  test("the legend renders once, values for opted-in characters and relationships, none for the rest", () => {
    const directory = mkdtempSync(join(tmpdir(), "storyfold-stats-prompt-"));
    try {
      const db = openDatabase(join(directory, "storyfold.db"));
      const { campaign, health, trust } = seedStatCampaign(db);
      const healthStat = campaign.stats.find((stat) => stat.label === "Health")!;
      const trustStat = campaign.stats.find((stat) => stat.label === "Trust")!;
      updateCampaignCharacter(db, campaign.id, protagonistOf(campaign).id, { stats: { [healthStat.id]: 7 } });
      const relationship = createRelationship(
        db,
        campaign,
        campaign.characters[0]!.id,
        campaign.characters[1]!.id,
        parseRelationshipPatch({ how_met: "At sea.", status: "wary", known_facts: ["Keeps a brass compass."] }, campaign),
      );
      updateRelationship(db, campaign, relationship.id, parseRelationshipPatch({ stats: { [trustStat.id]: 4 } }, campaign));

      const prompt = new PlayService(db).systemPrompt(campaign.active_session_id);
      expect(prompt.match(/Stats \(scale and meaning\):/g)).toHaveLength(1);
      expect(prompt).toContain(`- Health (character, 0–10): ${health.description} 0: dying · 10: unharmed`);
      expect(prompt).toContain(`- Trust (relationship, 0–10): ${trust.description} 0: none · 10: complete`);
      expect(prompt).toContain("The player controls their character, Mira: A careful sailor. [Health 7/10]");
      expect(prompt).toContain("- Oren: A retired navigator.");
      expect(prompt).not.toMatch(/- Oren: [^\n]*\[/);
      expect(prompt).toContain(
        "- Mira → Oren: status: wary; how met: At sea.; known facts: Keeps a brass compass.; Trust 4/10",
      );
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("fork", () => {
  test("a fork from a closed session restores stats and values under new stat ids", () => {
    const directory = mkdtempSync(join(tmpdir(), "storyfold-stats-fork-"));
    try {
      const db = openDatabase(join(directory, "storyfold.db"));
      const { campaign } = seedStatCampaign(db);
      const healthStat = campaign.stats.find((stat) => stat.label === "Health")!;
      const trustStat = campaign.stats.find((stat) => stat.label === "Trust")!;
      const protagonist = protagonistOf(campaign);
      updateCampaignCharacter(db, campaign.id, protagonist.id, { stats: { [healthStat.id]: 7 } });
      const relationship = createRelationship(
        db,
        campaign,
        protagonist.id,
        campaign.characters[1]!.id,
        parseRelationshipPatch({ how_met: "At sea." }, campaign),
      );
      updateRelationship(db, campaign, relationship.id, parseRelationshipPatch({ stats: { [trustStat.id]: 4 } }, campaign));

      const closedId = campaign.active_session_id;
      const cutId = addMessage(db, closedId, 1, "The storm passes.");
      beginNextSession(db, campaign.id, { title: "After the storm", handoff: "The crew reached the harbor." });
      // Later edits must stay out of the checkpoint the fork restores.
      updateCampaignStat(db, campaign.id, healthStat.id, { max: 5, default_value: 5 });
      updateCampaignCharacter(db, campaign.id, protagonist.id, { stats: { [healthStat.id]: 2 } });

      const fork = forkCampaignFromMessage(db, closedId, cutId, { name: "Fork" })!;
      const forkStats = listCampaignStats(db, fork.campaign.id);
      const forkHealth = forkStats.find((stat) => stat.label === "Health")!;
      const forkTrust = forkStats.find((stat) => stat.label === "Trust")!;
      expect(forkHealth.id).not.toBe(healthStat.id);
      expect(forkTrust.id).not.toBe(trustStat.id);
      expect(forkHealth.max).toBe(10);
      const forkProtagonist = listCampaignCharacters(db, fork.campaign.id)[0]!;
      expect([forkProtagonist.stats_enabled, forkProtagonist.stats]).toEqual([true, { [forkHealth.id]: 7 }]);
      const forkRelationship = listRelationships(db, fork.campaign.id)[0]!;
      expect(forkRelationship.stats).toEqual({ [forkTrust.id]: 4 });
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
