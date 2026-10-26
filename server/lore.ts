import type { CampaignCharacter, MessageLore, WorldEntrySnapshot } from "../shared/domain";
import { contextNote, type NarrationContext, type RelationshipPrompt, type ReplyContext } from "../shared/narration";
import { countTokens } from "../shared/tokens";

/** Newest messages a name or keyword is looked for in; a sticky one looks `sticky` messages further back. */
export const LORE_SCAN_DEPTH = 2;

/** Most tokens triggered characters and entries may add to one reply, within what the narration budget leaves. */
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

function triggered(keywords: ReadonlyArray<string>, sticky: number, recent: ReadonlyArray<string>): boolean {
  const text = recent.slice(-(LORE_SCAN_DEPTH + sticky)).join("\n");
  return keywords.some((keyword) => keywordPattern(keyword).test(text));
}

export interface LoreSelection {
  /** What the narration records; null when nothing was triggered. */
  lore: MessageLore | null;
  /** Text appended to the latest player input; "" when nothing fits. */
  note: string;
}

export interface ReplyContextSource {
  /** The campaign's cast; `always` members are already in the system prompt. */
  cast: ReadonlyArray<CampaignCharacter>;
  relationships: ReadonlyArray<RelationshipPrompt>;
  entries: ReadonlyArray<WorldEntrySnapshot>;
  stats: NarrationContext["stats"];
}

type Item =
  | { kind: "character"; character: CampaignCharacter }
  | { kind: "entry"; entry: WorldEntrySnapshot };

/**
 * What one reply gets beyond the system prompt, from the recent messages
 * (oldest first). Cast members who are not `always` join when their name or
 * an alias appears — in cast order, each with the relationships that tie it
 * to a character the narrator knows of — then keyword entries whose name or
 * a keyword appears, highest priority first and otherwise in capture order.
 * Items are added while the note fits `room` tokens, capped at the lore
 * budget; once one does not fit, it and every item after it are dropped, so
 * nothing later displaces something earlier.
 */
export function selectReplyContext(source: ReplyContextSource, recent: ReadonlyArray<string>, room: number): LoreSelection {
  const items: Item[] = [
    ...source.cast
      .filter((character) => character.context_mode !== "always" && triggered([character.name, ...character.aliases], character.sticky, recent))
      .map((character): Item => ({ kind: "character", character })),
    ...source.entries
      .filter((entry) => entry.keywords.length > 0 && triggered([entry.name, ...entry.keywords], entry.sticky, recent))
      .sort((a, b) => b.priority - a.priority)
      .map((entry): Item => ({ kind: "entry", entry })),
  ];
  if (items.length === 0) return { lore: null, note: "" };

  // Untriggered `mentioned` characters are unknown to the narrator, so no relationship may name them.
  const known = new Set(source.cast.filter((character) => character.context_mode !== "mentioned").map((character) => character.id));
  const castIds = new Set(source.cast.map((character) => character.id));

  const limit = Math.min(LORE_TOKEN_BUDGET, room);
  let context: ReplyContext = { characters: [], relationships: [], entries: [] };
  let used = 0;
  for (const item of items) {
    let next: ReplyContext;
    if (item.kind === "character") {
      const id = item.character.id;
      const joined = new Set([...known, id]);
      const ties = source.relationships.filter(
        (relationship) =>
          (relationship.source_id === id || relationship.target_id === id) &&
          !context.relationships.includes(relationship) &&
          (joined.has(relationship.source_id) || !castIds.has(relationship.source_id)) &&
          (joined.has(relationship.target_id) || !castIds.has(relationship.target_id)),
      );
      next = { ...context, characters: [...context.characters, item.character], relationships: [...context.relationships, ...ties] };
    } else {
      next = { ...context, entries: [...context.entries, item.entry] };
    }
    if (countTokens(contextNote(next, source.stats)) > limit) break;
    context = next;
    used += 1;
    if (item.kind === "character") known.add(item.character.id);
  }
  const name = (item: Item) => (item.kind === "character" ? item.character.name : item.entry.name);
  return {
    lore: { used: items.slice(0, used).map(name), dropped: items.slice(used).map(name) },
    note: used > 0 ? contextNote(context, source.stats) : "",
  };
}
