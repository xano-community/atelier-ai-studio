// The brand kit, added to what a step sends when the step asks for it (`use_brand: true`). Text gets the voice and the
// words to avoid as instructions; images and video get the visual rules and the palette after the prompt; an image also
// gets the kit's reference images after the person's own, while the model's limit leaves room; speech gets the default
// voice and its style when the step names none; music gets the house style. The step records whether anything was
// added, so the run page can say so.
import { c, defineFunction, expr, fl, inp, input, ref, s, withFilters, type Value } from "@xano/sdk";
import { brand, brand_image } from "../../table/studio/brand.js";

/** How many images an image model takes in one call, the person's own and the kit's together. */
export const IMAGE_INPUT_LIMIT = 14;
/** How many reference images the kit holds, and so sends at most. */
export const REFERENCE_LIMIT = 3;

const text = (path: string) => withFilters(ref("kit"), fl.get(path, ""), fl.first_notnull(c.text("")), fl.to_text(), fl.trim());
const list = (path: string) => withFilters(ref("kit"), fl.get(path, c.null()), fl.safe_array());
const filled = (name: string) => expr(withFilters(ref(name), fl.empty()), "=", c.bool(false));

export const composeFn = defineFunction({
  name: "brand/compose",
  description: "Add the brand kit to a step's prompt, instructions or voice when the step asks for it, and say whether it was added.",
  input: {
    kind: input.text({ required: true }),
    /** The step's input: prompt, system, text, voice, instructions, use_brand. */
    asked: input.json(),
  },
  stack: [
    s.set_var("asked", withFilters(inp("asked"), fl.first_notnull(c.obj({})))),
    s.set_var("prompt", withFilters(ref("asked"), fl.get("prompt", ""), fl.first_notnull(c.text("")), fl.to_text())),
    s.set_var("system", withFilters(ref("asked"), fl.get("system", ""), fl.first_notnull(c.text("")), fl.to_text())),
    s.set_var("voice", withFilters(ref("asked"), fl.get("voice", ""), fl.first_notnull(c.text("")), fl.to_text())),
    s.set_var("instructions", withFilters(ref("asked"), fl.get("instructions", ""), fl.first_notnull(c.text("")), fl.to_text())),
    s.set_var("applied", c.bool(false)),
    // Reference images go out as files made again from their kept bytes (see brand_image), after the step's own.
    s.set_var("references", c.array([])),
    s.set_var("reference_names", c.array([])),
    s.conditional({ when: expr(withFilters(ref("asked"), fl.get("use_brand", false), fl.first_notnull(c.bool(false))), "=", c.bool(true)), then: [
      s.conditional({ when: expr(inp("kind"), "=", c.text("image")), then: [
        s.set_var("room", withFilters(c.int(IMAGE_INPUT_LIMIT), fl.sub(withFilters(ref("asked"), fl.get("images", c.null()), fl.first_notnull(c.array([])), fl.count())))),
        s.conditional({ when: expr(ref("room"), ">", c.int(0)), then: [
          s.db.query({ table: brand_image, sort: [{ sortBy: "id", dir: "asc" }], output: ["id", "name", "mime", "data"], paging: { per_page: REFERENCE_LIMIT, metadata: false }, as: "kept_images" }),
          s.foreach({ list: ref("kept_images"), as: "kept", body: [
            s.conditional({ when: expr(withFilters(ref("references"), fl.count()), "<", ref("room")), then: [
              // Named by its id, not the name it was added with, which may hold characters a file name can't.
              s.set_var("reference_file", withFilters(c.text("brand-reference-"), fl.concat(ref("kept.id")), fl.concat(c.text(".")),
                fl.concat(withFilters(ref("kept.mime"), fl.split("/"), fl.last(), fl.string_replace("jpeg", "jpg"))))),
              s.storage.create_file_resource({ filename: ref("reference_file"), filedata: withFilters(ref("kept.data"), fl.base64_decode()), as: "reference" }),
              s.array.push({ name: "references", value: ref("reference") }),
              s.array.push({ name: "reference_names", value: ref("kept.name") }),
            ] }),
          ] }),
          s.conditional({ when: expr(withFilters(ref("references"), fl.count()), ">", c.int(0)), then: [s.update_var("applied", c.bool(true))] }),
        ] }),
      ] }),
      s.db.query({ table: brand, sort: [{ sortBy: "id", dir: "asc" }], returnType: "single", as: "kit" }),
      s.conditional({ when: expr(ref("kit"), "!=", c.null()), then: [
        s.set_var("brand_voice", text("voice")),
        s.set_var("visual_rules", text("visual_rules")),
        s.set_var("music_style", text("music_style")),
        s.set_var("default_voice", text("default_voice")),
        s.set_var("voice_style", text("voice_style")),
        s.set_var("avoid", withFilters(list("avoid_words"), fl.filter_empty_text(), fl.join(", "))),
        s.array.map({ source: list("colours"), as: "colour_names", transform: withFilters(ref("$this"), fl.get("name", ""), fl.first_notnull(c.text(""))) }),
        s.set_var("palette", withFilters(ref("colour_names"), fl.filter_empty_text(), fl.join(", "))),
        s.switch({ on: inp("kind"), cases: [
          { when: c.text("text"), break: true, body: [
            s.set_var("rules", c.text("")),
            s.conditional({ when: filled("brand_voice"), then: [s.update_var("rules", withFilters(c.text("Write in the brand's voice: "), fl.concat(ref("brand_voice"))))] }),
            s.conditional({ when: filled("avoid"), then: [s.update_var("rules", withFilters(ref("rules"), fl.concat(c.text("\nNever use these words: ")), fl.concat(ref("avoid")), fl.concat(c.text(".")), fl.trim()))] }),
            s.conditional({ when: filled("rules"), then: [
              s.conditional({
                when: filled("system"),
                then: [s.update_var("system", withFilters(ref("system"), fl.concat(c.text("\n\n")), fl.concat(ref("rules"))))],
                else: [s.update_var("system", ref("rules"))],
              }),
              s.update_var("applied", c.bool(true)),
            ] }),
          ] },
          ...["image", "video"].map((kind) => ({ when: c.text(kind), break: true, body: [
            s.set_var("look", c.text("")),
            s.conditional({ when: filled("visual_rules"), then: [s.update_var("look", withFilters(c.text("Brand look: "), fl.concat(ref("visual_rules"))))] }),
            s.conditional({ when: filled("palette"), then: [s.update_var("look", withFilters(ref("look"), fl.concat(c.text(" Brand colours: ")), fl.concat(ref("palette")), fl.concat(c.text(".")), fl.trim()))] }),
            s.conditional({ when: filled("look"), then: [
              s.update_var("prompt", withFilters(ref("prompt"), fl.concat(c.text("\n\n")), fl.concat(ref("look")))),
              s.update_var("applied", c.bool(true)),
            ] }),
          ] })),
          { when: c.text("speech"), break: true, body: [
            s.conditional({ when: [filled("default_voice"), expr(ref("voice"), "=", c.text(""))], then: [s.update_var("voice", ref("default_voice")), s.update_var("applied", c.bool(true))] }),
            s.conditional({ when: [filled("voice_style"), expr(ref("instructions"), "=", c.text(""))], then: [s.update_var("instructions", ref("voice_style")), s.update_var("applied", c.bool(true))] }),
          ] },
          { when: c.text("music"), break: true, body: [
            s.conditional({ when: filled("music_style"), then: [
              s.update_var("prompt", withFilters(ref("prompt"), fl.concat(c.text("\n\nStyle: ")), fl.concat(ref("music_style")))),
              s.update_var("applied", c.bool(true)),
            ] }),
          ] },
        ] }),
      ] }),
    ] }),
  ],
  response: {
    prompt: ref("prompt"), system: ref("system"), voice: ref("voice"), instructions: ref("instructions"), applied: ref("applied"),
    references: ref("references"), reference_names: ref("reference_names"),
  },
  responseShape: {} as {
    prompt: string; system: string; voice: string; instructions: string; applied: boolean;
    /** Files made from the kit's reference images, sent after the step's own images. */
    references: unknown[]; reference_names: string[];
  },
});

/** Run compose for the step in `step`/`asked`, binding `composed`. */
export const composeStep = (kind: string, mock?: Record<string, Value>) =>
  s.function.run({ fn: composeFn, as: "composed", input: { kind: c.text(kind), asked: ref("asked") }, ...(mock && Object.keys(mock).length ? { mock } : {}) });
