import type { Database } from "bun:sqlite";
import type { PromptCard, PromptPreset } from "../shared/domain";
import { unknownPlaceholders } from "../shared/narration";
import { insertDefaultPromptCards, newId, nowIso } from "./db";
import { ValidationError, optionalText, requiredText } from "./worlds";

export type PromptCardPatch = Partial<Pick<PromptCard, "title" | "body" | "enabled">>;

/** `clone_of` names the preset whose cards are copied; null starts from the defaults. */
export interface PromptPresetInput {
  name: string;
  clone_of: string | null;
}

const CARD_COLUMNS = "id, title, body, enabled, position, created_at, updated_at";

interface PromptCardRow extends Omit<PromptCard, "enabled"> {
  enabled: number;
}

interface PromptPresetRow extends Omit<PromptPreset, "active"> {
  active: number;
}

function fromRow(row: PromptCardRow): PromptCard {
  return { ...row, enabled: row.enabled === 1 };
}

function presetFromRow(row: PromptPresetRow): PromptPreset {
  return { ...row, active: row.active === 1 };
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

function activePresetId(db: Database): string {
  return db.query<{ id: string }, []>("SELECT id FROM prompt_presets WHERE active = 1").get()!.id;
}

/** The active preset's cards, in order: what the narrator is sent and what the card routes edit. */
export function listPromptCards(db: Database): PromptCard[] {
  return db
    .query<PromptCardRow, [string]>(`SELECT ${CARD_COLUMNS} FROM prompt_cards WHERE preset_id = ? ORDER BY position, rowid`)
    .all(activePresetId(db))
    .map(fromRow);
}

function getPromptCard(db: Database, id: string): PromptCard | null {
  const row = db.query<PromptCardRow, [string]>(`SELECT ${CARD_COLUMNS} FROM prompt_cards WHERE id = ?`).get(id);
  return row ? fromRow(row) : null;
}

export function createPromptCard(db: Database, input: Pick<PromptCard, "title" | "body" | "enabled">): PromptCard {
  const now = nowIso();
  const presetId = activePresetId(db);
  const position = db
    .query<{ next: number }, [string]>("SELECT COALESCE(MAX(position), 0) + 1 AS next FROM prompt_cards WHERE preset_id = ?")
    .get(presetId)!.next;
  const card: PromptCard = { id: newId(), ...input, position, created_at: now, updated_at: now };
  db.query(
    "INSERT INTO prompt_cards (id, preset_id, title, body, enabled, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(card.id, presetId, card.title, card.body, card.enabled ? 1 : 0, card.position, now, now);
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

/** `ids` must name every card of the active preset exactly once; positions become 1..n in that order. */
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
  db.transaction(() => insertDefaultPromptCards(db, activePresetId(db)))();
  return listPromptCards(db);
}

export function parsePromptPresetInput(body: Record<string, unknown>): PromptPresetInput {
  const cloneOf = body.clone_of ?? null;
  if (cloneOf !== null && typeof cloneOf !== "string") throw new ValidationError("clone_of must be a preset id or null");
  return { name: requiredText(body.name, "name"), clone_of: cloneOf };
}

export function parsePromptPresetPatch(body: Record<string, unknown>): { name: string } {
  return { name: requiredText(body.name, "name") };
}

export function listPromptPresets(db: Database): PromptPreset[] {
  return db.query<PromptPresetRow, []>("SELECT * FROM prompt_presets ORDER BY created_at, rowid").all().map(presetFromRow);
}

function getPromptPreset(db: Database, id: string): PromptPreset | null {
  const row = db.query<PromptPresetRow, [string]>("SELECT * FROM prompt_presets WHERE id = ?").get(id);
  return row ? presetFromRow(row) : null;
}

function activate(db: Database, id: string): void {
  db.query("UPDATE prompt_presets SET active = 0 WHERE active = 1").run();
  db.query("UPDATE prompt_presets SET active = 1 WHERE id = ?").run(id);
}

/**
 * A new preset, active from now on, holding the defaults or a copy of
 * `clone_of`'s cards (order and switches kept). Null when `clone_of` is unknown.
 */
export function createPromptPreset(db: Database, input: PromptPresetInput): PromptPreset | null {
  return db.transaction((): PromptPreset | null => {
    if (input.clone_of !== null && !getPromptPreset(db, input.clone_of)) return null;
    const now = nowIso();
    const id = newId();
    db.query("INSERT INTO prompt_presets (id, name, active, created_at, updated_at) VALUES (?, ?, 0, ?, ?)").run(id, input.name, now, now);
    if (input.clone_of === null) {
      insertDefaultPromptCards(db, id);
    } else {
      const copy = db.query(
        "INSERT INTO prompt_cards (id, preset_id, title, body, enabled, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const source = db
        .query<PromptCardRow, [string]>(`SELECT ${CARD_COLUMNS} FROM prompt_cards WHERE preset_id = ? ORDER BY position, rowid`)
        .all(input.clone_of);
      source.forEach((card, index) => copy.run(newId(), id, card.title, card.body, card.enabled, index + 1, now, now));
    }
    activate(db, id);
    return getPromptPreset(db, id);
  }).immediate();
}

export function renamePromptPreset(db: Database, id: string, name: string): PromptPreset | null {
  const changed = db.query("UPDATE prompt_presets SET name = ?, updated_at = ? WHERE id = ?").run(name, nowIso(), id).changes > 0;
  return changed ? getPromptPreset(db, id) : null;
}

/** Makes `id` the preset every chat is narrated with; null when unknown. */
export function activatePromptPreset(db: Database, id: string): PromptPreset | null {
  return db.transaction((): PromptPreset | null => {
    if (!getPromptPreset(db, id)) return null;
    activate(db, id);
    return getPromptPreset(db, id);
  }).immediate();
}
