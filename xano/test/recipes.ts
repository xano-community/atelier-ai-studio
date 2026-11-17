// Recipes: saving checks references (a step can use only the steps before it), a run's steps go in listed order with
// each step's dependencies taken from what its prompt names, a step whose dependency didn't succeed is skipped and the
// rest still run, one approval covers a run, a key's run is its owner's, a repeat is one run, and a retired model is
// refused. Steps are recorded with the real functions and a stub in the model's seat, as in steps.ts. Charges are worked
// out by hand from the test prices below, plus the gateway's 10%.
import { c, caught, cmp, col, fl, obj, ref, s, withFilters } from "@xano/sdk";
import { agent } from "../agent.js";
import { approvals } from "../approvals.js";
import { notification } from "../base/tables.js";
import { recipe } from "../table/recipes/recipe.js";
import { recipe_step } from "../table/recipes/recipe_step.js";
import { user } from "../table/user.js";
import { ai_run } from "../table/studio/ai_run.js";
import { ai_step } from "../table/studio/ai_step.js";
import { ledger } from "../table/studio/ledger.js";
import { asset } from "../table/library/asset.js";
import { claimStepFn, recordStepFn } from "../function/runs/execute_step.js";
import { retryRunFn } from "../function/runs/control.js";
import { deriveKeyFn } from "../function/runs/start.js";
import { planFn } from "../function/recipes/plan.js";
import { listRecipesFn, saveRecipeFn, startRecipeFn, viewRecipeFn } from "../function/recipes/recipes.js";
import { $, equal, is, ledgerAgrees, num, person, plainTest, priceRow, says, settings, workflowTest } from "./fixtures.js";

/** Test prices on real catalog models (a recipe's models are checked against the catalog). */
const prices = [
  priceRow("gemini-3.8-flash", "text", "input_token", 1 * $),
  priceRow("gemini-3.8-flash", "text", "output_token", 2 * $),
  priceRow("gemini-3.1-flash-image", "image", "image", 100_000, "1K"),
  priceRow("veo-3.1-fast-generate-001", "video", "second", 80_000, "720p/silent"),
  priceRow("gemini-3.8-flash-tts", "speech", "input_token", 1 * $),
  priceRow("gemini-3.8-flash-tts", "speech", "output_token", 2 * $),
  priceRow("lyria-002", "music", "clip", 60_000),
];

const COPY_SCHEMA = { type: "object", properties: { headline: { type: "string" }, script: { type: "string" } }, required: ["headline", "script"] };
/** The launch kit: copy, a hero image, a video from the image, a voiceover reading the copy's script, and a music bed. */
const launchKit = {
  name: "Product launch kit",
  inputs: [{ name: "product", label: "Product", type: "text", required: true }],
  steps: [
    { name: "Launch copy", kind: "text", model: "gemini-3.8-flash", prompt: "Write launch copy for {{input.product}}.", file: "",
      settings: { response_format: "json", json_schema: COPY_SCHEMA, use_brand: false }, options: { output_tokens: 1000 } },
    { name: "Hero image", kind: "image", model: "gemini-3.1-flash-image", prompt: "A hero photo of {{input.product}} on a gravel road.", file: "",
      settings: { use_brand: false }, options: { size: "1K", aspect_ratio: "4:5" } },
    { name: "8 s video", kind: "video", model: "veo-3.1-fast-generate-001", prompt: "A slow push in on the bike.", file: "{{step.2}}",
      settings: { use_brand: false }, options: { seconds: 4, resolution: "720p", audio: false, aspect_ratio: "9:16" } },
    { name: "Voiceover", kind: "speech", model: "gemini-3.8-flash-tts", prompt: "{{step.1.script}}", file: "", settings: { voice: "Kore", use_brand: false }, options: {} },
    { name: "Music bed", kind: "music", model: "lyria-002", prompt: "Warm indie, 100 bpm, no vocals.", file: "", settings: { use_brand: false }, options: {} },
  ],
};
type Draft = { name: string; inputs: Record<string, unknown>[]; steps: Record<string, unknown>[] };
const save = (as: string, actor: string, draft: Draft, status = "published") => s.function.run({ fn: saveRecipeFn, as, input: {
  actor_id: ref(`${actor}.id`), recipe_id: c.int(0), name: c.text(draft.name), description: c.text(""), status: c.text(status),
  inputs: c.array(draft.inputs as never), steps: c.array(draft.steps as never),
} });
const run = (as: string, actor: string, recipe: string, key: string, values: Record<string, unknown>, o: { via?: string; connection?: string } = {}) =>
  s.function.run({ fn: startRecipeFn, as, input: {
    actor_id: ref(`${actor}.id`), recipe_id: ref(`${recipe}.id`), values: c.obj(values as never), uploads: c.array([]), via: c.text(o.via ?? "ui"),
    connection_id: o.connection ? ref(`${o.connection}.connection.id`) : c.int(0), idem_key: c.text(key), base_url: c.text(""), agent_label: c.text("Test"), allow_draft: c.bool(false),
  } });
const stepsOf = (runVar: string, n: number) => [
  s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref(`${runVar}.run.id`)), sort: [{ sortBy: "seq", dir: "asc" }], as: "steps" }),
  ...Array.from({ length: n }, (_, i) => s.set_var(`step${i + 1}`, withFilters(ref("steps"), fl.get(String(i))))),
];
const claim = (as: string, step: string, attempt = 1) => s.function.run({ fn: claimStepFn, as, input: { step_id: ref(`${step}.id`), attempt: c.int(attempt) } });
const record = (as: string, step: string, outcome: string, output: Record<string, unknown> = {}, usage: Record<string, number> = {}) =>
  s.function.run({ fn: recordStepFn, as, input: {
    step_id: ref(`${step}.id`), attempt: c.int(1), outcome: c.text(outcome), reason: c.text(""), detail: c.text(outcome === "succeeded" ? "" : "It didn't work."),
    refused: c.bool(false), output: c.obj(output as never), usage: c.obj(usage), brand_applied: c.bool(false), sent_prompt: c.text(""),
  } });
const reload = (as: string, step: string) => s.db.get({ table: ai_step, fieldValue: ref(`${step}.id`), as });
const truthy = (path: string) => s.expect.to_be_true({ expr: ref(path) });

export const recipeTests = [
  workflowTest({
    name: "recipes: a step's dependencies are the earlier steps its prompt and file name, and a later step can't be named",
    stack: [
      settings(), person("jordan", "admin"), ...prices,
      save("kit", "jordan", launchKit),
      s.db.query({ table: recipe_step, where: cmp(col("recipe_id"), "=", ref("kit.id")), sort: [{ sortBy: "seq", dir: "asc" }], as: "rows" }),
      equal("rows.0.depends_on", c.array([])),
      // The video starts from the hero image; the voiceover reads the copy's script.
      equal("rows.2.depends_on", c.array([2])),
      equal("rows.3.depends_on", c.array([1])),
      equal("rows.4.depends_on", c.array([])),
      is("kit.slug", "product-launch-kit"),
      // A second recipe with the same name gets its own address.
      save("again", "jordan", launchKit, "draft"),
      is("again.slug", "product-launch-kit-2"),
      // Step 1 naming step 2 is refused, and the error points at that reference.
      s.function.run({ fn: planFn, as: "plan", input: { inputs: c.array([]), build: c.bool(false), values: c.null(), files_given: c.array([]), steps: c.array([
        { name: "Copy", kind: "text", model: "gemini-3.8-flash", prompt: "Shorten {{step.2}}", file: "", settings: {}, options: {} },
        { name: "Tagline", kind: "text", model: "gemini-3.8-flash", prompt: "A tagline", file: "", settings: {}, options: {} },
      ] as never) } }),
      s.expect.to_be_false({ expr: ref("plan.ok") }),
      num("plan.errors.0.step", 1), is("plan.errors.0.field", "prompt"), is("plan.errors.0.ref", "step.2"),
      says("plan.errors.0.message", "runs after this one"),
      s.expect.to_throw({ exception: c.text("runs after this one"), body: [
        s.db.query({ table: user, where: cmp(col("email"), "=", c.text("jordan@studio-test.example")), returnType: "single", as: "maker" }),
        s.function.run({ fn: saveRecipeFn, as: "bad", input: { actor_id: ref("maker.id"), recipe_id: c.int(0), name: c.text("Backwards"), description: c.text(""), status: c.text("draft"), inputs: c.array([]),
          steps: c.array([
            { name: "Copy", kind: "text", model: "gemini-3.8-flash", prompt: "Shorten {{step.2}}", file: "", settings: {}, options: {} },
            { name: "Tagline", kind: "text", model: "gemini-3.8-flash", prompt: "A tagline", file: "", settings: {}, options: {} },
          ] as never) } }),
      ] }),
    ],
  }),

  workflowTest({
    name: "recipes: when the video times out after the copy and image succeed, the run is partial, the steps that don't need the video still run, and a retry re-runs only the video",
    stack: [
      settings({ line: 5 * $ }), person("jordan", "admin"), ...prices,
      save("kit", "jordan", launchKit),
      // Its first step is copy, but a kit with a video is shown as video.
      s.db.get({ table: recipe, fieldValue: ref("kit.id"), output: ["lead_kind"], as: "kit_row" }), is("kit_row.lead_kind", "video"),
      run("r", "jordan", "kit", "click-1", { product: "Trail 2" }),
      is("r.outcome", "created"), is("r.run.status", "queued"), is("r.run.title", "Product launch kit · Trail 2"),
      ...stepsOf("r", 5),
      is("step3.label", "8 s video"),
      // 4 seconds at $0.08, plus 10%.
      num("step3.estimate", 352_000),
      claim("c1", "step1"), is("c1.status", "sent"),
      // The text input was filled in when the run started.
      reload("s1", "step1"), is("s1.input.prompt", "Write launch copy for Trail 2."),
      record("r1", "step1", "succeeded", { text: "{}", json: { headline: "Room for the rough stuff.", script: "Meet the Trail 2." } }, { input_tokens: 100, output_tokens: 100 }),
      claim("c2", "step2"),
      record("r2", "step2", "succeeded", { file: { path: "/vault/test/hero.png", name: "hero.png", mime: "image/png" }, resource: "hero-file-token" }, { input_tokens: 10, output_tokens: 1000 }),
      // The video gets the hero image as its first frame, from step 2's output.
      claim("c3", "step3"), is("c3.status", "sent"),
      reload("s3", "step3"), is("s3.input.image", "hero-file-token"),
      record("r3", "step3", "timed_out"),
      // The voiceover doesn't need the video: it still runs, reading the copy's script.
      claim("c4", "step4"), is("c4.status", "sent"),
      reload("s4", "step4"), is("s4.input.text", "Meet the Trail 2."),
      record("r4", "step4", "succeeded", { file: { path: "/vault/test/vo.wav" }, resource: "vo-token" }, { input_tokens: 20, output_tokens: 200 }),
      claim("c5", "step5"),
      record("r5", "step5", "succeeded", { file: { path: "/vault/test/bed.mp3" } }),
      s.db.get({ table: ai_run, fieldValue: ref("r.run.id"), as: "ended" }),
      is("ended.status", "partial"),
      // Timed out is charged in full.
      reload("v", "step3"), is("v.status", "timed_out"), num("v.charged", 352_000),
      // The bell tells the owner how it ended.
      s.db.query({ table: notification, where: cmp(col("user_id"), "=", ref("jordan.id")), returnType: "single", as: "rang" }),
      is("rang.title", "Product launch kit · Trail 2 finished, 1 step failed"),
      // Retry: only the video goes again.
      s.function.run({ fn: retryRunFn, as: "again", input: { run_id: ref("r.run.id"), actor_id: ref("jordan.id"), key: c.text("retry-1"), edits: c.array([]) } }),
      is("again.outcome", "created"), is("again.run.status", "queued"),
      s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", ref("r.run.id")), cmp(col("status"), "=", c.text("queued"))], as: "queued" }),
      s.expect.to_equal({ expr: withFilters(ref("queued"), fl.count()), value: c.int(1) }),
      equal("queued.0.id", ref("step3.id")), num("queued.0.attempt", 2),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "recipes: a step whose prompt names a blocked step is skipped and says so, and a step that doesn't need it still runs",
    stack: [
      settings({ line: 5 * $ }), person("jordan", "admin"), ...prices,
      save("kit", "jordan", { name: "Tagline then shorter", inputs: [], steps: [
        { name: "Tagline", kind: "text", model: "gemini-3.8-flash", prompt: "A tagline for a gravel bike.", file: "", settings: { use_brand: false }, options: { output_tokens: 200 } },
        { name: "Shorter", kind: "text", model: "gemini-3.8-flash", prompt: "Shorten this: {{step.1}}", file: "", settings: { use_brand: false }, options: { output_tokens: 200 } },
        { name: "Alt text", kind: "text", model: "gemini-3.8-flash", prompt: "Alt text for a bike photo.", file: "", settings: { use_brand: false }, options: { output_tokens: 200 } },
      ] }),
      run("r", "jordan", "kit", "click-1", {}),
      ...stepsOf("r", 3),
      equal("step2.depends_on", c.array([1])),
      claim("c1", "step1"),
      record("r1", "step1", "blocked", { finish_reason: null }, { input_tokens: 11, output_tokens: 157 }),
      claim("c2", "step2"), is("c2.status", "skipped"),
      reload("s2", "step2"), is("s2.status", "skipped"), is("s2.detail", "Skipped, because step 1 was blocked. Nothing was charged for it."),
      s.db.query({ table: ledger, where: cmp(col("step_id"), "=", ref("step2.id")), returnType: "single", as: "s2_money" }),
      is("s2_money.state", "released"), num("s2_money.amount", 0),
      claim("c3", "step3"), is("c3.status", "sent"),
      record("r3", "step3", "succeeded", { text: "A gravel bike on a forest road." }, { input_tokens: 20, output_tokens: 20 }),
      s.db.get({ table: ai_run, fieldValue: ref("r.run.id"), as: "ended" }), is("ended.status", "partial"),
      // Retry with the blocked prompt edited: the blocked step and the one skipped for it go again; the alt text stays.
      s.function.run({ fn: retryRunFn, as: "again", input: { run_id: ref("r.run.id"), actor_id: ref("jordan.id"), key: c.text("retry-1"),
        edits: withFilters(c.array([]), fl.append(obj({ step_id: ref("step1.id"), prompt: c.text("A calm tagline for a gravel bike.") }), c.text(""))) } }),
      reload("s1", "step1"), is("s1.status", "queued"), num("s1.attempt", 2), is("s1.input.prompt", "A calm tagline for a gravel bike."),
      reload("s2b", "step2"), is("s2b.status", "queued"), num("s2b.attempt", 2),
      reload("s3b", "step3"), is("s3b.status", "succeeded"), num("s3b.attempt", 1),
      ...ledgerAgrees(),
    ],
  }),

  plainTest({
    name: "recipes: a member's run with a video waits for one approval, which names the video step",
    stack: [
      settings({ line: 5 * $ }), person("jordan", "admin"), person("sam"), ...prices,
      save("kit", "jordan", launchKit),
      run("r", "sam", "kit", "click-1", { product: "Trail 2" }),
      is("r.run.status", "waiting_approval"),
      says("r.run.detail", "Needs it: step 3, 8 s video ($0.35)"),
      s.db.query({ table: approvals.approval, returnType: "count", as: "asked" }),
      num("asked", 1),
      // Nothing is held while it waits.
      s.db.query({ table: ledger, returnType: "count", as: "held" }),
      num("held", 0),
    ],
  }),

  workflowTest({
    name: "recipes: a run started with a person's key is theirs, records the key, and a repeat of its key is the same run",
    stack: [
      settings({ line: 5 * $ }), person("jordan", "admin"), person("sam"), ...prices,
      save("kit", "jordan", { name: "Product page copy", inputs: [{ name: "product", label: "Product", type: "text", required: true }], steps: [
        { name: "Copy", kind: "text", model: "gemini-3.8-flash", prompt: "Product page copy for {{input.product}}.", file: "", settings: { use_brand: false }, options: { output_tokens: 500 } },
      ] }),
      s.function.run({ fn: agent.connectFn, as: "key", input: { user_id: ref("sam.id"), name: c.text("Shop sync"), scope: c.text("read_write"), days: c.int(30) } }),
      run("r", "sam", "kit", "api:abc", { product: "Trail 2" }, { via: "api", connection: "key" }),
      is("r.outcome", "created"), is("r.run.status", "queued"),
      s.db.get({ table: ai_run, fieldValue: ref("r.run.id"), as: "row" }),
      is("row.via", "api"), equal("row.connection_id", ref("key.connection.id")), equal("row.owner_id", ref("sam.id")),
      s.db.query({ table: ledger, where: cmp(col("run_id"), "=", ref("r.run.id")), returnType: "single", as: "money" }),
      equal("money.owner_id", ref("sam.id")), equal("money.connection_id", ref("key.connection.id")), is("money.via", "api"),
      // The same key again: the same run, and no second reservation.
      run("again", "sam", "kit", "api:abc", { product: "Trail 2" }, { via: "api", connection: "key" }),
      is("again.outcome", "existing"), equal("again.run.id", ref("r.run.id")),
      s.db.query({ table: ledger, returnType: "count", as: "entries" }), num("entries", 1),
      // The same key with different inputs is refused as a conflict.
      run("other", "sam", "kit", "api:abc", { product: "City 3" }, { via: "api", connection: "key" }),
      is("other.outcome", "conflict"),
      // Revoked before its step is sent: the step never runs and its money goes back.
      s.function.run({ fn: agent.revokeFn, as: "revoked", input: { user_id: ref("sam.id"), id: ref("key.connection.id") } }),
      ...stepsOf("r", 1),
      claim("late", "step1"), is("late.status", "refused"),
      s.db.get({ table: ai_run, fieldValue: ref("r.run.id"), as: "stopped" }),
      is("stopped.status", "refused"), says("stopped.detail", "revoked or has expired"),
      s.db.query({ table: ledger, where: cmp(col("run_id"), "=", ref("r.run.id")), returnType: "single", as: "back" }),
      is("back.state", "released"),
      ...ledgerAgrees(),
    ],
  }),

  plainTest({
    name: "recipes: without a key of its own, the same call within ten minutes derives the same key, whatever order its arguments came in",
    stack: [
      person("sam"),
      s.function.run({ fn: deriveKeyFn, as: "one", input: { actor_id: ref("sam.id"), tool: c.text("recipe-api:kit"), args: c.obj({ product: "Trail 2", angle: "new" }), turn: c.text(""), at: c.int(0) } }),
      s.function.run({ fn: deriveKeyFn, as: "two", input: { actor_id: ref("sam.id"), tool: c.text("recipe-api:kit"), args: c.obj({ angle: "new", product: "Trail 2" }), turn: c.text(""), at: c.int(0) } }),
      equal("one", ref("two")),
      s.function.run({ fn: deriveKeyFn, as: "three", input: { actor_id: ref("sam.id"), tool: c.text("recipe-api:kit"), args: c.obj({ product: "City 3", angle: "new" }), turn: c.text(""), at: c.int(0) } }),
      s.expect.to_not_equal({ expr: ref("one"), value: ref("three") }),
      s.function.run({ fn: deriveKeyFn, as: "turned", input: { actor_id: ref("sam.id"), tool: c.text("recipe-api:kit"), args: c.obj({ product: "Trail 2", angle: "new" }), turn: c.text("turn-7"), at: c.int(0) } }),
      s.expect.to_not_equal({ expr: ref("one"), value: ref("turned") }),
    ],
  }),

  workflowTest({
    name: "recipes: a recipe whose model was retired shows which step and what to use, and its runs are refused with 409",
    stack: [
      settings({ line: 5 * $ }), person("jordan", "admin"), ...prices,
      save("kit", "jordan", { name: "Tagline", inputs: [], steps: [
        { name: "Tagline", kind: "text", model: "gemini-3.8-flash", prompt: "A tagline.", file: "", settings: { use_brand: false }, options: {} },
      ] }),
      // The catalog moved on after it was saved.
      s.db.query({ table: recipe_step, where: cmp(col("recipe_id"), "=", ref("kit.id")), returnType: "single", as: "row" }),
      s.db.patch({ table: recipe_step, fieldValue: ref("row.id"), data: obj({ model: c.text("gemini-2.0-flash") }) }),
      s.function.run({ fn: viewRecipeFn, as: "view", input: { actor_id: ref("jordan.id"), slug: c.text("tagline"), recipe_id: c.int(0) } }),
      num("view.retired.0.seq", 1), is("view.retired.0.model", "gemini-2.0-flash"),
      s.expect.to_contain({ expr: ref("view.retired.0.allowed"), value: c.text("gemini-3.8-flash") }),
      // Refused with the retired model's words and what its kind can use (the route answers 409 with them).
      s.set_var("refusal", c.text("")),
      s.try_catch({
        try: [s.function.run({ fn: startRecipeFn, as: "refused", input: { actor_id: ref("jordan.id"), recipe_id: ref("kit.id"), values: c.obj({}), uploads: c.array([]), via: c.text("api"),
          connection_id: c.int(0), idem_key: c.text("k"), base_url: c.text(""), agent_label: c.text("Test"), allow_draft: c.bool(false) } })],
        catch: [s.update_var("refusal", withFilters(caught("result"), fl.to_text()))],
      }),
      says("refusal", "Step 1 uses a model Xano AI no longer offers: gemini-2.0-flash"),
      says("refusal", "gemini-3.8-flash"),
      s.db.query({ table: ai_run, returnType: "count", as: "runs" }), num("runs", 0),
    ],
  }),

  plainTest({
    name: "recipes: a pick from Knowledge becomes an embedding step first, and the steps that use it wait for it",
    stack: [
      s.function.run({ fn: planFn, as: "plan", input: { build: c.bool(true), files_given: c.array([]), values: c.obj({ product: "Trail 2", angle: "" }),
        inputs: c.array([{ name: "product", label: "Product", type: "knowledge", required: true }, { name: "angle", label: "Angle", type: "text", required: false }] as never),
        steps: c.array([
          { name: "Copy", kind: "text", model: "gemini-3.8-flash", prompt: "Launch copy from these notes:\n{{input.product}}\nAngle: {{input.angle}}", file: "", settings: {}, options: {} },
          { name: "Alt text", kind: "text", model: "gemini-3.8-flash", prompt: "Alt text for a bike photo.", file: "", settings: {}, options: {} },
        ] as never) } }),
      truthy("plan.ok"),
      num("plan.kb_steps", 1),
      is("plan.run_steps.0.kind", "embedding"), is("plan.run_steps.0.input.task_type", "RETRIEVAL_QUERY"),
      equal("plan.run_steps.0.input.input", c.array(["Trail 2"])),
      equal("plan.run_steps.1.depends_on", c.array([1])),
      equal("plan.run_steps.2.depends_on", c.array([])),
      // The copy waits to be filled; the alt text is ready as it is.
      is("plan.run_steps.1.input.prompt", ""),
      is("plan.run_steps.1.input.fill.templates.prompt", "Launch copy from these notes:\n{{input.product}}\nAngle: "),
      is("plan.run_steps.2.input.prompt", "Alt text for a bike photo."),
      // A required input left empty is refused before anything starts.
      s.function.run({ fn: planFn, as: "empty", input: { build: c.bool(true), files_given: c.array([]), values: c.obj({}),
        inputs: c.array([{ name: "product", label: "Product", type: "knowledge", required: true }] as never),
        steps: c.array([{ name: "Copy", kind: "text", model: "gemini-3.8-flash", prompt: "{{input.product}}", file: "", settings: {}, options: {} }] as never) } }),
      s.expect.to_be_false({ expr: ref("empty.ok") }),
      is("empty.errors.0.message", "Product is required."),
    ],
  }),

  workflowTest({
    name: "recipes: a recipe's page knows its run count, its latest run, the reader's last inputs and what the newest finished run made",
    description: "Sam runs the tagline for Trail 2, then City 3; Jordan runs it for Fork 1; Priya hasn't run it. Only Sam's first run has finished, with one library item.",
    stack: [
      settings({ line: 5 * $ }), person("jordan", "admin"), person("sam"), ...prices,
      save("kit", "jordan", { name: "Tagline", inputs: [{ name: "product", label: "Product", type: "text", required: true }], steps: [
        { name: "Tagline", kind: "text", model: "gemini-3.8-flash", prompt: "A tagline for {{input.product}}.", file: "", settings: { use_brand: false }, options: {} },
      ] }),
      // Before any run: nothing to show, nothing to fill.
      s.function.run({ fn: viewRecipeFn, as: "fresh", input: { actor_id: ref("sam.id"), slug: c.text("tagline"), recipe_id: c.int(0) } }),
      num("fresh.history.runs", 0), equal("fresh.history.latest", c.null()), equal("fresh.history.made_run", c.null()),
      equal("fresh.history.last_inputs", c.array([])), num("fresh.history.last_inputs_by", 0), equal("fresh.history.made_ids", c.array([])),

      run("first", "sam", "kit", "k1", { product: "Trail 2" }),
      run("second", "sam", "kit", "k2", { product: "City 3" }),
      run("third", "jordan", "kit", "k3", { product: "Fork 1" }),
      // The first run finished and made one library item; the others are still going.
      s.db.patch({ table: ai_run, fieldValue: ref("first.run.id"), data: obj({ status: c.text("done") }) }),
      s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref("first.run.id")), returnType: "single", as: "first_step" }),
      s.db.add({ table: asset, as: "made", row: { kind: "text", title: "Trail 2 tagline", model: "gemini-3.8-flash", maker_id: ref("sam.id"), run_id: ref("first.run.id"),
        step_id: ref("first_step.id"), attempt: 1, private: false, status: "draft" } }),

      s.function.run({ fn: viewRecipeFn, as: "view", input: { actor_id: ref("sam.id"), slug: c.text("tagline"), recipe_id: c.int(0) } }),
      num("view.history.runs", 3),
      equal("view.history.latest.id", ref("third.run.id")),
      is("view.history.last_inputs.0.name", "product"), is("view.history.last_inputs.0.value", "City 3"), equal("view.history.last_inputs_by", ref("sam.id")),
      equal("view.history.made_run.id", ref("first.run.id")), is("view.history.made_run.status", "done"),
      equal("view.history.made_ids", withFilters(c.array([]), fl.array_push(ref("made.id")))),

      s.function.run({ fn: viewRecipeFn, as: "jordans", input: { actor_id: ref("jordan.id"), slug: c.text("tagline"), recipe_id: c.int(0) } }),
      is("jordans.history.last_inputs.0.value", "Fork 1"),
      // Someone who hasn't run it is offered the team's latest inputs, and told whose they were.
      person("priya"),
      s.function.run({ fn: viewRecipeFn, as: "priyas", input: { actor_id: ref("priya.id"), slug: c.text("tagline"), recipe_id: c.int(0) } }),
      is("priyas.history.last_inputs.0.value", "Fork 1"), equal("priyas.history.last_inputs_by", ref("jordan.id")),
    ],
  }),

  workflowTest({
    name: "recipes: the list says how often each recipe ran and when it last did, and leaves out one that never ran",
    description: "Sam runs the tagline twice and Jordan once, the last one a day after the others; nobody runs the alt text.",
    stack: [
      settings({ line: 5 * $ }), person("jordan", "admin"), person("sam"), ...prices,
      save("kit", "jordan", { name: "Tagline", inputs: [], steps: [
        { name: "Tagline", kind: "text", model: "gemini-3.8-flash", prompt: "A tagline for a gravel bike.", file: "", settings: { use_brand: false }, options: {} },
      ] }),
      save("alt", "jordan", { name: "Alt text", inputs: [], steps: [
        { name: "Alt text", kind: "text", model: "gemini-3.8-flash", prompt: "Alt text for a bike photo.", file: "", settings: { use_brand: false }, options: {} },
      ] }),
      run("first", "sam", "kit", "k1", {}),
      run("second", "sam", "kit", "k2", {}),
      run("third", "jordan", "kit", "k3", {}),
      // The first two ran yesterday; Jordan's is today's.
      s.set_var("yesterday", withFilters(c.now(), fl.sub(86_400_000))),
      s.db.patch({ table: ai_run, fieldValue: ref("first.run.id"), data: obj({ created_at: ref("yesterday") }) }),
      s.db.patch({ table: ai_run, fieldValue: ref("second.run.id"), data: obj({ created_at: ref("yesterday") }) }),
      s.db.get({ table: ai_run, fieldValue: ref("third.run.id"), output: ["created_at"], as: "latest" }),

      s.function.run({ fn: listRecipesFn, as: "list", input: { actor_id: ref("sam.id") } }),
      s.array.find({ expr: ref("list.usage"), as: "kit_use", if: cmp(ref("$this.recipe_id"), "=", ref("kit.id")) }),
      num("kit_use.runs", 3),
      equal("kit_use.last_run", ref("latest.created_at")),
      s.array.find({ expr: ref("list.usage"), as: "alt_use", if: cmp(ref("$this.recipe_id"), "=", ref("alt.id")) }),
      equal("alt_use", c.null()),
    ],
  }),
];
