import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { blockedReason, choicesFor, findModel, fitSettings, modelsFor, rangeLayout, secondsWords, startingModel, usualSeconds, type PlaygroundCatalog } from "./catalog";

// The committed catalog file (read from disk: a test never bundles a backend file).
const generated = JSON.parse(readFileSync(new URL("../../../xano/catalog.gen.json", import.meta.url), "utf8"));

/** The committed catalog, as the endpoint serves it, with prices for everything but one image model. */
const catalog = (patch: Partial<PlaygroundCatalog> = {}): PlaygroundCatalog => ({
  statements: generated.statements as PlaygroundCatalog["statements"],
  unavailable: generated.unavailable,
  synced_at: generated.generated_at,
  priced: ["gemini-3.8-flash", "claude-sonnet-5-5", "claude-haiku-5-5", "gemini-3.1-flash-image", "gemini-3-pro-image", "veo-3.1-fast-generate-001", "lyria-002"],
  ai_status: "on", ai_status_reason: "", fix_command: "", plan_paid_storage: true, can_run: true, is_admin: false,
  budget: { month_words: "November 2026", used: 0, budget: 25_000_000 },
  ...patch,
});

describe("model choices", () => {
  it("offers Veo 3.1 Fast only 4, 6 and 8 seconds, in 16:9 and 9:16", () => {
    const veo = findModel(catalog(), "video", "veo-3.1-fast-generate-001");
    const c = choicesFor(veo);
    expect(c.durations).toEqual([4, 6, 8]);
    expect(c.aspectRatios).toEqual(["16:9", "9:16"]);
    expect(c.resolutions).toEqual(["720p", "1080p", "4k"]);
  });

  it("lists the suggested model first", () => {
    expect(modelsFor(catalog(), "image")[0].model).toBe("gemini-3.1-flash-image");
    expect(modelsFor(catalog(), "text")[0].suggested).toBe(true);
  });

  it("keeps a setting the new model allows and replaces one it doesn't", () => {
    const pro = findModel(catalog(), "image", "gemini-3-pro-image");
    const lite = findModel(catalog(), "image", "gemini-3.1-flash-lite-image");
    const onPro = fitSettings({ aspect: "4:5", size: "2K" }, pro, "image");
    expect(onPro).toMatchObject({ aspect: "4:5", size: "2K" });
    // Flash-Lite Image makes 1K only.
    expect(fitSettings(onPro, lite, "image")).toMatchObject({ aspect: "4:5", size: "1K" });
  });

  it("starts a clip at the longest length the model offers, in its first shape", () => {
    const veo = findModel(catalog(), "video", "veo-3.1-fast-generate-001");
    expect(fitSettings({}, veo, "video")).toMatchObject({ seconds: 8, aspect: "16:9", resolution: "720p", audio: false });
    expect(fitSettings({ seconds: 5 }, veo, "video").seconds).toBe(8);
    expect(fitSettings({ seconds: 4 }, veo, "video").seconds).toBe(4);
  });

  it("caps a text answer at what a Claude model can send", () => {
    const sonnet = findModel(catalog(), "text", "claude-sonnet-5-5");
    expect(fitSettings({ outputTokens: 16_000 }, sonnet, "text").outputTokens).toBe(8000);
  });
});

describe("whether Generate is on", () => {
  it("is on for a priced model when AI is on and the role can run", () => {
    expect(blockedReason(catalog(), "gemini-3.1-flash-image")).toBeNull();
  });

  it("says no price is set for a model missing from the price table", () => {
    expect(blockedReason(catalog(), "gemini-nano-banana-2.1")).toBe("No price set: an admin can add one under Usage.");
  });

  it("refuses a model the gateway doesn't serve, even with a price", () => {
    expect(blockedReason(catalog(), "claude-haiku-5-5")).toMatch(/doesn't serve it yet/);
  });

  it("starts on a model that can run, skipping unserved and unpriced ones", () => {
    expect(startingModel(catalog({ priced: ["gemini-3-pro-image"] }), "image")).toBe("gemini-3-pro-image");
  });

  it("is off while Xano AI is off, saying only that: the notice above carries the reason and the fix", () => {
    const off = catalog({ ai_status: "signed_out", ai_status_reason: "AI isn't switched on here yet.", fix_command: "npx @xano/sdk login", is_admin: true });
    expect(blockedReason(off, "gemini-3.8-flash")).toBe("Generate is off until AI is on.");
  });

  it("marks video, music and speech as needing a paid plan before they run, and leaves text and images alone", () => {
    const free = catalog({ plan_paid_storage: false });
    for (const kind of ["video", "music", "speech"]) expect(blockedReason(free, "veo-3.1-fast-generate-001", kind)).toBe("Needs a paid plan: this plan can't save video, voice or music files.");
    expect(blockedReason(free, "gemini-3.1-flash-image", "image")).toBeNull();
    expect(blockedReason(free, "gemini-3.8-flash", "text")).toBeNull();
    expect(blockedReason(catalog(), "veo-3.1-fast-generate-001", "video")).toBeNull();
  });

  it("is off for a role that can't run AI, before anything else", () => {
    expect(blockedReason(catalog({ can_run: false, ai_status: "disabled" }), "gemini-3.8-flash")).toBe("Your role can't run AI here. Ask an admin for access.");
  });
});

describe("how long a background run usually takes", () => {
  it("has a usual range for video and music only", () => {
    expect(usualSeconds("video", "veo-3.1-fast-generate-001")).toEqual([25, 90]);
    expect(usualSeconds("text", "gemini-3.8-flash")).toBeNull();
  });

  it("places the range and the elapsed marker on a scale to 1.5 × the slowest time", () => {
    // Scale 0–135 s: 25 s is 18.5%, 90 s is 66.7%, 45 s is 33.3%.
    expect(rangeLayout(45, [25, 90])).toEqual({ from: 18.5, to: 66.7, marker: 33.3, late: false, scale: 135 });
  });

  it("keeps the marker at the end and says it's late past the usual time", () => {
    const l = rangeLayout(400, [25, 90]);
    expect(l.marker).toBe(100);
    expect(l.late).toBe(true);
  });

  it("says seconds and minutes plainly", () => {
    expect(secondsWords(29.4)).toBe("29 s");
    expect(secondsWords(90)).toBe("1 min 30 s");
    expect(secondsWords(240)).toBe("4 min");
  });
});
