// The brand kit: who may read and change it, what a save keeps, and what compose adds to each kind of step with the kit
// on and leaves out with it off. Expected words are written here, never read from the kit's code.
import { c, cmp, col, fl, ref, s, withFilters, type Statement } from "@xano/sdk";
import { brand_image } from "../table/studio/brand.js";
import { user } from "../table/user.js";
import { composeFn } from "../function/brand/compose.js";
import { addImageFn, readKitFn, removeImageFn, saveKitFn } from "../function/brand/kit.js";
import { equal, is, num, person, plainTest, says, settings, workflowTest } from "./fixtures.js";

/** A 1×1 PNG and a short text file, as base64. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const TXT = "aGVsbG8=";

const KIT = {
  voice: "Plain, warm and a little dry. Short sentences.",
  avoid_words: ["game-changer", "unleash", "epic"],
  visual_rules: "Natural light, real places, no lens flare.",
  default_voice: "Kore",
  voice_style: "Calm, friendly, medium pace",
  music_style: "Warm indie, around 100 bpm, no vocals",
  colours: [{ name: "Fern", hex: "#4a6b57" }, { name: "Oat", hex: "#E8DCC8" }],
};

const save = (as: string, who: string, kit: Record<string, unknown> = KIT) => s.function.run({ fn: saveKitFn, as, input: {
  actor_id: ref(`${who}.id`), voice: c.text(String(kit.voice ?? "")), avoid_words: c.array((kit.avoid_words ?? []) as never), visual_rules: c.text(String(kit.visual_rules ?? "")),
  default_voice: c.text(String(kit.default_voice ?? "")), voice_style: c.text(String(kit.voice_style ?? "")), music_style: c.text(String(kit.music_style ?? "")),
  colours: c.array((kit.colours ?? []) as never),
} });
const compose = (as: string, kind: string, asked: Record<string, unknown>) =>
  s.function.run({ fn: composeFn, as, input: { kind: c.text(kind), asked: c.obj(asked as never) } });
const addImage = (as: string, who: string, name: string, data = PNG) => [
  s.storage.create_file_resource({ filename: c.text(name), filedata: withFilters(c.text(data), fl.base64_decode()), as: `${as}_file` }),
  s.function.run({ fn: addImageFn, as, input: { actor_id: ref(`${who}.id`), file: ref(`${as}_file`) } }),
];
/** The body of an expect.to_throw runs on its own variables, so it finds the person by role itself. */
const findRole = (as: string, role: string) => s.db.query({ table: user, where: cmp(col("role"), "=", c.text(role)), returnType: "single", as });
const refused = (words: string, body: Statement[]) => s.expect.to_throw({ exception: c.text(words), body });
const yes = (path: string) => s.expect.to_be_true({ expr: ref(path) });
const no = (path: string) => s.expect.to_be_false({ expr: ref(path) });
const size = (as: string, path: string) => s.set_var(as, withFilters(ref(path), fl.safe_array(), fl.count()));

export const brandTests = [
  workflowTest({
    name: "brand: a member saves the kit and everyone who runs models reads it back; a guest can neither read nor change it",
    stack: [
      settings(), person("sam"), person("jordan", "admin"), person("alex", "guest"),
      save("saved", "sam"),
      is("saved.voice", KIT.voice), is("saved.default_voice", "Kore"), is("saved.music_style", KIT.music_style),
      equal("saved.avoid_words", c.array(["game-changer", "unleash", "epic"])),
      // Hex values are kept in upper case.
      equal("saved.colours", c.array([{ name: "Fern", hex: "#4A6B57" }, { name: "Oat", hex: "#E8DCC8" }] as never)),
      equal("saved.updated_by", ref("sam.id")),
      s.function.run({ fn: readKitFn, as: "read", input: { actor_id: ref("jordan.id") } }),
      is("read.voice", KIT.voice), is("read.visual_rules", KIT.visual_rules),
      refused("Guests can't see the brand kit", [findRole("guest", "guest"), s.function.run({ fn: readKitFn, as: "peek", input: { actor_id: ref("guest.id") } })]),
      refused("can't change it", [findRole("guest", "guest"), save("guest_save", "guest", { voice: "Loud" })]),
      // The guest's attempt changed nothing.
      s.function.run({ fn: readKitFn, as: "after", input: { actor_id: ref("sam.id") } }),
      is("after.voice", KIT.voice),
    ],
  }),

  workflowTest({
    name: "brand: a save cleans the words to avoid, and refuses a bad colour, a seventh colour or a voice no model offers",
    stack: [
      settings(), person("sam"),
      save("tidy", "sam", { ...KIT, avoid_words: ["  epic ", "", "epic", "unleash"] }),
      equal("tidy.avoid_words", c.array(["epic", "unleash"])),
      refused("hex value like #4A6B57", [findRole("sam", "member"), save("bad_hex", "sam", { ...KIT, colours: [{ name: "Fern", hex: "green" }] })]),
      refused("Add up to 6 colours", [findRole("sam", "member"), save("seven", "sam", { ...KIT, colours: Array.from({ length: 7 }, (_, i) => ({ name: `C${i}`, hex: "#111111" })) })]),
      refused("isn't one Xano AI's speech models offer", [findRole("sam", "member"), save("no_voice", "sam", { ...KIT, default_voice: "Gandalf" })]),
      // An empty default voice is allowed: speech then uses the model's own.
      save("cleared", "sam", { ...KIT, default_voice: "" }),
      is("cleared.default_voice", ""),
    ],
  }),

  plainTest({
    name: "brand: with the kit on, text gets the voice and the words to avoid; with it off, the step goes as written",
    stack: [
      settings(), person("sam"), save("saved", "sam"),
      compose("on", "text", { prompt: "Write the Trail 2 intro", system: "You write product pages.", use_brand: true }),
      yes("on.applied"),
      says("on.system", "You write product pages."), says("on.system", "Plain, warm and a little dry."), says("on.system", "game-changer, unleash, epic"),
      is("on.prompt", "Write the Trail 2 intro"),
      compose("off", "text", { prompt: "Write the Trail 2 intro", system: "You write product pages.", use_brand: false }),
      no("off.applied"), is("off.system", "You write product pages."), is("off.prompt", "Write the Trail 2 intro"),
      // A step that doesn't say is treated as off.
      compose("unsaid", "text", { prompt: "Write the Trail 2 intro" }),
      no("unsaid.applied"), is("unsaid.system", ""),
    ],
  }),

  plainTest({
    name: "brand: image and video prompts get the visual rules and colours, speech and music get their defaults, and none with the kit off",
    stack: [
      settings(), person("sam"), save("saved", "sam"),
      compose("video", "video", { prompt: "A slow pan across the workshop", use_brand: true }),
      yes("video.applied"), says("video.prompt", "A slow pan across the workshop"), says("video.prompt", "Natural light, real places"), says("video.prompt", "Fern, Oat"),
      compose("video_off", "video", { prompt: "A slow pan across the workshop", use_brand: false }),
      no("video_off.applied"), is("video_off.prompt", "A slow pan across the workshop"),
      compose("image", "image", { prompt: "The Trail 2 on oak", use_brand: true }),
      yes("image.applied"), says("image.prompt", "Natural light, real places"),
      // Text rules stay out of pictures.
      s.set_var("image_has_text_rules", withFilters(ref("image.prompt"), fl.contains("game-changer"))), no("image_has_text_rules"),
      compose("speech", "speech", { text: "Meet the Trail 2.", use_brand: true }),
      yes("speech.applied"), is("speech.voice", "Kore"), is("speech.instructions", KIT.voice_style),
      compose("speech_own", "speech", { text: "Meet the Trail 2.", voice: "Puck", instructions: "Bright", use_brand: true }),
      is("speech_own.voice", "Puck"), is("speech_own.instructions", "Bright"),
      compose("speech_off", "speech", { text: "Meet the Trail 2.", use_brand: false }),
      no("speech_off.applied"), is("speech_off.voice", ""), is("speech_off.instructions", ""),
      compose("music", "music", { prompt: "A launch theme", use_brand: true }),
      yes("music.applied"), says("music.prompt", "A launch theme"), says("music.prompt", "Warm indie, around 100 bpm"),
      compose("music_off", "music", { prompt: "A launch theme", use_brand: false }),
      no("music_off.applied"), is("music_off.prompt", "A launch theme"),
    ],
  }),

  plainTest({
    name: "brand: reference images go after the person's own images, byte for byte, never past the model's 14",
    stack: [
      settings(), person("sam"),
      ...addImage("first", "sam", "oak-set.png"),
      ...addImage("second", "sam", "forest trail.png"),
      is("second.mime", "image/png"),
      compose("with_own", "image", { prompt: "The Trail 2 on oak", images: ["their-photo"], use_brand: true }),
      yes("with_own.applied"),
      size("sent", "with_own.references"), num("sent", 2),
      equal("with_own.reference_names", c.array(["oak-set.png", "forest trail.png"])),
      // What goes to the model is the image that was added, as a file of its own type.
      s.storage.read_file_resource({ value: withFilters(ref("with_own.references"), fl.first()), as: "back" }),
      equal("back.data", withFilters(c.text(PNG), fl.base64_decode())),
      is("back.mime", "image/png"),
      // Thirteen of their own leave room for one.
      compose("nearly_full", "image", { prompt: "x", images: Array.from({ length: 13 }, (_, i) => `photo-${i}`), use_brand: true }),
      size("one_more", "nearly_full.references"), num("one_more", 1),
      compose("full", "image", { prompt: "x", images: Array.from({ length: 14 }, (_, i) => `photo-${i}`), use_brand: true }),
      size("none", "full.references"), num("none", 0),
      compose("off", "image", { prompt: "x", use_brand: false }),
      size("off_sent", "off.references"), num("off_sent", 0), no("off.applied"),
      // Video takes one image, its first frame, so the kit's images never go to it.
      compose("video", "video", { prompt: "x", use_brand: true }),
      size("video_sent", "video.references"), num("video_sent", 0),
    ],
  }),

  workflowTest({
    name: "brand: the kit holds three PNG, JPEG or WebP images, a guest can't add one, and a removed one stops being sent",
    stack: [
      settings(), person("sam"), person("alex", "guest"),
      refused("can be PNG, JPEG or WebP", [findRole("sam", "member"), ...addImage("note", "sam", "note.txt", TXT)]),
      refused("can't change it", [findRole("guest", "guest"), ...addImage("theirs", "guest", "theirs.png")]),
      ...addImage("a", "sam", "a.png"), ...addImage("b", "sam", "b.png"), ...addImage("c", "sam", "c.png"),
      refused("holds 3 reference images", [findRole("sam", "member"), ...addImage("d", "sam", "d.png")]),
      s.function.run({ fn: removeImageFn, as: "gone", input: { actor_id: ref("sam.id"), id: ref("a.id") } }),
      compose("sent", "image", { prompt: "x", use_brand: true }),
      equal("sent.reference_names", c.array(["b.png", "c.png"])),
      s.db.query({ table: brand_image, returnType: "count", as: "left" }), num("left", 2),
    ],
  }),
];
