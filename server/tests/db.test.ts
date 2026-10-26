import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROMPT_CARDS } from "../../shared/narration";
import { createChat } from "../chats";
import { openDatabase, sweepAbandonedPending } from "../db";
import { listPromptCards } from "../promptCards";
import { createCharacter, createWorld, listStatDefinitions, parseCharacterInput } from "../worlds";

const NOW = "2026-01-01T00:00:00Z";

let db: Database;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function seedChat(): { worldId: string; chatId: string; protagonistId: string } {
  const world = createWorld(db, { name: "Invariant World", setting_brief: "Brief." });
  const hero = createCharacter(db, world.id, parseCharacterInput({ name: "Invariant Hero", description: "Desc." }))!;
  const chat = createChat(db, world.id, { protagonist_id: hero.id, opening: "" })!;
  return { worldId: world.id, chatId: chat.id, protagonistId: hero.id };
}

function insertMessage(
  chatId: string,
  position: number,
  role: string,
  status: string,
  content = "x",
  selected = 1,
): string {
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO messages (id, chat_id, position, role, speaker_name, content, status, selected, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Narrator', ?, ?, ?, ?, ?)`,
  ).run(id, chatId, position, role, content, status, selected, NOW, NOW);
  return id;
}

describe("schema version", () => {
  test("a fresh workspace is seeded with the stat bank and prompt cards; reopening keeps them", () => {
    const directory = mkdtempSync(join(tmpdir(), "storyfold-schema-"));
    try {
      const path = join(directory, "fresh.db");
      const first = openDatabase(path);
      first.exec("UPDATE prompt_cards SET body = 'Edited.' WHERE position = 1");
      first.close();

      const reopened = openDatabase(path);
      try {
        expect(reopened.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(8);
        expect(listStatDefinitions(reopened, null)).toHaveLength(8);
        const cards = listPromptCards(reopened);
        expect(cards.map((card) => card.title)).toEqual(DEFAULT_PROMPT_CARDS.map((card) => card.title));
        expect(cards[0]!.body).toBe("Edited.");
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a workspace from an older schema is refused with its path and left untouched", () => {
    const directory = mkdtempSync(join(tmpdir(), "storyfold-schema-"));
    try {
      for (const version of [1, 3, 7]) {
        const path = join(directory, `v${version}.db`);
        const stale = new Database(path, { create: true });
        stale.exec("CREATE TABLE campaigns (id TEXT PRIMARY KEY)");
        stale.exec(`PRAGMA user_version = ${version}`);
        stale.close();

        expect(() => openDatabase(path)).toThrow(path);
        expect(() => openDatabase(path)).toThrow("predates the world-as-save model");

        const after = new Database(path);
        expect(after.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(version);
        expect(after.query("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([{ name: "campaigns" }]);
        after.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("schema invariants", () => {
  test("a chat's protagonist must be a character of the chat's world", () => {
    const { worldId } = seedChat();
    const other = createWorld(db, { name: "Other", setting_brief: "Elsewhere." });
    const stranger = createCharacter(db, other.id, parseCharacterInput({ name: "Stranger", description: "Foreign." }))!;
    const insert = () =>
      db
        .query(
          "INSERT INTO chats (id, world_id, protagonist_id, title, opening, created_at, updated_at) VALUES (?, ?, ?, 'T', '', ?, ?)",
        )
        .run(crypto.randomUUID(), worldId, stranger.id, NOW, NOW);
    expect(insert).toThrow(/FOREIGN KEY/);
  });

  test("a relationship cannot join characters of different worlds", () => {
    const { worldId, protagonistId } = seedChat();
    const other = createWorld(db, { name: "Other", setting_brief: "Elsewhere." });
    const stranger = createCharacter(db, other.id, parseCharacterInput({ name: "Stranger", description: "Foreign." }))!;
    const insert = () =>
      db
        .query(
          `INSERT INTO relationships (id, world_id, source_id, target_id, how_met, status, known_facts, stats, created_at, updated_at)
           VALUES (?, ?, ?, ?, '', '', '[]', '{}', ?, ?)`,
        )
        .run(crypto.randomUUID(), worldId, protagonistId, stranger.id, NOW, NOW);
    expect(insert).toThrow(/FOREIGN KEY/);
  });

  test("message positions are unique per chat and persist in order", () => {
    const { chatId } = seedChat();
    const first = insertMessage(chatId, 1, "user", "complete");
    const second = insertMessage(chatId, 2, "user", "complete");
    // A second selected row at one position violates the partial unique index.
    expect(() => insertMessage(chatId, 2, "user", "complete")).toThrow(/UNIQUE/);
    // An unselected alternate may share the position with the selected row.
    const alternate = insertMessage(chatId, 2, "assistant", "complete", "x", 0);
    const rows = db
      .query<{ id: string; position: number }, [string]>(
        "SELECT id, position FROM messages WHERE chat_id = ? ORDER BY position, selected",
      )
      .all(chatId);
    expect(rows).toEqual([
      { id: first, position: 1 },
      { id: alternate, position: 2 },
      { id: second, position: 2 },
    ]);
  });

  test("only narration has alternates and exactly one row per position is selected", () => {
    const { chatId } = seedChat();
    expect(() => insertMessage(chatId, 1, "user", "complete", "x", 0)).toThrow();
    expect(() => insertMessage(chatId, 1, "assistant", "complete", "x", 2)).toThrow();
    const swipe = insertMessage(chatId, 1, "assistant", "complete", "older", 0);
    const chosen = insertMessage(chatId, 1, "assistant", "complete", "newer");
    const rows = db
      .query<{ id: string; content: string; selected: number }, [string]>(
        "SELECT id, content, selected FROM messages WHERE chat_id = ? ORDER BY selected, rowid",
      )
      .all(chatId);
    expect(rows).toEqual([
      { id: swipe, content: "older", selected: 0 },
      { id: chosen, content: "newer", selected: 1 },
    ]);
  });

  test("only one pending assistant reply may exist per chat, and settlement frees the slot", () => {
    const { chatId } = seedChat();
    const first = insertMessage(chatId, 1, "assistant", "pending");
    expect(() => insertMessage(chatId, 2, "assistant", "pending")).toThrow();
    db.query("UPDATE messages SET status = 'interrupted' WHERE id = ? AND status = 'pending'").run(first);
    const second = insertMessage(chatId, 2, "assistant", "pending");
    const rows = db
      .query<{ id: string; status: string }, [string]>("SELECT id, status FROM messages WHERE chat_id = ? ORDER BY position")
      .all(chatId);
    expect(rows).toEqual([
      { id: first, status: "interrupted" },
      { id: second, status: "pending" },
    ]);
  });

  test("roles, statuses and user completion are constrained and persisted", () => {
    const { chatId } = seedChat();
    expect(() => insertMessage(chatId, 1, "narrator", "complete")).toThrow();
    expect(() => insertMessage(chatId, 2, "user", "pending")).toThrow();
    const kept = insertMessage(chatId, 3, "assistant", "complete");
    const row = db
      .query<{ id: string; role: string; status: string }, [string]>("SELECT id, role, status FROM messages WHERE id = ?")
      .get(kept)!;
    expect(row).toEqual({ id: kept, role: "assistant", status: "complete" });
  });

  test("deleting a character removes its relationships but a protagonist is protected by the key", () => {
    const { worldId, protagonistId } = seedChat();
    expect(() => db.query("DELETE FROM characters WHERE id = ?").run(protagonistId)).toThrow(/FOREIGN KEY/);
    const friend = createCharacter(db, worldId, parseCharacterInput({ name: "Friend", description: "Pal." }))!;
    db.query(
      `INSERT INTO relationships (id, world_id, source_id, target_id, how_met, status, known_facts, stats, created_at, updated_at)
       VALUES ('r1', ?, ?, ?, '', '', '[]', '{}', ?, ?)`,
    ).run(worldId, protagonistId, friend.id, NOW, NOW);
    db.query("DELETE FROM characters WHERE id = ?").run(friend.id);
    expect(db.query("SELECT 1 FROM relationships").all()).toEqual([]);
  });
});

describe("startup sweep", () => {
  test("settles only the pending draft interrupted and preserves partial, input and identity", () => {
    const { chatId } = seedChat();
    const draftId = insertMessage(chatId, 1, "assistant", "pending", "partial text");
    const inputId = insertMessage(chatId, 2, "user", "complete", "accepted input");

    expect(sweepAbandonedPending(db)).toBe(1);
    const rows = db
      .query<
        { id: string; position: number; role: string; speaker_name: string; content: string; status: string },
        [string]
      >("SELECT id, position, role, speaker_name, content, status FROM messages WHERE chat_id = ? ORDER BY position")
      .all(chatId);
    expect(rows).toEqual([
      { id: draftId, position: 1, role: "assistant", speaker_name: "Narrator", content: "partial text", status: "interrupted" },
      { id: inputId, position: 2, role: "user", speaker_name: "Narrator", content: "accepted input", status: "complete" },
    ]);
    expect(sweepAbandonedPending(db)).toBe(0);
  });
});
