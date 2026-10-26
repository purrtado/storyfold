/**
 * Wire/domain types shared between the Bun server and the browser.
 * JSON APIs are snake_case with ISO timestamps; ids are server-generated text.
 */

export const WORLD_ENTRY_KINDS = ["location", "lore", "scene"] as const;

export type WorldEntryKind = (typeof WORLD_ENTRY_KINDS)[number];

/**
 * An entry without keywords is always in the narrator's grounding; one with
 * keywords joins a reply only when a keyword or its name appears in the
 * recent messages (see shared/narration.ts). Scenes are opening templates
 * for new chats and never reach the narrator.
 */
export interface WorldEntry {
  id: string;
  world_id: string;
  kind: WorldEntryKind;
  name: string;
  description: string;
  keywords: string[];
  /** Higher goes first when triggered entries compete for the lore budget. */
  priority: number;
  /** Extra messages a triggered entry stays active after its keyword scrolls out of the scan window. */
  sticky: number;
  created_at: string;
  updated_at: string;
}

/**
 * The one character profile shape. `prompt` labels the field in narrator
 * grounding; name and description are rendered without a label.
 */
export const CHARACTER_PROFILE_FIELDS = [
  { key: "name", label: "Name", prompt: "", required: true },
  { key: "description", label: "Description", prompt: "", required: true },
  { key: "appearance", label: "Appearance", prompt: "Appearance", required: false },
  { key: "personality", label: "Personality", prompt: "Personality", required: false },
  { key: "background", label: "Background", prompt: "Background", required: false },
  { key: "baseline_motivations", label: "Motivations", prompt: "Motivations", required: false },
  { key: "speaking_style", label: "Speaking style", prompt: "Speaking style", required: false },
  { key: "knowledge", label: "Knowledge", prompt: "Knows", required: false },
] as const;

export type CharacterProfileKey = (typeof CHARACTER_PROFILE_FIELDS)[number]["key"];

/** Name and description are non-empty; the other fields are "" when unauthored. */
export type CharacterProfile = Record<CharacterProfileKey, string>;

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

/** World stat id → current integer value. */
export type StatValues = Record<string, number>;

/**
 * How a non-protagonist reaches the narrator. `always`: full profile in the
 * system prompt. `in_scene`: the one-line summary there, the full profile
 * only for replies whose recent messages name them. `mentioned`: nothing
 * until named. The chat's protagonist is always sent in full.
 */
export const CHARACTER_CONTEXT_MODES = ["always", "in_scene", "mentioned"] as const;
export type CharacterContextMode = (typeof CHARACTER_CONTEXT_MODES)[number];

/** A world's character; chats read it live, so every edit applies from the next reply. */
export interface Character extends CharacterProfile {
  id: string;
  world_id: string;
  /** Content-addressed image id (sha256 hex), null when no picture was uploaded. */
  avatar_id: string | null;
  /** Opted in: carries every character stat of the world; otherwise `stats` is empty. */
  stats_enabled: boolean;
  stats: StatValues;
  context_mode: CharacterContextMode;
  /** One line sent every turn while an `in_scene` character is offstage; "" sends the name alone. */
  summary: string;
  /** Other names that trigger the full profile, besides `name`. */
  aliases: string[];
  /** Extra messages the full profile stays after the last mention scrolls out of the scan window. */
  sticky: number;
  created_at: string;
  updated_at: string;
}

/** The save: everything the narrator knows lives here and is read live by every chat. */
export interface World {
  id: string;
  name: string;
  setting_brief: string;
  created_at: string;
  updated_at: string;
}

/** A directed relationship between two characters of the same world; carries every relationship stat. */
export interface Relationship {
  id: string;
  world_id: string;
  source_id: string;
  target_id: string;
  how_met: string;
  status: string;
  known_facts: string[];
  stats: StatValues;
  created_at: string;
  updated_at: string;
}

/** One playthrough in a world. Never writes to the world; discard deletes it. */
export interface Chat {
  id: string;
  world_id: string;
  /** The world character the player controls in this chat. */
  protagonist_id: string;
  title: string;
  /** How the story starts; sent to the narrator only until the chat has narration. */
  opening: string;
  created_at: string;
  updated_at: string;
}

export type MessageRole = "user" | "assistant";

export type MessageStatus = "pending" | "complete" | "interrupted" | "failed";

export interface Message {
  id: string;
  chat_id: string;
  position: number;
  role: MessageRole;
  speaker_name: string;
  content: string;
  status: MessageStatus;
  /** The out-of-character note that shaped this narration; never part of model history. */
  direction: string | null;
  /**
   * Characters and keyword entries this narration was sent beyond the system
   * prompt, by name in prompt order (characters first), and those that were
   * triggered but did not fit the budget. Null when nothing was triggered.
   */
  lore: MessageLore | null;
  created_at: string;
  updated_at: string;
}

export interface MessageLore {
  used: string[];
  dropped: string[];
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
