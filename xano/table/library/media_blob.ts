import { f, table } from "@xano/sdk";

/**
 * A made image or recording kept in a table, for a server that can't sign private links (the Xano Engine on a machine). Its
 * bytes are base64, behind an authed route that asks the same read rule as the item or source it belongs to. A server
 * that can sign keeps files in private storage instead, and never writes here.
 */
export const media_blob = table({
  name: "media_blob",
  description: "An image or recording kept in a table where private links can't be signed: its name, type, size and bytes.",
  schema: {
    name: f.text({ required: true }),
    mime: f.text({ required: true }),
    size: f.int({ required: true }),
    /** The bytes, base64. Read only by the media route, after the read rule passes. */
    b64: f.text({ required: true, access: "private" }),
    /** What made it: a run's step and attempt, or a Knowledge recording. */
    run_id: f.int(),
    step_id: f.int(),
    attempt: f.int(),
    source_id: f.int(),
    is_demo: f.bool(),
  },
  index: [
    { type: "btree", fields: [{ name: "step_id", op: "asc" }, { name: "attempt", op: "asc" }] },
    { type: "btree", fields: [{ name: "source_id", op: "asc" }] },
  ],
});
