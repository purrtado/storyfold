import { describe, expect, test } from "bun:test";
import type { Character, WorldEntry } from "../../shared/domain";
import { DEFAULT_PROMPT_CARDS, contextNote, narratorSystemPrompt, type RelationshipPrompt } from "../../shared/narration";
import { countTokens } from "../../shared/tokens";
import { LORE_TOKEN_BUDGET, selectReplyContext } from "../lore";

function entry(name: string, fields: Partial<WorldEntry> = {}): WorldEntry {
  return {
    id: name, world_id: "w", kind: "lore", name, description: `${name} lore.`, keywords: ["unused"], priority: 0, sticky: 0,
    created_at: "", updated_at: "", ...fields,
  };
}

function character(name: string, fields: Partial<Character> = {}): Character {
  return {
    id: name, world_id: "w", name, description: `${name}'s full card.`, appearance: "", personality: "",
    background: "", baseline_motivations: "", speaking_style: "", knowledge: "", avatar_id: null, stats_enabled: false, stats: {},
    context_mode: "in_scene", summary: "", aliases: [], sticky: 0, created_at: "", updated_at: "", ...fields,
  };
}

function tie(source: string, target: string, status: string): RelationshipPrompt {
  return { source_id: source, target_id: target, source_name: source, target_name: target, how_met: "", status, known_facts: [], stats: {} };
}

const ROOM = 40_000;

function select(
  recent: string[],
  { entries = [], cast = [], relationships = [], room = ROOM }: {
    entries?: WorldEntry[];
    cast?: Character[];
    relationships?: RelationshipPrompt[];
    room?: number;
  },
) {
  return selectReplyContext({ cast, relationships, entries, stats: [] }, recent, room);
}

describe("keyword matching", () => {
  const school = entry("Widow High", { keywords: ["school", "study hall"] });
  const used = (text: string) => select([text], { entries: [school] }).lore?.used ?? [];

  test("matches whole words in any case, beside punctuation", () => {
    expect(used("Back to SCHOOL, then.")).toEqual(["Widow High"]);
    expect(used("(school)")).toEqual(["Widow High"]);
  });

  test("never matches inside a longer word", () => {
    expect(used("The schooner docks.")).toEqual([]);
    expect(used("Preschool kids.")).toEqual([]);
  });

  test("a phrase matches across any whitespace, and the entry name triggers it too", () => {
    expect(used("She naps in study\n  hall.")).toEqual(["Widow High"]);
    expect(used("Rumours about widow high spread.")).toEqual(["Widow High"]);
  });

  test("entries without keywords are never selected; they live in the system prompt", () => {
    expect(select(["Harbor"], { entries: [entry("Harbor", { keywords: [] })] })).toEqual({ lore: null, note: "" });
  });
});

describe("scan window", () => {
  const history = ["We talk about school.", "Bell rings.", "I leave."];

  test("only the last two messages are scanned", () => {
    expect(select(history, { entries: [entry("Widow High", { keywords: ["school"] })] }).lore).toBeNull();
    expect(select([...history.slice(1), "school?"], { entries: [entry("Widow High", { keywords: ["school"] })] }).lore).not.toBeNull();
  });

  test("a sticky entry or character looks that many messages further back", () => {
    expect(select(history, { entries: [entry("Widow High", { keywords: ["school"], sticky: 1 })] }).lore?.used).toEqual(["Widow High"]);
    const talk = ["Ria waves.", "Bell rings.", "I leave."];
    expect(select(talk, { cast: [character("Ria")] }).lore).toBeNull();
    expect(select(talk, { cast: [character("Ria", { sticky: 1 })] }).lore?.used).toEqual(["Ria"]);
  });
});

describe("characters", () => {
  test("join by name, alias, or speaker tag; `always` members never do", () => {
    const cast = [character("Ria", { aliases: ["the nurse"] }), character("Bo", { context_mode: "mentioned" }), character("Al", { context_mode: "always" })];
    expect(select(['[Ria] "Late again."'], { cast }).lore?.used).toEqual(["Ria"]);
    expect(select(["I call the nurse."], { cast }).lore?.used).toEqual(["Ria"]);
    expect(select(["Bo and Al argue."], { cast }).lore?.used).toEqual(["Bo"]);
    expect(select(["Nobody here."], { cast })).toEqual({ lore: null, note: "" });
  });

  test("bring their relationships, but never one naming an unmentioned `mentioned` character", () => {
    const cast = [character("Ria"), character("Cy"), character("Dee", { context_mode: "mentioned" }), character("Al", { context_mode: "always" })];
    const relationships = [tie("Mira", "Ria", "dating"), tie("Ria", "Cy", "rivals"), tie("Ria", "Dee", "sisters"), tie("Ria", "Al", "boss"), tie("Cy", "Al", "friends")];
    expect(select(["Ria arrives."], { cast, relationships }).note).toBe(
      contextNote({ characters: [cast[0]!], relationships: [relationships[0]!, relationships[1]!, relationships[3]!], entries: [] }, []),
    );
    expect(select(["Ria and Dee arrive."], { cast, relationships }).note).toBe(
      contextNote({ characters: [cast[0]!, cast[2]!], relationships: [relationships[0]!, relationships[1]!, relationships[3]!, relationships[2]!], entries: [] }, []),
    );
  });

  test("a triggered character's note carries what it knows", () => {
    const ria = character("Ria", { knowledge: "Saw who cut the ferry rope." });
    expect(select(["Ria arrives."], { cast: [ria] }).note).toContain("- Ria: Ria's full card.; Knows: Saw who cut the ferry rope.");
  });

  test("go before keyword lore, which keeps its priority order", () => {
    const selection = select(["Ria at school."], { cast: [character("Ria")], entries: [entry("Widow High", { keywords: ["school"], priority: 9 })] });
    expect(selection.lore).toEqual({ used: ["Ria", "Widow High"], dropped: [] });
  });
});

describe("budget", () => {
  const text = ["alpha beta gamma"];

  test("higher priority goes first; equal priorities keep creation order", () => {
    const entries = [
      entry("A", { keywords: ["alpha"], priority: 1 }),
      entry("B", { keywords: ["beta"], priority: 5 }),
      entry("C", { keywords: ["gamma"], priority: 1 }),
    ];
    const selection = select(text, { entries });
    expect(selection.lore).toEqual({ used: ["B", "A", "C"], dropped: [] });
    expect(selection.note).toBe(contextNote({ characters: [], relationships: [], entries: [entries[1]!, entries[0]!, entries[2]!] }, []));
  });

  test("once an item does not fit, it and everything after it are dropped, even smaller ones", () => {
    const small = entry("Small", { keywords: ["alpha"], priority: 9 });
    const large = entry("Large", { keywords: ["beta"], priority: 5, description: "word ".repeat(200) });
    const tiny = entry("Tiny", { keywords: ["gamma"], priority: 1 });
    const room = countTokens(contextNote({ characters: [], relationships: [], entries: [small, tiny] }, []));
    expect(select(text, { entries: [small, large, tiny], room }).lore).toEqual({ used: ["Small"], dropped: ["Large", "Tiny"] });

    const big = character("Ria", { description: "word ".repeat(200) });
    const fitsLoreOnly = countTokens(contextNote({ characters: [], relationships: [], entries: [small] }, []));
    expect(select(["Ria says alpha."], { cast: [big], entries: [small], room: fitsLoreOnly }).lore).toEqual({ used: [], dropped: ["Ria", "Small"] });
  });

  test("the note never passes the room left or the cap", () => {
    const one = entry("One", { keywords: ["alpha"] });
    const exact = countTokens(contextNote({ characters: [], relationships: [], entries: [one] }, []));
    expect(select(text, { entries: [one], room: exact }).lore).toEqual({ used: ["One"], dropped: [] });
    expect(select(text, { entries: [one], room: exact - 1 })).toEqual({ lore: { used: [], dropped: ["One"] }, note: "" });
    const huge = entry("Huge", { keywords: ["alpha"], description: "word ".repeat(LORE_TOKEN_BUDGET) });
    expect(select(text, { entries: [huge] }).lore).toEqual({ used: [], dropped: ["Huge"] });
  });
});

describe("system prompt cast", () => {
  const protagonist = character("Mira", { context_mode: "always" });
  const cast = [
    character("Al", { context_mode: "always" }),
    character("Ria", { summary: "Night-shift nurse, red scrubs." }),
    character("Cy"),
    character("Dee", { context_mode: "mentioned" }),
  ];
  const prompt = narratorSystemPrompt(DEFAULT_PROMPT_CARDS.map((card) => ({ ...card, enabled: true })), {
    world: { name: "W", setting_brief: "b", entries: [] },
    opening: "s",
    stats: [],
    protagonist,
    cast,
    relationships: [tie("Mira", "Al", "brother"), tie("Mira", "Ria", "dating"), tie("Ria", "Mira", "smitten")],
    has_history: false,
  });

  test("only `always` members carry full cards; `in_scene` ones get one line; `mentioned` ones are absent", () => {
    expect(prompt).toContain("Narrator-controlled cast:\n- Al: Al's full card.\nRespect");
    expect(prompt).toContain("Elsewhere — not in the current scene:\n- Ria: Night-shift nurse, red scrubs. (Mira → Ria: dating)\n- Cy\nThey exist");
    for (const hidden of ["Ria's full card.", "Cy's full card.", "Dee"]) expect(prompt).not.toContain(hidden);
  });

  test("relationships reach it only between always-sent characters", () => {
    expect(prompt).toContain("- Mira → Al: status: brother");
    expect(prompt).not.toContain("status: dating");
    expect(prompt).not.toContain("smitten");
  });
});
