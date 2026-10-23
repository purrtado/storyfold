import type { Database } from "bun:sqlite";
import type { Campaign, Relationship, RelationshipDocument, RelationshipSubject } from "../shared/domain";
import type { RelationshipPrompt } from "../shared/narration";
import { newId, nowIso } from "./db";

const TEXT_LIMIT = 2_000;
const RELATIONSHIP_COUNT_LIMIT = 100;
const FORBIDDEN_KEYS: readonly string[] = ["__proto__", "prototype", "constructor"];

export class RelationshipValidationError extends Error {}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, field: string, max = TEXT_LIMIT): string {
  if (typeof value !== "string" || value.length > max) {
    throw new RelationshipValidationError(`${field} must be text of at most ${max} characters`);
  }
  return value;
}

export function parseRelationshipDocument(value: unknown): RelationshipDocument {
  if (!object(value) || Object.keys(value).some((key) => !["how_met", "status", "stats", "known_facts", "sections"].includes(key))) {
    throw new RelationshipValidationError("document has an invalid shape");
  }
  if (!object(value.stats) || Object.keys(value.stats).length > 50) {
    throw new RelationshipValidationError("stats must be an object with at most 50 values");
  }
  const stats: RelationshipDocument["stats"] = {};
  for (const [key, raw] of Object.entries(value.stats)) {
    if (key.length === 0 || key.length > 80 || FORBIDDEN_KEYS.includes(key) || !object(raw) ||
      Object.keys(raw).some((field) => !["value", "min", "max"].includes(field)) ||
      ![raw.value, raw.min, raw.max].every((number) => typeof number === "number" && Number.isFinite(number)) ||
      (raw.min as number) > (raw.max as number) || (raw.value as number) < (raw.min as number) || (raw.value as number) > (raw.max as number)) {
      throw new RelationshipValidationError(`invalid stat: ${key}`);
    }
    stats[key] = { value: raw.value as number, min: raw.min as number, max: raw.max as number };
  }
  if (!Array.isArray(value.known_facts) || value.known_facts.length > 100) {
    throw new RelationshipValidationError("known_facts must be a list of at most 100 items");
  }
  const known_facts = value.known_facts.map((fact) => text(fact, "known fact"));
  if (!Array.isArray(value.sections) || value.sections.length > 50) {
    throw new RelationshipValidationError("sections must be a list of at most 50 items");
  }
  const sectionIds = new Set<string>();
  const sections = value.sections.map((raw) => {
    if (!object(raw) || Object.keys(raw).some((key) => !["id", "label", "type", "value"].includes(key))) {
      throw new RelationshipValidationError("section has an invalid shape");
    }
    const id = text(raw.id, "section id", 80);
    if (id.length === 0 || sectionIds.has(id)) throw new RelationshipValidationError("section ids must be unique and non-empty");
    sectionIds.add(id);
    const label = text(raw.label, "section label", 120);
    if (raw.type === "text") return { id, label, type: "text" as const, value: text(raw.value, "section value") };
    if (raw.type === "list" && Array.isArray(raw.value) && raw.value.length <= 100) {
      return { id, label, type: "list" as const, value: raw.value.map((item) => text(item, "section item")) };
    }
    throw new RelationshipValidationError("section type and value do not match");
  });
  return {
    how_met: text(value.how_met, "how_met"),
    status: text(value.status, "status"),
    stats,
    known_facts,
    sections,
  };
}

function subjects(db: Database, campaign: Campaign): RelationshipSubject[] {
  return [
    { id: campaign.protagonist_snapshot.id, name: campaign.protagonist_snapshot.name, kind: "character" as const },
    ...campaign.cast.map((item) => ({ id: item.id, name: item.name, kind: "character" as const })),
    ...campaign.world_snapshot.entries.filter((item) => item.kind === "local_npc")
      .map((item) => ({ id: item.id, name: item.name, kind: "entry" as const })),
    ...db.query<{ id: string; name: string }, [string]>("SELECT id,name FROM relationship_subjects WHERE campaign_id = ? ORDER BY created_at,id")
      .all(campaign.id).map((item) => ({ ...item, kind: "local_character" as const })),
  ];
}

export function listRelationships(db: Database, campaign: Campaign): { subjects: RelationshipSubject[]; relationships: Relationship[] } {
  return { subjects: subjects(db, campaign), relationships: db.query<RelationshipRow, [string]>(
    "SELECT * FROM relationships WHERE campaign_id = ? ORDER BY created_at,id",
  ).all(campaign.id).map(relationshipFromRow) };
}

interface RelationshipRow extends Omit<Relationship, "document"> { document: string }
function relationshipFromRow(row: RelationshipRow): Relationship {
  return { ...row, document: JSON.parse(row.document) as RelationshipDocument };
}

export function createRelationshipSubject(db: Database, campaignId: string, name: string): RelationshipSubject {
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 120) {
    throw new RelationshipValidationError("name must contain 1 to 120 characters");
  }
  const now = nowIso();
  const subject = { id: newId(), name: name.trim(), kind: "local_character" as const };
  db.query("INSERT INTO relationship_subjects (id,campaign_id,name,created_at) VALUES (?,?,?,?)")
    .run(subject.id, campaignId, subject.name, now);
  return subject;
}

function requireSubject(db: Database, campaign: Campaign, id: string): void {
  if (subjects(db, campaign).some((subject) => subject.id === id)) return;
  throw new RelationshipValidationError("source_id and target_id must identify campaign subjects");
}

export function relationshipNarrationContext(db: Database, campaign: Campaign): RelationshipPrompt[] {
  const { subjects: available, relationships } = listRelationships(db, campaign);
  const names = new Map(available.map((subject) => [subject.id, subject.name]));
  return relationships.map((relationship) => ({
    source_name: names.get(relationship.source_id)!,
    target_name: names.get(relationship.target_id)!,
    document: relationship.document,
  }));
}

export function createRelationship(db: Database, campaign: Campaign, sourceId: string, targetId: string, document: RelationshipDocument): Relationship {
  if (sourceId === targetId) throw new RelationshipValidationError("source_id and target_id must differ");
  requireSubject(db, campaign, sourceId);
  requireSubject(db, campaign, targetId);
  if (db.query("SELECT 1 FROM relationships WHERE campaign_id=? AND source_id=? AND target_id=?")
    .get(campaign.id, sourceId, targetId)) {
    throw new RelationshipValidationError("a relationship already exists for this directional pair");
  }
  const count = db.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM relationships WHERE campaign_id=?")
    .get(campaign.id)!.count;
  if (count >= RELATIONSHIP_COUNT_LIMIT) {
    throw new RelationshipValidationError(`campaigns support at most ${RELATIONSHIP_COUNT_LIMIT} directional relationships`);
  }
  const now = nowIso();
  const id = newId();
  db.query("INSERT INTO relationships (id,campaign_id,source_id,target_id,document,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, campaign.id, sourceId, targetId, JSON.stringify(document), now, now);
  return { id, campaign_id: campaign.id, source_id: sourceId, target_id: targetId, document, created_at: now, updated_at: now };
}

/** Last save wins. */
export function updateRelationship(db: Database, campaign: Campaign, id: string, document: RelationshipDocument): Relationship | null {
  const row = db.query<RelationshipRow, [string, string]>("SELECT * FROM relationships WHERE id=? AND campaign_id=?").get(id, campaign.id);
  if (!row) return null;
  const json = JSON.stringify(document);
  const now = nowIso();
  db.query("UPDATE relationships SET document=?,updated_at=? WHERE id=? AND campaign_id=?").run(json, now, id, campaign.id);
  return relationshipFromRow({ ...row, document: json, updated_at: now });
}

export function deleteRelationship(db: Database, campaignId: string, id: string): boolean {
  return db.query("DELETE FROM relationships WHERE id=? AND campaign_id=?").run(id, campaignId).changes > 0;
}
