import type { Database } from "bun:sqlite";
import { EventType, toServerSentEventsResponse } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import type { Campaign, Message } from "../shared/domain";
import { newId, nowIso } from "./db";
import { ValidationError } from "./library";
import { startZaiRun, MAX_MESSAGE_CHARS, type NarrationMessage } from "./chat";

export const NARRATOR_NAME = "Narrator";

/** A reply is already being generated for this session; nothing was saved. */
export class BusyError extends Error {}

/** The session already contains completed opening narration. */
export class AlreadyOpenedError extends Error {}

export interface ReservedTurn {
  playerId: string | null;
  pendingId: string;
}

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
 * Owns the server-side play lifecycle: reserving turns atomically, streaming
 * narration, and settling every pending reply exactly once. One Bun backend
 * means the in-memory registry covers every live generation.
 */
export class PlayService {
  private runs = new Map<string, ActiveRun>();

  constructor(private db: Database) {}

  transcript(sessionId: string): Message[] {
    return this.db
      .query<Message, [string]>("SELECT * FROM messages WHERE session_id = ? ORDER BY position")
      .all(sessionId);
  }

  getMessage(messageId: string): Message | null {
    return this.db.query<Message, [string]>("SELECT * FROM messages WHERE id = ?").get(messageId) ?? null;
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
        if (this.hasPending(id)) throw new BusyError("A reply is already being generated for this session");
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

  /** Opening narration reserves only the pending row; no player input exists. */
  reserveOpening(sessionId: string): ReservedTurn {
    const opened = this.db
      .query<Message, [string]>(
        "SELECT * FROM messages WHERE session_id = ? AND role = 'assistant' AND status = 'complete' LIMIT 1",
      )
      .get(sessionId);
    if (opened) throw new AlreadyOpenedError("This campaign has already opened");

    const reserve = this.db.transaction((id: string): ReservedTurn => {
      if (this.hasPending(id)) throw new BusyError("A reply is already being generated for this session");
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

  private hasPending(sessionId: string): boolean {
    return (
      this.db
        .query<unknown, [string]>(
          "SELECT 1 FROM messages WHERE session_id = ? AND role = 'assistant' AND status = 'pending' LIMIT 1",
        )
        .get(sessionId) !== null
    );
  }

  private nextPosition(sessionId: string): number {
    const row = this.db
      .query<{ next: number }, [string]>(
        "SELECT COALESCE(MAX(position), 0) + 1 AS next FROM messages WHERE session_id = ?",
      )
      .get(sessionId)!;
    return row.next;
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
        `INSERT INTO messages (id, session_id, position, role, speaker_name, content, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, position, role, speakerName, content, status, now, now);
  }

  /**
   * Fixed narrator grounding, built only from the campaign's captured
   * snapshots. The campaign's starting situation is used as written — a
   * deliberately blank one stays blank; the world's suggestion is never
   * reapplied. Only a story without prior narration asks the model to start a
   * scene; an opening retried after accepted player turns continues the story.
   */
  narratorSystemPrompt(campaign: Campaign, opening: boolean, hasHistory: boolean): string {
    const world = campaign.world_snapshot;
    const persona = campaign.persona_snapshot;
    const situation =
      campaign.starting_situation.trim().length > 0
        ? campaign.starting_situation
        : "No starting situation was given; open with a scene that fits the world.";
    return [
      "You are the narrator of an ongoing interactive story.",
      "",
      `World — ${world.name}: ${world.setting_brief}`,
      "",
      `Starting situation: ${situation}`,
      "",
      `The player controls their persona, ${persona.name}: ${persona.description}`,
      `Whenever the player speaks or acts, it is ${persona.name} acting.`,
      "",
      "Narrate the world and every other character yourself; never narrate",
      `${persona.name}'s decisions, words, or thoughts.`,
      "",
      hasHistory
        ? "Continue the established story from the player's latest input; do not restart or retell earlier events."
        : "There is no prior narration: begin the story now with an opening scene.",
      ...(opening && hasHistory
        ? ["An opening was requested after earlier turns: continue, do not restart."]
        : []),
    ].join("\n");
  }

  /** Completed narration and accepted player input only, in position order. */
  modelHistory(sessionId: string): NarrationMessage[] {
    return this.db
      .query<{ role: "user" | "assistant"; content: string }, [string]>(
        "SELECT role, content FROM messages WHERE session_id = ? AND (role = 'user' OR status = 'complete') ORDER BY position",
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

    // An opening request (no player row) is the protocol kind; whether the
    // story actually starts fresh depends on the history: an opening retried
    // after accepted player turns must continue, never restart.
    const opening = options.playerId === null;
    const history = this.modelHistory(sessionId);

    const { stream: upstream } = startZaiRun({
      model: options.settings.model,
      apiKey: options.settings.apiKey,
      systemPrompt: this.narratorSystemPrompt(options.campaign, opening, history.length > 0),
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
