// The ledger is the record; the month rows are its running totals. For every month row, `reserved` must equal the sum of
// its held ledger rows and `spent` the sum of its settled ones. This checks that and, where they disagree, rebuilds the
// row from the ledger. The row is locked while it's checked, so a reservation can't land between the sums and the write.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, qf, ref, s, task, withFilters } from "@xano/sdk";
import { budget_month } from "../../table/studio/budget_month.js";
import { ledger } from "../../table/studio/ledger.js";

const total = (as: string, column: "team_month_id" | "person_month_id", what: "held" | "settled") => [
  s.db.query({
    table: ledger, as: `${as}_rows`, returnType: "aggregate",
    where: [cmp(col(column), "=", ref("row.id")), what === "held" ? expr(col("held"), "=", c.int(1)) : cmp(col("state"), "=", c.text("settled"))],
    aggregate: { group: [{ name: column, as: "month_row" }], eval: [{ name: what === "held" ? "estimate" : "amount", as: "total", filters: [qf.sum()] }] },
  }),
  s.set_var(as, withFilters(ref(`${as}_rows`), fl.first(), fl.get("total", 0), fl.first_notnull(0), fl.to_int())),
];

export const reconcileFn = defineFunction({
  name: "spend/reconcile",
  description: "Check every month row against the ledger, and rebuild the ones that disagree. Answers how many were checked and fixed.",
  input: { month: input.text({ description: "Only this month (\"2026-11\"). Empty: every month." }) },
  stack: [
    s.db.query({ table: budget_month, where: cmp(col("month"), "=", inp("month"), { ignoreEmpty: true }), output: ["id"], as: "months" }),
    s.set_var("fixed", c.int(0)),
    s.foreach({ list: ref("months"), as: "listed", body: [
      s.db.transaction({ body: [
        s.db.get({ table: budget_month, fieldValue: ref("listed.id"), lock: true, as: "row" }),
        guard.found("row", { message: "A budget row went missing." }),
        s.conditional({
          when: expr(ref("row.scope"), "=", c.text("team")),
          then: [...total("held_sum", "team_month_id", "held"), ...total("spent_sum", "team_month_id", "settled")],
          else: [...total("held_sum", "person_month_id", "held"), ...total("spent_sum", "person_month_id", "settled")],
        }),
        s.set_var("headroom", withFilters(ref("row.budget"), fl.sub(ref("held_sum")), fl.sub(ref("spent_sum")))),
        s.set_var("off", c.expression("$var.row.reserved != $var.held_sum || $var.row.spent != $var.spent_sum || $var.row.headroom != $var.headroom")),
        s.conditional({ when: expr(ref("off"), "=", c.bool(true)), then: [
          s.db.edit({ table: budget_month, fieldValue: ref("row.id"), row: { reserved: ref("held_sum"), spent: ref("spent_sum"), headroom: ref("headroom") } }),
          s.update_var("fixed", withFilters(ref("fixed"), fl.add(1))),
        ] }),
      ] }),
    ] }),
  ],
  response: { checked: withFilters(ref("months"), fl.count()), fixed: ref("fixed") },
});

/** Hourly: the ledger and the month rows agree, or are made to. */
export const reconcileHourly = task({
  name: "spend/reconcile_every_hour",
  description: "Check the budget counters against the ledger, and rebuild any that disagree.",
  schedule: [{ startsOn: "2026-01-01 00:00:00+0000", freq: 3_600 }],
  stack: [s.function.run({ fn: reconcileFn, as: "result", input: { month: c.text("") } })],
});
