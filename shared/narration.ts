import type { Character, CharacterProfile, PromptCard, StatFields, StatValues, WorldEntry } from "./domain";
import { CHARACTER_PROFILE_FIELDS } from "./domain";

/**
 * One size budget, in tokens (see shared/tokens.ts), for everything sent to
 * the narrator: the system prompt plus the chat's completed history.
 * Nothing is ever truncated — a request that would pass it is refused.
 */
export const NARRATION_TOKEN_BUDGET = 40_000;

export interface RelationshipPrompt {
  source_id: string;
  target_id: string;
  source_name: string;
  target_name: string;
  how_met: string;
  status: string;
  known_facts: ReadonlyArray<string>;
  stats: StatValues;
}

export type CharacterPrompt = CharacterProfile & { id: string; stats_enabled: boolean; stats: StatValues };

export type CastPrompt = CharacterPrompt & Pick<Character, "context_mode" | "summary">;

export interface NarrationContext {
  /** Entries exclude scenes, which are opening templates only. */
  world: { name: string; setting_brief: string; entries: ReadonlyArray<Pick<WorldEntry, "kind" | "name" | "description" | "keywords">> };
  /** Every stat definition, rendered once as a legend; values elsewhere refer to these ids. */
  stats: ReadonlyArray<StatFields & { id: string }>;
  protagonist: CharacterPrompt;
  cast: ReadonlyArray<CastPrompt>;
  /** Every relationship; only those between always-sent characters reach the system prompt. */
  relationships: ReadonlyArray<RelationshipPrompt>;
}

/** Values in legend order, e.g. "Health 7/10, Stress 2/10"; "" when none apply. */
function statValues(stats: NarrationContext["stats"], values: StatValues): string {
  return stats
    .filter((stat) => values[stat.id] !== undefined)
    .map((stat) => `${stat.label} ${values[stat.id]}/${stat.max}`)
    .join(", ");
}

/** Authored text is free-form, so markup-significant characters are escaped to keep block boundaries intact. */
function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attributeText(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeMarkup(value).replace(/"/g, "&quot;")}"`)
    .join("");
}

/** One element on a line: generated attributes plus escaped text. */
function taggedElement(tag: string, attributes: Record<string, string>, text: string): string {
  return `<${tag}${attributeText(attributes)}>${escapeMarkup(text)}</${tag}>`;
}

/** A block with one element per non-empty text; blank ones add no scaffold text. */
function taggedBlock(tag: string, attributes: Record<string, string>, elements: ReadonlyArray<readonly [string, string]>): string {
  const lines = elements.filter(([, text]) => text.length > 0).map(([name, text]) => `  ${taggedElement(name, {}, text)}`);
  return [`<${tag}${attributeText(attributes)}>`, ...lines, `</${tag}>`].join("\n");
}

function entryElement(entry: Pick<WorldEntry, "kind" | "name" | "description">): string {
  return taggedElement("entry", { kind: entry.kind, name: entry.name }, entry.description);
}

/** One authored character: an element per profile field, then stat values when the character carries stats. */
function characterBlock(character: CharacterPrompt, stats: NarrationContext["stats"]): string {
  return taggedBlock("character", { name: character.name }, [
    ...CHARACTER_PROFILE_FIELDS.filter((field) => field.tag !== "").map((field) => [field.tag, character[field.key]] as const),
    ["stats", character.stats_enabled ? statValues(stats, character.stats) : ""],
  ]);
}

function relationshipBlock(relationship: RelationshipPrompt, stats: NarrationContext["stats"]): string {
  return taggedBlock("relationship", { from: relationship.source_name, to: relationship.target_name }, [
    ["status", relationship.status],
    ["how_met", relationship.how_met],
    ["known_facts", relationship.known_facts.map((fact) => `- ${fact}`).join("\n")],
    ["stats", statValues(stats, relationship.stats)],
  ]);
}

/** The protagonist and `always` cast: the characters whose full profiles live in the system prompt. */
function alwaysSentIds(context: Pick<NarrationContext, "protagonist" | "cast">): Set<string> {
  return new Set([context.protagonist.id, ...context.cast.filter((member) => member.context_mode === "always").map((member) => member.id)]);
}

/** Every `{{name}}` a prompt card body may use; anything else is refused on save. */
export const PROMPT_PLACEHOLDERS = [
  "world_name",
  "world_brief",
  "stats",
  "protagonist_name",
  "protagonist",
  "cast",
  "offstage",
  "compendium",
  "relationships",
] as const;

export type PromptPlaceholder = (typeof PROMPT_PLACEHOLDERS)[number];

const PLACEHOLDER_PATTERN = /\{\{([\s\S]*?)\}\}/g;

function isPlaceholder(name: string): name is PromptPlaceholder {
  return (PROMPT_PLACEHOLDERS as readonly string[]).includes(name);
}

/** `{{…}}` names in `body` the renderer does not know, each once. */
export function unknownPlaceholders(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1]!).filter((name) => !isPlaceholder(name)))];
}

/**
 * The tag a card's body is wrapped in: its title in snake case — accents
 * dropped, every other run of non-alphanumerics an underscore, `_`-prefixed
 * when it would start with a digit, `card` when nothing is left.
 */
export function promptCardTag(title: string): string {
  const tag = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (tag === "") return "card";
  return /^[0-9]/.test(tag) ? `_${tag}` : tag;
}

/** The cards a fresh workspace starts with, and what Reset to defaults restores. */
export const DEFAULT_PROMPT_CARDS: ReadonlyArray<Pick<PromptCard, "title" | "body">> = [
  { title: "Narrator role", body: "You are the narrator of an ongoing interactive story." },
  { title: "World", body: "{{world_name}}: {{world_brief}}" },
  { title: "Stats legend", body: "{{stats}}\nEach <stat> gives its scale and what its ends mean." },
  {
    title: "Protagonist",
    body: "{{protagonist}}\nThe player controls {{protagonist_name}}, the character in <protagonist>. Whenever the player speaks or acts, it is {{protagonist_name}} acting.",
  },
  { title: "Cast", body: "{{cast}}\nYou control everyone in <cast>; respect these definitions as written." },
  {
    title: "Elsewhere",
    body: [
      "{{offstage}}",
      "Characters in <elsewhere> are not in the current scene. They exist and the player may mention them. Bring them in when the player calls for them or the story needs them.",
    ].join("\n"),
  },
  {
    title: "Compendium",
    body: "{{compendium}}\nRespect these definitions as written.",
  },
  {
    title: "Relationships",
    body: "{{relationships}}\nThese directional relationships are canon.",
  },
  {
    title: "Knowledge boundaries",
    body: "Each <character> block describes one character; first-person text inside it is that character's own words, never yours or the player's. In a <relationship> block, first-person text is the from character's own words about the to character. <intimacy> holds their sexual preferences and boundaries. Characters speak and act only from what they themselves know: their <knows> and <remembers>, what they witnessed in this story, and what they were told. Their <thinks> is never said aloud unless they choose to. The <compendium> is narrator background, not something every character knows.",
  },
  {
    title: "Reply context notes",
    body: "The player's latest message may end with a <reply_context> block: characters, relationships, and compendium entries that just became relevant. Treat it like the sections above, as narrator background, not as something the player said.",
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
    body: "The player's latest message may end with an out-of-character <ooc> note. Follow it for this reply only, and never answer or mention it in the narration.",
  },
];

/**
 * Narrator grounding: each enabled card's body wrapped in its title's tag
 * (`promptCardTag`), in order, placeholders filled from the world as it is
 * now, separated by blank lines. Every value is escaped text or generated
 * markup, so authored world text cannot close a card's tag. A card is left
 * out when any placeholder it uses is empty, so a section never introduces
 * nothing. Nothing here depends on the chat's progress, so the prompt only
 * changes when the world or the cards do.
 */
export function narratorSystemPrompt(
  cards: ReadonlyArray<Pick<PromptCard, "title" | "body" | "enabled">>,
  context: NarrationContext,
): string {
  const { world, protagonist } = context;
  const always = alwaysSentIds(context);
  const protagonistStatus = new Map(
    context.relationships
      .filter((relationship) => relationship.source_id === protagonist.id && relationship.status !== "")
      .map((relationship) => [relationship.target_id, relationship.status]),
  );
  const values: Record<PromptPlaceholder, string> = {
    world_name: escapeMarkup(world.name),
    world_brief: escapeMarkup(world.setting_brief),
    stats: context.stats
      .map((stat) =>
        taggedElement(
          "stat",
          { name: stat.label, applies_to: stat.applies_to, scale: `${stat.min}–${stat.max}`, low: `${stat.min}: ${stat.low_label}`, high: `${stat.max}: ${stat.high_label}` },
          stat.description,
        ),
      )
      .join("\n"),
    protagonist_name: escapeMarkup(protagonist.name),
    protagonist: characterBlock(protagonist, context.stats),
    cast: context.cast
      .filter((member) => member.context_mode === "always")
      .map((member) => characterBlock(member, context.stats))
      .join("\n"),
    offstage: context.cast
      .filter((member) => member.context_mode === "in_scene")
      .map((member) => {
        const status = protagonistStatus.get(member.id);
        const summary = member.summary === "" ? "" : `: ${member.summary}`;
        return escapeMarkup(`- ${member.name}${summary}${status === undefined ? "" : ` (${protagonist.name} → ${member.name}: ${status})`}`);
      })
      .join("\n"),
    compendium: world.entries
      .filter((entry) => entry.keywords.length === 0)
      .map(entryElement)
      .join("\n"),
    relationships: context.relationships
      .filter((relationship) => always.has(relationship.source_id) && always.has(relationship.target_id))
      .map((relationship) => relationshipBlock(relationship, context.stats))
      .join("\n"),
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
      if (missing || text === "") return [];
      const tag = promptCardTag(card.title);
      return [`<${tag}>\n${text}\n</${tag}>`];
    })
    .join("\n\n");
}

/**
 * The first user message of every narrator call: the chat's opening, or a
 * request for one, then the chapter summaries standing in for the oldest
 * messages. It changes only when a chapter does, so between chapters it
 * stays part of the cached prefix along with the system prompt.
 */
export function openingMessage(opening: string, chapters: ReadonlyArray<string> = []): string {
  const start =
    opening.trim().length > 0
      ? `<opening>\n${escapeMarkup(opening)}\n</opening>\nBegin the story with this opening scene.`
      : "Begin the story with an opening scene that fits the world.";
  if (chapters.length === 0) return start;
  return `${start}\n\n<story_so_far>\n${chapterElements(chapters)}\n</story_so_far>\nThese chapters summarize the story so far, oldest first. Continue from where they end.`;
}

function chapterElements(summaries: ReadonlyArray<string>): string {
  return summaries.map((summary, index) => taggedElement("chapter", { number: String(index + 1) }, summary)).join("\n");
}

/** Instructions for the call that writes one chapter summary. */
export const CHAPTER_SUMMARY_PROMPT = `You summarize one chapter of an interactive story so its narrator can continue the story without the original messages.

Write plain prose paragraphs in story order, in the past tense and third person. Say who did what, where, and what came of it. Keep the names, places, objects, numbers, promises, deadlines, secrets and who knows them, changes between characters, and the few lines of dialogue a later scene could call back to. Leave out atmosphere and description that nothing later depends on; aim for about a fifth of the messages' length. End with where things stand: where everyone is and what is unresolved.

Write only what the messages show. A character saying something makes it a claim, not a fact: write that they said it. Do not invent, guess at motives the messages do not show, or comment on the story. Reply with the summary only.`;

export interface ChapterSummarySource {
  world: { name: string; setting_brief: string };
  opening: string;
  /** Summaries of the chapters before this one, oldest first. */
  previous: ReadonlyArray<string>;
  messages: ReadonlyArray<{ role: "user" | "assistant"; speaker_name: string; content: string }>;
}

/** The one user message of a chapter summary call: grounding, earlier chapters as context, then the chapter's messages. */
export function chapterSummaryRequest(source: ChapterSummarySource): string {
  const parts = [taggedElement("world", { name: source.world.name }, source.world.setting_brief)];
  if (source.opening.trim().length > 0) parts.push(taggedElement("opening", {}, source.opening));
  if (source.previous.length > 0) parts.push(`<earlier_chapters>\n${chapterElements(source.previous)}\n</earlier_chapters>`);
  const messages = source.messages.map((message) =>
    taggedElement("message", { role: message.role === "user" ? "player" : "narrator", speaker: message.speaker_name }, message.content),
  );
  parts.push(`<chapter_messages>\n${messages.join("\n")}\n</chapter_messages>`);
  parts.push(
    `Summarize chapter ${source.previous.length + 1} from its messages.${source.previous.length > 0 ? " The earlier chapters are context only; do not repeat them." : ""}`,
  );
  return parts.join("\n\n");
}

/** The out-of-character note appended to the latest player input for one reply. */
export function directionNote(direction: string): string {
  return `\n\n<ooc>${escapeMarkup(direction)}</ooc>`;
}

export interface ReplyContext {
  characters: ReadonlyArray<CharacterPrompt>;
  relationships: ReadonlyArray<RelationshipPrompt>;
  entries: ReadonlyArray<Pick<WorldEntry, "kind" | "name" | "description">>;
}

/**
 * Triggered characters (full profiles and the relationships they bring) and
 * keyword entries, appended to the latest player input for one reply like a
 * direction note, so the system prompt — and any provider prefix cache —
 * stays the same from turn to turn. Empty sections are left out.
 */
export function contextNote(context: ReplyContext, stats: NarrationContext["stats"]): string {
  const sections = [
    ["characters", context.characters.map((character) => characterBlock(character, stats))],
    ["relationships", context.relationships.map((relationship) => relationshipBlock(relationship, stats))],
    ["compendium", context.entries.map(entryElement)],
  ] as const;
  const body = sections.filter(([, items]) => items.length > 0).map(([tag, items]) => [`<${tag}>`, ...items, `</${tag}>`].join("\n"));
  return `\n\n<reply_context>\n${body.join("\n")}\n</reply_context>`;
}
