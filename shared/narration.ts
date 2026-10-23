import type { CampaignStateItem, CharacterProfile, RelationshipDocument, WorldEntrySnapshot } from "./domain";
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
  document: RelationshipDocument;
}

export interface NarrationContext {
  world: { name: string; setting_brief: string; entries: ReadonlyArray<Pick<WorldEntrySnapshot, "kind" | "name" | "description">> };
  starting_situation: string;
  protagonist: CharacterProfile;
  cast: ReadonlyArray<CharacterProfile>;
  notes: ReadonlyArray<Pick<CampaignStateItem, "category" | "subject" | "content">>;
  relationships: ReadonlyArray<RelationshipPrompt>;
  /** Handoff grounding this session; replaces the starting situation when set. */
  handoff: string | null;
  has_history: boolean;
}

/**
 * One authored character as prompt text: description first, then only the
 * labelled fields actually authored — blank fields add no scaffold text.
 */
function characterDefinition(character: CharacterProfile): string {
  return [
    character.description,
    ...CHARACTER_PROFILE_FIELDS.filter((field) => field.prompt !== "" && character[field.key].length > 0).map(
      (field) => `${field.prompt}: ${character[field.key]}`,
    ),
  ].join("; ");
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
  const cast =
    context.cast.length > 0
      ? [
          "Narrator-controlled cast:",
          ...context.cast.map((member) => `- ${member.name}: ${characterDefinition(member)}`),
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
          ...context.relationships.map(({ source_name, target_name, document }) =>
            `- ${source_name} → ${target_name}: how met: ${document.how_met}; status: ${document.status}; ` +
            `stats: ${JSON.stringify(document.stats)}; known facts: ${JSON.stringify(document.known_facts)}; ` +
            `sections: ${JSON.stringify(document.sections)}`,
          ),
        ]
      : [];
  return [
    "You are the narrator of an ongoing interactive story.",
    "",
    `World — ${world.name}: ${world.setting_brief}`,
    "",
    situation,
    "",
    `The player controls their character, ${protagonist.name}: ${characterDefinition(protagonist)}`,
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
    context.has_history
      ? "Continue the established story from the player's latest input; do not restart or retell earlier events."
      : handoff !== null
        ? "There is no prior narration in this session: continue the story from the handoff."
        : "There is no prior narration: begin the story now with an opening scene.",
  ].join("\n");
}
