import type { Database } from "bun:sqlite";
import type {
  Campaign,
  Relationship,
  RelationshipDocument,
  RelationshipEvent,
  RelationshipSubject,
} from "../shared/domain";
import { newId, nowIso } from "./db";

export const RELATIONSHIP_GROUNDING_LIMIT = 16_000;
const DOCUMENT_LIMIT = 8_000;
const TEXT_LIMIT = 2_000;
const FORBIDDEN_KEYS: readonly string[] = ["__proto__", "prototype", "constructor"];

export class RelationshipValidationError extends Error {}
export class RelationshipConflictError extends Error {}

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
  const document = {
    how_met: text(value.how_met, "how_met"),
    status: text(value.status, "status"),
    stats,
    known_facts,
    sections,
  } satisfies RelationshipDocument;
  if (JSON.stringify(document).length > DOCUMENT_LIMIT) {
    throw new RelationshipValidationError(`document must be at most ${DOCUMENT_LIMIT} characters`);
  }
  return document;
}

export const emptyRelationshipDocument = (): RelationshipDocument => ({
  how_met: "", status: "", stats: {}, known_facts: [], sections: [],
});

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

function assertGroundingCapacity(db: Database, campaignId: string, nextJson: string, replacingId?: string): void {
  const totals = db.query<{ total: number; count: number }, [string, string]>(
    "SELECT COALESCE(SUM(length(document)),0) AS total,COUNT(*) AS count FROM relationships WHERE campaign_id=? AND id != ?",
  ).get(campaignId, replacingId ?? "")!;
  if (totals.count >= 100 && replacingId === undefined) {
    throw new RelationshipValidationError("campaigns support at most 100 directional relationships");
  }
  if (totals.total + nextJson.length > RELATIONSHIP_GROUNDING_LIMIT) {
    throw new RelationshipValidationError(`campaign relationship documents exceed ${RELATIONSHIP_GROUNDING_LIMIT} characters`);
  }
}

export interface RelationshipPrompt {
  source_name: string;
  target_name: string;
  document: RelationshipDocument;
  recent_events: string[];
}

export function relationshipNarrationContext(db: Database, campaign: Campaign): RelationshipPrompt[] {
  const { subjects: available, relationships } = listRelationships(db, campaign);
  const names = new Map(available.map((subject) => [subject.id, subject.name]));
  const recent = db.query<{ relationship_id: string; description: string }, [string]>(
    "SELECT relationship_id,description FROM relationship_events WHERE campaign_id=? ORDER BY rowid DESC LIMIT 5",
  ).all(campaign.id).reverse();
  const byRelationship = new Map<string, string[]>();
  for (const event of recent) {
    const events = byRelationship.get(event.relationship_id) ?? [];
    events.push(event.description);
    byRelationship.set(event.relationship_id, events);
  }
  return relationships.map((relationship) => ({
    source_name: names.get(relationship.source_id)!,
    target_name: names.get(relationship.target_id)!,
    document: relationship.document,
    recent_events: byRelationship.get(relationship.id) ?? [],
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
  const json = JSON.stringify(document);
  assertGroundingCapacity(db, campaign.id, json);
  const now = nowIso();
  const id = newId();
  db.query("INSERT INTO relationships (id,campaign_id,source_id,target_id,document,revision,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)")
    .run(id, campaign.id, sourceId, targetId, json, now, now);
  return { id, campaign_id: campaign.id, source_id: sourceId, target_id: targetId, document, revision: 1, created_at: now, updated_at: now };
}

export function updateRelationship(db: Database, campaign: Campaign, id: string, document: RelationshipDocument, revision: number): Relationship | null {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new RelationshipValidationError("revision must be a positive integer");
  const row = db.query<RelationshipRow, [string, string]>("SELECT * FROM relationships WHERE id=? AND campaign_id=?").get(id, campaign.id);
  if (!row) return null;
  if (row.revision !== revision) throw new RelationshipConflictError("Relationship changed since it was loaded");
  const json = JSON.stringify(document);
  assertGroundingCapacity(db, campaign.id, json, id);
  const now = nowIso();
  const changes = db.query("UPDATE relationships SET document=?,revision=revision+1,updated_at=? WHERE id=? AND campaign_id=? AND revision=?")
    .run(json, now, id, campaign.id, revision).changes;
  if (changes === 0) throw new RelationshipConflictError("Relationship changed since it was loaded");
  return relationshipFromRow({ ...row, document: json, revision: revision + 1, updated_at: now });
}

export function deleteRelationship(db: Database, campaignId: string, id: string): boolean {
  return db.query("DELETE FROM relationships WHERE id=? AND campaign_id=?").run(id, campaignId).changes > 0;
}

export function listRelationshipEvents(db: Database, campaignId: string, relationshipId: string): RelationshipEvent[] | null {
  if (!db.query("SELECT 1 FROM relationships WHERE id=? AND campaign_id=?").get(relationshipId, campaignId)) return null;
  return db.query<RelationshipEvent, [string, string]>(
    "SELECT id,relationship_id,campaign_id,session_id,description,created_at FROM relationship_events WHERE relationship_id=? AND campaign_id=? ORDER BY rowid",
  ).all(relationshipId, campaignId);
}

export function appendRelationshipEvent(db: Database, campaign: Campaign, relationshipId: string, description: string): RelationshipEvent | null {
  if (typeof description !== "string" || description.trim().length === 0 || description.length > 1_000) {
    throw new RelationshipValidationError("description must contain 1 to 1000 characters");
  }
  if (!db.query("SELECT 1 FROM relationships WHERE id=? AND campaign_id=?").get(relationshipId, campaign.id)) return null;
  const event: RelationshipEvent = { id: newId(), relationship_id: relationshipId, campaign_id: campaign.id,
    session_id: campaign.active_session_id, description: description.trim(), created_at: nowIso() };
  db.query("INSERT INTO relationship_events (id,relationship_id,campaign_id,session_id,description,created_at) VALUES (?,?,?,?,?,?)")
    .run(event.id, event.relationship_id, event.campaign_id, event.session_id, event.description, event.created_at);
  return event;
}

export function checkpointRelationships(db: Database, campaignId: string, sessionId: string): void {
  const localSubjects = db.query<{ id: string; name: string }, [string]>(
    "SELECT id,name FROM relationship_subjects WHERE campaign_id=? ORDER BY created_at,id",
  ).all(campaignId);
  for (const subject of localSubjects) {
    db.query("INSERT INTO session_relationship_subject_checkpoints (id,session_id,campaign_id,subject_id,name,created_at) VALUES (?,?,?,?,?,?)")
      .run(newId(), sessionId, campaignId, subject.id, subject.name, nowIso());
  }
  const rows = db.query<RelationshipRow, [string]>("SELECT * FROM relationships WHERE campaign_id=? ORDER BY created_at,id").all(campaignId);
  for (const row of rows) {
    const events = db.query<RelationshipEvent, [string]>("SELECT id,relationship_id,campaign_id,session_id,description,created_at FROM relationship_events WHERE relationship_id=? ORDER BY rowid").all(row.id);
    db.query("INSERT INTO session_relationship_checkpoints (id,session_id,campaign_id,source_id,target_id,document,revision,events,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(newId(), sessionId, campaignId, row.source_id, row.target_id, row.document, row.revision, JSON.stringify(events), nowIso());
  }
}

/** Inserts one copied relationship plus its event history under new ids. */
function copyRelationship(
  db: Database,
  forkCampaignId: string,
  sourceId: string,
  targetId: string,
  document: string,
  revision: number,
  createdAt: string,
  events: RelationshipEvent[],
): void {
  const id = newId();
  db.query("INSERT INTO relationships (id,campaign_id,source_id,target_id,document,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, forkCampaignId, sourceId, targetId, document, revision, createdAt, nowIso());
  for (const sourceEvent of events) {
    db.query("INSERT INTO relationship_events (id,relationship_id,campaign_id,session_id,description,origin_event_id,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(newId(), id, forkCampaignId, sourceEvent.session_id, sourceEvent.description, sourceEvent.id, sourceEvent.created_at);
  }
}

function insertLocalSubjects(db: Database, forkCampaignId: string, subjects: Array<{ subject_id: string; name: string; created_at: string }>): Record<string, string> {
  const subjectIds: Record<string, string> = {};
  for (const subject of subjects) {
    const id = newId();
    subjectIds[subject.subject_id] = id;
    db.query("INSERT INTO relationship_subjects (id,campaign_id,name,created_at) VALUES (?,?,?,?)")
      .run(id, forkCampaignId, subject.name, subject.created_at);
  }
  return subjectIds;
}

export function forkRelationships(
  db: Database,
  sourceSessionId: string,
  forkCampaignId: string,
  subjectIds: Record<string, string>,
): void {
  const checkpoints = db.query<{ source_id: string; target_id: string; document: string; revision: number; created_at: string; events: string }, [string]>(
    "SELECT source_id,target_id,document,revision,created_at,events FROM session_relationship_checkpoints WHERE session_id=? ORDER BY created_at,id",
  ).all(sourceSessionId);
  for (const item of checkpoints) {
    copyRelationship(db, forkCampaignId, subjectIds[item.source_id] ?? item.source_id, subjectIds[item.target_id] ?? item.target_id, item.document, item.revision, item.created_at, JSON.parse(item.events) as RelationshipEvent[]);
  }
}

/** Copies the campaign's CURRENT local subjects, relationships, and event history into new ids. */
export function forkCampaignRelationships(db: Database, sourceCampaignId: string, forkCampaignId: string): void {
  const subjectIds = insertLocalSubjects(db, forkCampaignId, db.query<{ subject_id: string; name: string; created_at: string }, [string]>(
    "SELECT id AS subject_id,name,created_at FROM relationship_subjects WHERE campaign_id=? ORDER BY created_at,id",
  ).all(sourceCampaignId));
  const rows = db.query<RelationshipRow, [string]>("SELECT * FROM relationships WHERE campaign_id=? ORDER BY created_at,id").all(sourceCampaignId);
  for (const row of rows) {
    const events = db.query<RelationshipEvent, [string]>(
      "SELECT id,relationship_id,campaign_id,session_id,description,created_at FROM relationship_events WHERE relationship_id=? ORDER BY rowid",
    ).all(row.id);
    copyRelationship(db, forkCampaignId, subjectIds[row.source_id] ?? row.source_id, subjectIds[row.target_id] ?? row.target_id, row.document, row.revision, row.created_at, events);
  }
}

export function createCampaignLocalSubjects(db: Database, sourceSessionId: string, forkCampaignId: string): Record<string, string> {
  return insertLocalSubjects(db, forkCampaignId, db.query<{ subject_id: string; name: string; created_at: string }, [string]>(
    "SELECT subject_id,name,created_at FROM session_relationship_subject_checkpoints WHERE session_id=? ORDER BY created_at,id",
  ).all(sourceSessionId));
}

