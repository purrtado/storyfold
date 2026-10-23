/**
 * Wire/domain types shared between the Bun server and the browser.
 * JSON APIs are snake_case with ISO timestamps; ids are server-generated text.
 */

export const WORLD_ENTRY_KINDS = ["local_npc", "location", "lore", "scene"] as const;

export type WorldEntryKind = (typeof WORLD_ENTRY_KINDS)[number];

export interface WorldEntry {
  id: string;
  world_id: string;
  kind: WorldEntryKind;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

/** A compendium entry captured into a campaign at creation; never re-resolved. */
export interface WorldEntrySnapshot {
  id: string;
  kind: WorldEntryKind;
  name: string;
  description: string;
}

export interface WorldSnapshot {
  name: string;
  setting_brief: string;
  suggested_starting_situation: string;
  entries: WorldEntrySnapshot[];
}

/**
 * A global character. name/description are required; the remaining authored
 * fields are optional but always present, empty when unauthored.
 */
export interface Character {
  id: string;
  name: string;
  description: string;
  appearance: string;
  personality: string;
  background: string;
  baseline_motivations: string;
  speaking_style: string;
  /** Content-addressed image id (sha256 hex), null when no picture was uploaded. */
  avatar_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * A global character definition captured at campaign creation, together with
 * the world-specific context of the world it was cast from ("" outside any
 * world cast). `id` is the captured global character id; later library edits
 * never rewrite a campaign snapshot.
 */
export interface CharacterSnapshot {
  id: string;
  name: string;
  description: string;
  appearance: string;
  personality: string;
  background: string;
  baseline_motivations: string;
  speaking_style: string;
  world_context: string;
  /** Captured image id at campaign creation; never re-resolved against the library. */
  avatar_id: string | null;
}

/** Association of a global character with a world plus freeform world-specific context. */
export interface WorldCharacter {
  world_id: string;
  character_id: string;
  context: string;
  created_at: string;
  updated_at: string;
  character: Character;
}

export interface World {
  id: string;
  name: string;
  setting_brief: string;
  suggested_starting_situation: string;
  created_at: string;
  updated_at: string;
}

export const CAMPAIGN_STATE_CATEGORIES = ["goal", "knowledge", "internal", "journal"] as const;

export type CampaignStateCategory = (typeof CAMPAIGN_STATE_CATEGORIES)[number];

/**
 * Campaign-owned manual note. `subject` is free text and never links to a
 * character or entry. Journal entries are read chronologically by created_at,
 * which never changes after creation.
 */
export interface CampaignStateItem {
  id: string;
  campaign_id: string;
  category: CampaignStateCategory;
  subject: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface RelationshipDocument {
  how_met: string;
  status: string;
  stats: Record<string, { value: number; min: number; max: number }>;
  known_facts: string[];
  sections: { id: string; label: string; type: "text" | "list"; value: string | string[] }[];
}

export interface RelationshipSubject {
  id: string;
  name: string;
  kind: "character" | "entry" | "local_character";
}

export interface Relationship {
  id: string;
  campaign_id: string;
  source_id: string;
  target_id: string;
  document: RelationshipDocument;
  created_at: string;
  updated_at: string;
}

export interface Campaign {
  id: string;
  name: string;
  world_id: string;
  protagonist_id: string;
  world_snapshot: WorldSnapshot;
  protagonist_snapshot: CharacterSnapshot;
  /** Narrator-controlled cast; excludes the protagonist, who grounds once. */
  cast: CharacterSnapshot[];
  starting_situation: string;
  active_session_id: string;
  /** Set when this campaign was forked from a message of another campaign's session. */
  forked_from_campaign_id: string | null;
  forked_from_session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  campaign_id: string;
  title: string;
  /**
   * The reviewable handoff written when this session was closed, or the
   * inherited handoff grounding a forked campaign's opening session; null
   * while a sequentially created session is still open.
   */
  handoff: string | null;
  /** Set when the session was closed by beginning the next one; read-only after. */
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type MessageRole = "user" | "assistant";

export type MessageStatus = "pending" | "complete" | "interrupted" | "failed";

export interface Message {
  id: string;
  session_id: string;
  position: number;
  role: MessageRole;
  speaker_name: string;
  content: string;
  status: MessageStatus;
  created_at: string;
  updated_at: string;
}
