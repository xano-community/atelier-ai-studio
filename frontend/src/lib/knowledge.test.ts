import { describe, expect, it } from "vitest";
import { answerKept, answerLine, citedNumbers, citedSources, starterQuestions } from "./knowledge";

describe("citation marks in an answer", () => {
  it("turns a single mark into its number", () => {
    expect(citedNumbers("It rides long [1].")).toEqual([{ text: "It rides long" }, { cite: [1] }, { text: "." }]);
  });
  it("reads a list in one pair of brackets, never leaving the brackets in the text", () => {
    const parts = citedNumbers("Take the smaller size [1, 2].");
    expect(parts).toEqual([{ text: "Take the smaller size" }, { cite: [1, 2] }, { text: "." }]);
    expect(parts.some((p) => "text" in p && p.text.includes("["))).toBe(false);
  });
  it("joins marks written side by side", () => {
    expect(citedNumbers("Dealers explain it [1][2] every time.")).toEqual([{ text: "Dealers explain it" }, { cite: [1, 2] }, { text: " " }, { text: "every time." }]);
    expect(citedNumbers("Yes [1] [3].")).toEqual([{ text: "Yes" }, { cite: [1, 3] }, { text: "." }]);
    expect(citedNumbers("The medium frame [1], [2]. Then")).toEqual([{ text: "The medium frame" }, { cite: [1, 2] }, { text: ". Then" }]);
  });
  it("leaves a comma after the last mark to the sentence", () => {
    expect(citedNumbers("It rides long [1], so size down.")).toEqual([{ text: "It rides long" }, { cite: [1] }, { text: ", so size down." }]);
  });
  it("opens a range", () => {
    expect(citedNumbers("All of them [1-3].")).toEqual([{ text: "All of them" }, { cite: [1, 2, 3] }, { text: "." }]);
  });
  it("leaves a year in brackets as text", () => {
    expect(citedNumbers("The terms [2027] apply.")).toEqual([{ text: "The terms [2027] apply." }]);
  });
  it("keeps text with no marks as it is", () => {
    expect(citedNumbers("No marks here.")).toEqual([{ text: "No marks here." }]);
  });
});

describe("questions to start with", () => {
  const src = (title: string, kind: "document" | "recording" = "document") => ({ title, kind });
  it("asks something specific about the sources it knows", () => {
    const asks = starterQuestions([src("Marlow brand voice guide"), src("Customer call: Halden Cycles", "recording")]);
    expect(asks).toEqual(["Which Trail 2 frame should a rider between a medium and a large pick?", "Which words does our brand voice guide rule out?"]);
  });
  it("asks a plain question about a source it doesn't know, and never more than four", () => {
    const asks = starterQuestions([src("Pricing FAQ"), src("Sales call: Hilltop", "recording"), src("A"), src("B"), src("C")]);
    expect(asks).toHaveLength(4);
    expect(asks[0]).toBe("What does Pricing FAQ say?");
    expect(asks[1]).toBe("What came up in Sales call: Hilltop?");
  });
  it("asks nothing when nothing is ready", () => {
    expect(starterQuestions([])).toEqual([]);
  });
});

describe("a past question in the list", () => {
  it("reads its answer as one plain line, with no citation marks", () => {
    expect(answerLine("Take the medium [1].\nThe spec sheet agrees [2][3].")).toBe("Take the medium. The spec sheet agrees.");
  });
  it("names each cited source once, in the order the answer cites them", () => {
    const c = (source_id: number, title: string) => ({ source_id, title, kind: "document" as const });
    expect(citedSources([c(4, "Spec sheet"), c(2, "Halden call"), c(4, "Spec sheet")]).map((s) => s.title)).toEqual(["Spec sheet", "Halden call"]);
  });
  it("shows an answer again only when one was kept; anything else is asked again", () => {
    expect(answerKept({ state: "answered" })).toBe(true);
    expect(answerKept({ state: "not_found" })).toBe(true);
    expect(answerKept({ state: "failed" })).toBe(false);
    expect(answerKept({ state: "refused" })).toBe(false);
  });
});
