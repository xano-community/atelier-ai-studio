// What a knowledge upload's steps leave behind. A PDF range or a recording comes back as JSON; its pages or lines become
// passages for the embedding step after it, which is filled in here. An embedding step's vectors go onto those passages.
// It runs before the step's result is recorded, so the vectors are in place before the run can end. When a step shows
// the source can't be added (no text, no speech, cut off at the length limit) it says so, and the caller records the
// step as failed with the reason in words and releases what wasn't sent. A PDF whose page count wasn't in the file
// is planned for the most Knowledge reads; once the first range says how many pages there are, the rest are released.
import { c, cmp, col, cond, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { kb_passage, KB_DIMENSIONS } from "../../table/knowledge/kb_passage.js";
import { kb_source } from "../../table/knowledge/kb_source.js";
import { ai_run } from "../../table/studio/ai_run.js";
import { ai_step, STEP_OUTCOMES } from "../../table/studio/ai_step.js";
import { releaseFn } from "../spend/release.js";
import { takeStep } from "../runs/reserve.js";
import { chunkFn } from "./chunk.js";
import { transcriptParseFn } from "./transcript_parse.js";

export const KB_EMBED_MODEL = "gemini-embedding-2";
export const KB_TEXT_MODEL = "gemini-3.8-flash";
/** Pages per reading step: few enough that the Markdown and the model's thinking fit one reply. */
export const PAGES_PER_STEP = 5;
/** The most pages a PDF may have: one reading and one embedding step per range, within a run's 20 steps. */
export const MOST_PAGES = 50;

export const KB_WORDS = {
  scan: "This looks like a scan with no text. Upload it again as text to add it.",
  tooLong: "This document is too long to read in full. Split it into smaller files and upload them again.",
  tooManyPages: `This document has more than ${MOST_PAGES} pages, which is more than Knowledge reads in one go. Split it into smaller files and upload them again.`,
  noSpeech: "We couldn't hear any speech in this recording. Check it plays, then upload it again.",
  recordingTooLong: "This recording is too long to transcribe in full. Split it into shorter parts and upload them again.",
  notEmbedded: "Some passages came back without an embedding. Upload it again to retry.",
} as const;

/**
 * The step is to be recorded failed with `reason` and these words, and the run stopped (the caller releases what wasn't
 * sent). Passages already made stay unsearchable (only a ready source's are live), and the minute sweep clears them.
 */
const fail = (reason: string, words: string) => [
  s.update_var("stop", c.bool(true)),
  s.update_var("fail_reason", c.text(reason)),
  s.update_var("fail_detail", c.text(words)),
];

/** Fill the embedding step `embed_seq` with the passages just made for it. */
const fillEmbedding = () => [
  s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", ref("run.id")), cmp(col("seq"), "=", ref("embed_seq"))], output: ["id", "status"], returnType: "single", as: "embed_step" }),
  s.conditional({ when: expr(ref("embed_step.status", { safe: true }), "=", c.text("queued")), then: [
    s.array.map({ source: ref("rows"), as: "texts", transform: ref("$this.text") }),
    s.db.patch({ table: ai_step, fieldValue: ref("embed_step.id"), data: obj({
      input: obj({ input: ref("texts"), task_type: c.text("RETRIEVAL_DOCUMENT"), dimensions: c.int(KB_DIMENSIONS), kb: obj({ part: c.text("embed") }) }),
    }) }),
  ] }),
];

export const absorbStepFn = defineFunction({
  name: "knowledge/absorb",
  description: "Keep what a knowledge upload's step made: pages or transcript lines as passages, or vectors on them. Says when the source can't be added.",
  input: {
    step_id: input.int({ required: true }), attempt: input.int({ required: true }),
    /** What the wrapper answered, before it's recorded on the step. */
    outcome: input.enum(STEP_OUTCOMES, { required: true }), output: input.json(),
  },
  stack: [
    s.set_var("stop", c.bool(false)),
    s.set_var("fail_reason", c.text("")),
    s.set_var("fail_detail", c.text("")),
    s.set_var("outcome", inp("outcome")),
    s.db.get({ table: ai_step, fieldValue: inp("step_id"), as: "step" }),
    guard.found("step", { message: "No such step." }),
    s.db.get({ table: ai_run, fieldValue: ref("step.run_id"), output: ["id", "kind"], as: "run" }),
    guard.found("run", { message: "No such run." }),
    s.db.query({ table: kb_source, where: cmp(col("run_id"), "=", ref("run.id")), returnType: "single", as: "source" }),
    s.set_var("asked", withFilters(ref("step.input"), fl.first_notnull(c.obj({})))),
    s.set_var("part", withFilters(ref("asked"), fl.get("kb", c.obj({})), fl.first_notnull(c.obj({})))),
    s.set_var("part_name", withFilters(ref("part"), fl.get("part", ""), fl.first_notnull(c.text("")), fl.to_text())),
    s.set_var("made", withFilters(inp("output"), fl.first_notnull(c.obj({})))),
    s.set_var("finish", withFilters(ref("made"), fl.get("finish_reason", ""), fl.first_notnull(c.text("")), fl.to_text())),
    s.set_var("reply", withFilters(ref("made"), fl.get("json", c.obj({})), fl.first_notnull(c.obj({})))),
    s.set_var("embed_seq", withFilters(ref("part"), fl.get("embed_seq", 0), fl.first_notnull(c.int(0)), fl.to_int())),
    s.set_var("rows", c.array([])),
    s.conditional({ when: [
      expr(ref("run.kind"), "=", c.text("ingest")), expr(ref("source"), "!=", c.null()), expr(ref("source.status", { safe: true }), "=", c.text("processing")),
      expr(ref("step.attempt"), "=", inp("attempt")),
    ], then: [s.switch({ on: ref("part_name"), cases: [
      // A range of a PDF's pages.
      { when: c.text("pages"), break: true, body: [
        s.conditional({ when: or2("succeeded", "failed"), then: [s.conditional({
          when: expr(ref("finish"), "=", c.text("max_tokens")),
          then: fail("too_long", KB_WORDS.tooLong),
          elif: [{ when: expr(ref("outcome"), "=", c.text("succeeded")), then: [
            s.set_var("from", withFilters(ref("part"), fl.get("from", 1), fl.to_int())),
            s.set_var("total", withFilters(ref("reply"), fl.get("total_pages", 0), fl.first_notnull(c.int(0)), fl.to_int())),
            s.foreach({ list: withFilters(ref("reply"), fl.get("pages", c.array([])), fl.safe_array()), as: "page", body: [
              s.set_var("page_no", withFilters(ref("page"), fl.get("page", 0), fl.first_notnull(c.int(0)), fl.to_int())),
              s.function.run({ fn: chunkFn, as: "pieces", input: { text: withFilters(ref("page"), fl.get("markdown", ""), fl.first_notnull(c.text("")), fl.to_text()), max_chars: c.int(0) } }),
              s.set_var("piece_no", c.int(0)),
              s.foreach({ list: ref("pieces"), as: "piece", body: [
                s.update_var("piece_no", withFilters(ref("piece_no"), fl.add(1))),
                s.array.push({ name: "rows", value: obj({
                  source_id: ref("source.id"), seq: withFilters(ref("page_no"), fl.mul(1000), fl.add(ref("piece_no"))), text: ref("piece"),
                  page: ref("page_no"), start_s: c.int(-1), speaker: c.text(""), batch: ref("embed_seq"), live: c.bool(false),
                }) }),
              ] }),
            ] }),
            s.conditional({
              when: [expr(withFilters(ref("rows"), fl.count()), "=", c.int(0)), expr(ref("from"), "=", c.int(1))],
              then: fail("no_text", KB_WORDS.scan),
              elif: [{ when: expr(ref("total"), ">", c.int(MOST_PAGES)), then: fail("too_long", KB_WORDS.tooManyPages) }],
              else: [
                s.conditional({ when: expr(withFilters(ref("rows"), fl.count()), ">", c.int(0)), then: [s.db.bulk.add({ table: kb_passage, items: ref("rows"), as: "added" })] }),
                ...fillEmbedding(),
                // The page count, when the file didn't say it: ranges past the end aren't needed.
                s.conditional({ when: [expr(ref("total"), ">", c.int(0)), expr(withFilters(ref("source.pages"), fl.first_notnull(c.int(0))), "=", c.int(0))], then: [
                  s.db.patch({ table: kb_source, fieldValue: ref("source.id"), data: obj({ pages: ref("total") }) }),
                  s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", ref("run.id")), cmp(col("status"), "=", c.text("queued"))], output: ["id", "attempt", "input"], as: "later" }),
                  s.foreach({ list: ref("later"), as: "one", body: [
                    s.set_var("one_from", withFilters(ref("one.input"), fl.get("kb", c.obj({})), fl.first_notnull(c.obj({})), fl.get("from", 0), fl.first_notnull(c.int(0)), fl.to_int())),
                    s.conditional({ when: expr(ref("one_from"), ">", ref("total")), then: [
                      takeStep(ref("one.id"), ref("one.attempt")),
                      s.conditional({ when: expr(ref("took"), "=", c.int(1)), then: [
                        s.function.run({ fn: releaseFn, as: "let_go", input: { step_id: ref("one.id"), attempt: ref("one.attempt"), reason: c.text("not_needed") } }),
                        s.db.patch({ table: ai_step, fieldValue: ref("one.id"), data: obj({ status: c.text("released"), reason: c.text("not_needed"), finished_at: c.now(),
                          detail: withFilters(c.text("Not needed: the document has "), fl.concat(ref("total")), fl.concat(c.text(" pages. Nothing was charged for it."))) }) }),
                      ] }),
                    ] }),
                  ] }),
                ] }),
              ],
            }),
          ] }],
        })] }),
      ] },
      // A recording's transcript.
      { when: c.text("recording"), break: true, body: [
        s.conditional({ when: or2("succeeded", "failed"), then: [s.conditional({
          when: expr(ref("finish"), "=", c.text("max_tokens")),
          then: fail("too_long", KB_WORDS.recordingTooLong),
          elif: [{ when: expr(ref("outcome"), "=", c.text("succeeded")), then: [
            s.function.run({ fn: transcriptParseFn, as: "parsed", input: { lines: withFilters(ref("reply"), fl.get("lines", c.array([])), fl.safe_array()), text: c.text(""), max_chars: c.int(0) } }),
            s.set_var("n", c.int(0)),
            s.foreach({ list: ref("parsed.passages"), as: "said", body: [
              s.update_var("n", withFilters(ref("n"), fl.add(1))),
              s.array.push({ name: "rows", value: obj({
                source_id: ref("source.id"), seq: ref("n"), text: ref("said.text"), page: c.int(0), start_s: ref("said.start_s"), speaker: ref("said.speaker"),
                batch: ref("embed_seq"), live: c.bool(false),
              }) }),
            ] }),
            s.conditional({
              when: expr(withFilters(ref("rows"), fl.count()), "=", c.int(0)),
              then: fail("no_speech", KB_WORDS.noSpeech),
              else: [
                s.db.bulk.add({ table: kb_passage, items: ref("rows"), as: "added" }),
                s.db.patch({ table: kb_source, fieldValue: ref("source.id"), data: obj({ duration_s: ref("parsed.duration_s") }) }),
                ...fillEmbedding(),
              ],
            }),
          ] }],
        })] }),
      ] },
      // Vectors for the passages this step embedded, in order.
      { when: c.text("embed"), break: true, body: [
        s.conditional({ when: expr(ref("outcome"), "=", c.text("succeeded")), then: [
          s.db.query({ table: kb_passage, where: [cmp(col("source_id"), "=", ref("source.id")), cmp(col("batch"), "=", ref("step.seq"))], sort: [{ sortBy: "seq", dir: "asc" }],
            output: ["id"], paging: { per_page: 5000, metadata: false }, as: "batch_rows" }),
          s.set_var("vectors", withFilters(ref("made"), fl.get("embeddings", c.array([])), fl.safe_array())),
          s.conditional({
            when: expr(withFilters(ref("vectors"), fl.count()), "!=", withFilters(ref("batch_rows"), fl.count())),
            then: fail("model_error", KB_WORDS.notEmbedded),
            else: [
              // One write per passage: an agent's tool can start this run, and agent tools don't bulk-change rows.
              s.set_var("i", c.int(0)),
              s.foreach({ list: ref("batch_rows"), as: "row", body: [
                s.set_var("at", withFilters(ref("i"), fl.to_text())),
                s.db.patch({ table: kb_passage, fieldValue: ref("row.id"), data: obj({ embedding: withFilters(ref("vectors"), fl.get(ref("at"))) }) }),
                s.update_var("i", withFilters(ref("i"), fl.add(1))),
              ] }),
            ],
          }),
        ] }),
      ] },
    ] })] }),
  ],
  response: { stop: ref("stop"), reason: ref("fail_reason"), detail: ref("fail_detail") },
  responseShape: {} as { stop: boolean; reason: string; detail: string },
});

/** The step ended one of these ways. */
function or2(a: string, b: string) {
  return cond.in(ref("outcome"), c.array([a, b]));
}
