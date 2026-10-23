import type { CampaignStateItem, CharacterProfile, StatFields, StatValues, WorldEntrySnapshot } from "./domain";
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

/**
 * Narrator grounding, built only from what the campaign owns. Shared so the
 * New campaign page counts the exact opening prompt against the budget.
 * A session grounded by a handoff never sees the starting situation. Only a
 * story without prior narration asks the model to start a scene.
 */
export function narratorSystemPrompt(context: NarrationContext): string {
  const { world, protagonist, handoff } = context;
  const situation =
    handoff !== null
      ? `Handoff from the previous session: ${handoff}`
      : `Starting situation: ${
          context.starting_situation.trim().length > 0
            ? context.starting_situation
            : "No starting situation was given; open with a scene that fits the world."
        }`;
  const legend =
    context.stats.length > 0
      ? [
          "Stats (scale and meaning):",
          ...context.stats.map((stat) =>
            `- ${stat.label} (${stat.applies_to}, ${stat.min}–${stat.max}): ${stat.description} ` +
            `${stat.min}: ${stat.low_label} · ${stat.max}: ${stat.high_label}`,
          ),
        ]
      : [];
  const cast =
    context.cast.length > 0
      ? [
          "Narrator-controlled cast:",
          ...context.cast.map((member) => `- ${member.name}: ${characterDefinition(member, context.stats)}`),
          "Respect these definitions as written.",
        ]
      : [];
  const compendium =
    world.entries.length > 0
      ? [
          "Captured world compendium (captured at campaign creation):",
          ...world.entries.map((entry) => `- ${entry.kind}: ${entry.name} — ${entry.description}`),
          "Respect these definitions as written.",
        ]
      : [];
  const notes =
    context.notes.length > 0
      ? [
          "Current campaign state:",
          ...context.notes.map((item) => `- ${item.category} — ${item.subject}: ${item.content}`),
        ]
      : [];
  const relationships =
    context.relationships.length > 0
      ? [
          "Current directional relationships (campaign-owned; use as canon, without inventing automatic changes):",
          ...context.relationships.map((relationship) => {
            const values = statValues(context.stats, relationship.stats);
            const parts = [
              ...(relationship.status ? [`status: ${relationship.status}`] : []),
              ...(relationship.how_met ? [`how met: ${relationship.how_met}`] : []),
              ...(relationship.known_facts.length > 0 ? [`known facts: ${relationship.known_facts.join("; ")}`] : []),
              ...(values ? [values] : []),
            ];
            return `- ${relationship.source_name} → ${relationship.target_name}: ${parts.join("; ")}`;
          }),
        ]
      : [];
  return [
    "You are the narrator of an ongoing interactive story.",
    "",
    `World — ${world.name}: ${world.setting_brief}`,
    "",
    situation,
    "",
    ...legend,
    "",
    `The player controls their character, ${protagonist.name}: ${characterDefinition(protagonist, context.stats)}`,
    `Whenever the player speaks or acts, it is ${protagonist.name} acting.`,
    "",
    ...cast,
    "",
    ...compendium,
    "",
    ...notes,
    "",
    ...relationships,
    "",
    "Narrate the world and every other character yourself; never narrate",
    `${protagonist.name}'s decisions, words, or thoughts.`,
    "",
    `Begin each paragraph that centres on one character other than ${protagonist.name} — their speech, actions, or both — with that character's name in square brackets, even when the previous paragraph was theirs too, for example:`,
    '[Name] She scoffs, swatting at the table. "You\'re late."',
    "Use names exactly as listed; give unnamed characters a short label and reuse it, such as [Dockhand].",
    `Start a new paragraph whenever the focus moves to another character. Leave scene description untagged, and never tag ${protagonist.name}.`,
    "",
    context.has_history
      ? "Continue the established story from the player's latest input; do not restart or retell earlier events."
      : handoff !== null
        ? "There is no prior narration in this session: continue the story from the handoff."
        : "There is no prior narration: begin the story now with an opening scene.",
  ].join("\n");
}
