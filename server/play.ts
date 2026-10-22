import type { Database } from "bun:sqlite";
import { EventType, toServerSentEventsResponse } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import type { Campaign, CampaignStateItem, CharacterSnapshot, Message } from "../shared/domain";
import { newId, nowIso } from "./db";
import {
  SessionClosedError,
  UnknownEntityError,
  listCampaignState,
  sessionGroundingHandoff,
  ValidationError,
} from "./library";
import { startZaiRun, MAX_MESSAGE_CHARS, type NarrationMessage } from "./chat";
import { relationshipNarrationContext, type RelationshipPrompt } from "./relationships";

export const NARRATOR_NAME = "Narrator";

/**
 * Server-enforced cap on one session's completed history, counted as the plain
 * summed content length of the player inputs and completed narration sent to
 * the model — independent of the 32,000-character authored grounding limit.
 * Nothing is ever truncated: at the limit the session is refused further input
 * and the player begins the next session with a reviewed handoff.
 */
export const HISTORY_CHARACTER_LIMIT = 100_000;

/** A reply is already being generated for this session; nothing was saved. */
export class BusyError extends Error {}

/** The session already contains completed opening narration. */
export class AlreadyOpenedError extends Error {}

/** Accepting this input would push completed history past the limit. */
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

/** Storage row including the selection flag; never sent to the client. */
interface MessageRow extends Message {
  selected: number;
}

const MESSAGE_COLUMNS =
  "id, session_id, position, role, speaker_name, content, status, created_at, updated_at";

export interface PlaySettings {
  model: string;
  apiKey: string;
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
 * One authored character as prompt text: description first, then only the
 * fields actually authored — blank fields add no scaffold text.
 */
function characterDefinition(character: CharacterSnapshot): string {
  return [
    character.description,
    ...(character.appearance.length > 0 ? [`Appearance: ${character.appearance}`] : []),
    ...(character.personality.length > 0 ? [`Personality: ${character.personality}`] : []),
    ...(character.background.length > 0 ? [`Background: ${character.background}`] : []),
    ...(character.baseline_motivations.length > 0
      ? [`Motivations: ${character.baseline_motivations}`]
      : []),
    ...(character.speaking_style.length > 0 ? [`Speaking style: ${character.speaking_style}`] : []),
    ...(character.world_context.length > 0 ? [`In this world: ${character.world_context}`] : []),
  ].join("; ");
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
      .query<Message, [string]>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE session_id = ? AND selected = 1 ORDER BY position`,
      )
      .all(sessionId);
    const plain = rows.map((row) => ({ ...row, variant_ids: [], variant_index: 0 }));
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
    return (
      this.db.query<Message, [string]>(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(messageId) ?? null
    );
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
  reservePlayerTurn(sessionId: string, content: string, speakerName: string): ReservedTurn {
    const reserve = this.db.transaction(
      (id: string, text: string, speaker: string): ReservedTurn => {
        this.requireOpenSession(id);
        if (this.hasPending(id)) throw new BusyError("A reply is already being generated for this session");
        const completed = this.completedHistoryCharacters(id);
        if (completed + text.length > HISTORY_CHARACTER_LIMIT) {
          throw new ContextLimitError(
            `This session's completed history is ${completed} characters and this input would pass the ` +
              `${HISTORY_CHARACTER_LIMIT}-character limit. Review this session, then begin the next session ` +
              "with a handoff.",
          );
        }
        const position = this.nextPosition(id);
        const playerId = newId();
        const pendingId = newId();
        const now = nowIso();
        this.insertMessage(id, position, "user", speaker, text, "complete", now, playerId);
        this.insertMessage(id, position + 1, "assistant", NARRATOR_NAME, "", "pending", now, pendingId);
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
  reserveOpening(sessionId: string): ReservedTurn {
    const reserve = this.db.transaction((id: string): ReservedTurn => {
      this.requireOpenSession(id);
      const existing = this.db
        .query<unknown, [string]>("SELECT 1 FROM messages WHERE session_id = ? LIMIT 1")
        .get(id);
      if (existing) throw new AlreadyOpenedError("This session has already opened");
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
  reserveRegeneration(sessionId: string): ReservedTurn {
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
      const pendingId = newId();
      this.insertMessage(id, position, "assistant", NARRATOR_NAME, "", "pending", nowIso(), pendingId);
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
   * history limit is refused.
   */
  editMessage(sessionId: string, messageId: string, content: string): Message {
    const edit = this.db.transaction((sid: string, id: string, text: string): Message => {
      this.requireOpenSession(sid);
      if (this.hasPending(sid)) throw new BusyError("A reply is already being generated for this session");
      const message = this.getSessionMessage(sid, id);
      if (!message) throw new UnknownEntityError("Unknown message");
      if (message.status !== "complete") throw new NotEditableError("Only completed messages can be edited");
      const completed = this.completedHistoryCharacters(sid) - (message.selected === 1 ? message.content.length : 0);
      if (completed + text.length > HISTORY_CHARACTER_LIMIT) {
        throw new ContextLimitError(
          `This session's completed history is ${completed} characters and this edit would pass the ` +
            `${HISTORY_CHARACTER_LIMIT}-character limit. Review this session, then begin the next session ` +
            "with a handoff.",
        );
      }
      const now = nowIso();
      this.db.query("UPDATE messages SET content = ?, updated_at = ? WHERE id = ?").run(text, now, id);
      const { selected: _selected, ...edited } = { ...message, content: text, updated_at: now };
      return edited;
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

  /** Same rows the model sees: player inputs plus completed narration. */
  private completedHistoryCharacters(sessionId: string): number {
    const row = this.db
      .query<{ total: number | null }, [string]>(
        "SELECT SUM(length(content)) AS total FROM messages WHERE session_id = ? AND selected = 1 AND (role = 'user' OR status = 'complete')",
      )
      .get(sessionId);
    return row?.total ?? 0;
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
  ): void {
    this.db
      .query(
        `INSERT INTO messages (id, session_id, position, role, speaker_name, content, status, selected, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, sessionId, position, role, speakerName, content, status, now, now);
  }

  /**
   * Fixed narrator grounding, built only from the campaign's captured
   * snapshots. The protagonist, the narrator-controlled cast, and the
   * compendium use exclusively what was captured at creation — the live
   * library is never consulted, so edits and deletes to characters, world
   * casts, or world entries cannot rewrite an existing campaign's grounding.
   * A session grounded by a handoff never sees the starting situation: the
   * handoff replaces it verbatim (a fork inherits the closed source session's
   * handoff; a later session the one written at the previous close). The
   * campaign's current manual state is included as written — journals in
   * captured order. Only a story without prior narration asks the model to
   * start a scene.
   */
  narratorSystemPrompt(
    campaign: Campaign,
    state: CampaignStateItem[],
    handoff: string | null,
    hasHistory: boolean,
    relationships: RelationshipPrompt[] = [],
  ): string {
    const world = campaign.world_snapshot;
    const protagonist = campaign.protagonist_snapshot;
    const situation =
      handoff !== null
        ? `Handoff from the previous session: ${handoff}`
        : `Starting situation: ${
            campaign.starting_situation.trim().length > 0
              ? campaign.starting_situation
              : "No starting situation was given; open with a scene that fits the world."
          }`;
    const cast =
      campaign.cast.length > 0
        ? [
            "Narrator-controlled cast (captured at campaign creation):",
            ...campaign.cast.map((member) => `- ${member.name}: ${characterDefinition(member)}`),
            "Respect these definitions as written.",
          ]
        : [];
    const compendium =
      world.entries.length > 0
        ? [
            "Captured world compendium (captured at campaign creation):",
            ...world.entries.map((entry) => `- ${entry.kind}: ${entry.name} — ${entry.description}`),
            "Respect these definitions as written.",
          ]
        : [];
    const stateLines =
      state.length > 0
        ? [
            "Current campaign state:",
            ...state.map((item) => `- ${item.category} — ${item.subject}: ${item.content}`),
          ]
        : [];
    const relationshipLines =
      relationships.length > 0
        ? [
            "Current directional relationships (campaign-owned; use as canon, without inventing automatic changes):",
            ...relationships.map(({ source_name, target_name, document, recent_events }) =>
              `- ${source_name} → ${target_name}: how met: ${document.how_met}; status: ${document.status}; ` +
              `stats: ${JSON.stringify(document.stats)}; known facts: ${JSON.stringify(document.known_facts)}; ` +
              `sections: ${JSON.stringify(document.sections)}` +
              (recent_events.length > 0 ? `; recent events: ${JSON.stringify(recent_events)}` : ""),
            ),
          ]
        : [];
    return [
      "You are the narrator of an ongoing interactive story.",
      "",
      `World — ${world.name}: ${world.setting_brief}`,
      "",
      situation,
      "",
      `The player controls their character, ${protagonist.name}: ${characterDefinition(protagonist)}`,
      `Whenever the player speaks or acts, it is ${protagonist.name} acting.`,
      "",
      ...cast,
      "",
      ...compendium,
      "",
      ...stateLines,
      "",
      ...relationshipLines,
      "",
      "Narrate the world and every other character yourself; never narrate",
      `${protagonist.name}'s decisions, words, or thoughts.`,
      "",
      hasHistory
        ? "Continue the established story from the player's latest input; do not restart or retell earlier events."
        : handoff !== null
          ? "There is no prior narration in this session: continue the story from the handoff."
          : "There is no prior narration: begin the story now with an opening scene.",
    ].join("\n");
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
    campaign: Campaign;
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
    const history = this.modelHistory(sessionId);
    const state = listCampaignState(this.db, options.campaign.id);
    const handoff = sessionGroundingHandoff(this.db, options.campaign.id, sessionId);
    const relationships = relationshipNarrationContext(this.db, options.campaign);

    const { stream: upstream } = startZaiRun({
      model: options.settings.model,
      apiKey: options.settings.apiKey,
      systemPrompt: this.narratorSystemPrompt(
        options.campaign,
        state,
        handoff,
        history.length > 0,
        relationships,
      ),
      messages:
        history.length > 0
          ? history
          : [{ role: "user", content: "Begin the opening scene." }],
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
