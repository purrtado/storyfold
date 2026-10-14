/**
 * Combined authored grounding limit shared by the server (enforcement) and the
 * UI (live count). Characters, not tokens: this bounds authored input size and
 * is not a model context-window guarantee.
 */
export const GROUNDING_CHARACTER_LIMIT = 32_000;

/** Authored character field values plus the world context captured with it. */
export interface GroundingCharacterInput {
  name: string;
  description: string;
  appearance: string;
  personality: string;
  background: string;
  baseline_motivations: string;
  speaking_style: string;
  world_context: string;
}

export interface GroundingCountInput {
  world_name: string;
  world_setting_brief: string;
  starting_situation: string;
  /** The played character; counted exactly once, never again via cast. */
  protagonist: GroundingCharacterInput;
  /** Narrator-controlled cast members; excludes the protagonist. */
  cast: ReadonlyArray<GroundingCharacterInput>;
  entries: ReadonlyArray<{ name: string; description: string }>;
}

/**
 * The one counting rule: world name/brief, the starting situation, every
 * authored field of the protagonist and of each cast member (each character
 * exactly once), and each selected entry's name/description, summed as plain
 * string lengths. Unauthored fields are "" and add zero. No separators, no
 * truncation.
 */
export function groundingCharacterCount(input: GroundingCountInput): number {
  let total = input.world_name.length + input.world_setting_brief.length;
  total += input.starting_situation.length;
  const characters = [input.protagonist, ...input.cast];
  for (const character of characters) {
    total += character.name.length + character.description.length;
    total += character.appearance.length;
    total += character.personality.length;
    total += character.background.length;
    total += character.baseline_motivations.length;
    total += character.speaking_style.length;
    total += character.world_context.length;
  }
  for (const entry of input.entries) {
    total += entry.name.length + entry.description.length;
  }
  return total;
}
