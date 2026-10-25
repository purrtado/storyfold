import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EventType } from "@tanstack/ai";
import { join } from "node:path";
import { protagonistOf, type Campaign, type CampaignCharacter, type Character, type Session, type World } from "../../shared/domain";
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

async function createWorldCharacter(worldId: string, body: Record<string, unknown>): Promise<Character> {
  const response = await json("POST", `/api/worlds/${worldId}/characters`, body);
  expect(response.status).toBe(201);
  const payload = (await response.json()) as { character: Character };
  return payload.character;
}

async function getCharacter(id: string): Promise<Character> {
  const response = await json("GET", `/api/characters/${id}`);
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { character: Character };
  return payload.character;
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

function upload(path: string, bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
  return fetch(`${base.url}${path}`, {
    method: "PUT",
    headers: headersWith({ "content-type": "image/png", origin: TRUSTED_ORIGIN }),
    body: bytes,
  });
}

// Real 1x1 PNG.
const PNG_BYTES = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("world characters API", () => {
  test("world characters live in their world only, edited and deleted via /api/characters/:id", async () => {
    const world = await createWorld({ name: "Ember Coast", setting_brief: "b", suggested_starting_situation: "" });
    const worldCharacter = await createWorldCharacter(world.id, {
      name: "Brann",
      description: "Harbormaster.",
      personality: "Gruff.",
    });
    expect(worldCharacter.world_id).toBe(world.id);

    const worldList = (await (await json("GET", `/api/worlds/${world.id}/characters`)).json()) as {
      characters: Character[];
    };
    expect(worldList.characters.map((character) => character.id)).toEqual([worldCharacter.id]);
    const libraryList = (await (await json("GET", "/api/characters")).json()) as { characters: Character[] };
    expect(libraryList.characters.map((character) => character.id)).not.toContain(worldCharacter.id);

    const patched = await json("PATCH", `/api/characters/${worldCharacter.id}`, { name: "Brann the Elder" });
    expect(patched.status).toBe(200);
    const patchedPayload = (await patched.json()) as { character: Character };
    expect(patchedPayload.character.name).toBe("Brann the Elder");

    const removed = await json("DELETE", `/api/characters/${worldCharacter.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await json("GET", `/api/characters/${worldCharacter.id}`)).status).toBe(404);

    // Library characters are permanent: DELETE refuses instead of deleting.
    const libraryCharacter = await createCharacter({ name: "Moro", description: "A wandering cartographer." });
    const refused = await json("DELETE", `/api/characters/${libraryCharacter.id}`);
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { code?: string }).code).toBe("invalid_input");
    expect((await json("GET", `/api/characters/${libraryCharacter.id}`)).status).toBe(200);
  });
});

describe("copy to library", () => {
  test("copies a world character into the library; the copies never touch each other again", async () => {
    const world = await createWorld({ name: "Harbor", setting_brief: "h", suggested_starting_situation: "" });
    const worldCharacter = await createWorldCharacter(world.id, {
      name: "Maera",
      description: "Keeper of the light.",
      personality: "Steady.",
    });
    expect((await upload(`/api/characters/${worldCharacter.id}/avatar`, PNG_BYTES)).status).toBe(200);

    const copyResponse = await json("POST", `/api/characters/${worldCharacter.id}/copy-to-library`);
    expect(copyResponse.status).toBe(201);
    const copyPayload = (await copyResponse.json()) as { character: Character };
    const copy = copyPayload.character;
    expect(copy.id).not.toBe(worldCharacter.id);
    expect(copy.world_id).toBeNull();
    expect(copy.name).toBe("Maera");
    expect(copy.description).toBe("Keeper of the light.");
    expect(copy.personality).toBe("Steady.");
    expect(copy.avatar_id).toBe(sha256(PNG_BYTES));

    await json("PATCH", `/api/characters/${copy.id}`, { name: "Renamed Copy" });
    await json("PATCH", `/api/characters/${worldCharacter.id}`, { description: "Rewritten in the world." });
    expect((await getCharacter(copy.id)).description).toBe("Keeper of the light.");
    expect((await getCharacter(worldCharacter.id)).name).toBe("Maera");
    // The world keeps its own character.
    const worldList = (await (await json("GET", `/api/worlds/${world.id}/characters`)).json()) as {
      characters: Character[];
    };
    expect(worldList.characters.map((character) => character.id)).toEqual([worldCharacter.id]);

    const again = await json("POST", `/api/characters/${copy.id}/copy-to-library`);
    expect(again.status).toBe(400);
  });
});

describe("campaign character picking", () => {
  test("campaigns copy library and same-world characters; foreign and unknown ids are 404", async () => {
    const world = await createWorld({ name: "Pick World", setting_brief: "p", suggested_starting_situation: "" });
    const other = await createWorld({ name: "Other World", setting_brief: "o", suggested_starting_situation: "" });
    const libraryProtagonist = await createCharacter({ name: "Player One", description: "The played character." });
    const worldCast = await createWorldCharacter(world.id, { name: "Ferry Captain", description: "Runs the dawn boat." });
    const foreignCast = await createWorldCharacter(other.id, { name: "Drifter", description: "Belongs to another world." });

    for (const castId of [foreignCast.id, "no-such-character"]) {
      const result = await createCampaign({
        world_id: world.id,
        protagonist_id: libraryProtagonist.id,
        cast_character_ids: [castId],
        starting_situation: "s",
      });
      expect(result.status).toBe(404);
      expect(result.code).toBe("not_found");
    }
    for (const cast_character_ids of [
      [worldCast.id, worldCast.id],
      [libraryProtagonist.id],
    ]) {
      const result = await createCampaign({
        world_id: world.id,
        protagonist_id: libraryProtagonist.id,
        cast_character_ids,
        starting_situation: "s",
      });
      expect(result.status).toBe(400);
      expect(result.code).toBe("invalid_input");
    }

    const created = await createCampaign({
      world_id: world.id,
      protagonist_id: libraryProtagonist.id,
      cast_character_ids: [worldCast.id],
      starting_situation: "The captain steers at dawn.",
    });
    expect(created.status).toBe(201);
    expect(created.campaign!.characters.map((character) => [character.role, character.name])).toEqual([
      ["protagonist", "Player One"],
      ["cast", "Ferry Captain"],
    ]);

    // Copies are independent in both directions.
    await json("PATCH", `/api/characters/${libraryProtagonist.id}`, { name: "Renamed Live" });
    await json("PATCH", `/api/characters/${worldCast.id}`, { description: "Rewritten." });
    const detail = (await (await json("GET", `/api/campaigns/${created.campaign!.id}`)).json()) as { campaign: Campaign };
    expect(protagonistOf(detail.campaign).name).toBe("Player One");
    expect(detail.campaign.characters[1]?.description).toBe("Runs the dawn boat.");

    await json("PATCH", `/api/campaigns/${created.campaign!.id}/characters/${created.campaign!.characters[0]!.id}`, {
      name: "Renamed In Campaign",
    });
    expect((await getCharacter(libraryProtagonist.id)).name).toBe("Renamed Live");
  });
});

describe("campaign characters API", () => {
  test("creates cast, patches profiles, refuses protagonist deletion, and cascades relationships", async () => {
    const world = await createWorld({ name: "Cast World", setting_brief: "c", suggested_starting_situation: "" });
    const protagonist = await createCharacter({ name: "Player One", description: "The played character." });
    const created = await createCampaign({ world_id: world.id, protagonist_id: protagonist.id, starting_situation: "s" });
    expect(created.status).toBe(201);
    const campaignId = created.campaign!.id;
    const protagonistId = protagonistOf(created.campaign!).id;

    const companionResponse = await json("POST", `/api/campaigns/${campaignId}/characters`, {
      name: "Maera",
      description: "Keeper of the light.",
    });
    expect(companionResponse.status).toBe(201);
    const companionPayload = (await companionResponse.json()) as { character: CampaignCharacter };
    const companion = companionPayload.character;
    expect(companion.role).toBe("cast");
    expect(companion.campaign_id).toBe(campaignId);

    const patched = await json("PATCH", `/api/campaigns/${campaignId}/characters/${companion.id}`, {
      personality: "Watchful.",
    });
    expect(patched.status).toBe(200);
    const patchedBody = ((await patched.json()) as { character: CampaignCharacter }).character;
    expect(patchedBody.personality).toBe("Watchful.");
    expect(patchedBody.description).toBe("Keeper of the light.");

    const relationship = await json("POST", `/api/campaigns/${campaignId}/relationships`, {
      source_id: protagonistId,
      target_id: companion.id,
      document: { how_met: "At the pier.", status: "wary", stats: {}, known_facts: [], sections: [] },
    });
    expect(relationship.status).toBe(201);

    expect((await json("DELETE", `/api/campaigns/${campaignId}/characters/${protagonistId}`)).status).toBe(400);

    const removed = await json("DELETE", `/api/campaigns/${campaignId}/characters/${companion.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    const relationships = (await (await json("GET", `/api/campaigns/${campaignId}/relationships`)).json()) as {
      relationships: unknown[];
    };
    expect(relationships.relationships).toEqual([]);
    const remaining = (await (await json("GET", `/api/campaigns/${campaignId}/characters`)).json()) as {
      characters: CampaignCharacter[];
    };
    expect(remaining.characters.map((character) => character.id)).toEqual([protagonistId]);
  });

  test("save-to-world copies the current profile and avatar into the campaign's world", async () => {
    const world = await createWorld({ name: "Save World", setting_brief: "s", suggested_starting_situation: "" });
    const protagonist = await createCharacter({ name: "Player One", description: "The played character." });
    const created = await createCampaign({ world_id: world.id, protagonist_id: protagonist.id, starting_situation: "s" });
    const campaignId = created.campaign!.id;
    const companionResponse = await json("POST", `/api/campaigns/${campaignId}/characters`, {
      name: "Maera",
      description: "Keeper of the light.",
    });
    expect(companionResponse.status).toBe(201);
    const companionPayload = (await companionResponse.json()) as { character: CampaignCharacter };
    const companion = companionPayload.character;
    expect(
      (await upload(`/api/campaigns/${campaignId}/characters/${companion.id}/avatar`, PNG_BYTES)).status,
    ).toBe(200);

    const savedResponse = await json("POST", `/api/campaigns/${campaignId}/characters/${companion.id}/save-to-world`);
    expect(savedResponse.status).toBe(201);
    const savedPayload = (await savedResponse.json()) as { character: Character };
    const saved = savedPayload.character;
    expect(saved.world_id).toBe(world.id);
    expect(saved.name).toBe("Maera");
    expect(saved.description).toBe("Keeper of the light.");
    expect(saved.avatar_id).toBe(sha256(PNG_BYTES));

    // The copy is independent of the campaign character.
    await json("PATCH", `/api/campaigns/${campaignId}/characters/${companion.id}`, { name: "Renamed In Campaign" });
    expect((await getCharacter(saved.id)).name).toBe("Maera");
  });

  test("campaign character edits reach the next narration and the player speaks with the current name", async () => {
    await configureProvider(base.url, "test-key-campaign-characters");

    const world = await createWorld({ name: "Prompt World", setting_brief: "p", suggested_starting_situation: "" });
    const protagonist = await createCharacter({ name: "Stale Name", description: "The played character." });
    const created = await createCampaign({ world_id: world.id, protagonist_id: protagonist.id, starting_situation: "s" });
    expect(created.status).toBe(201);
    const campaignId = created.campaign!.id;

    const patched = await json(
      "PATCH",
      `/api/campaigns/${campaignId}/characters/${protagonistOf(created.campaign!).id}`,
      { name: "Current Name", personality: "Fearless, loudly." },
    );
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
      const response = await fetch(`${server.url}/api/sessions/${created.session!.id}/messages`, {
        method: "POST",
        headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
        body: JSON.stringify({ content: "I watch the docks." }),
      });
      expect(response.status).toBe(200);
      const events = parseSseEvents(await response.text());
      expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED);

      const history = calls[0].messages as Array<{ role: string; content: string }>;
      expect(history[0].role).toBe("system");
      expect(history[0].content).toContain("Current Name");
      expect(history[0].content).toContain("Fearless, loudly.");
      expect(history[0].content).toContain("The played character.");

      const transcriptResponse = await fetch(`${server.url}/api/sessions/${created.session!.id}/messages`, {
        headers: headersWith(),
      });
      const transcript = (await transcriptResponse.json()) as {
        messages: Array<{ role: string; speaker_name: string }>;
      };
      const player = transcript.messages.find((message) => message.role === "user");
      expect(player?.speaker_name).toBe("Current Name");
    } finally {
      await server.stop();
    }
  });
});
