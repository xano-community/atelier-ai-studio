import { describe, expect, it } from "vitest";
import { pipeline, slotShape } from "./pipeline";

describe("how a run's steps hang together, for the rail", () => {
  // The launch kit: copy; image after it; video from the image; voiceover reading the copy; music after the voiceover.
  const kit = [{ seq: 1, depends_on: [] }, { seq: 2, depends_on: [] }, { seq: 3, depends_on: [2] }, { seq: 4, depends_on: [1] }, { seq: 5, depends_on: [] }];

  it("joins a step to the next with 'uses' only when the next step uses it", () => {
    expect(pipeline(kit).joins).toEqual({ 1: "after", 2: "uses", 3: "after", 4: "after" });
  });
  it("draws a branch for a step that uses one further up, and none for the one just before", () => {
    const p = pipeline(kit);
    expect(p.branches).toEqual([{ from: 1, to: 4, lane: 0 }]);
    expect(p.lanes).toBe(1);
  });
  it("gives overlapping branches a lane each, and reuses a lane once its branch has ended", () => {
    const p = pipeline([{ seq: 1 }, { seq: 2 }, { seq: 3, depends_on: [1] }, { seq: 4, depends_on: [2] }, { seq: 5 }, { seq: 6, depends_on: [4] }]);
    expect(p.branches).toEqual([{ from: 1, to: 3, lane: 0 }, { from: 2, to: 4, lane: 1 }, { from: 4, to: 6, lane: 0 }]);
    expect(p.lanes).toBe(2);
  });
  it("ignores a dependency on a step that isn't in the run", () => {
    expect(pipeline([{ seq: 1 }, { seq: 2, depends_on: [9] }]).branches).toEqual([]);
  });
});

describe("the output slot a media step keeps", () => {
  it("takes a picture's and a clip's aspect, inside 56 by 32", () => {
    expect(slotShape("image", { aspect_ratio: "4:5" })).toEqual({ kind: "image", width: 26, height: 32 });
    expect(slotShape("image", {})).toEqual({ kind: "image", width: 32, height: 32 });
    expect(slotShape("video", { aspect_ratio: "16:9" })).toEqual({ kind: "video", width: 56, height: 32 });
    expect(slotShape("video", { aspect_ratio: "9:16" })).toEqual({ kind: "video", width: 18, height: 32 });
  });
  it("is a strip for a recording, and nothing for words", () => {
    expect(slotShape("music", {})).toEqual({ kind: "audio", width: 56, height: 32 });
    expect(slotShape("text", {})).toBeNull();
  });
});
