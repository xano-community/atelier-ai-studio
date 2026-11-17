// Transcription: one call to s.ai.speech.transcribe for a reserved step. It returns plain text: the model ignores
// requests for speakers or timestamps (measured), so the prompt is only a hint about names and terms.
import { c, defineFunction, expect, expr, fl, input, obj, ref, resp, s, withFilters } from "@xano/sdk";
import {
  callModel, fellShort, flagFilled, forAll, fromAsked, heldRow, NO_RESERVATION, pick, reservedStep, stepRow, succeeded, variants, wrapperResponse,
  type WrapperResult,
} from "./shared.js";

const T = {
  heard: "a recording comes back as text with what it used",
  silent: "a recording with no speech says so",
  noReservation: "a step without a reservation is refused",
} as const;
const ALL = Object.values(T);
export const NO_SPEECH_WORDS = "No speech was found in the recording. It was still charged. Check the file and try again.";
const NEEDS_AUDIO = "A transcription needs a recording. Nothing was sent or charged.";
const heard = "Thanks for making time, Riley. I wanted to talk through how the Trail 2 is landing with your customers.";

export const transcribeFn = defineFunction({
  name: "ai/transcribe",
  description: "Transcribe a recording for a reserved step into plain text.",
  input: { step_id: input.int({ required: true }) },
  stack: [
    ...reservedStep("transcribe", { step: forAll(ALL, stepRow("transcribe", "gemini-3.5-transcribe", { audio: "file-resource" })), entry: { ...forAll(ALL, heldRow), [T.noReservation]: c.null() } }),
    fromAsked("audio"),
    fromAsked("language"), flagFilled("language"),
    fromAsked("prompt"), flagFilled("prompt"),
    s.set_var("mapped", c.null()),
    s.set_var("failed", c.bool(true)),
    s.set_var("r", c.null()),
    s.conditional({
      when: expr(withFilters(ref("audio"), fl.empty()), "=", c.bool(true)),
      then: [s.update_var("mapped", obj({ outcome: c.text("failed"), reason: c.text("rejected"), detail: c.text(NEEDS_AUDIO), refused: c.bool(true), output: c.obj({}), usage: c.obj({}) }))],
      else: [...callModel(variants(["language", "prompt"], (on) => s.ai.speech.transcribe({
        model: ref("step.model"), audio: ref("audio"), ...pick(on, { language: ref("language"), prompt: ref("prompt") }), as: "r",
        mock: {
          [T.heard]: c.obj({ text: heard, model: "gemini-3.5-transcribe", usage: { input_tokens: 1672, output_tokens: 252 } }),
          [T.silent]: c.obj({ text: "", model: "gemini-3.5-transcribe", usage: { input_tokens: 40, output_tokens: 0 } }),
        },
      })))],
    }),
    s.conditional({ when: expr(ref("failed"), "=", c.bool(false)), then: [
      s.set_var("used", withFilters(ref("r.usage", { safe: true }), fl.first_notnull(c.obj({})))),
      s.set_var("said", withFilters(ref("r.text", { safe: true }), fl.first_notnull(c.text("")), fl.to_text())),
      s.conditional({
        when: expr(withFilters(ref("said"), fl.trim()), "=", c.text("")),
        then: [fellShort("failed", "no_speech", NO_SPEECH_WORDS, c.obj({}), ref("used"))],
        else: [succeeded(obj({ text: ref("said") }), ref("used"))],
      }),
    ] }),
  ],
  response: wrapperResponse(c.bool(false), withFilters(ref("prompt"), fl.first_notnull(c.text("")))),
  responseShape: {} as WrapperResult,
  tests: [
    { name: T.heard, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("succeeded")),
      expect.to_equal(resp("output.text"), c.text(heard)),
      expect.to_equal(resp("usage.input_tokens"), c.int(1672)),
    ] },
    { name: T.silent, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("failed")),
      expect.to_equal(resp("detail"), c.text(NO_SPEECH_WORDS)),
    ] },
    { name: T.noReservation, input: { step_id: c.int(41) }, expect: [expect.to_throw(c.text(NO_RESERVATION))] },
  ],
});
