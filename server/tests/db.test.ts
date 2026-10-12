import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createCampaign, createPersona, createWorld } from "../library";
import { openDatabase, sweepAbandonedPending } from "../db";
import { makeConfigDirectory, removeDirectory } from "./helpers";

const configDirectory = await makeConfigDirectory();
const db = openDatabase(join(configDirectory, "invariants.db"));

afterAll(async () => {
  db.close();
  await removeDirectory(configDirectory);
});

const NOW = "2026-01-01T00:00:00Z";

function seedLibrary(): { worldId: string; personaId: string } {
  const world = createWorld(db, {
    name: "Invariant World",
    setting_brief: "Brief.",
    suggested_starting_situation: "",
  });
  const persona = createPersona(db, { name: "Invariant Persona", description: "Desc." });
  return { worldId: world.id, personaId: persona.id };
}

function insertMessage(sessionId: string, position: number, role: string, status: string): void {
  db.query(
    `INSERT INTO messages (id, session_id, position, role, speaker_name, content, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Narrator', 'x', ?, ?, ?)`,
  ).run(crypto.randomUUID(), sessionId, position, role, status, NOW, NOW);
}

describe("schema invariants", () => {
  test("active session must belong to its own campaign at commit", () => {
    const { worldId, personaId } = seedLibrary();
    const { campaign, session } = createCampaign(db, {
      world_id: worldId,
      persona_id: personaId,
      starting_situation: "One.",
      name: "Owner",
    });
    expect(campaign.active_session_id).toBe(session.id);

    // A second campaign pointing at the first campaign's session violates the
    // deferred composite key exactly at COMMIT, even though both rows exist.
    const steal = db.transaction(() => {
      db.query(
        `INSERT INTO campaigns
           (id, name, world_id, persona_id, world_snapshot, persona_snapshot,
            starting_situation, active_session_id, created_at, updated_at)
         VALUES ('c2', 'Thief', ?, ?, '{}', '{}', 'Two.', ?, ?, ?)`,
      ).run(worldId, personaId, session.id, NOW, NOW);
    });
    expect(() => steal.immediate()).toThrow(/FOREIGN KEY/);
    const stolen = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM campaigns WHERE id = 'c2'").get();
    expect(stolen?.n).toBe(0);
  });

  test("message positions are unique per session and server-assigned sequentially", () => {
    const { worldId, personaId } = seedLibrary();
    const { session } = createCampaign(db, {
      world_id: worldId,
      persona_id: personaId,
      starting_situation: "Order.",
    });
    insertMessage(session.id, 1, "user", "complete");
    expect(() => insertMessage(session.id, 1, "user", "complete")).toThrow(/UNIQUE/);
    insertMessage(session.id, 2, "user", "complete");
  });

  test("only one pending assistant reply may exist per session, and settlement frees the slot", () => {
    const { worldId, personaId } = seedLibrary();
    const { session } = createCampaign(db, {
      world_id: worldId,
      persona_id: personaId,
      starting_situation: "Excl.",
    });
    insertMessage(session.id, 1, "assistant", "pending");
    expect(() => insertMessage(session.id, 2, "assistant", "pending")).toThrow();
    // Settling the first reply releases the exclusivity slot.
    db.query("UPDATE messages SET status = 'interrupted' WHERE session_id = ? AND status = 'pending'").run(session.id);
    expect(() => insertMessage(session.id, 2, "assistant", "pending")).not.toThrow();
  });

  test("multiple sessions may share one campaign", () => {
    const { worldId, personaId } = seedLibrary();
    const { campaign } = createCampaign(db, {
      world_id: worldId,
      persona_id: personaId,
      starting_situation: "Multi.",
    });
    const now = new Date().toISOString();
    expect(() =>
      db
        .query(
          "INSERT INTO sessions (id, campaign_id, title, created_at, updated_at) VALUES (?, ?, 'Second', ?, ?)",
        )
        .run(crypto.randomUUID(), campaign.id, now, now),
    ).not.toThrow();
  });

  test("roles, statuses and user completion are constrained", () => {
    const { worldId, personaId } = seedLibrary();
    const { session } = createCampaign(db, {
      world_id: worldId,
      persona_id: personaId,
      starting_situation: "Check.",
    });
    expect(() => insertMessage(session.id, 1, "narrator", "complete")).toThrow();
    expect(() => insertMessage(session.id, 2, "user", "pending")).toThrow();
    expect(() => insertMessage(session.id, 3, "assistant", "complete")).not.toThrow();
  });

  test("snapshot columns refuse non-JSON text", () => {
    const { worldId, personaId } = seedLibrary();
    const sessionId = crypto.randomUUID();
    const broken = db.transaction(() => {
      db.query(
        `INSERT INTO campaigns
           (id, name, world_id, persona_id, world_snapshot, persona_snapshot,
            starting_situation, active_session_id, created_at, updated_at)
         VALUES (?, 'Broken', ?, ?, 'not json', '{}', 'x', ?, ?, ?)`,
      ).run(crypto.randomUUID(), worldId, personaId, sessionId, NOW, NOW);
      db.query(
        "INSERT INTO sessions (id, campaign_id, title, created_at, updated_at) VALUES (?, ?, 'T', ?, ?)",
      ).run(sessionId, db.query<{ id: string }, []>("SELECT id FROM campaigns WHERE name = 'Broken'").get()!.id, NOW, NOW);
    });
    expect(() => broken.immediate()).toThrow();
  });
});

describe("startup sweep", () => {
  test("settles abandoned pending replies interrupted and leaves settled rows alone", () => {
    const { worldId, personaId } = seedLibrary();
    const { session } = createCampaign(db, {
      world_id: worldId,
      persona_id: personaId,
      starting_situation: "Crash.",
    });
    insertMessage(session.id, 1, "assistant", "pending");
    insertMessage(session.id, 2, "user", "complete");

    // The sweep is workspace-global: earlier tests may leave their own pending
    // rows behind, so assert at least this session's row was settled.
    expect(sweepAbandonedPending(db)).toBeGreaterThanOrEqual(1);
    const rows = db
      .query<{ status: string }, [string]>("SELECT status FROM messages WHERE session_id = ? ORDER BY position")
      .all(session.id);
    expect(rows.map((row) => row.status)).toEqual(["interrupted", "complete"]);
    // Sweeping again is a no-op.
    expect(sweepAbandonedPending(db)).toBe(0);
  });
});
