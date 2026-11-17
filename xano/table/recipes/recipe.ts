import { f, table } from "@xano/sdk";
import { user } from "../user.js";

export const RECIPE_STATES = ["draft", "published"] as const;
export const RECIPE_INPUT_TYPES = ["text", "long_text", "image", "audio", "file", "knowledge"] as const;

/**
 * Which step kind a recipe is shown as, most defining first: a launch kit with copy, a picture and a video reads as video,
 * not as its first (text) step. Video costs the most and takes longest, so it leads.
 */
export const LEAD_ORDER = ["video", "image", "music", "speech", "transcribe", "text"] as const;
/** The kind a recipe with these step kinds is shown as. */
export const leadKind = (kinds: readonly string[]) => LEAD_ORDER.find((k) => kinds.includes(k)) ?? kinds[0] ?? "";

/**
 * A saved, named setup: an input form and one or more steps, each step able to use the inputs and earlier steps' outputs.
 * Anyone but a guest runs a published one, from the app, with an API key, or through an agent. Its steps are
 * `recipe_step` rows, in order.
 */
export const recipe = table({
  name: "recipe",
  description: "A saved setup of AI steps with an input form: who made it, whether it's published, and what a run is estimated to cost.",
  schema: {
    /** The address its API call uses: /recipes/{slug}/run. Set once, from the first name. */
    slug: f.text({ required: true }),
    name: f.text({ required: true }),
    description: f.text(),
    status: f.enum(RECIPE_STATES, { default: "draft" }),
    /** The form a run fills: [{ name, label, type, required, hint }]. */
    inputs: f.json(),
    /** What a run is estimated to cost with every input at its longest, in micro-dollars, as of the last save. */
    estimate: f.int(),
    step_count: f.int(),
    /** The kind that defines it, for the list's icon: its first step of the first kind in LEAD_ORDER. */
    lead_kind: f.text(),
    created_by: f.tableRef(user, { required: true }),
    updated_by: f.tableRef(user),
    updated_at: f.timestamp({ nullable: true }),
    is_demo: f.bool(),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "slug", op: "asc" }] },
    { type: "btree", fields: [{ name: "name", op: "asc" }] },
  ],
});
