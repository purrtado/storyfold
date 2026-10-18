import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db";
import {
  beginNextSession,
  createCampaign,
  createCharacter,
  createWorld,
  createWorldEntry,
  forkCampaignFromSession,
  getCampaign,
  parseCampaignInput,
} from "../library";
import { PlayService } from "../play";
import {
  appendRelationshipEvent,
  createRelationship,
  createRelationshipSubject,
  emptyRelationshipDocument,
  listRelationshipEvents,
  listRelationships,
  parseRelationshipDocument,
  relationshipNarrationContext,
  updateRelationship,
} from "../relationships";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "storyfold-relationships-"));
  directories.push(directory);
  const path = join(directory, "storyfold.db");
  const db = openDatabase(path);
  const world = createWorld(db, { name: "World", setting_brief: "A quiet harbor", suggested_starting_situation: "" });
  const protagonist = createCharacter(db, { name: "Mira", description: "A careful sailor." });
  const cast = createCharacter(db, { name: "Oren", description: "A retired navigator." });
  const stranger = createCharacter(db, { name: "Other", description: "Not in this campaign." });
  const npc = createWorldEntry(db, world.id, { kind: "local_npc", name: "Tamsin", description: "A lighthouse keeper." })!;
  const location = createWorldEntry(db, world.id, { kind: "location", name: "Old Pier", description: "A weathered pier." })!;
  const campaign = createCampaign(db, parseCampaignInput({
    world_id: world.id,
    protagonist_id: protagonist.id,
    cast_character_ids: [cast.id],
    entry_ids: [npc.id, location.id],
    starting_situation: "A storm approaches.",
  })).campaign;
  return { db, path, campaign, protagonist, cast, stranger, npc, location };
}

const document = (how_met: string) => ({ ...emptyRelationshipDocument(), how_met, status: "wary" });

test("relationships are directional, campaign-scoped, validated, and revision checked", () => {
  const { db, campaign, protagonist, cast, stranger, location } = setup();
  const forward = createRelationship(db, campaign, protagonist.id, cast.id, parseRelationshipDocument(document("At sea.")));
  const reverse = createRelationship(db, campaign, cast.id, protagonist.id, parseRelationshipDocument(document("At port.")));
  expect(forward.source_id).toBe(protagonist.id);
  expect(reverse.source_id).toBe(cast.id);
  expect(() => createRelationship(db, campaign, protagonist.id, cast.id, parseRelationshipDocument(document("Again.")))).toThrow();
  expect(() => createRelationship(db, campaign, protagonist.id, location.id, parseRelationshipDocument(document("No.")))).toThrow();
  expect(() => createRelationship(db, campaign, "foreign-subject", cast.id, parseRelationshipDocument(document("No.")))).toThrow();
  expect(() => createRelationship(db, campaign, protagonist.id, stranger.id, parseRelationshipDocument(document("No.")))).toThrow();
  expect(() => parseRelationshipDocument({ ...document(""), hidden: "not allowed" })).toThrow();
  expect(() => parseRelationshipDocument({ ...document(""), stats: { mood: { value: Number.POSITIVE_INFINITY, min: 0, max: 1 } } })).toThrow();
  expect(() => parseRelationshipDocument({ ...document(""), stats: { mood: { value: 2, min: 0, max: 1 } } })).toThrow();
  expect(() => parseRelationshipDocument({ ...document(""), sections: [
    { id: "secret", label: "One", type: "text", value: "A" },
    { id: "secret", label: "Two", type: "text", value: "B" },
  ] })).toThrow();
  expect(() => parseRelationshipDocument({ ...document("x".repeat(9_000)) })).toThrow();
  const changed = updateRelationship(db, campaign, forward.id, parseRelationshipDocument(document("Changed.")), forward.revision)!;
  expect(changed.revision).toBe(2);
  expect(() => updateRelationship(db, campaign, forward.id, parseRelationshipDocument(document("Stale.")), forward.revision)).toThrow();
  db.close();
  const reopened = openDatabase(join(directories[0]!, "storyfold.db"));
  expect(listRelationships(reopened, campaign).relationships.map((item) => item.id)).toEqual([forward.id, reverse.id]);
  reopened.close();
});

test("subjects, prompt grounding, session boundary, and fork copies remain isolated", () => {
  const { db, path, campaign, protagonist, npc } = setup();
  const local = createRelationshipSubject(db, campaign.id, "Ilyra");
  expect(listRelationships(db, campaign).subjects.some((subject) => subject.id === npc.id && subject.kind === "entry")).toBe(true);
  const relationship = createRelationship(db, campaign, protagonist.id, local.id, parseRelationshipDocument({
    ...document("Met during the eclipse."),
    stats: { trust: { value: 2, min: 0, max: 5 } },
    known_facts: ["She keeps a brass compass."],
    sections: [{ id: "promise", label: "Promise", type: "text", value: "Return the map." }],
  }));
  const originalEvent = appendRelationshipEvent(db, campaign, relationship.id, "Ilyra shared the map.")!;
  const context = relationshipNarrationContext(db, campaign);
  const prompt = new PlayService(db).narratorSystemPrompt(campaign, [], null, false, false, context);
  expect(prompt).toContain("Mira → Ilyra");
  expect(prompt).toContain("Met during the eclipse.");
  expect(prompt).toContain("Ilyra shared the map.");

  beginNextSession(db, campaign.id, { title: "After the storm", handoff: "The crew reached the lighthouse." });
  const closed = db.query<{ id: string }, [string]>("SELECT id FROM sessions WHERE campaign_id=? AND closed_at IS NOT NULL").get(campaign.id)!;
  const afterBoundary = getCampaign(db, campaign.id)!;
  const updated = updateRelationship(db, afterBoundary, relationship.id, parseRelationshipDocument(document("After checkpoint.")), relationship.revision)!;
  appendRelationshipEvent(db, afterBoundary, relationship.id, "A later session event.");
  const fork = forkAtCheckpoint(db, closed.id);
  const forkRelationship = listRelationships(db, fork.campaign).relationships[0]!;
  expect(forkRelationship.id).not.toBe(relationship.id);
  expect(forkRelationship.target_id).not.toBe(local.id);
  expect(listRelationships(db, fork.campaign).subjects.some((subject) => subject.id === forkRelationship.target_id && subject.name === "Ilyra")).toBe(true);
  const forkEvents = listRelationshipEvents(db, fork.campaign.id, forkRelationship.id)!;
  expect(forkEvents.map((event) => event.description)).toEqual(["Ilyra shared the map."]);
  expect(forkEvents[0]!.id).not.toBe(originalEvent.id);
  expect(forkEvents[0]!.session_id).toBe(closed.id);
  expect(listRelationshipEvents(db, campaign.id, relationship.id)!.map((event) => event.description)).toHaveLength(2);
  expect(updated.document.how_met).toBe("After checkpoint.");
  db.close();
  const reopened = openDatabase(path);
  expect(listRelationshipEvents(reopened, fork.campaign.id, forkRelationship.id)!.length).toBe(1);
  reopened.close();
});

function forkAtCheckpoint(db: Database, sourceSessionId: string) {
  const fork = forkCampaignFromSession(db, sourceSessionId, { name: "Fork" });
  if (!fork) throw new Error("Expected fork");
  return fork;
}
