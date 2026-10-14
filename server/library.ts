import type { Database } from "bun:sqlite";
import type {
  Campaign,
  Persona,
  Session,
  World,
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

export interface PersonaInput {
  name: string;
  description: string;
}

export function parsePersonaInput(body: Record<string, unknown>): PersonaInput {
  return {
    name: requiredText(body.name, "name"),
    description: requiredText(body.description, "description"),
  };
}

export function parsePersonaPatch(body: Record<string, unknown>): Partial<PersonaInput> {
  const patch: Partial<PersonaInput> = {};
  if (body.name !== undefined) patch.name = requiredText(body.name, "name");
  if (body.description !== undefined) patch.description = requiredText(body.description, "description");
  if (Object.keys(patch).length === 0) {
    throw new ValidationError("at least one of name, description is required");
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

export function listPersonas(db: Database): Persona[] {
  return db.query<Persona, []>("SELECT * FROM personas ORDER BY created_at, id").all();
}

export function getPersona(db: Database, id: string): Persona | null {
  return db.query<Persona, [string]>("SELECT * FROM personas WHERE id = ?").get(id) ?? null;
}

export function createPersona(db: Database, input: PersonaInput): Persona {
  const now = nowIso();
  const persona: Persona = { id: newId(), ...input, created_at: now, updated_at: now };
  db.query(
    "INSERT INTO personas (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(persona.id, persona.name, persona.description, persona.created_at, persona.updated_at);
  return persona;
}

export function updatePersona(db: Database, id: string, patch: Partial<PersonaInput>): Persona | null {
  const existing = getPersona(db, id);
  if (!existing) return null;
  const next: Persona = { ...existing, ...patch, updated_at: nowIso() };
  db.query("UPDATE personas SET name = ?, description = ?, updated_at = ? WHERE id = ?").run(
    next.name,
    next.description,
    next.updated_at,
    id,
  );
  return next;
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
  persona_id: string;
  starting_situation: string;
  entry_ids?: string[];
  name?: string;
}

export function parseCampaignInput(body: Record<string, unknown>): CampaignInput {
  const { world_id, persona_id } = body;
  if (typeof world_id !== "string" || world_id.length === 0) {
    throw new ValidationError("world_id must be a non-empty string");
  }
  if (typeof persona_id !== "string" || persona_id.length === 0) {
    throw new ValidationError("persona_id must be a non-empty string");
  }
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim().length === 0)) {
    throw new ValidationError("name must be a non-empty string when provided");
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
    persona_id,
    starting_situation: optionalText(body.starting_situation, "starting_situation"),
    ...(entry_ids !== undefined ? { entry_ids } : {}),
    ...(body.name !== undefined ? { name: body.name.trim() } : {}),
  };
}

export interface CreatedCampaign {
  campaign: Campaign;
  session: Session;
}

/**
 * Creates the campaign, its captured world/persona snapshots (including the
 * selected compendium entries), and the opening session in one transaction:
 * the deferred (active_session_id, id) foreign key only needs to hold at
 * commit, so the campaign row may reference the preallocated session id before
 * the session row exists. COMMIT happens before any model call — a crash
 * mid-creation leaves no half-created campaign. Captured entries are copied by
 * value; later library edits and deletes never rewrite a campaign snapshot.
 */
export function createCampaign(db: Database, input: CampaignInput): CreatedCampaign {
  const create = db.transaction(() => {
    const world = getWorld(db, input.world_id);
    if (!world) throw new UnknownEntityError("world_id does not match an existing world");
    const persona = getPersona(db, input.persona_id);
    if (!persona) throw new UnknownEntityError("persona_id does not match an existing persona");

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

    // The limit binds every campaign: world, persona and situation alone can
    // exceed it even when no entries are selected.
    const total = groundingCharacterCount({
      world_name: world.name,
      world_setting_brief: world.setting_brief,
      persona_name: persona.name,
      persona_description: persona.description,
      starting_situation: input.starting_situation,
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
         (id, name, world_id, persona_id, world_snapshot, persona_snapshot,
          starting_situation, active_session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      campaignId,
      input.name ?? world.name,
      world.id,
      persona.id,
      JSON.stringify({
        name: world.name,
        setting_brief: world.setting_brief,
        suggested_starting_situation: world.suggested_starting_situation,
        entries: captured,
      }),
      JSON.stringify({ name: persona.name, description: persona.description }),
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
