import { describe, expect, it } from "vitest";
import {
  countWords, dailySeries, dollars, markedDays, monthBefore, easelLine, parseDollars, peopleLines, raiseTo, share, shortModelName, unitWords, weekOfSpend, type Usage,
} from "./usage";

const $ = 1_000_000;

describe("money in words", () => {
  it("drops the cents from whole dollars and keeps two places otherwise", () => {
    expect(dollars(100 * $)).toBe("$100");
    expect(dollars(38_400_000)).toBe("$38.40");
    expect(dollars($ / 2)).toBe("$0.50");
    expect(dollars(1_250 * $)).toBe("$1,250");
    expect(dollars(3_300)).toBe("$0.0033");
    expect(dollars(4)).toBe("under $0.0001");
    expect(dollars(0)).toBe("$0");
  });
  it("reads what someone typed as dollars, and refuses what isn't an amount", () => {
    expect(parseDollars("25")).toBe(25 * $);
    expect(parseDollars("$0.50")).toBe(500_000);
    expect(parseDollars(" 1,000 ")).toBe(1_000 * $);
    expect(parseDollars("0.0000015")).toBeNull();
    expect(parseDollars("-3")).toBeNull();
    expect(parseDollars("ten")).toBeNull();
    expect(parseDollars("")).toBeNull();
  });
  it("fills a meter by the share used, never past full", () => {
    expect(share(38_400_000, 100 * $)).toBeCloseTo(38.4);
    expect(share(30 * $, 25 * $)).toBe(100);
    expect(share(1, 0)).toBe(100);
    expect(share(0, 0)).toBe(0);
  });
});

describe("raising a budget for a refused run", () => {
  it("rounds what's spent, held and asked for up to the next $5", () => {
    // $24.60 spent, $0.20 held, a $1.05 run: $25.85 needed, so $30.
    expect(raiseTo({ budget: 25 * $, spent: 24_600_000, reserved: 200_000 }, 1_050_000)).toBe(30 * $);
    // Their budget already covers it, so it was the team's budget that refused: nothing to raise.
    expect(raiseTo({ budget: 25 * $, spent: 24 * $, reserved: 0 }, 1 * $)).toBeNull();
    expect(raiseTo({ budget: 50_000, spent: 66_000, reserved: 0 }, 3_300)).toBe(5 * $);
  });
});

describe("months", () => {
  it("goes back a month across a year", () => {
    expect(monthBefore("2026-11")).toBe("2026-10");
    expect(monthBefore("2026-01")).toBe("2025-12");
  });
  it("puts each day's spend in its own bar, with empty days at zero", () => {
    const s = dailySeries("2026-02", [{ day: 1, amount: 5 }, { day: 28, amount: 7 }, { day: 3, amount: 2 }]);
    expect(s).toHaveLength(28);
    expect(s[0]).toBe(5);
    expect(s[1]).toBe(0);
    expect(s[2]).toBe(2);
    expect(s[27]).toBe(7);
  });
});

describe("words for counts and prices", () => {
  it("names each kind's unit", () => {
    expect(countWords("video", 31)).toBe("31 clips");
    expect(countWords("image", 1)).toBe("1 image");
    expect(countWords("text", 1920)).toBe("1,920 calls");
  });
  it("says what a price is per", () => {
    expect(unitWords({ unit: "input_token", variant: "" })).toBe("per 1M input tokens");
    expect(unitWords({ unit: "second", variant: "720p/silent" })).toBe("per second (720p, no sound)");
    expect(unitWords({ unit: "image", variant: "1K" })).toBe("per image (1K)");
  });
});

describe("usage by person", () => {
  const usage = {
    month: "2026-11", this_month: "2026-11", team: null, total: 0, held: 0,
    by_person: [
      { owner_id: 2, via: "ui", connection_id: 0, amount: 12 * $, calls: 10 },
      { owner_id: 2, via: "api", connection_id: 7, amount: 9_800_000, calls: 4 },
      { owner_id: 3, via: "ui", connection_id: 0, amount: 5_500_000, calls: 3 },
      { owner_id: 2, via: "easel", connection_id: 0, amount: 100_000, calls: 1 },
    ],
    by_kind: [], by_model: [], by_day: [],
    rows: [{ subject_id: 2, budget: 25 * $, reserved: 0, spent: 21_900_000 }],
    people: [{ id: 1, name: "Jordan Lee", role: "admin" }, { id: 2, name: "Sam Rivera", role: "member" }, { id: 3, name: "Priya Nair", role: "member" }],
    keys: [{ id: 7, name: "Shopify sync" }],
    team_budget: 100 * $, person_budget: 25 * $, approval_line: $ / 2,
  } as unknown as Usage;

  it("puts keys and agents under their owner, adds them to the owner's total, and sorts by spend", () => {
    const lines = peopleLines(usage, false);
    expect(lines.map((l) => l.name)).toEqual(["Sam Rivera", "Priya Nair"]);
    expect(lines[0].amount).toBe(21_900_000);
    expect(lines[0].details.map((d) => d.label)).toEqual(['key "Shopify sync"', "through Easel"]);
    // Priya has no month row: she reads the default budget.
    expect(lines[1].budget).toBe(25 * $);
    expect(lines[1].hasRow).toBe(false);
  });
  it("lists everyone on this month's view, so anyone can be given a budget", () => {
    expect(peopleLines(usage, true).map((l) => l.name)).toEqual(["Sam Rivera", "Priya Nair", "Jordan Lee"]);
  });
});

describe("Easel's own turns on Usage", () => {
  const people = [{ id: 1, name: "Jordan Lee", role: "admin" }, { id: 2, name: "Sam Rivera", role: "member" }];
  it("names who bills them and adds up the tokens and turns, busiest person first", () => {
    const line = easelLine({ people, easel: [
      { user_id: 1, provider: "anthropic", model: "claude-opus-5-5", turns: 2, input_tokens: 13_440, output_tokens: 710 },
      { user_id: 2, provider: "anthropic", model: "claude-opus-5-5", turns: 3, input_tokens: 5_840, output_tokens: 412 },
    ] } as unknown as Usage)!;
    expect(line.billedBy).toBe("Anthropic");
    expect([line.turns, line.input, line.output]).toEqual([5, 19_280, 1_122]);
    expect(line.words).toBe("19k tokens in, 1.1k out · 5 turns");
    expect(line.people).toEqual([{ name: "Sam Rivera", turns: 3 }, { name: "Jordan Lee", turns: 2 }]);
  });
  it("says both providers when the month used both, and nothing when Easel wasn't used", () => {
    const both = easelLine({ people, easel: [
      { user_id: 1, provider: "google-genai", model: "gemini-3.8-flash", turns: 1, input_tokens: 900, output_tokens: 80 },
      { user_id: 1, provider: "anthropic", model: "claude-opus-5-5", turns: 1, input_tokens: 800, output_tokens: 60 },
    ] } as unknown as Usage)!;
    expect(both.billedBy).toBe("Google/Anthropic");
    expect(both.words).toBe("1.7k tokens in, 140 out · 2 turns");
    expect(easelLine({ people, easel: [] } as unknown as Usage)).toBeNull();
  });
});

describe("Home's week of spend", () => {
  const DAY = 86_400_000;
  const now = 20_000 * DAY + 15 * 3_600_000;
  it("puts each charged day in its place, oldest first and ending today, with quiet days at 0", () => {
    expect(weekOfSpend([{ day: 20_000, amount: 7 * $ }, { day: 19_996, amount: 2 * $ }], now)).toEqual([0, 0, 2 * $, 0, 0, 0, 7 * $]);
  });
  it("leaves out days older than a week", () => {
    expect(weekOfSpend([{ day: 19_993, amount: $ }, { day: 19_994, amount: 3 * $ }], now)).toEqual([3 * $, 0, 0, 0, 0, 0, 0]);
  });
});

describe("the month's chart", () => {
  it("marks today and the busiest day", () => {
    expect(markedDays([0, 5, 9, 2], 3)).toEqual({ today: 3, busiest: 2 });
  });
  it("marks no today in another month, and no busiest day in a month with nothing spent", () => {
    expect(markedDays([0, 0, 0], -1)).toEqual({ today: -1, busiest: -1 });
  });
});

describe("model names in a row", () => {
  it("drops the bracketed family from a long name", () => {
    expect(shortModelName("Nano Banana 2 (Gemini 3.1 Flash Image)")).toBe("Nano Banana 2");
    expect(shortModelName("Veo 3.1 Fast")).toBe("Veo 3.1 Fast");
  });
});
