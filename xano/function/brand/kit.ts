// The brand kit itself: reading it, saving it, and adding or removing a reference image. Everyone who can run models
// reads it (it shapes their runs); admins and members with `recipes.manage` change it. Each takes the acting person's
// id, so a route and a test check the same role the same way.
import { c, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { changed } from "../../base/index.js";
import { rbac } from "../../rbac.js";
import { brand, brand_image } from "../../table/studio/brand.js";
import { user } from "../../table/user.js";
import { CATALOG } from "../studio/catalog.js";
import { REFERENCE_LIMIT } from "./compose.js";

/** Every voice a speech model in the catalog offers, for the default voice. */
export const BRAND_VOICES = [...new Set((CATALOG.statements.speech ?? []).flatMap((m) => (m.options.voices as string[] | undefined) ?? []))];

export const KIT_LIMITS = { words: 2000, style: 500, avoid: 40, avoidChars: 60, colours: 6, colourName: 30, imageBytes: 2 * 1024 * 1024 } as const;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

export const KIT_WORDS = {
  readDenied: "Guests can't see the brand kit. It shapes runs, and a guest's role can't start one.",
  saveDenied: "Your role can see the brand kit but can't change it. Ask an admin or a member who manages recipes.",
  tooLong: `Keep the voice and visual rules under ${KIT_LIMITS.words} characters each, and the voice and music styles under ${KIT_LIMITS.style}.`,
  avoid: `List up to ${KIT_LIMITS.avoid} words to avoid, each under ${KIT_LIMITS.avoidChars} characters.`,
  colours: `Add up to ${KIT_LIMITS.colours} colours, each a hex value like #4A6B57 with a name under ${KIT_LIMITS.colourName} characters.`,
  voice: "That voice isn't one Xano AI's speech models offer. Pick one from the list, or leave it empty for the model's own.",
  noImage: "Attach a PNG, JPEG or WebP image to add.",
  imageType: "Reference images can be PNG, JPEG or WebP. Export it as one of those and add it again.",
  imageSize: "Reference images can be up to 2 MB. Export a smaller copy (1,500 px on the long side is plenty) and add it again.",
  full: `The kit holds ${REFERENCE_LIMIT} reference images. Remove one before adding another.`,
  gone: "That reference image isn't in the kit any more.",
} as const;

export type BrandColour = { name: string; hex: string };
export type BrandImage = { id: number; created_at: number; name: string; mime: string; size: number; added_by: number };
export type BrandKit = {
  voice: string; avoid_words: string[]; visual_rules: string; default_voice: string; voice_style: string; music_style: string;
  colours: BrandColour[]; updated_by: number; updated_at: number | null; images: BrandImage[];
  /** The voices the default voice can be. */
  voices: string[];
};

const IMAGE_FIELDS = ["id", "created_at", "name", "mime", "size", "added_by"] as const;
const text = (path: string) => withFilters(ref("row"), fl.get(path, ""), fl.first_notnull(c.text("")));
// No kit row yet (a new workspace) reads as empty lists, never a list holding one null.
const list = (path: string) => withFilters(ref("row"), fl.get(path, c.null()), fl.first_notnull(c.array([])), fl.safe_array());

/** The acting person, refused unless their role holds `perm`. */
const actor = (perm: "studio.run" | "recipes.manage", words: string) => [
  s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
  guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
  rbac.allows(ref("actor.role"), perm, words),
];

export const readKitFn = defineFunction({
  name: "brand/read",
  description: "The brand kit as the page shows it: its words, colours and reference images (without their bytes), and who saved it last.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    ...actor("studio.run", KIT_WORDS.readDenied),
    s.db.query({ table: brand, sort: [{ sortBy: "id", dir: "asc" }], returnType: "single", as: "row" }),
    s.db.query({ table: brand_image, sort: [{ sortBy: "id", dir: "asc" }], output: [...IMAGE_FIELDS], as: "images" }),
  ],
  response: {
    voice: text("voice"), avoid_words: list("avoid_words"), visual_rules: text("visual_rules"), default_voice: text("default_voice"),
    voice_style: text("voice_style"), music_style: text("music_style"), colours: list("colours"),
    updated_by: withFilters(ref("row"), fl.get("updated_by", 0), fl.first_notnull(c.int(0))),
    updated_at: withFilters(ref("row"), fl.get("updated_at", c.null())),
    images: ref("images"), voices: c.array(BRAND_VOICES),
  },
  responseShape: {} as BrandKit,
});

export const saveKitFn = defineFunction({
  name: "brand/save",
  description: "Save the brand kit's words, default voice, music style and colours. Needs recipes.manage. Reference images are added one at a time.",
  input: {
    actor_id: input.int({ required: true }),
    voice: input.text({ methods: ["trim"] }),
    avoid_words: input.json(),
    visual_rules: input.text({ methods: ["trim"] }),
    default_voice: input.text({ methods: ["trim"] }),
    voice_style: input.text({ methods: ["trim"] }),
    music_style: input.text({ methods: ["trim"] }),
    colours: input.json(),
  },
  stack: [
    ...actor("recipes.manage", KIT_WORDS.saveDenied),
    s.set_var("voice", withFilters(inp("voice"), fl.first_notnull(c.text("")))),
    s.set_var("visual_rules", withFilters(inp("visual_rules"), fl.first_notnull(c.text("")))),
    s.set_var("default_voice", withFilters(inp("default_voice"), fl.first_notnull(c.text("")))),
    s.set_var("voice_style", withFilters(inp("voice_style"), fl.first_notnull(c.text("")))),
    s.set_var("music_style", withFilters(inp("music_style"), fl.first_notnull(c.text("")))),
    guard.require([
      expr(withFilters(ref("voice"), fl.strlen()), "<=", c.int(KIT_LIMITS.words)), expr(withFilters(ref("visual_rules"), fl.strlen()), "<=", c.int(KIT_LIMITS.words)),
      expr(withFilters(ref("voice_style"), fl.strlen()), "<=", c.int(KIT_LIMITS.style)), expr(withFilters(ref("music_style"), fl.strlen()), "<=", c.int(KIT_LIMITS.style)),
    ], { errorType: "badrequest", message: KIT_WORDS.tooLong }),
    guard.require(expr(withFilters(c.array(["", ...BRAND_VOICES]), fl.in(ref("default_voice"))), "=", c.bool(true)), { errorType: "badrequest", message: KIT_WORDS.voice }),
    // Words to avoid: trimmed, empty ones dropped, each once.
    s.set_var("avoid", c.array([])),
    s.foreach({ list: withFilters(inp("avoid_words"), fl.safe_array()), as: "word", body: [
      s.set_var("one", withFilters(ref("word"), fl.to_text(), fl.trim())),
      guard.require(expr(withFilters(ref("one"), fl.strlen()), "<=", c.int(KIT_LIMITS.avoidChars)), { errorType: "badrequest", message: KIT_WORDS.avoid }),
      s.conditional({ when: [expr(ref("one"), "!=", c.text("")), expr(withFilters(ref("avoid"), fl.in(ref("one"))), "=", c.bool(false))], then: [
        s.array.push({ name: "avoid", value: ref("one") }),
      ] }),
    ] }),
    guard.require(expr(withFilters(ref("avoid"), fl.count()), "<=", c.int(KIT_LIMITS.avoid)), { errorType: "badrequest", message: KIT_WORDS.avoid }),
    // Colours: a name and a six-digit hex each, kept in upper case.
    s.set_var("colours", c.array([])),
    s.foreach({ list: withFilters(inp("colours"), fl.safe_array()), as: "colour", body: [
      s.set_var("hex", withFilters(ref("colour"), fl.get("hex", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.trim(), fl.upper())),
      s.set_var("colour_name", withFilters(ref("colour"), fl.get("name", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.trim())),
      guard.require([
        expr(withFilters(c.regex(/^#[0-9A-F]{6}$/), fl.regex_test(ref("hex"))), "=", c.bool(true)),
        expr(withFilters(ref("colour_name"), fl.strlen()), "<=", c.int(KIT_LIMITS.colourName)),
      ], { errorType: "badrequest", message: KIT_WORDS.colours }),
      s.array.push({ name: "colours", value: obj({ name: ref("colour_name"), hex: ref("hex") }) }),
    ] }),
    guard.require(expr(withFilters(ref("colours"), fl.count()), "<=", c.int(KIT_LIMITS.colours)), { errorType: "badrequest", message: KIT_WORDS.colours }),
    s.set_var("fields", obj({
      voice: ref("voice"), avoid_words: ref("avoid"), visual_rules: ref("visual_rules"), default_voice: ref("default_voice"),
      voice_style: ref("voice_style"), music_style: ref("music_style"), colours: ref("colours"), updated_by: inp("actor_id"), updated_at: c.now(),
    })),
    // One row: the first save makes it.
    s.db.query({ table: brand, sort: [{ sortBy: "id", dir: "asc" }], returnType: "single", output: ["id"], as: "kit" }),
    s.set_var("kit_id", withFilters(ref("kit.id", { safe: true }), fl.first_notnull(c.int(0)))),
    s.conditional({ when: expr(ref("kit_id"), "=", c.int(0)), then: [
      s.db.add({ table: brand, row: { voice: c.text("") }, as: "made" }), s.update_var("kit_id", ref("made.id")),
    ] }),
    s.db.patch({ table: brand, fieldValue: ref("kit_id"), data: ref("fields") }),
    changed({ entity: "brand", id: ref("kit_id"), op: "updated", verb: "updated", title: c.text("the brand kit"), link: "/brand", actor: inp("actor_id") }),
    s.function.run({ fn: readKitFn, as: "kit_now", input: { actor_id: inp("actor_id") } }),
  ],
  response: ref("kit_now"),
  responseShape: {} as BrandKit,
});

export const addImageFn = defineFunction({
  name: "brand/add_image",
  description: "Add a reference image (PNG, JPEG or WebP, up to 2 MB) to the brand kit. It's sent with image runs that use the kit. Three at most.",
  input: { actor_id: input.int({ required: true }), file: input.file() },
  stack: [
    ...actor("recipes.manage", KIT_WORDS.saveDenied),
    guard.require(expr(inp("file"), "!=", c.null()), { errorType: "badrequest", message: KIT_WORDS.noImage }),
    s.db.query({ table: brand_image, returnType: "count", as: "held" }),
    guard.require(expr(ref("held"), "<", c.int(REFERENCE_LIMIT)), { errorType: "badrequest", message: KIT_WORDS.full }),
    s.storage.read_file_resource({ value: inp("file"), as: "upload" }),
    s.set_var("mime", withFilters(ref("upload.mime"), fl.first_notnull(c.text("")), fl.to_text(), fl.lower())),
    s.set_var("size", withFilters(ref("upload.size"), fl.first_notnull(c.int(0)), fl.to_int())),
    guard.require(expr(withFilters(c.array(IMAGE_TYPES), fl.in(ref("mime"))), "=", c.bool(true)), { errorType: "badrequest", message: KIT_WORDS.imageType }),
    guard.require(expr(ref("size"), "<=", c.int(KIT_LIMITS.imageBytes)), { errorType: "badrequest", message: KIT_WORDS.imageSize }),
    s.set_var("name", withFilters(ref("upload.name"), fl.first_notnull(c.text("")), fl.to_text(), fl.trim())),
    s.conditional({ when: expr(ref("name"), "=", c.text("")), then: [s.update_var("name", c.text("reference image"))] }),
    s.db.add({ table: brand_image, as: "added", row: {
      name: ref("name"), mime: ref("mime"), size: ref("size"), data: withFilters(ref("upload.data"), fl.base64_encode()), added_by: inp("actor_id"),
    } }),
    changed({ entity: "brand", id: ref("added.id"), op: "updated", verb: "added a reference image to", title: c.text("the brand kit"), link: "/brand", actor: inp("actor_id") }),
  ],
  response: { id: ref("added.id"), created_at: ref("added.created_at"), name: ref("added.name"), mime: ref("added.mime"), size: ref("added.size"), added_by: ref("added.added_by") },
  responseShape: {} as BrandImage,
});

export const removeImageFn = defineFunction({
  name: "brand/remove_image",
  description: "Remove a reference image from the brand kit. Runs already sent keep what they were sent.",
  input: { actor_id: input.int({ required: true }), id: input.int({ required: true }) },
  stack: [
    ...actor("recipes.manage", KIT_WORDS.saveDenied),
    s.db.get({ table: brand_image, fieldValue: inp("id"), output: ["id"], as: "image" }),
    guard.found("image", { errorType: "notfound", message: KIT_WORDS.gone }),
    s.db.del({ table: brand_image, fieldValue: inp("id") }),
    changed({ entity: "brand", id: inp("id"), op: "updated", verb: "removed a reference image from", title: c.text("the brand kit"), link: "/brand", actor: inp("actor_id") }),
  ],
  response: { removed: c.bool(true) },
  responseShape: {} as { removed: boolean },
});

/** One reference image's bytes, as a data URL the page can show and download. */
export const imageDataFn = defineFunction({
  name: "brand/image_data",
  description: "A reference image as a data URL, for the brand kit page to show and download.",
  input: { actor_id: input.int({ required: true }), id: input.int({ required: true }) },
  stack: [
    ...actor("studio.run", KIT_WORDS.readDenied),
    s.db.get({ table: brand_image, fieldValue: inp("id"), output: ["id", "name", "mime", "data"], as: "image" }),
    guard.found("image", { errorType: "notfound", message: KIT_WORDS.gone }),
  ],
  response: {
    name: ref("image.name"),
    url: withFilters(c.text("data:"), fl.concat(ref("image.mime")), fl.concat(c.text(";base64,")), fl.concat(ref("image.data"))),
  },
  responseShape: {} as { name: string; url: string },
});
