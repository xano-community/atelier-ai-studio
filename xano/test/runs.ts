// Runs from start to end, with a stub in the model's seat: repeats, approvals and confirmations, the sweep, and how a
// run's state follows its steps. Approvals are decided through the approvals module's own decide function, as the app's
// Approve button does.
import { c, cmp, col, obj, ref, s, withFilters, fl } from "@xano/sdk";
import { approvals } from "../approvals.js";
import { ai_run } from "../table/studio/ai_run.js";
import { ai_step } from "../table/studio/ai_step.js";
import { budget_month } from "../table/studio/budget_month.js";
import { ledger } from "../table/studio/ledger.js";
import { setPersonBudgetFn } from "../function/spend/budgets.js";
import { askAdminFn, confirmRunFn } from "../function/runs/start.js";
import { stepResultFn } from "../function/runs/finish.js";
import { sweepFn } from "../function/runs/sweep.js";
import { aiStatusFn } from "../function/studio/ai_status.js";
import { clipStep, count, is, ledgerAgrees, monthRow, num, person, says, settings, start, testPrices, textStep, thisMonth, videoStep, workflowTest, plainTest } from "./fixtures.js";
import { sent, stepsOf } from "./spend.js";

const decide = (as: string, actor: string, run: string, decision: "approve" | "decline") =>
  s.function.run({ fn: approvals.decide, as, input: { actor_id: ref(`${actor}.id`), id: ref(`${run}.approval_id`), decision: c.text(decision), edited: c.text("") } });
const reload = (as: string, id: string) => s.db.get({ table: ai_run, fieldValue: ref(id), as });
const sweep = (as = "swept") => s.function.run({ fn: sweepFn, as });
const result = (as: string, step: string, outcome: string, output: Record<string, unknown> = {}, usage: Record<string, number> = {}) =>
  s.function.run({ fn: stepResultFn, as, input: { step_id: ref(`${step}.id`), attempt: c.int(1), outcome: c.text(outcome), output: c.obj(output as never), usage: c.obj(usage), detail: c.text("") } });

export const runTests = [
  plainTest({
    name: "runs: the same key returns the first run and reserves once; a different request under it is a conflict",
    stack: [
      settings(),
      person("sam"),
      ...testPrices,
      start("first", "sam", "click-1", [textStep()]),
      is("first.outcome", "created"),
      start("again", "sam", "click-1", [textStep()]),
      is("again.outcome", "existing"),
      s.expect.to_equal({ expr: ref("again.run.id"), value: ref("first.run.id") }),
      ...count("ledger_rows", ledger, 1),
      s.db.query({ table: ai_run, returnType: "count", as: "runs" }),
      num("runs", 1),
      start("other", "sam", "click-1", [textStep(5000, 5000)]),
      is("other.outcome", "conflict"),
      ...count("ledger_still", ledger, 1),
      // Keys are per person: someone else's click-1 is their own run.
      person("priya"),
      start("hers", "priya", "click-1", [textStep()]),
      is("hers.outcome", "created"),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "runs: a member's video waits for an admin with nothing held, and approval reserves against the member's budget",
    stack: [
      settings(),
      person("avery", "admin"),
      person("sam"),
      ...testPrices,
      start("r", "sam", "v1", [videoStep()]),
      is("r.run.status", "waiting_approval"),
      is("r.run.reason", "video"),
      says("r.run.detail", "Video runs by members wait for an admin"),
      ...count("no_ledger", ledger, 0),
      ...count("no_months", budget_month, 0),
      s.db.get({ table: approvals.approval, fieldValue: ref("r.run.approval_id"), as: "asked" }),
      is("asked.action", "costly_run"), is("asked.status", "pending"),
      s.expect.to_equal({ expr: ref("asked.user_id"), value: ref("sam.id") }),
      decide("decided", "avery", "r.run", "approve"),
      is("decided.status", "approved"),
      reload("run", "r.run.id"),
      is("run.status", "queued"),
      ...count("one_held", ledger, 1),
      thisMonth(),
      monthRow("sams", "person", ref("sam.id")),
      num("sams.reserved", 352_000),
      monthRow("averys", "person", ref("avery.id")),
      s.expect.to_be_null({ expr: ref("averys") }),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "runs: a declined request, and one nobody decides, end the run declined with no money moved",
    stack: [
      settings(),
      person("avery", "admin"),
      person("sam"),
      ...testPrices,
      start("declined", "sam", "v1", [videoStep()]),
      start("lapsed", "sam", "v2", [videoStep()]),
      decide("no", "avery", "declined.run", "decline"),
      s.db.patch({ table: approvals.approval, fieldValue: ref("lapsed.run.approval_id"), data: obj({ expires_at: c.int(1000) }) }),
      sweep(),
      num("swept.expired", 1),
      num("swept.declined", 2),
      reload("one", "declined.run.id"),
      is("one.status", "declined"), is("one.reason", "declined"), says("one.detail", "Declined by Test avery. Nothing was charged."),
      reload("two", "lapsed.run.id"),
      is("two.status", "declined"), is("two.reason", "expired"),
      ...count("no_ledger", ledger, 0),
      ...count("no_months", budget_month, 0),
    ],
  }),

  workflowTest({
    name: "runs: approving after the owner's budget was cut ends the run refused, saying why",
    stack: [
      settings(),
      person("avery", "admin"),
      person("sam"),
      ...testPrices,
      start("r", "sam", "v1", [videoStep()]),
      // $0.10 left for a $0.352 video.
      s.function.run({ fn: setPersonBudgetFn, as: "cut", input: { actor_id: ref("avery.id"), person_id: ref("sam.id"), budget: c.int(100_000) } }),
      decide("decided", "avery", "r.run", "approve"),
      is("decided.status", "approved"),
      reload("run", "r.run.id"),
      is("run.status", "refused"), is("run.reason", "over_budget"),
      says("run.detail", "Approved by Test avery, but the budget no longer fits."),
      says("run.detail", "you have $0.10 left of your $0.10 budget"),
      ...count("no_ledger", ledger, 0),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "runs: a run over the person's budget can go to an admin, who lets it past once",
    stack: [
      settings({ person: 1_000 }),
      person("avery", "admin"),
      person("sam"),
      ...testPrices,
      start("r", "sam", "k1", [textStep()]),
      is("r.run.status", "refused"),
      s.function.run({ fn: askAdminFn, as: "asked", input: { run_id: ref("r.run.id"), actor_id: ref("sam.id") } }),
      is("asked.status", "waiting_approval"),
      s.db.get({ table: approvals.approval, fieldValue: ref("asked.approval_id"), as: "request" }),
      is("request.action", "over_budget"),
      ...count("none_yet", ledger, 0),
      s.function.run({ fn: approvals.decide, as: "decided", input: { actor_id: ref("avery.id"), id: ref("asked.approval_id"), decision: c.text("approve"), edited: c.text("") } }),
      reload("run", "r.run.id"),
      is("run.status", "queued"),
      thisMonth(),
      monthRow("sams", "person", ref("sam.id")),
      num("sams.reserved", 3_300), num("sams.headroom", 1_000 - 3_300),
      ...count("held", ledger, 1),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "runs: an admin's own costly run waits for their click in the app, even when an agent started it",
    stack: [
      settings(),
      person("avery", "admin"),
      ...testPrices,
      // Ten clips: $0.66, over the $0.50 line.
      start("app", "avery", "k1", [clipStep(10)]),
      is("app.run.status", "needs_confirmation"),
      says("app.run.detail", "above the $0.50 approval line. Confirm it to start."),
      start("agent", "avery", "k2", [clipStep(10)], { via: "mcp" }),
      is("agent.run.status", "waiting_confirmation"),
      says("agent.run.detail", "confirm it in the app"),
      ...count("none_held", ledger, 0),
      s.expect.to_throw({ exception: c.text("Confirm this run in the app"), body: [
        s.db.query({ table: ai_run, where: cmp(col("idem_key"), "=", c.text("k2")), returnType: "single", as: "agent_run" }),
        s.function.run({ fn: confirmRunFn, as: "nope", input: { run_id: ref("agent_run.id"), actor_id: ref("agent_run.owner_id"), via: c.text("mcp") } }),
      ] }),
      s.function.run({ fn: confirmRunFn, as: "confirmed", input: { run_id: ref("agent.run.id"), actor_id: ref("avery.id"), via: c.text("ui") } }),
      is("confirmed.status", "queued"),
      ...count("one_held", ledger, 1),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "runs: the sweep charges a sent step past its time, and a late success is kept and charged once",
    description: "Sent 11 minutes ago with a 2-minute limit: charged as timed out. Then the result arrives: the output is kept, the step succeeded, and the ledger still shows one charge.",
    stack: [
      settings(),
      person("sam"),
      ...testPrices,
      start("r", "sam", "k1", [textStep()]),
      ...stepsOf("r", 1),
      sent("step1", 11),
      sweep(),
      num("swept.charged", 1),
      s.db.get({ table: ai_step, fieldValue: ref("step1.id"), as: "timed" }),
      is("timed.status", "timed_out"), is("timed.reason", "timeout"),
      s.db.query({ table: ledger, where: cmp(col("step_id"), "=", ref("step1.id")), returnType: "single", as: "entry" }),
      is("entry.state", "settled"), is("entry.reason", "timeout"), num("entry.amount", 3_300),
      reload("failed_run", "r.run.id"),
      is("failed_run.status", "failed"),
      result("late", "step1", "succeeded", { text: "Fresh ideas, every week." }, { input_tokens: 10, output_tokens: 10 }),
      s.expect.to_be_false({ expr: ref("late.charged_now") }),
      s.db.get({ table: ai_step, fieldValue: ref("step1.id"), as: "kept" }),
      is("kept.status", "succeeded"), is("kept.output.text", "Fresh ideas, every week."),
      s.db.query({ table: ledger, where: cmp(col("step_id"), "=", ref("step1.id")), returnType: "single", as: "still" }),
      num("still.amount", 3_300),
      thisMonth(),
      monthRow("team", "team", c.int(0)),
      num("team.spent", 3_300), num("team.reserved", 0),
      reload("done_run", "r.run.id"),
      is("done_run.status", "done"), num("done_run.spent", 3_300),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "runs: the sweep releases a step whose request died before it reached the model",
    stack: [
      settings(),
      person("sam"),
      ...testPrices,
      start("r", "sam", "k1", [textStep()]),
      ...stepsOf("r", 1),
      s.db.patch({ table: ai_step, fieldValue: ref("step1.id"), data: obj({ status: c.text("working"), claimed_at: withFilters(c.now(), fl.sub(11 * 60_000)) }) }),
      // A step still waiting its turn keeps its money.
      start("waiting", "sam", "k2", [textStep()]),
      sweep(),
      num("swept.released", 1),
      num("swept.charged", 0),
      s.db.get({ table: ai_step, fieldValue: ref("step1.id"), as: "after" }),
      is("after.status", "failed"), is("after.reason", "interrupted"),
      s.db.query({ table: ledger, where: cmp(col("step_id"), "=", ref("step1.id")), returnType: "single", as: "entry" }),
      is("entry.state", "released"), num("entry.amount", 0),
      reload("run", "r.run.id"),
      is("run.status", "failed"),
      thisMonth(),
      monthRow("team", "team", c.int(0)),
      num("team.reserved", 3_300), num("team.spent", 0),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "runs: a run's state follows its steps",
    description: "Running while a step is live, partial when one succeeds and one fails, and its spend is what the ledger charged.",
    stack: [
      settings(),
      person("sam"),
      ...testPrices,
      start("r", "sam", "k1", [textStep(), clipStep()]),
      ...stepsOf("r", 2),
      sent("step1"),
      result("one", "step1", "succeeded", { text: "Hello" }, { input_tokens: 1000, output_tokens: 1000 }),
      is("one.run_status", "running"),
      sent("step2"),
      result("two", "step2", "failed"),
      is("two.run_status", "partial"),
      reload("run", "r.run.id"),
      // $0.0033 for the text, and the clip's $0.066: a sent call that fails is still billed.
      num("run.spent", 69_300),
      s.expect.to_not_be_null({ expr: ref("run.finished_at") }),
      ...ledgerAgrees(),
    ],
  }),

  plainTest({
    name: "studio: a gateway refusal sets the AI status",
    stack: [
      settings(),
      s.function.run({ fn: aiStatusFn, as: "off", input: { status: c.text(""), error: c.text("Xano AI refused the request (HTTP 400): Xano AI is not available yet on this instance"), http_status: c.int(400) } }),
      is("off.ai_status", "disabled"),
      s.function.run({ fn: aiStatusFn, as: "broke", input: { status: c.text(""), error: c.text("Xano AI refused the request (HTTP 402)"), http_status: c.int(402) } }),
      is("broke.ai_status", "no_credits"),
      says("broke.ai_status_reason", "Check again"),
      s.function.run({ fn: aiStatusFn, as: "back", input: { status: c.text("on"), error: c.text(""), http_status: c.int(0) } }),
      is("back.ai_status", "on"),
      s.function.run({ fn: aiStatusFn, as: "exhausted", input: { status: c.text(""), error: c.text("credits_exhausted"), http_status: c.int(400) } }),
      is("exhausted.ai_status", "no_credits"),
      // One ordinary failure isn't an outage.
      s.function.run({ fn: aiStatusFn, as: "same", input: { status: c.text(""), error: c.text("Model returned 500"), http_status: c.int(500) } }),
      is("same.ai_status", "no_credits"),
    ],
  }),
];


