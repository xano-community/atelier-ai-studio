// Knowledge's endpoints: the team's sources and Ask. Everyone on the team, guests included, sees every source and may
// ask; adding and removing sources needs `knowledge.manage`. Each door is thin: adding is knowledge/add and asking is
// knowledge/ask, the same functions the assistant and agents will call, so the spend gate and roles apply the same way.
import { apiGroup, auth, c, cmp, col, cond, expr, fl, guard, inp, input, obj, query, ref, s, sys, withFilters } from "@xano/sdk";
import { changed } from "../base/index.js";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { kb_passage } from "../table/knowledge/kb_passage.js";
import { kb_source } from "../table/knowledge/kb_source.js";
import { media_blob } from "../table/library/media_blob.js";
import { ai_run } from "../table/studio/ai_run.js";
import { ai_step } from "../table/studio/ai_step.js";
import { askFn, recentQuestionsFn, type AskView, type AskedView } from "../function/knowledge/ask.js";
import { addSourceFn, retrySourceFn } from "../function/knowledge/ingest.js";
import { mediaLinkFn } from "../function/library/media.js";

export const knowledgeGroup = apiGroup({ name: "knowledge", canonical: "knowledge", description: "Knowledge: the team's sources, and Ask with citations." });

const SOURCE_FIELDS = ["id", "created_at", "title", "kind", "format", "file_name", "size", "pages", "duration_s", "status", "detail", "run_id", "added_by", "passages", "can_retry", "ready_at", "audio"] as const;
/** How long a recording's playback link lasts: long enough to press play and listen. */
const PLAY_SECONDS = 600;
/** Run states where processing waits on a person: an admin's approval, or its owner's confirmation. */
const WAITING = ["waiting_approval", "needs_confirmation", "waiting_confirmation"];

export type SourceView = {
  id: number; created_at: number; title: string; kind: "document" | "recording"; format: "pdf" | "text" | "markdown" | "audio";
  file_name: string; size: number; pages: number; duration_s: number; status: "processing" | "ready" | "failed"; detail: string;
  run_id: number; added_by: number; passages: number; can_retry: boolean; ready_at: number | null; has_audio: boolean;
  /** While processing: steps done of all, and the run's own state (waiting for an admin or a confirmation, with the estimate). */
  progress: { done: number; total: number; run_status: string; estimate: number } | null;
};

/** A source as screens read it: no private file path, whether it can play, and progress while it's processing. */
const viewSource = (row: string, as: string) => [
  s.set_var("_has_audio", c.bool(false)),
  s.conditional({ when: expr(ref(`${row}.audio`, { safe: true }), "!=", c.null()), then: [s.update_var("_has_audio", c.bool(true))] }),
  s.set_var(as, withFilters(ref(row), fl.unset("audio"), fl.set("has_audio", ref("_has_audio")), fl.set("progress", c.null()))),
  s.conditional({ when: [expr(ref(`${row}.status`), "=", c.text("processing")), expr(ref(`${row}.run_id`), ">", c.int(0))], then: [
    s.db.get({ table: ai_run, fieldValue: ref(`${row}.run_id`), output: ["status", "estimate"], as: "_run" }),
    s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref(`${row}.run_id`)), output: ["status"], as: "_steps" }),
    s.array.filter_count({ expr: ref("_steps"), if: cond.notIn(ref("$this.status"), c.array(["queued", "working"])), as: "_done" }),
    s.update_var(as, withFilters(ref(as), fl.set("progress", obj({
      done: ref("_done"), total: withFilters(ref("_steps"), fl.count()), run_status: ref("_run.status", { safe: true }), estimate: ref("_run.estimate", { safe: true }),
    })))),
  ] }),
];

/** GET knowledge/sources: every source, newest first. A source whose run ended without saying so is settled by the minute sweep. */
export const listSources = query({
  apiGroup: knowledgeGroup, auth: user,
  name: "sources", verb: "GET",
  description: "Every Knowledge source, newest first: what it is, who added it, and whether it's processing, ready or failed and why.",
  stack: [
    ...rbac.require("knowledge.ask", "Your role can't see Knowledge."),
    s.db.query({ table: kb_source, sort: [{ sortBy: "created_at", dir: "desc" }], output: [...SOURCE_FIELDS], paging: { per_page: 500, metadata: false }, as: "rows" }),
    s.set_var("items", c.array([])),
    s.foreach({ list: ref("rows"), as: "row", body: [...viewSource("row", "shown"), s.array.push({ name: "items", value: ref("shown") })] }),
  ],
  response: { items: ref("items") },
  responseShape: {} as { items: SourceView[] },
});

/** GET knowledge/sources/{id}: one source and its passages, for the Sources view. */
export const readSource = query({
  apiGroup: knowledgeGroup, auth: user,
  name: "sources/{id}", verb: "GET",
  description: "One Knowledge source and its passages in order (page, or start time and speaker).",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.require("knowledge.ask", "Your role can't see Knowledge."),
    s.db.get({ table: kb_source, fieldValue: inp("id"), output: [...SOURCE_FIELDS], as: "row" }),
    guard.found("row", { errorType: "notfound", message: "That source isn't in Knowledge any more." }),
    ...viewSource("row", "shown"),
    s.db.query({ table: kb_passage, where: cmp(col("source_id"), "=", inp("id")), sort: [{ sortBy: "seq", dir: "asc" }],
      output: ["id", "seq", "text", "page", "start_s", "speaker"], paging: { per_page: 200, metadata: false }, as: "passages" }),
  ],
  response: { source: ref("shown"), passages: ref("passages") },
  responseShape: {} as { source: SourceView; passages: { id: number; seq: number; text: string; page: number; start_s: number; speaker: string }[] },
});

/**
 * POST knowledge/sources: add a document or a recording. `client_id` is this upload's own key, so a retried upload adds
 * one source. Request history is off: the request carries a file and mints the background worker's token.
 */
export const addSource = query({
  apiGroup: knowledgeGroup, auth: user, history: false,
  name: "sources", verb: "POST",
  description: "Add a PDF, text or Markdown file, or an audio recording, to Knowledge. It's read and embedded in the background.",
  input: { file: input.file(), title: input.text({ methods: ["trim"] }), client_id: input.text({ required: true, methods: ["trim"] }) },
  stack: [
    ...rbac.require("knowledge.manage", "Your role can ask Knowledge but can't add to it. Ask an admin or a member to add it."),
    s.set_var("base", withFilters(c.regex(/\/api:.*$/), fl.regex_replace(c.text(""), sys.apiBaseUrl()))),
    s.function.run({ fn: addSourceFn, as: "source_id", input: {
      actor_id: auth("id"), file: inp("file"), title: inp("title"), idem_key: withFilters(c.text("kb:"), fl.concat(inp("client_id"))), via: c.text("ui"), base_url: ref("base"),
    } }),
    s.db.get({ table: kb_source, fieldValue: ref("source_id"), output: [...SOURCE_FIELDS], as: "row" }),
    guard.found("row", { message: "That source couldn't be added. Try again." }),
    ...viewSource("row", "shown"),
  ],
  response: ref("shown"),
  responseShape: {} as SourceView,
});

/** DELETE knowledge/sources/{id}: remove a source and its passages. Not while it's still being read. */
export const removeSource = query({
  apiGroup: knowledgeGroup, auth: user,
  name: "sources/{id}", verb: "DELETE",
  description: "Remove a source from Knowledge, with its passages and any kept recording. A source still being read can't be removed yet.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.require("knowledge.manage", "Your role can't remove Knowledge sources."),
    s.db.get({ table: kb_source, fieldValue: inp("id"), as: "row" }),
    guard.found("row", { errorType: "notfound", message: "That source isn't in Knowledge any more." }),
    guard.require(expr(ref("row.status"), "!=", c.text("processing")), { errorType: "badrequest", message: "It's still being read. Remove it once it's ready or has failed." }),
    s.db.bulk.delete({ table: kb_passage, where: cmp(col("source_id"), "=", inp("id")), as: "dropped" }),
    s.db.bulk.delete({ table: media_blob, where: cmp(col("source_id"), "=", inp("id")), as: "dropped_audio" }),
    s.conditional({ when: expr(ref("row.audio.path", { safe: true }), "!=", c.null()), then: [
      s.try_catch({ try: [s.storage.delete_file({ pathname: ref("row.audio.path") })], catch: [] }),
    ] }),
    s.db.del({ table: kb_source, fieldValue: inp("id") }),
    changed({ entity: "kb_source", id: inp("id"), op: "deleted", verb: "removed", title: withFilters(ref("row.title"), fl.concat(c.text(" from Knowledge"))), link: "/knowledge/sources" }),
  ],
  response: { removed: c.bool(true) },
  responseShape: {} as { removed: boolean },
});

/** GET knowledge/sources/{id}/audio: a short-lived link to play a recording, for a citation's "Play from here". */
export const playSource = query({
  apiGroup: knowledgeGroup, auth: user,
  name: "sources/{id}/audio", verb: "GET",
  description: "How to play a recording source: a link good for ten minutes, or its table-kept bytes by id where this server can't sign private links.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.require("knowledge.ask", "Your role can't see Knowledge."),
    s.db.get({ table: kb_source, fieldValue: inp("id"), output: ["id", "audio"], as: "row" }),
    guard.found("row", { errorType: "notfound", message: "That source isn't in Knowledge any more." }),
    guard.require(expr(ref("row.audio"), "!=", c.null()), { errorType: "notfound", message: "This source has no recording to play." }),
    s.function.run({ fn: mediaLinkFn, as: "shown", input: { file: ref("row.audio"), ttl: c.int(PLAY_SECONDS) } }),
  ],
  response: { url: ref("shown.url"), blob_id: ref("shown.blob_id"), mime: ref("row.audio.mime", { safe: true }) },
  responseShape: {} as { url: string; blob_id: number; mime: string | null },
});

/** POST knowledge/ask: a question answered only from the sources, with citations. The same client_id twice asks once. */
export const askRoute = query({
  apiGroup: knowledgeGroup, auth: user,
  name: "ask", verb: "POST",
  description: "Ask a question. It's answered only from the closest passages in Knowledge, citing each one used; the same client_id twice asks once.",
  input: { question: input.text({ methods: ["trim"] }), client_id: input.text({ required: true, methods: ["trim"] }) },
  stack: [
    ...rbac.require("knowledge.ask", "Your role can't ask Knowledge."),
    s.function.run({ fn: askFn, as: "asked", input: {
      actor_id: auth("id"), question: inp("question"), idem_key: withFilters(c.text("ask:"), fl.concat(inp("client_id"))), via: c.text("ui"), connection_id: c.int(0),
    } }),
  ],
  response: ref("asked"),
  responseShape: {} as AskView,
});

/** GET knowledge/questions: your own recent questions with their stored answers. Nobody sees anyone else's. */
export const recentQuestions = query({
  apiGroup: knowledgeGroup, auth: user,
  name: "questions", verb: "GET",
  description: "The questions you asked Knowledge, newest first, each with its answer and citations as they were given. Only your own.",
  stack: [
    ...rbac.require("knowledge.ask", "Your role can't ask Knowledge."),
    s.function.run({ fn: recentQuestionsFn, as: "recent", input: { actor_id: auth("id") } }),
  ],
  response: ref("recent"),
  responseShape: {} as { items: AskedView[] },
});

/** POST knowledge/sources/{id}/retry: finish a source whose embedding failed, from what was read. Whoever added it. */
export const retrySource = query({
  apiGroup: knowledgeGroup, auth: user, history: false,
  name: "sources/{id}/retry", verb: "POST",
  description: "Retry the embedding a source missed, keeping what was read. Only the person who added it; the same client_id twice retries once.",
  input: { id: input.int({ required: true }), client_id: input.text({ required: true, methods: ["trim"] }) },
  stack: [
    ...rbac.require("knowledge.manage", "Your role can't add to Knowledge."),
    s.function.run({ fn: retrySourceFn, as: "source_id", input: { source_id: inp("id"), actor_id: auth("id"), key: withFilters(c.text("kb-retry:"), fl.concat(inp("client_id"))) } }),
    s.db.get({ table: kb_source, fieldValue: inp("id"), output: [...SOURCE_FIELDS], as: "row" }),
    guard.found("row", { errorType: "notfound", message: "That source isn't in Knowledge any more." }),
    ...viewSource("row", "shown"),
  ],
  response: ref("shown"),
  responseShape: {} as SourceView,
});

export const knowledgeQueries = [listSources, readSource, addSource, removeSource, playSource, askRoute, recentQuestions, retrySource];

