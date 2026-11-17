// Starting a run. The run row goes in first, outside any transaction, under a unique (owner, idem_key) index: a repeat of
// the same request (a double click, a client's retry, an agent calling its tool again) hits the duplicate, which is
// caught, and gets the run that's already there. The same key with a different request is refused. Only the first
// insert goes on to price the steps and decide: refuse, wait for an admin or for its owner's confirmation, or reserve.
import { c, cmp, col, cond, defineFunction, expr, fl, guard, inp, input, obj, or, ref, s, withFilters, type Value } from "@xano/sdk";
import { approvals } from "../../approvals.js";
import { notifyRoles } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { STEP_TIMEOUT_SECONDS } from "../../prices.js";
import { ai_run, RUN_KINDS, RUN_VIAS } from "../../table/studio/ai_run.js";
import { ai_step, STEP_KINDS } from "../../table/studio/ai_step.js";
import { user } from "../../table/user.js";
import { settingsRow } from "../spend/begin.js";
import { readRun, reserveRun } from "./reserve.js";
import { dollars, estimateFn } from "../spend/estimate.js";
import { studioChanged } from "../studio/changed.js";
import { NO_PAID_STORAGE_WORDS } from "../library/media.js";

export const MOST_STEPS = 20;
/** The longest a step may ask to run: a video's limit. */
const MOST_STEP_SECONDS = 600;
/** The kinds whose files a plan without paid storage can't keep. */
export const PAID_STORAGE_KINDS = ["video", "music", "speech"] as const;
export const PLAN_REFUSAL_WORDS = `${NO_PAID_STORAGE_WORDS} Nothing was made or charged.`;
/** Where a step's input holds a file token: a short-lived handle to an upload, not its content. */
export const FILE_TOKENS = ["files", "images", "image", "audio"];
/** Who decides a costly run, or one over budget: admins only. */
export const RUN_APPROVERS = rbac.rolesWith("budgets.manage");

/** Ask the admins, for a run of `ownerVar`, binding `asked` → { approval_id }. */
const askAdmins = (action: "costly_run" | "over_budget", run: string, owner: string, preview: Value) => [
  dollars("asked_cost", ref(`${run}.estimate`)),
  // The approval card already says whose run it is ("…, working for Priya Nair"); the bell's line names them.
  s.set_var("asked_title", withFilters(c.text("Run "), fl.concat(ref(`${run}.title`)), fl.concat(c.text(", estimated at ")), fl.concat(ref("asked_cost")))),
  s.set_var("rang_title", withFilters(ref(`${owner}.name`), fl.concat(c.text(" asks to run ")), fl.concat(ref(`${run}.title`)), fl.concat(c.text(", estimated at ")), fl.concat(ref("asked_cost")))),
  s.set_var("asked_source", c.text("assistant")),
  s.conditional({ when: expr(ref(`${run}.via`), "=", c.text("mcp")), then: [s.update_var("asked_source", c.text("mcp"))] }),
  s.function.run({ fn: approvals.requestApproval, as: "asked", input: {
    user_id: ref(`${run}.owner_id`), source: ref("asked_source"), agent_label: withFilters(ref("agent_label"), fl.first_notempty(c.text("Atelier"))),
    connection_id: ref(`${run}.connection_id`), action: c.text(action), title: ref("asked_title"), preview,
    link: withFilters(c.text("/runs/"), fl.concat(ref(`${run}.id`))), payload: obj({ run_id: ref(`${run}.id`) }),
  } }),
  notifyRoles({ roles: RUN_APPROVERS, kind: "approval", title: ref("rang_title"), body: preview, link: "/approvals", actor: ref(`${run}.owner_id`) }),
];

export const startRunFn = defineFunction({
  name: "runs/start",
  description: "Start a run once per idempotency key: price its steps, then refuse, wait for an admin or a confirmation, or reserve.",
  input: {
    owner_id: input.int({ required: true }),
    kind: input.enum(RUN_KINDS, { required: true }),
    via: input.enum(RUN_VIAS, { required: true }),
    connection_id: input.int(),
    idem_key: input.text({ required: true }),
    recipe_id: input.int(),
    title: input.text(),
    private: input.bool(),
    base_url: input.text(),
    /** Whose name an approval card shows as asking: the app, "Recipe API", an agent's name. */
    agent_label: input.text(),
    /** In order: [{ kind, model, input, options, depends_on, optional, timeout_s, skip }]. `skip` lists an optional step as skipped, with those words. */
    steps: input.json({ required: true }),
  },
  stack: [
    s.set_var("agent_label", inp("agent_label")),
    guard.require([expr(withFilters(inp("idem_key"), fl.first_notnull(c.text("")), fl.strlen()), ">=", c.int(1)), expr(withFilters(inp("idem_key"), fl.strlen()), "<=", c.int(200))],
      { errorType: "badrequest", message: "Every run needs an idempotency key of up to 200 characters, so a repeat doesn't run twice." }),
    s.db.get({ table: user, fieldValue: inp("owner_id"), output: ["id", "name", "role"], as: "owner" }),
    guard.found("owner", { errorType: "unauthorized", message: "Sign in again." }),
    s.switch({ on: inp("kind"), default: [rbac.allows(ref("owner.role"), "studio.run", "Your role can't run AI here. Ask an admin for access.")], cases: [
      { when: c.text("ask"), break: true, body: [rbac.allows(ref("owner.role"), "knowledge.ask", "Your role can't ask Knowledge.")] },
      { when: c.text("ingest"), break: true, body: [rbac.allows(ref("owner.role"), "knowledge.manage", "Your role can't add to Knowledge.")] },
      { when: c.text("check"), break: true, body: [rbac.allows(ref("owner.role"), "team.manage", "Only admins check whether AI is back.")] },
    ] }),
    s.set_var("step_list", withFilters(inp("steps"), fl.safe_array())),
    guard.require([expr(withFilters(ref("step_list"), fl.count()), ">=", c.int(1)), expr(withFilters(ref("step_list"), fl.count()), "<=", c.int(MOST_STEPS))],
      { errorType: "badrequest", message: `A run has 1 to ${MOST_STEPS} steps.` }),
    // A file's token changes with every upload, so the fingerprint leaves it out (its file_sha stays in).
    s.array.map({ source: ref("step_list"), as: "hashed_steps", transform: withFilters(ref("$this"), ...FILE_TOKENS.map((key) => fl.unset(`input.${key}`))) }),
    // Checked before the run row goes in, so a malformed request leaves nothing behind.
    s.array.filter_count({ expr: ref("step_list"), as: "malformed", if: or(
      expr(withFilters(c.array([...STEP_KINDS]), fl.in(withFilters(ref("$this"), fl.get("kind", "")))), "=", c.bool(false)),
      expr(withFilters(ref("$this"), fl.get("model", ""), fl.first_notnull(c.text(""))), "=", c.text("")),
    ) }),
    guard.require(expr(ref("malformed"), "=", c.int(0)), { errorType: "badrequest", message: `Each step needs a kind (${STEP_KINDS.join(", ")}) and a model.` }),
    s.set_var("body_hash", withFilters(obj({ kind: inp("kind"), recipe_id: inp("recipe_id"), private: inp("private"), steps: ref("hashed_steps") }), fl.json_encode(), fl.sha256())),

    // A repeat usually finds its run here. Two copies arriving together both miss it, and the unique index lets only one
    // insert through: the other's duplicate is caught and it reads the winner's run.
    s.set_var("outcome", c.text("existing")),
    s.db.query({ table: ai_run, where: [cmp(col("owner_id"), "=", inp("owner_id")), cmp(col("idem_key"), "=", inp("idem_key"))], output: ["id"], returnType: "single", as: "seen" }),
    s.conditional({ when: expr(ref("seen"), "=", c.null()), then: [
      s.try_catch({
        try: [
          s.db.add({ table: ai_run, as: "run", row: {
            owner_id: inp("owner_id"), kind: inp("kind"), via: inp("via"), connection_id: inp("connection_id"), idem_key: inp("idem_key"),
            body_hash: ref("body_hash"), recipe_id: inp("recipe_id"), title: withFilters(inp("title"), fl.first_notempty(c.text("AI run"))),
            status: c.text("starting"), reason: c.text(""), detail: c.text(""), estimate: c.int(0), spent: c.int(0),
            private: inp("private"), base_url: inp("base_url"), approval_id: c.int(0), is_demo: c.bool(false),
          } }),
          s.update_var("outcome", c.text("created")),
        ],
        catch: [],
      }),
    ] }),

    s.conditional({
      when: expr(ref("outcome"), "=", c.text("existing")),
      then: [
        s.db.query({ table: ai_run, where: [cmp(col("owner_id"), "=", inp("owner_id")), cmp(col("idem_key"), "=", inp("idem_key"))], output: ["id", "body_hash"], returnType: "single", as: "first" }),
        guard.found("first", { message: "That run couldn't be started. Try again." }),
        s.conditional({ when: expr(ref("first.body_hash"), "!=", ref("body_hash")), then: [s.update_var("outcome", c.text("conflict"))] }),
        s.set_var("run_id", ref("first.id")),
      ],
      else: [
        s.set_var("run_id", ref("run.id")),
        // Price every step before anything is stored: one without a price refuses the run.
        s.set_var("rows", c.array([])),
        s.set_var("total", c.int(0)),
        s.set_var("missing", c.text("")),
        s.set_var("has_video", c.bool(false)),
        s.foreach({ list: ref("step_list"), as: "asked_step", body: [
          s.set_var("step_kind", withFilters(ref("asked_step"), fl.get("kind", ""), fl.to_text())),
          s.set_var("step_model", withFilters(ref("asked_step"), fl.get("model", ""), fl.to_text())),
          s.set_var("step_options", withFilters(ref("asked_step"), fl.get("options", c.obj({})), fl.first_notnull(c.obj({})))),
          // An optional step the run already knows it can't do (a rerank with no model here) is listed as skipped, with
          // its reason, and isn't priced or reserved.
          s.set_var("skip_words", withFilters(ref("asked_step"), fl.get("skip", ""), fl.first_notnull(c.text("")), fl.to_text())),
          s.set_var("step_status", c.text("queued")),
          s.set_var("step_reason", c.text("")),
          s.set_var("step_optional", withFilters(ref("asked_step"), fl.get("optional", false), fl.first_notnull(c.bool(false)), fl.to_bool())),
          s.conditional({
            when: expr(ref("skip_words"), "!=", c.text("")),
            then: [
              s.set_var("priced", obj({ priced: c.bool(true), amount: c.int(0), detail: c.text("") })),
              s.update_var("step_status", c.text("skipped")), s.update_var("step_reason", c.text("unavailable")), s.update_var("step_optional", c.bool(true)),
            ],
            else: [s.function.run({ fn: estimateFn, as: "priced", input: { kind: ref("step_kind"), model: ref("step_model"), options: ref("step_options") } })],
          }),
          s.conditional({ when: [expr(ref("priced.priced"), "=", c.bool(false)), expr(ref("missing"), "=", c.text(""))], then: [s.update_var("missing", ref("priced.detail"))] }),
          s.conditional({ when: expr(ref("step_kind"), "=", c.text("video")), then: [s.update_var("has_video", c.bool(true))] }),
          s.set_var("kind_timeout", withFilters(c.obj(STEP_TIMEOUT_SECONDS), fl.get(ref("step_kind"), 120))),
          s.update_var("total", withFilters(ref("total"), fl.add(ref("priced.amount")))),
          s.update_var("rows", withFilters(ref("rows"), fl.array_push(obj({
            run_id: ref("run_id"), seq: withFilters(ref("rows"), fl.count(), fl.add(1)), kind: ref("step_kind"), model: ref("step_model"),
            label: withFilters(ref("asked_step"), fl.get("label", ""), fl.first_notnull(c.text("")), fl.to_text()),
            input: withFilters(ref("asked_step"), fl.get("input", c.obj({}))), options: ref("step_options"),
            depends_on: withFilters(ref("asked_step"), fl.get("depends_on", c.array([]))),
            optional: ref("step_optional"), status: ref("step_status"), reason: ref("step_reason"), detail: ref("skip_words"), attempt: c.int(1),
            // A step may ask for longer than its kind's limit (reading a long recording), up to the longest any kind gets.
            timeout_s: withFilters(ref("asked_step"), fl.get("timeout_s", c.null()), fl.first_notempty(ref("kind_timeout")), fl.to_int(), fl.clamp_max(MOST_STEP_SECONDS)),
            output: c.obj({}), usage: c.obj({}), estimate: ref("priced.amount"), charged: c.int(0),
          })))),
        ] }),
        // A plan that can't keep video, music or speech files (the first-run storage check said so) refuses those kinds
        // before anything is stored or reserved, rather than failing after the model was paid.
        settingsRow("plan_settings"),
        s.set_var("unkeepable", c.int(0)),
        s.conditional({ when: [expr(ref("plan_settings.storage_checked", { safe: true }), "=", c.bool(true)), expr(ref("plan_settings.plan_paid_storage", { safe: true }), "=", c.bool(false))], then: [
          s.array.filter_count({ expr: ref("rows"), as: "media_steps", if: cond.in(ref("$this.kind"), c.array([...PAID_STORAGE_KINDS])) }),
          s.update_var("unkeepable", ref("media_steps")),
        ] }),
        s.conditional({
          when: expr(ref("missing"), "!=", c.text("")),
          then: [s.db.patch({ table: ai_run, fieldValue: ref("run_id"), data: obj({ status: c.text("refused"), reason: c.text("no_price"), detail: ref("missing") }) })],
          elif: [{ when: expr(ref("unkeepable"), ">", c.int(0)), then: [
            s.db.patch({ table: ai_run, fieldValue: ref("run_id"), data: obj({ status: c.text("refused"), reason: c.text("plan"), detail: c.text(PLAN_REFUSAL_WORDS) }) }),
          ] }],
          else: [
            s.db.bulk.add({ table: ai_step, items: ref("rows"), as: "made_steps" }),
            s.db.patch({ table: ai_run, fieldValue: ref("run_id"), data: obj({ estimate: ref("total") }) }),
            settingsRow("settings"),
            s.set_var("line", withFilters(ref("settings.approval_line", { safe: true }), fl.first_notnull(c.int(0)))),
            dollars("cost_words", ref("total")),
            dollars("line_words", ref("line")),
            s.set_var("costly", c.expression("$var.total > $var.line")),
            s.set_var("is_admin", c.expression('$var.owner.role == "admin"')),
            s.conditional({
              when: [expr(ref("costly"), "=", c.bool(true)), expr(ref("is_admin"), "=", c.bool(true))],
              // An admin's own costly run needs their click in the app: an agent or a script can't supply it.
              then: [s.conditional({
                when: expr(inp("via"), "=", c.text("ui")),
                then: [s.db.patch({ table: ai_run, fieldValue: ref("run_id"), data: obj({ status: c.text("needs_confirmation"), reason: c.text("costly"),
                  detail: withFilters(c.text("This run is estimated at "), fl.concat(ref("cost_words")), fl.concat(c.text(", above the ")), fl.concat(ref("line_words")), fl.concat(c.text(" approval line. Confirm it to start."))) }) })],
                else: [s.db.patch({ table: ai_run, fieldValue: ref("run_id"), data: obj({ status: c.text("waiting_confirmation"), reason: c.text("costly"),
                  detail: withFilters(c.text("This run is estimated at "), fl.concat(ref("cost_words")), fl.concat(c.text(", above the ")), fl.concat(ref("line_words")), fl.concat(c.text(" approval line. Nothing is reserved until you confirm it in the app, under Runs."))) }) })],
              })],
              elif: [{
                when: or(expr(ref("costly"), "=", c.bool(true)), expr(c.expression("$var.has_video && !$var.is_admin"), "=", c.bool(true))),
                then: [
                  s.set_var("why", c.text("costly")),
                  s.set_var("wait_words", withFilters(c.text("This run is estimated at "), fl.concat(ref("cost_words")), fl.concat(c.text(", above the ")), fl.concat(ref("line_words")), fl.concat(c.text(" approval line, so it waits for an admin. Nothing is charged until it's approved.")))),
                  s.conditional({ when: expr(ref("costly"), "=", c.bool(false)), then: [
                    s.update_var("why", c.text("video")),
                    s.update_var("wait_words", withFilters(c.text("Video runs by members wait for an admin. This one is estimated at "), fl.concat(ref("cost_words")), fl.concat(c.text(", and nothing is charged until it's approved.")))),
                  ] }),
                  // A run of several steps says which of them need the approval: every video, and any step above the
                  // line on its own, or else the costliest one.
                  s.conditional({ when: expr(withFilters(ref("rows"), fl.count()), ">", c.int(1)), then: [
                    s.array.filter({ expr: ref("rows"), as: "costly_rows", if: or(expr(ref("$this.kind"), "=", c.text("video")), expr(ref("$this.estimate"), ">", ref("line"))) }),
                    s.conditional({ when: expr(withFilters(ref("costly_rows"), fl.count()), "=", c.int(0)), then: [
                      s.update_var("costly_rows", withFilters(ref("rows"), fl.fsort("estimate", "number", false), fl.array_slice(0, 1))),
                    ] }),
                    s.set_var("costly_names", c.array([])),
                    s.foreach({ list: ref("costly_rows"), as: "costly_row", body: [
                      dollars("costly_cost", ref("costly_row.estimate")),
                      s.array.push({ name: "costly_names", value: withFilters(c.text("step "), fl.concat(ref("costly_row.seq")), fl.concat(c.text(", ")),
                        fl.concat(withFilters(ref("costly_row.label"), fl.first_notempty(ref("costly_row.kind")))), fl.concat(c.text(" (")), fl.concat(ref("costly_cost")), fl.concat(c.text(")"))) }),
                    ] }),
                    s.update_var("wait_words", withFilters(ref("wait_words"), fl.concat(c.text(" Needs it: ")), fl.concat(withFilters(ref("costly_names"), fl.join("; "))), fl.concat(c.text(".")))),
                  ] }),
                  readRun(ref("run_id"), "waiting"),
                  guard.found("waiting", { message: "That run couldn't be started. Try again." }),
                  s.set_var("waiting_owner", ref("owner")),
                  ...askAdmins("costly_run", "waiting", "waiting_owner", ref("wait_words")),
                  s.db.patch({ table: ai_run, fieldValue: ref("run_id"), data: obj({ status: c.text("waiting_approval"), reason: ref("why"), detail: ref("wait_words"), approval_id: ref("asked.approval_id") }) }),
                ],
              }],
              else: [...reserveRun(ref("run_id"), c.bool(false))],
            }),
          ],
        }),
        studioChanged({ entity: "ai_run", id: ref("run_id"), owner: inp("owner_id"), private: inp("private"), op: "created" }),
      ],
    }),
    readRun(ref("run_id")),
  ],
  response: { outcome: ref("outcome"), run: ref("result") },
});

/** "Ask an admin" on a run refused for its budget: an admin may approve it over budget, once. */
export const askAdminFn = defineFunction({
  name: "runs/ask_admin",
  description: "Ask the admins to approve a run its owner's budget refused. Nothing is reserved while it waits.",
  input: { run_id: input.int({ required: true }), actor_id: input.int({ required: true }) },
  stack: [
    s.set_var("agent_label", c.text("")),
    s.db.get({ table: ai_run, fieldValue: inp("run_id"), as: "run" }),
    guard.found("run", { message: "No such run." }),
    guard.require(expr(ref("run.owner_id"), "=", inp("actor_id")), { errorType: "notfound", message: "No such run." }),
    guard.require([expr(ref("run.status"), "=", c.text("refused")), expr(ref("run.reason"), "=", c.text("over_budget"))],
      { errorType: "badrequest", message: "Only a run refused for its budget can go to an admin." }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "name", "role"], as: "owner" }),
    guard.found("owner", { errorType: "unauthorized", message: "Sign in again." }),
    // The steps a refusal skipped go back in the queue, unreserved, for the admin's decision.
    s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", inp("run_id")), cmp(col("status"), "=", c.text("skipped"))], output: ["id"], as: "skipped" }),
    s.foreach({ list: ref("skipped"), as: "step", body: [s.db.patch({ table: ai_step, fieldValue: ref("step.id"), data: obj({ status: c.text("queued"), reason: c.text(""), finished_at: c.null() }) })] }),
    ...askAdmins("over_budget", "run", "owner", ref("run.detail")),
    s.db.patch({ table: ai_run, fieldValue: inp("run_id"), data: obj({ status: c.text("waiting_approval"), approval_id: ref("asked.approval_id"),
      detail: c.text("Waiting for an admin to approve it over your budget. Nothing is charged until then.") }) }),
    studioChanged({ entity: "ai_run", id: inp("run_id"), owner: ref("run.owner_id"), private: ref("run.private") }),
    readRun(inp("run_id")),
  ],
  response: ref("result"),
});

/** An admin confirms their own costly run, in the app. Only then is anything reserved. */
export const confirmRunFn = defineFunction({
  name: "runs/confirm",
  description: "Confirm your own run above the approval line, from the app. It reserves now, or is refused for the budget.",
  input: { run_id: input.int({ required: true }), actor_id: input.int({ required: true }), via: input.enum(RUN_VIAS, { required: true }) },
  stack: [
    s.db.get({ table: ai_run, fieldValue: inp("run_id"), as: "run" }),
    guard.found("run", { message: "No such run." }),
    guard.require(expr(ref("run.owner_id"), "=", inp("actor_id")), { errorType: "notfound", message: "No such run." }),
    guard.require(expr(inp("via"), "=", c.text("ui")), { errorType: "accessdenied", message: "Confirm this run in the app, under Runs." }),
    guard.require(or(expr(ref("run.status"), "=", c.text("needs_confirmation")), expr(ref("run.status"), "=", c.text("waiting_confirmation"))),
      { errorType: "badrequest", message: "This run isn't waiting for a confirmation." }),
    ...reserveRun(inp("run_id"), c.bool(false)),
    studioChanged({ entity: "ai_run", id: inp("run_id"), owner: ref("run.owner_id"), private: ref("run.private") }),
    readRun(inp("run_id")),
  ],
  response: ref("result"),
});

/** How long a repeat of the same call without a key of its own counts as the same request. */
export const SAME_CALL_MS = 10 * 60_000;

/**
 * The idempotency key for a call that didn't bring one: the person, the tool, its arguments with their keys in order, and
 * the conversation turn when there is one (Easel) or the 10-minute window it falls in (the recipe API, MCP). A call id is
 * never part of it, because an agent's id changes when it calls again. The window lets a deliberate repeat later start a
 * new run instead of returning the old one for ever.
 */
export const deriveKeyFn = defineFunction({
  name: "runs/derive_key",
  description: "An idempotency key from the person, the tool, its sorted arguments, and the turn or the 10-minute window.",
  input: {
    actor_id: input.int({ required: true }), tool: input.text({ required: true }), args: input.json(), turn: input.text(),
    /** When the call came, in epoch ms: its window. 0 (or none) is now. */
    at: input.int(),
  },
  stack: [
    s.set_var("args", withFilters(inp("args"), fl.first_notnull(c.obj({})))),
    s.set_var("at", withFilters(inp("at"), fl.first_notempty(c.now()))),
    s.lambda({ as: "sorted", code: ({ $var }) => {
      const order = (v: unknown): unknown => Array.isArray(v) ? v.map(order)
        : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, order((v as Record<string, unknown>)[k])])) : v;
      return { text: JSON.stringify(order($var.args)) };
    } }),
    s.set_var("when", withFilters(inp("turn"), fl.first_notnull(c.text("")))),
    s.conditional({ when: expr(ref("when"), "=", c.text("")), then: [
      s.update_var("when", withFilters(c.text("window:"), fl.concat(withFilters(ref("at"), fl.div(SAME_CALL_MS), fl.floor(), fl.to_int())))),
    ] }),
    s.set_var("key", withFilters(inp("actor_id"), fl.to_text(), fl.concat(c.text("|")), fl.concat(inp("tool")), fl.concat(c.text("|")),
      fl.concat(withFilters(ref("sorted.text", { safe: true }), fl.first_notnull(c.text("")))), fl.concat(c.text("|")), fl.concat(ref("when")), fl.sha256())),
  ],
  response: withFilters(c.text("derived:"), fl.concat(ref("key"))),
  responseShape: "" as string,
});
