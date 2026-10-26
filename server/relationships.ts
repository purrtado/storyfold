import type { Database } from "bun:sqlite";
import type { Campaign, Relationship, StatValues } from "../shared/domain";
import type { RelationshipPrompt } from "../shared/narration";
import { newId, nowIso } from "./db";
import { parseStatValues, statDefaults } from "./library";

const TEXT_LIMIT = 2_000;
const KNOWN_FACTS_LIMIT = 100;
const RELATIONSHIP_COUNT_LIMIT = 100;

export class RelationshipValidationError extends Error {}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > TEXT_LIMIT) {
    throw new RelationshipValidationError(`${field} must be text of at most ${TEXT_LIMIT} characters`);
  }
  return value.trim();
}

function knownFacts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > KNOWN_FACTS_LIMIT) {
    throw new RelationshipValidationError(`known_facts must be a list of at most ${KNOWN_FACTS_LIMIT} items`);
  }
  return value.map((fact) => text(fact, "known fact")).filter((fact) => fact.length > 0);
}

/** The fixed relationship template; any provided field is validated, stats against the campaign's relationship stats. */
export interface RelationshipPatch {
  how_met?: string;
  status?: string;
  known_facts?: string[];
  stats?: StatValues;
}

export function parseRelationshipPatch(body: Record<string, unknown>, campaign: Campaign): RelationshipPatch {
  return {
    ...(body.how_met !== undefined ? { how_met: text(body.how_met, "how_met") } : {}),
    ...(body.status !== undefined ? { status: text(body.status, "status") } : {}),
    ...(body.known_facts !== undefined ? { known_facts: knownFacts(body.known_facts) } : {}),
    ...(body.stats !== undefined ? { stats: parseStatValues(body.stats, campaign.stats, "relationship") } : {}),
  };
}

interface RelationshipRow extends Omit<Relationship, "known_facts" | "stats"> {
  known_facts: string;
  stats: string;
}

function relationshipFromRow(row: RelationshipRow): Relationship {
  return { ...row, known_facts: JSON.parse(row.known_facts) as string[], stats: JSON.parse(row.stats) as StatValues };
}

export function listRelationships(db: Database, campaignId: string): Relationship[] {
  return db.query<RelationshipRow, [string]>(
    "SELECT * FROM relationships WHERE campaign_id = ? ORDER BY created_at,id",
  ).all(campaignId).map(relationshipFromRow);
}

export function relationshipNarrationContext(db: Database, campaign: Campaign): RelationshipPrompt[] {
  const names = new Map(campaign.characters.map((character) => [character.id, character.name]));
  return listRelationships(db, campaign.id).map((relationship) => ({
    source_id: relationship.source_id,
    target_id: relationship.target_id,
    source_name: names.get(relationship.source_id)!,
    target_name: names.get(relationship.target_id)!,
    how_met: relationship.how_met,
    status: relationship.status,
    known_facts: relationship.known_facts,
    stats: relationship.stats,
  }));
}

/** A new relationship carries every relationship stat, at its default unless given. */
export function createRelationship(db: Database, campaign: Campaign, sourceId: unknown, targetId: unknown, input: RelationshipPatch): Relationship {
  const ids = campaign.characters.map((character) => character.id);
  if (typeof sourceId !== "string" || typeof targetId !== "string" || !ids.includes(sourceId) || !ids.includes(targetId)) {
    throw new RelationshipValidationError("source_id and target_id must identify characters of this campaign");
  }
  if (sourceId === targetId) throw new RelationshipValidationError("source_id and target_id must differ");
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
  const relationship: Relationship = {
    id: newId(),
    campaign_id: campaign.id,
    source_id: sourceId,
    target_id: targetId,
    how_met: input.how_met ?? "",
    status: input.status ?? "",
    known_facts: input.known_facts ?? [],
    stats: { ...statDefaults(campaign.stats, "relationship"), ...input.stats },
    created_at: now,
    updated_at: now,
  };
  db.query(
    "INSERT INTO relationships (id,campaign_id,source_id,target_id,how_met,status,known_facts,stats,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(
    relationship.id,
    campaign.id,
    sourceId,
    targetId,
    relationship.how_met,
    relationship.status,
    JSON.stringify(relationship.known_facts),
    JSON.stringify(relationship.stats),
    now,
    now,
  );
  return relationship;
}

/** Last save wins; stats merge into the existing values. */
export function updateRelationship(db: Database, campaign: Campaign, id: string, patch: RelationshipPatch): Relationship | null {
  const row = db.query<RelationshipRow, [string, string]>("SELECT * FROM relationships WHERE id=? AND campaign_id=?").get(id, campaign.id);
  if (!row) return null;
  const existing = relationshipFromRow(row);
  const next: Relationship = { ...existing, ...patch, stats: { ...existing.stats, ...patch.stats }, updated_at: nowIso() };
  db.query("UPDATE relationships SET how_met=?,status=?,known_facts=?,stats=?,updated_at=? WHERE id=?").run(
    next.how_met,
    next.status,
    JSON.stringify(next.known_facts),
    JSON.stringify(next.stats),
    next.updated_at,
    id,
  );
  return next;
}

export function deleteRelationship(db: Database, campaignId: string, id: string): boolean {
  return db.query("DELETE FROM relationships WHERE id=? AND campaign_id=?").run(id, campaignId).changes > 0;
}
