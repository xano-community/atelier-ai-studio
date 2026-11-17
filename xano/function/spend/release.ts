// Give a reservation back, for a step that never reached the model. A step with `sent_at` may have been billed, so it is
// never released: it's settled or charged instead.
import { c, defineFunction, expr, guard, inp, input, obj, ref, s } from "@xano/sdk";
import { ledger } from "../../table/studio/ledger.js";
import { ai_step } from "../../table/studio/ai_step.js";
import { ledgerRow, moveMoney, unhold } from "./settle.js";

export const releaseFn = defineFunction({
  name: "spend/release",
  description: "Release one step attempt's reservation, once, when the step was never sent to the model.",
  input: {
    step_id: input.int({ required: true }), attempt: input.int({ required: true }),
    /** Why: "stopped", "interrupted", "skipped", "refused". */
    reason: input.text(),
  },
  stack: [
    s.db.get({ table: ai_step, fieldValue: inp("step_id"), as: "step" }),
    guard.found("step", { message: "No such step." }),
    s.set_var("moved", c.int(0)),
    s.set_var("sent", c.bool(false)),
    s.conditional({ when: [expr(ref("step.attempt"), "=", inp("attempt")), expr(ref("step.sent_at"), "!=", c.null())], then: [s.update_var("sent", c.bool(true))] }),
    s.conditional({ when: expr(ref("sent"), "=", c.bool(false)), then: [
      ledgerRow(inp("step_id"), inp("attempt")),
      s.conditional({ when: expr(ref("entry"), "!=", c.null()), then: [
        s.db.transaction({ body: [
          unhold(ref("entry.id")),
          s.conditional({ when: expr(ref("moved"), "=", c.int(1)), then: [
            s.db.patch({ table: ledger, fieldValue: ref("entry.id"), data: obj({ state: c.text("released"), amount: c.int(0), reason: inp("reason"), moved_at: c.now() }) }),
            ...moveMoney("entry", c.int(0)),
          ] }),
        ] }),
      ] }),
    ] }),
  ],
  response: { moved: c.expression("$var.moved == 1"), sent: ref("sent") },
});
