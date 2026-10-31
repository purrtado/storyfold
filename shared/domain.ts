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
 * The one character profile shape. `tag` names the field's element inside the
 * narrator's `<character>` block; name is the block's attribute instead. `voice`
 * "first" fields are authored in the character's own words, which teaches
 * the narrator how they speak; "third" fields are factual.
 */
export const CHARACTER_PROFILE_FIELDS = [
  { key: "name", label: "Name", tag: "", voice: "third", required: true },
  { key: "description", label: "Description", tag: "description", voice: "third", required: true },
  { key: "appearance", label: "Appearance", tag: "appearance", voice: "third", required: false },
  { key: "personality", label: "Personality", tag: "personality", voice: "third", required: false },
  { key: "intimacy", label: "Intimacy", tag: "intimacy", voice: "third", required: false },
  { key: "knowledge", label: "Knowledge", tag: "knows", voice: "first", required: false },
  { key: "memories", label: "Memories", tag: "remembers", voice: "first", required: false },
  { key: "thoughts", label: "Inner thoughts", tag: "thinks", voice: "first", required: false },
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
 * Thinking levels for Anthropic Messages models, as providers and the adapter
 * name them. A model with no stored level is sent no thinking fields.
 */
export const REASONING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

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
  /** What this narration was sent and what the provider reported; null on player messages and replies never sent. */
  usage: MessageUsage | null;
  /** The model's summarized thinking for this narration, as streamed; never part of model history. Null when it sent none. */
  reasoning: string | null;
  /** How long the model thought before replying, in milliseconds; null when it sent no thinking or was stopped mid-thought. */
  reasoning_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface MessageLore {
  used: string[];
  dropped: string[];
}

/**
 * Token accounting for one narration call. `estimate` splits what was sent,
 * counted with shared/tokens: the system prompt, the chat history (the
 * opening message included), and the one-reply notes (reply context and OOC).
 * `provider` is what the provider reported, null when it reported nothing.
 */
export interface MessageUsage {
  estimate: { system: number; history: number; context: number };
  provider: { prompt_tokens: number; cached_tokens: number; completion_tokens: number } | null;
}

/**
 * A summary that replaces a chat's selected messages at positions
 * `start_position`..`end_position` in what the narrator is sent; the
 * transcript keeps every message. Chapters cover a contiguous run of
 * positions from the chat's start. `covered_tokens` counts the messages it
 * replaces and `summary_tokens` the summary itself.
 */
export interface Chapter {
  id: string;
  chat_id: string;
  start_position: number;
  end_position: number;
  summary: string;
  /** The summary was edited by hand since it was written. */
  edited: boolean;
  /** The model that wrote the summary. */
  model: string;
  /** What the provider reported for the summary call; null when it reported nothing. */
  usage: MessageUsage["provider"];
  covered_tokens: number;
  summary_tokens: number;
  created_at: string;
  updated_at: string;
}

/**
 * One ordered piece of a prompt preset. The active preset's enabled bodies are
 * sent in `position` order, each wrapped in a tag named after its title.
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

/** A named set of prompt cards; exactly one is active and sent to every chat. */
export interface PromptPreset {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
  updated_at: string;
}
