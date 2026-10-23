import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Campaign, CampaignCharacter, WorldEntryKind, WorldEntrySnapshot, WorldSnapshot } from "../shared/domain";
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
  world_id TEXT REFERENCES worlds(id),
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

CREATE INDEX IF NOT EXISTS characters_world ON characters(world_id);

CREATE TABLE IF NOT EXISTS world_entries (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  kind TEXT NOT NULL CHECK (kind IN ('location', 'lore', 'scene')),
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
  world_snapshot TEXT NOT NULL CHECK (json_valid(world_snapshot)),
  starting_situation TEXT NOT NULL,
  active_session_id TEXT NOT NULL,
  forked_from_campaign_id TEXT REFERENCES campaigns(id),
  forked_from_session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (active_session_id, id) REFERENCES sessions(id, campaign_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS campaign_characters (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  role TEXT NOT NULL CHECK (role IN ('protagonist', 'cast')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  appearance TEXT NOT NULL,
  personality TEXT NOT NULL,
  background TEXT NOT NULL,
  baseline_motivations TEXT NOT NULL,
  speaking_style TEXT NOT NULL,
  avatar_id TEXT REFERENCES images(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, campaign_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS campaign_characters_one_protagonist
  ON campaign_characters(campaign_id) WHERE role = 'protagonist';

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
  FOREIGN KEY (source_id, campaign_id) REFERENCES campaign_characters(id, campaign_id) ON DELETE CASCADE,
  FOREIGN KEY (target_id, campaign_id) REFERENCES campaign_characters(id, campaign_id) ON DELETE CASCADE
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
  character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
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
const SCHEMA_VERSION = 2;

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

/** Storage shape of a campaign row: the world snapshot is JSON text until parsed. */
export interface CampaignRecord {
  id: string;
  name: string;
  world_id: string;
  world_snapshot: string;
  starting_situation: string;
  active_session_id: string;
  forked_from_campaign_id: string | null;
  forked_from_session_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The snapshot column is written only by campaign creation from API-validated
 * fields; on read we re-check the shape so a corrupt workspace can never reach
 * prompts as undefined. name/setting_brief stay non-empty and entries must be
 * present.
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
  if (
    typeof snapshot.name !== "string" ||
    typeof snapshot.setting_brief !== "string" ||
    snapshot.name.length === 0 ||
    snapshot.setting_brief.length === 0
  ) {
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
  return { name: snapshot.name, setting_brief: snapshot.setting_brief, entries: entries as WorldEntrySnapshot[] };
}

export function campaignFromRow(row: CampaignRecord, characters: CampaignCharacter[]): Campaign {
  return { ...row, world_snapshot: parseWorldSnapshot(row.world_snapshot), characters };
}
