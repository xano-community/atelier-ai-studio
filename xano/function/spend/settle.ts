// After a call: move its one ledger row out of `reserved`, exactly once. The move is a guarded update that takes `held`
// from 1 to 0, so whoever gets there second (a late result after the sweep timed the step out, a retried request) finds
// nothing to move and is only recorded. Money moves on the month rows the reservation counted against, team row first,
// even when the month has turned since.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { ledger } from "../../table/studio/ledger.js";
import { ai_step, STEP_OUTCOMES } from "../../table/studio/ai_step.js";
import { bump } from "./begin.js";
import { estimateFn } from "./estimate.js";

/** Bind `as` to the ledger row for (step, attempt). */
export const ledgerRow = (step: Value, attempt: Value, as = "entry") =>
  s.db.query({ table: ledger, where: [cmp(col("step_id"), "=", step), cmp(col("attempt"), "=", attempt)], returnType: "single", as });

/** Take one ledger row from held to not, binding `as` to 1 when this call did it and 0 when it had already moved. */
export const unhold = (id: Value, as = "moved") =>
  s.db.increment({ table: ledger, where: [expr(col("id"), "=", id), expr(col("held"), "=", c.int(1))], fieldName: "held", value: c.int(-1), returnType: "count", as });

/** Move a reservation of `estimate` on both month rows: `charge` becomes spent and the rest goes back to headroom. */
export const moveMoney = (entry: string, charge: Value) => [
  s.set_var("_back", withFilters(ref(`${entry}.estimate`), fl.sub(charge))),
  s.set_var("_unreserve", withFilters(ref(`${entry}.estimate`), fl.mul(-1))),
  bump(ref(`${entry}.team_month_id`), "reserved", ref("_unreserve")),
  bump(ref(`${entry}.team_month_id`), "spent", charge),
  bump(ref(`${entry}.team_month_id`), "headroom", ref("_back")),
  bump(ref(`${entry}.person_month_id`), "reserved", ref("_unreserve")),
  bump(ref(`${entry}.person_month_id`), "spent", charge),
  bump(ref(`${entry}.person_month_id`), "headroom", ref("_back")),
];

/**
 * Charge a sent call. With usage, the charge is the estimate for what was actually used (tokens, seconds); without it
 * (music reports none, a timeout reports nothing) the charge is the reservation. Success, blocked prompts and timeouts are
 * all charged: the gateway bills them.
 */
export const settleFn = defineFunction({
  name: "spend/settle",
  description: "Charge one step attempt from its reservation, once. A result that arrives after it already moved is recorded with no money moved.",
  input: {
    step_id: input.int({ required: true }), attempt: input.int({ required: true }),
    outcome: input.enum(STEP_OUTCOMES, { required: true }),
    /** What the gateway reported: input_tokens, output_tokens, seconds. */
    usage: input.json(),
    /** The gateway refused the call before doing any work (a model it can't serve, no credits): it billed nothing, so neither does this. */
    refused: input.bool(),
  },
  stack: [
    s.db.get({ table: ai_step, fieldValue: inp("step_id"), as: "step" }),
    guard.found("step", { message: "No such step." }),
    ledgerRow(inp("step_id"), inp("attempt")),
    guard.found("entry", { message: "Nothing was reserved for this step." }),
    s.set_var("used", withFilters(inp("usage"), fl.first_notnull(obj({})))),
    s.set_var("amount", ref("entry.estimate")),
    s.conditional({ when: [expr(withFilters(ref("used"), fl.count()), ">", c.int(0)), expr(inp("refused"), "!=", c.bool(true))], then: [
      s.set_var("actual", withFilters(ref("step.options"), fl.first_notnull(obj({})),
        fl.set_ifnotnull("input_tokens", withFilters(ref("used"), fl.get("input_tokens"))),
        fl.set_ifnotnull("output_tokens", withFilters(ref("used"), fl.get("output_tokens"))),
        fl.set_ifnotnull("seconds", withFilters(ref("used"), fl.get("seconds"))))),
      s.function.run({ fn: estimateFn, as: "priced", input: { kind: ref("step.kind"), model: ref("step.model"), options: ref("actual") } }),
      s.conditional({ when: expr(ref("priced.priced"), "=", c.bool(true)), then: [s.update_var("amount", ref("priced.amount"))] }),
    ] }),
    s.set_var("reason", inp("outcome")),
    s.conditional({ when: expr(inp("outcome"), "=", c.text("timed_out")), then: [s.update_var("reason", c.text("timeout"))] }),
    s.conditional({ when: expr(inp("refused"), "=", c.bool(true)), then: [s.update_var("amount", c.int(0)), s.update_var("reason", c.text("refused"))] }),
    s.db.transaction({ body: [
      unhold(ref("entry.id")),
      s.conditional({
        when: expr(ref("moved"), "=", c.int(1)),
        then: [
          s.db.patch({ table: ledger, fieldValue: ref("entry.id"), data: obj({ state: c.text("settled"), amount: ref("amount"), reason: ref("reason"), moved_at: c.now() }) }),
          ...moveMoney("entry", ref("amount")),
        ],
        else: [s.db.patch({ table: ledger, fieldValue: ref("entry.id"), data: obj({ late: obj({ outcome: inp("outcome"), usage: ref("used"), amount: ref("amount"), at: c.now() }) }) })],
      }),
    ] }),
    s.conditional({ when: expr(ref("moved"), "=", c.int(1)), then: [
      s.conditional({ when: expr(ref("step.attempt"), "=", inp("attempt")), then: [
        s.db.patch({ table: ai_step, fieldValue: inp("step_id"), data: obj({ charged: ref("amount") }) }),
      ] }),
    ] }),
  ],
  response: { moved: c.expression("$var.moved == 1"), amount: ref("amount") },
});
