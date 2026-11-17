// Video: one call to s.ai.video.generate for a reserved step, run in the background. The length, resolution and sound
// the estimate priced are always sent. The call waits up to the step's own time limit; a video that isn't ready by then
// is still billed by the gateway ("not refunded"), so it ends timed out and charged. The clip is stored privately.
import { c, defineFunction, expect, expr, fl, input, obj, ref, resp, s, withFilters } from "@xano/sdk";
import { ESTIMATE_DEFAULTS, STEP_TIMEOUT_SECONDS } from "../../prices.js";
import { composeStep } from "../brand/compose.js";
import {
  callModel, fellShort, fileName, flagFilled, forAll, fromAsked, heldRow, NO_RESERVATION, pick, plainCompose, reservedStep, STORE_FAILED, stepRow,
  storedFile, storePrivately, succeeded, variants, wrapperResponse, type WrapperResult,
} from "./shared.js";

const T = {
  made: "a clip is made, kept privately, and reports its seconds",
  noReservation: "a step without a reservation is refused",
} as const;
const ALL = Object.values(T);
export const NO_VIDEO_WORDS = "The model didn't send a video back. It was sent, so it may be charged. Try again.";

const asked = { prompt: "A slow pan across a gravel bike leaning on a stone wall" };
const options = { seconds: 4, resolution: "720p", audio: false };

export const videoFn = defineFunction({
  name: "ai/video",
  description: "Make a video clip for a reserved step and keep it in private storage. A clip not ready in time is charged.",
  input: { step_id: input.int({ required: true }) },
  stack: [
    ...reservedStep("video", { step: forAll(ALL, stepRow("video", "veo-3.1-fast-generate-001", asked, options)), entry: { ...forAll(ALL, heldRow), [T.noReservation]: c.null() } }),
    composeStep("video", { [T.made]: plainCompose(asked.prompt) }),
    s.set_var("prompt", ref("composed.prompt")),
    fromAsked("image"), flagFilled("image"),
    fromAsked("negative_prompt"), flagFilled("negative_prompt"),
    s.set_var("seconds", withFilters(ref("options"), fl.get("seconds", ESTIMATE_DEFAULTS.video_seconds), fl.first_notnull(c.int(ESTIMATE_DEFAULTS.video_seconds)), fl.to_int())),
    s.set_var("resolution", withFilters(ref("options"), fl.get("resolution", ESTIMATE_DEFAULTS.video_resolution), fl.first_notempty(c.text(ESTIMATE_DEFAULTS.video_resolution)), fl.to_text(), fl.lower())),
    s.set_var("sound", withFilters(ref("options"), fl.get("audio", false), fl.first_notnull(c.bool(false)), fl.to_bool())),
    s.set_var("shape", withFilters(ref("options"), fl.get("aspect_ratio", "16:9"), fl.first_notempty(c.text("16:9")))),
    s.set_var("wait", withFilters(ref("step.timeout_s"), fl.first_notempty(c.int(STEP_TIMEOUT_SECONDS.video)), fl.to_int())),
    ...callModel(variants(["image", "negative_prompt"], (on) => s.ai.video.generate({
      model: ref("step.model"), prompt: ref("prompt"), aspect_ratio: ref("shape"), resolution: ref("resolution"), duration: ref("seconds"),
      generate_audio: ref("sound"), timeout: ref("wait"), ...pick(on, { image: ref("image"), negative_prompt: ref("negative_prompt") }), as: "r",
      mock: { [T.made]: c.obj({ video: "file-resource", model: "veo-3.1-fast-generate-001", duration: 4 }) },
    }))),
    s.conditional({ when: expr(ref("failed"), "=", c.bool(false)), then: [
      s.set_var("length", withFilters(ref("r.duration", { safe: true }), fl.first_notnull(ref("seconds")))),
      s.conditional({
        when: expr(withFilters(ref("r.video", { safe: true }), fl.empty()), "=", c.bool(true)),
        then: [fellShort("failed", "model_error", NO_VIDEO_WORDS, c.obj({}), obj({ seconds: ref("length") }))],
        else: [
          ...storePrivately("video", ref("r.video"), fileName("mp4"), { [T.made]: storedFile("video", "atelier-video-41-1.mp4", "video/mp4", { duration: 4 }) }),
          s.conditional({
            when: expr(ref("stored"), "=", c.null()),
            then: [fellShort("failed", "storage", STORE_FAILED, c.obj({}), obj({ seconds: ref("length") }))],
            else: [succeeded(obj({ file: ref("stored"), duration: ref("length") }), obj({ seconds: ref("length") }))],
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
      expect.to_equal(resp("output.file.access"), c.text("private")),
      expect.to_equal(resp("output.duration"), c.int(4)),
      // Settled by the second: the clip's length is its usage.
      expect.to_equal(resp("usage.seconds"), c.int(4)),
    ] },
    { name: T.noReservation, input: { step_id: c.int(41) }, expect: [expect.to_throw(c.text(NO_RESERVATION))] },
  ],
});
