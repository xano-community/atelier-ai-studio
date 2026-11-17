// my_usage: what the person has spent on AI this month, what's held for runs under way, what's left of their budget, and
// the approval line, read from the same month rows the spend gate keeps. Admins also see the team's. Easel's own turns are
// counted apart: the deployer's model provider bills them, so they never come out of a budget. Reads only: a month with no
// row yet is reported from the budgets set under Usage.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, ref, s, withFilters } from "@xano/sdk";
import { rbac } from "../../rbac.js";
import { budget_month } from "../../table/studio/budget_month.js";
import { easel_turn } from "../../table/studio/easel_turn.js";
import { user } from "../../table/user.js";
import { settingsRow, thisMonth } from "../spend/begin.js";
import { dollars } from "../spend/estimate.js";
import { actorInputs } from "./tooling.js";

type Money = { budget: string; spent: string; held: string; left: string };
export type ToolUsage = { month: string; mine: Money; team: Money | null; approval_line: string; easel_turns: number; easel_tokens: { input: number; output: number }; easel_note: string };

/** A month row's budget, spent, held and left in words, bound to `<as>`, from a row or the Settings budget when it has none. */
const money = (as: string, row: string, fallbackBudget: string) => [
  s.set_var(`${as}_budget`, withFilters(ref(`${row}.budget`, { safe: true }), fl.first_notnull(ref(fallbackBudget)))),
  s.set_var(`${as}_spent`, withFilters(ref(`${row}.spent`, { safe: true }), fl.first_notnull(c.int(0)))),
  s.set_var(`${as}_held`, withFilters(ref(`${row}.reserved`, { safe: true }), fl.first_notnull(c.int(0)))),
  dollars(`${as}_budget_words`, ref(`${as}_budget`)),
  dollars(`${as}_spent_words`, ref(`${as}_spent`)),
  dollars(`${as}_held_words`, ref(`${as}_held`)),
  dollars(`${as}_left_words`, withFilters(ref(`${as}_budget`), fl.sub(ref(`${as}_spent`)), fl.sub(ref(`${as}_held`)))),
  s.set_var(as, withFilters(c.obj({}), fl.set("budget", ref(`${as}_budget_words`)), fl.set("spent", ref(`${as}_spent_words`)), fl.set("held", ref(`${as}_held_words`)), fl.set("left", ref(`${as}_left_words`)))),
];

export const myUsageToolFn = defineFunction({
  name: "studio/my_usage",
  description: "The person's AI spend this month against their budget, the approval line, and Easel's provider-billed turns.",
  input: { ...actorInputs },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    ...thisMonth(),
    settingsRow("settings"),
    s.set_var("person_default", withFilters(ref("settings.person_budget", { safe: true }), fl.first_notnull(c.int(0)))),
    s.set_var("team_default", withFilters(ref("settings.team_budget", { safe: true }), fl.first_notnull(c.int(0)))),
    s.db.query({ table: budget_month, where: [cmp(col("scope"), "=", c.text("person")), cmp(col("subject_id"), "=", inp("actor_id")), cmp(col("month"), "=", ref("month"))], returnType: "single", as: "person_row" }),
    ...money("mine", "person_row", "person_default"),
    s.set_var("team", c.null()),
    s.conditional({ when: expr(withFilters(c.array(rbac.rolesWith("usage.read")), fl.in(ref("actor.role"))), "=", c.bool(true)), then: [
      s.db.query({ table: budget_month, where: [cmp(col("scope"), "=", c.text("team")), cmp(col("subject_id"), "=", c.int(0)), cmp(col("month"), "=", ref("month"))], returnType: "single", as: "team_row" }),
      ...money("team_money", "team_row", "team_default"),
      s.update_var("team", ref("team_money")),
    ] }),
    dollars("line_words", withFilters(ref("settings.approval_line", { safe: true }), fl.first_notnull(c.int(0)))),
    s.set_var("month_start", withFilters(ref("month"), fl.concat(c.text("-01 00:00:00")), fl.to_epochms(c.text("UTC")))),
    s.db.query({ table: easel_turn, where: [cmp(col("user_id"), "=", inp("actor_id")), expr(col("created_at"), ">=", ref("month_start"))],
      output: ["input_tokens", "output_tokens"], paging: { per_page: 10000, metadata: false }, as: "turns" }),
    s.array.map({ source: ref("turns"), as: "turn_in", transform: ref("$this.input_tokens") }),
    s.array.map({ source: ref("turns"), as: "turn_out", transform: ref("$this.output_tokens") }),
  ],
  response: {
    month: ref("month_words"), mine: ref("mine"), team: ref("team"), approval_line: ref("line_words"), easel_turns: withFilters(ref("turns"), fl.count()),
    easel_tokens: withFilters(c.obj({}), fl.set("input", withFilters(ref("turn_in"), fl.sum())), fl.set("output", withFilters(ref("turn_out"), fl.sum()))),
    easel_note: c.text("Easel's own replies are billed by the model provider this app is set up with, not Xano credits, so they don't count against a budget."),
  },
  responseShape: {} as ToolUsage,
});
