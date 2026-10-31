import type { Database } from "bun:sqlite";
import { EventType, fromSpecTokenUsage, toServerSentEventsResponse } from "@tanstack/ai";
import type { StreamChunk, TokenUsage } from "@tanstack/ai";
import type { MessageUsage, ReasoningLevel } from "../shared/domain";
import { nowIso } from "./db";
import { startNarrationRun, type NarrationMessage } from "./chat";
import type { ProviderApi } from "./providers";

export interface PlaySettings {
  api: ProviderApi;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  reasoning?: ReasoningLevel;
}

export type ReplyStatus = "complete" | "interrupted" | "failed";

/** Tables holding streamed replies; both carry `status`, `content`, `reasoning` and `reasoning_ms`. */
type ReplyTable = "messages" | "scratch_messages";

/** The provider's counts from a normal finish, null when it reported none. */
function providerUsage(chunk: Extract<StreamChunk, { type: EventType.RUN_FINISHED }>): MessageUsage["provider"] {
  const usage: TokenUsage | undefined = Array.isArray(chunk.usage)
    ? fromSpecTokenUsage(chunk.usage, chunk.metadata?.tanstack?.usage)
    : chunk.usage;
  if (!usage) return null;
  return {
    prompt_tokens: usage.promptTokens,
    cached_tokens: usage.promptTokensDetails?.cachedTokens ?? 0,
    completion_tokens: usage.completionTokens,
  };
}

interface ActiveRun {
  controller: AbortController;
  messageId: string;
  partial: string;
  reasoning: string;
  settled: boolean;
  /** Stop, failure and completion share this first-wins settlement. */
  settle: (status: ReplyStatus) => void;
  /** Every chunk forwarded so far, replayed to readers that attach mid-run. */
  log: StreamChunk[];
  readers: Set<RunReader>;
  /** Ends every reader's stream. */
  end: () => void;
}

interface RunReader {
  push: (chunk: StreamChunk) => void;
  end: () => void;
}

/**
 * Runs pending replies stored in one table, at most one per chat, and settles
 * each exactly once. A run belongs to the server until it settles: browsers
 * only read it, closing one leaves it generating, and only Stop cancels it.
 * One Bun backend means the in-memory registry covers every live generation
 * of that table.
 */
export class ReplyRuns {
  private runs = new Map<string, ActiveRun>();

  constructor(
    private db: Database,
    private table: ReplyTable,
    /** Runs after a pending row actually changed status. */
    private onSettled: (messageId: string) => void = () => {},
  ) {}

  /**
   * CAS settlement: only a still-pending row can change status, so Stop,
   * failure and completion can race without overwriting each
   * other, and late chunks can never alter a settled reply.
   */
  settlePending(messageId: string, status: ReplyStatus, content: string): boolean {
    const settled =
      this.db
        .query(`UPDATE ${this.table} SET status = ?, content = ?, updated_at = ? WHERE id = ? AND status = 'pending'`)
        .run(status, content, nowIso(), messageId).changes > 0;
    if (settled) this.onSettled(messageId);
    return settled;
  }

  /**
   * Starts one run: a single lifecycle generator persists and settles before
   * each chunk is forwarded, and deltas persist into the pending row as they
   * arrive, so partial text survives Stop and crashes. The returned response
   * is the first reader.
   */
  stream(options: {
    chatId: string;
    messageId: string;
    systemPrompt: string;
    messages: NarrationMessage[];
    settings: PlaySettings;
    /** Recorded with the provider's counts on a normal finish; null stores no usage. */
    estimate: MessageUsage["estimate"] | null;
    /** RUN_ERROR text for a normal finish without any reply text. */
    emptyReply: string;
    /** Acceptance headers the browser needs before the first byte. */
    headers: Record<string, string>;
    upstreamFetch?: typeof fetch;
  }): Response {
    const runs = this;
    const { chatId } = options;

    // First terminal settlement wins and releases the exclusivity slot, so a
    // stalled upstream can never hold a chat hostage.
    const run: ActiveRun = {
      controller: new AbortController(),
      messageId: options.messageId,
      partial: "",
      reasoning: "",
      settled: false,
      settle(status) {
        if (run.settled) return;
        run.settled = true;
        runs.settlePending(run.messageId, status, run.partial);
        if (runs.runs.get(chatId) === run) runs.runs.delete(chatId);
      },
      log: [],
      readers: new Set(),
      end() {
        for (const reader of run.readers) reader.end();
        run.readers.clear();
      },
    };
    this.runs.set(chatId, run);

    const { stream: upstream } = startNarrationRun({
      threadId: chatId,
      api: options.settings.api,
      baseUrl: options.settings.baseUrl,
      model: options.settings.model,
      apiKey: options.settings.apiKey,
      reasoning: options.settings.reasoning,
      systemPrompt: options.systemPrompt,
      messages: options.messages,
      abortController: run.controller,
      upstreamFetch: options.upstreamFetch,
    });

    void (async () => {
      try {
        for await (const chunk of this.lifecycle(run, upstream, options.estimate, options.emptyReply)) {
          run.log.push(chunk);
          for (const reader of run.readers) reader.push(chunk);
        }
      } catch (error) {
        // Nothing awaits this task: an escaping error would be an unhandled rejection.
        console.error("Reply run failed", error);
      } finally {
        run.end();
      }
    })();

    return this.readerResponse(run, options.headers);
  }

  /**
   * Joins the chat's live run from any browser: every chunk forwarded so
   * far, then the rest as they arrive. `null` when nothing is generating.
   */
  attach(chatId: string): Response | null {
    const run = this.runs.get(chatId);
    return run ? this.readerResponse(run, {}) : null;
  }

  /**
   * One SSE reader of a run. Copying the log and registering happen in the
   * same synchronous step, so no chunk is missed or repeated; cancelling the
   * response removes only this reader.
   */
  private readerResponse(run: ActiveRun, headers: Record<string, string>): Response {
    const queue = [...run.log];
    let ended = false;
    let wake: (() => void) | undefined;
    const reader: RunReader = {
      push(chunk) {
        queue.push(chunk);
        wake?.();
      },
      end() {
        ended = true;
        wake?.();
      },
    };
    run.readers.add(reader);
    const cancel = new AbortController();
    const detach = () => {
      run.readers.delete(reader);
      reader.end();
    };
    cancel.signal.addEventListener("abort", detach, { once: true });

    async function* read(): AsyncGenerator<StreamChunk> {
      try {
        while (true) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          if (ended) return;
          const { promise, resolve } = Promise.withResolvers<void>();
          wake = resolve;
          await promise;
          wake = undefined;
        }
      } finally {
        detach();
      }
    }

    return toServerSentEventsResponse(read(), {
      headers: {
        ...headers,
        "x-storyfold-pending-message-id": run.messageId,
        "access-control-expose-headers":
          "x-storyfold-accepted, x-storyfold-player-message-id, x-storyfold-pending-message-id",
      },
      abortController: cancel,
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
    estimate: MessageUsage["estimate"] | null,
    emptyReply: string,
  ): AsyncGenerator<StreamChunk> {
    const persist = this.db.query(
      `UPDATE ${this.table} SET content = ?, updated_at = ? WHERE id = ? AND status = 'pending'`,
    );
    const persistReasoning = this.db.query(`UPDATE ${this.table} SET reasoning = ? WHERE id = ? AND status = 'pending'`);
    const recordReasoningTime = this.db.query(`UPDATE ${this.table} SET reasoning_ms = ? WHERE id = ?`);
    const recordUsage = estimate === null ? null : this.db.query(`UPDATE ${this.table} SET usage = ? WHERE id = ?`);
    // Providers and gateways may hold thinking back and send it in one burst
    // just before the reply, so its time runs from the request to the first
    // reply text (or the end of a run without any), not from its own deltas.
    let requestedAt = 0;
    let reasoningTimed = false;
    const endReasoning = () => {
      if (reasoningTimed || run.reasoning === "") return;
      reasoningTimed = true;
      recordReasoningTime.run(Date.now() - requestedAt, run.messageId);
    };
    async function* generate(): AsyncGenerator<StreamChunk> {
      requestedAt = Date.now();
      try {
        for await (const chunk of upstream) {
          if (run.settled) return; // Stop settled already: swallow late chunks.
          if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
            endReasoning();
            run.partial += chunk.delta;
            persist.run(run.partial, nowIso(), run.messageId);
            yield chunk;
            continue;
          }
          if (chunk.type === EventType.REASONING_MESSAGE_CONTENT) {
            run.reasoning += chunk.delta;
            persistReasoning.run(run.reasoning, run.messageId);
            yield chunk;
            continue;
          }
          if (chunk.type === EventType.RUN_FINISHED) {
            endReasoning();
            if (recordUsage && estimate) {
              recordUsage.run(JSON.stringify({ estimate, provider: providerUsage(chunk) } satisfies MessageUsage), run.messageId);
            }
            if (run.partial.trim().length > 0) {
              // Normal-stop evidence with real text: complete.
              run.settle("complete");
              yield chunk;
              return;
            }
            // An empty reply is a failure, never a silent success.
            run.settle("failed");
            yield {
              type: EventType.RUN_ERROR,
              message: emptyReply,
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
        // Abort from Stop, which settles synchronously.
        run.settle("interrupted");
      } finally {
        run.settle("interrupted");
      }
    }
    return generate();
  }

  /**
   * Server-owned Stop, usable from any browser and the only way to cancel a
   * run: settles the pending row first (releasing the exclusivity slot even
   * if the upstream never notices the abort), ends every reader, then cancels
   * the shared controller — aborting the real provider call. Late chunks land
   * on a settled run and are dropped.
   */
  stop(chatId: string): string | null {
    const run = this.runs.get(chatId);
    if (!run) return null;
    run.settle("interrupted");
    run.end();
    run.controller.abort();
    return run.messageId;
  }
}
