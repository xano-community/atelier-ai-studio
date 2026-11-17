import { f, table } from "@xano/sdk";

export const BUDGET_SCOPES = ["team", "person"] as const;

/**
 * A budget's counters for one month (UTC): the team's (subject 0) and each person's. `headroom` is what's left,
 * budget − reserved − spent, kept in step with the other three on every write. A reservation takes from it only where it
 * covers the whole estimate, in one guarded update, so two requests at once can't both fit into the last dollar.
 */
export const budget_month = table({
  name: "budget_month",
  description: "Monthly budget counters (micro-dollars) for the team and for each person: budget, reserved, spent and what's left.",
  schema: {
    scope: f.enum(BUDGET_SCOPES, { required: true }),
    /** The person's id, or 0 for the team. */
    subject_id: f.int(),
    /** "2026-11": the UTC month. */
    month: f.text({ required: true }),
    budget: f.int(),
    reserved: f.int(),
    spent: f.int(),
    headroom: f.int(),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "scope", op: "asc" }, { name: "subject_id", op: "asc" }, { name: "month", op: "asc" }] },
    { type: "btree", fields: [{ name: "month", op: "asc" }] },
  ],
});
