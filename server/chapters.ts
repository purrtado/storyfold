import type { Database } from "bun:sqlite";
import { EventType } from "@tanstack/ai";
import type { Chapter, MessageUsage } from "../shared/domain";
import { CHAPTER_SUMMARY_PROMPT, chapterSummaryRequest } from "../shared/narration";
import { countTokens } from "../shared/tokens";
import { providerUsage, startNarrationRun } from "./chat";
import { getChat } from "./chats";
import { newId, nowIso } from "./db";
import { BusyError, type PlaySettings } from "./play";
import { ConflictError, UnknownEntityError, ValidationError, getWorld, requiredText } from "./worlds";

/** The summary call failed; the message and code are the sanitized upstream ones. */
export class SummaryFailedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

interface ChapterRow {
  id: string;
  chat_id: string;
  start_position: number;
  end_position: number;
  summary: string;
  edited: number;
  model: string;
  usage: string | null;
  created_at: string;
  updated_at: string;
}

const CHAPTER_COLUMNS = "id, chat_id, start_position, end_position, summary, edited, model, usage, created_at, updated_at";

interface SourceMessage {
  id: string;
  role: "user" | "assistant";
  speaker_name: string;
  content: string;
  updated_at: string;
}

/** The messages a chapter stands in for: what model history would send from those positions. */
function sourceMessages(db: Database, chatId: string, start: number, end: number): SourceMessage[] {
  return db
    .query<SourceMessage, [string, number, number]>(
      `SELECT id, role, speaker_name, content, updated_at FROM messages
       WHERE chat_id = ? AND selected = 1 AND (role = 'user' OR status = 'complete') AND position BETWEEN ? AND ?
       ORDER BY position`,
    )
    .all(chatId, start, end);
}

/** Changes whenever a message in the range is edited, swapped, added, or removed. */
function fingerprint(messages: ReadonlyArray<SourceMessage>): string {
  return messages.map((message) => `${message.id}@${message.updated_at}`).join(",");
}

function chapterRows(db: Database, chatId: string): ChapterRow[] {
  return db
    .query<ChapterRow, [string]>(`SELECT ${CHAPTER_COLUMNS} FROM chapters WHERE chat_id = ? ORDER BY end_position`)
    .all(chatId);
}

function getChapterRow(db: Database, chatId: string, chapterId: string): ChapterRow | null {
  return (
    db
      .query<ChapterRow, [string, string]>(`SELECT ${CHAPTER_COLUMNS} FROM chapters WHERE id = ? AND chat_id = ?`)
      .get(chapterId, chatId) ?? null
  );
}

function chapterFromRow(db: Database, row: ChapterRow): Chapter {
  const covered = sourceMessages(db, row.chat_id, row.start_position, row.end_position);
  return {
    ...row,
    edited: row.edited === 1,
    usage: row.usage === null ? null : (JSON.parse(row.usage) as MessageUsage["provider"]),
    covered_tokens: covered.reduce((sum, message) => sum + countTokens(message.content), 0),
    summary_tokens: countTokens(row.summary),
  };
}

export function listChapters(db: Database, chatId: string): Chapter[] {
  return chapterRows(db, chatId).map((row) => chapterFromRow(db, row));
}

/** The summaries model history sends, oldest first, and the last position they cover (0 when none). */
export function chapterCoverage(db: Database, chatId: string): { summaries: string[]; coveredThrough: number } {
  const rows = db
    .query<{ summary: string; end_position: number }, [string]>(
      "SELECT summary, end_position FROM chapters WHERE chat_id = ? ORDER BY end_position",
    )
    .all(chatId);
  return { summaries: rows.map((row) => row.summary), coveredThrough: rows.at(-1)?.end_position ?? 0 };
}

/**
 * A change to the selected message at `position` makes the chapter covering
 * it stale, and every later one with it, so chapters keep covering a
 * contiguous run from the start. Their messages go back to model history.
 */
export function dropChaptersFrom(db: Database, chatId: string, position: number): void {
  db.query("DELETE FROM chapters WHERE chat_id = ? AND end_position >= ?").run(chatId, position);
}

/** A hand edit; the chapter keeps its range and is marked edited. */
export function updateChapterSummary(db: Database, chatId: string, chapterId: string, summary: string): Chapter | null {
  const row = getChapterRow(db, chatId, chapterId);
  if (!row) return null;
  const now = nowIso();
  db.query("UPDATE chapters SET summary = ?, edited = 1, updated_at = ? WHERE id = ?").run(summary, now, chapterId);
  return chapterFromRow(db, { ...row, summary, edited: 1, updated_at: now });
}

/** Deletes the chapter and every later one; null when it is not this chat's. */
export function deleteChapter(db: Database, chatId: string, chapterId: string): Chapter[] | null {
  const row = getChapterRow(db, chatId, chapterId);
  if (!row) return null;
  dropChaptersFrom(db, chatId, row.end_position);
  return listChapters(db, chatId);
}

export function parseChapterInput(body: Record<string, unknown>): { through_message_id: string } {
  return { through_message_id: requiredText(body.through_message_id, "through_message_id") };
}

export function parseChapterPatch(body: Record<string, unknown>): { summary: string } {
  return { summary: requiredText(body.summary, "summary").trim() };
}

interface SummaryOptions {
  signal?: AbortSignal;
  upstreamFetch?: typeof fetch;
}

/**
 * Writes chapter summaries with a model call. One summary runs per chat at a
 * time; the call runs outside any transaction, so its result commits only
 * when the messages it summarized and the chapters around it are unchanged.
 */
export class ChapterService {
  private writing = new Set<string>();

  constructor(private db: Database) {}

  /** A new chapter from the first uncovered position through `throughMessageId`, a selected completed narration. */
  async create(chatId: string, throughMessageId: string, settings: PlaySettings, options: SummaryOptions = {}): Promise<Chapter> {
    const target = this.db
      .query<{ position: number; role: string; status: string; selected: number }, [string, string]>(
        "SELECT position, role, status, selected FROM messages WHERE id = ? AND chat_id = ?",
      )
      .get(throughMessageId, chatId);
    if (!target) throw new UnknownEntityError("Unknown message");
    if (target.role !== "assistant" || target.status !== "complete" || target.selected !== 1) {
      throw new ValidationError("A chapter ends on a completed narration");
    }
    const coveredThrough = chapterCoverage(this.db, chatId).coveredThrough;
    if (target.position <= coveredThrough) throw new ValidationError("This message is already in a chapter");

    return this.write(chatId, coveredThrough + 1, target.position, settings, options, (summary, usage) => {
      if (chapterCoverage(this.db, chatId).coveredThrough !== coveredThrough) {
        throw new ConflictError("The chapters changed while this one was being summarized; summarize it again.");
      }
      const now = nowIso();
      const row: ChapterRow = {
        id: newId(),
        chat_id: chatId,
        start_position: coveredThrough + 1,
        end_position: target.position,
        summary,
        edited: 0,
        model: settings.model,
        usage,
        created_at: now,
        updated_at: now,
      };
      this.db
        .query(
          `INSERT INTO chapters (${CHAPTER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(row.id, row.chat_id, row.start_position, row.end_position, row.summary, row.edited, row.model, row.usage, row.created_at, row.updated_at);
      return chapterFromRow(this.db, row);
    });
  }

  /** Rewrites a chapter's summary from the same messages, replacing any hand edit. */
  async regenerate(chatId: string, chapterId: string, settings: PlaySettings, options: SummaryOptions = {}): Promise<Chapter> {
    const row = getChapterRow(this.db, chatId, chapterId);
    if (!row) throw new UnknownEntityError("Unknown chapter");

    return this.write(chatId, row.start_position, row.end_position, settings, options, (summary, usage) => {
      const current = getChapterRow(this.db, chatId, chapterId);
      if (!current || current.start_position !== row.start_position || current.end_position !== row.end_position) {
        throw new ConflictError("The chapter changed while it was being summarized; summarize it again.");
      }
      const now = nowIso();
      this.db
        .query("UPDATE chapters SET summary = ?, edited = 0, model = ?, usage = ?, updated_at = ? WHERE id = ?")
        .run(summary, settings.model, usage, now, chapterId);
      return chapterFromRow(this.db, { ...current, summary, edited: 0, model: settings.model, usage, updated_at: now });
    });
  }

  private async write(
    chatId: string,
    start: number,
    end: number,
    settings: PlaySettings,
    options: SummaryOptions,
    commit: (summary: string, usage: string | null) => Chapter,
  ): Promise<Chapter> {
    if (this.writing.has(chatId)) throw new BusyError("A chapter is already being summarized for this chat");
    this.writing.add(chatId);
    try {
      const chat = getChat(this.db, chatId);
      if (!chat) throw new UnknownEntityError("Unknown chat");
      const world = getWorld(this.db, chat.world_id)!;
      const messages = sourceMessages(this.db, chatId, start, end);
      const previous = chapterRows(this.db, chatId)
        .filter((row) => row.end_position < start)
        .map((row) => row.summary);
      const request = chapterSummaryRequest({ world, opening: chat.opening, previous, messages });
      const { text, usage } = await summarize(chatId, settings, request, options);
      return this.db.transaction(() => {
        if (fingerprint(sourceMessages(this.db, chatId, start, end)) !== fingerprint(messages)) {
          throw new ConflictError("The chapter's messages changed while it was being summarized; summarize it again.");
        }
        return commit(text, usage === null ? null : JSON.stringify(usage));
      }).immediate();
    } finally {
      this.writing.delete(chatId);
    }
  }
}

async function summarize(
  chatId: string,
  settings: PlaySettings,
  request: string,
  options: SummaryOptions,
): Promise<{ text: string; usage: MessageUsage["provider"] }> {
  const { stream } = startNarrationRun({
    threadId: `${chatId}:chapters`,
    api: settings.api,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    reasoning: settings.reasoning,
    systemPrompt: CHAPTER_SUMMARY_PROMPT,
    messages: [{ role: "user", content: request }],
    disconnectSignal: options.signal,
    upstreamFetch: options.upstreamFetch,
  });
  let text = "";
  for await (const chunk of stream) {
    if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) text += chunk.delta;
    else if (chunk.type === EventType.RUN_ERROR) {
      throw new SummaryFailedError(chunk.message ?? "The AI request failed. Please try again.", chunk.code ?? "upstream_error");
    } else if (chunk.type === EventType.RUN_FINISHED) {
      if (text.trim().length === 0) throw new SummaryFailedError("The model returned an empty summary. Try again.", "incomplete_generation");
      return { text: text.trim(), usage: providerUsage(chunk) };
    }
  }
  throw new SummaryFailedError("The summary stopped before it finished. Try again.", "incomplete_generation");
}
