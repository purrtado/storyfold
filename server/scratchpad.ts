import type { Database } from "bun:sqlite";
import type { ScratchMessage } from "../shared/domain";
import { SCRATCHPAD_TOKEN_BUDGET, scratchpadSystemPrompt } from "../shared/narration";
import { countTokens } from "../shared/tokens";
import { newId, nowIso } from "./db";
import { getChat } from "./chats";
import { chatGrounding } from "./grounding";
import { UnknownEntityError } from "./worlds";
import type { NarrationMessage } from "./chat";
import { BusyError, ContextLimitError, NothingToRegenerateError, type PlayService, type ReservedTurn } from "./play";
import { ReplyRuns, type PlaySettings } from "./runs";

const COLUMNS = "id, chat_id, position, role, content, status, reasoning, reasoning_ms, created_at, updated_at";

/**
 * Each chat's scratchpad: one thread of talk about the story with a model
 * that reads the whole world and the chat's transcript. Nothing here ever
 * reaches the narrator, and the thread never writes to the chat or world.
 */
export class ScratchpadService {
  private replies: ReplyRuns;

  constructor(
    private db: Database,
    private play: PlayService,
  ) {
    this.replies = new ReplyRuns(db, "scratch_messages");
  }

  /** The thread in position order, drafts included. */
  list(chatId: string): ScratchMessage[] {
    return this.db
      .query<ScratchMessage, [string]>(`SELECT ${COLUMNS} FROM scratch_messages WHERE chat_id = ? ORDER BY position`)
      .all(chatId);
  }

  /** True while a scratchpad reply is being generated for this chat. */
  hasPending(chatId: string): boolean {
    return this.db.query("SELECT 1 FROM scratch_messages WHERE chat_id = ? AND status = 'pending' LIMIT 1").get(chatId) !== null;
  }

  /** The player's message plus the reserved pending reply, one transaction. */
  reserveMessage(chatId: string, content: string): ReservedTurn {
    const reserve = this.db.transaction((): ReservedTurn => {
      this.assertIdle(chatId);
      const position = this.nextPosition(chatId);
      const playerId = newId();
      const pendingId = newId();
      this.insert(chatId, position, "user", content, "complete", playerId);
      this.insert(chatId, position + 1, "assistant", "", "pending", pendingId);
      this.assertWithinBudget(chatId);
      return { playerId, pendingId };
    });
    return reserve.immediate();
  }

  /** Replaces the trailing reply, whatever its status, with a fresh pending one; the thread must end on the player. */
  reserveRegeneration(chatId: string): ReservedTurn {
    const reserve = this.db.transaction((): ReservedTurn => {
      this.assertIdle(chatId);
      this.db
        .query(
          `DELETE FROM scratch_messages WHERE role = 'assistant' AND id = (
             SELECT id FROM scratch_messages WHERE chat_id = ? ORDER BY position DESC LIMIT 1
           )`,
        )
        .run(chatId);
      const last = this.db
        .query<{ id: string; role: string }, [string]>(
          "SELECT id, role FROM scratch_messages WHERE chat_id = ? ORDER BY position DESC LIMIT 1",
        )
        .get(chatId);
      if (last?.role !== "user") throw new NothingToRegenerateError("The scratchpad has nothing to answer");
      this.assertWithinBudget(chatId);
      const pendingId = newId();
      this.insert(chatId, this.nextPosition(chatId), "assistant", "", "pending", pendingId);
      return { playerId: last.id, pendingId };
    });
    return reserve.immediate();
  }

  /** Deletes one message of the thread; another chat's id is missing. */
  deleteMessage(chatId: string, messageId: string): ScratchMessage[] {
    const remove = this.db.transaction((): ScratchMessage[] => {
      this.assertIdle(chatId);
      const removed = this.db.query("DELETE FROM scratch_messages WHERE id = ? AND chat_id = ?").run(messageId, chatId).changes;
      if (removed === 0) throw new UnknownEntityError("Unknown scratchpad message");
      return this.list(chatId);
    });
    return remove.immediate();
  }

  /** Empties the thread. */
  clear(chatId: string): void {
    const clear = this.db.transaction(() => {
      this.assertIdle(chatId);
      this.db.query("DELETE FROM scratch_messages WHERE chat_id = ?").run(chatId);
    });
    clear.immediate();
  }

  /** The world and the chat's transcript as they are now: completed narration and accepted player input only. */
  systemPrompt(chatId: string): string {
    const chat = getChat(this.db, chatId)!;
    const grounding = chatGrounding(this.db, chat);
    const transcript = this.play.transcript(chatId).filter((message) => message.role === "user" || message.status === "complete");
    return scratchpadSystemPrompt(
      {
        world: { name: grounding.world.name, setting_brief: grounding.world.setting_brief, entries: grounding.entries },
        stats: grounding.stats,
        protagonist: grounding.protagonist,
        cast: grounding.cast,
        relationships: grounding.relationships,
      },
      chat.opening,
      transcript,
    );
  }

  /** The thread as model turns: the player's messages and completed replies. */
  history(chatId: string): NarrationMessage[] {
    return this.db
      .query<NarrationMessage, [string]>(
        "SELECT role, content FROM scratch_messages WHERE chat_id = ? AND (role = 'user' OR status = 'complete') ORDER BY position",
      )
      .all(chatId);
  }

  stream(options: {
    chatId: string;
    pendingId: string;
    playerId: string;
    settings: PlaySettings;
    upstreamFetch?: typeof fetch;
  }): Response {
    return this.replies.stream({
      chatId: options.chatId,
      messageId: options.pendingId,
      systemPrompt: this.systemPrompt(options.chatId),
      messages: this.history(options.chatId),
      settings: options.settings,
      estimate: null,
      emptyReply: "The scratchpad returned an empty reply. Try again.",
      headers: { "x-storyfold-accepted": "true", "x-storyfold-player-message-id": options.playerId },
      upstreamFetch: options.upstreamFetch,
    });
  }

  /** Joins the chat's live scratchpad reply from any browser; see `ReplyRuns.attach`. */
  attach(chatId: string): Response | null {
    return this.replies.attach(chatId);
  }

  /** Server-owned Stop for the scratchpad reply; the narration keeps running. */
  stop(chatId: string): { pending: boolean; message: ScratchMessage | null } {
    const messageId = this.replies.stop(chatId);
    if (messageId === null) return { pending: false, message: null };
    const message = this.db.query<ScratchMessage, [string]>(`SELECT ${COLUMNS} FROM scratch_messages WHERE id = ?`).get(messageId);
    return { pending: true, message };
  }

  /** Missing-provider path: the reserved pending reply settles as failed. */
  failPending(pendingId: string): void {
    this.replies.settlePending(pendingId, "failed", "");
  }

  private assertIdle(chatId: string): void {
    if (this.hasPending(chatId)) throw new BusyError("A scratchpad reply is already being generated for this chat");
  }

  /** The world, transcript and thread that the next reply would be sent must fit the scratchpad budget. */
  private assertWithinBudget(chatId: string): void {
    const total = countTokens(this.systemPrompt(chatId)) + this.history(chatId).reduce((sum, message) => sum + countTokens(message.content), 0);
    if (total > SCRATCHPAD_TOKEN_BUDGET) {
      throw new ContextLimitError(
        `This would send ${total} tokens to the scratchpad; the budget is ${SCRATCHPAD_TOKEN_BUDGET}. Clear the scratchpad or delete old messages.`,
      );
    }
  }

  private nextPosition(chatId: string): number {
    return (
      this.db
        .query<{ max: number }, [string]>("SELECT COALESCE(MAX(position), 0) AS max FROM scratch_messages WHERE chat_id = ?")
        .get(chatId)!.max + 1
    );
  }

  private insert(chatId: string, position: number, role: "user" | "assistant", content: string, status: string, id: string): void {
    const now = nowIso();
    this.db
      .query(
        `INSERT INTO scratch_messages (id, chat_id, position, role, content, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, chatId, position, role, content, status, now, now);
  }
}
