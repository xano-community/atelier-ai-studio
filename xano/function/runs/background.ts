// Steps that run after the response. The request that starts a run hands it on with s.util.post_process; from there the
// driver calls the app itself, one step per call, at /api:studio-loop/steps/execute, signed in as the worker with a
// token that names the step and attempt and lasts two minutes. It waits for each call and then starts the next, so steps
// go one at a time in listed order.
//
// The loopback is waited on for 285 seconds; a video step may take up to its own limit (600 s). When the wait ends first
// for a step that's already sent, the step is left working: the call is still running there and finishes it, and only
// the step's own limit plus the sweep's minute of grace ever ends it as timed out. The sweep then hands on what's left.
// A call that fails before taking its step means this app didn't answer itself: that step fails, released, and the
// next is tried.
import { c, caught, cmp, col, cond, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { MOST_STEPS } from "./start.js";
import { ai_run } from "../../table/studio/ai_run.js";
import { ai_step } from "../../table/studio/ai_step.js";
import { STEP_WORKER, worker } from "../../table/studio/worker.js";
import { releaseFn } from "../spend/release.js";
import { executeStepFn, takeStep } from "./execute_step.js";
import { finishRunFn } from "./finish.js";

export const LOOP_GROUP = "studio-loop";
export const LOOP_PATH = "steps/execute";
/** How long the driver waits on one loopback call. Below the platform's request limit. */
export const LOOP_WAIT_SECONDS = 285;
/** How long a step's token is good for: only long enough to reach the loopback. */
export const STEP_TOKEN_SECONDS = 120;
/** Kinds quick enough to answer inside the request that asked, when a run is that one step. */
export const FAST_KINDS = ["text", "image", "speech", "transcribe", "embedding", "rerank"];
export const NO_ANSWER_WORDS = "It couldn't start, because this app didn't answer its own call. Nothing was charged. Retry it in a moment.";

/** Hand the next queued step of a run to the loopback, and keep going only past steps that couldn't be started. */
export const driveRunFn = defineFunction({
  name: "runs/drive",
  description: "Start a run's next queued step through the app's own loopback call, one step at a time, in listed order.",
  input: { run_id: input.int({ required: true }) },
  stack: [
    s.set_var("going", c.bool(true)),
    s.set_var("passes", c.int(0)),
    s.set_var("handed", c.int(0)),
    s.while({ when: [expr(ref("going"), "=", c.bool(true)), expr(ref("passes"), "<=", c.int(MOST_STEPS))], body: [
      s.update_var("passes", withFilters(ref("passes"), fl.add(1))),
      s.db.get({ table: ai_run, fieldValue: inp("run_id"), output: ["id", "status", "base_url"], as: "run" }),
      s.set_var("base", withFilters(ref("run.base_url", { safe: true }), fl.first_notnull(c.text("")))),
      s.conditional({
        when: [cond.in(ref("run.status", { safe: true }), c.array(["queued", "running"])), expr(ref("base"), "!=", c.text(""))],
        then: [
          s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", inp("run_id")), cmp(col("status"), "=", c.text("working"))], returnType: "count", as: "busy" }),
          s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", inp("run_id")), cmp(col("status"), "=", c.text("queued"))], sort: [{ sortBy: "seq", dir: "asc" }],
            paging: { per_page: 1, metadata: false }, output: ["id", "attempt"], as: "next_rows" }),
          s.set_var("next", withFilters(ref("next_rows"), fl.first())),
          s.conditional({
            // One step at a time: while one is out, it hands on the next itself.
            when: [expr(ref("busy"), "=", c.int(0)), expr(ref("next"), "!=", c.null())],
            then: [
              s.db.query({ table: worker, where: cmp(col("name"), "=", c.text(STEP_WORKER)), output: ["id"], returnType: "single", as: "me" }),
              s.conditional({ when: expr(ref("me"), "=", c.null()), then: [
                s.try_catch({ try: [s.db.add({ table: worker, as: "made_me", row: { name: c.text(STEP_WORKER) } })], catch: [] }),
                s.db.query({ table: worker, where: cmp(col("name"), "=", c.text(STEP_WORKER)), output: ["id"], returnType: "single", as: "me" }),
              ] }),
              guard.found("me", { message: "The background worker couldn't be set up." }),
              s.security.create_auth_token({ table: worker, id: ref("me.id"), extras: obj({ step_id: ref("next.id"), attempt: ref("next.attempt") }), expiration: c.int(STEP_TOKEN_SECONDS), as: "token" }),
              s.set_var("reached", c.int(0)),
              s.set_var("call_error", c.text("")),
              s.try_catch({
                try: [
                  s.api.request({ url: withFilters(ref("base"), fl.concat(c.text(`/api:${LOOP_GROUP}/${LOOP_PATH}`))), method: "POST", params: c.obj({}),
                    headers: { Authorization: withFilters(c.text("Bearer "), fl.concat(ref("token"))) }, timeout: c.int(LOOP_WAIT_SECONDS), as: "reply" }),
                  s.update_var("reached", withFilters(ref("reply.response.status", { safe: true }), fl.first_notnull(c.int(0)))),
                ],
                catch: [s.update_var("call_error", caught("message"))],
              }),
              s.update_var("handed", withFilters(ref("handed"), fl.add(1))),
              s.conditional({
                when: expr(ref("reached"), "=", c.int(200)),
                // It ran there. If the step is somehow still waiting its turn, stop rather than ask again.
                then: [
                  s.db.get({ table: ai_step, fieldValue: ref("next.id"), output: ["status", "attempt"], as: "after" }),
                  s.conditional({ when: [expr(ref("after.status", { safe: true }), "=", c.text("queued")), expr(ref("after.attempt", { safe: true }), "=", ref("next.attempt"))], then: [
                    s.update_var("going", c.bool(false)),
                  ] }),
                ],
                else: [
                  // Take the step back if the call never took it. If it did, it's running there: leave it.
                  takeStep(ref("next.id"), ref("next.attempt")),
                  s.conditional({
                    when: expr(ref("took"), "=", c.int(1)),
                    then: [
                      s.function.run({ fn: releaseFn, as: "let_go", input: { step_id: ref("next.id"), attempt: ref("next.attempt"), reason: c.text("interrupted") } }),
                      s.db.patch({ table: ai_step, fieldValue: ref("next.id"), data: obj({ status: c.text("failed"), reason: c.text("interrupted"), detail: c.text(NO_ANSWER_WORDS), finished_at: c.now() }) }),
                      s.function.run({ fn: finishRunFn, as: "moved", input: { run_id: inp("run_id") } }),
                    ],
                    else: [s.update_var("going", c.bool(false))],
                  }),
                ],
              }),
            ],
            else: [s.update_var("going", c.bool(false))],
          }),
        ],
        else: [s.update_var("going", c.bool(false))],
      }),
    ] }),
  ],
  response: { handed: ref("handed") },
});

/**
 * Let a reserved run go. With `inline` and a single fast step, run it here and now, inside the asking request. Anything
 * else (video, music, every run of several steps, and every run let go by someone else's request) goes to the
 * background after the response. A run with no address to call back on (a workflow test) waits for its caller.
 */
export const goFn = defineFunction({
  name: "runs/go",
  description: "Run a queued run: its one fast step inline, or everything else in the background after the response.",
  input: { run_id: input.int({ required: true }), inline: input.bool() },
  stack: [
    s.db.get({ table: ai_run, fieldValue: inp("run_id"), output: ["id", "status", "base_url"], as: "run" }),
    guard.found("run", { message: "No such run." }),
    s.set_var("mode", c.text("none")),
    s.conditional({ when: expr(ref("run.status"), "=", c.text("queued")), then: [
      s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", inp("run_id")), output: ["id", "kind", "attempt", "status"], as: "steps" }),
      s.set_var("only", withFilters(ref("steps"), fl.first())),
      s.conditional({
        when: [expr(inp("inline"), "=", c.bool(true)), expr(withFilters(ref("steps"), fl.count()), "=", c.int(1)), cond.in(ref("only.kind", { safe: true }), c.array(FAST_KINDS))],
        then: [
          s.function.run({ fn: executeStepFn, as: "ran", input: { step_id: ref("only.id"), attempt: ref("only.attempt") } }),
          s.update_var("mode", c.text("inline")),
        ],
        elif: [{ when: expr(withFilters(ref("run.base_url"), fl.first_notnull(c.text(""))), "!=", c.text("")), then: [
          s.util.post_process([s.function.run({ fn: driveRunFn, as: "driven", input: { run_id: inp("run_id") } })]),
          s.update_var("mode", c.text("background")),
        ] }],
      }),
    ] }),
  ],
  response: ref("mode"),
  responseShape: "" as "inline" | "background" | "none",
});
