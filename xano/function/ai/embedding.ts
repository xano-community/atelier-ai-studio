// Embeddings: one call to s.ai.embedding.create for a reserved step. The task type takes Google's names (measured:
// anything else is an input error), so an unknown one is refused before anything is sent.
import { c, defineFunction, expect, expr, fl, input, obj, ref, resp, s, withFilters } from "@xano/sdk";
import {
  callModel, flagFilled, flagSet, forAll, fromAsked, heldRow, NO_RESERVATION, pick, reservedStep, stepRow, succeeded, variants, wrapperResponse,
  type WrapperResult,
} from "./shared.js";

export const TASK_TYPES = ["RETRIEVAL_QUERY", "RETRIEVAL_DOCUMENT", "SEMANTIC_SIMILARITY", "CLASSIFICATION", "CLUSTERING", "QUESTION_ANSWERING", "FACT_VERIFICATION"] as const;

const T = {
  vectors: "passages come back as one vector each",
  badTask: "an unknown task type is refused before sending",
  noReservation: "a step without a reservation is refused",
} as const;
const ALL = Object.values(T);
const refuse = (detail: string) => s.update_var("mapped", obj({ outcome: c.text("failed"), reason: c.text("rejected"), detail: c.text(detail), refused: c.bool(true), output: c.obj({}), usage: c.obj({}) }));
export const BAD_TASK_WORDS = `The task type is one of ${TASK_TYPES.join(", ")}. Nothing was sent or charged.`;

export const embeddingFn = defineFunction({
  name: "ai/embedding",
  description: "Embed text for a reserved step: one vector per input, in order.",
  input: { step_id: input.int({ required: true }) },
  stack: [
    ...reservedStep("embedding", {
      step: {
        ...forAll(ALL, stepRow("embedding", "gemini-embedding-2", { input: ["The Trail 2 frame is aluminium.", "Medium fits riders 170 to 178 cm."], task_type: "RETRIEVAL_DOCUMENT", dimensions: 768 })),
        [T.badTask]: stepRow("embedding", "gemini-embedding-2", { input: ["Hello"], task_type: "retrieval" }),
      },
      entry: { ...forAll(ALL, heldRow), [T.noReservation]: c.null() },
    }),
    s.set_var("texts", withFilters(ref("asked"), fl.get("input", c.null()))),
    fromAsked("task_type"), flagFilled("task_type"),
    fromAsked("dimensions"), flagSet("dimensions"),
    s.set_var("mapped", c.null()),
    s.set_var("failed", c.bool(true)),
    s.set_var("r", c.null()),
    s.conditional({
      when: expr(withFilters(ref("texts"), fl.empty()), "=", c.bool(true)),
      then: [refuse("An embedding needs text to embed. Nothing was sent or charged.")],
      elif: [{ when: [expr(ref("has_task_type"), "=", c.bool(true)), expr(withFilters(c.array([...TASK_TYPES]), fl.in(ref("task_type"))), "=", c.bool(false))], then: [refuse(BAD_TASK_WORDS)] }],
      else: [...callModel(variants(["task_type", "dimensions"], (on) => s.ai.embedding.create({
        model: ref("step.model"), input: ref("texts"), ...pick(on, { task_type: ref("task_type"), dimensions: ref("dimensions") }), as: "r",
        mock: { [T.vectors]: c.obj({ embeddings: [[0.1, 0.2, 0.3], [0.3, 0.2, 0.1]], model: "gemini-embedding-2", usage: { input_tokens: 16, output_tokens: 0 } }) },
      })))],
    }),
    s.conditional({ when: expr(ref("failed"), "=", c.bool(false)), then: [
      s.set_var("vectors", withFilters(ref("r.embeddings", { safe: true }), fl.safe_array())),
      succeeded(obj({ embeddings: ref("vectors"), count: withFilters(ref("vectors"), fl.count()), dimensions: withFilters(ref("vectors"), fl.first(), fl.safe_array(), fl.count()) }),
        withFilters(ref("r.usage", { safe: true }), fl.first_notnull(c.obj({})))),
    ] }),
  ],
  response: wrapperResponse(c.bool(false), c.text("")),
  responseShape: {} as WrapperResult,
  tests: [
    { name: T.vectors, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("succeeded")),
      expect.to_equal(resp("output.count"), c.int(2)),
      expect.to_equal(resp("output.dimensions"), c.int(3)),
      expect.to_equal(resp("usage.input_tokens"), c.int(16)),
    ] },
    { name: T.badTask, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("failed")),
      expect.to_be_true(resp("refused")),
      expect.to_equal(resp("detail"), c.text(BAD_TASK_WORDS)),
    ] },
    { name: T.noReservation, input: { step_id: c.int(41) }, expect: [expect.to_throw(c.text(NO_RESERVATION))] },
  ],
});
