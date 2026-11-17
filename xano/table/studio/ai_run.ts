import { f, table } from "@xano/sdk";
import { user } from "../user.js";

export const RUN_KINDS = ["playground", "recipe", "ask", "ingest", "easel", "check"] as const;
export const RUN_VIAS = ["ui", "api", "mcp", "easel"] as const;
/**
 * `starting` is the moment between the row and its decision. Nothing is reserved while a run is waiting for an admin or for
 * its owner's confirmation; `queued` holds a reservation for every step.
 */
export const RUN_STATES = [
  "starting", "waiting_approval", "needs_confirmation", "waiting_confirmation", "queued", "running",
  "done", "partial", "failed", "refused", "declined", "stopped",
] as const;
export const RUN_REASONS = ["", "no_price", "plan", "over_budget", "costly", "video", "declined", "expired", "interrupted", "timeout", "blocked", "model_error", "stopped", "access"] as const;
/** States a run doesn't leave. */
export const RUN_FINAL = ["done", "partial", "failed", "refused", "declined", "stopped"] as const;

/**
 * One request to make something with AI: a Playground run, a recipe run, an Ask, a knowledge upload, an admin's check that
 * AI answers again, or one of the assistant's turns. Its steps are `ai_step` rows, and its money is in the ledger.
 */
export const ai_run = table({
  name: "ai_run",
  description: "One request to make something with AI: who asked, from where, what it was estimated to cost, and how it ended.",
  schema: {
    owner_id: f.tableRef(user, { required: true }),
    kind: f.enum(RUN_KINDS, { required: true }),
    via: f.enum(RUN_VIAS, { default: "ui" }),
    /** The person's own agent connection it came through (an API key or MCP), or 0 from the app. */
    connection_id: f.int(),
    /** The caller's key for this request. A repeat with the same key returns this run instead of starting another. */
    idem_key: f.text({ required: true }),
    /** A fingerprint of what was asked, so the same key with a different request is refused. */
    body_hash: f.text({ access: "private" }),
    recipe_id: f.int(),
    /** What a recipe run was given, as the run page shows it: [{ name, label, type, value }], a file by its name. */
    inputs: f.json(),
    /** What it is, in a few words ("Image with Nano Banana 2"), for cards and approvals. */
    title: f.text(),
    status: f.enum(RUN_STATES, { default: "starting" }),
    reason: f.enum(RUN_REASONS, { default: "" }),
    /** Plain words about where it stands: why it's waiting, refused or failed, and what to do. */
    detail: f.text(),
    /** Micro-dollars: the estimate when it started, and what its steps were charged. */
    estimate: f.int(),
    spent: f.int(),
    /** A private run is seen only by its owner, and never announced to the team. */
    private: f.bool(),
    /** Where the background steps call back, captured in the request that started it. */
    base_url: f.text({ access: "private" }),
    /** The key of the last "Retry failed steps": the same click sent twice retries once. */
    retry_key: f.text({ access: "private" }),
    /** The approval it waits on, while it waits. */
    approval_id: f.int(),
    finished_at: f.timestamp({ nullable: true }),
    is_demo: f.bool(),
    /** The demo's sample run: its outputs were made before the deploy, and the minute sweep ends it with no model call. */
    sample: f.bool(),
  },
  index: [
    { type: "btree|unique", fields: [{ name: "owner_id", op: "asc" }, { name: "idem_key", op: "asc" }] },
    { type: "btree", fields: [{ name: "owner_id", op: "asc" }, { name: "created_at", op: "desc" }] },
    { type: "btree", fields: [{ name: "status", op: "asc" }, { name: "created_at", op: "asc" }] },
    { type: "btree", fields: [{ name: "approval_id", op: "asc" }] },
  ],
});
