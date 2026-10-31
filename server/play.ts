import type { Database } from "bun:sqlite";
import type { Message, MessageLore, MessageUsage } from "../shared/domain";
import { NARRATION_TOKEN_BUDGET, directionNote, openingMessage } from "../shared/narration";
import { countTokens } from "../shared/tokens";
import { newId, nowIso } from "./db";
import { selectReplyContext, type LoreSelection } from "./lore";
import { getChat } from "./chats";
import { chatGrounding, chatSystemPrompt } from "./grounding";
import { UnknownEntityError, ValidationError } from "./worlds";
import { MAX_MESSAGE_CHARS, type NarrationMessage } from "./chat";
import { ReplyRuns, type PlaySettings } from "./runs";


export const NARRATOR_NAME = "Narrator";

/** A reply is already being generated for this chat; nothing was saved. */
export class BusyError extends Error {}

/** The chat already contains completed opening narration. */
export class AlreadyOpenedError extends Error {}

/** Accepting this request would pass the narration budget. */
export class ContextLimitError extends Error {}

/** The chat has no messages to regenerate. */
export class NothingToRegenerateError extends Error {}

/** Selection and swipe deletion exist only on the trailing narration. */
export class NotTrailingError extends Error {}

/** The last remaining alternate was offered to a swipe delete. */
export class SoleVariantError extends Error {}

/** Only completed messages can be edited. */
export class NotEditableError extends Error {}

export interface ReservedTurn {
  playerId: string | null;
  pendingId: string;
}

/**
 * Wire transcript row: `variant_ids` (oldest first) and `variant_index`
 * describe the trailing narration's alternates; every other row carries
 * `[]` / `0`.
 */
export interface TranscriptMessage extends Message {
  variant_ids: string[];
  variant_index: number;
}

/** Storage shape of a message: lore and usage are JSON text until parsed. */
type MessageRecord = Omit<Message, "lore" | "usage"> & { lore: string | null; usage: string | null };

/** Storage row including the selection flag; never sent to the client. */
interface MessageRow extends MessageRecord {
  selected: number;
}

const MESSAGE_COLUMNS =
  "id, chat_id, position, role, speaker_name, content, status, direction, lore, usage, reasoning, reasoning_ms, created_at, updated_at";

function messageFromRow({ selected: _selected, ...row }: MessageRecord & { selected?: number }): Message {
  return {
    ...row,
    lore: row.lore === null ? null : (JSON.parse(row.lore) as MessageLore),
    usage: row.usage === null ? null : (JSON.parse(row.usage) as MessageUsage),
  };
}

/**
 * Owns the server-side play lifecycle: reserving turns atomically, streaming
 * narration, and settling every pending reply exactly once. One Bun backend
 * means the in-memory registry covers every live generation.
 */
export class PlayService {
  private replies: ReplyRuns;

  constructor(private db: Database) {
    this.replies = new ReplyRuns(db, "messages", (messageId) => {
      this.db.query("UPDATE chats SET updated_at = ? WHERE id = (SELECT chat_id FROM messages WHERE id = ?)").run(nowIso(), messageId);
    });
  }

  /** Selected rows in position order; the trailing narration carries its alternates. */
  transcript(chatId: string): TranscriptMessage[] {
    const rows = this.db
      .query<MessageRecord, [string]>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE chat_id = ? AND selected = 1 ORDER BY position`,
      )
      .all(chatId);
    const plain = rows.map((row) => ({ ...messageFromRow(row), variant_ids: [], variant_index: 0 }));
    const trailing = plain.at(-1);
    if (!trailing || trailing.role !== "assistant") return plain;
    const variants = this.db
      .query<{ id: string; selected: number }, [string, number]>(
        "SELECT id, selected FROM messages WHERE chat_id = ? AND position = ? ORDER BY created_at, rowid",
      )
      .all(chatId, trailing.position);
    const selectedAt = variants.findIndex((variant) => variant.selected === 1);
    return [
      ...plain.slice(0, -1),
      { ...trailing, variant_ids: variants.map((variant) => variant.id), variant_index: Math.max(selectedAt, 0) },
    ];
  }

  getMessage(messageId: string): Message | null {
    const row = this.db.query<MessageRecord, [string]>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(messageId);
    return row ? messageFromRow(row) : null;
  }

  /** Accepted player input plus the reserved pending narration, one transaction. */
  reservePlayerTurn(chatId: string, content: string, speakerName: string, direction: string | null = null): ReservedTurn {
    const reserve = this.db.transaction(
      (id: string, text: string, speaker: string): ReservedTurn => {
        if (this.hasPending(id)) throw new BusyError("A reply is already being generated for this chat");
        const position = this.nextPosition(id);
        const playerId = newId();
        const pendingId = newId();
        const now = nowIso();
        this.insertMessage(id, position, "user", speaker, text, "complete", now, playerId, null);
        this.insertMessage(id, position + 1, "assistant", NARRATOR_NAME, "", "pending", now, pendingId, direction);
        // Checked against the history the model will actually receive; a refusal rolls the rows back.
        this.assertWithinBudget(id, directionTokens(direction));
        return { playerId, pendingId };
      },
    );
    return reserve.immediate(chatId, content, speakerName);
  }

  /**
   * Opening narration reserves only the pending row; no player input exists.
   * Every chat may open exactly once, and only from emptiness: once
   * any message exists — a settled opening, a draft, or accepted player input
   * — retries go through regeneration. All guards sit inside the reservation
   * transaction: a second /opening that raced the first can never reserve
   * after the first settled complete.
   */
  reserveOpening(chatId: string, direction: string | null = null): ReservedTurn {
    const reserve = this.db.transaction((id: string): ReservedTurn => {
      const existing = this.db
        .query<unknown, [string]>("SELECT 1 FROM messages WHERE chat_id = ? LIMIT 1")
        .get(id);
      if (existing) throw new AlreadyOpenedError("This chat has already opened");
      this.assertWithinBudget(id, directionTokens(direction));
      const pendingId = newId();
      this.insertMessage(
        id,
        this.nextPosition(id),
        "assistant",
        NARRATOR_NAME,
        "",
        "pending",
        nowIso(),
        pendingId,
        direction,
      );
      return { playerId: null, pendingId };
    });
    return reserve.immediate(chatId);
  }

  /**
   * Regeneration adds a selected pending alternate at the trailing narration's
   * position: complete alternates stay as swipes, failed or interrupted drafts
   * are discarded. A chat ending on a player turn reserves a fresh reply;
   * an empty chat has nothing to regenerate.
   */
  reserveRegeneration(chatId: string, direction: string | null = null): ReservedTurn {
    const reserve = this.db.transaction((id: string): ReservedTurn => {
      if (this.hasPending(id)) throw new BusyError("A reply is already being generated for this chat");
      const lastUser = this.db
        .query<Pick<Message, "id">, [string]>(
          "SELECT id FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY position DESC LIMIT 1",
        )
        .get(id);
      const trailing = this.db
        .query<MessageRow, [string]>(
          `SELECT ${MESSAGE_COLUMNS}, selected FROM messages
           WHERE chat_id = ? AND selected = 1 ORDER BY position DESC LIMIT 1`,
        )
        .get(id);
      if (!lastUser && !trailing) throw new NothingToRegenerateError("This chat has nothing to regenerate");
      let position: number;
      if (trailing && trailing.role === "assistant") {
        position = trailing.position;
        this.db
          .query("DELETE FROM messages WHERE chat_id = ? AND position = ? AND status IN ('failed', 'interrupted')")
          .run(id, position);
      } else {
        position = this.nextPosition(id);
      }
      this.db
        .query("UPDATE messages SET selected = 0 WHERE chat_id = ? AND position = ?")
        .run(id, position);
      this.assertWithinBudget(id, directionTokens(direction));
      const pendingId = newId();
      this.insertMessage(id, position, "assistant", NARRATOR_NAME, "", "pending", nowIso(), pendingId, direction);
      return { playerId: lastUser?.id ?? null, pendingId };
    });
    return reserve.immediate(chatId);
  }

  /**
   * Selects one alternate of the trailing narration; drafts left behind are
   * deleted. Anything else — a player message, older narration — is a
   * conflict; a foreign or unknown id is missing.
   */
  selectVariant(chatId: string, messageId: string): TranscriptMessage[] {
    const select = this.db.transaction((sid: string, id: string): TranscriptMessage[] => {
      if (this.hasPending(sid)) throw new BusyError("A reply is already being generated for this chat");
      const message = this.getChatMessage(sid, id);
      if (!message) throw new UnknownEntityError("Unknown message");
      if (message.role !== "assistant" || message.position !== this.maxPosition(sid)) {
        throw new NotTrailingError("Only the latest narration can be switched");
      }
      this.db
        .query("UPDATE messages SET selected = 0 WHERE chat_id = ? AND position = ?")
        .run(sid, message.position);
      this.db
        .query(
          "DELETE FROM messages WHERE chat_id = ? AND position = ? AND status IN ('failed', 'interrupted') AND id != ?",
        )
        .run(sid, message.position, id);
      this.db.query("UPDATE messages SET selected = 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
      return this.transcript(sid);
    });
    return select.immediate(chatId, messageId);
  }

  /**
   * Deletes one alternate of the trailing narration (scope "variant"; deleting
   * the shown one selects the newest remaining, and the sole alternate is
   * refused — delete the message instead), a message with all its alternates
   * (default), or the message and everything after it (scope "after").
   * Positions never shift: the next turn continues after the highest survivor.
   */
  deleteMessage(chatId: string, messageId: string, scope: "variant" | "after" | null): TranscriptMessage[] {
    const remove = this.db.transaction(
      (sid: string, id: string, cut: "variant" | "after" | null): TranscriptMessage[] => {
        if (this.hasPending(sid)) throw new BusyError("A reply is already being generated for this chat");
        const message = this.getChatMessage(sid, id);
        if (!message) throw new UnknownEntityError("Unknown message");
        if (cut === "variant") {
          if (message.role !== "assistant" || message.position !== this.maxPosition(sid)) {
            throw new NotTrailingError("Only a swipe of the latest narration can be deleted");
          }
          const siblings = this.db
            .query<{ total: number }, [string, number]>(
              "SELECT COUNT(*) AS total FROM messages WHERE chat_id = ? AND position = ?",
            )
            .get(sid, message.position)!.total;
          if (siblings < 2) {
            throw new SoleVariantError("The only reply cannot be deleted as a swipe; delete the message instead");
          }
          this.db.query("DELETE FROM messages WHERE id = ?").run(id);
          if (message.selected === 1) {
            this.db
              .query(
                `UPDATE messages SET selected = 1, updated_at = ? WHERE id = (
                   SELECT id FROM messages WHERE chat_id = ? AND position = ?
                   ORDER BY created_at DESC, rowid DESC LIMIT 1
                 )`,
              )
              .run(nowIso(), sid, message.position);
          }
        } else if (cut === "after") {
          this.db.query("DELETE FROM messages WHERE chat_id = ? AND position >= ?").run(sid, message.position);
        } else {
          this.db.query("DELETE FROM messages WHERE chat_id = ? AND position = ?").run(sid, message.position);
        }
        return this.transcript(sid);
      },
    );
    return remove.immediate(chatId, messageId, scope);
  }

  /**
   * Edits a completed message in place; narration edits change only that
   * alternate. Role, speaker, and position never move; only growth past the
   * narration budget is refused.
   */
  editMessage(chatId: string, messageId: string, content: string): Message {
    const edit = this.db.transaction((sid: string, id: string, text: string): Message => {
      if (this.hasPending(sid)) throw new BusyError("A reply is already being generated for this chat");
      const message = this.getChatMessage(sid, id);
      if (!message) throw new UnknownEntityError("Unknown message");
      if (message.status !== "complete") throw new NotEditableError("Only completed messages can be edited");
      // Only the selected row feeds the model, so only its growth is checked.
      if (message.selected === 1) {
        const growth = countTokens(text) - countTokens(message.content);
        if (growth > 0) this.assertWithinBudget(sid, growth);
      }
      const now = nowIso();
      this.db.query("UPDATE messages SET content = ?, updated_at = ? WHERE id = ?").run(text, now, id);
      return messageFromRow({ ...message, content: text, updated_at: now });
    });
    return edit.immediate(chatId, messageId, content);
  }

  /** Chat-scoped message lookup: another chat's id is missing. */
  private getChatMessage(chatId: string, messageId: string): MessageRow | null {
    return (
      this.db
        .query<MessageRow, [string, string]>(
          `SELECT ${MESSAGE_COLUMNS}, selected FROM messages WHERE id = ? AND chat_id = ?`,
        )
        .get(messageId, chatId) ?? null
    );
  }

  /** True while a narration run is being generated for this chat. */
  hasPending(chatId: string): boolean {
    return (
      this.db
        .query<unknown, [string]>(
          "SELECT 1 FROM messages WHERE chat_id = ? AND role = 'assistant' AND status = 'pending' LIMIT 1",
        )
        .get(chatId) !== null
    );
  }


  /**
   * The one size rule: the system prompt plus the completed history the model
   * would see, grown by `extra` tokens, must fit the narration budget.
   * Nothing is truncated; the request is refused instead. Keyword lore is
   * not counted: it only ever takes the room left over.
   */
  private assertWithinBudget(chatId: string, extra: number): void {
    const total = countTokens(this.systemPrompt(chatId)) + historyTokens(this.modelHistory(chatId)) + extra;
    if (total > NARRATION_TOKEN_BUDGET) {
      throw new ContextLimitError(
        `This would send ${total} tokens to the narrator; the budget is ${NARRATION_TOKEN_BUDGET}. ` +
          "Shorten the world's characters, entries or relationships, or start a new chat.",
      );
    }
  }

  /**
   * Triggered characters and keyword lore for one reply, scanned from the
   * recent history — the opening message included — with the direction
   * counted as part of the latest input. It gets only the room the budget
   * leaves.
   */
  private replyLore(
    chatId: string,
    systemPrompt: string,
    history: NarrationMessage[],
    direction: string | null,
  ): LoreSelection {
    const chat = getChat(this.db, chatId)!;
    const grounding = chatGrounding(this.db, chat);
    const recent = history.map((message) => message.content);
    if (direction !== null) recent[recent.length - 1] += `\n${direction}`;
    const room = NARRATION_TOKEN_BUDGET - countTokens(systemPrompt) - historyTokens(history) - directionTokens(direction);
    return selectReplyContext(
      {
        cast: grounding.cast,
        relationships: grounding.relationships,
        entries: grounding.entries,
        stats: grounding.stats,
      },
      recent,
      room,
    );
  }

  /** Alternates share a position; the next turn still goes past the highest. */
  private maxPosition(chatId: string): number {
    return this.db
      .query<{ max: number }, [string]>(
        "SELECT COALESCE(MAX(position), 0) AS max FROM messages WHERE chat_id = ?",
      )
      .get(chatId)!.max;
  }

  private nextPosition(chatId: string): number {
    return this.maxPosition(chatId) + 1;
  }

  private insertMessage(
    chatId: string,
    position: number,
    role: "user" | "assistant",
    speakerName: string,
    content: string,
    status: string,
    now: string,
    id: string,
    direction: string | null,
  ): void {
    this.db
      .query(
        `INSERT INTO messages (id, chat_id, position, role, speaker_name, content, status, direction, selected, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, chatId, position, role, speakerName, content, status, direction, now, now);
    this.db.query("UPDATE chats SET updated_at = ? WHERE id = ?").run(now, chatId);
  }

  /**
   * Narrator grounding for this chat: the saved prompt cards filled from the
   * world as it is now, read on every call, so any edit applies from the next
   * reply.
   */
  systemPrompt(chatId: string): string {
    return chatSystemPrompt(this.db, getChat(this.db, chatId)!);
  }

  /**
   * The opening message, then completed narration and accepted player input
   * in position order. A player turn sent before any narration joins the
   * opening message, so every call starts with one user message that never
   * changes for the chat.
   */
  modelHistory(chatId: string): NarrationMessage[] {
    const opening = openingMessage(getChat(this.db, chatId)!.opening);
    const stored = this.db
      .query<{ role: "user" | "assistant"; content: string }, [string]>(
        "SELECT role, content FROM messages WHERE chat_id = ? AND selected = 1 AND (role = 'user' OR status = 'complete') ORDER BY position",
      )
      .all(chatId);
    const [first, ...rest] = stored;
    if (first?.role === "user") return [{ role: "user", content: `${opening}\n\n${first.content}` }, ...rest];
    return [{ role: "user", content: opening }, ...stored];
  }

  /**
   * Starts one narration run with the lore and direction notes appended to
   * the latest player input. The run belongs to the server until it settles;
   * the response is its first reader, carrying the acceptance headers the
   * browser needs before the first byte of narration.
   */
  streamNarration(options: {
    chatId: string;
    pendingId: string;
    playerId: string | null;
    settings: PlaySettings;
    upstreamFetch?: typeof fetch;
  }): Response {
    const chatId = options.chatId;

    const systemPrompt = this.systemPrompt(chatId);
    const history = this.modelHistory(chatId);
    const direction = this.getMessage(options.pendingId)?.direction ?? null;
    const lore = this.replyLore(chatId, systemPrompt, history, direction);
    // Lore first, so an OOC note still ends the player's latest message.
    const notes = lore.note + (direction === null ? "" : directionNote(direction));
    const estimate = { system: countTokens(systemPrompt), history: historyTokens(history), context: countTokens(notes) };
    this.db
      .query("UPDATE messages SET lore = ?, usage = ? WHERE id = ?")
      .run(lore.lore && JSON.stringify(lore.lore), JSON.stringify({ estimate, provider: null } satisfies MessageUsage), options.pendingId);
    if (notes !== "") {
      const last = history.at(-1)!;
      if (last.role === "user") last.content += notes;
      else history.push({ role: "user", content: notes.trimStart() });
    }

    const headers: Record<string, string> = { "x-storyfold-accepted": "true" };
    if (options.playerId !== null) headers["x-storyfold-player-message-id"] = options.playerId;

    return this.replies.stream({
      chatId,
      messageId: options.pendingId,
      systemPrompt,
      messages: history,
      settings: options.settings,
      estimate,
      emptyReply: "The narrator returned an empty reply. Try again.",
      headers,
      upstreamFetch: options.upstreamFetch,
    });
  }

  /** Joins the chat's live run from any browser; see `ReplyRuns.attach`. */
  attach(chatId: string): Response | null {
    return this.replies.attach(chatId);
  }

  /** Server-owned Stop, usable from any browser; see `ReplyRuns.stop`. */
  stop(chatId: string): { pending: boolean; message: Message | null } {
    const messageId = this.replies.stop(chatId);
    return messageId === null ? { pending: false, message: null } : { pending: true, message: this.getMessage(messageId) };
  }

  /** Missing-provider path: the reserved pending reply settles as failed. */
  failPending(pendingId: string): void {
    this.replies.settlePending(pendingId, "failed", "");
  }
}

export function parsePlayerContent(body: Record<string, unknown>): string {
  const content = body.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ValidationError("content must be a non-empty string");
  }
  if (content.length > MAX_MESSAGE_CHARS) {
    throw new ValidationError(`content must be at most ${MAX_MESSAGE_CHARS} characters`);
  }
  return content;
}

/** Optional one-reply direction: omitted or blank means none. */
export function parseDirection(body: Record<string, unknown>): string | null {
  const direction = body.direction;
  if (direction === undefined) return null;
  if (typeof direction !== "string") throw new ValidationError("direction must be a string");
  const trimmed = direction.trim();
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    throw new ValidationError(`direction must be at most ${MAX_MESSAGE_CHARS} characters`);
  }
  return trimmed.length > 0 ? trimmed : null;
}

function directionTokens(direction: string | null): number {
  return direction === null ? 0 : countTokens(directionNote(direction));
}

function historyTokens(history: NarrationMessage[]): number {
  return history.reduce((sum, message) => sum + countTokens(message.content), 0);
}
