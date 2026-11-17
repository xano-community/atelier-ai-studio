// Music: one call to s.ai.music.generate for a reserved step, run in the background. The gateway reports no usage for a
// clip, so it settles at the per-clip price. The clip is stored privately.
import { c, defineFunction, expect, expr, fl, input, obj, ref, resp, s, withFilters } from "@xano/sdk";
import { composeStep } from "../brand/compose.js";
import {
  callModel, fellShort, fileName, flagFilled, flagSet, forAll, fromAsked, heldRow, NO_RESERVATION, pick, plainCompose, reservedStep, STORE_FAILED,
  stepRow, storedFile, storePrivately, succeeded, variants, wrapperResponse, type WrapperResult,
} from "./shared.js";

const T = {
  made: "a clip is made and kept privately",
  noReservation: "a step without a reservation is refused",
} as const;
const ALL = Object.values(T);
const prompt = "A calm acoustic theme for a product film";

export const musicFn = defineFunction({
  name: "ai/music",
  description: "Make a music clip for a reserved step and keep it in private storage.",
  input: { step_id: input.int({ required: true }) },
  stack: [
    ...reservedStep("music", { step: forAll(ALL, stepRow("music", "lyria-002", { prompt })), entry: { ...forAll(ALL, heldRow), [T.noReservation]: c.null() } }),
    composeStep("music", { [T.made]: plainCompose(prompt) }),
    s.set_var("prompt", ref("composed.prompt")),
    fromAsked("negative_prompt"), flagFilled("negative_prompt"),
    fromAsked("seed"), flagSet("seed"),
    ...callModel(variants(["negative_prompt", "seed"], (on) => s.ai.music.generate({
      model: ref("step.model"), prompt: ref("prompt"), ...pick(on, { negative_prompt: ref("negative_prompt"), seed: ref("seed") }), as: "r",
      // Recorded on 2026-11-16: no usage, no lyrics, no description.
      mock: { [T.made]: c.obj({ audio: "file-resource", model: "lyria-002", lyrics: null, description: null } as never) },
    }))),
    s.conditional({ when: expr(ref("failed"), "=", c.bool(false)), then: [
      s.conditional({
        when: expr(withFilters(ref("r.audio", { safe: true }), fl.empty()), "=", c.bool(true)),
        then: [fellShort("failed", "model_error", "The model didn't send a clip back. It was sent, so it's charged. Try again.")],
        else: [
          ...storePrivately("audio", ref("r.audio"), fileName("wav"), { [T.made]: storedFile("audio", "atelier-music-41-1.wav", "audio/wav", { duration: 32.77 }) }),
          s.conditional({
            when: expr(ref("stored"), "=", c.null()),
            then: [fellShort("failed", "storage", STORE_FAILED)],
            else: [succeeded(obj({ file: ref("stored"), resource: ref("r.audio"), lyrics: ref("r.lyrics", { safe: true }), description: ref("r.description", { safe: true }) }), c.obj({}))],
          }),
        ],
      }),
    ] }),
  ],
  response: wrapperResponse(ref("composed.applied"), ref("prompt")),
  responseShape: {} as WrapperResult,
  tests: [
    { name: T.made, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("succeeded")),
      expect.to_equal(resp("output.file.type"), c.text("audio")),
      // No usage comes back for music: it settles at the clip's price.
      expect.to_be_empty(resp("usage")),
    ] },
    { name: T.noReservation, input: { step_id: c.int(41) }, expect: [expect.to_throw(c.text(NO_RESERVATION))] },
  ],
});
