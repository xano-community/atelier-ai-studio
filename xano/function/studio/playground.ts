// A person's Playground history, and "Use this". Both take the person's id, so the route, the assistant and the tests
// share one rule: a Playground run belongs to its maker, and nobody else reads it or acts on it, whatever their role.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { asset } from "../../table/library/asset.js";
import { ai_run } from "../../table/studio/ai_run.js";
import { ai_step } from "../../table/studio/ai_step.js";
import { changed } from "../../base/functions.js";

export const HISTORY_PAGE = 25;
export const NO_SUCH_OUTPUT = "No such output.";
export const NOT_FINISHED_WORDS = "Only a finished output can go to the library. Run it again, then choose Use this.";

export const historyFn = defineFunction({
  name: "playground/history",
  description: `A person's own Playground runs, newest first, ${HISTORY_PAGE} a page, with each run's steps.`,
  input: { actor_id: input.int({ required: true }), page: input.int() },
  stack: [
    s.set_var("page", withFilters(inp("page"), fl.first_notnull(c.int(1)), fl.clamp_min(1))),
    s.db.query({ table: ai_run, where: [cmp(col("owner_id"), "=", inp("actor_id")), cmp(col("kind"), "=", c.text("playground"))],
      sort: [{ sortBy: "created_at", dir: "desc" }], paging: { page: ref("page"), per_page: HISTORY_PAGE, metadata: false },
      output: ["id", "idem_key", "title", "status", "reason", "estimate", "spent", "created_at", "finished_at"], as: "runs" }),
    s.array.map({ source: ref("runs"), as: "run_ids", transform: ref("$this.id") }),
    s.set_var("steps", c.array([])),
    s.conditional({ when: expr(withFilters(ref("run_ids"), fl.count()), ">", c.int(0)), then: [
      s.db.query({ table: ai_step, where: cmp(col("run_id"), "in", ref("run_ids")), sort: [{ sortBy: "seq", dir: "asc" }],
        paging: { per_page: 500, metadata: false }, output: ["id", "run_id", "seq", "kind", "model", "status", "usage", "charged", "estimate", "asset_id"], as: "found_steps" }),
      s.update_var("steps", ref("found_steps")),
    ] }),
  ],
  response: { runs: ref("runs"), steps: ref("steps"), more: withFilters(ref("runs"), fl.count(), fl.eq(c.int(HISTORY_PAGE))) },
});

/**
 * "Use this": a successful step's output is already a draft library item, private to its maker. This puts it in the
 * team's library, still a draft. Someone else's output answers as if it didn't exist.
 */
export const useOutputFn = defineFunction({
  name: "playground/use",
  description: "Put a Playground output in the team's library as a draft. Only its maker can; the run itself stays private.",
  input: { step_id: input.int({ required: true }), actor_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: ai_step, fieldValue: inp("step_id"), output: ["id", "run_id", "status", "asset_id"], as: "step" }),
    guard.found("step", { errorType: "notfound", message: NO_SUCH_OUTPUT }),
    s.db.get({ table: ai_run, fieldValue: ref("step.run_id"), output: ["id", "owner_id", "kind"], as: "run" }),
    guard.found("run", { errorType: "notfound", message: NO_SUCH_OUTPUT }),
    guard.require([expr(ref("run.owner_id"), "=", inp("actor_id")), expr(ref("run.kind"), "=", c.text("playground"))], { errorType: "notfound", message: NO_SUCH_OUTPUT }),
    guard.require([expr(ref("step.status"), "=", c.text("succeeded")), expr(ref("step.asset_id"), ">", c.int(0))], { errorType: "badrequest", message: NOT_FINISHED_WORDS }),
    s.db.patch({ table: asset, fieldValue: ref("step.asset_id"), data: obj({ private: c.bool(false) }), as: "kept" }),
    // Now the team's: every open Library hears of it, and the activity feed says who added what.
    changed({ entity: "asset", id: ref("step.asset_id"), op: "updated", verb: "added", actor: inp("actor_id"),
      title: withFilters(c.text("added "), fl.concat(withFilters(ref("kept.title"), fl.first_notempty(c.text("a Playground output")))), fl.concat(c.text(" to the Library"))),
      link: withFilters(c.text("/library/"), fl.concat(ref("step.asset_id"))) }),
  ],
  response: { asset_id: ref("step.asset_id") },
});
