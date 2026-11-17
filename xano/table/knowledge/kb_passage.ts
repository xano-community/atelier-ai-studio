import { f, table } from "@xano/sdk";
import { kb_source } from "./kb_source.js";

/** The embedding size: gemini-embedding-2 at 768 dimensions. */
export const KB_DIMENSIONS = 768;

/**
 * One passage of a source: a few paragraphs of a document, or a stretch of a recording with its start time and speaker.
 * Its embedding is searched by cosine distance. Only passages of a ready source are `live`, so a source that's still
 * processing, or failed halfway, never answers a question.
 */
export const kb_passage = table({
  name: "kb_passage",
  description: "A passage of a Knowledge source, with where it is (page, or start time and speaker) and its embedding.",
  schema: {
    source_id: f.tableRef(kb_source, { required: true }),
    /** Its place in the source, from 1. */
    seq: f.int({ required: true }),
    text: f.text({ required: true }),
    /** The PDF page it's on, or 0. */
    page: f.int(),
    /** Where it starts in a recording, in seconds, or -1. */
    start_s: f.int({ default: -1 }),
    /** "Speaker 2", when the recording's transcript names one. */
    speaker: f.text(),
    /** The seq of the embedding step that embeds it. */
    batch: f.int(),
    embedding: f.vector(KB_DIMENSIONS),
    /** True once its source is ready: only live passages are searched. */
    live: f.bool(),
  },
  index: [
    { type: "vector", fields: [{ name: "embedding", op: "vector_cosine_ops" }] },
    { type: "btree", fields: [{ name: "source_id", op: "asc" }, { name: "seq", op: "asc" }] },
    { type: "btree", fields: [{ name: "source_id", op: "asc" }, { name: "batch", op: "asc" }] },
    { type: "btree", fields: [{ name: "live", op: "asc" }] },
  ],
});
