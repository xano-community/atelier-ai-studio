// Every successful output that's something a person keeps (text, an image, a clip, audio, a transcript) becomes a draft
// library item with how it was made. One item per step attempt: the unique (step, attempt) index makes a repeat (a late
// result, a retried request) find the item that's already there.
import { c, cmp, col, cond, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { asset } from "../../table/library/asset.js";
import { ai_run } from "../../table/studio/ai_run.js";
import { ai_step } from "../../table/studio/ai_step.js";
import { studioChanged } from "../studio/changed.js";

/** Which library kind each step kind's output becomes. Embeddings and rankings are working data, not items. */
export const ASSET_KIND_OF: Record<string, string> = { text: "text", image: "image", video: "video", music: "music", speech: "speech", transcribe: "transcript" };
/** Runs whose outputs are working data: a knowledge upload's reading and an Ask's answer. */
const WORKING_RUNS = ["ask", "ingest"] as const;
/** What a step's input carries that is a file or the prompt itself, rather than a setting. */
const NOT_SETTINGS = ["prompt", "text", "system", "files", "images", "image", "audio", "documents", "query", "input", "sources", "file_sha", "from_asset", "library_picture"];

export const storeFn = defineFunction({
  name: "library/store",
  description: "Keep a step's successful output as a draft library item with its provenance. Answers the item's id, or 0.",
  input: { step_id: input.int({ required: true }), attempt: input.int({ required: true }) },
  stack: [
    s.db.get({ table: ai_step, fieldValue: inp("step_id"), as: "step" }),
    guard.found("step", { message: "No such step." }),
    s.set_var("asset_id", c.int(0)),
    s.set_var("kind", withFilters(c.obj(ASSET_KIND_OF), fl.get(ref("step.kind"), ""), fl.first_notnull(c.text("")))),
    // Reading a knowledge source and answering a question make working data, not something to keep in the library.
    s.db.get({ table: ai_run, fieldValue: ref("step.run_id"), output: ["kind"], as: "made_for" }),
    s.conditional({ when: cond.in(ref("made_for.kind", { safe: true }), c.array([...WORKING_RUNS])), then: [s.update_var("kind", c.text(""))] }),
    s.conditional({ when: [expr(ref("step.status"), "=", c.text("succeeded")), expr(ref("step.attempt"), "=", inp("attempt")), expr(ref("kind"), "!=", c.text(""))], then: [
      s.db.get({ table: ai_run, fieldValue: ref("step.run_id"), as: "run" }),
      guard.found("run", { message: "No such run." }),
      s.set_var("asked", withFilters(ref("step.input"), fl.first_notnull(c.obj({})))),
      s.set_var("made", withFilters(ref("step.output"), fl.first_notnull(c.obj({})))),
      s.set_var("prompt", withFilters(ref("asked"), fl.get("prompt", ""), fl.first_notempty(withFilters(ref("asked"), fl.get("text", ""))), fl.first_notnull(c.text("")), fl.to_text())),
      s.set_var("body", c.text("")),
      s.conditional({ when: expr(ref("step.kind"), "=", c.text("text")), then: [
        s.update_var("body", withFilters(ref("made"), fl.get("text", ""), fl.first_notnull(c.text("")), fl.to_text())),
      ] }),
      s.conditional({ when: expr(ref("step.kind"), "=", c.text("transcribe")), then: [
        s.update_var("body", withFilters(ref("made"), fl.get("text", ""), fl.first_notnull(c.text("")), fl.to_text())),
      ] }),
      s.set_var("settings", withFilters(ref("asked"), ...NOT_SETTINGS.map((key) => fl.unset(key)), fl.first_notnull(c.obj({})))),
      s.set_var("settings", withFilters(ref("step.options"), fl.first_notnull(c.obj({})), fl.set("request", ref("settings")))),
      s.set_var("inputs", obj({
        files: withFilters(ref("asked"), fl.get("sources", c.array([])), fl.first_notnull(c.array([]))),
        from_steps: withFilters(ref("step.depends_on"), fl.safe_array()),
        // The library item it was started from ("Use in a new run"), or 0.
        from_asset: withFilters(ref("asked"), fl.get("from_asset", 0), fl.first_notnull(c.int(0)), fl.to_int()),
      })),
      // A repeat usually finds its item here; two at once both miss it, and the unique index lets one insert through.
      s.db.query({ table: asset, where: [cmp(col("step_id"), "=", inp("step_id")), cmp(col("attempt"), "=", inp("attempt"))], output: ["id"], returnType: "single", as: "seen" }),
      s.update_var("asset_id", withFilters(ref("seen.id", { safe: true }), fl.first_notnull(c.int(0)))),
      s.conditional({ when: expr(ref("asset_id"), "=", c.int(0)), then: [s.try_catch({
        try: [s.db.add({ table: asset, as: "item", row: {
          kind: ref("kind"), title: ref("run.title"), prompt: ref("prompt"),
          sent_prompt: withFilters(ref("made"), fl.get("sent_prompt", ""), fl.first_notnull(c.text(""))),
          model: ref("step.model"), settings: ref("settings"), inputs: ref("inputs"),
          file: withFilters(ref("made"), fl.get("file", c.null())), body: ref("body"),
          maker_id: ref("run.owner_id"), estimated_cost: ref("step.charged"), brand_applied: ref("step.brand_applied"),
          run_id: ref("run.id"), step_id: ref("step.id"), attempt: inp("attempt"), private: ref("run.private"),
          status: c.text("draft"), approved_by: c.int(0), approved_at: c.null(), is_demo: c.bool(false),
        } }), s.update_var("asset_id", ref("item.id"))],
        catch: [],
      })] }),
      s.conditional({ when: expr(ref("asset_id"), "=", c.int(0)), then: [
        s.db.query({ table: asset, where: [cmp(col("step_id"), "=", inp("step_id")), cmp(col("attempt"), "=", inp("attempt"))], output: ["id"], returnType: "single", as: "existing" }),
        s.update_var("asset_id", withFilters(ref("existing.id", { safe: true }), fl.first_notnull(c.int(0)))),
      ] }),
      s.conditional({ when: expr(ref("asset_id"), ">", c.int(0)), then: [
        s.db.patch({ table: ai_step, fieldValue: inp("step_id"), data: obj({ asset_id: ref("asset_id") }) }),
        studioChanged({ entity: "asset", id: ref("asset_id"), owner: ref("run.owner_id"), private: ref("run.private"), op: "created" }),
      ] }),
    ] }),
  ],
  response: ref("asset_id"),
  responseShape: 0 as number,
});
