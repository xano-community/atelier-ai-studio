import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateBounds, dateGroup, gridRows, groupCells, placesFor, repeatsTitle, saveView, savedView, tabCount, type DateCount } from "./library";

describe("date groups", () => {
  // Tuesday 17 November 2026, 10:00 local time.
  const now = new Date(2026, 10, 17, 10, 0).getTime();
  const at = (d: number, h = 12) => new Date(2026, 10, d, h, 0).getTime();
  it("puts an item in Today, Yesterday, This week or Earlier by its calendar day", () => {
    expect(dateGroup(at(17, 0), now)).toBe("Today");
    expect(dateGroup(at(16, 23), now)).toBe("Yesterday");
    expect(dateGroup(at(16, 0), now)).toBe("Yesterday");
    expect(dateGroup(at(15), now)).toBe("This week");
    expect(dateGroup(at(11, 0), now)).toBe("This week");
    expect(dateGroup(at(10, 23), now)).toBe("Earlier");
  });
});

describe("kind tab counts", () => {
  const counts = [
    { kind: "image", status: "approved", n: 4 }, { kind: "image", status: "draft", n: 2 }, { kind: "music", status: "draft", n: 1 },
    { kind: "speech", status: "approved", n: 2 }, { kind: "text", status: "draft", n: 12 }, { kind: "transcript", status: "draft", n: 2 },
  ];
  it("adds up the kinds a tab holds, in the statuses asked for", () => {
    expect(tabCount(counts, "all", ["draft", "approved"])).toBe(23);
    expect(tabCount(counts, "audio", ["draft", "approved"])).toBe(3);
    expect(tabCount(counts, "text", ["draft"])).toBe(14);
    expect(tabCount(counts, "image", ["approved"])).toBe(4);
    expect(tabCount(counts, "video", ["draft", "approved"])).toBe(0);
    expect(tabCount(undefined, "all", ["draft"])).toBe(0);
  });
});

describe("the grid's places and rows", () => {
  const now = new Date(2026, 10, 17, 10, 0).getTime();
  const day = (d: number) => new Date(2026, 10, d, 9, 0).getTime();
  const items = [
    { id: 1, kind: "video", status: "draft", created_at: day(17) },
    { id: 2, kind: "text", status: "draft", created_at: day(16) },
    { id: 3, kind: "text", status: "approved", created_at: day(16) },
    { id: 4, kind: "image", status: "approved", created_at: day(14) },
    { id: 5, kind: "text", status: "draft", created_at: day(14) },
    { id: 6, kind: "speech", status: "draft", created_at: day(14) },
    { id: 7, kind: "transcript", status: "draft", created_at: day(13) },
  ];
  const at = (i: number) => items[i];

  it("pairs text items two to a place within a day, and gives every other item a place of its own", () => {
    const groups = groupCells(items.length, items.length, at, now);
    expect(groups.map((g) => g.group)).toEqual(["Today", "Yesterday", "This week"]);
    expect(groups[1].cells).toEqual([[1, 2]]);
    // The week's second text joins its first, past the recording between them.
    expect(groups[2].cells).toEqual([[3], [4, 6], [5]]);
    expect(groups[2].drafts).toEqual([5, 6, 7]);
  });

  it("puts items not on hand yet after the last group, a place each", () => {
    expect(groupCells(10, 2, at, now).at(-1)!.cells).toEqual([[1], [2], [3], [4], [5], [6], [7], [8], [9]]);
  });

  it("flows the days on from one another, labelling each over the columns where it starts", () => {
    const rows = gridRows(groupCells(items.length, items.length, at, now), 4);
    expect(rows[0]).toEqual({ type: "head", segments: [
      { group: "Today", col: 0, span: 1, drafts: [1] },
      { group: "Yesterday", col: 1, span: 1, drafts: [2] },
      { group: "This week", col: 2, span: 2, drafts: [5, 6, 7] },
    ] });
    expect(rows[1]).toEqual({ type: "cells", cells: [{ col: 0, cell: [0] }, { col: 1, cell: [1, 2] }, { col: 2, cell: [3] }, { col: 3, cell: [4, 6] }] });
    // The week carries on in the next row, under no new label.
    expect(rows[2]).toEqual({ type: "cells", cells: [{ col: 0, cell: [5] }] });
    expect(rows).toHaveLength(3);
  });
});

describe("the grid laid out from each date group's count", () => {
  const now = new Date(2026, 10, 17, 10, 0).getTime();
  const day = (d: number) => new Date(2026, 10, d, 9, 0).getTime();
  const items = [
    { id: 1, kind: "video", status: "draft", created_at: day(17) },
    { id: 2, kind: "text", status: "draft", created_at: day(16) },
    { id: 3, kind: "text", status: "approved", created_at: day(16) },
    { id: 4, kind: "image", status: "approved", created_at: day(14) },
    { id: 5, kind: "text", status: "draft", created_at: day(14) },
    { id: 6, kind: "speech", status: "draft", created_at: day(14) },
    { id: 7, kind: "transcript", status: "draft", created_at: day(13) },
  ];
  // As the server counts them: Today one clip, Yesterday two texts, This week a picture, a recording and two texts.
  const dates: DateCount[] = [
    { group: "Today", n: 1, words: 0 }, { group: "Yesterday", n: 2, words: 2 }, { group: "This week", n: 4, words: 2 }, { group: "Earlier", n: 0, words: 0 },
  ];
  const all = (i: number) => items[i];
  const firstTwo = (i: number) => (i < 2 ? items[i] : undefined);
  const none = () => undefined;

  it("gives each group its places: one an item, words two to a place", () => {
    expect(placesFor({ n: 4, words: 2 })).toBe(3);
    expect(placesFor({ n: 3, words: 3 })).toBe(2);
    expect(placesFor({ n: 0, words: 0 })).toBe(0);
  });

  it("places the items exactly as their own dates would once they're all on hand", () => {
    expect(groupCells(7, 7, all, now, dates)).toEqual(groupCells(7, 7, all, now));
  });

  it("lays every group out before its pages arrive, with the same places it will have", () => {
    const empty = groupCells(7, 0, none, now, dates);
    expect(empty.map((g) => g.group)).toEqual(["Today", "Yesterday", "This week"]);
    expect(empty.map((g) => g.cells.length)).toEqual([1, 1, 3]);
    // Every position is held somewhere, so the page it's on is asked for when its place shows.
    expect(empty.flatMap((g) => g.cells.flat()).sort()).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const partly = groupCells(7, 2, firstTwo, now, dates);
    // Yesterday's first text is on hand; the second, still coming, waits beside it.
    expect(partly[1].cells).toEqual([[1, 2]]);
    expect(partly.map((g) => g.cells.length)).toEqual([1, 1, 3]);
    for (const columns of [2, 4, 5]) {
      const done = gridRows(groupCells(7, 7, all, now, dates), columns).map((r) => r.type);
      expect(gridRows(empty, columns).map((r) => r.type)).toEqual(done);
      expect(gridRows(partly, columns).map((r) => r.type)).toEqual(done);
    }
  });

  it("goes by the items' own dates when the counts don't match the list", () => {
    const stale = dates.map((d) => (d.group === "Today" ? { ...d, n: 3 } : d));
    expect(groupCells(7, 7, all, now, stale)).toEqual(groupCells(7, 7, all, now));
  });

  it("asks with this browser's midnights", () => {
    const b = dateBounds(now);
    expect(b.today_from).toBe(new Date(2026, 10, 17).getTime());
    expect(b.yesterday_from).toBe(new Date(2026, 10, 16).getTime());
    expect(b.week_from).toBe(new Date(2026, 10, 11).getTime());
  });
});

describe("a text card's preview", () => {
  it("leaves out a first line that says the title again", () => {
    expect(repeatsTitle("Trail 2 for the newsletter", "Trail 2 newsletter blurb")).toBe(true);
    expect(repeatsTitle("# City 3 briefing script", "City 3 briefing script")).toBe(true);
    expect(repeatsTitle("trail 2 newsletter blurb", "Trail 2 newsletter blurb")).toBe(true);
  });
  it("keeps a heading that says something new, and a first line that's a sentence", () => {
    expect(repeatsTitle("City 3: the quiet commuter", "City 3 page copy from the notes")).toBe(false);
    expect(repeatsTitle("Trail 2 for the newsletter.", "Trail 2 newsletter blurb")).toBe(false);
    expect(repeatsTitle("Hi Tom, thanks for the call", "Follow-up email to Oak & Spoke")).toBe(false);
    expect(repeatsTitle("", "Anything")).toBe(false);
  });
});

describe("the remembered view", () => {
  const kept = new Map<string, string>();
  beforeEach(() => {
    kept.clear();
    vi.stubGlobal("localStorage", { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => kept.set(k, v), removeItem: (k: string) => kept.delete(k) });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("is nobody's choice until someone picks one, then the one they picked", () => {
    expect(savedView()).toBeNull();
    saveView("list");
    expect(savedView()).toBe("list");
    saveView("grid");
    expect(savedView()).toBe("grid");
  });
  it("is nobody's choice when the browser won't keep anything", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    expect(() => saveView("list")).not.toThrow();
    expect(savedView()).toBeNull();
  });
});
