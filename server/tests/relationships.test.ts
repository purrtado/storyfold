import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Character, Relationship, World } from "../../shared/domain";
import { openDatabase } from "../db";
import {
  createRelationship,
  listRelationships,
  parseRelationshipPatch,
  updateRelationship,
} from "../relationships";
import { createCharacter, createWorld, parseCharacterInput } from "../worlds";
import { headersWith, startTestServer, type TestServer } from "./helpers";

const TRUSTED_ORIGIN = "http://localhost:5173";

const directories: string[] = [];
const servers: TestServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "storyfold-relationships-"));
  directories.push(directory);
  const path = join(directory, "storyfold.db");
  const db = openDatabase(path);
  const world = createWorld(db, { name: "World", setting_brief: "A quiet harbor" });
  const otherWorld = createWorld(db, { name: "Elsewhere", setting_brief: "A distant range" });
  const mira = createCharacter(db, world.id, parseCharacterInput({ name: "Mira", description: "A careful sailor." }))!;
  const oren = createCharacter(db, world.id, parseCharacterInput({ name: "Oren", description: "A retired navigator." }))!;
  const stranger = createCharacter(db, otherWorld.id, parseCharacterInput({ name: "Other", description: "Lives elsewhere." }))!;
  return { db, path, world, otherWorld, mira, oren, stranger };
}

const fields = (how_met: string) => ({ how_met, status: "wary", known_facts: [] });

test("relationships are directional, world-scoped, validated, and last save wins", () => {
  const { db, path, world, mira, oren, stranger } = setup();
  const stats = [] as const;
  const forward = createRelationship(db, world.id, mira.id, oren.id, parseRelationshipPatch(fields("At sea."), stats));
  const reverse = createRelationship(db, world.id, oren.id, mira.id, parseRelationshipPatch(fields("At port."), stats));
  expect(forward.source_id).toBe(mira.id);
  expect(forward.world_id).toBe(world.id);
  expect(reverse.source_id).toBe(oren.id);
  expect(() => createRelationship(db, world.id, mira.id, oren.id, parseRelationshipPatch(fields("Again."), stats))).toThrow();
  expect(() => createRelationship(db, world.id, mira.id, mira.id, {})).toThrow();
  expect(() => createRelationship(db, world.id, mira.id, "no-such-character", {})).toThrow();
  expect(() => createRelationship(db, world.id, mira.id, stranger.id, {})).toThrow();
  expect(() => parseRelationshipPatch({ stats: { mood: 1 } }, stats)).toThrow();
  updateRelationship(db, world.id, forward.id, parseRelationshipPatch(fields("First save."), stats));
  updateRelationship(db, world.id, forward.id, parseRelationshipPatch(fields("Second save."), stats));
  db.close();
  const reopened = openDatabase(path);
  const stored = listRelationships(reopened, world.id);
  expect(stored.map((item) => item.id)).toEqual([forward.id, reverse.id]);
  expect(stored[0]!.how_met).toBe("Second save.");
  expect(stored[0]!.status).toBe("wary");
  reopened.close();
});

test("a relationship belongs to one world: other worlds neither list nor edit it", () => {
  const { db, world, otherWorld, mira, oren, stranger } = setup();
  const sibling = createCharacter(db, otherWorld.id, parseCharacterInput({ name: "Sibling", description: "Also elsewhere." }))!;
  const home = createRelationship(db, world.id, mira.id, oren.id, parseRelationshipPatch(fields("At sea."), []));
  const away = createRelationship(db, otherWorld.id, stranger.id, sibling.id, parseRelationshipPatch(fields("In the range."), []));

  expect(listRelationships(db, world.id).map((item) => item.id)).toEqual([home.id]);
  expect(listRelationships(db, otherWorld.id).map((item) => item.id)).toEqual([away.id]);
  expect(updateRelationship(db, otherWorld.id, home.id, { status: "hostile" })).toBeNull();
  expect(listRelationships(db, world.id)[0]!.status).toBe("wary");
  db.close();
});

async function startApi(): Promise<{ call: (method: string, path: string, body?: unknown) => Promise<Response> }> {
  const directory = mkdtempSync(join(tmpdir(), "storyfold-relationships-api-"));
  directories.push(directory);
  const server = await startTestServer({ configDirectory: directory, databasePath: join(directory, "storyfold.db") });
  servers.push(server);
  return {
    call: (method, path, body) =>
      fetch(`${server.url}${path}`, {
        method,
        headers: headersWith({ "content-type": "application/json", origin: TRUSTED_ORIGIN }),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
  };
}

test("relationship routes are scoped to their world and validate endpoints", async () => {
  const { call } = await startApi();
  const worldOf = async (name: string) =>
    ((await (await call("POST", "/api/worlds", { name, setting_brief: "b" })).json()) as { world: World }).world;
  const characterOf = async (world: World, name: string) =>
    ((await (await call("POST", `/api/worlds/${world.id}/characters`, { name, description: "d" })).json()) as {
      character: Character;
    }).character;
  const harbor = await worldOf("Harbor");
  const range = await worldOf("Range");
  const mira = await characterOf(harbor, "Mira");
  const oren = await characterOf(harbor, "Oren");
  const drifter = await characterOf(range, "Drifter");

  const created = await call("POST", `/api/worlds/${harbor.id}/relationships`, {
    source_id: mira.id,
    target_id: oren.id,
    how_met: "At the pier.",
    status: "wary",
    known_facts: ["Owes a favor."],
  });
  expect(created.status).toBe(201);
  const relationship = ((await created.json()) as { relationship: Relationship }).relationship;
  expect(relationship.world_id).toBe(harbor.id);

  const crossWorld = await call("POST", `/api/worlds/${harbor.id}/relationships`, {
    source_id: mira.id,
    target_id: drifter.id,
  });
  expect(crossWorld.status).toBe(400);
  expect(((await crossWorld.json()) as { code?: string }).code).toBe("invalid_input");
  const duplicate = await call("POST", `/api/worlds/${harbor.id}/relationships`, { source_id: mira.id, target_id: oren.id });
  expect(duplicate.status).toBe(400);
  const unknownWorld = await call("GET", "/api/worlds/no-such-world/relationships");
  expect(unknownWorld.status).toBe(404);

  const rangeList = (await (await call("GET", `/api/worlds/${range.id}/relationships`)).json()) as {
    relationships: Relationship[];
  };
  expect(rangeList.relationships).toEqual([]);
  expect((await call("PATCH", `/api/worlds/${range.id}/relationships/${relationship.id}`, { status: "x" })).status).toBe(404);
  expect((await call("DELETE", `/api/worlds/${range.id}/relationships/${relationship.id}`)).status).toBe(404);

  const patched = await call("PATCH", `/api/worlds/${harbor.id}/relationships/${relationship.id}`, { status: "allied" });
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as { relationship: Relationship }).relationship.status).toBe("allied");
  const invalid = await call("PATCH", `/api/worlds/${harbor.id}/relationships/${relationship.id}`, { known_facts: "no" });
  expect(invalid.status).toBe(400);

  expect((await call("DELETE", `/api/worlds/${harbor.id}/relationships/${relationship.id}`)).status).toBe(200);
  const harborList = (await (await call("GET", `/api/worlds/${harbor.id}/relationships`)).json()) as {
    relationships: Relationship[];
  };
  expect(harborList.relationships).toEqual([]);
});

test("deleting either endpoint character removes its relationships", async () => {
  const { call } = await startApi();
  const world = ((await (await call("POST", "/api/worlds", { name: "Harbor", setting_brief: "b" })).json()) as { world: World }).world;
  const characters: Character[] = [];
  for (const name of ["Mira", "Oren", "Ilyra"]) {
    const response = await call("POST", `/api/worlds/${world.id}/characters`, { name, description: "d" });
    characters.push(((await response.json()) as { character: Character }).character);
  }
  const [mira, oren, ilyra] = characters as [Character, Character, Character];
  for (const [source, target] of [
    [mira, oren],
    [oren, ilyra],
    [ilyra, mira],
  ] as const) {
    const response = await call("POST", `/api/worlds/${world.id}/relationships`, {
      source_id: source.id,
      target_id: target.id,
    });
    expect(response.status).toBe(201);
  }

  expect((await call("DELETE", `/api/characters/${oren.id}`)).status).toBe(200);
  const remaining = (await (await call("GET", `/api/worlds/${world.id}/relationships`)).json()) as {
    relationships: Relationship[];
  };
  expect(remaining.relationships.map((item) => [item.source_id, item.target_id])).toEqual([[ilyra.id, mira.id]]);

  expect((await call("DELETE", `/api/characters/${mira.id}`)).status).toBe(200);
  const none = (await (await call("GET", `/api/worlds/${world.id}/relationships`)).json()) as {
    relationships: Relationship[];
  };
  expect(none.relationships).toEqual([]);
});
