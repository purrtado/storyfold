import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventType } from "@tanstack/ai";
import { join } from "node:path";
import type { Campaign, Character, Session, World, WorldEntry, WorldEntrySnapshot } from "../../shared/domain";
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

async function createCharacter(body: Record<string, unknown>): Promise<Character> {
  const response = await json("POST", "/api/characters", body);
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { character: Character };
  return payload.character;
}

interface ApiResult {
  status: number;
  entry?: WorldEntry;
  campaign?: Campaign;
  session?: Session;
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

async function createCampaign(body: Record<string, unknown>): Promise<ApiResult> {
  const response = await json("POST", "/api/campaigns", body);
  return { status: response.status, ...(await response.json()) };
}

async function getCampaign(id: string): Promise<Campaign> {
  const response = await json("GET", `/api/campaigns/${id}`);
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { campaign: Campaign };
  return payload.campaign;
}

describe("world entries API", () => {
  test("creates, lists, patches and deletes entries with ISO timestamps", async () => {
    const world = await createWorld({ name: "Ember Coast", setting_brief: "Tide-locked cliffs.", suggested_starting_situation: "" });

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
    // assert members, not sequence; campaign capture order is asserted where
    // the contract actually fixes it.
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
    const world = await createWorld({ name: "Protected", setting_brief: "b", suggested_starting_situation: "" });
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
    const world = await createWorld({ name: "Validation", setting_brief: "b", suggested_starting_situation: "" });

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
    const worldA = await createWorld({ name: "World A", setting_brief: "a", suggested_starting_situation: "" });
    const worldB = await createWorld({ name: "World B", setting_brief: "b", suggested_starting_situation: "" });
    const entry = (await createEntry(worldA.id, { kind: "location", name: "Sunken Archive", description: "d" })).entry!;

    const listResponse = await json("GET", `/api/worlds/${worldB.id}/entries`);
    const listB = (await listResponse.json()) as { entries: WorldEntry[] };
    expect(listB.entries).toEqual([]);
    expect((await patchEntry(worldB.id, entry.id, { name: "Hijacked" })).status).toBe(404);
    expect((await json("DELETE", `/api/worlds/${worldB.id}/entries/${entry.id}`)).status).toBe(404);
    expect((await patchEntry(worldA.id, entry.id, { name: "Renamed" })).status).toBe(200);
  });
});

describe("campaign entry capture", () => {
  test("captures every non-scene entry in creation order; scenes never enter grounding", async () => {
    const world = await createWorld({ name: "Veloria", setting_brief: "A rain-soaked harbor kingdom.", suggested_starting_situation: "" });
    const other = await createWorld({ name: "Other", setting_brief: "o", suggested_starting_situation: "" });
    const protagonist = await createCharacter({ name: "Sable", description: "A cynical ferrywoman spy." });
    const character = (await createEntry(world.id, { kind: "location", name: "Maera", description: "Lighthouse keeper." })).entry!;
    const location = (await createEntry(world.id, { kind: "location", name: "Drowned Pier", description: "Sagging boards." })).entry!;
    await createEntry(world.id, { kind: "scene", name: "Dawn docking", description: "The ferry scrapes ashore." });
    const lore = (await createEntry(world.id, { kind: "lore", name: "The Bell Pact", description: "Bells bind the tides." })).entry!;
    await createEntry(other.id, { kind: "lore", name: "Foreign", description: "Another world's lore." });

    const created = await createCampaign({
      world_id: world.id,
      protagonist_id: protagonist.id,
      starting_situation: "Sable docks at dawn.",
    });
    expect(created.status).toBe(201);
    expect(created.campaign?.world_snapshot.entries).toEqual([
      { id: character.id, kind: "location", name: "Maera", description: "Lighthouse keeper." },
      { id: location.id, kind: "location", name: "Drowned Pier", description: "Sagging boards." },
      { id: lore.id, kind: "lore", name: "The Bell Pact", description: "Bells bind the tides." },
    ]);
    expect(await getCampaign(created.campaign!.id)).toEqual(created.campaign!);
  });
});

describe("opening prompt budget", () => {
  test("creation is refused exactly when the opening prompt passes the budget", async () => {
    const world = await createWorld({ name: "Boundary", setting_brief: "b".repeat(100_000), suggested_starting_situation: "" });
    await createEntry(world.id, { kind: "lore", name: "Compact", description: "l".repeat(40_000) });
    const snapshot = (description: string): CharacterPrompt => ({
      name: "P", description, appearance: "", personality: "", background: "",
      baseline_motivations: "", speaking_style: "", stats_enabled: false, stats: {},
    });
    const promptTokens = (descriptionLength: number) => countTokens(narratorSystemPrompt(DEFAULT_PROMPT_CARDS.map((card) => ({ ...card, enabled: true })), {
      world: { name: world.name, setting_brief: world.setting_brief, entries: [{ kind: "lore", name: "Compact", description: "l".repeat(40_000) }] },
      starting_situation: "s",
      stats: [],
      protagonist: snapshot("d".repeat(descriptionLength)),
      cast: [],
      notes: [],
      relationships: [],
      handoff: null,
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
    const exact = await createCharacter({ name: "P", description: "d".repeat(low) });
    const over = await createCharacter({ name: "P", description: "d".repeat(low + 1) });

    const fits = await createCampaign({ world_id: world.id, protagonist_id: exact.id, starting_situation: "s" });
    expect(fits.status).toBe(201);
    const refused = await createCampaign({ world_id: world.id, protagonist_id: over.id, starting_situation: "s" });
    expect(refused.status).toBe(400);
    expect(refused.code).toBe("invalid_input");
    expect(refused.error).toContain(String(NARRATION_TOKEN_BUDGET));
  });
});

describe("captured grounding is immutable and drives narration", () => {
  test("library edits and deletes leave captured snapshots intact, across a restart", async () => {
    const configDir = await makeConfigDirectory();
    const dbPath = join(configDir, "capture.db");
    const serverA = await startTestServer({ configDirectory: configDir, databasePath: dbPath });
    const post = (method: string, path: string, body?: unknown) =>
      fetch(`${serverA.url}${path}`, {
        method,
        headers: headersWith({ "content-type": "application/json", origin: TRUSTED_ORIGIN }),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

    const worldResponse = await post("POST", "/api/worlds", { name: "Veloria", setting_brief: "b", suggested_starting_situation: "" });
    const worldPayload = (await worldResponse.json()) as { world: World };
    const world = worldPayload.world;
    const characterResponse = await post("POST", "/api/characters", { name: "Sable", description: "Spy of the ferries." });
    const characterPayload = (await characterResponse.json()) as { character: Character };
    const protagonist = characterPayload.character;
    const entryResponse = await post("POST", `/api/worlds/${world.id}/entries`, {
      kind: "lore",
      name: "Maera the Lighthouse Keeper",
      description: "Keeps the drowned light burning.",
    });
    const entryPayload = (await entryResponse.json()) as { entry: WorldEntry };
    const character = entryPayload.entry;
    const createdResponse = await post("POST", "/api/campaigns", {
      world_id: world.id,
      protagonist_id: protagonist.id,
      starting_situation: "Sable docks at dawn.",
    });
    expect(createdResponse.status).toBe(201);
    const createdPayload = (await createdResponse.json()) as { campaign: Campaign };
    const created = createdPayload.campaign;

    expect((await post("PATCH", `/api/worlds/${world.id}/entries/${character.id}`, { name: "Renamed", description: "Rewritten." })).status).toBe(200);
    expect((await post("DELETE", `/api/worlds/${world.id}/entries/${character.id}`)).status).toBe(200);

    const captured: WorldEntrySnapshot[] = [
      { id: character.id, kind: "lore", name: "Maera the Lighthouse Keeper", description: "Keeps the drowned light burning." },
    ];
    const detailResponse = await post("GET", `/api/campaigns/${created.id}`);
    const detail = (await detailResponse.json()) as { campaign: Campaign };
    expect(detail.campaign.world_snapshot.entries).toEqual(captured);

    await serverA.stop();
    const serverB = await startTestServer({ configDirectory: configDir, databasePath: dbPath });
    const reloadedResponse = await fetch(`${serverB.url}/api/campaigns/${created.id}`, { headers: headersWith() });
    const reloaded = (await reloadedResponse.json()) as { campaign: Campaign };
    expect(reloaded.campaign.world_snapshot.entries).toEqual(captured);
    await serverB.stop();
    await removeDirectory(configDir);
  });

  test("narration uses only the captured entries, not the live library", async () => {
    await configureProvider(base.url, "test-key-world-entries");

    const world = await createWorld({ name: "Veloria", setting_brief: "A rain-soaked harbor kingdom.", suggested_starting_situation: "" });
    const protagonist = await createCharacter({ name: "Sable", description: "A cynical ferrywoman spy." });
    const kept = (await createEntry(world.id, { kind: "lore", name: "Maera", description: "Lighthouse keeper." })).entry!;

    const created = await createCampaign({
      world_id: world.id,
      protagonist_id: protagonist.id,
      starting_situation: "Sable docks at dawn.",
    });
    expect(created.status).toBe(201);
    // Added to the world after capture: the narrator must never see it.
    await createEntry(world.id, { kind: "location", name: "Quarantine", description: "Off-limits pier." });

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
      const response = await fetch(`${server.url}/api/sessions/${created.session!.id}/opening`, {
        method: "POST",
        headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(200);
      const events = parseSseEvents(await response.text());
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);

      const history = calls[0].messages as Array<{ role: string; content: string }>;
      const system = history[0];
      expect(system.role).toBe("system");
      expect(system.content).toContain("Lighthouse keeper.");
      expect(system.content).toContain("Veloria");
      expect(system.content).toContain("Sable");
      expect(system.content).toContain("Sable docks at dawn.");
      expect(system.content).not.toContain("Quarantine");
      expect(system.content).not.toContain("Off-limits pier");

      // Renaming the live entry now must not rewrite the captured grounding.
      await patchEntry(world.id, kept.id, { name: "Renamed after capture" });
      const snapshot = await getCampaign(created.campaign!.id);
      expect(snapshot.world_snapshot.entries[0]?.name).toBe("Maera");
    } finally {
      await server.stop();
    }
  });
});
