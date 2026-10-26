import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { World } from "../../shared/domain";
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
  databasePath = join(configDirectory, "worlds.db");
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

describe("worlds API", () => {
  test("creates, lists, reads and patches worlds", async () => {
    const created = await createWorld({ name: "  Ember Coast  ", setting_brief: "  Tide-locked cliffs.  " });
    expect(created.status).toBe(201);
    expect(created.world?.name).toBe("Ember Coast");
    expect(created.world?.setting_brief).toBe("Tide-locked cliffs.");
    expect(created.world).not.toHaveProperty("suggested_starting_situation");
    expect(Number.isNaN(Date.parse(created.world!.created_at))).toBe(false);

    const list = (await (await fetch(`${base.url}/api/worlds`, { headers: headersWith() })).json()) as { worlds: World[] };
    expect(list.worlds.some((world) => world.id === created.world?.id)).toBe(true);

    const single = await fetch(`${base.url}/api/worlds/${created.world?.id}`, { headers: headersWith() });
    expect(single.status).toBe(200);
    expect(((await single.json()) as { world: World }).world).toEqual(created.world!);

    const patched = await patchWorld(created.world!.id, { setting_brief: "Cliffs above a beached leviathan." });
    expect(patched.status).toBe(200);
    expect(patched.world?.setting_brief).toBe("Cliffs above a beached leviathan.");
    expect(patched.world?.name).toBe("Ember Coast");
    expect(patched.world!.updated_at >= created.world!.updated_at).toBe(true);
  });

  test("rejects invalid worlds with invalid_input and unknown ids with not_found", async () => {
    for (const body of [{}, { name: "", setting_brief: "b" }, { name: "n", setting_brief: "" }, { name: "n" }]) {
      const result = await createWorld(body);
      expect(result.status).toBe(400);
      expect(result.code).toBe("invalid_input");
    }
    const missing = await patchWorld("no-such-world", { name: "X" });
    expect(missing.status).toBe(404);
    expect(missing.code).toBe("not_found");
    const emptyPatch = await patchWorld((await createWorld({ name: "W2", setting_brief: "b" })).world!.id, {});
    expect(emptyPatch.status).toBe(400);
    expect((await fetch(`${base.url}/api/worlds/missing`, { headers: headersWith() })).status).toBe(404);
  });
});
