// Stopping, retrying and reading a run. Stop gives back the money of every step not yet sent; a step already sent
// finishes and is charged, because the gateway bills it. Retry gives each failed, blocked or timed-out step a new attempt
// with a new reservation (and the steps that were skipped because of them), and leaves what succeeded alone. Reading a
// run writes nothing: a file comes back as a 60-second signed link, minted only after the read rule passes.
import { and, c, cmp, col, cond, defineFunction, expr, fl, guard, inp, input, obj, or, ref, s, withFilters } from "@xano/sdk";
import { rbac } from "../../rbac.js";
import { settingsRow } from "../spend/begin.js";
import { dollars } from "../spend/estimate.js";
import { studioChanged } from "../studio/changed.js";
import { ai_run, RUN_FINAL } from "../../table/studio/ai_run.js";
import { ai_step } from "../../table/studio/ai_step.js";
import { user } from "../../table/user.js";
import { releaseUnsentFn, NOT_SENT_WORDS } from "./execute_step.js";
import { finishRunFn } from "./finish.js";
import { mediaLinkFn } from "../library/media.js";
import { readRun, reserveRun, RUN_FIELDS } from "./reserve.js";

const NOT_FOUND = { errorType: "notfound", message: "No such run." } as const;
const ADMINS = rbac.rolesWith("budgets.manage");
/** How long a link to a private file lasts. */
export const LINK_SECONDS = 60;
/** What a step's input holds that's a file token or its fingerprint: never sent back. */
const FILE_KEYS = ["files", "images", "image", "audio", "file_sha", "sample_output"];

export const stopRunFn = defineFunction({
  name: "runs/stop",
  description: "Stop a run: release every step not yet sent; a sent step finishes and is charged. The run ends stopped.",
  input: { run_id: input.int({ required: true }), actor_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: ai_run, fieldValue: inp("run_id"), as: "run" }),
    guard.found("run", NOT_FOUND),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    guard.require(or(expr(ref("run.owner_id"), "=", inp("actor_id")), cond.in(ref("actor.role"), c.array(ADMINS))), NOT_FOUND),
    s.conditional({ when: cond.notIn(ref("run.status"), c.array([...RUN_FINAL])), then: [
      s.function.run({ fn: releaseUnsentFn, as: "released", input: { run_id: inp("run_id"), reason: c.text("stopped"), detail: c.text(NOT_SENT_WORDS) } }),
      s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", inp("run_id")), cmp(col("status"), "=", c.text("working"))], returnType: "count", as: "still_out" }),
      s.set_var("words", c.text("Stopped. Nothing more will run, and nothing that wasn't sent was charged.")),
      s.conditional({ when: expr(ref("still_out"), ">", c.int(0)), then: [
        s.update_var("words", c.text("Stopped. The step already sent finishes and is charged; the rest were released.")),
      ] }),
      s.db.patch({ table: ai_run, fieldValue: inp("run_id"), data: obj({ status: c.text("stopped"), reason: c.text("stopped"), detail: ref("words"), finished_at: c.now() }) }),
      s.function.run({ fn: finishRunFn, as: "finished", input: { run_id: inp("run_id") } }),
      studioChanged({ entity: "ai_run", id: inp("run_id"), owner: ref("run.owner_id"), private: ref("run.private") }),
    ] }),
    readRun(inp("run_id")),
  ],
  response: ref("result"),
});

/** What a retry picks up: steps that ended without succeeding, and the ones skipped because of them. */
const RETRYABLE = ["failed", "blocked", "timed_out"];

/**
 * Retry the steps that didn't succeed. `key` is the click's own: the same click twice retries once. A retry reserves
 * like a new run, and one that would need an admin's approval (above the line, or a member's video) is refused here
 * with the words to start it as a new run instead.
 */
export const retryRunFn = defineFunction({
  name: "runs/retry",
  description: "Give a run's failed, blocked and timed-out steps a new attempt and reserve for them. The same key twice retries once.",
  input: {
    run_id: input.int({ required: true }), actor_id: input.int({ required: true }), key: input.text({ required: true }),
    /** A new prompt for a step that was blocked or failed: [{ step_id, prompt }]. */
    edits: input.json(),
  },
  stack: [
    guard.require([expr(withFilters(inp("key"), fl.first_notnull(c.text("")), fl.strlen()), ">=", c.int(1)), expr(withFilters(inp("key"), fl.strlen()), "<=", c.int(200))],
      { errorType: "badrequest", message: "A retry needs its own key of up to 200 characters, so a repeat doesn't retry twice." }),
    s.db.get({ table: ai_run, fieldValue: inp("run_id"), as: "run" }),
    guard.found("run", NOT_FOUND),
    guard.require(expr(ref("run.owner_id"), "=", inp("actor_id")), NOT_FOUND),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("actor.role"), "studio.run", "Your role can't run AI here. Ask an admin for access."),
    s.set_var("outcome", c.text("existing")),
    // The run row is the lock: two copies of one click can't both pass the key check.
    s.db.transaction({ body: [
      s.db.get({ table: ai_run, fieldValue: inp("run_id"), lock: true, output: ["id", "status", "retry_key"], as: "locked" }),
      guard.found("locked", NOT_FOUND),
      s.conditional({ when: expr(ref("locked.retry_key"), "!=", inp("key")), then: [
        guard.require(cond.in(ref("locked.status"), c.array(["partial", "failed", "stopped"])), { errorType: "badrequest", message: "Only a run that has ended with failed steps can be retried." }),
        s.db.patch({ table: ai_run, fieldValue: inp("run_id"), data: obj({ retry_key: inp("key") }) }),
        s.update_var("outcome", c.text("created")),
      ] }),
    ] }),
    s.conditional({ when: expr(ref("outcome"), "=", c.text("created")), then: [
      s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", inp("run_id")), sort: [{ sortBy: "seq", dir: "asc" }], as: "steps" }),
      s.array.filter({ expr: ref("steps"), as: "again", if: or(
        cond.in(ref("$this.status"), c.array(RETRYABLE)),
        and(expr(ref("$this.status"), "=", c.text("skipped")), expr(ref("$this.reason"), "=", c.text("dependency"))),
      ) }),
      guard.require(expr(withFilters(ref("again"), fl.count()), ">", c.int(0)), { errorType: "badrequest", message: "Nothing failed in this run, so there's nothing to retry." }),
      s.array.map({ source: ref("again"), as: "again_amounts", transform: ref("$this.estimate") }),
      s.set_var("total", withFilters(ref("again_amounts"), fl.sum(), fl.to_int())),
      s.array.filter_count({ expr: ref("again"), if: expr(ref("$this.kind"), "=", c.text("video")), as: "videos" }),
      settingsRow("settings"),
      s.set_var("line", withFilters(ref("settings.approval_line", { safe: true }), fl.first_notnull(c.int(0)))),
      s.set_var("is_admin", withFilters(c.array(ADMINS), fl.in(ref("actor.role")))),
      s.conditional({ when: or(expr(ref("total"), ">", ref("line")), and(expr(ref("videos"), ">", c.int(0)), expr(ref("is_admin"), "=", c.bool(false)))), then: [
        // Give the key back, so the same click can try again once things change.
        s.db.patch({ table: ai_run, fieldValue: inp("run_id"), data: obj({ retry_key: c.text("") }) }),
        dollars("cost_words", ref("total")),
        s.throw({ name: "RETRY_NEEDS_APPROVAL", status: 409, value: withFilters(c.text("Retrying these steps is estimated at "), fl.concat(ref("cost_words")),
          fl.concat(c.text(", which needs an admin's approval. Start it again as a new run, and it will wait for one."))) }),
      ] }),
      s.set_var("edits", withFilters(inp("edits"), fl.first_notnull(c.array([])), fl.safe_array())),
      s.foreach({ list: ref("again"), as: "one", body: [
        // An edited prompt replaces what the step asked for. A recipe step keeps it as its template, so the earlier
        // steps it names are filled in again when it runs.
        s.set_var("edit", c.null()),
        s.conditional({ when: expr(withFilters(ref("edits"), fl.count()), ">", c.int(0)), then: [
          s.array.find({ expr: ref("edits"), as: "edit", if: expr(ref("$this.step_id", { safe: true }), "=", ref("one.id")) }),
        ] }),
        s.set_var("new_prompt", withFilters(ref("edit.prompt", { safe: true }), fl.first_notnull(c.text("")), fl.to_text(), fl.trim())),
        s.conditional({ when: [expr(ref("new_prompt"), "!=", c.text("")), cond.in(ref("one.status"), c.array(["blocked", "failed"]))], then: [
          s.set_var("edited", withFilters(ref("one.input"), fl.first_notnull(c.obj({})))),
          s.set_var("prompt_key", c.text("prompt")),
          s.conditional({ when: expr(ref("one.kind"), "=", c.text("speech")), then: [s.update_var("prompt_key", c.text("text"))] }),
          s.update_var("edited", withFilters(ref("edited"), fl.set(ref("prompt_key"), ref("new_prompt")))),
          s.conditional({ when: expr(withFilters(ref("edited"), fl.get("fill", c.null()), fl.is_object()), "=", c.bool(true)), then: [
            s.update_var("edited", withFilters(ref("edited"), fl.set("fill.templates.prompt", ref("new_prompt")))),
          ] }),
          s.db.patch({ table: ai_step, fieldValue: ref("one.id"), data: obj({ input: ref("edited") }) }),
        ] }),
        s.db.patch({ table: ai_step, fieldValue: ref("one.id"), data: obj({
          attempt: withFilters(ref("one.attempt"), fl.add(1)), status: c.text("queued"), reason: c.text(""), detail: c.text(""), claimed: c.int(0),
          claimed_at: c.null(), sent_at: c.null(), finished_at: c.null(), output: c.obj({}), usage: c.obj({}), charged: c.int(0), asset_id: c.int(0), brand_applied: c.bool(false),
        }) }),
      ] }),
      s.db.patch({ table: ai_run, fieldValue: inp("run_id"), data: obj({ status: c.text("starting"), reason: c.text(""), detail: c.text(""), finished_at: c.null() }) }),
      ...reserveRun(inp("run_id"), c.bool(false)),
      studioChanged({ entity: "ai_run", id: inp("run_id"), owner: ref("run.owner_id"), private: ref("run.private") }),
    ] }),
    readRun(inp("run_id")),
  ],
  response: { outcome: ref("outcome"), run: ref("result") },
});

/**
 * A run and its steps, for someone allowed to see it: its owner, an admin, or (for a run the team can see) anyone but a
 * guest. Anyone else gets the same answer as for a run that doesn't exist. Files come back as links good for a minute.
 */
export const viewRunFn = defineFunction({
  name: "runs/view",
  description: "Read a run and its steps with their outputs, for its owner, an admin, or a teammate when it isn't private. Writes nothing.",
  input: { run_id: input.int({ required: true }), actor_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: ai_run, fieldValue: inp("run_id"), output: [...RUN_FIELDS], as: "run" }),
    guard.found("run", NOT_FOUND),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    guard.require(or(
      expr(ref("run.owner_id"), "=", inp("actor_id")),
      cond.in(ref("actor.role"), c.array(ADMINS)),
      and(expr(ref("run.private"), "!=", c.bool(true)), expr(ref("actor.role"), "!=", c.text("guest"))),
    ), NOT_FOUND),
    s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", inp("run_id")), sort: [{ sortBy: "seq", dir: "asc" }],
      output: ["id", "seq", "label", "kind", "model", "input", "options", "depends_on", "optional", "status", "reason", "detail", "attempt", "timeout_s", "claimed_at", "sent_at", "finished_at", "output", "usage", "estimate", "charged", "brand_applied", "asset_id"], as: "rows" }),
    s.set_var("steps", c.array([])),
    s.foreach({ list: ref("rows"), as: "row", body: [
      s.set_var("made", withFilters(ref("row.output"), fl.first_notnull(c.obj({})))),
      // A file shows through a one-minute link, or its table-kept bytes where this server can't sign (library/media.ts).
      s.function.run({ fn: mediaLinkFn, as: "shown", input: { file: withFilters(ref("made"), fl.get("file", c.null())), ttl: c.int(LINK_SECONDS) } }),
      s.set_var("link", ref("shown.url")),
      s.set_var("shown_input", withFilters(ref("row.input"), fl.first_notnull(c.obj({})), ...FILE_KEYS.map((key) => fl.unset(key)))),
      // A made file kept on hand for a later step is a token, never sent back.
      s.set_var("shown_output", withFilters(ref("made"), fl.unset("resource"))),
      s.update_var("steps", withFilters(ref("steps"), fl.array_push(withFilters(ref("row"), fl.set("input", ref("shown_input")), fl.set("output", ref("shown_output")), fl.set("url", ref("link")), fl.set("blob_id", ref("shown.blob_id")))))),
    ] }),
    // Whose run it is, by name, for a card an admin reads in someone else's name.
    s.db.get({ table: user, fieldValue: ref("run.owner_id"), output: ["name"], as: "run_owner" }),
    s.set_var("owner_name", withFilters(ref("run_owner.name", { safe: true }), fl.first_notnull(c.text("")))),
  ],
  response: { run: withFilters(ref("run"), fl.set("owner_name", ref("owner_name"))), steps: ref("steps") },
});
