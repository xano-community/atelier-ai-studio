import { f, table } from "@xano/sdk";
import { ai_run } from "./ai_run.js";

export const STEP_KINDS = ["text", "image", "video", "speech", "transcribe", "embedding", "music", "rerank"] as const;
export const STEP_STATES = ["queued", "working", "succeeded", "blocked", "failed", "timed_out", "skipped", "released"] as const;
/** States a step ends in. */
export const STEP_FINAL = ["succeeded", "blocked", "failed", "timed_out", "skipped", "released"] as const;
/** The step outcomes a model call can report. */
export const STEP_OUTCOMES = ["succeeded", "blocked", "failed", "timed_out"] as const;

/** One model call in a run, in listed order. Its reservation is a ledger row for (step, attempt). */
export const ai_step = table({
  name: "ai_step",
  description: "One model call in a run: what it asks, where it stands, what it made and what it cost.",
  schema: {
    run_id: f.tableRef(ai_run, { required: true }),
    /** Its place in the run, from 1. */
    seq: f.int({ required: true }),
    /** Its name on the run page ("Hero image"), when the run came from a recipe. */
    label: f.text(),
    kind: f.enum(STEP_KINDS, { required: true }),
    model: f.text({ required: true }),
    /** What's sent to the model (the prompt and any references), as the wrapper will send it. */
    input: f.json(),
    /** What the estimate reads: sizes, durations, token caps, samples. */
    options: f.json(),
    /** The seq numbers of earlier steps it needs. When one of them doesn't succeed, this one is skipped. */
    depends_on: f.json(),
    /** A step the run can do without (a rerank): its failure doesn't skip the steps after it. */
    optional: f.bool(),
    status: f.enum(STEP_STATES, { default: "queued" }),
    /** A short reason: "blocked", "timeout", "interrupted", "model_error", "stopped". */
    reason: f.text(),
    /** Plain words for the person, never a key or a raw error. */
    detail: f.text(),
    /** Bumped by a retry, which reserves again under the new attempt. */
    attempt: f.int({ default: 1 }),
    /** How long the call may take once sent, in seconds. The sweep adds a minute's grace. */
    timeout_s: f.int(),
    /** 0 until a request takes this attempt, then 1: the take is a guarded update, so two requests can't both run it. */
    claimed: f.int(),
    claimed_at: f.timestamp({ nullable: true }),
    /** Committed before the gateway call: from here on the call can be charged even if nobody hears back. */
    sent_at: f.timestamp({ nullable: true }),
    finished_at: f.timestamp({ nullable: true }),
    output: f.json(),
    /** What the gateway reported: tokens, seconds. Music reports nothing. */
    usage: f.json(),
    /** Micro-dollars: reserved before the call, and charged after it. */
    estimate: f.int(),
    charged: f.int(),
    /** Whether the brand kit was added to what was sent. */
    brand_applied: f.bool(),
    /** The library item its output became, or 0. */
    asset_id: f.int(),
  },
  index: [
    { type: "btree", fields: [{ name: "run_id", op: "asc" }, { name: "seq", op: "asc" }] },
    { type: "btree", fields: [{ name: "status", op: "asc" }] },
  ],
});
