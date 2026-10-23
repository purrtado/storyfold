import type { CampaignCharacter } from "../../shared/domain";

export type NarrationSegment =
  | { kind: "narration"; text: string }
  /** `character` is null for a walk-on: a label that matches no campaign character. */
  | { kind: "speaker"; label: string; character: CampaignCharacter | null; text: string };

type SpeakerSegment = Extract<NarrationSegment, { kind: "speaker" }>;

// `[Name]` opening a paragraph; `[text](url)` and `[text][ref]` are Markdown links, not tags.
const TAG = /^\[([^[\]\n]{1,60})\](?![([])[ \t]*:?\s*/;
const PARTIAL_TAG = /^\[[^[\]\n]{0,60}$/;

function nameKey(name: string) {
  return name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** Full name, case-insensitive; else a one-word label that is exactly one character's first name. */
export function resolveSpeaker(label: string, characters: CampaignCharacter[]): CampaignCharacter | null {
  const wanted = nameKey(label);
  const exact = characters.find((character) => nameKey(character.name) === wanted);
  if (exact) return exact;
  if (wanted.includes(" ")) return null;
  const byFirstName = characters.filter((character) => nameKey(character.name).split(" ")[0] === wanted);
  return byFirstName.length === 1 ? byFirstName[0] : null;
}

/**
 * Splits narration into untagged prose and paragraphs attributed by a leading
 * `[Name]` tag. Consecutive paragraphs by the same speaker merge, absorbing a
 * single untagged paragraph between them; a tag alone in its paragraph
 * attributes the next one. While streaming, a trailing paragraph that is
 * still an unfinished tag is held back.
 */
export function narrationSegments(content: string, characters: CampaignCharacter[], streaming = false): NarrationSegment[] {
  const paragraphs = content.split(/\n[ \t]*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  if (streaming && PARTIAL_TAG.test(paragraphs.at(-1) ?? "")) paragraphs.pop();

  const segments: NarrationSegment[] = [];
  let carried: string | null = null;
  for (const paragraph of paragraphs) {
    const match = TAG.exec(paragraph);
    const tagged = match ? match[1].trim().replace(/\s+/g, " ") : "";
    const text = tagged ? paragraph.slice(match![0].length) : paragraph;
    const label: string | null = tagged || carried;
    carried = null;
    if (!text) {
      carried = label;
      continue;
    }
    const previous = segments.at(-1);
    if (!label) {
      if (previous?.kind === "narration") previous.text += `\n\n${text}`;
      else segments.push({ kind: "narration", text });
      continue;
    }
    const character = resolveSpeaker(label, characters);
    const isSameSpeaker = (segment: NarrationSegment | undefined): segment is SpeakerSegment =>
      segment?.kind === "speaker"
      && (character ? segment.character?.id === character.id : !segment.character && nameKey(segment.label) === nameKey(label));
    const beforeAside = segments.at(-2);
    if (isSameSpeaker(previous)) {
      previous.text += `\n\n${text}`;
    } else if (previous?.kind === "narration" && !previous.text.includes("\n\n") && isSameSpeaker(beforeAside)) {
      beforeAside.text += `\n\n${previous.text}\n\n${text}`;
      segments.pop();
    } else {
      segments.push({ kind: "speaker", label: character?.name ?? label, character, text });
    }
  }
  return segments;
}
