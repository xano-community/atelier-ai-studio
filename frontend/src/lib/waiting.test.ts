import { describe, expect, it } from "vitest";
import { ageWords, requestWords, sharedNote } from "./waiting";

const NOW = Date.UTC(2026, 10, 17, 9, 0);
const ago = (ms: number) => NOW - ms;

describe("ageWords", () => {
  it("says how long, without 'ago'", () => {
    expect(ageWords(ago(20_000), NOW)).toBe("just now");
    expect(ageWords(ago(40 * 60_000), NOW)).toBe("40 min");
    expect(ageWords(ago(60 * 60_000), NOW)).toBe("1 hour");
    expect(ageWords(ago(10 * 3_600_000), NOW)).toBe("10 hours");
    expect(ageWords(ago(26 * 3_600_000), NOW)).toBe("1 day");
    expect(ageWords(ago(5 * 86_400_000 + 3_600_000), NOW)).toBe("5 days");
    expect(ageWords(ago(23 * 86_400_000), NOW)).toBe("3 weeks");
  });
  it("never goes negative for a clock that's a little ahead", () => {
    expect(ageWords(NOW + 5_000, NOW)).toBe("just now");
  });
});

describe("requestWords", () => {
  it("takes a run's name and estimate from the line it was asked with", () => {
    expect(requestWords("Run Rack fitting clip for the City 3, estimated at $0.70")).toEqual({ name: "Rack fitting clip for the City 3", cost: "$0.70" });
    expect(requestWords("Run Product launch kit: City 3, estimated at $1,204.10")).toEqual({ name: "Product launch kit: City 3", cost: "$1,204.10" });
  });
  it("keeps any other request's line, with no cost", () => {
    expect(requestWords("Change Alex Kim's role to member")).toEqual({ name: "Change Alex Kim's role to member", cost: "" });
  });
});

describe("sharedNote", () => {
  const policy = "Video runs by members wait for an admin. Nothing is charged until it's approved.";
  it("lifts the sentence every request shares", () => {
    expect(sharedNote([{ preview: policy }, { preview: policy }])).toBe(policy);
  });
  it("keeps sentences on their rows when they differ, or when a request can be edited", () => {
    expect(sharedNote([{ preview: policy }, { preview: "Change the role to member." }])).toBe("");
    expect(sharedNote([{ preview: policy, editable_field: "role" }])).toBe("");
    expect(sharedNote([])).toBe("");
  });
});
