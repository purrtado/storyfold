import type { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, nowIso, openDatabase } from "../db";
import {
  beginNextSession,
  createCampaign,
  createCampaignCharacter,
  createCharacter,
  createWorld,
  forkCampaignFromMessage,
  getCampaign,
  listCampaignCharacters,
  parseCampaignInput,
  parseCharacterInput,
  updateCampaignCharacter,
} from "../library";
import {
  createRelationship,
  listRelationships,
  parseRelationshipDocument,
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
  const libraryProtagonist = createCharacter(db, parseCharacterInput({ name: "Mira", description: "A careful sailor." }));
  const libraryCast = createCharacter(db, parseCharacterInput({ name: "Oren", description: "A retired navigator." }));
  const stranger = createCharacter(db, parseCharacterInput({ name: "Other", description: "Not in this campaign." }));
  const campaign = createCampaign(db, parseCampaignInput({
    world_id: world.id,
    protagonist_id: libraryProtagonist.id,
    cast_character_ids: [libraryCast.id],
    starting_situation: "A storm approaches.",
  })).campaign;
  // Relationship endpoints are the campaign's own copies, never library ids.
  const [protagonist, cast] = campaign.characters;
  return { db, path, campaign, protagonist: protagonist!, cast: cast!, stranger };
}

const document = (how_met: string) => ({ how_met, status: "wary", stats: {}, known_facts: [], sections: [] });

function addMessage(db: Database, sessionId: string, position: number, role: "user" | "assistant", content: string): string {
  const id = newId();
  db.query(
    "INSERT INTO messages (id, session_id, position, role, speaker_name, content, status, selected, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'complete', 1, ?, ?)",
  ).run(id, sessionId, position, role, role === "user" ? "Mira" : "Narrator", content, nowIso(), nowIso());
  return id;
}

test("relationships are directional, campaign-scoped, validated, and last save wins", () => {
  const { db, path, campaign, protagonist, cast, stranger } = setup();
  const forward = createRelationship(db, campaign, protagonist.id, cast.id, parseRelationshipDocument(document("At sea.")));
  const reverse = createRelationship(db, campaign, cast.id, protagonist.id, parseRelationshipDocument(document("At port.")));
  expect(forward.source_id).toBe(protagonist.id);
  expect(reverse.source_id).toBe(cast.id);
  expect(() => createRelationship(db, campaign, protagonist.id, cast.id, parseRelationshipDocument(document("Again.")))).toThrow();
  expect(() => createRelationship(db, campaign, protagonist.id, "foreign-subject", parseRelationshipDocument(document("No.")))).toThrow();
  expect(() => createRelationship(db, campaign, protagonist.id, stranger.id, parseRelationshipDocument(document("No.")))).toThrow();
  expect(() => parseRelationshipDocument({ ...document(""), hidden: "not allowed" })).toThrow();
  expect(() => parseRelationshipDocument({ ...document(""), stats: { mood: { value: Number.POSITIVE_INFINITY, min: 0, max: 1 } } })).toThrow();
  expect(() => parseRelationshipDocument({ ...document(""), stats: { mood: { value: 2, min: 0, max: 1 } } })).toThrow();
  expect(() => parseRelationshipDocument({ ...document(""), sections: [
    { id: "secret", label: "One", type: "text", value: "A" },
    { id: "secret", label: "Two", type: "text", value: "B" },
  ] })).toThrow();
  updateRelationship(db, campaign, forward.id, parseRelationshipDocument(document("First save.")));
  updateRelationship(db, campaign, forward.id, parseRelationshipDocument(document("Second save.")));
  db.close();
  const reopened = openDatabase(path);
  const stored = listRelationships(reopened, campaign.id);
  expect(stored.map((item) => item.id)).toEqual([forward.id, reverse.id]);
  expect(stored[0]!.document.how_met).toBe("Second save.");
  reopened.close();
});

test("a closed-session fork restores that session's checkpoint, not later edits", () => {
  const { db, campaign } = setup();
  const companion = createCampaignCharacter(db, campaign.id, parseCharacterInput({
    name: "Ilyra",
    description: "A lighthouse keeper.",
  }))!;
  const withCompanion = getCampaign(db, campaign.id)!;
  const relationship = createRelationship(db, withCompanion, withCompanion.characters[0]!.id, companion.id, parseRelationshipDocument({
    ...document("Met during the eclipse."),
    known_facts: ["She keeps a brass compass."],
  }));

  const closedId = campaign.active_session_id;
  const cutId = addMessage(db, closedId, 1, "assistant", "The eclipse ends.");
  beginNextSession(db, campaign.id, { title: "After the storm", handoff: "The crew reached the lighthouse." });
  const afterBoundary = getCampaign(db, campaign.id)!;
  updateRelationship(db, afterBoundary, relationship.id, parseRelationshipDocument(document("After checkpoint.")));
  updateCampaignCharacter(db, campaign.id, companion.id, { name: "Renamed after the close" });
  createCampaignCharacter(db, campaign.id, parseCharacterInput({
    name: "Later arrival",
    description: "Joined after the checkpoint.",
  }));

  const fork = forkCampaignFromMessage(db, closedId, cutId, { name: "Fork" })!;
  const forkCharacters = listCampaignCharacters(db, fork.campaign.id);
  expect(forkCharacters.map((character) => character.name)).toEqual(["Mira", "Oren", "Ilyra"]);
  const forkRelationship = listRelationships(db, fork.campaign.id)[0]!;
  expect(forkRelationship.id).not.toBe(relationship.id);
  expect(forkRelationship.document.how_met).toBe("Met during the eclipse.");
  expect(forkRelationship.target_id).not.toBe(companion.id);
  const restored = forkCharacters.find((character) => character.id === forkRelationship.target_id)!;
  expect(restored.name).toBe("Ilyra");
  db.close();
});

test("an open-session fork copies current relationships and stays independent", () => {
  const { db, campaign } = setup();
  const companion = createCampaignCharacter(db, campaign.id, parseCharacterInput({
    name: "Ilyra",
    description: "A lighthouse keeper.",
  }))!;
  const withCompanion = getCampaign(db, campaign.id)!;
  const relationship = createRelationship(db, withCompanion, withCompanion.characters[0]!.id, companion.id, parseRelationshipDocument(document("Met during the eclipse.")));
  const sessionId = campaign.active_session_id;
  addMessage(db, sessionId, 1, "user", "I approach the lighthouse.");
  const cutId = addMessage(db, sessionId, 2, "assistant", "Tamsin waves from the gallery.");

  const forked = forkCampaignFromMessage(db, sessionId, cutId, { name: "Fork" })!;
  expect(forked.campaign.forked_from_campaign_id).toBe(campaign.id);
  expect(forked.campaign.forked_from_session_id).toBe(sessionId);
  const forkRelationship = listRelationships(db, forked.campaign.id)[0]!;
  expect(forkRelationship.id).not.toBe(relationship.id);
  expect(forkRelationship.target_id).not.toBe(companion.id);

  updateRelationship(db, forked.campaign, forkRelationship.id, parseRelationshipDocument(document("Changed in the fork.")));
  updateRelationship(db, campaign, relationship.id, parseRelationshipDocument(document("Changed in the origin.")));
  expect(listRelationships(db, forked.campaign.id)[0]!.document.how_met).toBe("Changed in the fork.");
  expect(listRelationships(db, campaign.id)[0]!.document.how_met).toBe("Changed in the origin.");
  db.close();
});
