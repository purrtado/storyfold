import type { Database } from "bun:sqlite";
import type { Chat } from "../shared/domain";
import { NARRATION_TOKEN_BUDGET } from "../shared/narration";
import { countTokens } from "../shared/tokens";
import { newId, nowIso } from "./db";
import { chatSystemPrompt } from "./grounding";
import { UnknownEntityError, ValidationError, getCharacter, getWorld, optionalText, requiredText } from "./worlds";

const TITLE_FROM_OPENING_CHARS = 60;
const DEFAULT_TITLE = "New chat";

export interface ChatInput {
  protagonist_id: string;
  opening: string;
  title?: string;
}

export function parseChatInput(body: Record<string, unknown>): ChatInput {
  const { protagonist_id } = body;
  if (typeof protagonist_id !== "string" || protagonist_id.length === 0) {
    throw new ValidationError("protagonist_id must be a non-empty string");
  }
  return {
    protagonist_id,
    opening: body.opening === undefined ? "" : optionalText(body.opening, "opening"),
    ...(body.title !== undefined ? { title: requiredText(body.title, "title") } : {}),
  };
}

export function parseChatPatch(body: Record<string, unknown>): { title: string } {
  return { title: requiredText(body.title, "title") };
}

/** The first line of the opening, or a generic name when there is none. */
function defaultTitle(opening: string): string {
  const line = opening.trim().split(/\r?\n/, 1)[0]!.trim().slice(0, TITLE_FROM_OPENING_CHARS).trim();
  return line === "" ? DEFAULT_TITLE : line;
}

/** Most recently updated first; rowid breaks same-instant ties newest first. */
const CHAT_ORDER = "ORDER BY updated_at DESC, rowid DESC";

/** Across every world when `worldId` is omitted. */
export function listChats(db: Database, worldId?: string): Chat[] {
  return worldId === undefined
    ? db.query<Chat, []>(`SELECT * FROM chats ${CHAT_ORDER}`).all()
    : db.query<Chat, [string]>(`SELECT * FROM chats WHERE world_id = ? ${CHAT_ORDER}`).all(worldId);
}

export function getChat(db: Database, id: string): Chat | null {
  return db.query<Chat, [string]>("SELECT * FROM chats WHERE id = ?").get(id) ?? null;
}

/**
 * A new playthrough of the world. The protagonist must be a character of that
 * world, and the world as it stands must still leave room in the narration
 * budget for an opening; either way nothing is created otherwise. Null when
 * the world is unknown.
 */
export function createChat(db: Database, worldId: string, input: ChatInput): Chat | null {
  if (!getWorld(db, worldId)) return null;
  const protagonist = getCharacter(db, input.protagonist_id);
  if (!protagonist || protagonist.world_id !== worldId) {
    throw new UnknownEntityError("protagonist_id does not match a character of this world");
  }
  const now = nowIso();
  const chat: Chat = {
    id: newId(),
    world_id: worldId,
    protagonist_id: protagonist.id,
    title: input.title ?? defaultTitle(input.opening),
    opening: input.opening,
    created_at: now,
    updated_at: now,
  };
  const openingTokens = countTokens(chatSystemPrompt(db, chat, false));
  if (openingTokens > NARRATION_TOKEN_BUDGET) {
    throw new ValidationError(`the opening prompt is ${openingTokens} tokens; the budget is ${NARRATION_TOKEN_BUDGET}`);
  }
  db.query(
    `INSERT INTO chats (id, world_id, protagonist_id, title, opening, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(chat.id, chat.world_id, chat.protagonist_id, chat.title, chat.opening, now, now);
  return chat;
}

export function renameChat(db: Database, id: string, title: string): Chat | null {
  const existing = getChat(db, id);
  if (!existing) return null;
  const next: Chat = { ...existing, title, updated_at: nowIso() };
  db.query("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").run(title, next.updated_at, id);
  return next;
}

/** Discard: the chat and its whole transcript, every alternate included. */
export function deleteChat(db: Database, id: string): boolean {
  const remove = db.transaction(() => {
    db.query("DELETE FROM messages WHERE chat_id = ?").run(id);
    return db.query("DELETE FROM chats WHERE id = ?").run(id).changes > 0;
  });
  return remove();
}

/**
 * "Branch from here": a new chat in the same world with the same protagonist
 * and opening, carrying the selected messages up to and including the chosen
 * one — drafts and unselected alternates excluded — renumbered from 1 with
 * their timestamps kept. Null when the chat or the message does not exist
 * (message ids are chat-scoped).
 */
export function branchChat(db: Database, chatId: string, messageId: string, title?: string): Chat | null {
  const branch = db.transaction((): Chat | null => {
    const source = getChat(db, chatId);
    if (!source) return null;
    const message = db
      .query<{ position: number }, [string, string]>(
        `SELECT position FROM messages
         WHERE id = ? AND chat_id = ? AND selected = 1 AND (role = 'user' OR status = 'complete')`,
      )
      .get(messageId, chatId);
    if (!message) return null;

    const now = nowIso();
    const chat: Chat = {
      ...source,
      id: newId(),
      title: title ?? `${source.title} (branch)`,
      created_at: now,
      updated_at: now,
    };
    db.query(
      `INSERT INTO chats (id, world_id, protagonist_id, title, opening, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(chat.id, chat.world_id, chat.protagonist_id, chat.title, chat.opening, now, now);

    const history = db
      .query<
        {
          role: string;
          speaker_name: string;
          content: string;
          status: string;
          direction: string | null;
          lore: string | null;
          created_at: string;
          updated_at: string;
        },
        [string, number]
      >(
        `SELECT role, speaker_name, content, status, direction, lore, created_at, updated_at FROM messages
         WHERE chat_id = ? AND selected = 1 AND position <= ?
           AND (role = 'user' OR status = 'complete')
         ORDER BY position`,
      )
      .all(chatId, message.position);
    const insert = db.query(
      `INSERT INTO messages
         (id, chat_id, position, role, speaker_name, content, status, direction, lore, selected, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    history.forEach((row, index) => {
      insert.run(
        newId(),
        chat.id,
        index + 1,
        row.role,
        row.speaker_name,
        row.content,
        row.status,
        row.direction,
        row.lore,
        row.created_at,
        row.updated_at,
      );
    });
    return chat;
  });
  return branch.immediate();
}
