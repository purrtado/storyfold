import type { Database } from "bun:sqlite";
import { EventType, toServerSentEventsResponse } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import type { Message, MessageLore } from "../shared/domain";
import { protagonistOf } from "../shared/domain";
import { NARRATION_TOKEN_BUDGET, directionNote, narratorSystemPrompt } from "../shared/narration";
import { countTokens } from "../shared/tokens";
import { newId, nowIso } from "./db";
import { selectLore, type LoreSelection } from "./lore";
import {
  SessionClosedError,
  UnknownEntityError,
  getCampaign,
  getSessionRecord,
  listCampaignState,
  sessionGroundingHandoff,
  ValidationError,
} from "./library";
import { startNarrationRun, MAX_MESSAGE_CHARS, type NarrationMessage } from "./chat";
import { listPromptCards } from "./promptCards";
import { relationshipNarrationContext } from "./relationships";

/** Stands in for the player's turn when an opening request has no history. */
const OPENING_REQUEST = "Begin the opening scene.";

export const NARRATOR_NAME = "Narrator";

/** A reply is already being generated for this session; nothing was saved. */
export class BusyError extends Error {}

/** The session already contains completed opening narration. */
export class AlreadyOpenedError extends Error {}

/** Accepting this request would pass the narration budget. */
export class ContextLimitError extends Error {}

/** The session has no messages to regenerate. */
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

/** Storage shape of a message: lore is JSON text until parsed. */
type MessageRecord = Omit<Message, "lore"> & { lore: string | null };

/** Storage row including the selection flag; never sent to the client. */
interface MessageRow extends MessageRecord {
  selected: number;
}

const MESSAGE_COLUMNS =
  "id, session_id, position, role, speaker_name, content, status, direction, lore, created_at, updated_at";

function messageFromRow({ selected: _selected, ...row }: MessageRecord & { selected?: number }): Message {
  return { ...row, lore: row.lore === null ? null : (JSON.parse(row.lore) as MessageLore) };
}

export interface PlaySettings {
  baseUrl: string;
  model: string;
  apiKey: string | null;
}

interface ActiveRun {
  controller: AbortController;
  messageId: string;
  partial: string;
  settled: boolean;
  /** Bound during streamNarration; Stop uses the same first-wins settlement. */
  settle: (status: "complete" | "interrupted" | "failed") => void;
}

/**
 * Owns the server-side play lifecycle: reserving turns atomically, streaming
 * narration, and settling every pending reply exactly once. One Bun backend
 * means the in-memory registry covers every live generation.
 */
export class PlayService {
  private runs = new Map<string, ActiveRun>();

  constructor(private db: Database) {}

  /** Selected rows in position order; the trailing narration carries its alternates. */
  transcript(sessionId: string): TranscriptMessage[] {
    const rows = this.db
      .query<MessageRecord, [string]>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ? AND selected = 1 ORDER BY position`,
      )
      .all(sessionId);
    const plain = rows.map((row) => ({ ...messageFromRow(row), variant_ids: [], variant_index: 0 }));
    const trailing = plain.at(-1);
    if (!trailing || trailing.role !== "assistant") return plain;
    const variants = this.db
      .query<{ id: string; selected: number }, [string, number]>(
        "SELECT id, selected FROM messages WHERE session_id = ? AND position = ? ORDER BY created_at, rowid",
      )
      .all(sessionId, trailing.position);
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

  /**
   * CAS settlement: only a still-pending row can change status, so Stop,
   * disconnect, failure and completion can race without overwriting each
   * other, and late chunks can never alter a settled reply.
   */
  settlePending(messageId: string, status: "complete" | "interrupted" | "failed", content: string): boolean {
    return (
      this.db
        .query(
          "UPDATE messages SET status = ?, content = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(status, content, nowIso(), messageId).changes > 0
    );
  }

  /** Accepted player input plus the reserved pending narration, one transaction. */
  reservePlayerTurn(sessionId: string, content: string, speakerName: string, direction: string | null = null): ReservedTurn {
    const reserve = this.db.transaction(
      (id: string, text: string, speaker: string): ReservedTurn => {
        this.requireOpenSession(id);
        if (this.hasPending(id)) throw new BusyError("A reply is already being generated for this session");
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
    return reserve.immediate(sessionId, content, speakerName);
  }

  /**
   * Opening narration reserves only the pending row; no player input exists.
   * Every active session may open exactly once, and only from emptiness: once
   * any message exists — a settled opening, a draft, or accepted player input
   * — retries go through regeneration. All guards sit inside the reservation
   * transaction: a second /opening that raced the first can never reserve
   * after the first settled complete.
   */
  reserveOpening(sessionId: string, direction: string | null = null): ReservedTurn {
    const reserve = this.db.transaction((id: string): ReservedTurn => {
      this.requireOpenSession(id);
      const existing = this.db
        .query<unknown, [string]>("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1")
        .get(id);
      if (existing) throw new AlreadyOpenedError("This session has already opened");
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
    return reserve.immediate(sessionId);
  }

  /**
   * Regeneration adds a selected pending alternate at the trailing narration's
   * position: complete alternates stay as swipes, failed or interrupted drafts
   * are discarded. A session ending on a player turn reserves a fresh reply;
   * an empty session has nothing to regenerate.
   */
  reserveRegeneration(sessionId: string, direction: string | null = null): ReservedTurn {
    const reserve = this.db.transaction((id: string): ReservedTurn => {
      this.requireOpenSession(id);
      if (this.hasPending(id)) throw new BusyError("A reply is already being generated for this session");
      const lastUser = this.db
        .query<Pick<Message, "id">, [string]>(
          "SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY position DESC LIMIT 1",
        )
        .get(id);
      const trailing = this.db
        .query<MessageRow, [string]>(
          `SELECT ${MESSAGE_COLUMNS}, selected FROM messages
           WHERE session_id = ? AND selected = 1 ORDER BY position DESC LIMIT 1`,
        )
        .get(id);
      if (!lastUser && !trailing) throw new NothingToRegenerateError("This session has nothing to regenerate");
      let position: number;
      if (trailing && trailing.role === "assistant") {
        position = trailing.position;
        this.db
          .query("DELETE FROM messages WHERE session_id = ? AND position = ? AND status IN ('failed', 'interrupted')")
          .run(id, position);
      } else {
        position = this.nextPosition(id);
      }
      this.db
        .query("UPDATE messages SET selected = 0 WHERE session_id = ? AND position = ?")
        .run(id, position);
      this.assertWithinBudget(id, directionTokens(direction));
      const pendingId = newId();
      this.insertMessage(id, position, "assistant", NARRATOR_NAME, "", "pending", nowIso(), pendingId, direction);
      return { playerId: lastUser?.id ?? null, pendingId };
    });
    return reserve.immediate(sessionId);
  }

  /**
   * Selects one alternate of the trailing narration; drafts left behind are
   * deleted. Anything else — a player message, older narration — is a
   * conflict; a foreign or unknown id is missing.
   */
  selectVariant(sessionId: string, messageId: string): TranscriptMessage[] {
    const select = this.db.transaction((sid: string, id: string): TranscriptMessage[] => {
      this.requireOpenSession(sid);
      if (this.hasPending(sid)) throw new BusyError("A reply is already being generated for this session");
      const message = this.getSessionMessage(sid, id);
      if (!message) throw new UnknownEntityError("Unknown message");
      if (message.role !== "assistant" || message.position !== this.maxPosition(sid)) {
        throw new NotTrailingError("Only the latest narration can be switched");
      }
      this.db
        .query("UPDATE messages SET selected = 0 WHERE session_id = ? AND position = ?")
        .run(sid, message.position);
      this.db
        .query(
          "DELETE FROM messages WHERE session_id = ? AND position = ? AND status IN ('failed', 'interrupted') AND id != ?",
        )
        .run(sid, message.position, id);
      this.db.query("UPDATE messages SET selected = 1, updated_at = ? WHERE id = ?").run(nowIso(), id);
      return this.transcript(sid);
    });
    return select.immediate(sessionId, messageId);
  }

  /**
   * Deletes one alternate of the trailing narration (scope "variant"; deleting
   * the shown one selects the newest remaining, and the sole alternate is
   * refused — delete the message instead), a message with all its alternates
   * (default), or the message and everything after it (scope "after").
   * Positions never shift: the next turn continues after the highest survivor.
   */
  deleteMessage(sessionId: string, messageId: string, scope: "variant" | "after" | null): TranscriptMessage[] {
    const remove = this.db.transaction(
      (sid: string, id: string, cut: "variant" | "after" | null): TranscriptMessage[] => {
        this.requireOpenSession(sid);
        if (this.hasPending(sid)) throw new BusyError("A reply is already being generated for this session");
        const message = this.getSessionMessage(sid, id);
        if (!message) throw new UnknownEntityError("Unknown message");
        if (cut === "variant") {
          if (message.role !== "assistant" || message.position !== this.maxPosition(sid)) {
            throw new NotTrailingError("Only a swipe of the latest narration can be deleted");
          }
          const siblings = this.db
            .query<{ total: number }, [string, number]>(
              "SELECT COUNT(*) AS total FROM messages WHERE session_id = ? AND position = ?",
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
                   SELECT id FROM messages WHERE session_id = ? AND position = ?
                   ORDER BY created_at DESC, rowid DESC LIMIT 1
                 )`,
              )
              .run(nowIso(), sid, message.position);
          }
        } else if (cut === "after") {
          this.db.query("DELETE FROM messages WHERE session_id = ? AND position >= ?").run(sid, message.position);
        } else {
          this.db.query("DELETE FROM messages WHERE session_id = ? AND position = ?").run(sid, message.position);
        }
        return this.transcript(sid);
      },
    );
    return remove.immediate(sessionId, messageId, scope);
  }

  /**
   * Edits a completed message in place; narration edits change only that
   * alternate. Role, speaker, and position never move; only growth past the
   * narration budget is refused.
   */
  editMessage(sessionId: string, messageId: string, content: string): Message {
    const edit = this.db.transaction((sid: string, id: string, text: string): Message => {
      this.requireOpenSession(sid);
      if (this.hasPending(sid)) throw new BusyError("A reply is already being generated for this session");
      const message = this.getSessionMessage(sid, id);
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
    return edit.immediate(sessionId, messageId, content);
  }

  /**
   * Write-side half of the read-only closed-session invariant, checked inside
   * the reservation transaction: a close that raced an in-flight play request
   * (between the route's early check and the provider-settings await) loses.
   */
  private requireOpenSession(sessionId: string): void {
    const session = this.db
      .query<{ closed_at: string | null }, [string]>("SELECT closed_at FROM sessions WHERE id = ?")
      .get(sessionId);
    if (!session || session.closed_at !== null) {
      throw new SessionClosedError("This session is closed; play continues in the campaign's active session");
    }
  }

  /** Session-scoped message lookup: another session's id is missing. */
  private getSessionMessage(sessionId: string, messageId: string): MessageRow | null {
    return (
      this.db
        .query<MessageRow, [string, string]>(
          `SELECT ${MESSAGE_COLUMNS}, selected FROM messages WHERE id = ? AND session_id = ?`,
        )
        .get(messageId, sessionId) ?? null
    );
  }

  /** True while a narration run is being generated for this session. */
  hasPending(sessionId: string): boolean {
    return (
      this.db
        .query<unknown, [string]>(
          "SELECT 1 FROM messages WHERE session_id = ? AND role = 'assistant' AND status = 'pending' LIMIT 1",
        )
        .get(sessionId) !== null
    );
  }

  private hasCompletedHistory(sessionId: string): boolean {
    return (
      this.db
        .query<unknown, [string]>(
          "SELECT 1 FROM messages WHERE session_id = ? AND selected = 1 AND (role = 'user' OR status = 'complete') AND length(content) > 0 LIMIT 1",
        )
        .get(sessionId) !== null
    );
  }

  /** What the model is sent before any one-reply notes: system prompt, history, and the opening stand-in. */
  private narrationTokens(systemPrompt: string, history: NarrationMessage[]): number {
    const messages = history.reduce((sum, message) => sum + countTokens(message.content), 0);
    const opening = history.length === 0 ? countTokens(OPENING_REQUEST) : 0;
    return countTokens(systemPrompt) + messages + opening;
  }

  /**
   * The one size rule: the system prompt plus the completed history the model
   * would see, grown by `extra` tokens, must fit the narration budget.
   * Nothing is truncated; the request is refused instead. Keyword lore is
   * not counted: it only ever takes the room left over.
   */
  private assertWithinBudget(sessionId: string, extra: number): void {
    const total = this.narrationTokens(this.systemPrompt(sessionId), this.modelHistory(sessionId)) + extra;
    if (total > NARRATION_TOKEN_BUDGET) {
      throw new ContextLimitError(
        `This would send ${total} tokens to the narrator; the budget is ${NARRATION_TOKEN_BUDGET}. ` +
          "Shorten the campaign's notes or relationships, or begin the next session with a handoff.",
      );
    }
  }

  /**
   * Keyword lore for one reply, scanned from the recent history — or, before
   * any, the situation the opening grows from — with the direction counted
   * as part of the latest input. It gets only the room the budget leaves.
   */
  private replyLore(
    sessionId: string,
    systemPrompt: string,
    history: NarrationMessage[],
    direction: string | null,
  ): LoreSelection {
    const campaign = getCampaign(this.db, getSessionRecord(this.db, sessionId)!.campaign_id)!;
    const recent =
      history.length > 0
        ? history.map((message) => message.content)
        : [sessionGroundingHandoff(this.db, campaign.id, sessionId) ?? campaign.starting_situation];
    if (direction !== null) recent[recent.length - 1] += `\n${direction}`;
    const room = NARRATION_TOKEN_BUDGET - this.narrationTokens(systemPrompt, history) - directionTokens(direction);
    return selectLore(campaign.world_snapshot.entries, recent, room);
  }

  /** Alternates share a position; the next turn still goes past the highest. */
  private maxPosition(sessionId: string): number {
    return this.db
      .query<{ max: number }, [string]>(
        "SELECT COALESCE(MAX(position), 0) AS max FROM messages WHERE session_id = ?",
      )
      .get(sessionId)!.max;
  }

  private nextPosition(sessionId: string): number {
    return this.maxPosition(sessionId) + 1;
  }

  private insertMessage(
    sessionId: string,
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
        `INSERT INTO messages (id, session_id, position, role, speaker_name, content, status, direction, selected, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, sessionId, position, role, speakerName, content, status, direction, now, now);
  }

  /**
   * Narrator grounding for this session: the saved prompt cards filled from
   * what its campaign owns — the world snapshot, its characters, current notes
   * and relationships, and the handoff that grounds the session. The library
   * and worlds are never consulted.
   */
  systemPrompt(sessionId: string): string {
    const campaign = getCampaign(this.db, getSessionRecord(this.db, sessionId)!.campaign_id)!;
    return narratorSystemPrompt(listPromptCards(this.db), {
      world: campaign.world_snapshot,
      starting_situation: campaign.starting_situation,
      stats: campaign.stats,
      protagonist: protagonistOf(campaign),
      cast: campaign.characters.filter((character) => character.role === "cast"),
      notes: listCampaignState(this.db, campaign.id),
      relationships: relationshipNarrationContext(this.db, campaign),
      handoff: sessionGroundingHandoff(this.db, campaign.id, sessionId),
      has_history: this.hasCompletedHistory(sessionId),
    });
  }

  /** Completed narration and accepted player input only, in position order. */
  modelHistory(sessionId: string): NarrationMessage[] {
    return this.db
      .query<{ role: "user" | "assistant"; content: string }, [string]>(
        "SELECT role, content FROM messages WHERE session_id = ? AND selected = 1 AND (role = 'user' OR status = 'complete') ORDER BY position",
      )
      .all(sessionId);
  }

  /**
   * Streams one narration run through a single lifecycle generator that
   * persists and settles before yielding each chunk onward to the SSE
   * response. Deltas persist into the pending row as they arrive, so partial
   * text survives disconnects, Stop and crashes. The response carries the
   * acceptance headers the browser needs before the first byte of narration.
   */
  streamNarration(options: {
    sessionId: string;
    pendingId: string;
    playerId: string | null;
    settings: PlaySettings;
    disconnectSignal?: AbortSignal;
    upstreamFetch?: typeof fetch;
  }): Response {
    const service = this;
    const sessionId = options.sessionId;

    // First terminal settlement wins and releases the exclusivity slot, so a
    // stalled upstream can never hold a session hostage.
    function onDisconnect(): void {
      run.settle("interrupted");
      run.controller.abort(options.disconnectSignal?.reason);
    }
    function detachDisconnect(): void {
      options.disconnectSignal?.removeEventListener("abort", onDisconnect);
    }
    const run: ActiveRun = {
      controller: new AbortController(),
      messageId: options.pendingId,
      partial: "",
      settled: false,
      settle(status) {
        if (run.settled) return;
        run.settled = true;
        service.settlePending(run.messageId, status, run.partial);
        detachDisconnect();
        service.unregister(sessionId, run);
      },
    };
    this.runs.set(sessionId, run);

    // Disconnect must settle synchronously and abort the shared controller:
    // it cannot depend on a stalled upstream noticing the abort.
    if (options.disconnectSignal?.aborted) {
      onDisconnect();
    } else {
      options.disconnectSignal?.addEventListener("abort", onDisconnect, { once: true });
    }

    // An opening request carries no player row; whether the story starts
    // fresh depends on the history, not on the protocol kind.
    const systemPrompt = this.systemPrompt(sessionId);
    const history = this.modelHistory(sessionId);
    const direction = this.getMessage(options.pendingId)?.direction ?? null;
    const lore = this.replyLore(sessionId, systemPrompt, history, direction);
    this.db.query("UPDATE messages SET lore = ? WHERE id = ?").run(lore.lore && JSON.stringify(lore.lore), options.pendingId);
    if (history.length === 0) history.push({ role: "user", content: OPENING_REQUEST });
    // Lore first, so an OOC note still ends the player's latest message.
    const notes = lore.note + (direction === null ? "" : directionNote(direction));
    if (notes !== "") {
      const last = history.at(-1)!;
      if (last.role === "user") last.content += notes;
      else history.push({ role: "user", content: notes.trimStart() });
    }

    const { stream: upstream } = startNarrationRun({
      baseUrl: options.settings.baseUrl,
      model: options.settings.model,
      apiKey: options.settings.apiKey,
      systemPrompt,
      messages: history,
      abortController: run.controller,
      upstreamFetch: options.upstreamFetch,
    });

    const headers: Record<string, string> = {
      "x-storyfold-accepted": "true",
      "x-storyfold-pending-message-id": options.pendingId,
      "access-control-expose-headers":
        "x-storyfold-accepted, x-storyfold-player-message-id, x-storyfold-pending-message-id",
    };
    if (options.playerId !== null) headers["x-storyfold-player-message-id"] = options.playerId;

    return toServerSentEventsResponse(this.lifecycle(run, upstream), {
      headers,
      abortController: run.controller,
      debug: false,
    });
  }

  /**
   * The only consumer of the upstream stream. Each terminal outcome settles
   * the pending row before the corresponding chunk reaches the browser, and a
   * stream without a normal-stop terminal (the transport rewrites everything
   * else to RUN_ERROR) can never mark complete.
   */
  private lifecycle(
    run: ActiveRun,
    upstream: AsyncIterable<StreamChunk>,
  ): AsyncGenerator<StreamChunk> {
    const persist = this.db.query(
      "UPDATE messages SET content = ?, updated_at = ? WHERE id = ? AND status = 'pending'",
    );
    async function* generate(): AsyncGenerator<StreamChunk> {
      try {
        for await (const chunk of upstream) {
          if (run.settled) return; // Stop or disconnect settled already: swallow late chunks.
          if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
            run.partial += chunk.delta;
            persist.run(run.partial, nowIso(), run.messageId);
            yield chunk;
            continue;
          }
          if (chunk.type === EventType.RUN_FINISHED) {
            if (run.partial.trim().length > 0) {
              // Normal-stop evidence with real narration: complete.
              run.settle("complete");
              yield chunk;
              return;
            }
            // An empty reply is a failure, never a silent success.
            run.settle("failed");
            yield {
              type: EventType.RUN_ERROR,
              message: "The narrator returned an empty reply. Try again.",
              code: "incomplete_generation",
              timestamp: Date.now(),
            };
            return;
          }
          if (chunk.type === EventType.RUN_ERROR) {
            run.settle("failed");
            yield chunk;
            return;
          }
          yield chunk;
        }
        // Ended without any terminal event and not aborted: a failed draft.
        if (!run.controller.signal.aborted) run.settle("failed");
      } catch {
        // Abort from Stop or disconnect; those paths settle synchronously.
        run.settle("interrupted");
      } finally {
        run.settle("interrupted");
      }
    }
    return generate();
  }

  /** Only the run still registered for this session may remove itself. */
  private unregister(sessionId: string, run: ActiveRun): void {
    if (this.runs.get(sessionId) === run) this.runs.delete(sessionId);
  }

  /**
   * Server-owned Stop, usable from any browser: settles the pending row first
   * (releasing the exclusivity slot even if the upstream never notices the
   * abort), unregisters, then cancels the shared controller — aborting the
   * real provider call. Late chunks land on a settled run and are dropped.
   */
  stop(sessionId: string): { pending: boolean; message: Message | null } {
    const run = this.runs.get(sessionId);
    if (!run) return { pending: false, message: null };
    run.settle("interrupted");
    run.controller.abort();
    return { pending: true, message: this.getMessage(run.messageId) };
  }

  /** Missing-provider path: the reserved pending reply settles as failed. */
  failPending(pendingId: string): void {
    this.settlePending(pendingId, "failed", "");
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
