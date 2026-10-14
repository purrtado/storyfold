/**
 * Combined authored grounding limit shared by the server (enforcement) and the
 * UI (live count). Characters, not tokens: this bounds authored input size and
 * is not a model context-window guarantee.
 */
export const GROUNDING_CHARACTER_LIMIT = 32_000;

export interface GroundingCountInput {
  world_name: string;
  world_setting_brief: string;
  persona_name: string;
  persona_description: string;
  starting_situation: string;
  entries: ReadonlyArray<{ name: string; description: string }>;
}

/**
 * The one counting rule: world name/brief, persona name/description, the
 * starting situation, and each selected entry's name/description, summed as
 * plain string lengths. No separators, no truncation.
 */
export function groundingCharacterCount(input: GroundingCountInput): number {
  let total = input.world_name.length + input.world_setting_brief.length;
  total += input.persona_name.length + input.persona_description.length;
  total += input.starting_situation.length;
  for (const entry of input.entries) {
    total += entry.name.length + entry.description.length;
  }
  return total;
}
