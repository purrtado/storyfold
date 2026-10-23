import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  Campaign,
  CampaignStateCategory,
  CampaignStateItem,
  Character,
  CharacterSnapshot,
  RelationshipDocument,
  Session,
  World,
  WorldCharacter,
  WorldEntry,
  WorldEntryKind,
  WorldEntrySnapshot,
} from "../shared/domain";
import { CAMPAIGN_STATE_CATEGORIES, WORLD_ENTRY_KINDS } from "../shared/domain";
import { NARRATION_CHARACTER_BUDGET, narratorSystemPrompt } from "../shared/narration";
import { campaignFromRow, newId, nowIso, type CampaignRecord } from "./db";

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
  return {
    world_id,
    protagonist_id,
    starting_situation: optionalText(body.starting_situation, "starting_situation"),
    ...(cast_character_ids !== undefined ? { cast_character_ids } : {}),
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
 * Creates the campaign, its captured snapshots — every non-scene world entry,
 * the protagonist (once), and the narrator-controlled cast — and the opening
 * session in one transaction: the deferred (active_session_id, id) foreign
 * key only needs to hold at commit, so the campaign row may reference the
 * preallocated session id before the session row exists. COMMIT happens
 * before any model call. Captured characters and entries are copied by value;
 * later library edits and deletes never rewrite a campaign snapshot. Cast
 * picks may sit outside the world's cast; they then carry no world context.
 * Refused when the opening prompt alone exceeds the narration budget.
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

    const captured: WorldEntrySnapshot[] = listWorldEntries(db, world.id)
      .filter((entry) => entry.kind !== "scene")
      .map((entry) => ({ id: entry.id, kind: entry.kind, name: entry.name, description: entry.description }));
    const protagonistSnapshot = characterSnapshot(protagonist, worldContextFor(db, world.id, protagonist.id));
    const cast = castIds.map((id) =>
      characterSnapshot(castCharacters.get(id)!, worldContextFor(db, world.id, id)),
    );

    const opening = narratorSystemPrompt({
      world: { name: world.name, setting_brief: world.setting_brief, entries: captured },
      starting_situation: input.starting_situation,
      protagonist: protagonistSnapshot,
      cast,
      notes: [],
      relationships: [],
      handoff: null,
      has_history: false,
    });
    if (opening.length > NARRATION_CHARACTER_BUDGET) {
      throw new ValidationError(
        `the opening prompt is ${opening.length} characters; the budget is ${NARRATION_CHARACTER_BUDGET}`,
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
 * The handoff written at the close of the latest completed session before
 * this one (null for a campaign's opening session). A closed session's own
 * handoff is its outgoing summary, never its grounding; an open fork
 * session's inherited grounding lives in session.handoff and is resolved by
 * sessionGroundingHandoff instead.
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
 * A campaign's changeable state as one JSON value: what a session checkpoint
 * stores and what a fork restores. Captured snapshots are not part of it —
 * they never change after creation.
 */
interface CampaignStateSnapshot {
  notes: Array<Pick<CampaignStateItem, "category" | "subject" | "content" | "created_at">>;
  relationship_subjects: Array<{ id: string; name: string; created_at: string }>;
  relationships: Array<{ source_id: string; target_id: string; document: RelationshipDocument; created_at: string }>;
}

function serializeCampaignState(db: Database, campaignId: string): CampaignStateSnapshot {
  return {
    notes: db
      .query<CampaignStateSnapshot["notes"][number], [string]>(
        "SELECT category, subject, content, created_at FROM campaign_state_items WHERE campaign_id = ? ORDER BY created_at, id",
      )
      .all(campaignId),
    relationship_subjects: db
      .query<CampaignStateSnapshot["relationship_subjects"][number], [string]>(
        "SELECT id, name, created_at FROM relationship_subjects WHERE campaign_id = ? ORDER BY created_at, id",
      )
      .all(campaignId),
    relationships: db
      .query<{ source_id: string; target_id: string; document: string; created_at: string }, [string]>(
        "SELECT source_id, target_id, document, created_at FROM relationships WHERE campaign_id = ? ORDER BY created_at, id",
      )
      .all(campaignId)
      .map((row) => ({ ...row, document: JSON.parse(row.document) as RelationshipDocument })),
  };
}

/** Writes a snapshot into another campaign under new ids; `now` stamps the copies. */
function restoreCampaignState(db: Database, campaignId: string, state: CampaignStateSnapshot, now: string): void {
  for (const note of state.notes) {
    db.query(
      `INSERT INTO campaign_state_items (id, campaign_id, category, subject, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), campaignId, note.category, note.subject, note.content, note.created_at, now);
  }
  const subjectIds = new Map<string, string>();
  for (const subject of state.relationship_subjects) {
    const id = newId();
    subjectIds.set(subject.id, id);
    db.query("INSERT INTO relationship_subjects (id, campaign_id, name, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      campaignId,
      subject.name,
      subject.created_at,
    );
  }
  for (const relationship of state.relationships) {
    db.query(
      `INSERT INTO relationships (id, campaign_id, source_id, target_id, document, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      campaignId,
      subjectIds.get(relationship.source_id) ?? relationship.source_id,
      subjectIds.get(relationship.target_id) ?? relationship.target_id,
      JSON.stringify(relationship.document),
      relationship.created_at,
      now,
    );
  }
}

/**
 * Closes the campaign's open session with the reviewed handoff, stores one
 * JSON checkpoint of the campaign's state at that boundary, and opens the next
 * session — one transaction, so active_session_id moves atomically and a
 * closed session is immutable thereafter. Refuses nothing here about pending
 * runs: the route guards that synchronously before calling, and this
 * transaction never awaits.
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
      db.query("INSERT INTO session_checkpoints (session_id, campaign_id, state, created_at) VALUES (?, ?, ?, ?)").run(
        active.id,
        id,
        JSON.stringify(serializeCampaignState(db, id)),
        now,
      );

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

/**
 * "Fork from here": forks from a message in the open or a closed session into
 * a new independent campaign. Captured snapshots and the starting situation
 * are copied by value; the campaign state comes from the closed session's
 * checkpoint, or from the campaign's current state for the open session, and
 * is restored under new ids. The handoff that grounded the source session
 * grounds the fork's first session, and the transcript is the selected rows
 * up to and including the chosen message — drafts and unselected alternates
 * excluded — renumbered from 1 with their timestamps kept. Null when the
 * session or the message does not exist (message ids are session-scoped).
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
          `SELECT position FROM messages
           WHERE id = ? AND session_id = ? AND selected = 1 AND (role = 'user' OR status = 'complete')`,
        )
        .get(mid, id);
      if (!message) return null;

      const now = nowIso();
      const forkSessionId = newId();
      const campaignId = insertForkCampaign(db, origin, name, source.id, forkSessionId, now);
      insertForkSession(
        db,
        campaignId,
        forkSessionId,
        source,
        source.closed_at === null
          ? sessionGroundingHandoff(db, source.campaign_id, source.id)
          : sessionIncomingHandoff(db, source),
        now,
      );
      const state =
        source.closed_at === null
          ? serializeCampaignState(db, source.campaign_id)
          : (JSON.parse(
              db
                .query<{ state: string }, [string]>("SELECT state FROM session_checkpoints WHERE session_id = ?")
                .get(source.id)!.state,
            ) as CampaignStateSnapshot);
      restoreCampaignState(db, campaignId, state, now);

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
  content: string;
}

function parseStateCategory(value: unknown): CampaignStateCategory {
  if (typeof value !== "string" || !CAMPAIGN_STATE_CATEGORIES.includes(value as CampaignStateCategory)) {
    throw new ValidationError(`category must be one of: ${CAMPAIGN_STATE_CATEGORIES.join(", ")}`);
  }
  return value as CampaignStateCategory;
}

export function parseCampaignStateInput(body: Record<string, unknown>): CampaignStateInput {
  return {
    category: parseStateCategory(body.category),
    subject: requiredText(body.subject, "subject"),
    content: requiredText(body.content, "content"),
  };
}

/** PATCH applies only the provided fields; at least one must be present. */
export function parseCampaignStatePatch(body: Record<string, unknown>): Partial<CampaignStateInput> {
  const patch: Partial<CampaignStateInput> = {};
  if (body.category !== undefined) patch.category = parseStateCategory(body.category);
  if (body.subject !== undefined) patch.subject = requiredText(body.subject, "subject");
  if (body.content !== undefined) patch.content = requiredText(body.content, "content");
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("at least one of category, subject, content is required");
  }
  return patch;
}

export function createCampaignStateItem(
  db: Database,
  campaignId: string,
  input: CampaignStateInput,
): CampaignStateItem | null {
  if (!getCampaign(db, campaignId)) return null;
  const now = nowIso();
  const item: CampaignStateItem = {
    id: newId(),
    campaign_id: campaignId,
    ...input,
    created_at: now,
    updated_at: now,
  };
  db.query(
    `INSERT INTO campaign_state_items (id, campaign_id, category, subject, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(item.id, campaignId, item.category, item.subject, item.content, item.created_at, item.updated_at);
  return item;
}

export function updateCampaignStateItem(
  db: Database,
  campaignId: string,
  itemId: string,
  patch: Partial<CampaignStateInput>,
): CampaignStateItem | null {
  // Null covers both an unknown campaign and an item from another campaign.
  const existing =
    db
      .query<CampaignStateItem, [string, string]>(
        "SELECT * FROM campaign_state_items WHERE id = ? AND campaign_id = ?",
      )
      .get(itemId, campaignId) ?? null;
  if (!existing) return null;
  const next: CampaignStateItem = { ...existing, ...patch, updated_at: nowIso() };
  db.query(
    "UPDATE campaign_state_items SET category = ?, subject = ?, content = ?, updated_at = ? WHERE id = ?",
  ).run(next.category, next.subject, next.content, next.updated_at, itemId);
  return next;
}

export function deleteCampaignStateItem(db: Database, campaignId: string, itemId: string): boolean {
  return (
    db
      .query("DELETE FROM campaign_state_items WHERE id = ? AND campaign_id = ?")
      .run(itemId, campaignId).changes > 0
  );
}
