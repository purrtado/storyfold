import type { Database } from "bun:sqlite";
import type { PromptCard } from "../shared/domain";
import { unknownPlaceholders } from "../shared/narration";
import { insertDefaultPromptCards, newId, nowIso } from "./db";
import { ValidationError, optionalText, requiredText } from "./worlds";

export type PromptCardPatch = Partial<Pick<PromptCard, "title" | "body" | "enabled">>;

interface PromptCardRow extends Omit<PromptCard, "enabled"> {
  enabled: number;
}

function fromRow(row: PromptCardRow): PromptCard {
  return { ...row, enabled: row.enabled === 1 };
}

function parseBody(value: unknown): string {
  const body = optionalText(value, "body");
  const unknown = unknownPlaceholders(body);
  if (unknown.length > 0) {
    throw new ValidationError(`unknown placeholders: ${unknown.map((name) => `{{${name}}}`).join(", ")}`);
  }
  return body;
}

function parseEnabled(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ValidationError("enabled must be a boolean");
  return value;
}

export function parsePromptCardInput(body: Record<string, unknown>): Pick<PromptCard, "title" | "body" | "enabled"> {
  return {
    title: requiredText(body.title, "title"),
    body: body.body === undefined ? "" : parseBody(body.body),
    enabled: body.enabled === undefined ? true : parseEnabled(body.enabled),
  };
}

export function parsePromptCardPatch(body: Record<string, unknown>): PromptCardPatch {
  const patch: PromptCardPatch = {};
  if (body.title !== undefined) patch.title = requiredText(body.title, "title");
  if (body.body !== undefined) patch.body = parseBody(body.body);
  if (body.enabled !== undefined) patch.enabled = parseEnabled(body.enabled);
  if (Object.keys(patch).length === 0) throw new ValidationError("at least one of title, body, enabled is required");
  return patch;
}

export function listPromptCards(db: Database): PromptCard[] {
  return db
    .query<PromptCardRow, []>("SELECT * FROM prompt_cards ORDER BY position, rowid")
    .all()
    .map(fromRow);
}

function getPromptCard(db: Database, id: string): PromptCard | null {
  const row = db.query<PromptCardRow, [string]>("SELECT * FROM prompt_cards WHERE id = ?").get(id);
  return row ? fromRow(row) : null;
}

export function createPromptCard(db: Database, input: Pick<PromptCard, "title" | "body" | "enabled">): PromptCard {
  const now = nowIso();
  const position = db.query<{ next: number }, []>("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM prompt_cards").get()!.next;
  const card: PromptCard = { id: newId(), ...input, position, created_at: now, updated_at: now };
  db.query(
    "INSERT INTO prompt_cards (id, title, body, enabled, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(card.id, card.title, card.body, card.enabled ? 1 : 0, card.position, now, now);
  return card;
}

export function updatePromptCard(db: Database, id: string, patch: PromptCardPatch): PromptCard | null {
  const existing = getPromptCard(db, id);
  if (!existing) return null;
  const next: PromptCard = { ...existing, ...patch, updated_at: nowIso() };
  db.query("UPDATE prompt_cards SET title = ?, body = ?, enabled = ?, updated_at = ? WHERE id = ?").run(
    next.title,
    next.body,
    next.enabled ? 1 : 0,
    next.updated_at,
    id,
  );
  return next;
}

export function deletePromptCard(db: Database, id: string): boolean {
  return db.query("DELETE FROM prompt_cards WHERE id = ?").run(id).changes > 0;
}

/** `ids` must name every card exactly once; positions become 1..n in that order. */
export function reorderPromptCards(db: Database, value: unknown): PromptCard[] {
  const existing = new Set(listPromptCards(db).map((card) => card.id));
  if (
    !Array.isArray(value) ||
    value.length !== existing.size ||
    new Set(value).size !== value.length ||
    value.some((id) => typeof id !== "string" || !existing.has(id))
  ) {
    throw new ValidationError("ids must list every prompt card exactly once");
  }
  db.transaction(() => {
    const update = db.query("UPDATE prompt_cards SET position = ? WHERE id = ?");
    value.forEach((id, index) => update.run(index + 1, id));
  })();
  return listPromptCards(db);
}

export function resetPromptCards(db: Database): PromptCard[] {
  db.transaction(() => insertDefaultPromptCards(db))();
  return listPromptCards(db);
}
