import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { protagonistOf, type Campaign, type Character, type Session, type World } from "../../shared/domain";
import {
  headersWith,
  makeConfigDirectory,
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
  databasePath = join(configDirectory, "library.db");
  base = await startTestServer({ configDirectory, databasePath });
});

afterAll(async () => {
  await base?.stop();
  if (configDirectory) await removeDirectory(configDirectory);
});

async function createWorld(body: Record<string, unknown>): Promise<{ status: number; world?: World; error?: string; code?: string }> {
  const response = await fetch(`${base.url}/api/worlds`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return { status: response.status, ...(await response.json()) };
}

async function patchWorld(id: string, body: Record<string, unknown>): Promise<{ status: number; world?: World; code?: string }> {
  const response = await fetch(`${base.url}/api/worlds/${id}`, {
    method: "PATCH",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return { status: response.status, ...(await response.json()) };
}

async function createCharacter(body: Record<string, unknown>): Promise<{ status: number; character?: Character }> {
  const response = await fetch(`${base.url}/api/characters`, {
    method: "POST",
    headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  return { status: response.status, ...(await response.json()) };
}

describe("worlds API", () => {
  test("creates, lists, reads and patches worlds; blank suggestion stays blank", async () => {
    const created = await createWorld({
      name: "  Ember Coast  ",
      setting_brief: "Tide-locked cliffs.",
      suggested_starting_situation: "  ",
    });
    expect(created.status).toBe(201);
    expect(created.world?.name).toBe("Ember Coast");
    expect(created.world?.suggested_starting_situation).toBe("");

    const list = (await (await fetch(`${base.url}/api/worlds`, { headers: headersWith() })).json()) as { worlds: World[] };
    expect(list.worlds.some((world) => world.id === created.world?.id)).toBe(true);

    const single = await fetch(`${base.url}/api/worlds/${created.world?.id}`, { headers: headersWith() });
    expect((await single.json()) as { world: World }).toBeTruthy();

    const patched = await patchWorld(created.world!.id, { suggested_starting_situation: "A beached leviathan." });
    expect(patched.status).toBe(200);
    expect(patched.world?.suggested_starting_situation).toBe("A beached leviathan.");
    expect(patched.world?.setting_brief).toBe("Tide-locked cliffs.");
  });

  test("rejects invalid worlds with invalid_input and unknown ids with not_found", async () => {
    for (const body of [{}, { name: "", setting_brief: "b", suggested_starting_situation: "" }, { name: "n", setting_brief: "", suggested_starting_situation: "" }, { name: "n", setting_brief: "b" }]) {
      const result = await createWorld(body);
      expect(result.status).toBe(400);
      expect(result.code).toBe("invalid_input");
    }
    const missing = await patchWorld("no-such-world", { name: "X" });
    expect(missing.status).toBe(404);
    expect(missing.code).toBe("not_found");
    const emptyPatch = await patchWorld((await createWorld({ name: "W2", setting_brief: "b", suggested_starting_situation: "" })).world!.id, {});
    expect(emptyPatch.status).toBe(400);
  });
});

describe("characters API", () => {
  test("creates and edits characters with optional authored fields defaulting to empty", async () => {
    const created = await createCharacter({
      name: "Moss",
      description: "A hedge-witch archivist.",
      speaking_style: "Dry, precise, fond of marginalia.",
    });
    expect(created.status).toBe(201);
    expect(created.character?.appearance).toBe("");
    expect(created.character?.personality).toBe("");
    expect(created.character?.background).toBe("");
    expect(created.character?.baseline_motivations).toBe("");
    expect(created.character?.speaking_style).toBe("Dry, precise, fond of marginalia.");

    const bad = await createCharacter({ name: "", description: "d" });
    expect(bad.status).toBe(400);
    const notText = await createCharacter({ name: "n", description: "d", appearance: 42 });
    expect(notText.status).toBe(400);

    const list = (await (await fetch(`${base.url}/api/characters`, { headers: headersWith() })).json()) as {
      characters: Character[];
    };
    expect(list.characters.some((character) => character.id === created.character?.id)).toBe(true);

    const patched = await fetch(`${base.url}/api/characters/${created.character!.id}`, {
      method: "PATCH",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ description: "Archivist of drowned libraries.", personality: "Painstaking." }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { character: Character };
    expect(body.character.description).toBe("Archivist of drowned libraries.");
    expect(body.character.personality).toBe("Painstaking.");
    expect(body.character.speaking_style).toBe("Dry, precise, fond of marginalia.");
    const emptyPatch = await fetch(`${base.url}/api/characters/${created.character!.id}`, {
      method: "PATCH",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({}),
    });
    expect(emptyPatch.status).toBe(400);
    expect((await fetch(`${base.url}/api/characters/missing`, { headers: headersWith() })).status).toBe(404);
  });
});

describe("campaigns API", () => {
  test("campaigns create distinctly with or without an explicit name and reopen by id", async () => {
    const world = (await createWorld({ name: "Two Seat World", setting_brief: "b", suggested_starting_situation: "" })).world!;
    const protagonist = (await createCharacter({ name: "Two Seat Hero", description: "d" })).character!;
    const named = await fetch(`${base.url}/api/campaigns`, {
      method: "POST",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ world_id: world.id, protagonist_id: protagonist.id, starting_situation: "s", name: "Custom Name" }),
    });
    expect(named.status).toBe(201);
    const namedBody = (await named.json()) as { campaign: Campaign; session: Session };
    expect(namedBody.campaign.name).toBe("Custom Name");
    const unnamed = await fetch(`${base.url}/api/campaigns`, {
      method: "POST",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ world_id: world.id, protagonist_id: protagonist.id, starting_situation: "s2" }),
    });
    expect(unnamed.status).toBe(201);
    const unnamedBody = (await unnamed.json()) as { campaign: Campaign; session: Session };
    expect(unnamedBody.campaign.id).not.toBe(namedBody.campaign.id);
    expect(unnamedBody.session.id).not.toBe(namedBody.session.id);

    for (const created of [namedBody, unnamedBody]) {
      const detail = await fetch(`${base.url}/api/campaigns/${created.campaign.id}`, { headers: headersWith() });
      expect(detail.status).toBe(200);
      const body = (await detail.json()) as { campaign: Campaign };
      expect(body.campaign.active_session_id).toBe(created.session.id);
    }
  });

  test("campaign detail exposes characters and unknown ids 404", async () => {
    const world = (await createWorld({ name: "Detail World", setting_brief: "deep", suggested_starting_situation: "opt" })).world!;
    const protagonist = (await createCharacter({ name: "Detail Hero", description: "deep hero" })).character!;
    const created = await fetch(`${base.url}/api/campaigns`, {
      method: "POST",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ world_id: world.id, protagonist_id: protagonist.id, starting_situation: "Detail situation" }),
    });
    const { campaign } = (await created.json()) as { campaign: Campaign };
    const detail = (await (
      await fetch(`${base.url}/api/campaigns/${campaign.id}`, { headers: headersWith() })
    ).json()) as { campaign: Campaign };
    expect(protagonistOf(detail.campaign).description).toBe("deep hero");
    expect(detail.campaign.characters).toHaveLength(1);
    expect(detail.campaign.characters[0]?.role).toBe("protagonist");
    expect(detail.campaign.starting_situation).toBe("Detail situation");
    expect((await fetch(`${base.url}/api/campaigns/missing`, { headers: headersWith() })).status).toBe(404);
  });
});
