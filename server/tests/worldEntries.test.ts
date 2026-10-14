import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventType } from "@tanstack/ai";
import { join } from "node:path";
import type { Campaign, Persona, Session, World, WorldEntry, WorldEntrySnapshot } from "../../shared/domain";
import { GROUNDING_CHARACTER_LIMIT, groundingCharacterCount } from "../../shared/grounding";
import {
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

async function createPersona(body: Record<string, unknown>): Promise<Persona> {
  const response = await json("POST", "/api/personas", body);
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { persona: Persona };
  return payload.persona;
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
      kind: "  character  ",
      name: "  Maera  ",
      description: "Keeper of the drowned lighthouse.",
    });
    expect(created.status).toBe(201);
    expect(created.entry?.kind).toBe("character");
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
    expect(patched.entry?.kind).toBe("character");
    expect(patched.entry?.description).toBe("Keeper of the drowned lighthouse.");
    expect(patched.entry?.created_at).toBe(created.entry?.created_at);

    const removed = await json("DELETE", `/api/worlds/${world.id}/entries/${created.entry!.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await json("DELETE", `/api/worlds/${world.id}/entries/${created.entry!.id}`)).status).toBe(404);
  });

  test("rejects invalid payloads with invalid_input and unknown routes with not_found", async () => {
    const world = await createWorld({ name: "Validation", setting_brief: "b", suggested_starting_situation: "" });

    for (const body of [
      {},
      { kind: "monster", name: "n", description: "d" },
      { kind: "character", name: "  ", description: "d" },
      { kind: "character", name: "n", description: "" },
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
  test("captures the selected subset in selection order; scenes never enter grounding", async () => {
    const world = await createWorld({ name: "Veloria", setting_brief: "A rain-soaked harbor kingdom.", suggested_starting_situation: "" });
    const persona = await createPersona({ name: "Sable", description: "A cynical ferrywoman spy." });
    const character = (await createEntry(world.id, { kind: "character", name: "Maera", description: "Lighthouse keeper." })).entry!;
    const location = (await createEntry(world.id, { kind: "location", name: "Drowned Pier", description: "Sagging boards." })).entry!;
    await createEntry(world.id, { kind: "lore", name: "The Bell Pact", description: "Bells bind the tides." });
    await createEntry(world.id, { kind: "scene", name: "Dawn docking", description: "The ferry scrapes ashore." });

    const created = await createCampaign({
      world_id: world.id,
      persona_id: persona.id,
      starting_situation: "Sable docks at dawn.",
      entry_ids: [location.id, character.id],
    });
    expect(created.status).toBe(201);
    expect(created.campaign?.world_snapshot.entries).toEqual([
      { id: location.id, kind: "location", name: "Drowned Pier", description: "Sagging boards." },
      { id: character.id, kind: "character", name: "Maera", description: "Lighthouse keeper." },
    ]);
    expect(await getCampaign(created.campaign!.id)).toEqual(created.campaign!);
  });

  test("rejects duplicates, malformed ids, scenes with 400; unknown and foreign with 404", async () => {
    const world = await createWorld({ name: "Rejects", setting_brief: "b", suggested_starting_situation: "" });
    const other = await createWorld({ name: "Other", setting_brief: "o", suggested_starting_situation: "" });
    const persona = await createPersona({ name: "P", description: "d" });
    const character = (await createEntry(world.id, { kind: "character", name: "n", description: "d" })).entry!;
    const foreign = (await createEntry(other.id, { kind: "lore", name: "f", description: "d" })).entry!;
    const scene = (await createEntry(world.id, { kind: "scene", name: "s", description: "d" })).entry!;
    const base = { world_id: world.id, persona_id: persona.id, starting_situation: "" };

    for (const body of [
      { ...base, entry_ids: [character.id, character.id] },
      { ...base, entry_ids: "character" },
      { ...base, entry_ids: [42] },
      { ...base, entry_ids: [""] },
      { ...base, entry_ids: [scene.id] },
    ]) {
      const result = await createCampaign(body as Record<string, unknown>);
      expect(result.status).toBe(400);
      expect(result.code).toBe("invalid_input");
    }

    // Inherited-object-property names and arbitrary junk must be unknown, not
    // silently accepted, duplicated or a 500.
    for (const id of ["no-such-entry", "toString", "__proto__", foreign.id]) {
      const result = await createCampaign({ ...base, entry_ids: [id] });
      expect(result.status).toBe(404);
      expect(result.code).toBe("not_found");
    }
  });
});

describe("shared grounding limit", () => {
  test("binds campaigns with no entries at the exact boundary", async () => {
    const atLimit = await createWorld({ name: "Boundary", setting_brief: "b".repeat(31_000), suggested_starting_situation: "" });
    const persona = await createPersona({ name: "P", description: "d".repeat(990) });

    // 8 + 31000 + 1 + 990 + 1 = 32000 exactly.
    const exact = await createCampaign({
      world_id: atLimit.id,
      persona_id: persona.id,
      starting_situation: "s",
    });
    expect(exact.status).toBe(201);
    expect(exact.campaign?.world_snapshot.entries).toEqual([]);

    const over = await createCampaign({
      world_id: atLimit.id,
      persona_id: persona.id,
      starting_situation: "ss",
    });
    expect(over.status).toBe(400);
    expect(over.code).toBe("invalid_input");
    expect(over.error).toContain("32000");
  });

  test("binds selected entries against the shared count at the exact boundary", async () => {
    const world = await createWorld({ name: "W", setting_brief: "b".repeat(10_000), suggested_starting_situation: "" });
    const persona = await createPersona({ name: "P", description: "d".repeat(10_000) });
    const lore = (await createEntry(world.id, { kind: "lore", name: "The Compact", description: "l".repeat(10_000) })).entry!;
    const base = { world_id: world.id, persona_id: persona.id, starting_situation: "s".repeat(900) };

    const baseCount = groundingCharacterCount({
      world_name: world.name,
      world_setting_brief: world.setting_brief,
      persona_name: persona.name,
      persona_description: persona.description,
      starting_situation: base.starting_situation,
      entries: [{ name: lore.name, description: lore.description }],
    });
    const room = GROUNDING_CHARACTER_LIMIT - baseCount;

    const fits = (await createEntry(world.id, { kind: "location", name: "Fit", description: "f".repeat(room - 3) })).entry!;
    const atLimit = await createCampaign({ ...base, entry_ids: [lore.id, fits.id] });
    expect(atLimit.status).toBe(201);
    expect(
      groundingCharacterCount({
        world_name: world.name,
        world_setting_brief: world.setting_brief,
        persona_name: persona.name,
        persona_description: persona.description,
        starting_situation: base.starting_situation,
        entries: [
          { name: lore.name, description: lore.description },
          { name: fits.name, description: fits.description },
        ],
      }),
    ).toBe(GROUNDING_CHARACTER_LIMIT);

    const overflows = (await createEntry(world.id, { kind: "location", name: "Fits", description: "f".repeat(room - 2) })).entry!;
    const over = await createCampaign({ ...base, entry_ids: [lore.id, overflows.id] });
    expect(over.status).toBe(400);
    expect(over.code).toBe("invalid_input");
    expect(over.error).toContain("32000");
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
    const world = ((await worldResponse.json()) as { world: World }).world;
    const personaResponse = await post("POST", "/api/personas", { name: "Sable", description: "Spy of the ferries." });
    const persona = ((await personaResponse.json()) as { persona: Persona }).persona;
    const entryResponse = await post("POST", `/api/worlds/${world.id}/entries`, {
      kind: "character",
      name: "Maera the Lighthouse Keeper",
      description: "Keeps the drowned light burning.",
    });
    const character = ((await entryResponse.json()) as { entry: WorldEntry }).entry;
    const createdResponse = await post("POST", "/api/campaigns", {
      world_id: world.id,
      persona_id: persona.id,
      starting_situation: "Sable docks at dawn.",
      entry_ids: [character.id],
    });
    expect(createdResponse.status).toBe(201);
    const created = ((await createdResponse.json()) as { campaign: Campaign }).campaign;

    expect((await post("PATCH", `/api/worlds/${world.id}/entries/${character.id}`, { name: "Renamed", description: "Rewritten." })).status).toBe(200);
    expect((await post("DELETE", `/api/worlds/${world.id}/entries/${character.id}`)).status).toBe(200);

    const captured: WorldEntrySnapshot[] = [
      { id: character.id, kind: "character", name: "Maera the Lighthouse Keeper", description: "Keeps the drowned light burning." },
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
    await json("PUT", "/api/provider", { model: "glm-5.3", api_key: "test-key-world-entries" });

    const world = await createWorld({ name: "Veloria", setting_brief: "A rain-soaked harbor kingdom.", suggested_starting_situation: "" });
    const persona = await createPersona({ name: "Sable", description: "A cynical ferrywoman spy." });
    const kept = (await createEntry(world.id, { kind: "character", name: "Maera", description: "Lighthouse keeper." })).entry!;
    // Present in the library but deliberately not selected: the narrator must
    // never see it.
    await createEntry(world.id, { kind: "location", name: "Quarantine", description: "Off-limits pier." });

    const created = await createCampaign({
      world_id: world.id,
      persona_id: persona.id,
      starting_situation: "Sable docks at dawn.",
      entry_ids: [kept.id],
    });
    expect(created.status).toBe(201);

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
      expect(system.content).toContain("character: Maera — Lighthouse keeper.");
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
