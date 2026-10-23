import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventType } from "@tanstack/ai";
import { join } from "node:path";
import type { Campaign, Character, Session, World, WorldCharacter } from "../../shared/domain";
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

async function associate(
  worldId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; character?: WorldCharacter; code?: string; error?: string }> {
  const response = await json("POST", `/api/worlds/${worldId}/characters`, body);
  const payload = (await response.json()) as { character?: WorldCharacter; code?: string; error?: string };
  return { status: response.status, ...payload };
}

async function patchAssociation(
  worldId: string,
  characterId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; character?: WorldCharacter; code?: string }> {
  const response = await json("PATCH", `/api/worlds/${worldId}/characters/${characterId}`, body);
  const payload = (await response.json()) as { character?: WorldCharacter; code?: string };
  return { status: response.status, ...payload };
}

async function createCampaign(
  body: Record<string, unknown>,
): Promise<{ status: number; campaign?: Campaign; session?: Session; code?: string; error?: string }> {
  const response = await json("POST", "/api/campaigns", body);
  const payload = (await response.json()) as {
    campaign?: Campaign;
    session?: Session;
    code?: string;
    error?: string;
  };
  return { status: response.status, ...payload };
}

describe("world cast API", () => {
  test("associates globals with world-specific context; definitions stay global-only", async () => {
    const world = await createWorld({ name: "Ember Coast", setting_brief: "b", suggested_starting_situation: "" });
    const character = await createCharacter({ name: "Brann", description: "Harbormaster.", personality: "Gruff." });

    const created = await associate(world.id, { character_id: character.id, context: "Harbormaster of Ember Coast; owes the tide-priests." });
    expect(created.status).toBe(201);
    expect(created.character?.character_id).toBe(character.id);
    expect(created.character?.world_id).toBe(world.id);
    expect(created.character?.context).toBe("Harbormaster of Ember Coast; owes the tide-priests.");
    expect(created.character?.character.name).toBe("Brann");
    expect(created.character?.character.personality).toBe("Gruff.");

    const duplicate = await associate(world.id, { character_id: character.id });
    expect(duplicate.status).toBe(400);
    expect(duplicate.code).toBe("invalid_input");

    const unknown = await associate(world.id, { character_id: "no-such-character" });
    expect(unknown.status).toBe(404);
    expect(unknown.code).toBe("not_found");
    const unknownWorld = await associate("no-such-world", { character_id: character.id });
    expect(unknownWorld.status).toBe(404);

    const patched = await patchAssociation(world.id, character.id, { context: "Stripped of title; now runs smuggled salt." });
    expect(patched.status).toBe(200);
    expect(patched.character?.context).toBe("Stripped of title; now runs smuggled salt.");
    await expect(patchAssociation(world.id, "no-such-character", { context: "x" })).resolves.toMatchObject({ status: 404 });
    expect((await json("PATCH", `/api/worlds/${world.id}/characters/${character.id}`, {})).status).toBe(400);

    const list = (await (await json("GET", `/api/worlds/${world.id}/characters`)).json()) as {
      characters: WorldCharacter[];
    };
    expect(list.characters).toHaveLength(1);
    expect(list.characters[0]?.context).toBe("Stripped of title; now runs smuggled salt.");

    const removed = await json("DELETE", `/api/worlds/${world.id}/characters/${character.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await json("DELETE", `/api/worlds/${world.id}/characters/${character.id}`)).status).toBe(404);
  });

  test("associations are world-scoped: another world's cast member is just missing", async () => {
    const worldA = await createWorld({ name: "World A", setting_brief: "a", suggested_starting_situation: "" });
    const worldB = await createWorld({ name: "World B", setting_brief: "b", suggested_starting_situation: "" });
    const character = await createCharacter({ name: "Vex", description: "Cartographer of dead routes." });
    expect((await associate(worldA.id, { character_id: character.id, context: "A-context" })).status).toBe(201);

    const listB = (await (await json("GET", `/api/worlds/${worldB.id}/characters`)).json()) as {
      characters: WorldCharacter[];
    };
    expect(listB.characters).toEqual([]);
    expect((await patchAssociation(worldB.id, character.id, { context: "Hijacked" })).status).toBe(404);
    expect((await json("DELETE", `/api/worlds/${worldB.id}/characters/${character.id}`)).status).toBe(404);
    expect((await patchAssociation(worldA.id, character.id, { context: "Renamed" })).status).toBe(200);
  });
});

describe("campaign cast capture", () => {
  test("one global character reused in two worlds captures each world's context separately", async () => {
    const harbor = await createWorld({ name: "Harbor", setting_brief: "h", suggested_starting_situation: "" });
    const mountain = await createWorld({ name: "Mountain", setting_brief: "m", suggested_starting_situation: "" });
    const character = await createCharacter({ name: "Ossra", description: "A wandering bell-founder." });
    expect((await associate(harbor.id, { character_id: character.id, context: "Harbor guildmother." })).status).toBe(201);
    expect((await associate(mountain.id, { character_id: character.id, context: "Mountain exile." })).status).toBe(201);

    const inHarbor = await createCampaign({
      world_id: harbor.id,
      protagonist_id: character.id,
      starting_situation: "s",
    });
    expect(inHarbor.status).toBe(201);
    expect(inHarbor.campaign?.protagonist_snapshot.world_context).toBe("Harbor guildmother.");
    expect(inHarbor.campaign?.protagonist_snapshot.id).toBe(character.id);

    const inMountain = await createCampaign({
      world_id: mountain.id,
      protagonist_id: character.id,
      starting_situation: "s",
    });
    expect(inMountain.status).toBe(201);
    expect(inMountain.campaign?.protagonist_snapshot.world_context).toBe("Mountain exile.");
    expect(inMountain.campaign?.protagonist_snapshot.id).toBe(character.id);
  });

  test("cast accepts outside-world characters with empty context; unknown and malformed are rejected", async () => {
    const world = await createWorld({ name: "Cast World", setting_brief: "c", suggested_starting_situation: "" });
    const associated = await createCharacter({ name: "Ferry Captain", description: "Runs the dawn boat." });
    expect((await associate(world.id, { character_id: associated.id, context: "Owns the Bell" })).status).toBe(201);
    const outsider = await createCharacter({ name: "Drifter", description: "Just off the night boat." });
    const protagonist = await createCharacter({ name: "Player One", description: "The played character." });

    const created = await createCampaign({
      world_id: world.id,
      protagonist_id: protagonist.id,
      cast_character_ids: [outsider.id, associated.id],
      starting_situation: "s",
    });
    expect(created.status).toBe(201);
    expect(created.campaign?.cast).toHaveLength(2);
    expect(created.campaign?.cast.map((member) => member.id)).toEqual([outsider.id, associated.id]);
    const byId = new Map(created.campaign?.cast.map((member) => [member.id, member]));
    expect(byId.get(outsider.id)?.world_context).toBe("");
    expect(byId.get(associated.id)?.world_context).toBe("Owns the Bell");
    expect(created.campaign?.cast.some((member) => member.id === protagonist.id)).toBe(false);

    for (const body of [
      { world_id: world.id, protagonist_id: protagonist.id, cast_character_ids: [outsider.id, outsider.id], starting_situation: "" },
      { world_id: world.id, protagonist_id: protagonist.id, cast_character_ids: [protagonist.id], starting_situation: "" },
      { world_id: world.id, protagonist_id: protagonist.id, cast_character_ids: "drifter", starting_situation: "" },
      { world_id: world.id, protagonist_id: protagonist.id, cast_character_ids: [42], starting_situation: "" },
    ]) {
      const result = await createCampaign(body as Record<string, unknown>);
      expect(result.status).toBe(400);
      expect(result.code).toBe("invalid_input");
    }

    for (const id of ["no-such-character", "toString", "__proto__"]) {
      const result = await createCampaign({
        world_id: world.id,
        protagonist_id: protagonist.id,
        cast_character_ids: [id],
        starting_situation: "",
      });
      expect(result.status).toBe(404);
      expect(result.code).toBe("not_found");
    }
  });
});

describe("captured cast is immutable and drives narration", () => {
  test("character, world-context and world edits leave captured cast intact, across a restart", async () => {
    const configDir = await makeConfigDirectory();
    const dbPath = join(configDir, "cast-capture.db");
    const serverA = await startTestServer({ configDirectory: configDir, databasePath: dbPath });
    const post = (method: string, path: string, body?: unknown) =>
      fetch(`${serverA.url}${path}`, {
        method,
        headers: headersWith({ "content-type": "application/json", origin: TRUSTED_ORIGIN }),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

    const worldResponse = await post("POST", "/api/worlds", { name: "Harbor", setting_brief: "b", suggested_starting_situation: "" });
    const worldPayload = (await worldResponse.json()) as { world: World };
    const world = worldPayload.world;
    const protagonistResponse = await post("POST", "/api/characters", { name: "Sable", description: "Spy of the ferries." });
    const protagonistPayload = (await protagonistResponse.json()) as { character: Character };
    const protagonist = protagonistPayload.character;
    const castResponse = await post("POST", "/api/characters", { name: "Maera", description: "Keeper of the light." });
    const castPayload = (await castResponse.json()) as { character: Character };
    const castMember = castPayload.character;
    expect(
      (await post("POST", `/api/worlds/${world.id}/characters`, { character_id: castMember.id, context: "Sworn to the pier." })).status,
    ).toBe(201);

    const createdResponse = await post("POST", "/api/campaigns", {
      world_id: world.id,
      protagonist_id: protagonist.id,
      cast_character_ids: [castMember.id],
      starting_situation: "Sable docks at dawn.",
    });
    expect(createdResponse.status).toBe(201);
    const createdPayload = (await createdResponse.json()) as { campaign: Campaign; session: Session };
    const created = createdPayload.campaign;
    expect(created.protagonist_snapshot).toEqual({
      id: protagonist.id,
      name: "Sable",
      description: "Spy of the ferries.",
      appearance: "",
      personality: "",
      background: "",
      baseline_motivations: "",
      speaking_style: "",
      world_context: "",
      avatar_id: null,
    });
    expect(created.cast).toEqual([
      {
        id: castMember.id,
        name: "Maera",
        description: "Keeper of the light.",
        appearance: "",
        personality: "",
        background: "",
        baseline_motivations: "",
        speaking_style: "",
        world_context: "Sworn to the pier.",
        avatar_id: null,
      },
    ]);

    expect((await post("PATCH", `/api/characters/${castMember.id}`, { name: "Renamed", description: "Rewritten." })).status).toBe(200);
    expect(
      (await post("PATCH", `/api/worlds/${world.id}/characters/${castMember.id}`, { context: "New context." })).status,
    ).toBe(200);
    expect((await post("DELETE", `/api/worlds/${world.id}/characters/${castMember.id}`)).status).toBe(200);

    const detailResponse = await post("GET", `/api/campaigns/${created.id}`);
    const detail = (await detailResponse.json()) as { campaign: Campaign };
    expect(detail.campaign.cast).toEqual(created.cast);
    expect(detail.campaign.protagonist_snapshot).toEqual(created.protagonist_snapshot);

    await serverA.stop();
    const serverB = await startTestServer({ configDirectory: configDir, databasePath: dbPath });
    const reloadedResponse = await fetch(`${serverB.url}/api/campaigns/${created.id}`, { headers: headersWith() });
    const reloaded = (await reloadedResponse.json()) as { campaign: Campaign };
    expect(reloaded.campaign.cast).toEqual(created.cast);
    await serverB.stop();
    await removeDirectory(configDir);
  });

  test("narration grounds the captured protagonist and cast exactly once, never the live library", async () => {
    await json("PUT", "/api/provider", { model: "glm-5.3", api_key: "test-key-characters" });

    const world = await createWorld({ name: "Harbor", setting_brief: "A drowned harbor.", suggested_starting_situation: "" });
    const protagonist = await createCharacter({
      name: "Sable",
      description: "A cynical ferrywoman spy.",
      speaking_style: "Clipped, sarcastic.",
    });
    const castMember = await createCharacter({ name: "Maera", description: "Keeper of the drowned light." });
    expect((await associate(world.id, { character_id: castMember.id, context: "Sworn to the pier." })).status).toBe(201);
    // Same name as the cast member but a different global character: identity,
    // not name, must decide who is grounded.
    const namesake = await createCharacter({ name: "Maera", description: "A mainland impostor." });
    // In the world cast but deliberately not selected: the narrator must never
    // see it.
    const unselected = await createCharacter({ name: "Quarantine Officer", description: "Off-limits." });
    expect((await associate(world.id, { character_id: unselected.id, context: "sealed" })).status).toBe(201);

    async function createEntry(body: Record<string, unknown>): Promise<string> {
      const response = await json("POST", `/api/worlds/${world.id}/entries`, body);
      expect(response.status).toBe(201);
      const payload = (await response.json()) as { entry: { id: string } };
      return payload.entry.id;
    }
    await createEntry({ kind: "local_npc", name: "Pier Warden", description: "Counts every hull by lantern." });
    await createEntry({ kind: "location", name: "Drowned Pier", description: "Boards hum at low tide." });
    await createEntry({ kind: "lore", name: "The Bell Pact", description: "Bells bind the tides." });
    await createEntry({ kind: "scene", name: "Sealed Pact", description: "Never spoken aloud." });

    const created = await createCampaign({
      world_id: world.id,
      protagonist_id: protagonist.id,
      cast_character_ids: [castMember.id, namesake.id],
      starting_situation: "Sable docks at dawn.",
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
      // Distinctive authored content of protagonist, cast, and selected
      // entries; the prompt's assembled wording is not pinned.
      expect(system.content).toContain("A cynical ferrywoman spy.");
      expect(system.content).toContain("Clipped, sarcastic.");
      expect(system.content).toContain("Keeper of the drowned light.");
      expect(system.content).toContain("Sworn to the pier.");
      expect(system.content).toContain("A mainland impostor.");
      expect(system.content).toContain("Counts every hull by lantern.");
      expect(system.content).toContain("Boards hum at low tide.");
      expect(system.content).toContain("Bells bind the tides.");
      expect(system.content).toContain("Sable docks at dawn.");
      // The cast member's definition grounds exactly once despite its namesake.
      expect(system.content.match(/Keeper of the drowned light/g)).toHaveLength(1);
      // Unselected characters and entries never reach the prompt.
      expect(system.content).not.toContain("Quarantine Officer");
      expect(system.content).not.toContain("Off-limits");
      expect(system.content).not.toContain("Sealed Pact");
      expect(system.content).not.toContain("Never spoken aloud");
      expect(system.content).not.toContain("sealed");

      // Live library edits now must not rewrite the captured grounding.
      const patched = await json("PATCH", `/api/characters/${castMember.id}`, { description: "Rewritten after capture." });
      expect(patched.status).toBe(200);
      const detail = (await (await json("GET", `/api/campaigns/${created.campaign!.id}`)).json()) as { campaign: Campaign };
      expect(detail.campaign.cast[0]?.description).toBe("Keeper of the drowned light.");
      expect(detail.campaign.protagonist_snapshot.description).toBe("A cynical ferrywoman spy.");
    } finally {
      await server.stop();
    }
  });

  test("player turns are spoken as the captured protagonist name", async () => {
    await json("PUT", "/api/provider", { model: "glm-5.3", api_key: "test-key-characters-speaker" });

    const world = await createWorld({ name: "Speaker World", setting_brief: "s", suggested_starting_situation: "" });
    const protagonist = await createCharacter({ name: "Captured Speaker", description: "The played character." });
    const created = await createCampaign({
      world_id: world.id,
      protagonist_id: protagonist.id,
      starting_situation: "s",
    });
    expect(created.status).toBe(201);

    // Rename the live character after capture: the speaker name must stay the
    // captured one.
    expect((await json("PATCH", `/api/characters/${protagonist.id}`, { name: "Renamed Live" })).status).toBe(200);

    const upstream = (async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(openAiChatCompletionSse("glm-5.3", ["Narration."]), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;
    const server = await startTestServer({ configDirectory, databasePath, upstreamFetch: upstream });
    try {
      const response = await fetch(`${server.url}/api/sessions/${created.session!.id}/messages`, {
        method: "POST",
        headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
        body: JSON.stringify({ content: "I watch the docks." }),
      });
      expect(response.status).toBe(200);
      const transcriptResponse = await fetch(`${server.url}/api/sessions/${created.session!.id}/messages`, {
        headers: headersWith(),
      });
      const transcript = (await transcriptResponse.json()) as { messages: Array<{ role: string; speaker_name: string }> };
      const player = transcript.messages.find((message) => message.role === "user");
      expect(player?.speaker_name).toBe("Captured Speaker");
    } finally {
      await server.stop();
    }
  });
});
