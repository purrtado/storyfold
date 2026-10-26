import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type {
  Character,
  CharacterContextMode,
  CharacterProfile,
  StatColor,
  StatDefinition,
  StatFields,
  StatKind,
  StatValues,
  World,
  WorldEntry,
  WorldEntryKind,
} from "../shared/domain";
import {
  CHARACTER_CONTEXT_MODES,
  CHARACTER_PROFILE_FIELDS,
  STAT_COLORS,
  STAT_KINDS,
  WORLD_ENTRY_KINDS,
} from "../shared/domain";
import { newId, nowIso } from "./db";

/** Request rejected before any state changed; the message is client-safe. */
export class ValidationError extends Error {}

export class UnknownEntityError extends Error {}

/** The request is well-formed but the current state forbids it; nothing changed. */
export class ConflictError extends Error {}

const TEXT_MAX_CHARS = 100_000;

export function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > TEXT_MAX_CHARS) {
    throw new ValidationError(`${field} must be at most ${TEXT_MAX_CHARS} characters`);
  }
  return text;
}


/** Optional but bounded: an absent value stays an empty string end to end. */
export function optionalText(value: unknown, field: string): string {
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
}

export function parseWorldInput(body: Record<string, unknown>): WorldInput {
  return {
    name: requiredText(body.name, "name"),
    setting_brief: requiredText(body.setting_brief, "setting_brief"),
  };
}

/** PATCH applies only the provided fields; at least one must be present. */
export function parseWorldPatch(body: Record<string, unknown>): Partial<WorldInput> {
  const patch: Partial<WorldInput> = {};
  if (body.name !== undefined) patch.name = requiredText(body.name, "name");
  if (body.setting_brief !== undefined) patch.setting_brief = requiredText(body.setting_brief, "setting_brief");
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("at least one of name, setting_brief is required");
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
function parseProfilePatch(body: Record<string, unknown>): Partial<CharacterInput> {
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

/** Creates the world and copies the chosen bank stats into it. */
export function createWorld(db: Database, input: WorldInput, bankStatIds: string[] = []): World {
  const now = nowIso();
  const world: World = { id: newId(), ...input, created_at: now, updated_at: now };
  const create = db.transaction(() => {
    db.query("INSERT INTO worlds (id, name, setting_brief, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      world.id,
      world.name,
      world.setting_brief,
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
  db.query("UPDATE worlds SET name = ?, setting_brief = ?, updated_at = ? WHERE id = ?").run(
    next.name,
    next.setting_brief,
    next.updated_at,
    id,
  );
  return next;
}

const STAT_TEXT_MAX = 500;
const STAT_RANGE_LIMIT = 1_000;
/** Per kind, per bank or world. */
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

/** A stat label is unique per kind within its scope (the bank or one world), and each kind holds at most STAT_COUNT_LIMIT stats. */
function assertStatSlot(
  db: Database,
  worldId: string | null,
  stat: Pick<StatFields, "applies_to" | "label">,
  excludeId: string | null,
): void {
  const siblings = db
    .query<{ id: string; label: string }, [string | null, string]>(
      "SELECT id, label FROM stat_definitions WHERE world_id IS ? AND applies_to = ?",
    )
    .all(worldId, stat.applies_to)
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

/** A world stat joins the value maps that carry its kind: opted-in characters, or every relationship, start at its default. */
export function createStatDefinition(db: Database, worldId: string | null, input: StatFields): StatDefinition {
  const create = db.transaction(() => {
    assertStatSlot(db, worldId, input, null);
    const now = nowIso();
    const stat: StatDefinition = { id: newId(), world_id: worldId, ...pickStat(input), created_at: now, updated_at: now };
    db.query(
      `INSERT INTO stat_definitions (id, world_id, ${STAT_COLUMNS.join(", ")}, created_at, updated_at)
       VALUES (?, ?, ${STAT_COLUMNS.map(() => "?").join(", ")}, ?, ?)`,
    ).run(stat.id, worldId, ...STAT_COLUMNS.map((key) => stat[key]), now, now);
    if (worldId !== null) {
      rewriteStatValues(db, stat, (values) => {
        values[stat.id] = stat.default_value;
      });
    }
    return stat;
  });
  return create();
}

/** Edits a stat; for a world stat a changed range pulls existing values into it. */
export function updateStatDefinition(db: Database, id: string, patch: StatPatch): StatDefinition | null {
  const update = db.transaction(() => {
    const existing = getStatDefinition(db, id);
    if (!existing) return null;
    const next = checkedStat({ ...existing, ...patch, updated_at: nowIso() });
    assertStatSlot(db, existing.world_id, next, id);
    db.query(
      `UPDATE stat_definitions SET ${STAT_COLUMNS.map((key) => `${key} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    ).run(...STAT_COLUMNS.map((key) => next[key]), next.updated_at, id);
    if (next.world_id !== null) {
      rewriteStatValues(db, next, (values) => {
        if (values[id] !== undefined) values[id] = Math.min(next.max, Math.max(next.min, values[id]));
      });
    }
    return next;
  });
  return update();
}

/** Removes a stat; a world stat's value leaves every character and relationship of that world. */
export function deleteStatDefinition(db: Database, id: string): boolean {
  const remove = db.transaction(() => {
    const existing = getStatDefinition(db, id);
    if (!existing) return false;
    if (existing.world_id !== null) {
      rewriteStatValues(db, existing, (values) => {
        delete values[id];
      });
    }
    db.query("DELETE FROM stat_definitions WHERE id = ?").run(id);
    return true;
  });
  return remove();
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


/** New characters start `in_scene`, staying for a few messages after their last mention. */
const CHARACTER_STICKY_DEFAULT = 4;
const SUMMARY_MAX_CHARS = 200;

export type CharacterSceneFields = Pick<Character, "context_mode" | "summary" | "aliases" | "sticky">;

interface CharacterRow extends Omit<Character, "stats_enabled" | "stats" | "aliases"> {
  stats_enabled: number;
  stats: string;
  aliases: string;
}

function characterFromRow(row: CharacterRow): Character {
  return {
    ...row,
    stats_enabled: row.stats_enabled === 1,
    stats: JSON.parse(row.stats) as StatValues,
    aliases: JSON.parse(row.aliases) as string[],
  };
}

/** Creation order; rowid keeps same-instant inserts in insertion order. */
export function listWorldCharacters(db: Database, worldId: string): Character[] {
  return db
    .query<CharacterRow, [string]>("SELECT * FROM characters WHERE world_id = ? ORDER BY created_at, rowid")
    .all(worldId)
    .map(characterFromRow);
}

export function getCharacter(db: Database, id: string): Character | null {
  const row = db.query<CharacterRow, [string]>("SELECT * FROM characters WHERE id = ?").get(id);
  return row ? characterFromRow(row) : null;
}

/** A new character of the world, not yet opted in to stats; null when the world is unknown. */
export function createCharacter(
  db: Database,
  worldId: string,
  input: CharacterInput,
  scene: Partial<CharacterSceneFields> = {},
): Character | null {
  if (!getWorld(db, worldId)) return null;
  const now = nowIso();
  const fields: CharacterSceneFields = {
    context_mode: "in_scene",
    summary: "",
    aliases: [],
    sticky: CHARACTER_STICKY_DEFAULT,
    ...scene,
  };
  const character: Character = {
    id: newId(),
    world_id: worldId,
    ...profileOf(input),
    avatar_id: null,
    stats_enabled: false,
    stats: {},
    ...fields,
    created_at: now,
    updated_at: now,
  };
  db.query(
    `INSERT INTO characters
       (id, world_id, ${PROFILE_COLUMNS.join(", ")}, avatar_id, stats_enabled, stats,
        context_mode, summary, aliases, sticky, created_at, updated_at)
     VALUES (?, ?, ${PROFILE_COLUMNS.map(() => "?").join(", ")}, NULL, 0, '{}', ?, ?, ?, ?, ?, ?)`,
  ).run(
    character.id,
    worldId,
    ...profileValues(character),
    character.context_mode,
    character.summary,
    JSON.stringify(character.aliases),
    character.sticky,
    now,
    now,
  );
  return character;
}

/** The optional scene fields of a character body; absent ones stay undefined. */
export function parseCharacterSceneFields(body: Record<string, unknown>): Partial<CharacterSceneFields> {
  const fields: Partial<CharacterSceneFields> = {};
  if (body.context_mode !== undefined) {
    if (!CHARACTER_CONTEXT_MODES.includes(body.context_mode as CharacterContextMode)) {
      throw new ValidationError(`context_mode must be one of: ${CHARACTER_CONTEXT_MODES.join(", ")}`);
    }
    fields.context_mode = body.context_mode as CharacterContextMode;
  }
  if (body.summary !== undefined) {
    if (typeof body.summary !== "string") throw new ValidationError("summary must be a string");
    const summary = body.summary.trim();
    if (summary.length > SUMMARY_MAX_CHARS || /[\r\n]/.test(summary)) {
      throw new ValidationError(`summary must be one line of at most ${SUMMARY_MAX_CHARS} characters`);
    }
    fields.summary = summary;
  }
  if (body.aliases !== undefined) fields.aliases = parseKeywords(body.aliases, "aliases");
  if (body.sticky !== undefined) fields.sticky = boundedInteger(body.sticky, "sticky", STICKY_LIMIT);
  return fields;
}

export type CharacterPatch = Partial<CharacterInput> &
  Partial<CharacterSceneFields> & { stats_enabled?: boolean; stats?: unknown };

/** Profile fields, scene fields, `stats_enabled`, and a partial `stats` value map; at least one must be present. */
export function parseCharacterPatch(body: Record<string, unknown>): CharacterPatch {
  const scene = parseCharacterSceneFields(body);
  const hasOther = body.stats_enabled !== undefined || body.stats !== undefined || Object.keys(scene).length > 0;
  const patch: CharacterPatch = {
    ...(CHARACTER_PROFILE_FIELDS.some((field) => body[field.key] !== undefined) || !hasOther
      ? parseProfilePatch(body)
      : {}),
    ...scene,
  };
  if (body.stats_enabled !== undefined) {
    if (typeof body.stats_enabled !== "boolean") throw new ValidationError("stats_enabled must be a boolean");
    patch.stats_enabled = body.stats_enabled;
  }
  if (body.stats !== undefined) patch.stats = body.stats;
  return patch;
}

/**
 * Profile and scene edits plus stat opt-in: turning stats on fills every
 * character stat of the world with its default, turning them off clears the
 * values; values may only be set while opted in.
 */
export function updateCharacter(db: Database, id: string, patch: CharacterPatch): Character | null {
  const existing = getCharacter(db, id);
  if (!existing) return null;
  const { stats_enabled, stats, ...fields } = patch;
  const worldStats = listStatDefinitions(db, existing.world_id);
  const enabled = stats_enabled ?? existing.stats_enabled;
  if (!enabled && stats !== undefined) throw new ValidationError("stats are off for this character");
  const base = !enabled ? {} : existing.stats_enabled ? existing.stats : statDefaults(worldStats, "character");
  const values = stats === undefined ? base : { ...base, ...parseStatValues(stats, worldStats, "character") };
  const next: Character = { ...existing, ...fields, stats_enabled: enabled, stats: values, updated_at: nowIso() };
  db.query(
    `UPDATE characters SET ${PROFILE_COLUMNS.map((key) => `${key} = ?`).join(", ")},
       stats_enabled = ?, stats = ?, context_mode = ?, summary = ?, aliases = ?, sticky = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    ...profileValues(next),
    enabled ? 1 : 0,
    JSON.stringify(values),
    next.context_mode,
    next.summary,
    JSON.stringify(next.aliases),
    next.sticky,
    next.updated_at,
    id,
  );
  return next;
}

/** A character that is some chat's protagonist cannot go; otherwise its relationships go with it. */
export function deleteCharacter(db: Database, id: string): boolean {
  const remove = db.transaction(() => {
    if (!getCharacter(db, id)) return false;
    if (db.query("SELECT 1 FROM chats WHERE protagonist_id = ? LIMIT 1").get(id)) {
      throw new ConflictError("This character is the protagonist of a chat; delete that chat first");
    }
    return db.query("DELETE FROM characters WHERE id = ?").run(id).changes > 0;
  });
  return remove();
}

/** Every stat of `kind` at its default: what opting in, or a new relationship, starts with. */
export function statDefaults(stats: ReadonlyArray<StatDefinition>, kind: StatKind): StatValues {
  return Object.fromEntries(stats.filter((stat) => stat.applies_to === kind).map((stat) => [stat.id, stat.default_value]));
}

/** Validates a partial value map: known stats of `kind`, integers within each stat's range. */
export function parseStatValues(value: unknown, stats: ReadonlyArray<StatDefinition>, kind: StatKind): StatValues {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError("stats must be an object of stat id to value");
  }
  const values: StatValues = {};
  for (const [id, raw] of Object.entries(value)) {
    const stat = stats.find((candidate) => candidate.id === id && candidate.applies_to === kind);
    if (!stat) throw new ValidationError(`stats key ${id} is not a ${kind} stat of this world`);
    if (!Number.isInteger(raw) || (raw as number) < stat.min || (raw as number) > stat.max) {
      throw new ValidationError(`${stat.label} must be an integer from ${stat.min} to ${stat.max}`);
    }
    values[id] = raw as number;
  }
  return values;
}

/** Rewrites every value map that carries a world stat: opted-in characters, or every relationship. */
function rewriteStatValues(db: Database, stat: StatDefinition, change: (values: StatValues) => void): void {
  const table = stat.applies_to === "character" ? "characters" : "relationships";
  const optedIn = stat.applies_to === "character" ? "AND stats_enabled = 1" : "";
  const rows = db
    .query<{ id: string; stats: string }, [string | null]>(`SELECT id, stats FROM ${table} WHERE world_id = ? ${optedIn}`)
    .all(stat.world_id);
  for (const row of rows) {
    const values = JSON.parse(row.stats) as StatValues;
    change(values);
    db.query(`UPDATE ${table} SET stats = ? WHERE id = ?`).run(JSON.stringify(values), row.id);
  }
}

/** Copies bank stats into the world; null when the world is unknown. */
export function importWorldStats(db: Database, worldId: string, bankStatIds: string[]): StatDefinition[] | null {
  if (!getWorld(db, worldId)) return null;
  const importStats = db.transaction(() => bankStats(db, bankStatIds).map((stat) => createStatDefinition(db, worldId, stat)));
  return importStats();
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
 * never garbage collected, because the same bytes may serve several characters.
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
  if (!getCharacter(db, characterId)) return null;
  const store = db.transaction(() => {
    const imageId = storeImage(db, bytes, mime);
    db.query("UPDATE characters SET avatar_id = ?, updated_at = ? WHERE id = ?").run(imageId, nowIso(), characterId);
  });
  store();
  return getCharacter(db, characterId);
}

/** Clears the character's picture; the image row itself is kept. */
export function clearCharacterAvatar(db: Database, characterId: string): Character | null {
  if (!getCharacter(db, characterId)) return null;
  db.query("UPDATE characters SET avatar_id = NULL, updated_at = ? WHERE id = ?").run(nowIso(), characterId);
  return getCharacter(db, characterId);
}

export type WorldEntryInput = Pick<WorldEntry, "kind" | "name" | "description" | "keywords" | "priority" | "sticky">;

const KEYWORD_COUNT_LIMIT = 50;
const KEYWORD_MAX_CHARS = 100;
const PRIORITY_LIMIT = 1_000;
const STICKY_LIMIT = 50;

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

/** Trimmed, non-empty, and distinct ignoring case; the first spelling is kept. */
function parseKeywords(value: unknown, field = "keywords"): string[] {
  if (!Array.isArray(value) || value.some((keyword) => typeof keyword !== "string")) {
    throw new ValidationError(`${field} must be an array of strings`);
  }
  const keywords: string[] = [];
  for (const raw of value as string[]) {
    const keyword = raw.trim();
    if (keyword.length === 0 || keyword.length > KEYWORD_MAX_CHARS) {
      throw new ValidationError(`each of ${field} must be 1 to ${KEYWORD_MAX_CHARS} characters`);
    }
    if (!keywords.some((kept) => kept.toLowerCase() === keyword.toLowerCase())) keywords.push(keyword);
  }
  if (keywords.length > KEYWORD_COUNT_LIMIT) {
    throw new ValidationError(`${field} may have at most ${KEYWORD_COUNT_LIMIT} items`);
  }
  return keywords;
}

function boundedInteger(value: unknown, field: string, max: number): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) {
    throw new ValidationError(`${field} must be an integer from 0 to ${max}`);
  }
  return value as number;
}

/** Keywords, priority, and sticky are optional: an entry without keywords is always included. */
export function parseWorldEntryInput(body: Record<string, unknown>): WorldEntryInput {
  return {
    kind: parseEntryKind(body.kind),
    name: requiredText(body.name, "name"),
    description: requiredText(body.description, "description"),
    keywords: body.keywords === undefined ? [] : parseKeywords(body.keywords),
    priority: body.priority === undefined ? 0 : boundedInteger(body.priority, "priority", PRIORITY_LIMIT),
    sticky: body.sticky === undefined ? 0 : boundedInteger(body.sticky, "sticky", STICKY_LIMIT),
  };
}

/** PATCH applies only the provided fields; at least one must be present. */
export function parseWorldEntryPatch(body: Record<string, unknown>): Partial<WorldEntryInput> {
  const patch: Partial<WorldEntryInput> = {};
  if (body.kind !== undefined) patch.kind = parseEntryKind(body.kind);
  if (body.name !== undefined) patch.name = requiredText(body.name, "name");
  if (body.description !== undefined) patch.description = requiredText(body.description, "description");
  if (body.keywords !== undefined) patch.keywords = parseKeywords(body.keywords);
  if (body.priority !== undefined) patch.priority = boundedInteger(body.priority, "priority", PRIORITY_LIMIT);
  if (body.sticky !== undefined) patch.sticky = boundedInteger(body.sticky, "sticky", STICKY_LIMIT);
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("at least one of kind, name, description, keywords, priority, sticky is required");
  }
  return patch;
}

type WorldEntryRow = Omit<WorldEntry, "keywords"> & { keywords: string };

function worldEntryFromRow(row: WorldEntryRow): WorldEntry {
  return { ...row, keywords: JSON.parse(row.keywords) as string[] };
}

export function listWorldEntries(db: Database, worldId: string): WorldEntry[] {
  return db
    .query<WorldEntryRow, [string]>("SELECT * FROM world_entries WHERE world_id = ? ORDER BY created_at, id")
    .all(worldId)
    .map(worldEntryFromRow);
}

export function createWorldEntry(db: Database, worldId: string, input: WorldEntryInput): WorldEntry | null {
  if (!getWorld(db, worldId)) return null;
  const now = nowIso();
  const entry: WorldEntry = { id: newId(), world_id: worldId, ...input, created_at: now, updated_at: now };
  db.query(
    `INSERT INTO world_entries (id, world_id, kind, name, description, keywords, priority, sticky, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.id,
    entry.world_id,
    entry.kind,
    entry.name,
    entry.description,
    JSON.stringify(entry.keywords),
    entry.priority,
    entry.sticky,
    entry.created_at,
    entry.updated_at,
  );
  return entry;
}

/** Null covers both an unknown world and an entry living in another world. */
function getWorldEntryScoped(db: Database, worldId: string, entryId: string): WorldEntry | null {
  const row = db
    .query<WorldEntryRow, [string, string]>("SELECT * FROM world_entries WHERE id = ? AND world_id = ?")
    .get(entryId, worldId);
  return row ? worldEntryFromRow(row) : null;
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
  db.query(
    `UPDATE world_entries SET kind = ?, name = ?, description = ?, keywords = ?, priority = ?, sticky = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.kind,
    next.name,
    next.description,
    JSON.stringify(next.keywords),
    next.priority,
    next.sticky,
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
