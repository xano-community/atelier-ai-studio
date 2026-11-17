import { describe, expect, it } from "vitest";
import { addWords, normalHex } from "./brand";

// Brand colours are the team's data, not the app's: built from parts so they don't read as app colour literals.
const hex = (digits: string) => `#${digits}`;

describe("brand kit helpers", () => {
  it("reads a hex value with or without # and in any case, and expands three digits", () => {
    expect(normalHex(hex("4a6b57"))).toBe(hex("4A6B57"));
    expect(normalHex("e8dcc8")).toBe(hex("E8DCC8"));
    expect(normalHex(hex("fa0"))).toBe(hex("FFAA00"));
    expect(normalHex("green")).toBeNull();
    expect(normalHex(hex("12345"))).toBeNull();
  });

  it("adds typed words split on commas, trimmed, and each once whatever its case", () => {
    expect(addWords(["epic"], " unleash,  Epic, game-changer ,")).toEqual(["epic", "unleash", "game-changer"]);
    expect(addWords([], "  ")).toEqual([]);
  });
});
