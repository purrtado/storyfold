import { countTokens as countEncodedTokens } from "gpt-tokenizer/encoding/o200k_base";

/**
 * One tokenizer for every provider: OpenAI's o200k_base. Exact for current
 * OpenAI models, an approximation for others. Kept out of narration.ts so the
 * client loads its rank table only where a count is shown.
 * Authored text is counted as plain text: a special-token spelling such as
 * `<|endoftext|>` would otherwise make the encoder throw.
 */
const PLAIN_TEXT = { allowedSpecial: new Set<string>(), disallowedSpecial: new Set<string>() };

export const countTokens = (text: string): number => countEncodedTokens(text, PLAIN_TEXT);
