import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StatFields } from "../shared/domain";
import { DEFAULT_PROMPT_CARDS } from "../shared/narration";

/**
 * A chapter stands in for the selected messages at positions
 * start_position..end_position in model history. A chat's chapters cover a
 * contiguous run of positions from its first message on.
 */
const CHAPTERS_SCHEMA = `
CREATE TABLE chapters (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  start_position INTEGER NOT NULL,
  end_position INTEGER NOT NULL CHECK (end_position >= start_position),
  summary TEXT NOT NULL,
  edited INTEGER NOT NULL CHECK (edited IN (0, 1)),
  model TEXT NOT NULL,
  usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX chapters_end ON chapters(chat_id, end_position);
`;

const SCHEMA = `
CREATE TABLE worlds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  setting_brief TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  appearance TEXT NOT NULL,
  personality TEXT NOT NULL,
  intimacy TEXT NOT NULL,
  knowledge TEXT NOT NULL,
  memories TEXT NOT NULL,
  thoughts TEXT NOT NULL,
  avatar_id TEXT REFERENCES images(id),
  stats_enabled INTEGER NOT NULL CHECK (stats_enabled IN (0, 1)),
  stats TEXT NOT NULL CHECK (json_valid(stats)),
  context_mode TEXT NOT NULL CHECK (context_mode IN ('always', 'in_scene', 'mentioned')),
  summary TEXT NOT NULL,
  aliases TEXT NOT NULL CHECK (json_valid(aliases)),
  sticky INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, world_id)
);

CREATE INDEX characters_world ON characters(world_id);

CREATE TABLE world_entries (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  kind TEXT NOT NULL CHECK (kind IN ('location', 'lore', 'scene')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  keywords TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(keywords)),
  priority INTEGER NOT NULL DEFAULT 0,
  sticky INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX world_entries_world ON world_entries(world_id);

CREATE TABLE stat_definitions (
  id TEXT PRIMARY KEY,
  world_id TEXT REFERENCES worlds(id),
  applies_to TEXT NOT NULL CHECK (applies_to IN ('character', 'relationship')),
  label TEXT NOT NULL,
  description TEXT NOT NULL,
  low_label TEXT NOT NULL,
  high_label TEXT NOT NULL,
  min INTEGER NOT NULL,
  max INTEGER NOT NULL,
  default_value INTEGER NOT NULL,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (min < max AND default_value BETWEEN min AND max)
);

CREATE INDEX stat_definitions_world ON stat_definitions(world_id);

CREATE TABLE relationships (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  how_met TEXT NOT NULL,
  status TEXT NOT NULL,
  known_facts TEXT NOT NULL CHECK (json_valid(known_facts)),
  stats TEXT NOT NULL CHECK (json_valid(stats)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (source_id != target_id),
  UNIQUE (world_id, source_id, target_id),
  FOREIGN KEY (source_id, world_id) REFERENCES characters(id, world_id) ON DELETE CASCADE,
  FOREIGN KEY (target_id, world_id) REFERENCES characters(id, world_id) ON DELETE CASCADE
);

CREATE INDEX relationships_world ON relationships(world_id);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id),
  protagonist_id TEXT NOT NULL,
  title TEXT NOT NULL,
  opening TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (protagonist_id, world_id) REFERENCES characters(id, world_id)
);

CREATE INDEX chats_world ON chats(world_id);
CREATE INDEX chats_protagonist ON chats(protagonist_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  position INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  speaker_name TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'interrupted', 'failed')),
  selected INTEGER NOT NULL CHECK (selected IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  direction TEXT,
  lore TEXT CHECK (lore IS NULL OR json_valid(lore)),
  usage TEXT CHECK (usage IS NULL OR json_valid(usage)),
  reasoning TEXT,
  reasoning_ms INTEGER CHECK (reasoning_ms IS NULL OR reasoning_ms >= 0),
  CHECK (role != 'user' OR status = 'complete'),
  CHECK (role = 'assistant' OR selected = 1)
);

CREATE UNIQUE INDEX messages_one_pending
  ON messages(chat_id) WHERE role = 'assistant' AND status = 'pending';

CREATE UNIQUE INDEX messages_one_selected
  ON messages(chat_id, position) WHERE selected = 1;

CREATE TABLE prompt_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX prompt_presets_one_active
  ON prompt_presets(active) WHERE active = 1;

CREATE TABLE prompt_cards (
  id TEXT PRIMARY KEY,
  preset_id TEXT NOT NULL REFERENCES prompt_presets(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
${CHAPTERS_SCHEMA}`;

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return randomUUID();
}

/** Bumped whenever SCHEMA changes, with a migration from the previous version. */
const SCHEMA_VERSION = 13;

/** The oldest workspace that migrations can upgrade; anything older is refused. */
const OLDEST_MIGRATABLE_VERSION = 12;

/** SQL that upgrades a workspace from the keyed version to the next one. */
const MIGRATIONS: Readonly<Record<number, string>> = {
  12: CHAPTERS_SCHEMA,
};

/** Ready-made stats a fresh workspace's bank starts with; deleting one is permanent. */
const STAT_BANK_SEED: ReadonlyArray<StatFields> = [
  { applies_to: "character", label: "Health", description: "Physical condition. Low health limits what they can attempt and how hard they can push.", low_label: "dying", high_label: "unharmed", min: 0, max: 10, default_value: 10, color: "red" },
  { applies_to: "character", label: "Stamina", description: "Energy for exertion. Low stamina means they tire quickly and need rest.", low_label: "spent", high_label: "fresh", min: 0, max: 10, default_value: 10, color: "amber" },
  { applies_to: "character", label: "Stress", description: "Mental strain. High stress shows in mistakes, short tempers, and rash choices.", low_label: "calm", high_label: "breaking point", min: 0, max: 10, default_value: 0, color: "violet" },
  { applies_to: "character", label: "Morale", description: "Hope and resolve. Low morale makes them hesitant; high morale makes them bold.", low_label: "hopeless", high_label: "resolute", min: 0, max: 10, default_value: 5, color: "blue" },
  { applies_to: "relationship", label: "Trust", description: "How much the source relies on the target's word and intentions.", low_label: "none", high_label: "complete", min: 0, max: 10, default_value: 5, color: "teal" },
  { applies_to: "relationship", label: "Affection", description: "How warmly the source feels toward the target.", low_label: "cold", high_label: "devoted", min: 0, max: 10, default_value: 5, color: "pink" },
  { applies_to: "relationship", label: "Respect", description: "How highly the source regards the target's abilities and judgment.", low_label: "contempt", high_label: "admiration", min: 0, max: 10, default_value: 5, color: "green" },
  { applies_to: "relationship", label: "Tension", description: "Unresolved friction between them. High tension colors every exchange.", low_label: "at ease", high_label: "hostile", min: 0, max: 10, default_value: 0, color: "orange" },
];

/** Replaces every card of `presetId` with the defaults, in order and enabled. */
export function insertDefaultPromptCards(db: Database, presetId: string): void {
  const now = nowIso();
  db.query("DELETE FROM prompt_cards WHERE preset_id = ?").run(presetId);
  const insert = db.query(
    "INSERT INTO prompt_cards (id, preset_id, title, body, enabled, position, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
  );
  DEFAULT_PROMPT_CARDS.forEach((card, index) => insert.run(newId(), presetId, card.title, card.body, index + 1, now, now));
}

/**
 * Opens the workspace database with foreign keys and the schema in place. A
 * fresh one gets the stat bank and prompt card seeds. An older workspace is
 * copied to `backups/` next to it and then migrated in one transaction;
 * one too old to migrate, or from a newer Storyfold, is refused untouched.
 */
export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: true });
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  const populated = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1").get() !== null;
  if (populated && version < OLDEST_MIGRATABLE_VERSION) {
    db.close();
    throw new Error(
      `${path} predates the world-as-save model (schema ${version}, expected ${SCHEMA_VERSION}); delete it to start fresh (it cannot be migrated)`,
    );
  }
  if (populated && version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`${path} was written by a newer Storyfold (schema ${version}, expected ${SCHEMA_VERSION}); update Storyfold to open it`);
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  if (populated) {
    if (version < SCHEMA_VERSION) migrate(db, path, version);
    return db;
  }
  db.transaction(() => {
    db.exec(SCHEMA);
    const now = nowIso();
    const insert = db.query(
      `INSERT INTO stat_definitions
         (id, world_id, applies_to, label, description, low_label, high_label, min, max, default_value, color, created_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const stat of STAT_BANK_SEED) {
      insert.run(newId(), stat.applies_to, stat.label, stat.description, stat.low_label, stat.high_label, stat.min, stat.max, stat.default_value, stat.color, now, now);
    }
    const presetId = newId();
    db.query("INSERT INTO prompt_presets (id, name, active, created_at, updated_at) VALUES (?, 'Default', 1, ?, ?)").run(presetId, now, now);
    insertDefaultPromptCards(db, presetId);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
  return db;
}

/**
 * Snapshots the workspace into `backups/storyfold-schema<version>-<time>.db`
 * (an in-memory database has nothing to keep), then applies every migration
 * from `version` up in one transaction, so a failure leaves it as it was.
 */
function migrate(db: Database, path: string, version: number): void {
  if (path !== ":memory:") {
    const directory = join(dirname(path), "backups");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stamp = nowIso().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
    const backup = join(directory, `storyfold-schema${version}-${stamp}.db`);
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }
  db.transaction(() => {
    for (let from = version; from < SCHEMA_VERSION; from++) db.exec(MIGRATIONS[from]!);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  })();
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
