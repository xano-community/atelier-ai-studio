// Adding a source to Knowledge. The upload's file lasts about a day and a stored file can't be read back, so everything
// that needs the file is planned here, in the upload's request, as one `ingest` run through the spend gate:
//   - text and Markdown are split into passages now; the run is only their embedding, in batches of 50;
//   - a PDF is read 5 pages per step (the model gets the file and returns each page as Markdown), each range followed by
//     the embedding of what it read. When the file doesn't say its page count, the run is planned for the most pages
//     Knowledge reads and the first range releases the rest;
//   - a recording is transcribed with speakers and start times in one step, then embedded. It's also kept privately, so a
//     citation can play from its moment.
// The run then goes to the background, and the source becomes ready or failed when the run ends (knowledge/settle).
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, or, ref, s, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { kb_passage, KB_DIMENSIONS } from "../../table/knowledge/kb_passage.js";
import { kb_source } from "../../table/knowledge/kb_source.js";
import { RUN_VIAS } from "../../table/studio/ai_run.js";
import { goFn } from "../runs/background.js";
import { retryRunFn } from "../runs/control.js";
import { startRunFn } from "../runs/start.js";
import { KB_EMBED_MODEL, KB_TEXT_MODEL, KB_WORDS, MOST_PAGES, PAGES_PER_STEP } from "./absorb.js";
import { chunkFn } from "./chunk.js";
import { keepWhereReadable } from "../library/media.js";
import { settleSourceFn } from "./settle.js";

export const ADD_DENIED = "Your role can ask Knowledge but can't add to it. Ask an admin or a member to add it.";
/** Passages per embedding call: 50 took 12 seconds in the live proof. */
export const EMBED_BATCH = 50;
/** The most passages a text file may become: one embedding step per batch, within a run's 20 steps. */
const MOST_TEXT_PASSAGES = EMBED_BATCH * 20;
const MB = 1024 * 1024;
export const LIMITS = { pdf: 20 * MB, text: 2 * MB, audio: 20 * MB } as const;
/** About what one PDF page costs the model to read, in tokens. */
const TOKENS_PER_PAGE = 260;
/** Room for a range's Markdown and the model's hidden thinking, which counts against the cap. */
const RANGE_OUTPUT_TOKENS = 12_000;
/** Bytes a second of a typical call recording (24 kbps); a guess on the long side, for the estimate only. */
const RECORDING_BYTES_PER_SECOND = 3_000;
const AUDIO_TOKENS_PER_SECOND = 32;

const AUDIO_EXT = ["mp3", "m4a", "wav", "aiff", "aif", "ogg", "flac", "webm", "aac"];
export const UPLOAD_WORDS = {
  unsupported: "Knowledge takes PDFs, text and Markdown files, and audio recordings (MP3, M4A, WAV, AIFF, OGG, FLAC). Convert it to one of those and try again.",
  empty: "This file has no text in it. Check it's the right file, then upload it again.",
  tooBig: "This file is too big for Knowledge: PDFs and recordings up to 20 MB, text up to 2 MB. Split it into smaller files and add each.",
  tooManyPassages: `This file is too long for one source: it would be more than ${MOST_TEXT_PASSAGES} passages. Split it into smaller files and add each.`,
} as const;

const PAGES_SCHEMA = {
  type: "object",
  properties: {
    total_pages: { type: "integer" },
    pages: { type: "array", items: { type: "object", properties: { page: { type: "integer" }, markdown: { type: "string" } }, required: ["page", "markdown"] } },
  },
  required: ["total_pages", "pages"],
};
const LINES_SCHEMA = {
  type: "object",
  properties: {
    lines: { type: "array", items: { type: "object", properties: { start: { type: "number" }, speaker: { type: "string" }, text: { type: "string" } }, required: ["start", "speaker", "text"] } },
  },
  required: ["lines"],
};
const RECORDING_PROMPT = "Transcribe this recording word for word. Return one line per speaker turn: `start` is the number of seconds from the beginning where the turn starts, `speaker` is \"Speaker 1\", \"Speaker 2\" and so on in the order people first speak, and `text` is what they said. Leave out filler sounds and long silences.";

/** The prompt for pages `from` to `to`, bound to `range_prompt`. */
const rangePrompt = () => s.set_var("range_prompt", withFilters(
  c.text("Read pages "), fl.concat(ref("from")), fl.concat(c.text(" to ")), fl.concat(ref("to")),
  fl.concat(c.text(" of this PDF, and only those pages. Return each one's text as Markdown: keep headings, lists and tables, and leave out running headers, footers and page numbers. Give a page with no text an empty string. Also return how many pages the whole document has in total_pages.")),
));

export const addSourceFn = defineFunction({
  name: "knowledge/add",
  description: "Add a document or recording to Knowledge: plan its reading and embedding as one run through the spend gate, then start it in the background.",
  input: {
    actor_id: input.int({ required: true }),
    file: input.file(),
    title: input.text(),
    idem_key: input.text({ required: true }),
    via: input.enum(RUN_VIAS, { required: true }),
    base_url: input.text(),
  },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("actor.role"), "knowledge.manage", ADD_DENIED),
    guard.require(expr(inp("file"), "!=", c.null()), { errorType: "badrequest", message: "Attach a document or a recording to add." }),
    s.storage.read_file_resource({ value: inp("file"), as: "upload" }),
    s.set_var("file_name", withFilters(ref("upload.name"), fl.first_notnull(c.text("")), fl.to_text())),
    s.set_var("mime", withFilters(ref("upload.mime"), fl.first_notnull(c.text("")), fl.to_text(), fl.lower())),
    s.set_var("size", withFilters(ref("upload.size"), fl.first_notnull(c.int(0)), fl.to_int())),
    s.set_var("ext", withFilters(ref("file_name"), fl.split("."), fl.last(), fl.lower())),
    s.conditional({ when: expr(withFilters(ref("file_name"), fl.contains(".")), "=", c.bool(false)), then: [s.update_var("ext", c.text(""))] }),
    s.set_var("format", c.text("")),
    s.conditional({
      when: [expr(ref("mime"), "=", c.text("application/pdf"))], then: [s.update_var("format", c.text("pdf"))],
      elif: [
        { when: expr(ref("ext"), "=", c.text("pdf")), then: [s.update_var("format", c.text("pdf"))] },
        { when: expr(withFilters(c.array(["md", "markdown"]), fl.in(ref("ext"))), "=", c.bool(true)), then: [s.update_var("format", c.text("markdown"))] },
        { when: expr(ref("mime"), "=", c.text("text/markdown")), then: [s.update_var("format", c.text("markdown"))] },
        { when: expr(withFilters(c.array(AUDIO_EXT), fl.in(ref("ext"))), "=", c.bool(true)), then: [s.update_var("format", c.text("audio"))] },
        { when: expr(withFilters(ref("mime"), fl.starts_with("audio/")), "=", c.bool(true)), then: [s.update_var("format", c.text("audio"))] },
        { when: expr(ref("ext"), "=", c.text("txt")), then: [s.update_var("format", c.text("text"))] },
        { when: expr(withFilters(ref("mime"), fl.starts_with("text/plain")), "=", c.bool(true)), then: [s.update_var("format", c.text("text"))] },
      ],
    }),
    guard.require(expr(ref("format"), "!=", c.text("")), { errorType: "badrequest", message: UPLOAD_WORDS.unsupported }),
    s.set_var("is_text", withFilters(c.array(["text", "markdown"]), fl.in(ref("format")))),
    s.set_var("limit", withFilters(c.obj({ pdf: LIMITS.pdf, text: LIMITS.text, markdown: LIMITS.text, audio: LIMITS.audio }), fl.get(ref("format"), 0))),
    guard.require(expr(ref("size"), "<=", ref("limit")), { errorType: "badrequest", message: UPLOAD_WORDS.tooBig }),
    s.set_var("title", withFilters(inp("title"), fl.first_notnull(c.text("")), fl.to_text(), fl.trim())),
    s.conditional({ when: expr(ref("title"), "=", c.text("")), then: [
      s.update_var("title", withFilters(c.regex(/\.[A-Za-z0-9]{1,8}$/), fl.regex_replace(c.text(""), ref("file_name")), fl.trim())),
    ] }),
    s.conditional({ when: expr(ref("title"), "=", c.text("")), then: [s.update_var("title", c.text("Untitled source"))] }),
    s.update_var("title", withFilters(ref("title"), fl.substr(0, 200))),
    s.set_var("file_sha", withFilters(ref("upload.data"), fl.sha256())),
    s.set_var("kind", c.text("document")),
    s.conditional({ when: expr(ref("format"), "=", c.text("audio")), then: [s.update_var("kind", c.text("recording"))] }),

    // The steps, in order.
    s.set_var("steps", c.array([])),
    s.set_var("texts", c.array([])),
    s.set_var("pages", c.int(0)),
    s.set_var("refusal", c.text("")),
    s.switch({ on: ref("format"), default: [
      // Text and Markdown: passages now, then their embedding in batches.
      s.function.run({ fn: chunkFn, as: "chunked", input: { text: withFilters(ref("upload.data"), fl.to_text()), max_chars: c.int(0) } }),
      s.update_var("texts", ref("chunked")),
      guard.require(expr(withFilters(ref("texts"), fl.count()), ">", c.int(0)), { errorType: "badrequest", message: UPLOAD_WORDS.empty }),
      guard.require(expr(withFilters(ref("texts"), fl.count()), "<=", c.int(MOST_TEXT_PASSAGES)), { errorType: "badrequest", message: UPLOAD_WORDS.tooManyPassages }),
      s.set_var("batch", c.array([])),
      s.set_var("batch_chars", c.int(0)),
      s.set_var("left", withFilters(ref("texts"), fl.count())),
      s.foreach({ list: ref("texts"), as: "one", body: [
        s.array.push({ name: "batch", value: ref("one") }),
        s.update_var("batch_chars", withFilters(ref("batch_chars"), fl.add(withFilters(ref("one"), fl.strlen())))),
        s.update_var("left", withFilters(ref("left"), fl.sub(1))),
        s.conditional({ when: or(expr(withFilters(ref("batch"), fl.count()), ">=", c.int(EMBED_BATCH)), expr(ref("left"), "=", c.int(0))), then: [
          s.array.push({ name: "steps", value: obj({
            kind: c.text("embedding"), model: c.text(KB_EMBED_MODEL),
            input: obj({ input: ref("batch"), task_type: c.text("RETRIEVAL_DOCUMENT"), dimensions: c.int(KB_DIMENSIONS), kb: obj({ part: c.text("embed") }) }),
            options: obj({ input_tokens: withFilters(ref("batch_chars"), fl.div(4), fl.ceil(), fl.to_int()), input_type: c.text("text") }),
          }) }),
          s.update_var("batch", c.array([])),
          s.update_var("batch_chars", c.int(0)),
        ] }),
      ] }),
    ], cases: [
      { when: c.text("pdf"), break: true, body: [
        // What the file itself says: no fonts and no compressed objects but images is a scan, and its page objects
        // count its pages. Compressed files hide both, so they're read and counted by the model instead.
        s.set_var("has_font", c.bool(true)),
        s.try_catch({ try: [
          s.set_var("bytes", withFilters(ref("upload.data"), fl.to_text())),
          s.update_var("has_font", withFilters(ref("bytes"), fl.contains("/Font"))),
          s.set_var("has_streams", withFilters(ref("bytes"), fl.contains("/ObjStm"))),
          s.set_var("has_image", withFilters(ref("bytes"), fl.contains("/Image"))),
          s.conditional({ when: [expr(ref("has_font"), "=", c.bool(false)), expr(ref("has_streams"), "=", c.bool(false)), expr(ref("has_image"), "=", c.bool(true))], then: [
            s.update_var("refusal", c.text(KB_WORDS.scan)),
          ] }),
          s.update_var("pages", withFilters(c.regex(/\/Type\s*\/Page(?![a-zA-Z])/), fl.regex_match_all(ref("bytes")), fl.first(), fl.safe_array(), fl.count())),
        ], catch: [s.update_var("pages", c.int(0))] }),
        guard.require(expr(ref("pages"), "<=", c.int(MOST_PAGES)), { errorType: "badrequest", message: KB_WORDS.tooManyPages }),
        s.set_var("planned", ref("pages")),
        s.conditional({ when: expr(ref("planned"), "<=", c.int(0)), then: [s.update_var("planned", c.int(MOST_PAGES))] }),
        s.set_var("ranges", withFilters(ref("planned"), fl.div(PAGES_PER_STEP), fl.ceil(), fl.to_int())),
        s.foreach({ list: withFilters(c.int(0), fl.range(0, withFilters(ref("ranges"), fl.sub(1)))), as: "r", body: [
          s.set_var("from", withFilters(ref("r"), fl.mul(PAGES_PER_STEP), fl.add(1), fl.to_int())),
          s.set_var("to", withFilters(ref("from"), fl.add(PAGES_PER_STEP - 1), fl.clamp_max(ref("planned")), fl.to_int())),
          s.set_var("read_seq", withFilters(ref("r"), fl.mul(2), fl.add(1), fl.to_int())),
          rangePrompt(),
          s.array.push({ name: "steps", value: obj({
            kind: c.text("text"), model: c.text(KB_TEXT_MODEL), timeout_s: c.int(240),
            input: obj({ prompt: ref("range_prompt"), files: withFilters(c.array([]), fl.append(inp("file"), c.text(""))), response_format: c.text("json"),
              json_schema: c.obj(PAGES_SCHEMA as never), file_sha: ref("file_sha"),
              kb: obj({ part: c.text("pages"), from: ref("from"), to: ref("to"), embed_seq: withFilters(ref("read_seq"), fl.add(1)) }) }),
            options: obj({ input_tokens: withFilters(ref("planned"), fl.mul(TOKENS_PER_PAGE), fl.add(500), fl.to_int()), output_tokens: c.int(RANGE_OUTPUT_TOKENS) }),
          }) }),
          s.array.push({ name: "steps", value: obj({
            kind: c.text("embedding"), model: c.text(KB_EMBED_MODEL), depends_on: withFilters(c.array([]), fl.append(ref("read_seq"), c.text(""))),
            input: obj({ input: c.array([]), task_type: c.text("RETRIEVAL_DOCUMENT"), dimensions: c.int(KB_DIMENSIONS), kb: obj({ part: c.text("embed"), from: ref("from") }) }),
            options: obj({ input_tokens: withFilters(ref("to"), fl.sub(ref("from")), fl.add(1), fl.mul(800), fl.to_int()), input_type: c.text("text") }),
          }) }),
        ] }),
      ] },
      { when: c.text("audio"), break: true, body: [
        s.set_var("seconds", withFilters(ref("size"), fl.div(RECORDING_BYTES_PER_SECOND), fl.ceil(), fl.clamp_min(30), fl.to_int())),
        s.array.push({ name: "steps", value: obj({
          kind: c.text("text"), model: c.text(KB_TEXT_MODEL), timeout_s: c.int(300),
          input: obj({ prompt: c.text(RECORDING_PROMPT), files: withFilters(c.array([]), fl.append(inp("file"), c.text(""))), response_format: c.text("json"),
            json_schema: c.obj(LINES_SCHEMA as never), file_sha: ref("file_sha"), kb: obj({ part: c.text("recording"), embed_seq: c.int(2) }) }),
          options: obj({
            input_tokens: withFilters(ref("seconds"), fl.mul(AUDIO_TOKENS_PER_SECOND), fl.add(300), fl.to_int()),
            output_tokens: withFilters(ref("seconds"), fl.mul(6), fl.add(4000), fl.clamp_min(8000), fl.clamp_max(60000), fl.to_int()),
          }),
        }) }),
        s.array.push({ name: "steps", value: obj({
          kind: c.text("embedding"), model: c.text(KB_EMBED_MODEL), depends_on: c.array([1]),
          input: obj({ input: c.array([]), task_type: c.text("RETRIEVAL_DOCUMENT"), dimensions: c.int(KB_DIMENSIONS), kb: obj({ part: c.text("embed") }) }),
          options: obj({ input_tokens: withFilters(ref("seconds"), fl.mul(4), fl.to_int()), input_type: c.text("text") }),
        }) }),
      ] },
    ] }),

    s.set_var("source_id", c.int(0)),
    // A scan is refused before anything is sent: nothing is charged, and the source says why.
    s.conditional({
      when: expr(ref("refusal"), "!=", c.text("")),
      then: [
        s.db.add({ table: kb_source, as: "made", row: {
          title: ref("title"), kind: ref("kind"), format: ref("format"), file_name: ref("file_name"), mime: ref("mime"), size: ref("size"), pages: ref("pages"),
          duration_s: c.int(0), status: c.text("failed"), detail: ref("refusal"), run_id: c.int(0), added_by: inp("actor_id"), passages: c.int(0), is_demo: c.bool(false),
        } }),
        s.update_var("source_id", ref("made.id")),
        changed({ entity: "kb_source", id: ref("made.id"), op: "created", actor: inp("actor_id") }),
      ],
      else: [
        s.function.run({ fn: startRunFn, as: "started", input: {
          owner_id: inp("actor_id"), kind: c.text("ingest"), via: inp("via"), connection_id: c.int(0), idem_key: inp("idem_key"), recipe_id: c.int(0),
          title: withFilters(c.text("Read "), fl.concat(ref("title")), fl.concat(c.text(" into Knowledge"))), private: c.bool(true),
          base_url: inp("base_url"), agent_label: c.text("Knowledge"), steps: ref("steps"),
        } }),
        s.conditional({ when: expr(ref("started.outcome"), "=", c.text("conflict")), then: [
          s.throw({ name: "IDEMPOTENCY_KEY_REUSED", value: c.text("That upload key was already used for a different file. Send a new one to add another source."), status: 409 }),
        ] }),
        s.conditional({
          when: expr(ref("started.outcome"), "=", c.text("existing")),
          then: [
            s.db.query({ table: kb_source, where: cmp(col("run_id"), "=", ref("started.run.id")), output: ["id"], returnType: "single", as: "seen" }),
            guard.found("seen", { message: "That upload is still being set up. Try again in a moment." }),
            s.update_var("source_id", ref("seen.id")),
          ],
          else: [
            s.db.add({ table: kb_source, as: "made", row: {
              title: ref("title"), kind: ref("kind"), format: ref("format"), file_name: ref("file_name"), mime: ref("mime"), size: ref("size"), pages: ref("pages"),
              duration_s: c.int(0), status: c.text("processing"), detail: c.text(""), run_id: ref("started.run.id"), added_by: inp("actor_id"), passages: c.int(0), is_demo: c.bool(false),
            } }),
            s.update_var("source_id", ref("made.id")),
            // Text and Markdown: the passages are known now, one batch per embedding step.
            s.conditional({ when: expr(ref("is_text"), "=", c.bool(true)), then: [
              s.set_var("rows", c.array([])),
              s.set_var("n", c.int(0)),
              s.foreach({ list: ref("texts"), as: "one", body: [
                s.array.push({ name: "rows", value: obj({
                  source_id: ref("made.id"), seq: withFilters(ref("n"), fl.add(1)), text: ref("one"), page: c.int(0), start_s: c.int(-1), speaker: c.text(""),
                  batch: withFilters(ref("n"), fl.div(EMBED_BATCH), fl.floor(), fl.add(1), fl.to_int()), live: c.bool(false),
                }) }),
                s.update_var("n", withFilters(ref("n"), fl.add(1))),
              ] }),
              s.db.bulk.add({ table: kb_passage, items: ref("rows"), as: "kept" }),
            ] }),
            // A recording is kept privately, so a citation can play from its moment, or in a table where this server can't
            // sign links (library/media.ts). Without it the source still works.
            s.conditional({ when: expr(ref("format"), "=", c.text("audio")), then: [
              s.try_catch({ try: [
                s.storage.create_audio({ value: inp("file"), access: "private", filename: ref("file_name"), as: "kept_audio" }),
                ...keepWhereReadable("kept_audio", inp("file"), { run: ref("started.run.id"), step: c.int(0), attempt: c.int(0), source: ref("made.id") }),
                s.db.patch({ table: kb_source, fieldValue: ref("made.id"), data: obj({ audio: ref("kept_audio") }) }),
              ], catch: [] }),
            ] }),
            s.set_var("run_status", ref("started.run.status")),
            s.conditional({
              when: expr(ref("run_status"), "=", c.text("queued")),
              then: [s.function.run({ fn: goFn, as: "went", input: { run_id: ref("started.run.id"), inline: c.bool(false) } })],
              // Refused for the budget: the source fails now, saying why. Waiting for an admin or a confirmation: it
              // stays processing and says what it's waiting for.
              elif: [{ when: expr(ref("run_status"), "=", c.text("refused")), then: [
                s.function.run({ fn: settleSourceFn, as: "settled", input: { run_id: ref("started.run.id") } }),
              ] }],
              else: [s.db.patch({ table: kb_source, fieldValue: ref("made.id"), data: obj({ detail: ref("started.run.detail") }) })],
            }),
            changed({ entity: "kb_source", id: ref("made.id"), op: "created", actor: inp("actor_id") }),
          ],
        }),
      ],
    }),
  ],
  response: ref("source_id"),
  responseShape: 0 as number,
});

export const RETRY_WORDS = {
  notRetryable: "Only a source whose embedding failed can be retried. Upload the file again to add it.",
  notYours: "Only the person who added this source can retry it. Anyone who can add sources can upload the file again.",
} as const;

/**
 * Retry a source whose reading finished but some embedding calls failed. Its passages were kept, so the failed steps
 * run again from them (no file needed) through the run's own retry: a new reservation, and the same key twice retries
 * once. Answers the source's id.
 */
export const retrySourceFn = defineFunction({
  name: "knowledge/retry",
  description: "Embed again what a source's failed embedding steps missed, keeping what was read. Only whoever added it may.",
  input: { source_id: input.int({ required: true }), actor_id: input.int({ required: true }), key: input.text({ required: true }) },
  stack: [
    s.db.get({ table: kb_source, fieldValue: inp("source_id"), as: "source" }),
    guard.found("source", { errorType: "notfound", message: "That source isn't in Knowledge any more." }),
    guard.require(expr(ref("source.added_by"), "=", inp("actor_id")), { errorType: "accessdenied", message: RETRY_WORDS.notYours }),
    guard.require([expr(ref("source.status"), "=", c.text("failed")), expr(ref("source.can_retry"), "=", c.bool(true))], { errorType: "badrequest", message: RETRY_WORDS.notRetryable }),
    s.function.run({ fn: retryRunFn, as: "retried", input: { run_id: ref("source.run_id"), actor_id: inp("actor_id"), key: inp("key") } }),
    s.db.patch({ table: kb_source, fieldValue: inp("source_id"), data: obj({ status: c.text("processing"), detail: c.text(""), can_retry: c.bool(false) }) }),
    s.conditional({ when: expr(ref("retried.outcome"), "=", c.text("created")), then: [
      s.function.run({ fn: goFn, as: "went", input: { run_id: ref("source.run_id"), inline: c.bool(false) } }),
    ] }),
    // A retry its owner's budget refused ends the source again, saying why.
    s.function.run({ fn: settleSourceFn, as: "settled", input: { run_id: ref("source.run_id") } }),
    changed({ entity: "kb_source", id: inp("source_id"), op: "updated", actor: inp("actor_id") }),
  ],
  response: inp("source_id"),
  responseShape: 0 as number,
});
