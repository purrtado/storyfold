import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCampaign, createCharacter, createWorld, parseCharacterInput } from "../library";
import { openDatabase, sweepAbandonedPending } from "../db";

const NOW = "2026-01-01T00:00:00Z";

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function seedLibrary(): { worldId: string; protagonistId: string } {
  const world = createWorld(db, {
    name: "Invariant World",
    setting_brief: "Brief.",
    suggested_starting_situation: "",
  });
  const protagonist = createCharacter(db, parseCharacterInput({ name: "Invariant Hero", description: "Desc." }));
  return { worldId: world.id, protagonistId: protagonist.id };
}

function insertMessage(
  sessionId: string,
  position: number,
  role: string,
  status: string,
  content = "x",
  selected = 1,
): string {
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO messages (id, session_id, position, role, speaker_name, content, status, selected, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Narrator', ?, ?, ?, ?, ?)`,
  ).run(id, sessionId, position, role, content, status, selected, NOW, NOW);
  return id;
}

function campaignRows(): Array<Record<string, unknown>> {
  return db.query<Record<string, unknown>, []>("SELECT * FROM campaigns").all();
}

describe("schema version", () => {
  test("a workspace from another schema is refused; one this build wrote reopens", () => {
    const directory = mkdtempSync(join(tmpdir(), "storyfold-schema-"));
    try {
      const stalePath = join(directory, "stale.db");
      const stale = new Database(stalePath, { create: true });
      stale.exec("CREATE TABLE worlds (id TEXT PRIMARY KEY)");
      stale.close();
      expect(() => openDatabase(stalePath)).toThrow("delete it to start fresh");

      const currentPath = join(directory, "current.db");
      openDatabase(currentPath).close();
      openDatabase(currentPath).close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a version 3 workspace keeps its transcript and gains narration directions", () => {
    const directory = mkdtempSync(join(tmpdir(), "storyfold-schema-"));
    try {
      const path = join(directory, "v3.db");
      db.close();
      db = openDatabase(path);
      const { worldId, protagonistId } = seedLibrary();
      const { session } = createCampaign(db, { world_id: worldId, protagonist_id: protagonistId, starting_situation: "" });
      const messageId = insertMessage(session.id, 1, "assistant", "complete", "Kept narration.");
      db.exec("ALTER TABLE messages DROP COLUMN direction");
      db.exec("PRAGMA user_version = 3");
      db.close();

      db = openDatabase(path);
      expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(4);
      expect(db.query("SELECT content, direction FROM messages WHERE id = ?").get(messageId)).toEqual({
        content: "Kept narration.",
        direction: null,
      });
    } finally {
      db.close();
      db = openDatabase(":memory:");
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("schema invariants", () => {
  test("active session must belong to its own campaign at commit", () => {
    const { worldId, protagonistId } = seedLibrary();
    const { campaign, session } = createCampaign(db, {
      world_id: worldId,
      protagonist_id: protagonistId,
      starting_situation: "One.",
      name: "Owner",
    });
    expect(campaign.active_session_id).toBe(session.id);

    // A second campaign pointing at the first campaign's session violates the
    // deferred composite key exactly at COMMIT, even though both rows exist.
    const steal = db.transaction(() => {
      db.query(
        `INSERT INTO campaigns
           (id, name, world_id, world_snapshot, starting_situation, active_session_id, created_at, updated_at)
         VALUES ('c2', 'Thief', ?, '{"name":"W","setting_brief":"b","entries":[]}', 'Two.', ?, ?, ?)`,
      ).run(worldId, session.id, NOW, NOW);
    });
    expect(() => steal.immediate()).toThrow(/FOREIGN KEY/);
    expect(campaignRows().map((row) => row.id)).toEqual([campaign.id]);
    const survived = db
      .query<{ id: string; active_session_id: string }, [string]>(
        "SELECT id, active_session_id FROM campaigns WHERE id = ?",
      )
      .get(campaign.id)!;
    expect(survived.active_session_id).toBe(session.id);
  });

  test("message positions are unique per session and persist in order", () => {
    const { worldId, protagonistId } = seedLibrary();
    const { session } = createCampaign(db, {
      world_id: worldId,
      protagonist_id: protagonistId,
      starting_situation: "Order.",
    });
    const first = insertMessage(session.id, 1, "user", "complete");
    const second = insertMessage(session.id, 2, "user", "complete");
    // A second selected row at one position violates the partial unique index.
    expect(() => insertMessage(session.id, 2, "user", "complete")).toThrow(/UNIQUE/);
    // An unselected alternate may share the position with the selected row.
    const alternate = insertMessage(session.id, 2, "assistant", "complete", "x", 0);
    const rows = db
      .query<{ id: string; position: number }, [string]>(
        "SELECT id, position FROM messages WHERE session_id = ? ORDER BY position, selected",
      )
      .all(session.id);
    expect(rows).toEqual([
      { id: first, position: 1 },
      { id: alternate, position: 2 },
      { id: second, position: 2 },
    ]);
  });

  test("only narration has alternates and exactly one row per position is selected", () => {
    const { worldId, protagonistId } = seedLibrary();
    const { session } = createCampaign(db, {
      world_id: worldId,
      protagonist_id: protagonistId,
      starting_situation: "Swipe.",
    });
    expect(() => insertMessage(session.id, 1, "user", "complete", "x", 0)).toThrow();
    expect(() => insertMessage(session.id, 1, "assistant", "complete", "x", 2)).toThrow();
    const swipe = insertMessage(session.id, 1, "assistant", "complete", "older", 0);
    const chosen = insertMessage(session.id, 1, "assistant", "complete", "newer");
    const rows = db
      .query<{ id: string; content: string; selected: number }, [string]>(
        "SELECT id, content, selected FROM messages WHERE session_id = ? ORDER BY selected, rowid",
      )
      .all(session.id);
    expect(rows).toEqual([
      { id: swipe, content: "older", selected: 0 },
      { id: chosen, content: "newer", selected: 1 },
    ]);
  });

  test("only one pending assistant reply may exist per session, and settlement frees the slot", () => {
    const { worldId, protagonistId } = seedLibrary();
    const { session } = createCampaign(db, {
      world_id: worldId,
      protagonist_id: protagonistId,
      starting_situation: "Excl.",
    });
    const first = insertMessage(session.id, 1, "assistant", "pending");
    expect(() => insertMessage(session.id, 2, "assistant", "pending")).toThrow();
    // Settling the first reply releases the exclusivity slot.
    db.query(
      "UPDATE messages SET status = 'interrupted' WHERE id = ? AND status = 'pending'",
    ).run(first);
    const second = insertMessage(session.id, 2, "assistant", "pending");
    const rows = db
      .query<{ id: string; status: string }, [string]>(
        "SELECT id, status FROM messages WHERE session_id = ? ORDER BY position",
      )
      .all(session.id);
    expect(rows).toEqual([
      { id: first, status: "interrupted" },
      { id: second, status: "pending" },
    ]);
  });

  test("multiple sessions may share one campaign", () => {
    const { worldId, protagonistId } = seedLibrary();
    const { campaign } = createCampaign(db, {
      world_id: worldId,
      protagonist_id: protagonistId,
      starting_situation: "Multi.",
    });
    const extra = crypto.randomUUID();
    db.query(
      "INSERT INTO sessions (id, campaign_id, ordinal, title, created_at, updated_at) VALUES (?, ?, 2, 'Second', ?, ?)",
    ).run(extra, campaign.id, NOW, NOW);
    const sessions = db
      .query<{ id: string }, [string]>("SELECT id FROM sessions WHERE campaign_id = ?")
      .all(campaign.id);
    expect(sessions.map((row) => row.id).sort()).toEqual([campaign.active_session_id, extra].sort());
  });

  test("roles, statuses and user completion are constrained and persisted", () => {
    const { worldId, protagonistId } = seedLibrary();
    const { session } = createCampaign(db, {
      world_id: worldId,
      protagonist_id: protagonistId,
      starting_situation: "Check.",
    });
    expect(() => insertMessage(session.id, 1, "narrator", "complete")).toThrow();
    expect(() => insertMessage(session.id, 2, "user", "pending")).toThrow();
    const kept = insertMessage(session.id, 3, "assistant", "complete");
    const row = db
      .query<{ id: string; role: string; status: string }, [string]>(
        "SELECT id, role, status FROM messages WHERE id = ?",
      )
      .get(kept)!;
    expect(row).toEqual({ id: kept, role: "assistant", status: "complete" });
  });

  test("snapshot columns refuse non-JSON text", () => {
    const { worldId } = seedLibrary();
    const sessionId = crypto.randomUUID();
    const broken = db.transaction(() => {
      db.query(
        `INSERT INTO campaigns
           (id, name, world_id, world_snapshot, starting_situation, active_session_id, created_at, updated_at)
         VALUES (?, 'Broken', ?, 'not json', 'x', ?, ?, ?)`,
      ).run(crypto.randomUUID(), worldId, sessionId, NOW, NOW);
      db.query(
        "INSERT INTO sessions (id, campaign_id, title, created_at, updated_at) VALUES (?, ?, 'T', ?, ?)",
      ).run(sessionId, db.query<{ id: string }, []>("SELECT id FROM campaigns WHERE name = 'Broken'").get()!.id, NOW, NOW);
    });
    expect(() => broken.immediate()).toThrow();
    expect(campaignRows()).toEqual([]);
  });
});

describe("startup sweep", () => {
  test("settles only the pending draft interrupted and preserves partial, input and identity", () => {
    const { worldId, protagonistId } = seedLibrary();
    const { session } = createCampaign(db, {
      world_id: worldId,
      protagonist_id: protagonistId,
      starting_situation: "Crash.",
    });
    const draftId = insertMessage(session.id, 1, "assistant", "pending", "partial text");
    const inputId = insertMessage(session.id, 2, "user", "complete", "accepted input");

    expect(sweepAbandonedPending(db)).toBe(1);
    const rows = db
      .query<
        { id: string; position: number; role: string; speaker_name: string; content: string; status: string },
        [string]
      >(
        "SELECT id, position, role, speaker_name, content, status FROM messages WHERE session_id = ? ORDER BY position",
      )
      .all(session.id);
    expect(rows).toEqual([
      { id: draftId, position: 1, role: "assistant", speaker_name: "Narrator", content: "partial text", status: "interrupted" },
      { id: inputId, position: 2, role: "user", speaker_name: "Narrator", content: "accepted input", status: "complete" },
    ]);
    // Sweeping again is a no-op.
    expect(sweepAbandonedPending(db)).toBe(0);
  });
});
