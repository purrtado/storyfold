import type { MessageLore, WorldEntrySnapshot } from "../shared/domain";
import { loreNote } from "../shared/narration";
import { countTokens } from "../shared/tokens";

/** Newest messages a keyword is looked for in; a sticky entry looks `sticky` messages further back. */
export const LORE_SCAN_DEPTH = 2;

/** Most tokens triggered entries may add to one reply, within what the narration budget leaves. */
export const LORE_TOKEN_BUDGET = 10_000;

const WORD_CHARACTER = String.raw`[\p{L}\p{N}_]`;

/** Case-insensitive whole-word match; a phrase matches across any run of whitespace. */
function keywordPattern(keyword: string): RegExp {
  const words = keyword
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<!${WORD_CHARACTER})${words.join(String.raw`\s+`)}(?!${WORD_CHARACTER})`, "iu");
}

export interface LoreSelection {
  /** What the narration records; null when no keyword entry matched. */
  lore: MessageLore | null;
  /** Text appended to the latest player input; "" when nothing fits. */
  note: string;
}

/**
 * Keyword entries whose name or a keyword appears in the recent messages
 * (oldest first), highest priority first and otherwise in capture order.
 * They are added while the note fits `room` tokens, capped at the lore
 * budget; once one does not fit, it and every entry after it are dropped,
 * so a lower priority never displaces a higher one.
 */
export function selectLore(
  entries: ReadonlyArray<WorldEntrySnapshot>,
  recent: ReadonlyArray<string>,
  room: number,
): LoreSelection {
  const triggered = entries
    .filter((entry) => {
      if (entry.keywords.length === 0) return false;
      const text = recent.slice(-(LORE_SCAN_DEPTH + entry.sticky)).join("\n");
      return [entry.name, ...entry.keywords].some((keyword) => keywordPattern(keyword).test(text));
    })
    .sort((a, b) => b.priority - a.priority);
  if (triggered.length === 0) return { lore: null, note: "" };

  const limit = Math.min(LORE_TOKEN_BUDGET, room);
  const used: WorldEntrySnapshot[] = [];
  for (const entry of triggered) {
    if (countTokens(loreNote([...used, entry])) > limit) break;
    used.push(entry);
  }
  return {
    lore: {
      used: used.map((entry) => entry.name),
      dropped: triggered.slice(used.length).map((entry) => entry.name),
    },
    note: used.length > 0 ? loreNote(used) : "",
  };
}
