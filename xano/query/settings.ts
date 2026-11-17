// The studio's settings endpoints: the brand kit and the price table. Everyone who can run models reads the kit; admins and
// members with `recipes.manage` change it. Only admins see and change prices. Each door is thin: the function behind it
// checks the role, so a test and a route agree.
import { apiGroup, auth, inp, input, query, ref, s } from "@xano/sdk";
import { user } from "../table/user.js";
import { addImageFn, imageDataFn, readKitFn, removeImageFn, saveKitFn, type BrandImage, type BrandKit } from "../function/brand/kit.js";
import { listPricesFn, setPriceFn, type PriceRow } from "../function/spend/usage.js";

export const settingsGroup = apiGroup({ name: "settings", canonical: "settings", description: "The studio's settings: the brand kit and the price table." });

/** GET settings/brand: the kit as the page shows it. */
export const readBrand = query({
  apiGroup: settingsGroup, auth: user,
  name: "brand", verb: "GET",
  description: "The brand kit: voice rules, words to avoid, visual rules, reference images, default voice and style, music style and colours.",
  stack: [s.function.run({ fn: readKitFn, as: "kit", input: { actor_id: auth("id") } })],
  response: ref("kit"),
  responseShape: {} as BrandKit,
});

/** PUT settings/brand: save the kit's words, voice, music style and colours. */
export const saveBrand = query({
  apiGroup: settingsGroup, auth: user,
  name: "brand", verb: "PUT",
  description: "Save the brand kit. Needs recipes.manage. Sends every field: an empty one clears it.",
  input: {
    voice: input.text({ methods: ["trim"] }),
    avoid_words: input.json(),
    visual_rules: input.text({ methods: ["trim"] }),
    default_voice: input.text({ methods: ["trim"] }),
    voice_style: input.text({ methods: ["trim"] }),
    music_style: input.text({ methods: ["trim"] }),
    colours: input.json(),
  },
  stack: [
    s.function.run({ fn: saveKitFn, as: "kit", input: {
      actor_id: auth("id"), voice: inp("voice"), avoid_words: inp("avoid_words"), visual_rules: inp("visual_rules"),
      default_voice: inp("default_voice"), voice_style: inp("voice_style"), music_style: inp("music_style"), colours: inp("colours"),
    } }),
  ],
  response: ref("kit"),
  responseShape: {} as BrandKit,
});

/** POST settings/brand/images: add a reference image. Request history is off: the request carries the image. */
export const addBrandImage = query({
  apiGroup: settingsGroup, auth: user, history: false,
  name: "brand/images", verb: "POST",
  description: "Add a reference image (PNG, JPEG or WebP, up to 2 MB) to the brand kit. Three at most.",
  input: { file: input.file() },
  stack: [s.function.run({ fn: addImageFn, as: "image", input: { actor_id: auth("id"), file: inp("file") } })],
  response: ref("image"),
  responseShape: {} as BrandImage,
});

/** GET settings/brand/images/{id}: one reference image, to show and download. */
export const readBrandImage = query({
  apiGroup: settingsGroup, auth: user, history: false,
  name: "brand/images/{id}", verb: "GET",
  description: "A brand kit reference image as a data URL.",
  input: { id: input.int({ required: true }) },
  stack: [s.function.run({ fn: imageDataFn, as: "image", input: { actor_id: auth("id"), id: inp("id") } })],
  response: ref("image"),
  responseShape: {} as { name: string; url: string },
});

/** DELETE settings/brand/images/{id}: remove a reference image. */
export const removeBrandImage = query({
  apiGroup: settingsGroup, auth: user,
  name: "brand/images/{id}", verb: "DELETE",
  description: "Remove a reference image from the brand kit.",
  input: { id: input.int({ required: true }) },
  stack: [s.function.run({ fn: removeImageFn, as: "gone", input: { actor_id: auth("id"), id: inp("id") } })],
  response: ref("gone"),
  responseShape: {} as { removed: boolean },
});


/** GET settings/prices: every price row, for the admins' price sheet. */
export const listPricesRoute = query({
  apiGroup: settingsGroup, auth: user,
  name: "prices", verb: "GET",
  description: "Every model's price per unit (micro-dollars; tokens per 1M), by kind and model. Admins.",
  stack: [s.function.run({ fn: listPricesFn, as: "rows", input: { actor_id: auth("id") } })],
  response: ref("rows"),
  responseShape: [] as PriceRow[],
});

/** PATCH settings/prices/{id}: change one price. Estimates from now on use it. */
export const setPriceRoute = query({
  apiGroup: settingsGroup, auth: user,
  name: "prices/{id}", verb: "PATCH",
  description: "Change one price row's amount (micro-dollars per unit; tokens per 1M). Admins. Runs already reserved keep what they held.",
  input: { id: input.int({ required: true }), amount: input.int({ required: true }) },
  stack: [s.function.run({ fn: setPriceFn, as: "row", input: { actor_id: auth("id"), price_id: inp("id"), amount: inp("amount") } })],
  response: ref("row"),
  responseShape: {} as PriceRow,
});

export const settingsQueries = [readBrand, saveBrand, addBrandImage, readBrandImage, removeBrandImage, listPricesRoute, setPriceRoute];
