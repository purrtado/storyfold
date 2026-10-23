import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Campaign,
  CharacterSnapshot,
  WorldEntryKind,
  WorldEntrySnapshot,
  WorldSnapshot,
} from "../shared/domain";
import { WORLD_ENTRY_KINDS } from "../shared/domain";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS worlds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  setting_brief TEXT NOT NULL,
  suggested_starting_situation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  appearance TEXT NOT NULL,
  personality TEXT NOT NULL,
  background TEXT NOT NULL,
  baseline_motivations TEXT NOT NULL,
  speaking_style TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_characters (
  world_id TEXT NOT NULL REFERENCES worlds(id),
  character_id TEXT NOT NULL REFERENCES characters(id),
  context TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (world_id, character_id)
);

CREATE TABLE IF NOT EXISTS world_entries (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  kind TEXT NOT NULL CHECK (kind IN ('local_npc', 'location', 'lore', 'scene')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS world_entries_world ON world_entries(world_id);

CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  protagonist_id TEXT NOT NULL REFERENCES characters(id),
  world_snapshot TEXT NOT NULL CHECK (json_valid(world_snapshot)),
  protagonist_snapshot TEXT NOT NULL CHECK (json_valid(protagonist_snapshot)),
  cast_snapshot TEXT NOT NULL CHECK (json_valid(cast_snapshot)),
  starting_situation TEXT NOT NULL,
  active_session_id TEXT NOT NULL,
  forked_from_campaign_id TEXT REFERENCES campaigns(id),
  forked_from_session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (active_session_id, id) REFERENCES sessions(id, campaign_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  handoff TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (campaign_id, ordinal)
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_id_campaign ON sessions(id, campaign_id);

CREATE TABLE IF NOT EXISTS campaign_state_items (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  category TEXT NOT NULL CHECK (category IN ('goal', 'knowledge', 'internal', 'journal')),
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS campaign_state_items_campaign ON campaign_state_items(campaign_id);

CREATE TABLE IF NOT EXISTS session_checkpoints (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  state TEXT NOT NULL CHECK (json_valid(state)),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relationship_subjects (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, campaign_id)
);

CREATE TABLE IF NOT EXISTS relationships (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  document TEXT NOT NULL CHECK (json_valid(document)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_id != target_id),
  UNIQUE (campaign_id, source_id, target_id),
  UNIQUE (id, campaign_id)
);

CREATE INDEX IF NOT EXISTS relationships_campaign ON relationships(campaign_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  position INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  speaker_name TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'interrupted', 'failed')),
  selected INTEGER NOT NULL CHECK (selected IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (role != 'user' OR status = 'complete'),
  CHECK (role = 'assistant' OR selected = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_one_pending
  ON messages(session_id) WHERE role = 'assistant' AND status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS messages_one_selected
  ON messages(session_id, position) WHERE selected = 1;

CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS character_avatars (
  character_id TEXT PRIMARY KEY REFERENCES characters(id),
  image_id TEXT NOT NULL REFERENCES images(id),
  updated_at TEXT NOT NULL
);
`;

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

/** Bumped whenever SCHEMA changes; there are no migrations. */
const SCHEMA_VERSION = 1;

/**
 * Opens the workspace database with foreign keys and the schema in place. A
 * workspace written by another schema version is refused rather than migrated.
 */
export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  const populated = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get() !== null;
  if (populated && version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(`${path} uses an older Storyfold schema; delete it to start fresh (there are no migrations)`);
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

/**
 * Startup-only: one Bun backend means any surviving pending assistant reply is
 * abandoned (the process that streamed it is gone), so it settles as
 * interrupted. Never resumes generation.
 */
export function sweepAbandonedPending(db: Database): number {
  return db
    .query(
      `UPDATE messages SET status = 'interrupted', updated_at = ?
       WHERE role = 'assistant' AND status = 'pending'`,
    )
    .run(nowIso()).changes;
}

/** Storage shape of a campaign row: snapshots are JSON text until parsed. */
export interface CampaignRecord {
  id: string;
  name: string;
  world_id: string;
  protagonist_id: string;
  world_snapshot: string;
  protagonist_snapshot: string;
  cast_snapshot: string;
  starting_situation: string;
  active_session_id: string;
  forked_from_campaign_id: string | null;
  forked_from_session_id: string | null;
  created_at: string;
  updated_at: string;
}

const CHARACTER_SNAPSHOT_FIELDS = [
  "name",
  "description",
  "appearance",
  "personality",
  "background",
  "baseline_motivations",
  "speaking_style",
  "world_context",
] as const;

/**
 * Snapshot columns are written only by campaign creation from API-validated
 * fields; on read we re-check the shape so a corrupt workspace can never reach
 * prompts as undefined. name/setting_brief stay non-empty;
 * suggested_starting_situation may be blank; entries must be present — there
 * is no pre-M2 snapshot compatibility. A character snapshot must carry its
 * captured global id and a non-empty name/description; every other authored
 * field may be blank.
 */
function parseWorldSnapshot(text: string): WorldSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("corrupt campaign snapshot");
  }
  if (typeof value !== "object" || value === null) throw new Error("corrupt campaign snapshot");
  const snapshot = value as Record<string, unknown>;
  for (const key of ["name", "setting_brief", "suggested_starting_situation"]) {
    if (typeof snapshot[key] !== "string") throw new Error("corrupt campaign snapshot");
  }
  if ((snapshot.name as string).length === 0 || (snapshot.setting_brief as string).length === 0) {
    throw new Error("corrupt campaign snapshot");
  }
  const entries = snapshot.entries;
  if (!Array.isArray(entries)) throw new Error("corrupt campaign snapshot");
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) throw new Error("corrupt campaign snapshot");
    const captured = entry as Record<string, unknown>;
    if (
      typeof captured.id !== "string" ||
      typeof captured.name !== "string" ||
      typeof captured.description !== "string" ||
      !WORLD_ENTRY_KINDS.includes(captured.kind as WorldEntryKind) ||
      captured.name.length === 0
    ) {
      throw new Error("corrupt campaign snapshot");
    }
  }
  return { ...(value as WorldSnapshot), entries: entries as WorldEntrySnapshot[] };
}

function parseCharacterSnapshot(text: string): CharacterSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("corrupt campaign snapshot");
  }
  if (typeof value !== "object" || value === null) throw new Error("corrupt campaign snapshot");
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.id !== "string" || snapshot.id.length === 0) {
    throw new Error("corrupt campaign snapshot");
  }
  for (const key of CHARACTER_SNAPSHOT_FIELDS) {
    if (typeof snapshot[key] !== "string") throw new Error("corrupt campaign snapshot");
  }
  if ((snapshot.name as string).length === 0 || (snapshot.description as string).length === 0) {
    throw new Error("corrupt campaign snapshot");
  }
  normalizeSnapshotAvatar(snapshot);
  return value as CharacterSnapshot;
}

/**
 * Snapshots written before avatars existed lack `avatar_id`; it is filled with
 * null at this single parse boundary so the wire shape is always
 * `string | null`. A present value must be text or null.
 */
function normalizeSnapshotAvatar(snapshot: Record<string, unknown>): void {
  if (snapshot.avatar_id !== undefined && typeof snapshot.avatar_id !== "string" && snapshot.avatar_id !== null) {
    throw new Error("corrupt campaign snapshot");
  }
  snapshot.avatar_id = snapshot.avatar_id ?? null;
}

function parseCastSnapshot(text: string): CharacterSnapshot[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("corrupt campaign snapshot");
  }
  if (!Array.isArray(value)) throw new Error("corrupt campaign snapshot");
  const ids = new Set<string>();
  return value.map((member) => {
    if (typeof member !== "object" || member === null) throw new Error("corrupt campaign snapshot");
    const snapshot = member as Record<string, unknown>;
    if (typeof snapshot.id !== "string" || snapshot.id.length === 0 || ids.has(snapshot.id)) {
      throw new Error("corrupt campaign snapshot");
    }
    ids.add(snapshot.id);
    for (const key of CHARACTER_SNAPSHOT_FIELDS) {
      if (typeof snapshot[key] !== "string") throw new Error("corrupt campaign snapshot");
    }
    if ((snapshot.name as string).length === 0 || (snapshot.description as string).length === 0) {
      throw new Error("corrupt campaign snapshot");
    }
    normalizeSnapshotAvatar(snapshot);
    return member as CharacterSnapshot;
  });
}

export function campaignFromRow(row: CampaignRecord): Campaign {
  const { cast_snapshot: _rawCast, ...rest } = row;
  return {
    ...rest,
    world_snapshot: parseWorldSnapshot(row.world_snapshot),
    protagonist_snapshot: parseCharacterSnapshot(row.protagonist_snapshot),
    cast: parseCastSnapshot(row.cast_snapshot),
  };
}
