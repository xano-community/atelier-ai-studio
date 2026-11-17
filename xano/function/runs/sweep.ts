// Every minute, what nobody else will finish. Approvals past their date expire, and a run that waited on a declined or
// expired one ends `declined` (the approvals module has no hook for either). Money still held for a step that's past its
// time moves: a step that never reached the model is released, and one that did is charged as timed out, because the
// gateway bills it. A run interrupted before it got going ends with its reservations released.
import { c, cmp, col, defineFunction, expr, fl, guard, obj, or, ref, s, task, withFilters } from "@xano/sdk";
import { approvals } from "../../approvals.js";
import { notify } from "../../base/functions.js";
import { SWEEP_GRACE_SECONDS } from "../../prices.js";
import { ai_run } from "../../table/studio/ai_run.js";
import { ai_step } from "../../table/studio/ai_step.js";
import { ledger } from "../../table/studio/ledger.js";
import { user } from "../../table/user.js";
import { releaseFn } from "../spend/release.js";
import { settleFn } from "../spend/settle.js";
import { studioChanged } from "../studio/changed.js";
import { finishRunFn } from "./finish.js";
import { driveRunFn } from "./background.js";
import { endOpenSteps } from "./reserve.js";
import { storeFn } from "../library/store.js";
import { tidySourcesFn } from "../knowledge/settle.js";

/** How long after the deploy the demo's sample run ends, and what it says when it does. */
export const SAMPLE_SECONDS = 150;
export const SAMPLE_RUN_WORDS = "A sample run: this clip was made before the deploy, so no model was called and nothing was charged.";

/** A run still `starting` this long after it was asked for was interrupted before it could decide. */
export const STARTING_LIMIT_MS = 5 * 60_000;
const MOST_PER_SWEEP = 500;
/** A run whose steps haven't moved for this long, with none out, has lost its hand-on. */
const RESUME_AFTER_MS = 90_000;
/** Runs one sweep hands on. Each waits for its step's call, so the rest wait for the next minute. */
const MOST_RESUMES = 3;

/** Past its date, a request can't be decided. The module only refuses it, so the row is closed here. */
export const expireApprovalsFn = defineFunction({
  name: "runs/expire_approvals",
  description: "Close every pending approval past its expiry.",
  stack: [
    s.db.query({ table: approvals.approval, where: [cmp(col("status"), "=", c.text("pending")), expr(col("expires_at"), "<=", c.now())], output: ["id"], as: "lapsed" }),
    s.foreach({ list: ref("lapsed"), as: "row", body: [s.db.patch({ table: approvals.approval, fieldValue: ref("row.id"), data: obj({ status: c.text("expired") }) })] }),
  ],
  response: { expired: withFilters(ref("lapsed"), fl.count()) },
});

/** A run waiting on an approval that was declined or expired ends `declined`, with nothing charged. */
export const closeDecidedFn = defineFunction({
  name: "runs/close_decided",
  description: "End runs whose approval was declined or expired. Nothing was reserved for them, so nothing moves.",
  stack: [
    s.db.query({ table: ai_run, where: [cmp(col("status"), "=", c.text("waiting_approval")), expr(col("approval_id"), ">", c.int(0))], output: ["id", "owner_id", "private", "approval_id"], as: "waiting" }),
    s.set_var("closed", c.int(0)),
    s.foreach({ list: ref("waiting"), as: "run", body: [
      s.db.get({ table: approvals.approval, fieldValue: ref("run.approval_id"), output: ["status", "decided_by"], as: "asked" }),
      s.set_var("outcome", ref("asked.status", { safe: true })),
      s.conditional({ when: or(expr(ref("outcome"), "=", c.text("declined")), expr(ref("outcome"), "=", c.text("expired"))), then: [
        s.set_var("words", c.text("Nobody approved it within 7 days. Nothing was charged.")),
        s.conditional({ when: expr(ref("outcome"), "=", c.text("declined")), then: [
          guard.found("asked", { message: "No such approval." }),
          s.db.get({ table: user, fieldValue: ref("asked.decided_by"), output: ["name"], as: "decider" }),
          s.update_var("words", withFilters(c.text("Declined by "), fl.concat(withFilters(ref("decider.name", { safe: true }), fl.first_notempty(c.text("an admin")))), fl.concat(c.text(". Nothing was charged.")))),
        ] }),
        s.db.patch({ table: ai_run, fieldValue: ref("run.id"), data: obj({ status: c.text("declined"), reason: ref("outcome"), detail: ref("words"), finished_at: c.now() }) }),
        ...endOpenSteps(ref("run.id"), "skipped", "declined"),
        studioChanged({ entity: "ai_run", id: ref("run.id"), owner: ref("run.owner_id"), private: ref("run.private") }),
        s.db.get({ table: ai_run, fieldValue: ref("run.id"), output: ["title"], as: "closed_run" }),
        notify({ to: ref("run.owner_id"), kind: "approval", title: withFilters(ref("closed_run.title", { safe: true }), fl.first_notempty(c.text("Your run")), fl.concat(c.text(" wasn't approved"))),
          body: ref("words"), link: withFilters(c.text("/runs/"), fl.concat(ref("run.id"))), actor: withFilters(ref("asked.decided_by", { safe: true }), fl.first_notnull(c.int(0))) }),
        s.update_var("closed", withFilters(ref("closed"), fl.add(1))),
      ] }),
    ] }),
  ],
  response: { closed: ref("closed") },
});

/**
 * The demo's sample run (xano/world.ts) is a clip that was made before the deploy. A couple of minutes after the deploy its
 * working step ends with the clip it already carries: no model is called and nothing is reserved or charged, and the clip
 * becomes a library item as any made output does.
 */
export const finishSamplesFn = defineFunction({
  name: "runs/finish_samples",
  description: "End the demo's sample run with the output it carries: no model call, nothing charged.",
  stack: [
    s.set_var("sample_before", withFilters(c.now(), fl.sub(SAMPLE_SECONDS * 1000))),
    s.db.query({ table: ai_run, where: [cmp(col("sample"), "=", c.bool(true)), cmp(col("status"), "in", c.array(["queued", "running"])), expr(col("created_at"), "<", ref("sample_before"))],
      output: ["id", "owner_id", "private"], as: "samples" }),
    s.foreach({ list: ref("samples"), as: "sample", body: [
      s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", ref("sample.id")), cmp(col("status"), "in", c.array(["queued", "working"]))], output: ["id", "attempt", "input"], as: "sample_steps" }),
      s.foreach({ list: ref("sample_steps"), as: "made", body: [
        s.db.patch({ table: ai_step, fieldValue: ref("made.id"), data: obj({
          status: c.text("succeeded"), reason: c.text(""), detail: c.text(""), finished_at: c.now(), charged: c.int(0),
          output: withFilters(ref("made.input"), fl.get("sample_output", c.obj({})), fl.first_notnull(c.obj({}))),
        }) }),
        s.function.run({ fn: storeFn, as: "kept", input: { step_id: ref("made.id"), attempt: ref("made.attempt") } }),
      ] }),
      s.function.run({ fn: finishRunFn, as: "finished", input: { run_id: ref("sample.id") } }),
      s.db.patch({ table: ai_run, fieldValue: ref("sample.id"), data: obj({ detail: c.text(SAMPLE_RUN_WORDS) }) }),
      studioChanged({ entity: "ai_run", id: ref("sample.id"), owner: ref("sample.owner_id"), private: ref("sample.private") }),
    ] }),
  ],
  response: { finished: withFilters(ref("samples"), fl.count()) },
});

export const sweepFn = defineFunction({
  name: "runs/sweep",
  description: "Expire approvals, end declined runs, release or charge money held past a step's time, and end interrupted runs.",
  stack: [
    s.function.run({ fn: expireApprovalsFn, as: "expired" }),
    s.function.run({ fn: closeDecidedFn, as: "closed" }),
    s.function.run({ fn: finishSamplesFn, as: "samples" }),
    s.function.run({ fn: tidySourcesFn, as: "sources" }),
    s.set_var("released", c.int(0)),
    s.set_var("charged", c.int(0)),

    // Runs that never got past their decision: release whatever they hold, and end them.
    s.set_var("starting_before", withFilters(c.now(), fl.sub(STARTING_LIMIT_MS))),
    s.db.query({ table: ai_run, where: [cmp(col("status"), "=", c.text("starting")), expr(col("created_at"), "<", ref("starting_before"))], output: ["id", "owner_id", "private"], as: "stalled" }),
    s.foreach({ list: ref("stalled"), as: "run", body: [
      s.db.query({ table: ledger, where: [cmp(col("run_id"), "=", ref("run.id")), expr(col("held"), "=", c.int(1))], output: ["step_id", "attempt"], as: "stalled_held" }),
      s.foreach({ list: ref("stalled_held"), as: "entry", body: [
        s.function.run({ fn: releaseFn, as: "let_go", input: { step_id: ref("entry.step_id"), attempt: ref("entry.attempt"), reason: c.text("interrupted") } }),
        s.update_var("released", withFilters(ref("released"), fl.add(1))),
      ] }),
      s.db.patch({ table: ai_run, fieldValue: ref("run.id"), data: obj({ status: c.text("failed"), reason: c.text("interrupted"), finished_at: c.now(),
        detail: c.text("It stopped before it began, and nothing was charged. Try again.") }) }),
      ...endOpenSteps(ref("run.id"), "skipped", "interrupted"),
      studioChanged({ entity: "ai_run", id: ref("run.id"), owner: ref("run.owner_id"), private: ref("run.private") }),
    ] }),

    // Money still held: release it, charge it, or leave it with a step that's waiting its turn.
    s.db.query({ table: ledger, where: expr(col("held"), "=", c.int(1)), sort: [{ sortBy: "created_at", dir: "asc" }], paging: { per_page: MOST_PER_SWEEP, metadata: false }, as: "held" }),
    s.foreach({ list: ref("held"), as: "entry", body: [
      s.db.get({ table: ai_step, fieldValue: ref("entry.step_id"), as: "step" }),
      s.set_var("limit_ms", withFilters(ref("step.timeout_s", { safe: true }), fl.add(SWEEP_GRACE_SECONDS), fl.mul(1000))),
      s.set_var("act", c.text("")),
      s.conditional({
        when: expr(ref("step"), "=", c.null()),
        then: [s.update_var("act", c.text("release"))],
        elif: [
          // A retry moved on to a new attempt: this one's money is no longer needed.
          { when: expr(ref("step.attempt", { safe: true }), "!=", ref("entry.attempt")), then: [s.update_var("act", c.text("release"))] },
          { when: expr(ref("step.sent_at", { safe: true }), "!=", c.null()), then: [
            s.conditional({ when: expr(c.now(), ">", withFilters(ref("step.sent_at", { safe: true }), fl.add(ref("limit_ms")))), then: [s.update_var("act", c.text("charge"))] }),
          ] },
          { when: expr(ref("step.status", { safe: true }), "=", c.text("working")), then: [
            s.conditional({ when: expr(c.now(), ">", withFilters(ref("step.claimed_at", { safe: true }), fl.add(ref("limit_ms")))), then: [s.update_var("act", c.text("interrupted"))] }),
          ] },
          // Ended without reaching the model (skipped, failed before sending): nothing to charge.
          { when: expr(ref("step.status", { safe: true }), "!=", c.text("queued")), then: [s.update_var("act", c.text("release"))] },
        ],
      }),
      s.switch({ on: ref("act"), cases: [
        { when: c.text("release"), break: true, body: [
          s.function.run({ fn: releaseFn, as: "let_go", input: { step_id: ref("entry.step_id"), attempt: ref("entry.attempt"), reason: c.text("ended") } }),
          s.update_var("released", withFilters(ref("released"), fl.add(1))),
        ] },
        { when: c.text("interrupted"), break: true, body: [
          s.function.run({ fn: releaseFn, as: "let_go", input: { step_id: ref("entry.step_id"), attempt: ref("entry.attempt"), reason: c.text("interrupted") } }),
          s.db.patch({ table: ai_step, fieldValue: ref("entry.step_id"), data: obj({ status: c.text("failed"), reason: c.text("interrupted"), finished_at: c.now(),
            detail: c.text("It stopped before it reached the model, so nothing was charged. Retry it.") }) }),
          s.function.run({ fn: finishRunFn, as: "finished", input: { run_id: ref("entry.run_id") } }),
          s.update_var("released", withFilters(ref("released"), fl.add(1))),
        ] },
        { when: c.text("charge"), break: true, body: [
          s.function.run({ fn: settleFn, as: "billed", input: { step_id: ref("entry.step_id"), attempt: ref("entry.attempt"), outcome: c.text("timed_out"), usage: c.obj({}) } }),
          s.conditional({ when: expr(ref("step.status", { safe: true }), "=", c.text("working")), then: [
            s.set_var("timeout_words", withFilters(c.text("No answer came back within "), fl.concat(ref("step.timeout_s")),
              fl.concat(c.text(" seconds. The gateway still charges for a call it was sent, so it's counted.")))),
            s.db.patch({ table: ai_step, fieldValue: ref("entry.step_id"), data: obj({ status: c.text("timed_out"), reason: c.text("timeout"), finished_at: c.now(), detail: ref("timeout_words") }) }),
          ] }),
          s.function.run({ fn: finishRunFn, as: "finished", input: { run_id: ref("entry.run_id") } }),
          s.update_var("charged", withFilters(ref("charged"), fl.add(1))),
        ] },
      ] }),
    ] }),

    // Runs whose next step nobody handed on (the request that should have died first): hand it on again. A run with a
    // step out, or one that moved in the last 90 seconds, is still being handed on and is left alone.
    s.set_var("resumed", c.int(0)),
    s.set_var("quiet_since", withFilters(c.now(), fl.sub(RESUME_AFTER_MS))),
    s.db.query({ table: ai_run, where: [cmp(col("status"), "in", c.array(["queued", "running"])), expr(col("created_at"), "<", ref("quiet_since")), expr(col("base_url"), "!=", c.text(""))],
      sort: [{ sortBy: "created_at", dir: "asc" }], paging: { per_page: MOST_RESUMES, metadata: false }, output: ["id"], as: "waiting_runs" }),
    s.foreach({ list: ref("waiting_runs"), as: "run", body: [
      s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", ref("run.id")), cmp(col("status"), "=", c.text("working"))], returnType: "count", as: "out_now" }),
      s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", ref("run.id")), cmp(col("status"), "=", c.text("queued"))], returnType: "count", as: "to_go" }),
      s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", ref("run.id")), expr(col("finished_at"), ">", ref("quiet_since"))], returnType: "count", as: "moved_lately" }),
      s.conditional({ when: [expr(ref("out_now"), "=", c.int(0)), expr(ref("to_go"), ">", c.int(0)), expr(ref("moved_lately"), "=", c.int(0))], then: [
        s.function.run({ fn: driveRunFn, as: "driven", input: { run_id: ref("run.id") } }),
        s.update_var("resumed", withFilters(ref("resumed"), fl.add(1))),
      ] }),
    ] }),
  ],
  response: { expired: ref("expired.expired"), declined: ref("closed.closed"), samples: ref("samples.finished"), released: ref("released"), charged: ref("charged"), interrupted: withFilters(ref("stalled"), fl.count()), resumed: ref("resumed") },
});

export const sweepEveryMinute = task({
  name: "runs/sweep_every_minute",
  description: "Expire approvals, end declined runs, and release or charge money held past a step's time.",
  schedule: [{ startsOn: "2026-01-01 00:00:00+0000", freq: 60 }],
  stack: [s.function.run({ fn: sweepFn, as: "swept" })],
});
