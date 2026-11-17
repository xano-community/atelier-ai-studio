// Running one step. The actor is the run's owner, read from the run row, never from whoever's request this is. Before
// anything is spent the step is checked again: the owner is still here and still allowed to run AI, the key or agent
// connection that started it hasn't been revoked, the step is still queued at the same attempt, and any approval still
// stands. A step whose earlier steps it needs didn't succeed is skipped and its money released. Then the step is taken
// (a guarded update, so two requests can't both run it), marked sent, and only then handed to its kind's wrapper. The
// result is charged once, kept, and becomes a library item.
import { and, c, caught, cmp, col, cond, defineFunction, expr, fl, guard, inp, input, obj, or, ref, s, withFilters, type Value } from "@xano/sdk";
import { agent } from "../../agent.js";
import { approvals } from "../../approvals.js";
import { rbac } from "../../rbac.js";
import { ai_run } from "../../table/studio/ai_run.js";
import { ai_step, STEP_OUTCOMES } from "../../table/studio/ai_step.js";
import { user } from "../../table/user.js";
import { embeddingFn } from "../ai/embedding.js";
import { imageFn } from "../ai/image.js";
import { musicFn } from "../ai/music.js";
import { rerankFn } from "../ai/rerank.js";
import { speechFn } from "../ai/speech.js";
import { textFn } from "../ai/text.js";
import { transcribeFn } from "../ai/transcribe.js";
import { videoFn } from "../ai/video.js";
import { storeFn } from "../library/store.js";
import { releaseFn } from "../spend/release.js";
import { studioChanged } from "../studio/changed.js";
import { finishRunFn, stepResultFn } from "./finish.js";
import { takeStep } from "./reserve.js";
import { absorbStepFn } from "../knowledge/absorb.js";
import { fillStepFn } from "../recipes/plan.js";

/** Runs whose steps may still be taken. */
const LIVE_RUNS = ["queued", "running"];
export const SKIPPED_WORDS = "Skipped, because a step it needs didn't succeed. Nothing was charged for it.";
/** How a step it needed ended, in the words of "Skipped, because step 1 was blocked". */
const MISSED_WORDS = { blocked: "was blocked", failed: "failed", timed_out: "timed out", skipped: "was skipped", released: "didn't run" };
export const NOT_SENT_WORDS = "Stopped before it was sent. Nothing was charged for it.";
export const NOT_NEEDED_WORDS = "Not sent, because an earlier step showed it wasn't needed. Nothing was charged for it.";

export { takeStep };

/** Which permission each kind of run needs, as the roles that hold it. */
const ROLES_FOR = c.obj({
  playground: rbac.rolesWith("studio.run"), recipe: rbac.rolesWith("studio.run"), easel: rbac.rolesWith("studio.run"),
  ask: rbac.rolesWith("knowledge.ask"), ingest: rbac.rolesWith("knowledge.manage"), check: rbac.rolesWith("team.manage"),
});

/** Whether a run's owner may still spend on it: `{ ok, detail }`, with the reason in words when not. */
export const gateFn = defineFunction({
  name: "runs/gate",
  description: "Check a run's owner may still spend: still here, still allowed, their key not revoked, any approval still approved.",
  input: { run_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: ai_run, fieldValue: inp("run_id"), as: "run" }),
    guard.found("run", { message: "No such run." }),
    s.set_var("why", c.text("")),
    s.db.get({ table: user, fieldValue: ref("run.owner_id"), output: ["id", "name", "role"], as: "owner" }),
    s.set_var("roles", withFilters(ROLES_FOR, fl.get(ref("run.kind"), c.array([])), fl.safe_array())),
    s.conditional({
      when: expr(ref("owner"), "=", c.null()),
      then: [s.update_var("why", c.text("The person who started this run no longer has an account here, so it stopped before anything was sent. Nothing was charged."))],
      elif: [{ when: expr(withFilters(ref("roles"), fl.in(ref("owner.role", { safe: true }))), "=", c.bool(false)), then: [
        s.update_var("why", withFilters(ref("owner.name", { safe: true }), fl.concat(c.text("'s role can no longer run this, so it stopped before anything was sent. Nothing was charged.")))),
      ] }],
    }),
    s.conditional({ when: [expr(ref("why"), "=", c.text("")), expr(ref("run.connection_id"), ">", c.int(0))], then: [
      s.db.get({ table: agent.agent_connection, fieldValue: ref("run.connection_id"), output: ["id", "revoked", "expires_at"], as: "line" }),
      s.set_var("expires", withFilters(ref("line.expires_at", { safe: true }), fl.first_notnull(c.int(0)))),
      s.conditional({ when: or(expr(ref("line"), "=", c.null()), expr(ref("line.revoked", { safe: true }), "=", c.bool(true)), and(expr(ref("expires"), ">", c.int(0)), expr(ref("expires"), "<", c.now()))), then: [
        s.update_var("why", c.text("The key or agent connection that started this run was revoked or has expired, so it stopped before anything was sent. Nothing was charged.")),
      ] }),
    ] }),
    s.conditional({ when: [expr(ref("why"), "=", c.text("")), expr(ref("run.approval_id"), ">", c.int(0))], then: [
      s.db.get({ table: approvals.approval, fieldValue: ref("run.approval_id"), output: ["status"], as: "asked" }),
      s.conditional({ when: expr(ref("asked.status", { safe: true }), "!=", c.text("approved")), then: [
        s.update_var("why", c.text("This run's approval is no longer in place, so it stopped before anything was sent. Nothing was charged.")),
      ] }),
    ] }),
  ],
  response: { ok: c.expression('$var.why == ""'), detail: ref("why") },
  responseShape: {} as { ok: boolean; detail: string },
});

/**
 * Give back the money of every step of a run that hasn't been sent, taking each one first so a request about to run it
 * can't. A step already taken by a request is left to finish: it may be sent, and is charged if it is.
 */
export const releaseUnsentFn = defineFunction({
  name: "runs/release_unsent",
  description: "Release every queued step of a run that no request has taken, marking it released with the reason. Answers how many.",
  input: { run_id: input.int({ required: true }), reason: input.text({ required: true }), detail: input.text() },
  stack: [
    s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", inp("run_id")), cmp(col("status"), "=", c.text("queued"))], output: ["id", "attempt"], as: "open" }),
    s.set_var("released", c.int(0)),
    s.foreach({ list: ref("open"), as: "one", body: [
      takeStep(ref("one.id"), ref("one.attempt")),
      s.conditional({ when: expr(ref("took"), "=", c.int(1)), then: [
        s.function.run({ fn: releaseFn, as: "let_go", input: { step_id: ref("one.id"), attempt: ref("one.attempt"), reason: inp("reason") } }),
        s.db.patch({ table: ai_step, fieldValue: ref("one.id"), data: obj({ status: c.text("released"), reason: inp("reason"), detail: inp("detail"), finished_at: c.now() }) }),
        s.update_var("released", withFilters(ref("released"), fl.add(1))),
      ] }),
    ] }),
  ],
  response: ref("released"),
  responseShape: 0 as number,
});

/**
 * Everything before the model call. Answers `go` (true only when this request took the step and marked it sent) and a
 * `status`: sent, waiting (a step it needs is still running), skipped, refused (the run ends), or not_queued.
 */
export const claimStepFn = defineFunction({
  name: "runs/claim_step",
  description: "Re-check a step's run and owner, take the step, skip it if what it needs failed, and mark it sent.",
  input: { step_id: input.int({ required: true }), attempt: input.int({ required: true }) },
  stack: [
    s.db.get({ table: ai_step, fieldValue: inp("step_id"), as: "step" }),
    guard.found("step", { message: "No such step." }),
    s.db.get({ table: ai_run, fieldValue: ref("step.run_id"), as: "run" }),
    guard.found("run", { message: "No such run." }),
    s.set_var("status", c.text("not_queued")),
    s.set_var("go", c.bool(false)),
    s.conditional({ when: [
      expr(ref("step.status"), "=", c.text("queued")), expr(ref("step.attempt"), "=", inp("attempt")), expr(ref("step.claimed"), "=", c.int(0)),
      cond.in(ref("run.status"), c.array(LIVE_RUNS)),
    ], then: [
      // What it needs: earlier steps by their seq. An optional one (a rerank) that ended any way is enough.
      s.set_var("needs", withFilters(ref("step.depends_on"), fl.safe_array())),
      s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref("step.run_id")), output: ["seq", "status", "optional"], as: "siblings" }),
      s.array.filter({ expr: ref("siblings"), if: expr(withFilters(ref("needs"), fl.in(ref("$this.seq"))), "=", c.bool(true)), as: "needed" }),
      s.array.filter_count({ expr: ref("needed"), if: or(expr(ref("$this.status"), "=", c.text("queued")), expr(ref("$this.status"), "=", c.text("working"))), as: "still_running" }),
      s.array.filter_count({ expr: ref("needed"), as: "unmet", if: and(
        expr(ref("$this.status"), "!=", c.text("succeeded")), expr(ref("$this.status"), "!=", c.text("queued")), expr(ref("$this.status"), "!=", c.text("working")),
        expr(ref("$this.optional"), "!=", c.bool(true)),
      ) }),
      s.conditional({
        when: expr(ref("still_running"), ">", c.int(0)),
        then: [s.update_var("status", c.text("waiting"))],
        else: [
          s.function.run({ fn: gateFn, as: "gate", input: { run_id: ref("run.id") } }),
          s.conditional({
            when: expr(ref("gate.ok"), "=", c.bool(false)),
            then: [
              s.function.run({ fn: releaseUnsentFn, as: "let_go", input: { run_id: ref("run.id"), reason: c.text("refused"), detail: c.text("Not sent: the run was stopped before it. Nothing was charged for it.") } }),
              s.db.patch({ table: ai_run, fieldValue: ref("run.id"), data: obj({ status: c.text("refused"), reason: c.text("access"), detail: ref("gate.detail"), finished_at: c.now() }) }),
              s.function.run({ fn: finishRunFn, as: "finished", input: { run_id: ref("run.id") } }),
              studioChanged({ entity: "ai_run", id: ref("run.id"), owner: ref("run.owner_id"), private: ref("run.private") }),
              s.update_var("status", c.text("refused")),
            ],
            else: [
              takeStep(inp("step_id"), inp("attempt")),
              s.conditional({ when: expr(ref("took"), "=", c.int(1)), then: [
                s.conditional({
                  when: expr(ref("unmet"), ">", c.int(0)),
                  then: [
                    s.function.run({ fn: releaseFn, as: "let_go", input: { step_id: inp("step_id"), attempt: inp("attempt"), reason: c.text("skipped") } }),
                    // Name the step it needed and what happened to it: "Skipped, because step 1 was blocked."
                    s.array.find({ expr: ref("needed"), as: "missed", if: [cond.notIn(ref("$this.status"), c.array(["succeeded", "queued", "working"])), expr(ref("$this.optional"), "!=", c.bool(true))] }),
                    s.set_var("missed_name", withFilters(c.text("step "), fl.concat(ref("missed.seq", { safe: true })))),
                    s.set_var("missed_how", withFilters(c.obj(MISSED_WORDS), fl.get(withFilters(ref("missed.status", { safe: true }), fl.first_notnull(c.text(""))), "didn't succeed"))),
                    s.set_var("skip_words", c.text(SKIPPED_WORDS)),
                    s.conditional({ when: expr(ref("missed"), "!=", c.null()), then: [
                      s.update_var("skip_words", withFilters(c.text("Skipped, because "), fl.concat(ref("missed_name")), fl.concat(c.text(" ")), fl.concat(ref("missed_how")), fl.concat(c.text(". Nothing was charged for it.")))),
                    ] }),
                    s.db.patch({ table: ai_step, fieldValue: inp("step_id"), data: obj({ status: c.text("skipped"), reason: c.text("dependency"), detail: ref("skip_words"), finished_at: c.now() }) }),
                    s.update_var("status", c.text("skipped")),
                  ],
                  else: [
                    // A recipe step's words are finished from the earlier steps now that they've run. If they can't be,
                    // nothing is sent and its money goes back.
                    s.function.run({ fn: fillStepFn, as: "filled", input: { step_id: inp("step_id") } }),
                    s.conditional({
                      when: expr(ref("filled.ok"), "=", c.bool(true)),
                      // From here the call can be charged even if nobody hears back: committed before the gateway call.
                      then: [
                        s.db.patch({ table: ai_step, fieldValue: inp("step_id"), data: obj({ status: c.text("working"), claimed_at: c.now(), sent_at: c.now(), reason: c.text(""), detail: c.text("") }) }),
                        s.update_var("status", c.text("sent")),
                        s.update_var("go", c.bool(true)),
                      ],
                      else: [
                        s.function.run({ fn: releaseFn, as: "let_go", input: { step_id: inp("step_id"), attempt: inp("attempt"), reason: c.text("input") } }),
                        s.db.patch({ table: ai_step, fieldValue: inp("step_id"), data: obj({ status: c.text("failed"), reason: c.text("input"), detail: ref("filled.detail"), finished_at: c.now() }) }),
                        s.update_var("status", c.text("failed")),
                      ],
                    }),
                  ],
                }),
                s.function.run({ fn: finishRunFn, as: "moved", input: { run_id: ref("run.id") } }),
              ] }),
            ],
          }),
        ],
      }),
    ] }),
  ],
  response: { go: ref("go"), status: ref("status"), kind: ref("step.kind"), run_id: ref("step.run_id") },
  responseShape: {} as { go: boolean; status: "sent" | "waiting" | "skipped" | "failed" | "refused" | "not_queued"; kind: string; run_id: number },
});

/** After the model call: charge it once, keep what it made, make the library item, and move the run on. */
export const recordStepFn = defineFunction({
  name: "runs/record_step",
  description: "Record a wrapper's result on its step: charge it once, keep the output, make the draft library item, update the run.",
  input: {
    step_id: input.int({ required: true }), attempt: input.int({ required: true }),
    outcome: input.enum(STEP_OUTCOMES, { required: true }),
    reason: input.text(), detail: input.text(), refused: input.bool(),
    output: input.json(), usage: input.json(),
    brand_applied: input.bool(), sent_prompt: input.text(),
  },
  stack: [
    s.set_var("kept", withFilters(inp("output"), fl.first_notnull(c.obj({})))),
    s.set_var("sent_prompt", withFilters(inp("sent_prompt"), fl.first_notnull(c.text("")))),
    s.conditional({ when: expr(ref("sent_prompt"), "!=", c.text("")), then: [
      s.update_var("kept", withFilters(ref("kept"), fl.set("sent_prompt", ref("sent_prompt")))),
    ] }),
    s.db.get({ table: ai_step, fieldValue: inp("step_id"), output: ["id", "run_id", "attempt"], as: "step" }),
    guard.found("step", { message: "No such step." }),
    s.db.get({ table: ai_run, fieldValue: ref("step.run_id"), output: ["id", "owner_id", "private", "kind"], as: "run" }),
    guard.found("run", { message: "No such run." }),
    s.set_var("outcome", inp("outcome")),
    s.set_var("reason", inp("reason")),
    s.set_var("detail", inp("detail")),
    s.set_var("stop", c.bool(false)),
    // A knowledge upload keeps what each step made, as passages or their vectors, before the result moves the run on. When
    // that shows the source can't be added (a scan, a document too long to read in full) the step is recorded as failed
    // with the reason, and the steps not yet sent are released.
    s.conditional({ when: expr(ref("run.kind"), "=", c.text("ingest")), then: [
      s.function.run({ fn: absorbStepFn, as: "absorbed", input: { step_id: inp("step_id"), attempt: inp("attempt"), outcome: inp("outcome"), output: ref("kept") } }),
      s.conditional({ when: expr(ref("absorbed.stop"), "=", c.bool(true)), then: [
        s.update_var("outcome", c.text("failed")), s.update_var("reason", ref("absorbed.reason")), s.update_var("detail", ref("absorbed.detail")), s.update_var("stop", c.bool(true)),
      ] }),
    ] }),
    s.function.run({ fn: stepResultFn, as: "result", input: {
      step_id: inp("step_id"), attempt: inp("attempt"), outcome: ref("outcome"), output: ref("kept"), usage: inp("usage"),
      detail: ref("detail"), reason: ref("reason"), refused: inp("refused"),
    } }),
    s.conditional({ when: expr(ref("stop"), "=", c.bool(true)), then: [
      s.function.run({ fn: releaseUnsentFn, as: "let_go", input: { run_id: ref("run.id"), reason: c.text("stopped"), detail: c.text(NOT_NEEDED_WORDS) } }),
      s.function.run({ fn: finishRunFn, as: "ended", input: { run_id: ref("run.id") } }),
    ] }),
    s.conditional({ when: expr(ref("step.attempt"), "=", inp("attempt")), then: [
      s.db.patch({ table: ai_step, fieldValue: inp("step_id"), data: obj({ brand_applied: inp("brand_applied") }) }),
    ] }),
    s.function.run({ fn: storeFn, as: "asset_id", input: { step_id: inp("step_id"), attempt: inp("attempt") } }),
    studioChanged({ entity: "ai_step", id: inp("step_id"), owner: ref("run.owner_id"), private: ref("run.private") }),
  ],
  response: { charged_now: ref("result.charged_now"), amount: ref("result.amount"), run_status: ref("result.run_status"), asset_id: ref("asset_id") },
});

const FAILED_WRAPPER = "Something went wrong running this step. It was sent, so it may be charged. Try again.";

/** Run one step from start to end: claim it, call its kind's wrapper, record the result. */
export const executeStepFn = defineFunction({
  name: "runs/execute_step",
  description: "Run one queued step: re-check, take and mark it sent, call its model through the wrapper, then charge and keep the result.",
  input: { step_id: input.int({ required: true }), attempt: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: claimStepFn, as: "claim", input: { step_id: inp("step_id"), attempt: inp("attempt") } }),
    s.set_var("outcome", c.text("")),
    s.conditional({ when: expr(ref("claim.go"), "=", c.bool(true)), then: [
      s.set_var("result", c.null()),
      s.try_catch({
        try: [
          s.switch({ on: ref("claim.kind"), cases: ([
            ["text", textFn], ["image", imageFn], ["video", videoFn], ["music", musicFn], ["speech", speechFn],
            ["transcribe", transcribeFn], ["embedding", embeddingFn], ["rerank", rerankFn],
          ] as const).map(([kind, fn]) => ({ when: c.text(kind), break: true, body: [
            s.function.run({ fn, as: `called_${kind}`, input: { step_id: inp("step_id") } }),
            s.update_var("result", ref(`called_${kind}`)),
          ] })) }),
        ],
        catch: [
          // A guard inside the wrapper refused before the model was called: nothing was billed.
          s.set_var("thrown", withFilters(caught("code"), fl.first_notnull(c.text("")), fl.to_text())),
          s.set_var("thrown_words", caught("message")),
          s.update_var("result", obj({ outcome: c.text("failed"), reason: c.text("model_error"), detail: c.text(FAILED_WRAPPER),
            refused: withFilters(ref("thrown"), fl.starts_with(c.text("ERROR_CODE_"))), output: obj({ error: ref("thrown_words") }), usage: c.obj({}), brand_applied: c.bool(false), sent_prompt: c.text("") })),
        ],
      }),
      s.conditional({ when: expr(ref("result"), "=", c.null()), then: [
        s.update_var("result", obj({ outcome: c.text("failed"), reason: c.text("model_error"), detail: c.text(FAILED_WRAPPER), refused: c.bool(true), output: c.obj({}), usage: c.obj({}), brand_applied: c.bool(false), sent_prompt: c.text("") })),
      ] }),
      s.function.run({ fn: recordStepFn, as: "recorded", input: {
        step_id: inp("step_id"), attempt: inp("attempt"), outcome: ref("result.outcome"), reason: ref("result.reason"), detail: ref("result.detail"),
        refused: ref("result.refused"), output: ref("result.output"), usage: ref("result.usage"), brand_applied: ref("result.brand_applied"), sent_prompt: ref("result.sent_prompt"),
      } }),
      s.update_var("outcome", ref("result.outcome")),
    ] }),
  ],
  response: { status: ref("claim.status"), outcome: ref("outcome"), run_id: ref("claim.run_id") },
  responseShape: {} as { status: string; outcome: string; run_id: number },
});
