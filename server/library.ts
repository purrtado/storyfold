import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  Campaign,
  CampaignCharacter,
  CampaignCharacterRole,
  CampaignStat,
  CampaignStateCategory,
  CampaignStateItem,
  Character,
  CharacterProfile,
  Relationship,
  Session,
  StatColor,
  StatDefinition,
  StatFields,
  StatKind,
  StatValues,
  World,
  WorldEntry,
  WorldEntryKind,
  WorldEntrySnapshot,
} from "../shared/domain";
import {
  CAMPAIGN_STATE_CATEGORIES,
  CHARACTER_PROFILE_FIELDS,
  STAT_COLORS,
  STAT_KINDS,
  WORLD_ENTRY_KINDS,
  protagonistOf,
} from "../shared/domain";
import { NARRATION_CHARACTER_BUDGET, narratorSystemPrompt } from "../shared/narration";
import { campaignFromRow, hasAnyMessage, newId, nowIso, type CampaignRecord } from "./db";

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

export type CharacterInput = CharacterProfile;

/** Every profile field: required ones must be non-empty, the rest default to "". */
export function parseCharacterInput(body: Record<string, unknown>): CharacterInput {
  const input = {} as CharacterInput;
  for (const field of CHARACTER_PROFILE_FIELDS) {
    input[field.key] = field.required
      ? requiredText(body[field.key], field.key)
      : body[field.key] === undefined
        ? ""
        : optionalText(body[field.key], field.key);
  }
  return input;
}

/** PATCH applies only the provided fields; at least one must be present. */
export function parseCharacterPatch(body: Record<string, unknown>): Partial<CharacterInput> {
  const patch: Partial<CharacterInput> = {};
  for (const field of CHARACTER_PROFILE_FIELDS) {
    if (body[field.key] === undefined) continue;
    patch[field.key] = field.required
      ? requiredText(body[field.key], field.key)
      : optionalText(body[field.key], field.key);
  }
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("at least one character field is required");
  }
  return patch;
}

const PROFILE_COLUMNS = CHARACTER_PROFILE_FIELDS.map((field) => field.key);

function profileOf(source: CharacterProfile): CharacterProfile {
  return Object.fromEntries(PROFILE_COLUMNS.map((key) => [key, source[key]])) as CharacterProfile;
}

function profileValues(source: CharacterProfile): string[] {
  return PROFILE_COLUMNS.map((key) => source[key]);
}

export function listWorlds(db: Database): World[] {
  return db.query<World, []>("SELECT * FROM worlds ORDER BY created_at, id").all();
}

export function getWorld(db: Database, id: string): World | null {
  return db.query<World, [string]>("SELECT * FROM worlds WHERE id = ?").get(id) ?? null;
}

/** Creates the world and copies the chosen bank stats into it — the only time importing is offered. */
export function createWorld(db: Database, input: WorldInput, bankStatIds: string[] = []): World {
  const now = nowIso();
  const world: World = { id: newId(), ...input, created_at: now, updated_at: now };
  const create = db.transaction(() => {
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
    for (const stat of bankStats(db, bankStatIds)) createStatDefinition(db, world.id, stat);
  });
  create();
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

const STAT_TEXT_MAX = 500;
const STAT_RANGE_LIMIT = 1_000;
/** Per kind, per bank, world, or campaign. */
export const STAT_COUNT_LIMIT = 12;
const STAT_COLUMNS = [
  "applies_to",
  "label",
  "description",
  "low_label",
  "high_label",
  "min",
  "max",
  "default_value",
  "color",
] as const;

function statText(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (text.length > STAT_TEXT_MAX) throw new ValidationError(`${field} must be at most ${STAT_TEXT_MAX} characters`);
  return text;
}

function statInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Math.abs(value as number) > STAT_RANGE_LIMIT) {
    throw new ValidationError(`${field} must be an integer between -${STAT_RANGE_LIMIT} and ${STAT_RANGE_LIMIT}`);
  }
  return value as number;
}

function statColor(value: unknown): StatColor {
  if (!STAT_COLORS.includes(value as StatColor)) {
    throw new ValidationError(`color must be one of: ${STAT_COLORS.join(", ")}`);
  }
  return value as StatColor;
}

export type StatPatch = Partial<Omit<StatFields, "applies_to">>;

/** PATCH applies only the provided fields; `applies_to` never changes after creation. */
export function parseStatPatch(body: Record<string, unknown>): StatPatch {
  if (body.applies_to !== undefined) throw new ValidationError("applies_to cannot change");
  const patch: StatPatch = {};
  for (const field of ["label", "description", "low_label", "high_label"] as const) {
    if (body[field] !== undefined) patch[field] = statText(body[field], field);
  }
  for (const field of ["min", "max", "default_value"] as const) {
    if (body[field] !== undefined) patch[field] = statInteger(body[field], field);
  }
  if (body.color !== undefined) patch.color = statColor(body.color);
  if (Object.keys(patch).length === 0) throw new ValidationError("at least one stat field is required");
  return patch;
}

export function parseStatInput(body: Record<string, unknown>): StatFields {
  if (!STAT_KINDS.includes(body.applies_to as StatKind)) {
    throw new ValidationError(`applies_to must be one of: ${STAT_KINDS.join(", ")}`);
  }
  return checkedStat({
    applies_to: body.applies_to as StatKind,
    label: statText(body.label, "label"),
    description: statText(body.description, "description"),
    low_label: statText(body.low_label, "low_label"),
    high_label: statText(body.high_label, "high_label"),
    min: statInteger(body.min, "min"),
    max: statInteger(body.max, "max"),
    default_value: statInteger(body.default_value, "default_value"),
    color: statColor(body.color),
  });
}

function checkedStat<T extends StatFields>(stat: T): T {
  if (stat.min >= stat.max) throw new ValidationError("min must be less than max");
  if (stat.default_value < stat.min || stat.default_value > stat.max) {
    throw new ValidationError("default_value must be between min and max");
  }
  return stat;
}

/** A stat label is unique per kind within its scope, and each kind holds at most STAT_COUNT_LIMIT stats. */
function assertStatSlot(
  db: Database,
  table: "stat_definitions" | "campaign_stats",
  scope: { column: "world_id" | "campaign_id"; id: string | null },
  stat: Pick<StatFields, "applies_to" | "label">,
  excludeId: string | null,
): void {
  const siblings = db
    .query<{ id: string; label: string }, [string | null, string]>(
      `SELECT id, label FROM ${table} WHERE ${scope.column} IS ? AND applies_to = ?`,
    )
    .all(scope.id, stat.applies_to)
    .filter((sibling) => sibling.id !== excludeId);
  if (siblings.some((sibling) => sibling.label.toLowerCase() === stat.label.toLowerCase())) {
    throw new ValidationError(`a ${stat.applies_to} stat named "${stat.label}" already exists`);
  }
  if (excludeId === null && siblings.length >= STAT_COUNT_LIMIT) {
    throw new ValidationError(`at most ${STAT_COUNT_LIMIT} ${stat.applies_to} stats are allowed`);
  }
}

/** The bank when `worldId` is null, otherwise that world's stats. */
export function listStatDefinitions(db: Database, worldId: string | null): StatDefinition[] {
  return db
    .query<StatDefinition, [string | null]>(
      "SELECT * FROM stat_definitions WHERE world_id IS ? ORDER BY applies_to = 'relationship', created_at, rowid",
    )
    .all(worldId);
}

export function getStatDefinition(db: Database, id: string): StatDefinition | null {
  return db.query<StatDefinition, [string]>("SELECT * FROM stat_definitions WHERE id = ?").get(id) ?? null;
}

export function createStatDefinition(db: Database, worldId: string | null, input: StatFields): StatDefinition {
  assertStatSlot(db, "stat_definitions", { column: "world_id", id: worldId }, input, null);
  const now = nowIso();
  const stat: StatDefinition = { id: newId(), world_id: worldId, ...pickStat(input), created_at: now, updated_at: now };
  db.query(
    `INSERT INTO stat_definitions (id, world_id, ${STAT_COLUMNS.join(", ")}, created_at, updated_at)
     VALUES (?, ?, ${STAT_COLUMNS.map(() => "?").join(", ")}, ?, ?)`,
  ).run(stat.id, worldId, ...STAT_COLUMNS.map((key) => stat[key]), now, now);
  return stat;
}

export function updateStatDefinition(db: Database, id: string, patch: StatPatch): StatDefinition | null {
  const existing = getStatDefinition(db, id);
  if (!existing) return null;
  const next = checkedStat({ ...existing, ...patch, updated_at: nowIso() });
  assertStatSlot(db, "stat_definitions", { column: "world_id", id: existing.world_id }, next, id);
  db.query(
    `UPDATE stat_definitions SET ${STAT_COLUMNS.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
  ).run(...STAT_COLUMNS.map((key) => next[key]), next.updated_at, id);
  return next;
}

export function deleteStatDefinition(db: Database, id: string): boolean {
  return db.query("DELETE FROM stat_definitions WHERE id = ?").run(id).changes > 0;
}

function pickStat(source: StatFields): StatFields {
  return Object.fromEntries(STAT_COLUMNS.map((key) => [key, source[key]])) as unknown as StatFields;
}

/** Bank stats by id, in the given order; anything else is unknown. */
function bankStats(db: Database, ids: string[]): StatDefinition[] {
  return ids.map((id) => {
    const stat = getStatDefinition(db, id);
    if (!stat || stat.world_id !== null) throw new UnknownEntityError("stat_ids entry does not match a bank stat");
    return stat;
  });
}

/** An optional list of distinct non-empty ids; absent means none. */
export function parseIdList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new ValidationError(`${field} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) throw new ValidationError(`${field} must not contain duplicates`);
  return value;
}

const CHARACTER_SELECT = `SELECT c.*, ca.image_id AS avatar_id FROM characters c
  LEFT JOIN character_avatars ca ON ca.character_id = c.id`;

/** The global library: characters owned by no world. */
export function listCharacters(db: Database): Character[] {
  return db
    .query<Character, []>(`${CHARACTER_SELECT} WHERE c.world_id IS NULL ORDER BY c.created_at, c.id`)
    .all();
}

export function listWorldCharacters(db: Database, worldId: string): Character[] {
  return db
    .query<Character, [string]>(`${CHARACTER_SELECT} WHERE c.world_id = ? ORDER BY c.created_at, c.id`)
    .all(worldId);
}

export function getCharacter(db: Database, id: string): Character | null {
  return db.query<Character, [string]>(`${CHARACTER_SELECT} WHERE c.id = ?`).get(id) ?? null;
}

/** A library character when `worldId` is null, otherwise one owned by that world. */
export function createCharacter(
  db: Database,
  input: CharacterInput,
  worldId: string | null = null,
  avatarId: string | null = null,
): Character {
  const now = nowIso();
  const character: Character = {
    id: newId(),
    world_id: worldId,
    ...profileOf(input),
    avatar_id: avatarId,
    created_at: now,
    updated_at: now,
  };
  const insert = db.transaction(() => {
    db.query(
      `INSERT INTO characters (id, world_id, ${PROFILE_COLUMNS.join(", ")}, created_at, updated_at)
       VALUES (?, ?, ${PROFILE_COLUMNS.map(() => "?").join(", ")}, ?, ?)`,
    ).run(character.id, worldId, ...profileValues(character), now, now);
    if (avatarId !== null) {
      db.query("INSERT INTO character_avatars (character_id, image_id, updated_at) VALUES (?, ?, ?)").run(
        character.id,
        avatarId,
        now,
      );
    }
  });
  insert();
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
    `UPDATE characters SET ${PROFILE_COLUMNS.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
  ).run(...profileValues(next), next.updated_at, id);
  return next;
}

/** Only world characters can be deleted; library characters stay forever. */
export function deleteCharacter(db: Database, id: string): boolean {
  const existing = getCharacter(db, id);
  if (!existing) return false;
  if (existing.world_id === null) throw new ValidationError("library characters cannot be deleted");
  return db.query("DELETE FROM characters WHERE id = ?").run(id).changes > 0;
}

/** Copies a world character into the library; the world keeps its own. */
export function copyCharacterToLibrary(db: Database, id: string): Character | null {
  const source = getCharacter(db, id);
  if (!source) return null;
  if (source.world_id === null) throw new ValidationError("character is already in the library");
  return createCharacter(db, source, null, source.avatar_id);
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
 * Stores the bytes content-addressed (lowercase hex sha256) and returns the
 * image id. Identical bytes are deduplicated by the primary key; images are
 * never garbage collected, because copies at other scopes share them.
 */
function storeImage(db: Database, bytes: Uint8Array, mime: ImageMime): string {
  if (detectImageMime(bytes) !== mime) {
    throw new ValidationError("image data does not match its declared type");
  }
  const id = createHash("sha256").update(bytes).digest("hex");
  db.query(
    "INSERT INTO images (id, mime, data, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
  ).run(id, mime, bytes, nowIso());
  return id;
}

export function setCharacterAvatar(
  db: Database,
  characterId: string,
  bytes: Uint8Array,
  mime: ImageMime,
): Character | null {
  const store = db.transaction(() => {
    const id = storeImage(db, bytes, mime);
    db.query(
      `INSERT INTO character_avatars (character_id, image_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(character_id) DO UPDATE SET image_id = excluded.image_id, updated_at = excluded.updated_at`,
    ).run(characterId, id, nowIso());
  });
  store();
  return getCharacter(db, characterId);
}

/** Clears the character's picture; the image row itself is kept. */
export function clearCharacterAvatar(db: Database, characterId: string): Character | null {
  db.query("DELETE FROM character_avatars WHERE character_id = ?").run(characterId);
  return getCharacter(db, characterId);
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

/** A library character, or one owned by `worldId`; anything else is unknown. */
function pickableCharacter(db: Database, worldId: string, id: string, field: string): Character {
  const character = getCharacter(db, id);
  if (!character || (character.world_id !== null && character.world_id !== worldId)) {
    throw new UnknownEntityError(`${field} does not match a library or world character`);
  }
  return character;
}

function insertCampaignCharacter(
  db: Database,
  campaignId: string,
  role: CampaignCharacterRole,
  profile: CharacterProfile,
  avatarId: string | null,
  values: StatValues | null,
  createdAt: string,
  now: string,
): string {
  const id = newId();
  db.query(
    `INSERT INTO campaign_characters
       (id, campaign_id, role, ${PROFILE_COLUMNS.join(", ")}, avatar_id, stats_enabled, stats, created_at, updated_at)
     VALUES (?, ?, ?, ${PROFILE_COLUMNS.map(() => "?").join(", ")}, ?, ?, ?, ?, ?)`,
  ).run(id, campaignId, role, ...profileValues(profile), avatarId, values ? 1 : 0, JSON.stringify(values ?? {}), createdAt, now);
  return id;
}

function insertCampaignStat(db: Database, campaignId: string, stat: StatFields, createdAt: string, now: string): string {
  const id = newId();
  db.query(
    `INSERT INTO campaign_stats (id, campaign_id, ${STAT_COLUMNS.join(", ")}, created_at, updated_at)
     VALUES (?, ?, ${STAT_COLUMNS.map(() => "?").join(", ")}, ?, ?)`,
  ).run(id, campaignId, ...STAT_COLUMNS.map((key) => stat[key]), createdAt, now);
  return id;
}

/** Every stat of `kind` at its default: what opting in, or a new relationship, starts with. */
export function statDefaults(stats: CampaignStat[], kind: StatKind): StatValues {
  return Object.fromEntries(stats.filter((stat) => stat.applies_to === kind).map((stat) => [stat.id, stat.default_value]));
}

/** Validates a partial value map: known stats of `kind`, integers within each stat's range. */
export function parseStatValues(value: unknown, stats: CampaignStat[], kind: StatKind): StatValues {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("stats must be an object of stat id to value");
  }
  const values: StatValues = {};
  for (const [id, raw] of Object.entries(value)) {
    const stat = stats.find((candidate) => candidate.id === id && candidate.applies_to === kind);
    if (!stat) throw new ValidationError(`stats key ${id} is not a ${kind} stat of this campaign`);
    if (!Number.isInteger(raw) || (raw as number) < stat.min || (raw as number) > stat.max) {
      throw new ValidationError(`${stat.label} must be an integer from ${stat.min} to ${stat.max}`);
    }
    values[id] = raw as number;
  }
  return values;
}

/**
 * Creates the campaign, its own copies of the world's stats and of the picked
 * characters (library or this world's), the world snapshot with every
 * non-scene entry, and the opening session in one transaction: the deferred
 * (active_session_id, id) foreign key only needs to hold at commit, so the
 * campaign row may reference the preallocated session id before the session
 * row exists. The protagonist starts opted in to character stats. COMMIT
 * happens before any model call; later library or world edits never reach
 * the campaign. Rolled back when the opening prompt exceeds the narration budget.
 */
export function createCampaign(db: Database, input: CampaignInput): CreatedCampaign {
  const create = db.transaction(() => {
    const world = getWorld(db, input.world_id);
    if (!world) throw new UnknownEntityError("world_id does not match an existing world");
    const protagonist = pickableCharacter(db, world.id, input.protagonist_id, "protagonist_id");
    const cast = (input.cast_character_ids ?? []).map((id) =>
      pickableCharacter(db, world.id, id, "cast_character_ids entry"),
    );
    const captured: WorldEntrySnapshot[] = listWorldEntries(db, world.id)
      .filter((entry) => entry.kind !== "scene")
      .map((entry) => ({ id: entry.id, kind: entry.kind, name: entry.name, description: entry.description }));

    const now = nowIso();
    const campaignId = newId();
    const sessionId = newId();

    db.query(
      `INSERT INTO campaigns
         (id, name, world_id, world_snapshot, starting_situation, active_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      campaignId,
      input.name ?? world.name,
      world.id,
      JSON.stringify({ name: world.name, setting_brief: world.setting_brief, entries: captured }),
      input.starting_situation,
      sessionId,
      now,
      now,
    );
    for (const stat of listStatDefinitions(db, world.id)) insertCampaignStat(db, campaignId, stat, now, now);
    const defaults = statDefaults(listCampaignStats(db, campaignId), "character");
    insertCampaignCharacter(db, campaignId, "protagonist", protagonist, protagonist.avatar_id, defaults, now, now);
    for (const member of cast) {
      insertCampaignCharacter(db, campaignId, "cast", member, member.avatar_id, null, now, now);
    }
    db.query(
      "INSERT INTO sessions (id, campaign_id, ordinal, title, handoff, closed_at, created_at, updated_at) VALUES (?, ?, 1, ?, NULL, NULL, ?, ?)",
    ).run(sessionId, campaignId, "Opening session", now, now);

    const campaign = getCampaign(db, campaignId)!;
    const opening = narratorSystemPrompt({
      world: campaign.world_snapshot,
      starting_situation: campaign.starting_situation,
      stats: campaign.stats,
      protagonist: protagonistOf(campaign),
      cast: campaign.characters.filter((character) => character.role === "cast"),
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
    const session = db.query<Session, [string]>("SELECT * FROM sessions WHERE id = ?").get(sessionId)!;
    return { campaign, session };
  });
  return create.immediate();
}

/** Protagonist first, then cast in creation order; rowid keeps same-instant inserts in pick order. */
const CAMPAIGN_CHARACTER_ORDER = "ORDER BY role = 'protagonist' DESC, created_at, rowid";

interface CampaignCharacterRow extends Omit<CampaignCharacter, "stats_enabled" | "stats"> {
  stats_enabled: number;
  stats: string;
}

function campaignCharacterFromRow(row: CampaignCharacterRow): CampaignCharacter {
  return { ...row, stats_enabled: row.stats_enabled === 1, stats: JSON.parse(row.stats) as StatValues };
}

export function listCampaignCharacters(db: Database, campaignId: string): CampaignCharacter[] {
  return db
    .query<CampaignCharacterRow, [string]>(
      `SELECT * FROM campaign_characters WHERE campaign_id = ? ${CAMPAIGN_CHARACTER_ORDER}`,
    )
    .all(campaignId)
    .map(campaignCharacterFromRow);
}

export function listCampaignStats(db: Database, campaignId: string): CampaignStat[] {
  return db
    .query<CampaignStat, [string]>(
      "SELECT * FROM campaign_stats WHERE campaign_id = ? ORDER BY applies_to = 'relationship', created_at, rowid",
    )
    .all(campaignId);
}

export function listCampaigns(db: Database): Campaign[] {
  return db
    .query<CampaignRecord, []>("SELECT * FROM campaigns ORDER BY created_at DESC, id DESC")
    .all()
    .map((row) => campaignFromRow(db, row, listCampaignCharacters(db, row.id), listCampaignStats(db, row.id)));
}

export function getCampaign(db: Database, id: string): Campaign | null {
  const row = db.query<CampaignRecord, [string]>("SELECT * FROM campaigns WHERE id = ?").get(id);
  return row ? campaignFromRow(db, row, listCampaignCharacters(db, id), listCampaignStats(db, id)) : null;
}

/** Null covers both an unknown campaign and a character of another campaign. */
export function getCampaignCharacter(db: Database, campaignId: string, id: string): CampaignCharacter | null {
  const row = db
    .query<CampaignCharacterRow, [string, string]>("SELECT * FROM campaign_characters WHERE id = ? AND campaign_id = ?")
    .get(id, campaignId);
  return row ? campaignCharacterFromRow(row) : null;
}

/** A new narrator-controlled character owned by this campaign, not yet opted in to stats. */
export function createCampaignCharacter(
  db: Database,
  campaignId: string,
  input: CharacterInput,
): CampaignCharacter | null {
  if (!getCampaign(db, campaignId)) return null;
  const now = nowIso();
  return getCampaignCharacter(db, campaignId, insertCampaignCharacter(db, campaignId, "cast", input, null, null, now, now));
}

export type CampaignCharacterPatch = Partial<CharacterInput> & { stats_enabled?: boolean; stats?: unknown };

/** Profile fields as in parseCharacterPatch, plus `stats_enabled` and a partial `stats` value map. */
export function parseCampaignCharacterPatch(body: Record<string, unknown>): CampaignCharacterPatch {
  const hasStats = body.stats_enabled !== undefined || body.stats !== undefined;
  const patch: CampaignCharacterPatch = CHARACTER_PROFILE_FIELDS.some((field) => body[field.key] !== undefined) || !hasStats
    ? parseCharacterPatch(body)
    : {};
  if (body.stats_enabled !== undefined) {
    if (typeof body.stats_enabled !== "boolean") throw new ValidationError("stats_enabled must be a boolean");
    patch.stats_enabled = body.stats_enabled;
  }
  if (body.stats !== undefined) patch.stats = body.stats;
  return patch;
}

/**
 * Profile edits plus stat opt-in: turning stats on fills every character stat
 * with its default, turning them off clears the values; values may only be
 * set while opted in.
 */
export function updateCampaignCharacter(
  db: Database,
  campaignId: string,
  id: string,
  patch: CampaignCharacterPatch,
): CampaignCharacter | null {
  const campaign = getCampaign(db, campaignId);
  const existing = getCampaignCharacter(db, campaignId, id);
  if (!campaign || !existing) return null;
  const { stats_enabled, stats, ...profile } = patch;
  const enabled = stats_enabled ?? existing.stats_enabled;
  if (!enabled && stats !== undefined) throw new ValidationError("stats are off for this character");
  const base = !enabled ? {} : existing.stats_enabled ? existing.stats : statDefaults(campaign.stats, "character");
  const values = stats === undefined ? base : { ...base, ...parseStatValues(stats, campaign.stats, "character") };
  const next: CampaignCharacter = { ...existing, ...profile, stats_enabled: enabled, stats: values, updated_at: nowIso() };
  db.query(
    `UPDATE campaign_characters SET ${PROFILE_COLUMNS.map((key) => `${key} = ?`).join(", ")},
       stats_enabled = ?, stats = ?, updated_at = ?
     WHERE id = ?`,
  ).run(...profileValues(next), enabled ? 1 : 0, JSON.stringify(values), next.updated_at, id);
  return next;
}

/** A campaign is fresh until its story has any message; bank import is offered only then. */
function isFreshCampaign(db: Database, campaignId: string): boolean {
  return !hasAnyMessage(db, campaignId);
}

/** Rewrites every value map that carries `stat`: opted-in characters, or every relationship. */
function rewriteStatValues(db: Database, campaignId: string, stat: CampaignStat, change: (values: StatValues) => void): void {
  const table = stat.applies_to === "character" ? "campaign_characters" : "relationships";
  const optedIn = stat.applies_to === "character" ? "AND stats_enabled = 1" : "";
  const rows = db
    .query<{ id: string; stats: string }, [string]>(`SELECT id, stats FROM ${table} WHERE campaign_id = ? ${optedIn}`)
    .all(campaignId);
  for (const row of rows) {
    const values = JSON.parse(row.stats) as StatValues;
    change(values);
    db.query(`UPDATE ${table} SET stats = ? WHERE id = ?`).run(JSON.stringify(values), row.id);
  }
}

/** Adds a campaign stat; opted-in characters (or every relationship) get its default. */
export function createCampaignStat(db: Database, campaignId: string, input: StatFields): CampaignStat | null {
  if (!getCampaign(db, campaignId)) return null;
  const create = db.transaction(() => {
    assertStatSlot(db, "campaign_stats", { column: "campaign_id", id: campaignId }, input, null);
    const now = nowIso();
    const stat = getCampaignStat(db, campaignId, insertCampaignStat(db, campaignId, input, now, now))!;
    rewriteStatValues(db, campaignId, stat, (values) => {
      values[stat.id] = stat.default_value;
    });
    return stat;
  });
  return create();
}

export function getCampaignStat(db: Database, campaignId: string, id: string): CampaignStat | null {
  return (
    db.query<CampaignStat, [string, string]>("SELECT * FROM campaign_stats WHERE id = ? AND campaign_id = ?").get(id, campaignId) ??
    null
  );
}

/** Edits a campaign stat; a changed range pulls existing values into it. */
export function updateCampaignStat(db: Database, campaignId: string, id: string, patch: StatPatch): CampaignStat | null {
  const update = db.transaction(() => {
    const existing = getCampaignStat(db, campaignId, id);
    if (!existing) return null;
    const next = checkedStat({ ...existing, ...patch, updated_at: nowIso() });
    assertStatSlot(db, "campaign_stats", { column: "campaign_id", id: campaignId }, next, id);
    db.query(
      `UPDATE campaign_stats SET ${STAT_COLUMNS.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    ).run(...STAT_COLUMNS.map((key) => next[key]), next.updated_at, id);
    rewriteStatValues(db, campaignId, next, (values) => {
      if (values[id] !== undefined) values[id] = Math.min(next.max, Math.max(next.min, values[id]));
    });
    return next;
  });
  return update();
}

/** Removes a campaign stat and its value from every map. */
export function deleteCampaignStat(db: Database, campaignId: string, id: string): boolean {
  const remove = db.transaction(() => {
    const existing = getCampaignStat(db, campaignId, id);
    if (!existing) return false;
    rewriteStatValues(db, campaignId, existing, (values) => {
      delete values[id];
    });
    db.query("DELETE FROM campaign_stats WHERE id = ?").run(id);
    return true;
  });
  return remove();
}

/** Copies bank stats into a campaign that has not opened yet. */
export function importCampaignStats(db: Database, campaignId: string, bankStatIds: string[]): CampaignStat[] | null {
  if (!getCampaign(db, campaignId)) return null;
  const importStats = db.transaction(() => {
    if (!isFreshCampaign(db, campaignId)) {
      throw new ValidationError("bank stats can only be imported before the story begins");
    }
    return bankStats(db, bankStatIds).map((stat) => createCampaignStat(db, campaignId, stat)!);
  });
  return importStats();
}

/** Any character but the protagonist; its relationships go with it. */
export function deleteCampaignCharacter(db: Database, campaignId: string, id: string): boolean {
  const existing = getCampaignCharacter(db, campaignId, id);
  if (!existing) return false;
  if (existing.role === "protagonist") throw new ValidationError("the protagonist cannot be deleted");
  return db.query("DELETE FROM campaign_characters WHERE id = ?").run(id).changes > 0;
}

/** Copies the campaign character's current profile and picture into the campaign's world. */
export function saveCampaignCharacterToWorld(db: Database, campaignId: string, id: string): Character | null {
  const campaign = getCampaign(db, campaignId);
  const character = getCampaignCharacter(db, campaignId, id);
  if (!campaign || !character) return null;
  return createCharacter(db, character, campaign.world_id, character.avatar_id);
}

export function setCampaignCharacterAvatar(
  db: Database,
  campaignId: string,
  id: string,
  image: { bytes: Uint8Array; mime: ImageMime } | null,
): CampaignCharacter | null {
  if (!getCampaignCharacter(db, campaignId, id)) return null;
  const store = db.transaction(() => {
    const imageId = image ? storeImage(db, image.bytes, image.mime) : null;
    db.query("UPDATE campaign_characters SET avatar_id = ?, updated_at = ? WHERE id = ?").run(imageId, nowIso(), id);
  });
  store();
  return getCampaignCharacter(db, campaignId, id);
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
 * stores and what a fork restores. The world snapshot is not part of it — it
 * never changes after creation.
 */
interface CampaignStateSnapshot {
  stats: Array<StatFields & Pick<CampaignStat, "id" | "created_at">>;
  characters: Array<
    CharacterProfile & Pick<CampaignCharacter, "id" | "role" | "avatar_id" | "stats_enabled" | "stats" | "created_at">
  >;
  notes: Array<Pick<CampaignStateItem, "category" | "subject" | "content" | "created_at">>;
  relationships: Array<
    Pick<Relationship, "source_id" | "target_id" | "how_met" | "status" | "known_facts" | "stats" | "created_at">
  >;
}

function serializeCampaignState(db: Database, campaignId: string): CampaignStateSnapshot {
  return {
    stats: listCampaignStats(db, campaignId).map((stat) => ({ id: stat.id, ...pickStat(stat), created_at: stat.created_at })),
    characters: listCampaignCharacters(db, campaignId).map((character) => ({
      id: character.id,
      role: character.role,
      ...profileOf(character),
      avatar_id: character.avatar_id,
      stats_enabled: character.stats_enabled,
      stats: character.stats,
      created_at: character.created_at,
    })),
    notes: db
      .query<CampaignStateSnapshot["notes"][number], [string]>(
        "SELECT category, subject, content, created_at FROM campaign_state_items WHERE campaign_id = ? ORDER BY created_at, id",
      )
      .all(campaignId),
    relationships: db
      .query<{ source_id: string; target_id: string; how_met: string; status: string; known_facts: string; stats: string; created_at: string }, [string]>(
        "SELECT source_id, target_id, how_met, status, known_facts, stats, created_at FROM relationships WHERE campaign_id = ? ORDER BY created_at, id",
      )
      .all(campaignId)
      .map((row) => ({
        ...row,
        known_facts: JSON.parse(row.known_facts) as string[],
        stats: JSON.parse(row.stats) as StatValues,
      })),
  };
}

/**
 * Writes a snapshot into another campaign under new ids, remapping character
 * ids in relationships and stat ids in value maps; `now` stamps the copies.
 */
function restoreCampaignState(db: Database, campaignId: string, state: CampaignStateSnapshot, now: string): void {
  const statIds = new Map(state.stats.map((stat) => [stat.id, insertCampaignStat(db, campaignId, stat, stat.created_at, now)]));
  const remap = (values: StatValues): StatValues =>
    Object.fromEntries(Object.entries(values).map(([id, value]) => [statIds.get(id)!, value]));
  const characterIds = new Map<string, string>();
  for (const character of state.characters) {
    characterIds.set(
      character.id,
      insertCampaignCharacter(
        db,
        campaignId,
        character.role,
        character,
        character.avatar_id,
        character.stats_enabled ? remap(character.stats) : null,
        character.created_at,
        now,
      ),
    );
  }
  for (const note of state.notes) {
    db.query(
      `INSERT INTO campaign_state_items (id, campaign_id, category, subject, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), campaignId, note.category, note.subject, note.content, note.created_at, now);
  }
  for (const relationship of state.relationships) {
    db.query(
      `INSERT INTO relationships (id, campaign_id, source_id, target_id, how_met, status, known_facts, stats, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId(),
      campaignId,
      characterIds.get(relationship.source_id)!,
      characterIds.get(relationship.target_id)!,
      relationship.how_met,
      relationship.status,
      JSON.stringify(relationship.known_facts),
      JSON.stringify(remap(relationship.stats)),
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
 * Inserts the fork's campaign row: world snapshot and starting situation
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
       (id, name, world_id, world_snapshot, starting_situation, active_session_id,
        forked_from_campaign_id, forked_from_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    campaignId,
    name,
    origin.world_id,
    JSON.stringify(origin.world_snapshot),
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
 * a new independent campaign. The world snapshot and starting situation are
 * copied by value; characters, notes, and relationships come from the closed
 * session's checkpoint, or from the campaign's current state for the open
 * session, and are restored under new ids. The handoff that grounded the source session
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
            direction: string | null;
            created_at: string;
            updated_at: string;
          },
          [string, number]
        >(
          `SELECT role, speaker_name, content, status, direction, created_at, updated_at FROM messages
           WHERE session_id = ? AND selected = 1 AND position <= ?
             AND (role = 'user' OR status = 'complete')
           ORDER BY position`,
        )
        .all(id, message.position);
      history.forEach((row, index) => {
        db.query(
          `INSERT INTO messages
             (id, session_id, position, role, speaker_name, content, status, direction, selected, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(
          newId(),
          forkSessionId,
          index + 1,
          row.role,
          row.speaker_name,
          row.content,
          row.status,
          row.direction,
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
