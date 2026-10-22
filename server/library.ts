import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  Campaign,
  CampaignStateCategory,
  CampaignStateItem,
  CampaignStateSubjectKind,
  Character,
  CharacterSnapshot,
  Session,
  World,
  WorldCharacter,
  WorldEntry,
  WorldEntryKind,
  WorldEntrySnapshot,
} from "../shared/domain";
import { CAMPAIGN_STATE_CATEGORIES, WORLD_ENTRY_KINDS } from "../shared/domain";
import { GROUNDING_CHARACTER_LIMIT, groundingCharacterCount } from "../shared/grounding";
import { campaignFromRow, newId, nowIso, type CampaignRecord } from "./db";
import { checkpointRelationships, createCampaignLocalSubjects, forkCampaignRelationships, forkRelationships } from "./relationships";

/** Request rejected before any state changed; the message is client-safe. */
export class ValidationError extends Error {}

export class UnknownEntityError extends Error {}

const TEXT_MAX_CHARS = 100_000;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > TEXT_MAX_CHARS) {
    throw new ValidationError(`${field} must be at most ${TEXT_MAX_CHARS} characters`);
  }
  return text;
}

/** Optional but bounded: an absent suggestion stays an empty string end to end. */
function optionalText(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ValidationError(`${field} must be a string`);
  }
  const text = value.trim();
  if (text.length > TEXT_MAX_CHARS) {
    throw new ValidationError(`${field} must be at most ${TEXT_MAX_CHARS} characters`);
  }
  return text;
}

export interface WorldInput {
  name: string;
  setting_brief: string;
  suggested_starting_situation: string;
}

export function parseWorldInput(body: Record<string, unknown>): WorldInput {
  return {
    name: requiredText(body.name, "name"),
    setting_brief: requiredText(body.setting_brief, "setting_brief"),
    suggested_starting_situation: optionalText(body.suggested_starting_situation, "suggested_starting_situation"),
  };
}

/** PATCH applies only the provided fields; at least one must be present. */
export function parseWorldPatch(body: Record<string, unknown>): Partial<WorldInput> {
  const patch: Partial<WorldInput> = {};
  if (body.name !== undefined) patch.name = requiredText(body.name, "name");
  if (body.setting_brief !== undefined) patch.setting_brief = requiredText(body.setting_brief, "setting_brief");
  if (body.suggested_starting_situation !== undefined) {
    patch.suggested_starting_situation = optionalText(
      body.suggested_starting_situation,
      "suggested_starting_situation",
    );
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError(
      "at least one of name, setting_brief, suggested_starting_situation is required",
    );
  }
  return patch;
}

export interface CharacterInput {
  name: string;
  description: string;
  appearance?: string;
  personality?: string;
  background?: string;
  baseline_motivations?: string;
  speaking_style?: string;
}

const CHARACTER_OPTIONAL_FIELDS = [
  "appearance",
  "personality",
  "background",
  "baseline_motivations",
  "speaking_style",
] as const;

export function parseCharacterInput(body: Record<string, unknown>): CharacterInput {
  const input: CharacterInput = {
    name: requiredText(body.name, "name"),
    description: requiredText(body.description, "description"),
    appearance: "",
    personality: "",
    background: "",
    baseline_motivations: "",
    speaking_style: "",
  };
  for (const field of CHARACTER_OPTIONAL_FIELDS) {
    if (body[field] !== undefined) input[field] = optionalText(body[field], field);
  }
  return input;
}

/** PATCH applies only the provided fields; at least one must be present. */
export function parseCharacterPatch(body: Record<string, unknown>): Partial<CharacterInput> {
  const patch: Partial<CharacterInput> = {};
  if (body.name !== undefined) patch.name = requiredText(body.name, "name");
  if (body.description !== undefined) patch.description = requiredText(body.description, "description");
  for (const field of CHARACTER_OPTIONAL_FIELDS) {
    if (body[field] !== undefined) patch[field] = optionalText(body[field], field);
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("at least one character field is required");
  }
  return patch;
}

export function listWorlds(db: Database): World[] {
  return db.query<World, []>("SELECT * FROM worlds ORDER BY created_at, id").all();
}

export function getWorld(db: Database, id: string): World | null {
  return db.query<World, [string]>("SELECT * FROM worlds WHERE id = ?").get(id) ?? null;
}

export function createWorld(db: Database, input: WorldInput): World {
  const now = nowIso();
  const world: World = { id: newId(), ...input, created_at: now, updated_at: now };
  db.query(
    `INSERT INTO worlds (id, name, setting_brief, suggested_starting_situation, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    world.id,
    world.name,
    world.setting_brief,
    world.suggested_starting_situation,
    world.created_at,
    world.updated_at,
  );
  return world;
}

export function updateWorld(db: Database, id: string, patch: Partial<WorldInput>): World | null {
  const existing = getWorld(db, id);
  if (!existing) return null;
  const next: World = { ...existing, ...patch, updated_at: nowIso() };
  db.query(
    "UPDATE worlds SET name = ?, setting_brief = ?, suggested_starting_situation = ?, updated_at = ? WHERE id = ?",
  ).run(next.name, next.setting_brief, next.suggested_starting_situation, next.updated_at, id);
  return next;
}

export function listCharacters(db: Database): Character[] {
  return db
    .query<Character, []>(
      `SELECT c.*, ca.image_id AS avatar_id FROM characters c
       LEFT JOIN character_avatars ca ON ca.character_id = c.id
       ORDER BY c.created_at, c.id`,
    )
    .all();
}

export function getCharacter(db: Database, id: string): Character | null {
  return (
    db
      .query<Character, [string]>(
        `SELECT c.*, ca.image_id AS avatar_id FROM characters c
         LEFT JOIN character_avatars ca ON ca.character_id = c.id
         WHERE c.id = ?`,
      )
      .get(id) ?? null
  );
}

export function createCharacter(db: Database, input: CharacterInput): Character {
  const now = nowIso();
  const character: Character = {
    id: newId(),
    name: input.name,
    description: input.description,
    appearance: input.appearance ?? "",
    personality: input.personality ?? "",
    background: input.background ?? "",
    baseline_motivations: input.baseline_motivations ?? "",
    speaking_style: input.speaking_style ?? "",
    avatar_id: null,
    created_at: now,
    updated_at: now,
  };
  db.query(
    `INSERT INTO characters
       (id, name, description, appearance, personality, background, baseline_motivations,
        speaking_style, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    character.id,
    character.name,
    character.description,
    character.appearance,
    character.personality,
    character.background,
    character.baseline_motivations,
    character.speaking_style,
    character.created_at,
    character.updated_at,
  );
  return character;
}

export function updateCharacter(
  db: Database,
  id: string,
  patch: Partial<CharacterInput>,
): Character | null {
  const existing = getCharacter(db, id);
  if (!existing) return null;
  const next: Character = { ...existing, ...patch, updated_at: nowIso() };
  db.query(
    `UPDATE characters SET name = ?, description = ?, appearance = ?, personality = ?,
       background = ?, baseline_motivations = ?, speaking_style = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.name,
    next.description,
    next.appearance,
    next.personality,
    next.background,
    next.baseline_motivations,
    next.speaking_style,
    next.updated_at,
    id,
  );
  return next;
}

/** Image formats accepted for character pictures, by magic-byte detection. */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

export interface ImageRecord {
  id: string;
  mime: string;
  data: Uint8Array<ArrayBuffer>;
}

/**
 * Sniffs the image format from magic bytes; null when the bytes match none of
 * the accepted formats (including SVG, which is never accepted because it can
 * carry script).
 */
export function detectImageMime(bytes: Uint8Array): ImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && // G
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x38 && // 8
    bytes[4] === 0x37 && // 7 (GIF87a)
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    bytes[4] === 0x39 && // 9 (GIF89a)
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  return null;
}

export function getImage(db: Database, id: string): ImageRecord | null {
  return (
    db
      .query<{ id: string; mime: string; data: Uint8Array<ArrayBuffer> }, [string]>(
        "SELECT id, mime, data FROM images WHERE id = ?",
      )
      .get(id) ?? null
  );
}

/**
 * Stores the bytes content-addressed (lowercase hex sha256) and points the
 * character at them in one transaction. Identical bytes are deduplicated by
 * the primary key; the previous image row stays — there is no garbage
 * collection, because past campaigns still reference their captured snapshot.
 */
export function setCharacterAvatar(
  db: Database,
  characterId: string,
  bytes: Uint8Array,
  mime: ImageMime,
): Character | null {
  if (detectImageMime(bytes) !== mime) {
    throw new ValidationError("image data does not match its declared type");
  }
  const id = createHash("sha256").update(bytes).digest("hex");
  const now = nowIso();
  const store = db.transaction(() => {
    db.query(
      "INSERT INTO images (id, mime, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    ).run(id, mime, bytes, now);
    db.query(
      `INSERT INTO character_avatars (character_id, image_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(character_id) DO UPDATE SET image_id = excluded.image_id, updated_at = excluded.updated_at`,
    ).run(characterId, id, now);
  });
  store();
  return getCharacter(db, characterId);
}

/** Clears the character's picture; the image row itself is kept. */
export function clearCharacterAvatar(db: Database, characterId: string): Character | null {
  db.query("DELETE FROM character_avatars WHERE character_id = ?").run(characterId);
  return getCharacter(db, characterId);
}

export interface WorldCharacterInput {
  character_id: string;
  context: string;
}

export function parseWorldCharacterInput(body: Record<string, unknown>): WorldCharacterInput {
  if (typeof body.character_id !== "string" || body.character_id.length === 0) {
    throw new ValidationError("character_id must be a non-empty string");
  }
  return {
    character_id: body.character_id,
    ...(body.context !== undefined ? { context: optionalText(body.context, "context") } : { context: "" }),
  };
}

export function parseWorldCharacterPatch(body: Record<string, unknown>): Partial<WorldCharacterInput> {
  const patch: Partial<WorldCharacterInput> = {};
  if (body.context !== undefined) patch.context = optionalText(body.context, "context");
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("context is required");
  }
  return patch;
}

function worldCharacterFromRow(db: Database, row: WorldCharacterRow): WorldCharacter {
  const character = getCharacter(db, row.character_id)!;
  return { ...row, character };
}

/** Row shape before the character is joined in. */
interface WorldCharacterRow extends Omit<WorldCharacter, "character"> {}

export function listWorldCharacters(db: Database, worldId: string): WorldCharacter[] {
  return db
    .query<WorldCharacterRow, [string]>(
      "SELECT * FROM world_characters WHERE world_id = ? ORDER BY created_at, character_id",
    )
    .all(worldId)
    .map((row) => worldCharacterFromRow(db, row));
}

/** Null covers both an unknown world and an association in another world. */
function getWorldCharacterScoped(
  db: Database,
  worldId: string,
  characterId: string,
): WorldCharacterRow | null {
  return (
    db
      .query<WorldCharacterRow, [string, string]>(
        "SELECT * FROM world_characters WHERE character_id = ? AND world_id = ?",
      )
      .get(characterId, worldId) ?? null
  );
}

/**
 * Associates an existing global character with a world plus optional
 * world-specific context. The global definition is never copied here; context
 * is the only world-owned text.
 */
export function associateWorldCharacter(
  db: Database,
  worldId: string,
  input: WorldCharacterInput,
): WorldCharacter | null {
  if (!getWorld(db, worldId)) return null;
  const character = getCharacter(db, input.character_id);
  if (!character) throw new UnknownEntityError("character_id does not match an existing character");
  if (getWorldCharacterScoped(db, worldId, input.character_id)) {
    throw new ValidationError("character is already in this world's cast");
  }
  const now = nowIso();
  db.query(
    `INSERT INTO world_characters (world_id, character_id, context, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(worldId, character.id, input.context, now, now);
  return {
    world_id: worldId,
    character_id: character.id,
    context: input.context,
    created_at: now,
    updated_at: now,
    character,
  };
}

export function updateWorldCharacter(
  db: Database,
  worldId: string,
  characterId: string,
  patch: Partial<WorldCharacterInput>,
): WorldCharacter | null {
  const existing = getWorldCharacterScoped(db, worldId, characterId);
  if (!existing) return null;
  const next = { ...existing, ...patch, updated_at: nowIso() };
  db.query("UPDATE world_characters SET context = ?, updated_at = ? WHERE world_id = ? AND character_id = ?").run(
    next.context,
    next.updated_at,
    worldId,
    characterId,
  );
  return worldCharacterFromRow(db, next);
}

export function deleteWorldCharacter(db: Database, worldId: string, characterId: string): boolean {
  return (
    db
      .query("DELETE FROM world_characters WHERE character_id = ? AND world_id = ?")
      .run(characterId, worldId).changes > 0
  );
}

export interface WorldEntryInput {
  kind: WorldEntryKind;
  name: string;
  description: string;
}

function parseEntryKind(value: unknown): WorldEntryKind {
  if (typeof value !== "string") {
    throw new ValidationError(`kind must be one of: ${WORLD_ENTRY_KINDS.join(", ")}`);
  }
  const kind = value.trim() as WorldEntryKind;
  if (!WORLD_ENTRY_KINDS.includes(kind)) {
    throw new ValidationError(`kind must be one of: ${WORLD_ENTRY_KINDS.join(", ")}`);
  }
  return kind;
}

export function parseWorldEntryInput(body: Record<string, unknown>): WorldEntryInput {
  return {
    kind: parseEntryKind(body.kind),
    name: requiredText(body.name, "name"),
    description: requiredText(body.description, "description"),
  };
}

/** PATCH applies only the provided fields; at least one must be present. */
export function parseWorldEntryPatch(body: Record<string, unknown>): Partial<WorldEntryInput> {
  const patch: Partial<WorldEntryInput> = {};
  if (body.kind !== undefined) patch.kind = parseEntryKind(body.kind);
  if (body.name !== undefined) patch.name = requiredText(body.name, "name");
  if (body.description !== undefined) patch.description = requiredText(body.description, "description");
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("at least one of kind, name, description is required");
  }
  return patch;
}

export function listWorldEntries(db: Database, worldId: string): WorldEntry[] {
  return db
    .query<WorldEntry, [string]>("SELECT * FROM world_entries WHERE world_id = ? ORDER BY created_at, id")
    .all(worldId);
}

export function createWorldEntry(db: Database, worldId: string, input: WorldEntryInput): WorldEntry | null {
  if (!getWorld(db, worldId)) return null;
  const now = nowIso();
  const entry: WorldEntry = { id: newId(), world_id: worldId, ...input, created_at: now, updated_at: now };
  db.query(
    `INSERT INTO world_entries (id, world_id, kind, name, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(entry.id, entry.world_id, entry.kind, entry.name, entry.description, entry.created_at, entry.updated_at);
  return entry;
}

/** Null covers both an unknown world and an entry living in another world. */
function getWorldEntryScoped(db: Database, worldId: string, entryId: string): WorldEntry | null {
  return (
    db
      .query<WorldEntry, [string, string]>("SELECT * FROM world_entries WHERE id = ? AND world_id = ?")
      .get(entryId, worldId) ?? null
  );
}

export function updateWorldEntry(
  db: Database,
  worldId: string,
  entryId: string,
  patch: Partial<WorldEntryInput>,
): WorldEntry | null {
  const existing = getWorldEntryScoped(db, worldId, entryId);
  if (!existing) return null;
  const next: WorldEntry = { ...existing, ...patch, updated_at: nowIso() };
  db.query("UPDATE world_entries SET kind = ?, name = ?, description = ?, updated_at = ? WHERE id = ?").run(
    next.kind,
    next.name,
    next.description,
    next.updated_at,
    entryId,
  );
  return next;
}

export function deleteWorldEntry(db: Database, worldId: string, entryId: string): boolean {
  return (
    db.query("DELETE FROM world_entries WHERE id = ? AND world_id = ?").run(entryId, worldId).changes > 0
  );
}

export interface CampaignInput {
  world_id: string;
  protagonist_id: string;
  starting_situation: string;
  cast_character_ids?: string[];
  entry_ids?: string[];
  name?: string;
}

export function parseCampaignInput(body: Record<string, unknown>): CampaignInput {
  const { world_id, protagonist_id } = body;
  if (typeof world_id !== "string" || world_id.length === 0) {
    throw new ValidationError("world_id must be a non-empty string");
  }
  if (typeof protagonist_id !== "string" || protagonist_id.length === 0) {
    throw new ValidationError("protagonist_id must be a non-empty string");
  }
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length === 0)) {
    throw new ValidationError("name must be a non-empty string when provided");
  }
  let cast_character_ids: string[] | undefined;
  if (body.cast_character_ids !== undefined) {
    if (
      !Array.isArray(body.cast_character_ids) ||
      body.cast_character_ids.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      throw new ValidationError("cast_character_ids must be an array of non-empty strings");
    }
    cast_character_ids = body.cast_character_ids;
    if (new Set(cast_character_ids).size !== cast_character_ids.length) {
      throw new ValidationError("cast_character_ids must not contain duplicates");
    }
    if (cast_character_ids.includes(protagonist_id)) {
      throw new ValidationError(
        "protagonist_id must not appear in cast_character_ids; the protagonist grounds exactly once",
      );
    }
  }
  let entry_ids: string[] | undefined;
  if (body.entry_ids !== undefined) {
    if (
      !Array.isArray(body.entry_ids) ||
      body.entry_ids.some((id) => typeof id !== "string" || id.length === 0)
    ) {
      throw new ValidationError("entry_ids must be an array of non-empty strings");
    }
    entry_ids = body.entry_ids;
    if (new Set(entry_ids).size !== entry_ids.length) {
      throw new ValidationError("entry_ids must not contain duplicates");
    }
  }
  return {
    world_id,
    protagonist_id,
    starting_situation: optionalText(body.starting_situation, "starting_situation"),
    ...(cast_character_ids !== undefined ? { cast_character_ids } : {}),
    ...(entry_ids !== undefined ? { entry_ids } : {}),
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
  };
}

export interface CreatedCampaign {
  campaign: Campaign;
  session: Session;
}

/** Captures a global character definition plus the world context it carries. */
function characterSnapshot(character: Character, worldContext: string): CharacterSnapshot {
  return {
    id: character.id,
    name: character.name,
    description: character.description,
    appearance: character.appearance,
    personality: character.personality,
    background: character.background,
    baseline_motivations: character.baseline_motivations,
    speaking_style: character.speaking_style,
    world_context: worldContext,
    avatar_id: character.avatar_id,
  };
}

/** World-specific context of a character's membership in this world's cast, "" outside it. */
function worldContextFor(db: Database, worldId: string, characterId: string): string {
  const row = db
    .query<{ context: string }, [string, string]>(
      "SELECT context FROM world_characters WHERE character_id = ? AND world_id = ?",
    )
    .get(characterId, worldId);
  return row?.context ?? "";
}

/**
 * Creates the campaign, its captured snapshots — world compendium, protagonist
 * (once), and the narrator-controlled cast — and the opening session in one
 * transaction: the deferred (active_session_id, id) foreign key only needs to
 * hold at commit, so the campaign row may reference the preallocated session
 * id before the session row exists. COMMIT happens before any model call — a
 * crash mid-creation leaves no half-created campaign. Captured characters and
 * entries are copied by value; later library edits and deletes never rewrite a
 * campaign snapshot, and narration never resolves captured ids against the
 * live library. Cast picks may sit outside the world's cast; they then carry
 * no world context.
 */
export function createCampaign(db: Database, input: CampaignInput): CreatedCampaign {
  const create = db.transaction(() => {
    const world = getWorld(db, input.world_id);
    if (!world) throw new UnknownEntityError("world_id does not match an existing world");
    const protagonist = getCharacter(db, input.protagonist_id);
    if (!protagonist) {
      throw new UnknownEntityError("protagonist_id does not match an existing character");
    }

    const castIds = input.cast_character_ids ?? [];
    const castCharacters = new Map<string, Character>();
    if (castIds.length > 0) {
      const placeholders = castIds.map(() => "?").join(", ");
      for (const row of db
        .query<Character, string[]>(
          `SELECT c.*, ca.image_id AS avatar_id FROM characters c
           LEFT JOIN character_avatars ca ON ca.character_id = c.id
           WHERE c.id IN (${placeholders})`,
        )
        .all(...castIds)) {
        castCharacters.set(row.id, row);
      }
      for (const id of castIds) {
        if (!castCharacters.has(id)) {
          throw new UnknownEntityError("cast_character_ids entry does not match an existing character");
        }
      }
    }

    const captured: WorldEntrySnapshot[] = [];
    if ((input.entry_ids ?? []).length > 0) {
      const placeholders = input.entry_ids!.map(() => "?").join(", ");
      const byId = new Map<string, WorldEntry>();
      for (const row of db
        .query<WorldEntry, string[]>(`SELECT * FROM world_entries WHERE id IN (${placeholders})`)
        .all(...input.entry_ids!)) {
        byId.set(row.id, row);
      }
      for (const id of input.entry_ids!) {
        const entry = byId.get(id);
        if (!entry) throw new UnknownEntityError("entry_id does not match an existing entry");
        if (entry.world_id !== world.id) {
          throw new UnknownEntityError("entry_id belongs to a different world");
        }
        if (entry.kind === "scene") {
          throw new ValidationError(
            "scene entries cannot ground a campaign; a scene only supplies starting text",
          );
        }
        captured.push({ id: entry.id, kind: entry.kind, name: entry.name, description: entry.description });
      }
    }

    const protagonistSnapshot = characterSnapshot(protagonist, worldContextFor(db, world.id, protagonist.id));
    const cast = castIds.map((id) =>
      characterSnapshot(castCharacters.get(id)!, worldContextFor(db, world.id, id)),
    );

    // The limit binds every campaign: world, protagonist and situation alone
    // can exceed it even when no cast or entries are selected. Each character
    // contributes its authored fields exactly once.
    const total = groundingCharacterCount({
      world_name: world.name,
      world_setting_brief: world.setting_brief,
      starting_situation: input.starting_situation,
      protagonist: protagonistSnapshot,
      cast,
      entries: captured,
    });
    if (total > GROUNDING_CHARACTER_LIMIT) {
      throw new ValidationError(
        `combined grounding is ${total} characters; the limit is ${GROUNDING_CHARACTER_LIMIT}`,
      );
    }

    const now = nowIso();
    const campaignId = newId();
    const sessionId = newId();

    db.query(
      `INSERT INTO campaigns
         (id, name, world_id, protagonist_id, world_snapshot, protagonist_snapshot,
          cast_snapshot, starting_situation, active_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      campaignId,
      input.name ?? world.name,
      world.id,
      protagonist.id,
      JSON.stringify({
        name: world.name,
        setting_brief: world.setting_brief,
        suggested_starting_situation: world.suggested_starting_situation,
        entries: captured,
      }),
      JSON.stringify(protagonistSnapshot),
      JSON.stringify(cast),
      input.starting_situation,
      sessionId,
      now,
      now,
    );

    db.query(
      "INSERT INTO sessions (id, campaign_id, ordinal, title, handoff, closed_at, created_at, updated_at) VALUES (?, ?, 1, ?, NULL, NULL, ?, ?)",
    ).run(sessionId, campaignId, "Opening session", now, now);

    const campaign = campaignFromRow(
      db.query<CampaignRecord, [string]>("SELECT * FROM campaigns WHERE id = ?").get(campaignId)!,
    );
    const session = db.query<Session, [string]>("SELECT * FROM sessions WHERE id = ?").get(sessionId)!;
    return { campaign, session };
  });
  return create.immediate();
}

export function listCampaigns(db: Database): Campaign[] {
  return db
    .query<CampaignRecord, []>("SELECT * FROM campaigns ORDER BY created_at DESC, id DESC")
    .all()
    .map(campaignFromRow);
}

export function getCampaign(db: Database, id: string): Campaign | null {
  const row = db.query<CampaignRecord, [string]>("SELECT * FROM campaigns WHERE id = ?").get(id);
  return row ? campaignFromRow(row) : null;
}

export function getSession(db: Database, id: string): Session | null {
  const row = getSessionRecord(db, id);
  return row ? sessionFromRow(row) : null;
}

/** Storage shape of a session row: ordinal orders the campaign's sequence. */
export interface SessionRecord extends Session {
  ordinal: number;
}

export function sessionFromRow(row: SessionRecord): Session {
  const { ordinal: _ordinal, ...session } = row;
  return session;
}

export function getSessionRecord(db: Database, id: string): SessionRecord | null {
  return db.query<SessionRecord, [string]>("SELECT * FROM sessions WHERE id = ?").get(id) ?? null;
}

export function listCampaignSessions(db: Database, campaignId: string): Session[] {
  return db
    .query<SessionRecord, [string]>("SELECT * FROM sessions WHERE campaign_id = ? ORDER BY ordinal")
    .all(campaignId)
    .map(sessionFromRow);
}

/**
 * The incoming handoff that grounded a session's transcript: the handoff
 * written at the close of the latest completed session before it (null for a
 * campaign's opening session). For an open session this is exactly what
 * sessionGroundingHandoff returns; a closed session's own handoff is its
 * outgoing summary, never its grounding.
 */
function sessionIncomingHandoff(db: Database, session: SessionRecord): string | null {
  const previous = db
    .query<{ handoff: string | null }, [string, number]>(
      `SELECT handoff FROM sessions
       WHERE campaign_id = ? AND closed_at IS NOT NULL AND ordinal < ?
       ORDER BY ordinal DESC LIMIT 1`,
    )
    .get(session.campaign_id, session.ordinal);
  return previous?.handoff ?? null;
}

/**
 * The handoff that grounds this session: an inherited fork handoff, or the
 * handoff written at the close of the latest completed session before it
 * (null for a campaign's opening session).
 */
export function sessionGroundingHandoff(db: Database, campaignId: string, sessionId: string): string | null {
  const session = getSessionRecord(db, sessionId);
  if (!session || session.campaign_id !== campaignId) return null;
  if (session.handoff !== null) return session.handoff;
  return sessionIncomingHandoff(db, session);
}

export class SessionClosedError extends Error {}

export class SessionNotClosedError extends Error {}

export interface SessionCreateInput {
  title: string;
  handoff: string;
}

export function parseSessionCreateInput(body: Record<string, unknown>): SessionCreateInput {
  return {
    title: requiredText(body.title, "title"),
    handoff: requiredText(body.handoff, "handoff"),
  };
}

export interface BeginNextSessionResult {
  closed: Session;
  session: Session;
}

/**
 * Closes the campaign's open session with the reviewed handoff, checkpoints
 * the campaign's current state at that boundary, and opens the next session —
 * one transaction, so active_session_id moves atomically and a closed session
 * is immutable thereafter. Refuses nothing here about pending runs: the route
 * guards that synchronously before calling, and this transaction never awaits.
 */
export function beginNextSession(
  db: Database,
  campaignId: string,
  input: SessionCreateInput,
): BeginNextSessionResult | null {
  const begin = db.transaction(
    (id: string, title: string, handoff: string): BeginNextSessionResult | null => {
      const campaign = getCampaign(db, id);
      if (!campaign) return null;
      const active = getSessionRecord(db, campaign.active_session_id);
      if (!active || active.closed_at !== null) {
        throw new ValidationError("campaign has no open session to close");
      }

      const now = nowIso();
      const closed: Session = { ...sessionFromRow(active), handoff, closed_at: now, updated_at: now };
      db.query("UPDATE sessions SET handoff = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(
        handoff,
        now,
        now,
        active.id,
      );

      // Checkpoint copies the campaign state by value at this boundary, keyed
      // to the closed session; later campaign edits never rewrite it.
      const checkpointItems = listCampaignState(db, id);
      for (const item of checkpointItems) {
        db.query(
          `INSERT INTO session_state_checkpoints
             (id, session_id, campaign_id, category, subject, subject_kind, subject_id, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          newId(),
          active.id,
          id,
          item.category,
          item.subject,
          item.subject_kind,
          item.subject_id,
          item.content,
          item.created_at,
        );
      }
      checkpointRelationships(db, id, active.id);

      const sessionId = newId();
      db.query(
        `INSERT INTO sessions
           (id, campaign_id, ordinal, title, handoff, closed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
      ).run(sessionId, id, active.ordinal + 1, title, now, now);
      db.query("UPDATE campaigns SET active_session_id = ?, updated_at = ? WHERE id = ?").run(
        sessionId,
        now,
        id,
      );

      return {
        closed,
        session: sessionFromRow(getSessionRecord(db, sessionId)!),
      };
    },
  );
  return begin.immediate(campaignId, input.title, input.handoff);
}

export interface ForkInput {
  name: string;
}

export function parseForkInput(body: Record<string, unknown>): ForkInput {
  return { name: requiredText(body.name, "name") };
}

export interface CreatedFork {
  campaign: Campaign;
  session: Session;
}

/**
 * Inserts the fork's campaign row: captured snapshots and starting situation
 * copied by value from the origin, origin ids recorded for provenance. Returns
 * the new campaign id; the origin is never re-resolved afterwards.
 */
function insertForkCampaign(
  db: Database,
  origin: Campaign,
  name: string,
  sourceSessionId: string,
  forkSessionId: string,
  now: string,
): string {
  const campaignId = newId();
  db.query(
    `INSERT INTO campaigns
       (id, name, world_id, protagonist_id, world_snapshot, protagonist_snapshot,
        cast_snapshot, starting_situation, active_session_id,
        forked_from_campaign_id, forked_from_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    campaignId,
    name,
    origin.world_id,
    origin.protagonist_id,
    JSON.stringify(origin.world_snapshot),
    JSON.stringify(origin.protagonist_snapshot),
    JSON.stringify(origin.cast),
    origin.starting_situation,
    forkSessionId,
    origin.id,
    sourceSessionId,
    now,
    now,
  );
  return campaignId;
}

/** Inserts the fork's opening session, grounded by `handoff` (null = none). */
function insertForkSession(
  db: Database,
  campaignId: string,
  sessionId: string,
  source: SessionRecord,
  handoff: string | null,
  now: string,
): void {
  db.query(
    `INSERT INTO sessions
       (id, campaign_id, ordinal, title, handoff, closed_at, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, NULL, ?, ?)`,
  ).run(sessionId, campaignId, source.title, handoff, now, now);
}

/** Copies state rows by value under new ids; `now` stamps the copies. */
function copyStateItems(
  db: Database,
  campaignId: string,
  items: Array<{
    category: string;
    subject: string;
    subject_kind: string | null;
    subject_id: string | null;
    content: string;
    created_at: string;
  }>,
  now: string,
): void {
  for (const item of items) {
    db.query(
      `INSERT INTO campaign_state_items
         (id, campaign_id, category, subject, subject_kind, subject_id, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      campaignId,
      item.category,
      item.subject,
      item.subject_kind,
      item.subject_id,
      item.content,
      item.created_at,
      now,
    );
  }
}

/**
 * Forks a completed session's boundary into a new independent campaign: the
 * captured world/protagonist/cast snapshots and starting situation are copied
 * by value, the closed session's state checkpoint becomes the new campaign's
 * state, and its handoff grounds the new opening session.
 */
export function forkCampaignFromSession(
  db: Database,
  sessionId: string,
  input: ForkInput,
): CreatedFork | null {
  const fork = db.transaction((id: string, name: string): CreatedFork | null => {
    const source = getSessionRecord(db, id);
    if (!source) return null;
    if (source.closed_at === null) throw new SessionNotClosedError("only completed sessions can fork");
    const origin = getCampaign(db, source.campaign_id);
    if (!origin) return null;

    const now = nowIso();
    const forkSessionId = newId();
    const campaignId = insertForkCampaign(db, origin, name, source.id, forkSessionId, now);
    insertForkSession(db, campaignId, forkSessionId, source, source.handoff ?? "", now);

    const copiedSubjectIds = createCampaignLocalSubjects(db, source.id, campaignId);
    forkRelationships(db, source.id, campaignId, copiedSubjectIds);
    const checkpoint = db
      .query<
        {
          category: string;
          subject: string;
          subject_kind: string | null;
          subject_id: string | null;
          content: string;
          created_at: string;
        },
        [string]
      >(
        "SELECT category, subject, subject_kind, subject_id, content, created_at FROM session_state_checkpoints WHERE session_id = ? ORDER BY created_at, id",
      )
      .all(source.id);
    copyStateItems(db, campaignId, checkpoint, now);

    return {
      campaign: getCampaign(db, campaignId)!,
      session: sessionFromRow(getSessionRecord(db, forkSessionId)!),
    };
  });
  return fork.immediate(sessionId, input.name);
}

/**
 * Forks from a message in the open or a completed session into a new
 * independent campaign: the captured snapshots and starting situation are
 * copied by value exactly like a boundary fork, the campaign's CURRENT state
 * notes, relationships, and event history become the fork's own under new ids,
 * the handoff that grounded the source session grounds the fork's first
 * session, and the transcript is the selected rows up to and including the
 * chosen message — drafts and unselected alternates excluded — renumbered
 * from 1 with their timestamps kept. Null when the session or the message does
 * not exist (message ids are session-scoped).
 */
export function forkCampaignFromMessage(
  db: Database,
  sessionId: string,
  messageId: string,
  input: ForkInput,
): CreatedFork | null {
  const fork = db.transaction(
    (id: string, mid: string, name: string): CreatedFork | null => {
      const source = getSessionRecord(db, id);
      if (!source) return null;
      const origin = getCampaign(db, source.campaign_id);
      if (!origin) return null;
      const message = db
        .query<{ position: number }, [string, string]>(
          "SELECT position FROM messages WHERE id = ? AND session_id = ?",
        )
        .get(mid, id);
      if (!message) return null;

      const now = nowIso();
      const forkSessionId = newId();
      const campaignId = insertForkCampaign(db, origin, name, source.id, forkSessionId, now);
      insertForkSession(db, campaignId, forkSessionId, source, sessionIncomingHandoff(db, source), now);

      copyStateItems(db, campaignId, listCampaignState(db, source.campaign_id), now);
      forkCampaignRelationships(db, source.campaign_id, campaignId);

      const history = db
        .query<
          {
            role: string;
            speaker_name: string;
            content: string;
            status: string;
            created_at: string;
            updated_at: string;
          },
          [string, number]
        >(
          `SELECT role, speaker_name, content, status, created_at, updated_at FROM messages
           WHERE session_id = ? AND selected = 1 AND position <= ?
             AND (role = 'user' OR status = 'complete')
           ORDER BY position`,
        )
        .all(id, message.position);
      history.forEach((row, index) => {
        db.query(
          `INSERT INTO messages
             (id, session_id, position, role, speaker_name, content, status, selected, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(
          newId(),
          forkSessionId,
          index + 1,
          row.role,
          row.speaker_name,
          row.content,
          row.status,
          row.created_at,
          row.updated_at,
        );
      });

      return {
        campaign: getCampaign(db, campaignId)!,
        session: sessionFromRow(getSessionRecord(db, forkSessionId)!),
      };
    },
  );
  return fork.immediate(sessionId, messageId, input.name);
}

export function listCampaignState(db: Database, campaignId: string): CampaignStateItem[] {
  return db
    .query<CampaignStateItem, [string]>(
      "SELECT * FROM campaign_state_items WHERE campaign_id = ? ORDER BY created_at, id",
    )
    .all(campaignId);
}

export interface CampaignStateInput {
  category: CampaignStateCategory;
  subject: string;
  subject_kind: CampaignStateSubjectKind | null;
  subject_id: string | null;
  content: string;
}

function parseStateCategory(value: unknown): CampaignStateCategory {
  if (typeof value !== "string" || !CAMPAIGN_STATE_CATEGORIES.includes(value as CampaignStateCategory)) {
    throw new ValidationError(`category must be one of: ${CAMPAIGN_STATE_CATEGORIES.join(", ")}`);
  }
  return value as CampaignStateCategory;
}

function parseSubjectKind(value: unknown): CampaignStateSubjectKind | null {
  if (value === undefined || value === null) return null;
  if (value === "character" || value === "entry") return value;
  throw new ValidationError("subject_kind must be 'character' or 'entry' or null");
}

function parseSubjectId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError("subject_id must be a non-empty string when provided");
  }
  return value;
}

/**
 * A subject may be a free-text label (both fields null) or refer to a captured
 * snapshot of this campaign: kind 'character' resolves against the captured
 * protagonist and cast ids, 'entry' against the captured compendium entries.
 * The live library is never consulted, so the reference survives library edits
 * and deletes exactly like every other captured grounding.
 */
function validateSubjectRef(
  campaign: Campaign,
  subject: { subject_kind: CampaignStateSubjectKind | null; subject_id: string | null },
): void {
  if (subject.subject_kind === null || subject.subject_id === null) {
    if (subject.subject_kind !== null || subject.subject_id !== null) {
      throw new ValidationError("subject_kind and subject_id must be set together");
    }
    return;
  }
  const captured =
    subject.subject_kind === "character"
      ? [campaign.protagonist_snapshot.id, ...campaign.cast.map((member) => member.id)]
      : campaign.world_snapshot.entries.map((entry) => entry.id);
  if (!captured.includes(subject.subject_id)) {
    throw new ValidationError(
      `subject_id does not match a captured ${subject.subject_kind} of this campaign`,
    );
  }
}

/**
 * Aggregate cap on the campaign state injected into the narrator prompt,
 * mirroring RELATIONSHIP_GROUNDING_LIMIT: characters, not tokens — this bounds
 * authored input size and is not a model context-window guarantee. Counted as
 * summed subject + content length across the campaign's items; those are the
 * two fields the prompt renders verbatim per item
 * (`- category — subject: content`), while the category and per-item
 * separators are fixed and add nothing the cap needs to bound.
 */
export const CAMPAIGN_STATE_GROUNDING_LIMIT = 16_000;

function assertCampaignStateCapacity(
  db: Database,
  campaignId: string,
  next: { subject: string; content: string },
  replacingSize = 0,
): void {
  const totals = db
    .query<{ total: number }, [string]>(
      "SELECT COALESCE(SUM(length(subject) + length(content)), 0) AS total FROM campaign_state_items WHERE campaign_id = ?",
    )
    .get(campaignId)!;
  const nextLength = next.subject.length + next.content.length;
  // Only writes that grow the total are capped: a campaign seeded before the
  // cap existed can sit above it, and shrinking (or total-neutral) edits must
  // stay possible so it can be worked back under.
  if (nextLength > replacingSize && totals.total - replacingSize + nextLength > CAMPAIGN_STATE_GROUNDING_LIMIT) {
    throw new ValidationError(
      `campaign state exceeds ${CAMPAIGN_STATE_GROUNDING_LIMIT} characters of subject+content; shorten or delete existing items first`,
    );
  }
}

export function parseCampaignStateInput(body: Record<string, unknown>): CampaignStateInput {
  return {
    category: parseStateCategory(body.category),
    subject: requiredText(body.subject, "subject"),
    subject_kind: parseSubjectKind(body.subject_kind),
    subject_id: parseSubjectId(body.subject_id),
    content: requiredText(body.content, "content"),
  };
}

/** PATCH applies only the provided fields; at least one must be present. */
export function parseCampaignStatePatch(body: Record<string, unknown>): Partial<CampaignStateInput> {
  const patch: Partial<CampaignStateInput> = {};
  if (body.category !== undefined) patch.category = parseStateCategory(body.category);
  if (body.subject !== undefined) patch.subject = requiredText(body.subject, "subject");
  if (body.subject_kind !== undefined) patch.subject_kind = parseSubjectKind(body.subject_kind);
  if (body.subject_id !== undefined) patch.subject_id = parseSubjectId(body.subject_id);
  if (body.content !== undefined) patch.content = requiredText(body.content, "content");
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("at least one of category, subject, subject_kind, subject_id, content is required");
  }
  return patch;
}

export function createCampaignStateItem(
  db: Database,
  campaignId: string,
  input: CampaignStateInput,
): CampaignStateItem | null {
  const campaign = getCampaign(db, campaignId);
  if (!campaign) return null;
  validateSubjectRef(campaign, input);
  assertCampaignStateCapacity(db, campaignId, input);
  const now = nowIso();
  const item: CampaignStateItem = {
    id: newId(),
    campaign_id: campaignId,
    ...input,
    created_at: now,
    updated_at: now,
  };
  db.query(
    `INSERT INTO campaign_state_items
       (id, campaign_id, category, subject, subject_kind, subject_id, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    campaignId,
    item.category,
    item.subject,
    item.subject_kind,
    item.subject_id,
    item.content,
    item.created_at,
    item.updated_at,
  );
  return item;
}

export function updateCampaignStateItem(
  db: Database,
  campaignId: string,
  itemId: string,
  patch: Partial<CampaignStateInput>,
): CampaignStateItem | null {
  const campaign = getCampaign(db, campaignId);
  if (!campaign) return null;
  // Null covers both an unknown campaign and an item from another campaign.
  const existing =
    db
      .query<CampaignStateItem, [string, string]>(
        "SELECT * FROM campaign_state_items WHERE id = ? AND campaign_id = ?",
      )
      .get(itemId, campaignId) ?? null;
  if (!existing) return null;
  const next: CampaignStateItem = { ...existing, ...patch, updated_at: nowIso() };
  validateSubjectRef(campaign, next);
  assertCampaignStateCapacity(db, campaignId, next, existing.subject.length + existing.content.length);
  db.query(
    "UPDATE campaign_state_items SET category = ?, subject = ?, subject_kind = ?, subject_id = ?, content = ?, updated_at = ? WHERE id = ?",
  ).run(
    next.category,
    next.subject,
    next.subject_kind,
    next.subject_id,
    next.content,
    next.updated_at,
    itemId,
  );
  return next;
}

export function deleteCampaignStateItem(db: Database, campaignId: string, itemId: string): boolean {
  return (
    db
      .query("DELETE FROM campaign_state_items WHERE id = ? AND campaign_id = ?")
      .run(itemId, campaignId).changes > 0
  );
}
