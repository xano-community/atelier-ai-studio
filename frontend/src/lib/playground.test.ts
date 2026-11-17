import { describe, expect, it } from "vitest";
import { buildRequest, compareKeys, formFromStep, groupHistory, missingInput, money, paneState, promptForKind, resultLine, titleFrom, usageWords, type Form, type RunView } from "./playground";

const form = (patch: Partial<Form> = {}): Form => ({
  tab: "text", audio: "speech", model: "gemini-3.8-flash", compareModel: "claude-sonnet-5-5", compare: false,
  prompt: "Write the product page intro for the Trail 2.", system: "", json: false, schema: "", negative: "", useBrand: true,
  speechText: "", voice: "", style: "", language: "", hint: "",
  settings: { aspect: "1:1", size: "1K", seconds: 8, resolution: "720p", audio: false, voice: "", outputTokens: 4000 },
  ...patch,
});

const view = (run: Partial<RunView["run"]>, step: Partial<RunView["steps"][number]> = {}): RunView => ({
  run: { id: 1, kind: "playground", via: "ui", title: "t", status: "done", reason: "", detail: "", estimate: 0, spent: 0, private: true, approval_id: 0, created_at: 0, finished_at: null, ...run },
  steps: [{ id: 11, seq: 1, kind: "text", model: "gemini-3.8-flash", status: "succeeded", reason: "", detail: "", attempt: 1, input: {}, options: {}, output: {}, usage: {},
    estimate: 0, charged: 0, brand_applied: false, asset_id: 0, url: "", sent_at: null, finished_at: null, ...step }],
});

describe("the request for each kind", () => {
  it("asks for text with the brand kit, the answer cap, and JSON with its schema when switched on", () => {
    const r = buildRequest(form({ json: true, schema: '{"type":"object","properties":{"intro":{"type":"string"}}}' }));
    expect(r.kind).toBe("text");
    expect(r.input).toEqual({ prompt: "Write the product page intro for the Trail 2.", use_brand: true, response_format: "json",
      json_schema: { type: "object", properties: { intro: { type: "string" } } } });
    expect(r.options.output_tokens).toBe(4000);
  });

  it("refuses a schema that isn't JSON, in words", () => {
    expect(missingInput(form({ json: true, schema: "{type: object" }), false)).toMatch(/isn't valid JSON/);
  });

  it("asks for an image at the size and shape picked", () => {
    const r = buildRequest(form({ tab: "image", model: "gemini-3.1-flash-image", settings: { ...form().settings, aspect: "4:5", size: "2K" } }));
    expect(r).toMatchObject({ kind: "image", model: "gemini-3.1-flash-image", options: { size: "2K", aspect_ratio: "4:5", samples: 1 } });
  });

  it("asks for a clip with its length, resolution and sound", () => {
    const r = buildRequest(form({ tab: "video", model: "veo-3.1-fast-generate-001", settings: { ...form().settings, seconds: 4, aspect: "9:16" } }));
    expect(r.options).toEqual({ seconds: 4, resolution: "720p", audio: false, aspect_ratio: "9:16", samples: 1 });
  });

  it("asks for speech with its words and voice, and music with its prompt", () => {
    const speech = buildRequest(form({ tab: "audio", audio: "speech", model: "gemini-3.8-flash-tts", speechText: "Meet the Trail 2.", settings: { ...form().settings, voice: "Kore" } }));
    expect(speech).toMatchObject({ kind: "speech", input: { text: "Meet the Trail 2.", voice: "Kore", use_brand: true } });
    const music = buildRequest(form({ tab: "audio", audio: "music", model: "lyria-002", prompt: "A calm acoustic theme" }));
    expect(music).toMatchObject({ kind: "music", input: { prompt: "A calm acoustic theme" } });
  });

  it("compares by sending the same input to the second model", () => {
    const f = form({ compare: true });
    const a = buildRequest(f), b = buildRequest(f, { model: f.compareModel });
    expect(b.model).toBe("claude-sonnet-5-5");
    expect(b.input).toEqual(a.input);
    expect(b.options).toEqual(a.options);
  });

  it("won't compare a model with itself", () => {
    expect(missingInput(form({ compare: true, compareModel: "gemini-3.8-flash" }), false)).toBe("Pick a second, different model to compare with.");
  });

  it("needs a recording to transcribe and words to speak", () => {
    expect(missingInput(form({ tab: "transcribe" }), false)).toBe("Attach a recording to transcribe.");
    expect(missingInput(form({ tab: "transcribe" }), true)).toBeNull();
    expect(missingInput(form({ tab: "audio", audio: "speech" }), false)).toBe("Write the words to say first.");
  });

  it("names a run from the first line of its prompt, cut at a word", () => {
    expect(titleFrom("Trail 2, sage, oak set\nMore detail", "Image")).toBe("Trail 2, sage, oak set");
    expect(titleFrom("Write the product page intro for the Trail 2: two sentences, our voice, mention the tyres", "Text")).toBe("Write the product page intro for the Trail 2: two sentences…");
    expect(titleFrom("   ", "Image")).toBe("Image");
  });
});

describe("Compare", () => {
  it("sends one click as two keys", () => {
    expect(compareKeys("c1")).toEqual(["c1:a", "c1:b"]);
  });

  it("shows each model's own time, tokens and cost", () => {
    const gemini = view({ id: 1, spent: 500 }, { model: "gemini-3.8-flash", usage: { input_tokens: 412, output_tokens: 64 }, sent_at: 1_000, finished_at: 3_100 });
    const claude = view({ id: 2, spent: 1_600 }, { model: "claude-sonnet-5-5", usage: { input_tokens: 418, output_tokens: 71 }, sent_at: 1_000, finished_at: 4_400 });
    expect(resultLine(gemini)).toEqual({ seconds: 2.1, usage: "412 in / 64 out", cost: "$0.0005" });
    expect(resultLine(claude)).toEqual({ seconds: 3.4, usage: "418 in / 71 out", cost: "$0.0016" });
  });

  it("shows a budget refusal in its own pane while the other pane shows its result", () => {
    const refused = view({ id: 2, status: "refused", reason: "over_budget", detail: "This run needs $0.02, but your budget for November 2026 has $0.01 left." }, { status: "skipped" });
    const done = view({ id: 1, status: "done", spent: 500 }, { output: { text: "Built for the long way home." } });
    expect(paneState({ view: refused })).toMatchObject({ state: "refused", words: "This run needs $0.02, but your budget for November 2026 has $0.01 left." });
    expect(paneState({ view: done }).state).toBe("done");
    expect(paneState({ error: "claude-haiku-5-5 is listed by Xano AI but isn't served yet. Pick another model." }).state).toBe("failed");
  });

  it("puts both runs of one click on one history line", () => {
    const rows = groupHistory(
      [{ id: 8, idem_key: "k2:b", title: "Trail 2 intro", status: "done", spent: 1_600, estimate: 0, created_at: 300 },
        { id: 7, idem_key: "k2:a", title: "Trail 2 intro", status: "done", spent: 500, estimate: 0, created_at: 299 },
        { id: 5, idem_key: "k1", title: "Trail 2, sage, oak set", status: "done", spent: 100_000, estimate: 0, created_at: 100 }],
      [{ run_id: 7, kind: "text", model: "gemini-3.8-flash" }, { run_id: 8, kind: "text", model: "claude-sonnet-5-5" }, { run_id: 5, kind: "image", model: "gemini-3.1-flash-image" }],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ runIds: [7, 8], models: ["gemini-3.8-flash", "claude-sonnet-5-5"], compared: true, spent: 2_100, kind: "text" });
    expect(rows[1]).toMatchObject({ runIds: [5], compared: false, kind: "image" });
  });

  it("puts the first model's run first, even when the second model's run was made first", () => {
    const rows = groupHistory(
      [{ id: 21, idem_key: "k3:a", title: "t", status: "done", spent: 1, estimate: 0, created_at: 2 }, { id: 20, idem_key: "k3:b", title: "t", status: "done", spent: 1, estimate: 0, created_at: 1 }],
      [{ run_id: 21, kind: "text", model: "gemini-3.8-flash" }, { run_id: 20, kind: "text", model: "claude-sonnet-5-5" }],
    );
    expect(rows[0]).toMatchObject({ runIds: [21, 20], models: ["gemini-3.8-flash", "claude-sonnet-5-5"] });
  });
});

describe("words", () => {
  it("keeps enough digits to compare cheap runs", () => {
    expect(money(100_000)).toBe("$0.10");
    expect(money(500)).toBe("$0.0005");
    expect(money(40)).toBe("under $0.0001");
  });

  it("says what an image and a clip used", () => {
    expect(usageWords({ kind: "image", usage: { input_tokens: 1290, output_tokens: 1120 }, output: {} })).toBe("1,290 in · 1 image out");
    expect(usageWords({ kind: "video", usage: { seconds: 4 }, output: {} })).toBe("4 s of video");
  });

  it("restores a past run's settings to run it again", () => {
    const step = view({}, { kind: "image", model: "gemini-3-pro-image", input: { prompt: "Trail 2 on oak", use_brand: false }, options: { size: "2K", aspect_ratio: "4:5" } }).steps[0];
    const back = formFromStep(step, form());
    expect(back).toMatchObject({ tab: "image", model: "gemini-3-pro-image", prompt: "Trail 2 on oak", useBrand: false, settings: { size: "2K", aspect: "4:5" } });
  });
});

describe("the starting prompt", () => {
  it("follows the tab while it's still a starter", () => {
    const fromText = promptForKind("", "text");
    expect(fromText).toMatch(/Trail 2/);
    const image = promptForKind(fromText, "image");
    expect(image).not.toBe(fromText);
    expect(promptForKind(image, "video")).not.toBe(image);
  });
  it("keeps what someone wrote", () => {
    expect(promptForKind("A red bike on a beach", "image")).toBe("A red bike on a beach");
  });
  it("leaves a kind with no prompt alone", () => {
    expect(promptForKind("", "transcribe")).toBe("");
  });
  it("starts every kind runnable", () => {
    for (const kind of ["text", "image", "video", "music"] as const) {
      expect(missingInput(form({ tab: kind === "music" ? "audio" : kind, audio: "music", prompt: promptForKind("", kind) }), false)).toBeNull();
    }
  });
});
