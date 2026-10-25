/**
 * Wire/domain types shared between the Bun server and the browser.
 * JSON APIs are snake_case with ISO timestamps; ids are server-generated text.
 */

export const WORLD_ENTRY_KINDS = ["location", "lore", "scene"] as const;

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
  entries: WorldEntrySnapshot[];
}

/**
 * The one character profile shape, at every scope. `prompt` labels the field
 * in narrator grounding; name and description are rendered without a label.
 */
export const CHARACTER_PROFILE_FIELDS = [
  { key: "name", label: "Name", prompt: "", required: true },
  { key: "description", label: "Description", prompt: "", required: true },
  { key: "appearance", label: "Appearance", prompt: "Appearance", required: false },
  { key: "personality", label: "Personality", prompt: "Personality", required: false },
  { key: "background", label: "Background", prompt: "Background", required: false },
  { key: "baseline_motivations", label: "Motivations", prompt: "Motivations", required: false },
  { key: "speaking_style", label: "Speaking style", prompt: "Speaking style", required: false },
] as const;

export type CharacterProfileKey = (typeof CHARACTER_PROFILE_FIELDS)[number]["key"];

/** Name and description are non-empty; the other fields are "" when unauthored. */
export type CharacterProfile = Record<CharacterProfileKey, string>;

/**
 * A library character (`world_id` null) or a world character. Copies between
 * scopes are independent; nothing links them.
 */
export interface Character extends CharacterProfile {
  id: string;
  world_id: string | null;
  /** Content-addressed image id (sha256 hex), null when no picture was uploaded. */
  avatar_id: string | null;
  created_at: string;
  updated_at: string;
}

export const STAT_KINDS = ["character", "relationship"] as const;

export type StatKind = (typeof STAT_KINDS)[number];

/** Named palette tokens; light and dark values live in src/index.css as --stat-<token>. */
export const STAT_COLORS = ["slate", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"] as const;

export type StatColor = (typeof STAT_COLORS)[number];

/** What a stat measures and its integer scale; `applies_to` never changes after creation. */
export interface StatFields {
  applies_to: StatKind;
  label: string;
  description: string;
  low_label: string;
  high_label: string;
  min: number;
  max: number;
  default_value: number;
  color: StatColor;
}

/** A stat in the bank (`world_id` null) or defined by a world. */
export interface StatDefinition extends StatFields {
  id: string;
  world_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A campaign's own copy of a stat; edits never reach the world or the bank. */
export interface CampaignStat extends StatFields {
  id: string;
  campaign_id: string;
  created_at: string;
  updated_at: string;
}

/** Campaign stat id → current integer value. */
export type StatValues = Record<string, number>;

export type CampaignCharacterRole = "protagonist" | "cast";

/** A campaign's own copy of a character; edits never reach the library or world. */
export interface CampaignCharacter extends CharacterProfile {
  id: string;
  campaign_id: string;
  role: CampaignCharacterRole;
  avatar_id: string | null;
  /** Opted in: carries every character stat of the campaign; otherwise `stats` is empty. */
  stats_enabled: boolean;
  stats: StatValues;
  created_at: string;
  updated_at: string;
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

/** A directed relationship between two characters of the same campaign; carries every relationship stat. */
export interface Relationship {
  id: string;
  campaign_id: string;
  source_id: string;
  target_id: string;
  how_met: string;
  status: string;
  known_facts: string[];
  stats: StatValues;
  created_at: string;
  updated_at: string;
}

export interface Campaign {
  id: string;
  name: string;
  world_id: string;
  world_snapshot: WorldSnapshot;
  /** The protagonist first, then the narrator-controlled cast in creation order. */
  characters: CampaignCharacter[];
  /** Character stats, then relationship stats, each in creation order. */
  stats: CampaignStat[];
  starting_situation: string;
  active_session_id: string;
  /** True once any session of this campaign has a message; bank stat import is offered only before that. */
  story_begun: boolean;
  /** Set when this campaign was forked from a message of another campaign's session. */
  forked_from_campaign_id: string | null;
  forked_from_session_id: string | null;
  created_at: string;
  updated_at: string;
}

/** The character the player controls; every campaign has exactly one, listed first. */
export function protagonistOf(campaign: Campaign): CampaignCharacter {
  return campaign.characters[0]!;
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
  /** The out-of-character note that shaped this narration; never part of model history. */
  direction: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * One ordered piece of the global narrator prompt. Enabled bodies are sent in
 * `position` order; the title only labels the card in the editor.
 */
export interface PromptCard {
  id: string;
  title: string;
  body: string;
  enabled: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}
