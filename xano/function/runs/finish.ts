// How a run ends is read from its steps: running while any step is live, done when every step it needs succeeded, partial
// when some did and some didn't, failed when none did. A step's result charges it (once) and is kept, even when it
// arrives after the sweep gave up on it.
import { and, c, cmp, col, cond, defineFunction, expr, fl, guard, inp, input, obj, or, qf, ref, s, withFilters } from "@xano/sdk";
import { changed, notify } from "../../base/functions.js";
import { ai_run } from "../../table/studio/ai_run.js";
import { ai_step, STEP_OUTCOMES } from "../../table/studio/ai_step.js";
import { ledger } from "../../table/studio/ledger.js";
import { settleFn } from "../spend/settle.js";
import { settleSourceFn } from "../knowledge/settle.js";
import { studioChanged } from "../studio/changed.js";

/** Runs whose state isn't read from their steps: still deciding, or ended by a decision. */
const NOT_DERIVED = ["starting", "waiting_approval", "needs_confirmation", "waiting_confirmation", "refused", "declined", "stopped"];
const isOne = (status: string) => expr(ref("$this.status"), "=", c.text(status));
const tally = (as: string, when: Parameters<typeof s.array.filter_count>[0]["if"]) => s.array.filter_count({ expr: ref("steps"), if: when, as });

export const finishRunFn = defineFunction({
  name: "runs/finish",
  description: "Set a run's state and spend from its steps and its ledger. Says so on the activity feed when a team-visible run ends.",
  input: { run_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: ai_run, fieldValue: inp("run_id"), as: "run" }),
    guard.found("run", { message: "No such run." }),
    s.set_var("next", ref("run.status")),
    s.conditional({ when: cond.notIn(ref("run.status"), c.array(NOT_DERIVED)), then: [
      s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", inp("run_id")), output: ["status", "optional"], as: "steps" }),
      tally("live", or(isOne("queued"), isOne("working"))),
      tally("started", expr(ref("$this.status"), "!=", c.text("queued"))),
      tally("good", isOne("succeeded")),
      tally("bad", and(expr(ref("$this.optional"), "!=", c.bool(true)), or(isOne("blocked"), isOne("failed"), isOne("timed_out")))),
      s.conditional({
        when: expr(ref("live"), ">", c.int(0)),
        then: [s.update_var("next", c.text("queued")), s.conditional({ when: expr(ref("started"), ">", c.int(0)), then: [s.update_var("next", c.text("running"))] })],
        elif: [
          { when: [expr(ref("good"), ">", c.int(0)), expr(ref("bad"), "=", c.int(0))], then: [s.update_var("next", c.text("done"))] },
          { when: expr(ref("good"), ">", c.int(0)), then: [s.update_var("next", c.text("partial"))] },
        ],
        else: [s.update_var("next", c.text("failed"))],
      }),
      s.db.query({ table: ledger, as: "charged_rows", returnType: "aggregate",
        where: [cmp(col("run_id"), "=", inp("run_id")), cmp(col("state"), "=", c.text("settled"))],
        aggregate: { group: [{ name: "run_id", as: "run_id" }], eval: [{ name: "amount", as: "total", filters: [qf.sum()] }] } }),
      s.set_var("spent", withFilters(ref("charged_rows"), fl.first(), fl.get("total", 0), fl.first_notnull(0), fl.to_int())),
      s.set_var("ended", c.expression('$var.next == "done" || $var.next == "partial" || $var.next == "failed"')),
      s.set_var("finished_at", ref("run.finished_at")),
      s.conditional({ when: [expr(ref("ended"), "=", c.bool(true)), expr(ref("run.finished_at"), "=", c.null())], then: [s.update_var("finished_at", c.now())] }),
      s.db.patch({ table: ai_run, fieldValue: inp("run_id"), data: obj({ status: ref("next"), spent: ref("spent"), finished_at: ref("finished_at") }) }),
      // A team-visible run that just ended gets one line on the activity feed.
      s.conditional({ when: [expr(ref("ended"), "=", c.bool(true)), expr(ref("run.status"), "!=", ref("next")), expr(ref("run.private"), "!=", c.bool(true))], then: [
        s.set_var("said", withFilters(c.text("made "), fl.concat(ref("run.title")))),
        s.conditional({ when: expr(ref("next"), "=", c.text("partial")), then: [s.update_var("said", withFilters(c.text("finished "), fl.concat(ref("run.title")), fl.concat(c.text(", with some steps failed"))))] }),
        s.conditional({ when: expr(ref("next"), "=", c.text("failed")), then: [s.update_var("said", withFilters(c.text("couldn't finish "), fl.concat(ref("run.title"))))] }),
        changed({ entity: "ai_run", id: inp("run_id"), op: "updated", verb: "ran", title: ref("said"), actor: ref("run.owner_id"),
          link: withFilters(c.text("/runs/"), fl.concat(inp("run_id"))) }),
        // A recipe runs in the background, so its owner may have left the page: the bell says how it ended.
        s.conditional({ when: expr(ref("run.kind"), "=", c.text("recipe")), then: [
          s.set_var("rang", withFilters(ref("run.title"), fl.concat(c.text(" finished")))),
          s.conditional({ when: expr(ref("next"), "=", c.text("partial")), then: [
            s.set_var("steps_word", c.text(" steps failed")),
            s.conditional({ when: expr(ref("bad"), "=", c.int(1)), then: [s.update_var("steps_word", c.text(" step failed"))] }),
            s.update_var("rang", withFilters(ref("rang"), fl.concat(c.text(", ")), fl.concat(ref("bad")), fl.concat(ref("steps_word")))),
          ] }),
          s.conditional({ when: expr(ref("next"), "=", c.text("failed")), then: [s.update_var("rang", withFilters(ref("run.title"), fl.concat(c.text(" couldn't finish"))))] }),
          notify({ to: ref("run.owner_id"), kind: "run", title: ref("rang"), link: withFilters(c.text("/runs/"), fl.concat(inp("run_id"))), actor: c.int(0) }),
        ] }),
      ] }),
      studioChanged({ entity: "ai_run", id: inp("run_id"), owner: ref("run.owner_id"), private: ref("run.private") }),
    ],
    // A stopped run's sent step still finishes and is charged: its spend keeps up.
    else: [
      s.db.query({ table: ledger, as: "kept_rows", returnType: "aggregate",
        where: [cmp(col("run_id"), "=", inp("run_id")), cmp(col("state"), "=", c.text("settled"))],
        aggregate: { group: [{ name: "run_id", as: "run_id" }], eval: [{ name: "amount", as: "total", filters: [qf.sum()] }] } }),
      s.set_var("kept_spent", withFilters(ref("kept_rows"), fl.first(), fl.get("total", 0), fl.first_notnull(0), fl.to_int())),
      s.conditional({ when: expr(ref("kept_spent"), "!=", ref("run.spent")), then: [
        s.db.patch({ table: ai_run, fieldValue: inp("run_id"), data: obj({ spent: ref("kept_spent") }) }),
        studioChanged({ entity: "ai_run", id: inp("run_id"), owner: ref("run.owner_id"), private: ref("run.private") }),
      ] }),
    ] }),
    // A knowledge upload's source follows its run: ready or failed once the run has ended.
    s.conditional({ when: expr(ref("run.kind"), "=", c.text("ingest")), then: [
      s.function.run({ fn: settleSourceFn, as: "source_settled", input: { run_id: inp("run_id") } }),
    ] }),
  ],
  response: { status: ref("next") },
});

/**
 * A model call came back: charge it (once), keep what it made, and move the run on. A success that arrives after the sweep
 * timed the step out is kept and the step counts as succeeded, but it isn't charged again.
 */
export const stepResultFn = defineFunction({
  name: "runs/step_result",
  description: "Record a model call's outcome on its step, charge it once, and update the run.",
  input: {
    step_id: input.int({ required: true }), attempt: input.int({ required: true }),
    outcome: input.enum(STEP_OUTCOMES, { required: true }),
    output: input.json(), usage: input.json(),
    /** Plain words for the person when it didn't succeed. */
    detail: input.text(),
    /** A finer reason than the outcome gives ("unavailable", "no_credits", "bad_json"). Empty: read from the outcome. */
    reason: input.text(),
    /** The gateway refused it before doing any work, so it isn't charged. */
    refused: input.bool(),
  },
  stack: [
    s.db.get({ table: ai_step, fieldValue: inp("step_id"), as: "step" }),
    guard.found("step", { message: "No such step." }),
    s.function.run({ fn: settleFn, as: "settled", input: { step_id: inp("step_id"), attempt: inp("attempt"), outcome: inp("outcome"), usage: inp("usage"), refused: inp("refused") } }),
    s.set_var("reason", c.text("")),
    s.switch({ on: inp("outcome"), cases: [
      { when: c.text("blocked"), break: true, body: [s.update_var("reason", c.text("blocked"))] },
      { when: c.text("failed"), break: true, body: [s.update_var("reason", c.text("model_error"))] },
      { when: c.text("timed_out"), break: true, body: [s.update_var("reason", c.text("timeout"))] },
    ] }),
    s.conditional({ when: expr(withFilters(inp("reason"), fl.first_notnull(c.text(""))), "!=", c.text("")), then: [s.update_var("reason", inp("reason"))] }),
    s.conditional({ when: expr(ref("step.attempt"), "=", inp("attempt")), then: [
      s.conditional({
        when: or(expr(ref("step.status"), "=", c.text("queued")), expr(ref("step.status"), "=", c.text("working"))),
        then: [s.db.patch({ table: ai_step, fieldValue: inp("step_id"), data: obj({ status: inp("outcome"), reason: ref("reason"), detail: inp("detail"), output: inp("output"), usage: inp("usage"), finished_at: c.now() }) })],
        elif: [{
          when: [expr(ref("step.status"), "=", c.text("timed_out")), expr(inp("outcome"), "=", c.text("succeeded"))],
          then: [s.db.patch({ table: ai_step, fieldValue: inp("step_id"), data: obj({ status: c.text("succeeded"), reason: c.text(""), output: inp("output"), usage: inp("usage"),
            detail: c.text("It arrived after the time limit, and it's kept. It was charged once.") }) })],
        }],
      }),
    ] }),
    s.function.run({ fn: finishRunFn, as: "finished", input: { run_id: ref("step.run_id") } }),
  ],
  response: { charged_now: ref("settled.moved"), amount: ref("settled.amount"), run_status: ref("finished.status") },
});
