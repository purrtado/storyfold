/**
 * One tokenizer for every provider: OpenAI's o200k_base. Exact for current
 * OpenAI models, an approximation for others. Kept out of narration.ts so the
 * client loads its rank table only where a count is shown.
 */
export { countTokens } from "gpt-tokenizer/encoding/o200k_base";
