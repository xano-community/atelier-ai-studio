// Speech: one call to s.ai.speech.generate for a reserved step. With the brand kit asked for, its default voice and
// voice style stand in for the ones the step left out. The audio is stored privately.
import { c, defineFunction, expect, expr, fl, input, obj, ref, resp, s, withFilters } from "@xano/sdk";
import { composeStep } from "../brand/compose.js";
import {
  callModel, fellShort, fileName, flagFilled, forAll, heldRow, NO_RESERVATION, pick, plainCompose, reservedStep, STORE_FAILED, stepRow, storedFile,
  storePrivately, succeeded, variants, wrapperResponse, type WrapperResult,
} from "./shared.js";

const T = {
  made: "speech is made with the brand's voice and kept privately",
  noReservation: "a step without a reservation is refused",
} as const;
const ALL = Object.values(T);
const words = "Meet the Trail 2: built for every road you haven't ridden yet.";
const NEEDS_TEXT = "A speech step needs the words to say. Nothing was sent or charged.";

export const speechFn = defineFunction({
  name: "ai/speech",
  description: "Turn text into speech for a reserved step and keep the audio in private storage.",
  input: { step_id: input.int({ required: true }) },
  stack: [
    ...reservedStep("speech", { step: forAll(ALL, stepRow("speech", "gemini-3.8-flash-tts", { text: words, use_brand: true })), entry: { ...forAll(ALL, heldRow), [T.noReservation]: c.null() } }),
    composeStep("speech", { [T.made]: plainCompose("", { voice: "Kore", instructions: "Warm and unhurried", applied: true }) }),
    s.set_var("words", withFilters(ref("asked"), fl.get("text", ""), fl.first_notempty(withFilters(ref("asked"), fl.get("prompt", ""))), fl.first_notnull(c.text("")), fl.to_text())),
    s.set_var("voice", ref("composed.voice")), flagFilled("voice"),
    s.set_var("instructions", ref("composed.instructions")), flagFilled("instructions"),
    s.set_var("mapped", c.null()),
    s.set_var("failed", c.bool(true)),
    s.conditional({
      when: expr(withFilters(ref("words"), fl.trim()), "=", c.text("")),
      then: [s.update_var("mapped", obj({ outcome: c.text("failed"), reason: c.text("rejected"), detail: c.text(NEEDS_TEXT), refused: c.bool(true), output: c.obj({}), usage: c.obj({}) }))],
      else: [...callModel(variants(["voice", "instructions"], (on) => s.ai.speech.generate({
        model: ref("step.model"), text: ref("words"), ...pick(on, { voice: ref("voice"), instructions: ref("instructions") }), as: "r",
        mock: { [T.made]: c.obj({ audio: "file-resource", model: "gemini-3.8-flash-tts", usage: { input_tokens: 26, output_tokens: 170 } }) },
      })))],
    }),
    s.conditional({ when: expr(ref("failed"), "=", c.bool(false)), then: [
      s.set_var("used", withFilters(ref("r.usage", { safe: true }), fl.first_notnull(c.obj({})))),
      ...storePrivately("audio", ref("r.audio"), fileName("wav"), { [T.made]: storedFile("audio", "atelier-speech-41-1.wav", "audio/wav", { duration: 6.8 }) }),
      s.conditional({
        when: expr(ref("stored"), "=", c.null()),
        then: [fellShort("failed", "storage", STORE_FAILED, c.obj({}), ref("used"))],
        // The made audio itself stays on hand for a day, so a later recipe step can use it.
        else: [succeeded(obj({ file: ref("stored"), voice: ref("voice"), resource: ref("r.audio") }), ref("used"))],
      }),
    ] }),
  ],
  response: wrapperResponse(ref("composed.applied"), ref("words")),
  responseShape: {} as WrapperResult,
  tests: [
    { name: T.made, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("succeeded")),
      expect.to_equal(resp("output.voice"), c.text("Kore")),
      expect.to_be_true(resp("brand_applied")),
      expect.to_equal(resp("usage.output_tokens"), c.int(170)),
    ] },
    { name: T.noReservation, input: { step_id: c.int(41) }, expect: [expect.to_throw(c.text(NO_RESERVATION))] },
  ],
});
