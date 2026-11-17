// What every way of letting a run go ahead shares: reserve it for its owner, or record the refusal in words.
import { c, cmp, col, expr, fl, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { ai_run } from "../../table/studio/ai_run.js";
import { ai_step } from "../../table/studio/ai_step.js";
import { beginFn } from "../spend/begin.js";

/** What a screen or a caller reads back about a run. */
export const RUN_FIELDS = ["id", "owner_id", "connection_id", "kind", "via", "title", "status", "reason", "detail", "estimate", "spent", "private", "approval_id", "created_at", "finished_at"] as const;
/** Take a queued step's attempt, once: binds `as` to 1 for the request that took it and 0 for any other. */
export const takeStep = (step: Value, attempt: Value, as = "took") => s.db.increment({
  table: ai_step, where: [expr(col("id"), "=", step), expr(col("attempt"), "=", attempt), expr(col("claimed"), "=", c.int(0)), cmp(col("status"), "=", c.text("queued"))],
  fieldName: "claimed", value: c.int(1), returnType: "count", as,
});

export const readRun = (id: Value, as = "result") => s.db.get({ table: ai_run, fieldValue: id, output: [...RUN_FIELDS], as });

/** Mark every step of a run that hasn't ended, e.g. "skipped" when the run is refused before anything is reserved. */
export const endOpenSteps = (runId: Value, status: "skipped" | "released", reason: string) => [
  s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", runId), cmp(col("status"), "=", c.text("queued"))], output: ["id"], as: "_open_steps" }),
  s.foreach({ list: ref("_open_steps"), as: "_open", body: [
    s.db.patch({ table: ai_step, fieldValue: ref("_open.id"), data: obj({ status: c.text(status), reason: c.text(reason), finished_at: c.now() }) }),
  ] }),
];

/**
 * Reserve a run that may start now (`begin` for its owner), and record how it went: `queued`, or `refused` with the words.
 * `prefix` goes before a refusal's words ("Approved, but…"). Never throws for a budget that doesn't fit.
 */
export const reserveRun = (runId: Value, override: Value, prefix: Value = c.text("")) => [
  s.function.run({ fn: beginFn, as: "began", input: { run_id: runId, override } }),
  s.conditional({
    when: expr(ref("began.ok"), "=", c.bool(true)),
    then: [s.db.patch({ table: ai_run, fieldValue: runId, data: obj({ status: c.text("queued"), reason: c.text(""), detail: c.text("") }) })],
    else: [
      s.db.patch({ table: ai_run, fieldValue: runId, data: obj({ status: c.text("refused"), reason: c.text("over_budget"), detail: withFilters(prefix, fl.concat(ref("began.detail"))) }) }),
      ...endOpenSteps(runId, "skipped", "refused"),
    ],
  }),
];

