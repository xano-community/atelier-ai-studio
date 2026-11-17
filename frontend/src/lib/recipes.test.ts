import { describe, expect, it } from "vitest";
import { lastRunWords, lastValues, stepBits, stepUses } from "./recipes";

describe("what a step uses, for the Steps tab", () => {
  const inputs = [{ name: "product", label: "Product", type: "text" as const, required: true }, { name: "notes", label: "Notes", type: "knowledge" as const, required: false }];
  const steps = [{ seq: 1, name: "Launch copy", kind: "text" }, { seq: 2, name: "Hero image", kind: "image" }];
  it("names inputs by label and earlier steps by number and name, each once, in the order written", () => {
    const uses = stepUses({ prompt: "Read {{step.1.script}} for the {{input.product}}, then {{ input.product }} again with {{input.notes}}", file: "{{step.2}}" }, inputs, steps);
    expect(uses.map((u) => [u.step ?? 0, u.label])).toEqual([[1, "Launch copy → script"], [0, "Product"], [0, "Notes"], [2, "Hero image"]]);
  });
  it("lists a step's settings each on its own", () => {
    expect(stepBits({ kind: "video", settings: { use_brand: true }, options: { seconds: 8, resolution: "720p", aspect_ratio: "16:9", audio: false } }))
      .toEqual(["8 s", "720p", "16:9", "silent", "brand kit"]);
    expect(stepBits({ kind: "text", settings: { response_format: "json" }, options: {} })).toEqual(["JSON"]);
  });
});
import fillBody from "./rules/recipe-fill";
import { curlFor, draftFromRun, fileChoices, insertAt, moveStep, planDraft, removeStep, wordChoices, type Draft, type DraftStep } from "./recipes";
import type { RunView } from "./playground";

const step = (name: string, kind: DraftStep["kind"], prompt: string, extra: Partial<DraftStep> = {}): DraftStep => ({
  name, kind, model: "gemini-3.8-flash", prompt, file: "", settings: {}, options: {}, ...extra,
});
const draft = (steps: DraftStep[], inputs: Draft["inputs"] = []): Draft => ({ name: "Kit", description: "", status: "draft", inputs, steps });

describe("a recipe's references", () => {
  it("takes each step's dependencies from the steps its prompt and file name", () => {
    const d = draft([
      step("Copy", "text", "Copy for {{input.product}}", { settings: { response_format: "json", json_schema: { properties: { script: {} } } } }),
      step("Hero", "image", "A photo of {{input.product}}", { model: "gemini-3.1-flash-image" }),
      step("Video", "video", "Push in slowly", { model: "veo-3.1-fast-generate-001", file: "{{step.2}}" }),
      step("Voiceover", "speech", "{{step.1.script}}", { model: "gemini-3.8-flash-tts" }),
    ], [{ name: "product", label: "Product", type: "text", required: true }]);
    const plan = planDraft(d);
    expect(plan.ok).toBe(true);
    expect(plan.steps.map((s) => s.depends_on)).toEqual([[], [], [2], [1]]);
  });

  it("marks a reference to a later step on that reference, and to the step itself", () => {
    const plan = planDraft(draft([step("Copy", "text", "Shorten {{step.2}}"), step("Tagline", "text", "Say {{step.2}}")]));
    expect(plan.ok).toBe(false);
    expect(plan.errors).toContainEqual(expect.objectContaining({ step: 1, field: "prompt", ref: "step.2", message: expect.stringContaining("runs after this one") }));
    expect(plan.errors).toContainEqual(expect.objectContaining({ step: 2, field: "prompt", ref: "step.2", message: expect.stringContaining("is this step") }));
  });

  it("refuses a file input in words, a picture in words, and a field of a reply that isn't JSON", () => {
    const plan = planDraft(draft([
      step("Hero", "image", "A bike", { model: "gemini-3.1-flash-image" }),
      step("Copy", "text", "Describe {{input.photo}} and {{step.1}}"),
      step("Short", "text", "Shorten {{step.2.headline}}"),
    ], [{ name: "photo", label: "Photo", type: "image", required: true }]));
    const messages = plan.errors.map((e) => e.message);
    expect(messages).toContain("photo is a file, so it can't go into words. Pick it as this step's file instead.");
    expect(messages).toContain("Step 1 makes an image, which can't go into words. Use it as this step's file instead.");
    expect(messages.some((m) => m.includes("doesn't return JSON"))).toBe(true);
  });

  it("offers only what a step can use: earlier word steps for its prompt, earlier images for a video's first frame", () => {
    const d = draft([step("Copy", "text", "x"), step("Hero", "image", "y"), step("Video", "video", "z")], [{ name: "photo", label: "Photo", type: "image", required: false }]);
    expect(wordChoices(d, 2).map((c) => c.token)).toEqual(["{{step.1}}"]);
    expect(fileChoices(d, 2).map((c) => c.token)).toEqual(["{{input.photo}}", "{{step.2}}"]);
    expect(wordChoices(d, 0)).toEqual([]);
  });
});

describe("moving and removing steps", () => {
  it("keeps every reference on the step it named", () => {
    const steps = [step("A", "text", "a"), step("B", "text", "use {{step.1}}"), step("C", "text", "use {{step.2}} and {{step.1}}")];
    const moved = moveStep(steps, 0, 1);
    expect(moved.map((s) => s.name)).toEqual(["B", "A", "C"]);
    // B named A (was step 1, now step 2): after the move it names a later step, and the plan says so.
    expect(moved[0].prompt).toBe("use {{step.2}}");
    expect(moved[2].prompt).toBe("use {{step.1}} and {{step.2}}");
    expect(planDraft(draft(moved)).errors[0]).toMatchObject({ step: 1, ref: "step.2" });
  });

  it("renumbers the steps after a removed one and leaves a reference to it to be flagged", () => {
    const left = removeStep([step("A", "text", "a"), step("B", "text", "b"), step("C", "text", "{{step.1}} {{step.3}}")], 0);
    expect(left[1].prompt).toBe("{{step.1}} {{step.2}}");
  });
});

describe("Save as recipe", () => {
  const view = (input: Record<string, unknown>, options: Record<string, unknown>, kind = "image"): RunView => ({
    run: { id: 7, kind: "playground", via: "ui", title: "Trail 2 on a forest road", status: "done", reason: "", detail: "", estimate: 0, spent: 0, private: true, approval_id: 0, created_at: 0, finished_at: 0 },
    steps: [{ id: 9, seq: 1, kind, model: "gemini-3.1-flash-image", status: "succeeded", reason: "", detail: "", attempt: 1, input, options, output: {}, usage: {}, estimate: 0, charged: 0, brand_applied: true, asset_id: 0, url: "" }],
  });

  it("makes a one-step draft whose step matches the image run", () => {
    const d = draftFromRun(view({ prompt: "Trail 2 on a forest road", use_brand: true }, { size: "2K", aspect_ratio: "4:5", samples: 1 }));
    expect(d.name).toBe("Trail 2 on a forest road");
    expect(d.status).toBe("draft");
    expect(d.inputs).toEqual([]);
    expect(d.steps).toHaveLength(1);
    expect(d.steps[0]).toMatchObject({ kind: "image", model: "gemini-3.1-flash-image", prompt: "Trail 2 on a forest road", file: "", settings: { use_brand: true }, options: { size: "2K", aspect_ratio: "4:5" } });
  });

  it("asks for the file each time when the run edited one", () => {
    const d = draftFromRun(view({ prompt: "Make it sage green", sources: [{ name: "bike.png" }] }, { size: "1K" }));
    expect(d.inputs).toEqual([{ name: "image", label: "Image", type: "image", required: true }]);
    expect(d.steps[0].file).toBe("{{input.image}}");
    expect(planDraft(d).ok).toBe(true);
  });
});

describe("the editor's small rules", () => {
  it("inserts a reference at the cursor with a space either side", () => {
    expect(insertAt("Shorten this", "{{step.1}}", 7)).toEqual({ text: "Shorten {{step.1}} this", cursor: 18 });
    expect(insertAt("", "{{input.product}}")).toEqual({ text: "{{input.product}}", cursor: 17 });
  });

  it("writes the cURL call with the person's key, an idempotency key and files in order", () => {
    const curl = curlFor("https://x1.xano.io/", "product-launch-kit", [
      { name: "product", label: "Product", type: "knowledge", required: true }, { name: "photo", label: "Photo", type: "image", required: true },
    ]);
    expect(curl).toContain("https://x1.xano.io/api:studio/recipes/product-launch-kit/run");
    expect(curl).toContain('-H "Authorization: Bearer $ATELIER_KEY"');
    expect(curl).toContain("Idempotency-Key");
    expect(curl).toContain(`-F 'inputs={"product":"what to look up"}'`);
    expect(curl).toContain("-F file_1=@photo.jpg");
    expect(curl.endsWith("\\")).toBe(false);
  });
});

describe("filling a step when it runs", () => {
  const fill = (templates: Record<string, string>, outputs: Record<string, unknown>, knowledge: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    fillBody({ $var: { fill_in: { fill: { templates, seq_of: { "1": 2, "2": 3 }, caps: { step: 12, knowledge: 20, speech: 8 }, ...extra }, outputs, knowledge } } });

  it("puts in an earlier step's words, one field of its JSON, and Knowledge passages, each cut to its cap", () => {
    const out = fill({ prompt: "A: {{step.1}} B: {{step.2.script}} K: {{input.product}}" },
      { "2": { text: "Room for the rough stuff and more", json: null }, "3": { text: "{}", json: { script: "Meet the Trail 2." } } },
      { product: "[1] (Spec) Clears 2.4 inch tyres." });
    // The recipe's step 1 ran as seq 2 (a Knowledge step went first). Each value stops at its cap.
    expect(out.fields.prompt).toBe("A: Room for the B: Meet the Tra K: [1] (Spec) Clears 2.");
    expect(out.missing).toEqual([]);
  });

  it("cuts the words a speech step says to the speech cap, and names a step with no output", () => {
    const out = fill({ prompt: "{{step.1}}" }, { "2": { text: "Twelve words long here", json: null } }, {}, { speech: true });
    expect(out.fields.prompt).toBe("Twelve w");
    expect(fill({ prompt: "{{step.2}}" }, {}).missing).toEqual(["step 2"]);
  });
});

describe("filling the run form from a last run", () => {
  const inputs = [
    { name: "product", label: "Product", type: "text" as const, required: true },
    { name: "photo", label: "Photo", type: "image" as const, required: false },
    { name: "points", label: "Points", type: "long_text" as const, required: false },
  ];
  it("takes back the words for inputs the recipe still asks for, but never a file or an empty value", () => {
    expect(lastValues(inputs, [{ name: "product", value: "City 3" }, { name: "photo", value: "city-3.jpg" }, { name: "points", value: "  " }, { name: "gone", value: "x" }]))
      .toEqual({ product: "City 3" });
  });
  it("cuts a value to what its field allows", () => {
    expect(lastValues(inputs, [{ name: "product", value: "a".repeat(2500) }]).product).toHaveLength(2000);
  });
});

describe("when a recipe last ran, for the list", () => {
  const now = new Date(2026, 10, 17, 9, 30).getTime();
  it("says today and yesterday by the viewer's own days", () => {
    expect(lastRunWords(new Date(2026, 10, 17, 0, 5).getTime(), now)).toBe("Today");
    expect(lastRunWords(new Date(2026, 10, 16, 23, 50).getTime(), now)).toBe("Yesterday");
  });
  it("gives the day and month this year, and the year before that", () => {
    expect(lastRunWords(new Date(2026, 10, 4, 12).getTime(), now)).toBe("4 Nov");
    expect(lastRunWords(new Date(2025, 11, 30, 12).getTime(), now)).toBe("30 Dec 2025");
  });
});
