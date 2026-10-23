import { expect, test } from "bun:test";
import type { CampaignCharacter } from "../../shared/domain";
import { narrationSegments, resolveSpeaker } from "./speakerTags";

function character(id: string, name: string, role: CampaignCharacter["role"] = "cast"): CampaignCharacter {
  return {
    id,
    name,
    role,
    description: "",
    campaign_id: "c",
    avatar_id: null,
    stats_enabled: false,
    stats: {},
    created_at: "",
    updated_at: "",
  } as CampaignCharacter;
}

const cast = [
  character("p", "Sable Reyes", "protagonist"),
  character("v", "Vex Calder"),
  character("o1", "Orrin Hale"),
  character("o2", "Orrin Marsh"),
];

test("speakers resolve by full name, then by a first name only one character has", () => {
  expect(resolveSpeaker("vex calder", cast)?.id).toBe("v");
  expect(resolveSpeaker("Vex", cast)?.id).toBe("v");
  expect(resolveSpeaker("Orrin", cast)).toBeNull();
  expect(resolveSpeaker("Orrin Marsh", cast)?.id).toBe("o2");
  expect(resolveSpeaker("Vex Marsh", cast)).toBeNull();
});

test("tagged paragraphs keep their prose and group by speaker; untagged ones stay narration", () => {
  const content = [
    "Rain needles the harbor lamps.",
    '[Vex] She scoffs, swatting your knee. "You\'re late," she says, tucking one leg beneath her.',
    "[Vex Calder] She drags the laptop closer.",
    "[Dockhand] *spits* \"Tide's turning.\"",
    "[dockhand] He shrugs.",
    "The lamps gutter.",
  ].join("\n\n");
  expect(narrationSegments(content, cast)).toEqual([
    { kind: "narration", text: "Rain needles the harbor lamps." },
    {
      kind: "speaker",
      label: "Vex Calder",
      character: cast[1],
      text: 'She scoffs, swatting your knee. "You\'re late," she says, tucking one leg beneath her.\n\nShe drags the laptop closer.',
    },
    { kind: "speaker", label: "Dockhand", character: null, text: "*spits* \"Tide's turning.\"\n\nHe shrugs." },
    { kind: "narration", text: "The lamps gutter." },
  ]);
});

test("one untagged paragraph between the same speaker's paragraphs joins them; longer or mixed gaps do not", () => {
  expect(narrationSegments("[Theo] \"Everyone says it's empty.\"\n\nHe lowers his voice.\n\n[Theo] \"But some Tuesdays—\"", cast)).toEqual([
    { kind: "speaker", label: "Theo", character: null, text: "\"Everyone says it's empty.\"\n\nHe lowers his voice.\n\n\"But some Tuesdays—\"" },
  ]);
  expect(narrationSegments("[Vex] One.\n\nRain.\n\nThunder.\n\n[Vex] Two.", cast).map((segment) => segment.kind)).toEqual([
    "speaker",
    "narration",
    "speaker",
  ]);
  expect(narrationSegments("[Vex] One.\n\nRain.\n\n[Dockhand] Two.", cast).map((segment) => segment.kind)).toEqual([
    "speaker",
    "narration",
    "speaker",
  ]);
});

test("Markdown links are not tags, and a tag alone in its paragraph attributes the next one", () => {
  expect(narrationSegments("[the map](https://example.com) is torn.", cast)).toEqual([
    { kind: "narration", text: "[the map](https://example.com) is torn." },
  ]);
  expect(narrationSegments("[Vex]\n\nShe laughs.", cast)).toEqual([
    { kind: "speaker", label: "Vex Calder", character: cast[1], text: "She laughs." },
  ]);
});

test("an unfinished tag is held back only while streaming", () => {
  expect(narrationSegments("The door opens.\n\n[Ve", cast, true)).toEqual([
    { kind: "narration", text: "The door opens." },
  ]);
  expect(narrationSegments("The door opens.\n\n[Ve", cast)).toEqual([
    { kind: "narration", text: "The door opens.\n\n[Ve" },
  ]);
});
