// An admin changes a budget: Settings holds the default for each new month, and this month's rows move by the difference,
// so what's already reserved or spent stays put and only what's left changes. An increment, not a read and a write, so a
// reservation landing at the same moment isn't lost.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { workspace_setting } from "../../base/tables.js";
import { budget_month } from "../../table/studio/budget_month.js";
import { user } from "../../table/user.js";
import { rbac } from "../../rbac.js";
import { monthRowsFn, settingsRow, thisMonth } from "./begin.js";

const MOST = 1_000_000 * 1_000_000; // $1M: a typo guard, not a policy.

const shift = (scope: "team" | "person", by: string) => [
  s.db.increment({ table: budget_month, where: [cmp(col("scope"), "=", c.text(scope)), cmp(col("month"), "=", ref("month"))], fieldName: "budget", value: ref(by), returnType: "count", as: `${scope}_budget_moved` }),
  s.db.increment({ table: budget_month, where: [cmp(col("scope"), "=", c.text(scope)), cmp(col("month"), "=", ref("month"))], fieldName: "headroom", value: ref(by), returnType: "count", as: `${scope}_headroom_moved` }),
];
const amountInput = () => input.int({ description: "Micro-dollars. -1 leaves it as it is." });
const inRange = (name: string) => guard.require(
  [expr(inp(name), ">=", c.int(-1)), expr(inp(name), "<=", c.int(MOST))],
  { errorType: "badrequest", message: "A budget is between $0 and $1,000,000." },
);

/** Change the team budget, the per-person budget and the approval line. This month's rows follow the budget changes. */
export const setBudgetsFn = defineFunction({
  name: "spend/set_budgets",
  description: "Change the monthly budgets and the approval line (admins). This month's rows move by the difference.",
  input: { actor_id: input.int({ required: true }), team_budget: amountInput(), person_budget: amountInput(), approval_line: amountInput() },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("actor.role"), "budgets.manage", "Only admins change budgets."),
    inRange("team_budget"), inRange("person_budget"), inRange("approval_line"),
    settingsRow("first"),
    guard.found("first", { message: "The workspace has no settings row." }),
    ...thisMonth(),
    // Locked, so two admins saving at once each move the month rows by their own difference.
    s.db.transaction({ body: [
      s.db.get({ table: workspace_setting, fieldValue: ref("first.id"), lock: true, as: "settings" }),
      guard.found("settings", { message: "The workspace has no settings row." }),
      s.conditional({ when: expr(inp("team_budget"), ">=", c.int(0)), then: [
        s.set_var("team_delta", withFilters(inp("team_budget"), fl.sub(ref("settings.team_budget")))),
        ...shift("team", "team_delta"),
        s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ team_budget: inp("team_budget") }) }),
      ] }),
      s.conditional({ when: expr(inp("person_budget"), ">=", c.int(0)), then: [
        s.set_var("person_delta", withFilters(inp("person_budget"), fl.sub(ref("settings.person_budget")))),
        ...shift("person", "person_delta"),
        s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ person_budget: inp("person_budget") }) }),
      ] }),
      s.conditional({ when: expr(inp("approval_line"), ">=", c.int(0)), then: [
        s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ approval_line: inp("approval_line") }) }),
      ] }),
    ] }),
    settingsRow("now"),
    guard.found("now", { message: "The workspace has no settings row." }),
  ],
  response: { team_budget: ref("now.team_budget"), person_budget: ref("now.person_budget"), approval_line: ref("now.approval_line") },
});

/** Give one person a different budget for this month (an admin answering "Ask an admin"). */
export const setPersonBudgetFn = defineFunction({
  name: "spend/set_person_budget",
  description: "Set one person's budget for this month (admins). What's reserved and spent stays; what's left moves.",
  input: { actor_id: input.int({ required: true }), person_id: input.int({ required: true }), budget: input.int({ required: true }) },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("actor.role"), "budgets.manage", "Only admins change budgets."),
    guard.require([expr(inp("budget"), ">=", c.int(0)), expr(inp("budget"), "<=", c.int(MOST))], { errorType: "badrequest", message: "A budget is between $0 and $1,000,000." }),
    s.db.get({ table: user, fieldValue: inp("person_id"), output: ["id"], as: "person" }),
    guard.found("person", { message: "No such person." }),
    s.function.run({ fn: monthRowsFn, as: "rows", input: { owner_id: inp("person_id") } }),
    s.db.transaction({ body: [
      s.db.get({ table: budget_month, fieldValue: ref("rows.person.id"), lock: true, as: "locked" }),
      guard.found("locked", { message: "This month's budget couldn't be opened." }),
      s.set_var("delta", withFilters(inp("budget"), fl.sub(ref("locked.budget")))),
      s.db.increment({ table: budget_month, where: expr(col("id"), "=", ref("rows.person.id")), fieldName: "budget", value: ref("delta"), returnType: "count", as: "budget_moved" }),
      s.db.increment({ table: budget_month, where: expr(col("id"), "=", ref("rows.person.id")), fieldName: "headroom", value: ref("delta"), returnType: "count", as: "headroom_moved" }),
    ] }),
    s.db.get({ table: budget_month, fieldValue: ref("rows.person.id"), as: "row" }),
    guard.found("row", { message: "This month's budget couldn't be opened." }),
  ],
  response: ref("row"),
});
