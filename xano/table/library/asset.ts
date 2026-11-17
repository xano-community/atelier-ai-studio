import { f, table } from "@xano/sdk";
import { user } from "../user.js";
import { ai_run } from "../studio/ai_run.js";
import { ai_step } from "../studio/ai_step.js";

export const ASSET_KINDS = ["text", "image", "video", "music", "speech", "transcript"] as const;
export const ASSET_STATES = ["draft", "approved"] as const;

/**
 * Something AI made, kept with how it was made: the prompt, model, settings and inputs, who made it and when, what it
 * was estimated to cost, and the run and step it came from. It starts as a draft. Files are private: a screen asks for a
 * 60-second link to show one.
 */
export const asset = table({
  name: "asset",
  description: "A library item AI made, with its provenance: prompt, model, settings, inputs, maker, cost, run and step.",
  schema: {
    kind: f.enum(ASSET_KINDS, { required: true }),
    title: f.text(),
    /** The prompt as the person wrote it, and as it was sent (with the brand kit, when added). */
    prompt: f.text(),
    sent_prompt: f.text(),
    model: f.text({ required: true }),
    /** What the call was asked for: sizes, durations, voice, token caps. */
    settings: f.json(),
    /** The files and earlier outputs it was made from: names, sizes and types, never the files themselves. */
    inputs: f.json(),
    /** The stored file ({ path, name, mime, size, meta }), private. Empty for text. */
    file: f.json(),
    /** The words, for text and transcripts. */
    body: f.text(),
    maker_id: f.tableRef(user, { required: true }),
    /** Micro-dollars: what the call that made it was charged. */
    estimated_cost: f.int(),
    brand_applied: f.bool(),
    run_id: f.tableRef(ai_run, { required: true }),
    step_id: f.tableRef(ai_step, { required: true }),
    attempt: f.int(),
    /** A private run's output is seen by its maker and admins only, until it's saved to the library. */
    private: f.bool(),
    status: f.enum(ASSET_STATES, { default: "draft" }),
    approved_by: f.int(),
    approved_at: f.timestamp({ nullable: true }),
    is_demo: f.bool(),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "step_id", op: "asc" }, { name: "attempt", op: "asc" }] },
    { type: "btree", fields: [{ name: "maker_id", op: "asc" }, { name: "created_at", op: "desc" }] },
    { type: "btree", fields: [{ name: "status", op: "asc" }, { name: "created_at", op: "desc" }] },
  ],
});
