// The Playground's rules: a model the catalog doesn't offer never starts a run, a person's Playground history is theirs
// alone, and "Use this" acts only on your own output. Steps are recorded with the real functions and a stub in the
// model's seat, as in steps.ts.
import { c, cmp, col, fl, ref, s, withFilters } from "@xano/sdk";
import { asset } from "../table/library/asset.js";
import { ai_run } from "../table/studio/ai_run.js";
import { ai_step } from "../table/studio/ai_step.js";
import { user } from "../table/user.js";
import { claimStepFn, recordStepFn } from "../function/runs/execute_step.js";
import { viewRunFn } from "../function/runs/control.js";
import { startRunFn } from "../function/runs/start.js";
import { checkModelsFn } from "../function/studio/catalog.js";
import { historyFn, useOutputFn } from "../function/studio/playground.js";
import { equal, person, plainTest, settings, start, testPrices, textStep, workflowTest } from "./fixtures.js";
import { stepsOf } from "./spend.js";

const counts = (path: string, n: number) => s.expect.to_equal({ expr: withFilters(ref(path), fl.count()), value: c.int(n) });
const check = (as: string, steps: Record<string, unknown>[]) => s.function.run({ fn: checkModelsFn, as, input: { steps: c.array(steps as never) } });
/** A private Playground run, as the app starts one. */
const privateRun = (as: string, owner: string, key: string) => s.function.run({ fn: startRunFn, as, input: {
  owner_id: ref(`${owner}.id`), kind: c.text("playground"), via: c.text("ui"), connection_id: c.int(0), idem_key: c.text(key), recipe_id: c.int(0),
  title: c.text("Tagline"), private: c.bool(true), base_url: c.text(""), agent_label: c.text("Test"), steps: c.array([textStep()] as never),
} });
const history = (as: string, actor: string) => s.function.run({ fn: historyFn, as, input: { actor_id: ref(`${actor}.id`), page: c.int(1) } });
/** Claim step1 and record what a text wrapper would have answered: it succeeds, and its output becomes a draft item. */
const succeed = (step: string) => [
  s.function.run({ fn: claimStepFn, as: "claimed", input: { step_id: ref(`${step}.id`), attempt: c.int(1) } }),
  s.function.run({ fn: recordStepFn, as: "recorded", input: {
    step_id: ref(`${step}.id`), attempt: c.int(1), outcome: c.text("succeeded"), reason: c.text(""), detail: c.text(""), refused: c.bool(false),
    output: c.obj({ text: "Ride further." }), usage: c.obj({ input_tokens: 1000, output_tokens: 1000 }), brand_applied: c.bool(false), sent_prompt: c.text("Write a tagline"),
  } }),
];

export const playgroundTests = [
  plainTest({
    name: "playground: a model the catalog doesn't offer for that kind, or doesn't serve, is refused",
    stack: [
      check("fine", [{ kind: "text", model: "gemini-3.8-flash" }, { kind: "image", model: "gemini-3.1-flash-image" }, { kind: "video", model: "veo-3.1-fast-generate-001" }]),
      s.expect.to_be_true({ expr: ref("fine.ok") }),
      s.expect.to_throw({ exception: c.text("isn't a model Xano AI offers"), body: [check("made_up", [{ kind: "text", model: "gpt-imaginary" }])] }),
      // A real model, asked for as the wrong kind of step.
      s.expect.to_throw({ exception: c.text("isn't a model Xano AI offers"), body: [check("wrong_kind", [{ kind: "image", model: "gemini-3.8-flash" }])] }),
      // Listed by the catalog, but the gateway answers 404 for it.
      s.expect.to_throw({ exception: c.text("isn't served yet"), body: [check("unserved", [{ kind: "text", model: "claude-haiku-5-5" }])] }),
      // One bad step refuses the whole list.
      s.expect.to_throw({ exception: c.text("gpt-imaginary"), body: [check("mixed", [{ kind: "text", model: "gemini-3.8-flash" }, { kind: "text", model: "gpt-imaginary" }])] }),
    ],
  }),

  plainTest({
    name: "playground: history lists only your own Playground runs, whatever the reader's role",
    stack: [
      settings(), person("sam"), person("priya"), person("avery", "admin"), ...testPrices,
      privateRun("sams", "sam", "click-1"),
      privateRun("priyas", "priya", "click-1"),
      // A recipe run isn't Playground history.
      start("recipe", "sam", "recipe-1", [textStep()], { kind: "recipe" }),
      history("sam_sees", "sam"),
      counts("sam_sees.runs", 1),
      equal("sam_sees.runs.0.id", ref("sams.run.id")),
      equal("sam_sees.steps.0.run_id", ref("sams.run.id")),
      s.expect.to_equal({ expr: ref("sam_sees.steps.0.model"), value: c.text("test-text") }),
      history("priya_sees", "priya"),
      counts("priya_sees.runs", 1),
      equal("priya_sees.runs.0.id", ref("priyas.run.id")),
      // An admin's history is their own too: nobody's Playground shows up in it.
      history("avery_sees", "avery"),
      counts("avery_sees.runs", 0),
      counts("avery_sees.steps", 0),
    ],
  }),

  workflowTest({
    name: "playground: another member asking for a private Playground run gets the same answer as for no run at all",
    stack: [
      settings(), person("sam"), person("priya"), ...testPrices,
      privateRun("sams", "sam", "click-1"),
      s.expect.to_throw({ exception: c.text("No such run."), body: [
        s.db.query({ table: ai_run, where: cmp(col("idem_key"), "=", c.text("click-1")), returnType: "single", as: "run" }),
        s.db.query({ table: user, where: cmp(col("email"), "=", c.text("priya@studio-test.example")), returnType: "single", as: "other" }),
        s.function.run({ fn: viewRunFn, as: "theirs", input: { run_id: ref("run.id"), actor_id: ref("other.id") } }),
      ] }),
      s.expect.to_throw({ exception: c.text("No such run."), body: [
        s.db.query({ table: user, where: cmp(col("email"), "=", c.text("priya@studio-test.example")), returnType: "single", as: "other" }),
        s.function.run({ fn: viewRunFn, as: "none", input: { run_id: c.int(987_654), actor_id: ref("other.id") } }),
      ] }),
    ],
  }),

  workflowTest({
    name: "playground: Use this puts your own output in the team's library as a draft; someone else's isn't found",
    stack: [
      settings(), person("sam"), person("priya"), ...testPrices,
      privateRun("sams", "sam", "click-1"),
      ...stepsOf("sams", 1),
      // Not finished yet: there's nothing to keep.
      s.expect.to_throw({ exception: c.text("Only a finished output"), body: [
        s.db.query({ table: ai_run, where: cmp(col("idem_key"), "=", c.text("click-1")), returnType: "single", as: "run" }),
        s.db.query({ table: user, where: cmp(col("email"), "=", c.text("sam@studio-test.example")), returnType: "single", as: "maker" }),
        s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref("run.id")), returnType: "single", as: "step" }),
        s.function.run({ fn: useOutputFn, as: "early", input: { step_id: ref("step.id"), actor_id: ref("maker.id") } }),
      ] }),
      ...succeed("step1"),
      s.db.query({ table: asset, returnType: "single", as: "item" }),
      s.expect.to_be_true({ expr: ref("item.private") }),
      s.expect.to_equal({ expr: ref("item.status"), value: c.text("draft") }),
      s.expect.to_throw({ exception: c.text("No such output."), body: [
        s.db.query({ table: ai_run, where: cmp(col("idem_key"), "=", c.text("click-1")), returnType: "single", as: "run" }),
        s.db.query({ table: user, where: cmp(col("email"), "=", c.text("priya@studio-test.example")), returnType: "single", as: "other" }),
        s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref("run.id")), returnType: "single", as: "step" }),
        s.function.run({ fn: useOutputFn, as: "stolen", input: { step_id: ref("step.id"), actor_id: ref("other.id") } }),
      ] }),
      s.db.get({ table: asset, fieldValue: ref("item.id"), as: "still" }),
      s.expect.to_be_true({ expr: ref("still.private") }),
      s.function.run({ fn: useOutputFn, as: "used", input: { step_id: ref("step1.id"), actor_id: ref("sam.id") } }),
      equal("used.asset_id", ref("item.id")),
      s.db.get({ table: asset, fieldValue: ref("item.id"), as: "kept" }),
      s.expect.to_be_false({ expr: ref("kept.private") }),
      s.expect.to_equal({ expr: ref("kept.status"), value: c.text("draft") }),
      // The run itself stays private: the library item is what the team sees.
      s.db.get({ table: ai_run, fieldValue: ref("sams.run.id"), as: "run_after" }),
      s.expect.to_be_true({ expr: ref("run_after.private") }),
    ],
  }),
];
