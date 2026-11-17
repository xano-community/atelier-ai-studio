// Images: one call to s.ai.image.generate for a reserved step. Given images, it's an edit of them, and the item records
// what it was made from. The size and shape are always sent, because the estimate priced that size. What comes back is
// a file resource that lasts a day, so it's stored at once, privately.
import { c, defineFunction, expect, expr, fl, input, obj, ref, resp, s, withFilters } from "@xano/sdk";
import { ESTIMATE_DEFAULTS } from "../../prices.js";
import { composeStep } from "../brand/compose.js";
import {
  callModel, fellShort, fileName, flagFilled, forAll, heldRow, NO_RESERVATION, pick, plainCompose, reservedStep, STORE_FAILED, stepRow,
  storedFile, storePrivately, succeeded, variants, wrapperResponse, type WrapperResult,
} from "./shared.js";

const T = {
  made: "a new image is made and kept privately",
  edit: "with an image given, it edits it and records the source",
  nothing: "no image back is blocked",
  noReservation: "a step without a reservation is refused",
} as const;
const ALL = Object.values(T);
export const NO_IMAGE_WORDS = "The model didn't make an image for this prompt. Xano AI still charges for the call. Change the prompt and try again.";

// The gateway's envelope recorded on 2026-11-16; the file resource itself is a token that has long expired.
const made = c.obj({ image: "file-resource", text: "", model: "gemini-3.1-flash-image", usage: { input_tokens: 16, output_tokens: 1120 } } as never);
const source = { name: "trail-2.png", size: 48213, mime: "image/png" };
const stepMocks = {
  [T.made]: stepRow("image", "gemini-3.1-flash-image", { prompt: "A gravel bike on a forest trail at dawn" }, { size: "1K" }),
  [T.edit]: stepRow("image", "gemini-3.1-flash-image", { prompt: "Make the bike sage green", images: ["file-resource"], sources: [source] }, { size: "1K" }),
  [T.nothing]: stepRow("image", "gemini-3.1-flash-image", { prompt: "A gravel bike" }),
  [T.noReservation]: stepRow("image", "gemini-3.1-flash-image", { prompt: "A gravel bike" }),
};
const kept = storedFile("image", "atelier-image-41-1.png", "image/png", { width: 1024, height: 1024 });

export const imageFn = defineFunction({
  name: "ai/image",
  description: "Make or edit an image for a reserved step and keep it in private storage.",
  input: { step_id: input.int({ required: true }) },
  stack: [
    ...reservedStep("image", { step: stepMocks, entry: { ...forAll(ALL, heldRow), [T.noReservation]: c.null() } }),
    composeStep("image", { [T.made]: plainCompose("A gravel bike on a forest trail at dawn"), [T.edit]: plainCompose("Make the bike sage green"), [T.nothing]: plainCompose("A gravel bike") }),
    s.set_var("prompt", ref("composed.prompt")),
    // The person's own images make it an edit; the brand kit's reference images follow them.
    s.set_var("own_images", withFilters(ref("asked"), fl.get("images", c.null()), fl.first_notnull(c.array([])))), flagFilled("own_images"),
    s.set_var("images", withFilters(ref("own_images"), fl.array_merge(withFilters(ref("composed.references", { safe: true }), fl.safe_array())))),
    flagFilled("images"),
    s.set_var("size", withFilters(ref("options"), fl.get("size", ESTIMATE_DEFAULTS.image_size), fl.first_notempty(c.text(ESTIMATE_DEFAULTS.image_size)))),
    s.set_var("shape", withFilters(ref("options"), fl.get("aspect_ratio", "1:1"), fl.first_notempty(c.text("1:1")))),
    ...callModel(variants(["images"], (on) => s.ai.image.generate({
      model: ref("step.model"), prompt: ref("prompt"), aspect_ratio: ref("shape"), image_size: ref("size"),
      ...pick(on, { images: ref("images") }), as: "r", mock: { [T.made]: made, [T.edit]: made, [T.nothing]: c.obj({ image: null, text: "", model: "gemini-3.1-flash-image", usage: { input_tokens: 9, output_tokens: 0 } } as never) },
    }))),
    s.conditional({ when: expr(ref("failed"), "=", c.bool(false)), then: [
      s.set_var("used", withFilters(ref("r.usage", { safe: true }), fl.first_notnull(c.obj({})))),
      s.conditional({
        when: expr(withFilters(ref("r.image", { safe: true }), fl.empty()), "=", c.bool(true)),
        then: [fellShort("blocked", "blocked", NO_IMAGE_WORDS, c.obj({}), ref("used"))],
        else: [
          ...storePrivately("image", ref("r.image"), fileName("png"), { [T.made]: kept, [T.edit]: kept }),
          s.conditional({
            when: expr(ref("stored"), "=", c.null()),
            then: [fellShort("failed", "storage", STORE_FAILED, c.obj({}), ref("used"))],
            else: [succeeded(obj({
              // The made image itself stays on hand for a day, so a later recipe step can edit it or start a video from it.
              file: ref("stored"), resource: ref("r.image"), text: withFilters(ref("r.text", { safe: true }), fl.first_notnull(c.text(""))),
              edit: ref("has_own_images"), edited_from: withFilters(ref("asked"), fl.get("sources", c.array([])), fl.first_notnull(c.array([]))),
              brand_references: withFilters(ref("composed.reference_names", { safe: true }), fl.safe_array()),
            }), ref("used"))],
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
      expect.to_be_false(resp("output.edit")),
    ] },
    { name: T.edit, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("succeeded")),
      expect.to_be_true(resp("output.edit")),
      expect.to_equal(withFilters(resp("output.edited_from"), fl.first(), fl.get("name", "")), c.text(source.name)),
    ] },
    { name: T.nothing, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("blocked")),
      expect.to_equal(resp("detail"), c.text(NO_IMAGE_WORDS)),
    ] },
    { name: T.noReservation, input: { step_id: c.int(41) }, expect: [expect.to_throw(c.text(NO_RESERVATION))] },
  ],
});
