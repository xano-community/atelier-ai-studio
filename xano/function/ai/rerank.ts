// Rerank: one call to s.ai.rerank for a reserved step. On the dev gateway today the reranker "has no price and cannot be
// served", which the gateway mapper turns into "unavailable", not charged. The price table has no rerank row either,
// so a run asking for one is refused before anything is reserved.
import { c, defineFunction, expect, expr, fl, input, obj, ref, resp, s, withFilters } from "@xano/sdk";
import {
  callModel, flagSet, forAll, fromAsked, heldRow, NO_RESERVATION, pick, reservedStep, stepRow, succeeded, variants, wrapperResponse, type WrapperResult,
} from "./shared.js";

const T = {
  ranked: "documents come back best first",
  noReservation: "a step without a reservation is refused",
} as const;
const ALL = Object.values(T);
const NEEDS = "A rerank needs a question and at least one document. Nothing was sent or charged.";

export const rerankFn = defineFunction({
  name: "ai/rerank",
  description: "Order documents by how well they answer a question, for a reserved step.",
  input: { step_id: input.int({ required: true }) },
  stack: [
    ...reservedStep("rerank", {
      step: forAll(ALL, stepRow("rerank", "semantic-ranker-default-005", { query: "Which size fits 175 cm?", documents: ["Large fits 176 to 186 cm.", "Medium fits 170 to 178 cm."], top_n: 1 })),
      entry: { ...forAll(ALL, heldRow), [T.noReservation]: c.null() },
    }),
    fromAsked("query"),
    fromAsked("documents", c.array([])),
    fromAsked("top_n"), flagSet("top_n"),
    s.set_var("mapped", c.null()),
    s.set_var("failed", c.bool(true)),
    s.set_var("r", c.null()),
    s.conditional({
      when: [expr(withFilters(ref("query"), fl.empty()), "=", c.bool(false)), expr(withFilters(ref("documents"), fl.empty()), "=", c.bool(false))],
      then: [...callModel(variants(["top_n"], (on) => s.ai.rerank({
        model: ref("step.model"), query: ref("query"), documents: ref("documents"), ...pick(on, { top_n: ref("top_n") }), as: "r",
        mock: { [T.ranked]: c.obj({ results: [{ index: 1, id: "1", score: 0.91, content: "Medium fits 170 to 178 cm." }], model: "semantic-ranker-default-005" }) },
      })))],
      else: [s.update_var("mapped", obj({ outcome: c.text("failed"), reason: c.text("rejected"), detail: c.text(NEEDS), refused: c.bool(true), output: c.obj({}), usage: c.obj({}) }))],
    }),
    s.conditional({ when: expr(ref("failed"), "=", c.bool(false)), then: [
      succeeded(obj({ results: withFilters(ref("r.results", { safe: true }), fl.safe_array()) }), c.obj({})),
    ] }),
  ],
  response: wrapperResponse(c.bool(false), withFilters(ref("query"), fl.first_notnull(c.text("")), fl.to_text())),
  responseShape: {} as WrapperResult,
  tests: [
    { name: T.ranked, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("succeeded")),
      expect.to_equal(withFilters(resp("output.results"), fl.first(), fl.get("index", -1)), c.int(1)),
    ] },
    { name: T.noReservation, input: { step_id: c.int(41) }, expect: [expect.to_throw(c.text(NO_RESERVATION))] },
  ],
});
