import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { protagonistOf, type Campaign, type Character, type World } from "../../shared/domain";
import { AVATAR_BODY_MAX_BYTES } from "../security";
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
  databasePath = join(configDirectory, "avatars.db");
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

/** Raw-byte mutation with an explicit content type and origin. */
function upload(path: string, mime: string, bytes: Uint8Array<ArrayBuffer>, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base.url}${path}`, {
    method: "PUT",
    headers: headersWith({ "content-type": mime, origin: TRUSTED_ORIGIN, ...extra }),
    body: bytes,
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createCharacter(body: Record<string, unknown>): Promise<Character> {
  const response = await json("POST", "/api/characters", body);
  expect(response.status).toBe(201);
  const payload: { character: Character } = await response.json();
  return payload.character;
}

async function createWorld(body: Record<string, unknown>): Promise<World> {
  const response = await json("POST", "/api/worlds", body);
  expect(response.status).toBe(201);
  const payload: { world: World } = await response.json();
  return payload.world;
}

async function getCharacter(id: string): Promise<Character> {
  const response = await json("GET", `/api/characters/${id}`);
  expect(response.status).toBe(200);
  const payload: { character: Character } = await response.json();
  return payload.character;
}

async function getCampaign(id: string): Promise<Campaign> {
  const response = await json("GET", `/api/campaigns/${id}`);
  expect(response.status).toBe(200);
  const payload: { campaign: Campaign } = await response.json();
  return payload.campaign;
}

// Real 1x1 PNG, plus format-prefixed bytes for the other accepted types.
const PNG_BYTES = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (char) => char.charCodeAt(0),
);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const WEBP_BYTES = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);
const GIF_BYTES = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]);
const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');

describe("character avatars", () => {
  test("upload stores content-addressed bytes and serves them with immutable caching", async () => {
    const character = await createCharacter({ name: "Sable", description: "Spy of the ferries." });
    expect(character.avatar_id).toBeNull();

    const response = await upload(`/api/characters/${character.id}/avatar`, "image/png", PNG_BYTES);
    expect(response.status).toBe(200);
    const payload: { character: Character } = await response.json();
    expect(payload.character.avatar_id).toBe(sha256(PNG_BYTES));

    const reloaded = await getCharacter(character.id);
    expect(reloaded.avatar_id).toBe(sha256(PNG_BYTES));

    const imageId = sha256(PNG_BYTES);
    const image = await fetch(`${base.url}/api/images/${imageId}`, { headers: headersWith() });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(sha256(new Uint8Array(await image.arrayBuffer()))).toBe(imageId);

    // Re-uploading identical bytes converges on the same image id.
    const again = await upload(`/api/characters/${character.id}/avatar`, "image/png", PNG_BYTES);
    const againPayload: { character: Character } = await again.json();
    expect(againPayload.character.avatar_id).toBe(imageId);
  });

  test("accepts every declared format and rejects mismatched or unsupported magic bytes", async () => {
    const character = await createCharacter({ name: "Maera", description: "Keeper of the light." });
    const cases: Array<[string, Uint8Array<ArrayBuffer>]> = [
      ["image/jpeg", JPEG_BYTES],
      ["image/webp", WEBP_BYTES],
      ["image/gif", GIF_BYTES],
    ];
    for (const [mime, bytes] of cases) {
      const response = await upload(`/api/characters/${character.id}/avatar`, mime, bytes);
      expect(response.status).toBe(200);
      const payload: { character: Character } = await response.json();
      expect(payload.character.avatar_id).toBe(sha256(bytes));
    }

    // Declared type disagrees with the actual bytes, and SVG is never accepted.
    const mismatch = await upload(`/api/characters/${character.id}/avatar`, "image/png", JPEG_BYTES);
    expect(mismatch.status).toBe(400);
    const svgAsPng = await upload(`/api/characters/${character.id}/avatar`, "image/png", SVG_BYTES);
    expect(svgAsPng.status).toBe(400);
    const svgType = await upload(`/api/characters/${character.id}/avatar`, "image/svg+xml", SVG_BYTES);
    expect(svgType.status).toBe(415);
    const missingBody = await upload(`/api/characters/${character.id}/avatar`, "image/png", new Uint8Array(0));
    expect(missingBody.status).toBe(400);
    // The failed attempts never cleared or replaced the stored GIF.
    expect((await getCharacter(character.id)).avatar_id).toBe(sha256(GIF_BYTES));
  });

  test("rejects oversize uploads with 413", async () => {
    const character = await createCharacter({ name: "Harrow", description: "Ferry wright." });
    const oversize = new Uint8Array(AVATAR_BODY_MAX_BYTES + 1);
    oversize.set(PNG_BYTES.subarray(0, 8));
    const response = await upload(`/api/characters/${character.id}/avatar`, "image/png", oversize);
    expect(response.status).toBe(413);
    expect((await getCharacter(character.id)).avatar_id).toBeNull();
  });

  test("mutations require a trusted origin", async () => {
    const character = await createCharacter({ name: "Vess", description: "Tide-priest." });
    const noOrigin = await upload(`/api/characters/${character.id}/avatar`, "image/png", PNG_BYTES, { origin: "" });
    expect(noOrigin.status).toBe(403);
    const foreignOrigin = await fetch(`${base.url}/api/characters/${character.id}/avatar`, {
      method: "PUT",
      headers: headersWith({ "content-type": "image/png", origin: "http://evil.example" }),
      body: PNG_BYTES,
    });
    expect(foreignOrigin.status).toBe(403);
    expect((await getCharacter(character.id)).avatar_id).toBeNull();
  });

  test("unknown characters and images answer 404; images are read-only", async () => {
    const missing = await upload("/api/characters/nope/avatar", "image/png", PNG_BYTES);
    expect(missing.status).toBe(404);
    const unknownImage = await fetch(`${base.url}/api/images/${"0".repeat(64)}`, { headers: headersWith() });
    expect(unknownImage.status).toBe(404);
    const unknownPayload: { code?: string } = await unknownImage.json();
    expect(unknownPayload.code).toBe("not_found");
    const postImage = await fetch(`${base.url}/api/images/${"0".repeat(64)}`, {
      method: "POST",
      headers: headersWith({ origin: TRUSTED_ORIGIN }),
    });
    expect(postImage.status).toBe(405);
  });

  test("campaign creation captures the avatar; later library changes never rewrite the snapshot", async () => {
    const world = await createWorld({ name: "Ember Coast", setting_brief: "b", suggested_starting_situation: "" });
    const protagonist = await createCharacter({ name: "Sable", description: "Spy of the ferries." });
    const castMember = await createCharacter({ name: "Maera", description: "Keeper of the light." });
    expect((await upload(`/api/characters/${protagonist.id}/avatar`, "image/png", PNG_BYTES)).status).toBe(200);
    expect((await upload(`/api/characters/${castMember.id}/avatar`, "image/jpeg", JPEG_BYTES)).status).toBe(200);

    const created = await json("POST", "/api/campaigns", {
      world_id: world.id,
      protagonist_id: protagonist.id,
      cast_character_ids: [castMember.id],
      starting_situation: "Sable docks at dawn.",
    });
    expect(created.status).toBe(201);
    const createdPayload: { campaign: Campaign } = await created.json();
    const campaignId = createdPayload.campaign.id;

    const campaign = await getCampaign(campaignId);
    expect(protagonistOf(campaign).avatar_id).toBe(sha256(PNG_BYTES));
    expect(campaign.characters[1]?.avatar_id).toBe(sha256(JPEG_BYTES));

    // Replacing the library avatar leaves the captured campaign untouched.
    expect((await upload(`/api/characters/${protagonist.id}/avatar`, "image/gif", GIF_BYTES)).status).toBe(200);
    const after = await getCampaign(campaignId);
    expect(protagonistOf(after).avatar_id).toBe(sha256(PNG_BYTES));
    expect((await getCharacter(protagonist.id)).avatar_id).toBe(sha256(GIF_BYTES));
  });

  test("delete clears the avatar but keeps the image bytes", async () => {
    const character = await createCharacter({ name: "Brann", description: "Harbormaster." });
    expect((await upload(`/api/characters/${character.id}/avatar`, "image/png", PNG_BYTES)).status).toBe(200);

    const response = await fetch(`${base.url}/api/characters/${character.id}/avatar`, {
      method: "DELETE",
      headers: headersWith({ origin: TRUSTED_ORIGIN }),
    });
    expect(response.status).toBe(200);
    const payload: { character: Character } = await response.json();
    expect(payload.character.avatar_id).toBeNull();
    expect((await getCharacter(character.id)).avatar_id).toBeNull();

    const image = await fetch(`${base.url}/api/images/${sha256(PNG_BYTES)}`, { headers: headersWith() });
    expect(image.status).toBe(200);
    const cleared = await fetch(`${base.url}/api/characters/${character.id}/avatar`, {
      method: "DELETE",
      headers: headersWith({ origin: TRUSTED_ORIGIN }),
    });
    expect(cleared.status).toBe(200);
    const clearedPayload: { character: Character } = await cleared.json();
    expect(clearedPayload.character.avatar_id).toBeNull();
  });
});
