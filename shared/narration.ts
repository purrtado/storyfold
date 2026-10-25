import type { CampaignStateItem, CharacterProfile, PromptCard, StatFields, StatValues, WorldEntrySnapshot } from "./domain";
import { CHARACTER_PROFILE_FIELDS } from "./domain";

/**
 * One size budget, in characters, for everything sent to the narrator: the
 * system prompt plus the session's completed history. Characters, not tokens;
 * nothing is ever truncated — a request that would pass it is refused.
 */
export const NARRATION_CHARACTER_BUDGET = 160_000;

export interface RelationshipPrompt {
  source_name: string;
  target_name: string;
  how_met: string;
  status: string;
  known_facts: ReadonlyArray<string>;
  stats: StatValues;
}

export type CharacterPrompt = CharacterProfile & { stats_enabled: boolean; stats: StatValues };

export interface NarrationContext {
  world: { name: string; setting_brief: string; entries: ReadonlyArray<Pick<WorldEntrySnapshot, "kind" | "name" | "description">> };
  starting_situation: string;
  /** Every stat definition, rendered once as a legend; values elsewhere refer to these ids. */
  stats: ReadonlyArray<StatFields & { id: string }>;
  protagonist: CharacterPrompt;
  cast: ReadonlyArray<CharacterPrompt>;
  notes: ReadonlyArray<Pick<CampaignStateItem, "category" | "subject" | "content">>;
  relationships: ReadonlyArray<RelationshipPrompt>;
  /** Handoff grounding this session; replaces the starting situation when set. */
  handoff: string | null;
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

/** Every `{{name}}` a prompt card body may use; anything else is refused on save. */
export const PROMPT_PLACEHOLDERS = [
  "world_name",
  "world_brief",
  "situation",
  "stats",
  "protagonist_name",
  "protagonist",
  "cast",
  "compendium",
  "notes",
  "relationships",
  "continuation",
] as const;

export type PromptPlaceholder = (typeof PROMPT_PLACEHOLDERS)[number];

const PLACEHOLDER_PATTERN = /\{\{(.*?)\}\}/g;

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
  { title: "Situation", body: "{{situation}}" },
  { title: "Stats legend", body: "Stats (scale and meaning):\n{{stats}}" },
  {
    title: "Protagonist",
    body: "The player controls their character, {{protagonist_name}}: {{protagonist}}\nWhenever the player speaks or acts, it is {{protagonist_name}} acting.",
  },
  { title: "Cast", body: "Narrator-controlled cast:\n{{cast}}\nRespect these definitions as written." },
  {
    title: "Compendium",
    body: "Captured world compendium (captured at campaign creation):\n{{compendium}}\nRespect these definitions as written.",
  },
  { title: "Campaign state", body: "Current campaign state:\n{{notes}}" },
  {
    title: "Relationships",
    body: "Current directional relationships (campaign-owned; use as canon, without inventing automatic changes):\n{{relationships}}",
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
 * what the campaign owns, separated by blank lines. A card is left out when
 * any placeholder it uses is empty, so a heading never introduces nothing.
 * Shared so the New campaign page counts the exact opening prompt against
 * the budget. A session grounded by a handoff never sees the starting
 * situation; only a story without prior narration asks for an opening scene.
 */
export function narratorSystemPrompt(
  cards: ReadonlyArray<Pick<PromptCard, "body" | "enabled">>,
  context: NarrationContext,
): string {
  const { world, protagonist, handoff } = context;
  const values: Record<PromptPlaceholder, string> = {
    world_name: world.name,
    world_brief: world.setting_brief,
    situation:
      handoff !== null
        ? `Handoff from the previous session: ${handoff}`
        : `Starting situation: ${
            context.starting_situation.trim().length > 0
              ? context.starting_situation
              : "No starting situation was given; open with a scene that fits the world."
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
    cast: context.cast.map((member) => `- ${member.name}: ${characterDefinition(member, context.stats)}`).join("\n"),
    compendium: world.entries.map((entry) => `- ${entry.kind}: ${entry.name} — ${entry.description}`).join("\n"),
    notes: context.notes.map((item) => `- ${item.category} — ${item.subject}: ${item.content}`).join("\n"),
    relationships: context.relationships
      .map((relationship) => {
        const values = statValues(context.stats, relationship.stats);
        const parts = [
          ...(relationship.status ? [`status: ${relationship.status}`] : []),
          ...(relationship.how_met ? [`how met: ${relationship.how_met}`] : []),
          ...(relationship.known_facts.length > 0 ? [`known facts: ${relationship.known_facts.join("; ")}`] : []),
          ...(values ? [values] : []),
        ];
        return `- ${relationship.source_name} → ${relationship.target_name}: ${parts.join("; ")}`;
      })
      .join("\n"),
    continuation: context.has_history
      ? "Continue the established story from the player's latest input; do not restart or retell earlier events."
      : handoff !== null
        ? "There is no prior narration in this session: continue the story from the handoff."
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
