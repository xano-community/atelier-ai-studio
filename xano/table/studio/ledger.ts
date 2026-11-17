import { f, table } from "@xano/sdk";
import { user } from "../user.js";
import { ai_run, RUN_VIAS } from "./ai_run.js";
import { ai_step } from "./ai_step.js";
import { budget_month } from "./budget_month.js";

export const LEDGER_STATES = ["reserved", "settled", "released"] as const;

/**
 * The money: one row per step attempt. It's written `reserved` with the estimate, then moves exactly once, to `settled`
 * (charged `amount`) or `released` (charged nothing). It records the two month rows it counted against, so it settles
 * there even when the month has turned since.
 */
export const ledger = table({
  name: "ledger",
  description: "Money held and charged for each step attempt, and which month's budgets it counted against.",
  schema: {
    step_id: f.tableRef(ai_step, { required: true }),
    attempt: f.int({ required: true }),
    run_id: f.tableRef(ai_run, { required: true }),
    owner_id: f.tableRef(user, { required: true }),
    team_month_id: f.tableRef(budget_month, { required: true }),
    person_month_id: f.tableRef(budget_month, { required: true }),
    state: f.enum(LEDGER_STATES, { default: "reserved" }),
    /** 1 while reserved, 0 once it has moved. The move takes it from 1 to 0 under a guard, so it can happen only once. */
    held: f.int(),
    /** Micro-dollars: held while reserved, and charged when settled. */
    estimate: f.int(),
    amount: f.int(),
    kind: f.text(),
    model: f.text(),
    via: f.enum(RUN_VIAS),
    connection_id: f.int(),
    /** Why it moved: "succeeded", "blocked", "timeout", "failed", or why it was released. */
    reason: f.text(),
    moved_at: f.timestamp({ nullable: true }),
    /** A result that arrived after this row had already moved: kept for the record, with no money moved. */
    late: f.json(),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "step_id", op: "asc" }, { name: "attempt", op: "asc" }] },
    { type: "btree", fields: [{ name: "run_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "team_month_id", op: "asc" }, { name: "held", op: "asc" }] },
    { type: "btree", fields: [{ name: "person_month_id", op: "asc" }, { name: "held", op: "asc" }] },
    { type: "btree", fields: [{ name: "held", op: "asc" }, { name: "created_at", op: "asc" }] },
  ],
});
