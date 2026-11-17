// Reserve before any model call. Each budget's month row keeps `headroom` (budget − reserved − spent), and a reservation
// takes the run's estimate from it in one guarded update that changes the row only while the headroom covers it. The
// database re-checks that guard under the row's lock, so two requests at once can't both fit into the same last dollar.
// The team row goes first, then the person's (settle keeps that order too). When the person's row refuses, the team's
// change is put back in the same transaction.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, ref, s, withFilters, type Value } from "@xano/sdk";
import { workspace_setting } from "../../base/tables.js";
import { budget_month } from "../../table/studio/budget_month.js";
import { ledger } from "../../table/studio/ledger.js";
import { ai_run } from "../../table/studio/ai_run.js";
import { ai_step } from "../../table/studio/ai_step.js";
import { dollars } from "./estimate.js";

/** The workspace's one settings row, bound to `as`. */
export const settingsRow = (as = "settings") =>
  s.db.query({ table: workspace_setting, sort: [{ sortBy: "id", dir: "asc" }], returnType: "single", as });

/** "2026-11" and "November 2026": the UTC month, as stored and as said. */
export const thisMonth = () => [
  s.set_var("month", withFilters(c.now(), fl.epochms_date("Y-m", "UTC"))),
  s.set_var("month_words", withFilters(c.now(), fl.epochms_date("F Y", "UTC"))),
] as const;

const monthRow = (as: string, scope: "team" | "person", subject: Value) => s.db.query({ table: budget_month, as, returnType: "single",
  where: [cmp(col("scope"), "=", c.text(scope)), cmp(col("subject_id"), "=", subject), cmp(col("month"), "=", ref("month"))] });

/**
 * This month's team row and this person's row, made when missing with the budgets set under Usage. Made outside any transaction
 * of its own: when two first requests of a month race, one insert wins and the other's duplicate is caught, and both then
 * read the one row.
 */
export const monthRowsFn = defineFunction({
  name: "spend/month_rows",
  description: "This month's team and person budget rows, created from the Settings budgets when missing.",
  input: { owner_id: input.int({ required: true }) },
  stack: [
    ...thisMonth(),
    monthRow("team", "team", c.int(0)),
    monthRow("person", "person", inp("owner_id")),
    s.conditional({ when: [expr(ref("team"), "=", c.null())], then: [
      settingsRow("settings"),
      s.try_catch({ try: [s.db.add({ table: budget_month, as: "made_team", row: {
        scope: c.text("team"), subject_id: c.int(0), month: ref("month"), budget: ref("settings.team_budget", { safe: true }),
        reserved: c.int(0), spent: c.int(0), headroom: ref("settings.team_budget", { safe: true }),
      } })], catch: [] }),
      monthRow("team", "team", c.int(0)),
    ] }),
    s.conditional({ when: [expr(ref("person"), "=", c.null())], then: [
      settingsRow("settings"),
      s.try_catch({ try: [s.db.add({ table: budget_month, as: "made_person", row: {
        scope: c.text("person"), subject_id: inp("owner_id"), month: ref("month"), budget: ref("settings.person_budget", { safe: true }),
        reserved: c.int(0), spent: c.int(0), headroom: ref("settings.person_budget", { safe: true }),
      } })], catch: [] }),
      monthRow("person", "person", inp("owner_id")),
    ] }),
    guard.found("team", { message: "This month's team budget couldn't be opened." }),
    guard.found("person", { message: "This month's budget couldn't be opened." }),
  ],
  response: { team: ref("team"), person: ref("person"), month: ref("month"), month_words: ref("month_words") },
});

/** Add `by` to a month row's column. */
export const bump = (rowId: Value, field: "reserved" | "spent" | "headroom" | "budget", by: Value) =>
  s.db.increment({ table: budget_month, where: expr(col("id"), "=", rowId), fieldName: field, value: by, returnType: "count", as: `_bumped_${field}` });

/** Take `total` from a month row's headroom only if it covers it, binding `as` to 1 (taken) or 0 (it didn't fit). */
const take = (rowId: Value, total: Value, as: string) =>
  s.db.increment({ table: budget_month, where: [expr(col("id"), "=", rowId), expr(col("headroom"), ">=", total)], fieldName: "headroom", value: withFilters(total, fl.mul(-1)), returnType: "count", as });

/**
 * Reserve every queued step of a run against its owner's month rows. With `override` (an admin approved it over budget)
 * the guard is skipped. Answers `ok`, or `refused` ("team" or "person") with plain words naming the month.
 */
export const beginFn = defineFunction({
  name: "spend/begin",
  description: "Reserve a run's estimate against this month's team and person budgets, one ledger row per step, or refuse in words.",
  input: { run_id: input.int({ required: true }), override: input.bool() },
  stack: [
    s.db.get({ table: ai_run, fieldValue: inp("run_id"), as: "run" }),
    guard.found("run", { message: "No such run." }),
    s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", inp("run_id")), cmp(col("status"), "=", c.text("queued"))], sort: [{ sortBy: "seq", dir: "asc" }], as: "steps" }),
    s.array.map({ source: ref("steps"), as: "amounts", transform: ref("$this.estimate") }),
    s.set_var("total", withFilters(ref("amounts"), fl.sum(), fl.to_int())),
    s.function.run({ fn: monthRowsFn, as: "rows", input: { owner_id: ref("run.owner_id") } }),
    s.set_var("team_id", ref("rows.team.id")),
    s.set_var("person_id", ref("rows.person.id")),
    s.set_var("ok", c.bool(false)),
    s.set_var("refused", c.text("")),
    s.set_var("negative", withFilters(ref("total"), fl.mul(-1))),
    s.db.transaction({ body: [
      s.conditional({
        when: expr(inp("override"), "=", c.bool(true)),
        then: [
          bump(ref("team_id"), "headroom", ref("negative")), bump(ref("team_id"), "reserved", ref("total")),
          bump(ref("person_id"), "headroom", ref("negative")), bump(ref("person_id"), "reserved", ref("total")),
          s.update_var("ok", c.bool(true)),
        ],
        else: [
          take(ref("team_id"), ref("total"), "team_taken"),
          s.conditional({
            when: expr(ref("team_taken"), "=", c.int(1)),
            then: [
              bump(ref("team_id"), "reserved", ref("total")),
              take(ref("person_id"), ref("total"), "person_taken"),
              s.conditional({
                when: expr(ref("person_taken"), "=", c.int(1)),
                then: [bump(ref("person_id"), "reserved", ref("total")), s.update_var("ok", c.bool(true))],
                // The person's budget doesn't fit: give the team its headroom back before the transaction ends.
                else: [bump(ref("team_id"), "headroom", ref("total")), bump(ref("team_id"), "reserved", ref("negative")), s.update_var("refused", c.text("person"))],
              }),
            ],
            else: [s.update_var("refused", c.text("team"))],
          }),
        ],
      }),
      s.conditional({ when: expr(ref("ok"), "=", c.bool(true)), then: [
        s.foreach({ list: ref("steps"), as: "step", body: [
          s.db.add({ table: ledger, as: "held_row", row: {
            step_id: ref("step.id"), attempt: ref("step.attempt"), run_id: inp("run_id"), owner_id: ref("run.owner_id"),
            team_month_id: ref("team_id"), person_month_id: ref("person_id"), state: c.text("reserved"), held: c.int(1),
            estimate: ref("step.estimate"), amount: c.int(0), kind: ref("step.kind"), model: ref("step.model"),
            via: ref("run.via"), connection_id: ref("run.connection_id"), reason: c.text(""),
          } }),
        ] }),
      ] }),
    ] }),
    s.set_var("detail", c.text("")),
    s.conditional({ when: expr(ref("ok"), "=", c.bool(false)), then: [
      dollars("cost_words", ref("total")),
      s.conditional({
        when: expr(ref("refused"), "=", c.text("team")),
        then: [
          s.db.get({ table: budget_month, fieldValue: ref("team_id"), as: "short" }),
          dollars("left_words", ref("short.headroom", { safe: true })),
          dollars("budget_words", ref("short.budget", { safe: true })),
          s.update_var("detail", withFilters(c.text("This run is estimated at "), fl.concat(ref("cost_words")), fl.concat(c.text(". The team has ")), fl.concat(ref("left_words")),
            fl.concat(c.text(" left of its ")), fl.concat(ref("budget_words")), fl.concat(c.text(" budget for ")), fl.concat(ref("rows.month_words")), fl.concat(c.text(". An admin can raise it under Usage.")))),
        ],
        else: [
          s.db.get({ table: budget_month, fieldValue: ref("person_id"), as: "short" }),
          dollars("left_words", ref("short.headroom", { safe: true })),
          dollars("budget_words", ref("short.budget", { safe: true })),
          s.update_var("detail", withFilters(c.text("This run is estimated at "), fl.concat(ref("cost_words")), fl.concat(c.text(", and you have ")), fl.concat(ref("left_words")),
            fl.concat(c.text(" left of your ")), fl.concat(ref("budget_words")), fl.concat(c.text(" budget for ")), fl.concat(ref("rows.month_words")),
            fl.concat(c.text(". Ask an admin to approve it, or to raise your budget.")))),
        ],
      }),
    ] }),
  ],
  response: { ok: ref("ok"), refused: ref("refused"), total: ref("total"), detail: ref("detail"), month: ref("rows.month") },
});
