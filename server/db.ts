import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  Campaign,
  PersonaSnapshot,
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

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_entries (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  kind TEXT NOT NULL CHECK (kind IN ('character', 'location', 'lore', 'scene')),
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
  persona_id TEXT NOT NULL REFERENCES personas(id),
  world_snapshot TEXT NOT NULL CHECK (json_valid(world_snapshot)),
  persona_snapshot TEXT NOT NULL CHECK (json_valid(persona_snapshot)),
  starting_situation TEXT NOT NULL,
  active_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (active_session_id, id) REFERENCES sessions(id, campaign_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_id_campaign ON sessions(id, campaign_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  position INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  speaker_name TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'interrupted', 'failed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, position),
  CHECK (role != 'user' OR status = 'complete')
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_one_pending
  ON messages(session_id) WHERE role = 'assistant' AND status = 'pending';
`;

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

/** Opens the workspace database with foreign keys and the M1 schema in place. */
export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
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
  persona_id: string;
  world_snapshot: string;
  persona_snapshot: string;
  starting_situation: string;
  active_session_id: string;
  created_at: string;
  updated_at: string;
}

/**
 * Snapshot columns are written only by campaign creation from API-validated
 * fields; on read we re-check the shape so a corrupt workspace can never reach
 * prompts as undefined. name/setting_brief stay non-empty;
 * suggested_starting_situation may be blank; entries must be present — there
 * is no pre-M2 snapshot compatibility.
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

function parsePersonaSnapshot(text: string): PersonaSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("corrupt campaign snapshot");
  }
  if (typeof value !== "object" || value === null) throw new Error("corrupt campaign snapshot");
  const snapshot = value as Record<string, unknown>;
  if (typeof snapshot.name !== "string" || typeof snapshot.description !== "string") {
    throw new Error("corrupt campaign snapshot");
  }
  if (snapshot.name.length === 0 || snapshot.description.length === 0) {
    throw new Error("corrupt campaign snapshot");
  }
  return value as PersonaSnapshot;
}

export function campaignFromRow(row: CampaignRecord): Campaign {
  return {
    ...row,
    world_snapshot: parseWorldSnapshot(row.world_snapshot),
    persona_snapshot: parsePersonaSnapshot(row.persona_snapshot),
  };
}
