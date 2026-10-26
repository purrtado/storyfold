import type { Character, CharacterProfile, PromptCard, StatFields, StatValues, WorldEntry } from "./domain";
import { CHARACTER_PROFILE_FIELDS } from "./domain";

/**
 * One size budget, in tokens (see shared/tokens.ts), for everything sent to
 * the narrator: the system prompt plus the chat's completed history.
 * Nothing is ever truncated — a request that would pass it is refused.
 */
export const NARRATION_TOKEN_BUDGET = 40_000;

export interface RelationshipPrompt {
  source_id: string;
  target_id: string;
  source_name: string;
  target_name: string;
  how_met: string;
  status: string;
  known_facts: ReadonlyArray<string>;
  stats: StatValues;
}

export type CharacterPrompt = CharacterProfile & { id: string; stats_enabled: boolean; stats: StatValues };

export type CastPrompt = CharacterPrompt & Pick<Character, "context_mode" | "summary">;

export interface NarrationContext {
  /** Entries exclude scenes, which are opening templates only. */
  world: { name: string; setting_brief: string; entries: ReadonlyArray<Pick<WorldEntry, "kind" | "name" | "description" | "keywords">> };
  opening: string;
  /** Every stat definition, rendered once as a legend; values elsewhere refer to these ids. */
  stats: ReadonlyArray<StatFields & { id: string }>;
  protagonist: CharacterPrompt;
  cast: ReadonlyArray<CastPrompt>;
  /** Every relationship; only those between always-sent characters reach the system prompt. */
  relationships: ReadonlyArray<RelationshipPrompt>;
  has_history: boolean;
}

/** Values in legend order, e.g. "Health 7/10, Stress 2/10"; "" when none apply. */
function statValues(stats: NarrationContext["stats"], values: StatValues): string {
  return stats
    .filter((stat) => values[stat.id] !== undefined)
    .map((stat) => `${stat.label} ${values[stat.id]}/${stat.max}`)
    .join(", ");
}

/**
 * One authored character as prompt text: description first, then only the
 * labelled fields actually authored — blank fields add no scaffold text —
 * then stat values when the character carries stats.
 */
function characterDefinition(character: CharacterPrompt, stats: NarrationContext["stats"]): string {
  const definition = [
    character.description,
    ...CHARACTER_PROFILE_FIELDS.filter((field) => field.prompt !== "" && character[field.key].length > 0).map(
      (field) => `${field.prompt}: ${character[field.key]}`,
    ),
  ].join("; ");
  const values = character.stats_enabled ? statValues(stats, character.stats) : "";
  return values ? `${definition} [${values}]` : definition;
}

function relationshipLine(relationship: RelationshipPrompt, stats: NarrationContext["stats"]): string {
  const values = statValues(stats, relationship.stats);
  const parts = [
    ...(relationship.status ? [`status: ${relationship.status}`] : []),
    ...(relationship.how_met ? [`how met: ${relationship.how_met}`] : []),
    ...(relationship.known_facts.length > 0 ? [`known facts: ${relationship.known_facts.join("; ")}`] : []),
    ...(values ? [values] : []),
  ];
  return `- ${relationship.source_name} → ${relationship.target_name}: ${parts.join("; ")}`;
}

/** The protagonist and `always` cast: the characters whose full profiles live in the system prompt. */
function alwaysSentIds(context: Pick<NarrationContext, "protagonist" | "cast">): Set<string> {
  return new Set([context.protagonist.id, ...context.cast.filter((member) => member.context_mode === "always").map((member) => member.id)]);
}

/** Every `{{name}}` a prompt card body may use; anything else is refused on save. */
export const PROMPT_PLACEHOLDERS = [
  "world_name",
  "world_brief",
  "opening",
  "stats",
  "protagonist_name",
  "protagonist",
  "cast",
  "offstage",
  "compendium",
  "relationships",
  "continuation",
] as const;

export type PromptPlaceholder = (typeof PROMPT_PLACEHOLDERS)[number];

const PLACEHOLDER_PATTERN = /\{\{([\s\S]*?)\}\}/g;

function isPlaceholder(name: string): name is PromptPlaceholder {
  return (PROMPT_PLACEHOLDERS as readonly string[]).includes(name);
}

/** `{{…}}` names in `body` the renderer does not know, each once. */
export function unknownPlaceholders(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]!).filter((name) => !isPlaceholder(name)))];
}

/** The cards a fresh workspace starts with, and what Reset to defaults restores. */
export const DEFAULT_PROMPT_CARDS: ReadonlyArray<Pick<PromptCard, "title" | "body">> = [
  { title: "Narrator role", body: "You are the narrator of an ongoing interactive story." },
  { title: "World", body: "World — {{world_name}}: {{world_brief}}" },
  { title: "Opening", body: "{{opening}}" },
  { title: "Stats legend", body: "Stats (scale and meaning):\n{{stats}}" },
  {
    title: "Protagonist",
    body: "The player controls their character, {{protagonist_name}}: {{protagonist}}\nWhenever the player speaks or acts, it is {{protagonist_name}} acting.",
  },
  { title: "Cast", body: "Narrator-controlled cast:\n{{cast}}\nRespect these definitions as written." },
  {
    title: "Elsewhere",
    body: [
      "Elsewhere — not in the current scene:",
      "{{offstage}}",
      "They exist and the player may mention them. Do not bring them into a scene unless the player calls for them or the story clearly requires it; never just because they are listed.",
    ].join("\n"),
  },
  {
    title: "Compendium",
    body: "World compendium:\n{{compendium}}\nRespect these definitions as written.",
  },
  {
    title: "Relationships",
    body: "Current directional relationships (use as canon, without inventing automatic changes):\n{{relationships}}",
  },
  {
    title: "Knowledge boundaries",
    body: "Characters speak and act only from what they themselves know: their Knows notes, what they witnessed in this story, and what they were told. The compendium and world lore are narrator background, not something every character knows.",
  },
  {
    title: "Narration boundaries",
    body: "Narrate the world and every other character yourself; never narrate {{protagonist_name}}'s decisions, words, or thoughts.",
  },
  {
    title: "Speaker tags",
    body: [
      "Begin each paragraph that centres on one character other than {{protagonist_name}} — their speech, actions, or both — with that character's name in square brackets, even when the previous paragraph was theirs too, for example:",
      '[Name] She scoffs, swatting at the table. "You\'re late."',
      "Use names exactly as listed; give unnamed characters a short label and reuse it, such as [Dockhand].",
      "Start a new paragraph whenever the focus moves to another character. Leave scene description untagged, and never tag {{protagonist_name}}.",
    ].join("\n"),
  },
  {
    title: "OOC notes",
    body: "The player may end their latest message with an out-of-character note, (OOC: …). Follow it for this reply only, and never answer or mention it in the narration.",
  },
  { title: "Continuation", body: "{{continuation}}" },
];

/**
 * Narrator grounding: the enabled cards in order, placeholders filled from
 * the world as it is now, separated by blank lines. A card is left out when
 * any placeholder it uses is empty, so a heading never introduces nothing.
 * The chat's opening is sent only until the chat has narration; after that
 * the transcript carries the story.
 */
export function narratorSystemPrompt(
  cards: ReadonlyArray<Pick<PromptCard, "body" | "enabled">>,
  context: NarrationContext,
): string {
  const { world, protagonist } = context;
  const always = alwaysSentIds(context);
  const protagonistStatus = new Map(
    context.relationships
      .filter((relationship) => relationship.source_id === protagonist.id && relationship.status !== "")
      .map((relationship) => [relationship.target_id, relationship.status]),
  );
  const values: Record<PromptPlaceholder, string> = {
    world_name: world.name,
    world_brief: world.setting_brief,
    opening: context.has_history
      ? ""
      : `Opening: ${
          context.opening.trim().length > 0 ? context.opening : "No opening was given; open with a scene that fits the world."
        }`,
    stats: context.stats
      .map(
        (stat) =>
          `- ${stat.label} (${stat.applies_to}, ${stat.min}–${stat.max}): ${stat.description} ` +
          `${stat.min}: ${stat.low_label} · ${stat.max}: ${stat.high_label}`,
      )
      .join("\n"),
    protagonist_name: protagonist.name,
    protagonist: characterDefinition(protagonist, context.stats),
    cast: context.cast
      .filter((member) => member.context_mode === "always")
      .map((member) => `- ${member.name}: ${characterDefinition(member, context.stats)}`)
      .join("\n"),
    offstage: context.cast
      .filter((member) => member.context_mode === "in_scene")
      .map((member) => {
        const status = protagonistStatus.get(member.id);
        const summary = member.summary === "" ? "" : `: ${member.summary}`;
        return `- ${member.name}${summary}${status === undefined ? "" : ` (${protagonist.name} → ${member.name}: ${status})`}`;
      })
      .join("\n"),
    compendium: world.entries
      .filter((entry) => entry.keywords.length === 0)
      .map((entry) => `- ${entry.kind}: ${entry.name} — ${entry.description}`)
      .join("\n"),
    relationships: context.relationships
      .filter((relationship) => always.has(relationship.source_id) && always.has(relationship.target_id))
      .map((relationship) => relationshipLine(relationship, context.stats))
      .join("\n"),
    continuation: context.has_history
      ? "Continue the established story from the player's latest input; do not restart or retell earlier events."
      : "There is no prior narration: begin the story now with an opening scene.",
  };
  return cards
    .filter((card) => card.enabled)
    .flatMap((card) => {
      let missing = false;
      const text = card.body
        .replace(PLACEHOLDER_PATTERN, (match, name: string) => {
          if (!isPlaceholder(name)) return match;
          if (values[name] === "") missing = true;
          return values[name];
        })
        .trim();
      return missing || text === "" ? [] : [text];
    })
    .join("\n\n");
}

/** The out-of-character note appended to the latest player input for one reply. */
export function directionNote(direction: string): string {
  return `\n\n(OOC: ${direction})`;
}

export interface ReplyContext {
  characters: ReadonlyArray<CharacterPrompt>;
  relationships: ReadonlyArray<RelationshipPrompt>;
  entries: ReadonlyArray<Pick<WorldEntry, "kind" | "name" | "description">>;
}

/**
 * Triggered characters (full profiles and the relationships they bring) and
 * keyword entries, appended to the latest player input for one reply like a
 * direction note, so the system prompt — and any provider prefix cache —
 * stays the same from turn to turn. Empty sections are left out.
 */
export function contextNote(context: ReplyContext, stats: NarrationContext["stats"]): string {
  const sections = [
    ["Characters present or mentioned:", context.characters.map((character) => `- ${character.name}: ${characterDefinition(character, stats)}`)],
    ["Their relationships:", context.relationships.map((relationship) => relationshipLine(relationship, stats))],
    ["World lore:", context.entries.map((entry) => `- ${entry.kind}: ${entry.name} — ${entry.description}`)],
  ] as const;
  const body = sections.filter(([, lines]) => lines.length > 0).map(([heading, lines]) => [heading, ...lines].join("\n"));
  return `\n\n(Context for this reply, not part of the player's message:\n${body.join("\n")})`;
}
