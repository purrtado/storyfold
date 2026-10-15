import type { Database } from "bun:sqlite";
import type {
  Campaign,
  Character,
  CharacterSnapshot,
  Session,
  World,
  WorldCharacter,
  WorldEntry,
  WorldEntryKind,
  WorldEntrySnapshot,
} from "../shared/domain";
import { WORLD_ENTRY_KINDS } from "../shared/domain";
import { GROUNDING_CHARACTER_LIMIT, groundingCharacterCount } from "../shared/grounding";
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
  return db.query<Character, []>("SELECT * FROM characters ORDER BY created_at, id").all();
}

export function getCharacter(db: Database, id: string): Character | null {
  return db.query<Character, [string]>("SELECT * FROM characters WHERE id = ?").get(id) ?? null;
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
  const character = db
    .query<Character, [string]>("SELECT * FROM characters WHERE id = ?")
    .get(row.character_id)!;
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
        .query<Character, string[]>(`SELECT * FROM characters WHERE id IN (${placeholders})`)
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
      "INSERT INTO sessions (id, campaign_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
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
  return db.query<Session, [string]>("SELECT * FROM sessions WHERE id = ?").get(id) ?? null;
}
