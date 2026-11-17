import { f, table } from "@xano/sdk";
import { recipe } from "./recipe.js";

export const RECIPE_STEP_KINDS = ["text", "image", "video", "music", "speech", "transcribe"] as const;

/**
 * One step of a recipe, in order: one AI statement with its model, settings and prompt. The prompt names what it uses
 * with {{input.name}} and {{step.N}}; `depends_on` is worked out from those references when the recipe is saved.
 */
export const recipe_step = table({
  name: "recipe_step",
  description: "One step of a recipe: its kind, model, prompt template, file, settings, and the earlier steps it uses.",
  schema: {
    recipe_id: f.tableRef(recipe, { required: true }),
    /** Its place in the recipe, from 1. */
    seq: f.int({ required: true }),
    name: f.text({ required: true }),
    kind: f.enum(RECIPE_STEP_KINDS, { required: true }),
    model: f.text({ required: true }),
    /** The words, with references: a text or media prompt, a speech step's words, a transcription hint. */
    prompt: f.text(),
    /** One reference to the step's file: an image to edit or start from, a file to read, a recording. Empty for none. */
    file: f.text(),
    /** What's sent besides the prompt: system, response_format, json_schema, voice, instructions, negative_prompt, use_brand. */
    settings: f.json(),
    /** What the estimate prices: output_tokens, size, aspect_ratio, seconds, resolution, audio. */
    options: f.json(),
    /** The earlier steps (by seq) its references use. */
    depends_on: f.json(),
  },
  index: [
    { type: "btree", fields: [{ name: "recipe_id", op: "asc" }, { name: "seq", op: "asc" }] },
  ],
});
