import { f, table } from "@xano/sdk";
import { ai_run } from "../studio/ai_run.js";
import { user } from "../user.js";

export const SOURCE_KINDS = ["document", "recording"] as const;
export const SOURCE_FORMATS = ["pdf", "text", "markdown", "audio"] as const;
export const SOURCE_STATES = ["processing", "ready", "failed"] as const;

/**
 * One document or recording the team added to Knowledge. It's read and embedded once, by the `ingest` run that its upload
 * started, and every team member sees it. A failed source keeps the reason in plain words: the upload's file lasts only
 * about a day and can't be read back, so trying again means uploading it again.
 */
export const kb_source = table({
  name: "kb_source",
  description: "A document or recording in Knowledge: what it is, who added it, and whether it's processing, ready or failed and why.",
  schema: {
    title: f.text({ required: true }),
    kind: f.enum(SOURCE_KINDS, { required: true }),
    format: f.enum(SOURCE_FORMATS, { required: true }),
    /** The uploaded file's name, type and size in bytes. */
    file_name: f.text(),
    mime: f.text(),
    size: f.int(),
    /** A PDF's page count, when the file says it. */
    pages: f.int(),
    /** A recording's length in seconds, read from its transcript. */
    duration_s: f.int(),
    status: f.enum(SOURCE_STATES, { default: "processing" }),
    /** Plain words: what's happening, or why it failed and how to add it. */
    detail: f.text(),
    /** The run that reads and embeds it. */
    run_id: f.tableRef(ai_run),
    added_by: f.tableRef(user, { required: true }),
    /** How many passages it became, once ready. */
    passages: f.int(),
    /** Only embedding failed (a passing gateway error): what was read is kept, and the person who added it can retry. */
    can_retry: f.bool(),
    /** A recording kept privately so a citation can play from its moment ({ path, name, mime, size }). Empty for documents. */
    audio: f.json({ access: "private" }),
    ready_at: f.timestamp({ nullable: true }),
    is_demo: f.bool(),
  },
  index: [
    { type: "btree", fields: [{ name: "created_at", op: "desc" }] },
    { type: "btree", fields: [{ name: "run_id", op: "asc" }] },
    { type: "btree", fields: [{ name: "status", op: "asc" }] },
  ],
});
