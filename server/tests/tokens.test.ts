import { describe, expect, test } from "bun:test";
import { countTokens } from "../../shared/tokens";

describe("countTokens", () => {
  test("counts a special-token spelling in authored text as plain text instead of throwing", () => {
    expect(countTokens("<|endoftext|>")).toBeGreaterThan(1);
    expect(countTokens("hi <|endoftext|> there")).toBeGreaterThan(countTokens("hi  there"));
  });
});
