import { describe, expect, it } from "vitest";
import { fieldLabel, groupByField, readJson, splitTitle } from "./readable-json";

describe("readJson", () => {
  it("reads launch copy as its headline, its body and its points as list items", () => {
    const lines = readJson('{"headline":"Room for the rough stuff.","body":"Meet the Trail 2.","points":["Wider tyres","Lighter frame"]}')!;
    expect(splitTitle(lines)).toEqual({
      title: "Room for the rough stuff.",
      rest: [
        { field: "body", text: "Meet the Trail 2.", item: false },
        { field: "points", text: "Wider tyres", item: true },
        { field: "points", text: "Lighter frame", item: true },
      ],
    });
  });

  it("reads a reply cut off mid-string up to where it stops", () => {
    expect(readJson('{"headline":"Ride further","script":"Meet the Tra')).toEqual([
      { field: "headline", text: "Ride further", item: false },
      { field: "script", text: "Meet the Tra", item: false },
    ]);
  });

  it("keeps escaped quotes and line breaks, and skips numbers and empty strings", () => {
    expect(readJson('{"quote":"She said \\"go\\"\\nthen left","count":3,"note":""}')).toEqual([
      { field: "quote", text: 'She said "go"\nthen left', item: false },
    ]);
  });

  it("leaves plain text alone", () => {
    expect(readJson("Meet the Trail 2.")).toBeNull();
  });

  it("groups a field's list items and labels fields in words", () => {
    const groups = groupByField(readJson('{"points":["A","B"],"voiceover_script":"Go."}')!);
    expect(groups.map((g) => [fieldLabel(g.field), g.lines.length])).toEqual([["Points", 2], ["Voiceover script", 1]]);
    expect(fieldLabel("seo")).toBe("SEO");
  });
});
