import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Campaign, Persona, World } from "../../shared/domain";
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

async function createPersona(body: Record<string, unknown>): Promise<{ status: number; persona?: Persona }> {
  const response = await fetch(`${base.url}/api/personas`, {
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

describe("personas API", () => {
  test("creates and edits personas with validated required text", async () => {
    const created = await createPersona({ name: "Moss", description: "A hedge-witch archivist." });
    expect(created.status).toBe(201);
    const bad = await createPersona({ name: "", description: "d" });
    expect(bad.status).toBe(400);
    const patched = await fetch(`${base.url}/api/personas/${created.persona!.id}`, {
      method: "PATCH",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ description: "Archivist of drowned libraries." }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as { persona: Persona };
    expect(body.persona.name).toBe("Moss");
    expect(body.persona.description).toBe("Archivist of drowned libraries.");
  });
});

describe("campaigns API", () => {
  test("creates campaigns with an explicit or default name and lists newest first", async () => {
    const world = (await createWorld({ name: "Named World", setting_brief: "b", suggested_starting_situation: "" })).world!;
    const persona = (await createPersona({ name: "Named Persona", description: "d" })).persona!;
    const named = await fetch(`${base.url}/api/campaigns`, {
      method: "POST",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ world_id: world.id, persona_id: persona.id, starting_situation: "s", name: "Custom Name" }),
    });
    expect(((await named.json()) as { campaign: Campaign }).campaign.name).toBe("Custom Name");
    const defaulted = await fetch(`${base.url}/api/campaigns`, {
      method: "POST",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ world_id: world.id, persona_id: persona.id, starting_situation: "" }),
    });
    expect(((await defaulted.json()) as { campaign: Campaign }).campaign.name).toBe("Named World");
    const list = (await (await fetch(`${base.url}/api/campaigns`, { headers: headersWith() })).json()) as {
      campaigns: Campaign[];
    };
    expect(list.campaigns[0].name).toBe("Named World");
  });

  test("campaign detail exposes parsed snapshots and unknown ids 404", async () => {
    const world = (await createWorld({ name: "Detail World", setting_brief: "deep", suggested_starting_situation: "opt" })).world!;
    const persona = (await createPersona({ name: "Detail Persona", description: "deep persona" })).persona!;
    const created = await fetch(`${base.url}/api/campaigns`, {
      method: "POST",
      headers: headersWith({ origin: TRUSTED_ORIGIN, "content-type": "application/json" }),
      body: JSON.stringify({ world_id: world.id, persona_id: persona.id, starting_situation: "Detail situation" }),
    });
    const { campaign } = (await created.json()) as { campaign: Campaign };
    const detail = (await (
      await fetch(`${base.url}/api/campaigns/${campaign.id}`, { headers: headersWith() })
    ).json()) as { campaign: Campaign };
    expect(detail.campaign.world_snapshot.suggested_starting_situation).toBe("opt");
    expect(detail.campaign.persona_snapshot.description).toBe("deep persona");
    expect(detail.campaign.starting_situation).toBe("Detail situation");
    expect((await fetch(`${base.url}/api/campaigns/missing`, { headers: headersWith() })).status).toBe(404);
  });
});
