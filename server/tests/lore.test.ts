import { describe, expect, test } from "bun:test";
import type { WorldEntrySnapshot } from "../../shared/domain";
import { loreNote } from "../../shared/narration";
import { countTokens } from "../../shared/tokens";
import { LORE_TOKEN_BUDGET, selectLore } from "../lore";

function entry(name: string, fields: Partial<WorldEntrySnapshot> = {}): WorldEntrySnapshot {
  return { id: name, kind: "lore", name, description: `${name} lore.`, keywords: ["unused"], priority: 0, sticky: 0, ...fields };
}

const ROOM = 40_000;

describe("keyword matching", () => {
  const school = entry("Widow High", { keywords: ["school", "study hall"] });
  const used = (text: string) => selectLore([school], [text], ROOM).lore?.used ?? [];

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
    expect(selectLore([entry("Harbor", { keywords: [] })], ["Harbor"], ROOM)).toEqual({ lore: null, note: "" });
  });
});

describe("scan window", () => {
  const history = ["We talk about school.", "Bell rings.", "I leave."];

  test("only the last two messages are scanned", () => {
    expect(selectLore([entry("Widow High", { keywords: ["school"] })], history, ROOM).lore).toBeNull();
    expect(selectLore([entry("Widow High", { keywords: ["school"] })], history.slice(1).concat("school?"), ROOM).lore).not.toBeNull();
  });

  test("a sticky entry looks that many messages further back", () => {
    expect(selectLore([entry("Widow High", { keywords: ["school"], sticky: 1 })], history, ROOM).lore?.used).toEqual(["Widow High"]);
  });
});

describe("lore budget", () => {
  const text = ["alpha beta gamma"];

  test("higher priority goes first; equal priorities keep capture order", () => {
    const entries = [
      entry("A", { keywords: ["alpha"], priority: 1 }),
      entry("B", { keywords: ["beta"], priority: 5 }),
      entry("C", { keywords: ["gamma"], priority: 1 }),
    ];
    const selection = selectLore(entries, text, ROOM);
    expect(selection.lore).toEqual({ used: ["B", "A", "C"], dropped: [] });
    expect(selection.note).toBe(loreNote([entries[1]!, entries[0]!, entries[2]!]));
  });

  test("once an entry does not fit, it and every lower one are dropped, even smaller ones", () => {
    const small = entry("Small", { keywords: ["alpha"], priority: 9 });
    const large = entry("Large", { keywords: ["beta"], priority: 5, description: "word ".repeat(200) });
    const tiny = entry("Tiny", { keywords: ["gamma"], priority: 1 });
    const room = countTokens(loreNote([small, tiny]));
    expect(selectLore([small, large, tiny], text, room).lore).toEqual({ used: ["Small"], dropped: ["Large", "Tiny"] });
  });

  test("the note never passes the room left or the lore cap", () => {
    const one = entry("One", { keywords: ["alpha"] });
    const exact = countTokens(loreNote([one]));
    expect(selectLore([one], text, exact).lore).toEqual({ used: ["One"], dropped: [] });
    expect(selectLore([one], text, exact - 1)).toEqual({ lore: { used: [], dropped: ["One"] }, note: "" });
    const huge = entry("Huge", { keywords: ["alpha"], description: "word ".repeat(LORE_TOKEN_BUDGET) });
    expect(selectLore([huge], text, ROOM).lore).toEqual({ used: [], dropped: ["Huge"] });
  });
});
