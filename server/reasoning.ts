import { REASONING_LEVELS, type ReasoningLevel } from "../shared/domain";
// The adapter's per-model thinking table is not in its package exports.
import { ANTHROPIC_MODEL_REASONING } from "../node_modules/@tanstack/ai-anthropic/dist/esm/model-meta.js";

/** The levels Storyfold can store, in order; "none"/"off" and unknown names drop out. */
export function knownLevels(levels: Iterable<unknown>): ReasoningLevel[] {
  const named = new Set(levels);
  return REASONING_LEVELS.filter((level) => named.has(level));
}

/** Whether the Anthropic adapter maps `chat({ reasoning })` to thinking fields for this model. */
export function adapterThinks(model: string): boolean {
  return Object.hasOwn(ANTHROPIC_MODEL_REASONING, model) && ANTHROPIC_MODEL_REASONING[model] !== false;
}

/** A model's levels: the provider's own listing when it gave one, else the adapter's table, else none. */
export function reasoningLevels(model: string, listed: ReasoningLevel[] | undefined): ReasoningLevel[] {
  if (listed !== undefined) return listed;
  const reasoning = adapterThinks(model) && ANTHROPIC_MODEL_REASONING[model];
  return reasoning ? knownLevels(Object.keys(reasoning.levels)) : [];
}
