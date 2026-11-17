// What an admin's approval does to a waiting run. Approval reserves for the run's owner, never the approver, and against
// the owner's budget as it stands now: a budget cut since the request can still refuse it, and the run says so. Only the
// over-budget approval may go past a budget. These run inside the approvals module's decision, so they never throw for a
// budget that doesn't fit: the decision is recorded and the run carries the outcome. A run approved here is queued, and
// the minute sweep starts it: the approvals module's routes keep request history, so they never mint the worker's token.
import { c, defineFunction, expr, fl, guard, inp, input, ref, s, withFilters } from "@xano/sdk";
import { notify } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { ai_run } from "../../table/studio/ai_run.js";
import { user } from "../../table/user.js";
import { studioChanged } from "../studio/changed.js";
import { readRun, reserveRun } from "./reserve.js";

const approved = (name: string, description: string, override: boolean) => defineFunction({
  name,
  description,
  input: { run_id: input.int({ required: true }), actor_id: input.int({ required: true }), requester_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "name", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("actor.role"), "budgets.manage", "Only admins approve runs that wait for one."),
    s.db.get({ table: ai_run, fieldValue: inp("run_id"), as: "run" }),
    guard.found("run", { message: "That run no longer exists." }),
    guard.require(expr(ref("run.owner_id"), "=", inp("requester_id")), { errorType: "badrequest", message: "That run belongs to someone else." }),
    guard.require(expr(ref("run.status"), "=", c.text("waiting_approval")), { errorType: "badrequest", message: "That run isn't waiting for an approval any more." }),
    ...reserveRun(inp("run_id"), c.bool(override), withFilters(c.text("Approved by "), fl.concat(ref("actor.name")), fl.concat(c.text(", but the budget no longer fits. ")))),
    studioChanged({ entity: "ai_run", id: inp("run_id"), owner: ref("run.owner_id"), private: ref("run.private") }),
    readRun(inp("run_id")),
    guard.found("result", { message: "That run no longer exists." }),
    // Whoever asked hears the decision: approved and on its way, or approved but refused by the budget.
    s.set_var("heard", withFilters(ref("actor.name"), fl.concat(c.text(" approved ")), fl.concat(ref("run.title")))),
    s.conditional({ when: expr(ref("result.status"), "=", c.text("refused")), then: [
      s.update_var("heard", withFilters(ref("heard"), fl.concat(c.text(", but the budget no longer fits")))),
    ] }),
    notify({ to: ref("run.owner_id"), kind: "approval", title: ref("heard"), body: ref("result.detail"), link: withFilters(c.text("/runs/"), fl.concat(inp("run_id"))), actor: inp("actor_id") }),
  ],
  response: { run_id: inp("run_id"), status: ref("result.status"), detail: ref("result.detail") },
});

/** A member's run above the approval line, or any video by a member. */
export const approveCostlyRun = approved("runs/approve_costly", "Approved costly run: reserve it for its owner within their budget, or refuse it in words.", false);

/** A run its owner's budget refused, approved once past the budget. */
export const approveOverBudget = approved("runs/approve_over_budget", "Approved over budget: reserve it for its owner past their budget, this once.", true);
