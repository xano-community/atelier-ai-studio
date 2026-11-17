// "Check again": after an admin adds credits or has AI switched on, one tiny embedding goes through the same gate as every
// other call. When it comes back, AI is on again. When the gateway refuses it, the refusal sets the status as any call's
// would, so the admin reads the current reason. It's a run of its own kind, so it never shows in anyone's history.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, ref, s, withFilters } from "@xano/sdk";
import { ai_step } from "../../table/studio/ai_step.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { KB_EMBED_MODEL } from "../knowledge/absorb.js";
import { goFn } from "../runs/background.js";
import { readRun } from "../runs/reserve.js";
import { startRunFn } from "../runs/start.js";
import { aiStatusFn } from "./ai_status.js";
import { settingsRow } from "../spend/begin.js";

/** The words embedded: short, so the check costs a few millionths of a dollar. */
export const CHECK_WORDS = "Is Xano AI answering?";

export const checkAiFn = defineFunction({
  name: "studio/check_ai",
  description: "Send one small embedding through the spend gate. When it comes back, set AI on; otherwise the refusal sets the status.",
  input: { actor_id: input.int({ required: true }), idem_key: input.text({ required: true }) },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("actor.role"), "team.manage", "Only admins check whether AI is back."),
    s.function.run({ fn: startRunFn, as: "started", input: {
      owner_id: inp("actor_id"), kind: c.text("check"), via: c.text("ui"), connection_id: c.int(0), idem_key: inp("idem_key"), recipe_id: c.int(0),
      title: c.text("Check that Xano AI answers"), private: c.bool(true), base_url: c.text(""), agent_label: c.text("Atelier"),
      steps: c.array([{ kind: "embedding", model: KB_EMBED_MODEL, input: { input: [CHECK_WORDS], task_type: "RETRIEVAL_QUERY" }, options: { input_tokens: 16, input_type: "text" } }]),
    } }),
    s.conditional({ when: expr(ref("started.outcome"), "=", c.text("created")), then: [
      s.function.run({ fn: goFn, as: "went", input: { run_id: ref("started.run.id"), inline: c.bool(true) } }),
    ] }),
    readRun(ref("started.run.id"), "run"),
    guard.found("run", { message: "The check couldn't start. Try again." }),
    s.set_var("ok", c.bool(false)),
    s.conditional({ when: expr(ref("run.status"), "=", c.text("done")), then: [
      s.function.run({ fn: aiStatusFn, as: "back_on", input: { status: c.text("on"), error: c.text(""), http_status: c.int(0) } }),
      s.update_var("ok", c.bool(true)),
    ] }),
    // A refusal before anything was sent is in the run's words; what the gateway said is in the step's.
    s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref("run.id")), output: ["detail"], returnType: "single", as: "step" }),
    s.set_var("detail", withFilters(ref("run.detail"), fl.first_notempty(ref("step.detail", { safe: true })), fl.first_notnull(c.text("")))),
    settingsRow("now"),
    guard.found("now", { message: "The workspace has no settings row." }),
  ],
  response: { ok: ref("ok"), run_status: ref("run.status"), detail: ref("detail"), ai_status: ref("now.ai_status"), ai_status_reason: ref("now.ai_status_reason") },
  responseShape: {} as { ok: boolean; run_status: string; detail: string; ai_status: string; ai_status_reason: string },
});
