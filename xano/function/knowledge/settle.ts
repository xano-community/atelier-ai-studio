// A knowledge source's outcome, once its run has ended. It's ready only when the run is done and every passage has its
// embedding; then its passages go live for Ask. Otherwise it failed, with the reason in words and how to add it, and its
// passages never go live, so nothing half-read answers a question; the minute sweep clears them (knowledge/tidy). The
// person who added it is told either way. Runs that agents' tools start reach this, so it changes passages one at a
// time and deletes nothing: the bulk delete is the sweep's.
import { and, c, cmp, col, cond, defineFunction, expr, fl, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { changed, notify } from "../../base/functions.js";
import { kb_passage } from "../../table/knowledge/kb_passage.js";
import { kb_source } from "../../table/knowledge/kb_source.js";
import { ai_run, RUN_FINAL } from "../../table/studio/ai_run.js";
import { ai_step } from "../../table/studio/ai_step.js";

/** Reasons whose words already say what to do. */
const SAYS_WHAT_TO_DO = ["too_long", "no_text", "no_speech", "unsupported"];
const AGAIN = " Upload it again to retry.";
export const SETTLE_WORDS = {
  timeout: "Reading it took longer than the time limit. Split it into smaller files and upload them again.",
  blocked: "The model declined to read it. Check it's a document or recording you meant to add, then upload it again.",
  failed: `It couldn't be read, because the model call failed.${AGAIN}`,
  empty: "Nothing in it could be read as text. Upload it again as a text-based file to add it.",
  embedding: "It was read, but some passages couldn't be embedded because the model call failed. Retry to finish it: what was read is kept.",
} as const;

export const settleSourceFn = defineFunction({
  name: "knowledge/settle",
  description: "When a source's run has ended, make the source ready (its passages live) or failed with the reason, and tell whoever added it.",
  input: { run_id: input.int({ required: true }) },
  stack: [
    s.set_var("settled", c.text("")),
    s.set_var("why", c.text("")),
    s.db.query({ table: kb_source, where: cmp(col("run_id"), "=", inp("run_id")), returnType: "single", as: "source" }),
    s.db.get({ table: ai_run, fieldValue: inp("run_id"), output: ["id", "status", "detail"], as: "run" }),
    s.conditional({ when: [
      expr(ref("source"), "!=", c.null()), expr(ref("run"), "!=", c.null()),
      expr(ref("source.status", { safe: true }), "=", c.text("processing")), cond.in(ref("run.status", { safe: true }), c.array([...RUN_FINAL])),
    ], then: [
      s.db.query({ table: kb_passage, where: cmp(col("source_id"), "=", ref("source.id")), returnType: "count", as: "total" }),
      s.db.query({ table: kb_passage, where: [cmp(col("source_id"), "=", ref("source.id")), cmp(col("embedding"), "=", c.null())], returnType: "count", as: "missing" }),
      s.conditional({
        when: [expr(ref("run.status"), "=", c.text("done")), expr(ref("total"), ">", c.int(0)), expr(ref("missing"), "=", c.int(0))],
        then: [
          s.db.query({ table: kb_passage, where: cmp(col("source_id"), "=", ref("source.id")), output: ["id"], paging: { per_page: 5000, metadata: false }, as: "going_live" }),
          s.foreach({ list: ref("going_live"), as: "passage", body: [
            s.db.patch({ table: kb_passage, fieldValue: ref("passage.id"), data: obj({ live: c.bool(true) }) }),
          ] }),
          s.db.patch({ table: kb_source, fieldValue: ref("source.id"), data: obj({ status: c.text("ready"), detail: c.text(""), passages: ref("total"), ready_at: c.now(), can_retry: c.bool(false) }) }),
          s.update_var("settled", c.text("ready")),
        ],
        else: [
          // The first step that went wrong says why; a run that was refused or declined says so itself.
          s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", inp("run_id")), sort: [{ sortBy: "seq", dir: "asc" }], output: ["seq", "kind", "status", "reason", "detail", "optional"], as: "steps" }),
          s.array.find({ expr: ref("steps"), as: "wrong", if: [
            expr(ref("$this.optional"), "!=", c.bool(true)),
            cond.in(ref("$this.status"), c.array(["failed", "blocked", "timed_out"])),
          ] }),
          s.update_var("why", c.text("")),
          s.conditional({
            when: cond.in(ref("run.status"), c.array(["refused", "declined", "stopped"])),
            then: [s.update_var("why", withFilters(ref("run.detail"), fl.first_notnull(c.text("")), fl.concat(c.text(" Then upload it again."))))],
            elif: [
              { when: expr(ref("wrong"), "=", c.null()), then: [s.update_var("why", c.text(SETTLE_WORDS.empty))] },
              { when: cond.in(ref("wrong.reason"), c.array(SAYS_WHAT_TO_DO)), then: [s.update_var("why", ref("wrong.detail"))] },
              { when: expr(ref("wrong.status"), "=", c.text("timed_out")), then: [s.update_var("why", c.text(SETTLE_WORDS.timeout))] },
              { when: expr(ref("wrong.status"), "=", c.text("blocked")), then: [s.update_var("why", c.text(SETTLE_WORDS.blocked))] },
            ],
            else: [s.update_var("why", c.text(SETTLE_WORDS.failed))],
          }),
          // Only embedding calls failed, and everything was read: the passages stay, and a retry needs no file.
          s.array.filter_count({ expr: ref("steps"), as: "bad_steps", if: and(
            expr(ref("$this.optional"), "!=", c.bool(true)), cond.in(ref("$this.status"), c.array(["failed", "blocked", "timed_out"])),
          ) }),
          s.array.filter_count({ expr: ref("steps"), as: "bad_embeds", if: and(
            expr(ref("$this.kind"), "=", c.text("embedding")), cond.in(ref("$this.status"), c.array(["failed", "timed_out"])), expr(ref("$this.reason"), "!=", c.text("rejected")),
          ) }),
          s.array.filter_count({ expr: ref("steps"), as: "unread", if: and(expr(ref("$this.kind"), "=", c.text("text")), expr(ref("$this.status"), "!=", c.text("succeeded")), expr(ref("$this.status"), "!=", c.text("released"))) }),
          s.set_var("can_retry", c.bool(false)),
          s.conditional({ when: [
            expr(ref("run.status"), "=", c.text("partial")), expr(ref("bad_steps"), ">", c.int(0)), expr(ref("bad_embeds"), "=", ref("bad_steps")),
            expr(ref("unread"), "=", c.int(0)), expr(ref("total"), ">", c.int(0)),
          ], then: [s.update_var("can_retry", c.bool(true)), s.update_var("why", c.text(SETTLE_WORDS.embedding))] }),
          s.db.patch({ table: kb_source, fieldValue: ref("source.id"), data: obj({ status: c.text("failed"), detail: ref("why"), passages: c.int(0), can_retry: ref("can_retry") }) }),
          s.update_var("settled", c.text("failed")),
        ],
      }),
      s.conditional({
        when: expr(ref("settled"), "=", c.text("ready")),
        then: [
          changed({ entity: "kb_source", id: ref("source.id"), op: "updated", verb: "added", actor: ref("source.added_by"), link: "/knowledge/sources",
            title: withFilters(ref("source.title"), fl.concat(c.text(" to Knowledge"))) }),
          notify({ to: ref("source.added_by"), kind: "knowledge", actor: c.int(0), link: "/knowledge",
            title: withFilters(ref("source.title"), fl.concat(c.text(" is ready to ask about"))), body: c.text("Its passages are in Knowledge now.") }),
        ],
        else: [
          changed({ entity: "kb_source", id: ref("source.id"), op: "updated", actor: ref("source.added_by") }),
          notify({ to: ref("source.added_by"), kind: "knowledge", actor: c.int(0), link: "/knowledge/sources",
            title: withFilters(ref("source.title"), fl.concat(c.text(" couldn't be added to Knowledge"))), body: ref("why") }),
        ],
      }),
    ] }),
  ],
  response: ref("settled"),
  responseShape: "" as "" | "ready" | "failed",
});

/**
 * Every minute (runs/sweep): a source whose run ended without settling it (declined or expired while it waited, or
 * interrupted) is settled, and the passages of a failed source that can't be retried are cleared.
 */
export const tidySourcesFn = defineFunction({
  name: "knowledge/tidy",
  description: "Settle sources whose run ended without saying so, and clear the passages of failed sources that can't be retried.",
  stack: [
    s.db.query({ table: kb_source, where: cmp(col("status"), "=", c.text("processing")), output: ["id", "run_id"], as: "open" }),
    s.set_var("settled", c.int(0)),
    s.foreach({ list: ref("open"), as: "one", body: [
      s.db.get({ table: ai_run, fieldValue: ref("one.run_id"), output: ["status"], as: "one_run" }),
      s.conditional({ when: cond.in(ref("one_run.status", { safe: true }), c.array([...RUN_FINAL])), then: [
        s.function.run({ fn: settleSourceFn, as: "repaired", input: { run_id: ref("one.run_id") } }),
        s.update_var("settled", withFilters(ref("settled"), fl.add(1))),
      ] }),
    ] }),
    s.db.query({ table: kb_source, where: [cmp(col("status"), "=", c.text("failed")), cmp(col("can_retry"), "=", c.bool(false))], output: ["id"], as: "failed" }),
    s.foreach({ list: ref("failed"), as: "gone", body: [
      s.db.bulk.delete({ table: kb_passage, where: cmp(col("source_id"), "=", ref("gone.id")), as: "dropped" }),
    ] }),
  ],
  response: { settled: ref("settled") },
});
