// The studio's own endpoints for runs, budgets and AI status. Each is a thin door onto a function the assistant, the
// recipe API and agents share, so the spend gate and the roles apply the same way whoever asks.
import { apiGroup, auth, c, cmp, col, cond, expr, fl, guard, inp, input, obj, query, ref, s, sys, withFilters } from "@xano/sdk";
import { APP } from "../app.js";
import { changed, workspace_setting } from "../base/index.js";
import { rbac } from "../rbac.js";
import { budget_month } from "../table/studio/budget_month.js";
import { user } from "../table/user.js";
import { settingsRow, thisMonth } from "../function/spend/begin.js";
import { setBudgetsFn, setPersonBudgetFn } from "../function/spend/budgets.js";
import { askAdminFn, confirmRunFn, startRunFn } from "../function/runs/start.js";
import { goFn } from "../function/runs/background.js";
import { retryRunFn, stopRunFn, viewRunFn } from "../function/runs/control.js";
import { readRun } from "../function/runs/reserve.js";
import { STEP_KINDS } from "../table/studio/ai_step.js";
import { aiStatusFn } from "../function/studio/ai_status.js";
import { aiStateFn, type AiState } from "../function/studio/ai_state.js";
import { storageCheckFn } from "../function/library/media.js";
import { checkModelsFn } from "../function/studio/catalog.js";
import { AI_STATUSES } from "../base/tables.js";

export const studioGroup = apiGroup({ name: "studio", canonical: "studio", description: "Runs, budgets and AI status." });

type StepView = { id: number; seq: number; kind: string; model: string; status: string; reason: string; detail: string; attempt: number; output: Record<string, unknown>; usage: Record<string, unknown>; estimate: number; charged: number; brand_applied: boolean; asset_id: number; url: string; blob_id?: number };
type RunView = { id: number; kind: string; via: string; title: string; status: string; reason: string; detail: string; estimate: number; spent: number; private: boolean; approval_id: number; created_at: number; finished_at: number | null };

/** Kinds the brand kit can be added to. It is, unless the run turns it off. */
const BRANDABLE = ["text", "image", "video", "speech", "music"];
/** Where an attached file goes in each kind's input. */
const FILE_SLOT: Record<string, { key: string; list: boolean }> = {
  text: { key: "files", list: true }, image: { key: "images", list: true }, video: { key: "image", list: false }, transcribe: { key: "audio", list: false },
};
const PROMPTED = ["text", "image", "video", "music"];
const KIND_LABEL = c.obj({ text: "Text", image: "Image", video: "Video", music: "Music", speech: "Speech", transcribe: "Transcript", embedding: "Embedding", rerank: "Rerank" });

/**
 * POST studio/runs: start a run from the app. Either one step (`kind`, `model`, `input`, `options`, and a `file` for an
 * image to edit, a recording to transcribe, a document to read or a video's first frame) or a list of `steps`.
 * `client_id` is the click's own key: the same click sent twice is one run. A run of one quick step answers with its
 * result; video, music and runs of several steps answer at once and carry on in the background. Request history is off:
 * this request mints the background worker's token.
 */
export const startRunRoute = query({
  apiGroup: studioGroup, auth: user, history: false,
  name: "runs", verb: "POST",
  description: "Start a run from the app: one step by kind and model, or a list of steps. A repeat of the same client_id returns the first run; the same client_id with a different request is 409.",
  input: {
    client_id: input.text({ required: true, methods: ["trim"] }),
    kind: input.enum(STEP_KINDS),
    model: input.text({ methods: ["trim"] }),
    /** The step's input: prompt, system, text, voice, temperature, response_format, json_schema, use_brand… */
    input: input.json(),
    /** What the estimate prices: output_tokens, size, seconds, resolution, audio, samples, aspect_ratio. */
    options: input.json(),
    file: input.file(),
    title: input.text({ methods: ["trim"] }),
    private: input.bool(),
    /** Several steps, in order: [{ kind, model, input, options, depends_on, optional }]. */
    steps: input.json(),
  },
  stack: [
    ...rbac.signedIn(),
    s.set_var("base", withFilters(c.regex(/\/api:.*$/), fl.regex_replace(c.text(""), sys.apiBaseUrl()))),
    s.set_var("asked_steps", c.array([])),
    s.conditional({ when: expr(withFilters(inp("steps"), fl.is_array()), "=", c.bool(true)), then: [s.update_var("asked_steps", inp("steps"))] }),
    // Inputs read inside filters are bound first.
    s.set_var("want_kind", withFilters(inp("kind"), fl.first_notnull(c.text("")))),
    s.set_var("want_model", withFilters(inp("model"), fl.first_notnull(c.text("")))),
    s.set_var("want_options", withFilters(inp("options"), fl.first_notnull(c.obj({})))),
    s.set_var("upload_file", inp("file")),
    s.set_var("title", withFilters(inp("title"), fl.first_notnull(c.text("")))),
    s.conditional({ when: expr(withFilters(ref("asked_steps"), fl.count()), "=", c.int(0)), then: [
      guard.require([expr(ref("want_kind"), "!=", c.text("")), expr(ref("want_model"), "!=", c.text(""))],
        { errorType: "badrequest", message: "Pick what to make and a model for it." }),
      s.set_var("asked", withFilters(inp("input"), fl.first_notnull(c.obj({})))),
      s.conditional({ when: [cond.in(ref("want_kind"), c.array(BRANDABLE)), expr(withFilters(ref("asked"), fl.has("use_brand")), "=", c.bool(false))], then: [
        s.update_var("asked", withFilters(ref("asked"), fl.set("use_brand", c.bool(true)))),
      ] }),
      s.conditional({ when: expr(ref("upload_file"), "!=", c.null()), then: [
        s.storage.read_file_resource({ value: ref("upload_file"), as: "upload" }),
        s.set_var("about", obj({ name: ref("upload.name"), size: ref("upload.size"), mime: ref("upload.mime") })),
        s.switch({ on: ref("want_kind"), default: [s.throw({ name: "FILE_NOT_TAKEN", status: 400, value: c.text("This kind doesn't take a file. Remove it and try again.") })],
          cases: Object.entries(FILE_SLOT).map(([kind, slot]) => ({ when: c.text(kind), break: true, body: [
            s.set_var("slot_value", slot.list ? withFilters(c.array([]), fl.append(ref("upload_file"), c.text(""))) : ref("upload_file")),
            s.update_var("asked", withFilters(ref("asked"), fl.set(slot.key, ref("slot_value")))),
          ] })) }),
        // The file token changes with every upload; its fingerprint doesn't, so a retried click is still the same request.
        s.set_var("sources", withFilters(c.array([]), fl.append(ref("about"), c.text("")))),
        s.set_var("file_sha", withFilters(ref("upload.data"), fl.sha256())),
        s.update_var("asked", withFilters(ref("asked"), fl.set("sources", ref("sources")), fl.set("file_sha", ref("file_sha")))),
      ] }),
      s.conditional({ when: cond.in(ref("want_kind"), c.array(PROMPTED)), then: [
        guard.require(expr(withFilters(ref("asked"), fl.get("prompt", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.trim()), "!=", c.text("")), { errorType: "badrequest", message: "Write a prompt first." }),
      ] }),
      s.conditional({ when: expr(ref("want_kind"), "=", c.text("speech")), then: [
        guard.require(expr(withFilters(ref("asked"), fl.get("text", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.trim()), "!=", c.text("")), { errorType: "badrequest", message: "Write the words to say first." }),
      ] }),
      s.conditional({ when: expr(ref("want_kind"), "=", c.text("transcribe")), then: [
        guard.require(expr(ref("upload_file"), "!=", c.null()), { errorType: "badrequest", message: "Attach a recording to transcribe." }),
      ] }),
      s.conditional({ when: expr(ref("title"), "=", c.text("")), then: [
        s.set_var("kind_name", withFilters(KIND_LABEL, fl.get(ref("want_kind"), "Run"))),
        s.update_var("title", withFilters(ref("kind_name"), fl.concat(c.text(" with ")), fl.concat(ref("want_model")))),
      ] }),
      s.set_var("one_step", obj({ kind: ref("want_kind"), model: ref("want_model"), input: ref("asked"), options: ref("want_options") })),
      s.update_var("asked_steps", withFilters(c.array([]), fl.append(ref("one_step"), c.text("")))),
    ] }),
    // A model the catalog doesn't offer is refused here, before the run row or any reservation.
    s.function.run({ fn: checkModelsFn, as: "models_ok", input: { steps: ref("asked_steps") } }),
    s.function.run({ fn: startRunFn, as: "started", input: {
      owner_id: auth("id"), kind: c.text("playground"), via: c.text("ui"), connection_id: c.int(0), idem_key: inp("client_id"), recipe_id: c.int(0),
      title: ref("title"), private: inp("private"), base_url: ref("base"), agent_label: c.text(APP.name), steps: ref("asked_steps"),
    } }),
    s.conditional({ when: expr(ref("started.outcome"), "=", c.text("conflict")), then: [
      s.throw({ name: "IDEMPOTENCY_KEY_REUSED", value: c.text("That client_id was already used for a different request. Send a new one for a new run."), status: 409 }),
    ] }),
    s.conditional({ when: expr(ref("started.outcome"), "=", c.text("created")), then: [
      s.function.run({ fn: goFn, as: "went", input: { run_id: ref("started.run.id"), inline: c.bool(true) } }),
    ] }),
    s.function.run({ fn: viewRunFn, as: "view", input: { run_id: ref("started.run.id"), actor_id: auth("id") } }),
  ],
  response: { outcome: ref("started.outcome"), run: ref("view.run"), steps: ref("view.steps") },
  responseShape: {} as { outcome: "created" | "existing"; run: RunView; steps: StepView[] },
});

/** GET studio/runs/{id}: a run and its steps, for its owner, an admin, or a teammate when it isn't private. */
export const readRunRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "runs/{id}", verb: "GET",
  description: "A run and its steps, with each output and a one-minute link to any file. Private runs: owner and admins only.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: viewRunFn, as: "view", input: { run_id: inp("id"), actor_id: auth("id") } }),
  ],
  response: { run: ref("view.run"), steps: ref("view.steps") },
  responseShape: {} as { run: RunView; steps: StepView[] },
});

/** POST studio/runs/{id}/stop: stop a run. Steps not yet sent are released; one already sent finishes and is charged. */
export const stopRunRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "runs/{id}/stop", verb: "POST",
  description: "Stop a run: what wasn't sent is released, a step already sent finishes and is charged, and the run ends stopped.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: stopRunFn, as: "run", input: { run_id: inp("id"), actor_id: auth("id") } }),
  ],
  response: ref("run"),
  responseShape: {} as RunView,
});

/** POST studio/runs/{id}/retry: run the failed, blocked and timed-out steps again. `client_id` is this click's own key. */
export const retryRunRoute = query({
  apiGroup: studioGroup, auth: user, history: false,
  name: "runs/{id}/retry", verb: "POST",
  description: "Retry a run's failed, blocked and timed-out steps with new reservations. The same client_id twice retries once.",
  input: {
    id: input.int({ required: true }), client_id: input.text({ required: true, methods: ["trim"] }),
    /** A new prompt for a blocked or failed step: [{ step_id, prompt }]. */
    edits: input.json(),
  },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: retryRunFn, as: "retried", input: { run_id: inp("id"), actor_id: auth("id"), key: inp("client_id"), edits: inp("edits") } }),
    s.conditional({ when: expr(ref("retried.outcome"), "=", c.text("created")), then: [
      s.function.run({ fn: goFn, as: "went", input: { run_id: inp("id"), inline: c.bool(true) } }),
    ] }),
    s.function.run({ fn: viewRunFn, as: "view", input: { run_id: inp("id"), actor_id: auth("id") } }),
  ],
  response: { outcome: ref("retried.outcome"), run: ref("view.run"), steps: ref("view.steps") },
  responseShape: {} as { outcome: "created" | "existing"; run: RunView; steps: StepView[] },
});

/** POST studio/runs/{id}/confirm: an admin starts their own run above the approval line. Only the app can. */
export const confirmRunRoute = query({
  apiGroup: studioGroup, auth: user, history: false,
  name: "runs/{id}/confirm", verb: "POST",
  description: "Confirm your own run above the approval line. It reserves now, or is refused for the budget.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: confirmRunFn, as: "confirmed", input: { run_id: inp("id"), actor_id: auth("id"), via: c.text("ui") } }),
    s.function.run({ fn: goFn, as: "went", input: { run_id: inp("id"), inline: c.bool(true) } }),
    readRun(inp("id"), "run"),
  ],
  response: ref("run"),
  responseShape: {} as RunView,
});

/** POST studio/runs/{id}/ask-admin: send a run your budget refused to the admins. */
export const askAdminRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "runs/{id}/ask-admin", verb: "POST",
  description: "Ask an admin to approve a run your budget refused. Nothing is charged until they do.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: askAdminFn, as: "run", input: { run_id: inp("id"), actor_id: auth("id") } }),
  ],
  response: ref("run"),
  responseShape: {} as RunView,
});

type MonthRow = { id: number; scope: "team" | "person"; subject_id: number; month: string; budget: number; reserved: number; spent: number; headroom: number };

/** GET studio/budgets: this month's budgets and what's left, for the team and each person who has used AI. Admins. */
export const budgetsRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "budgets", verb: "GET",
  description: "This month's budgets, reserved, spent and left, for the team and each person, plus the defaults and the approval line.",
  stack: [
    ...rbac.require("budgets.manage", "Only admins see the budgets."),
    ...thisMonth(),
    settingsRow("settings"),
    guard.found("settings", { message: "The workspace has no settings row." }),
    s.db.query({ table: budget_month, where: cmp(col("month"), "=", ref("month")), sort: [{ sortBy: "scope", dir: "desc" }, { sortBy: "subject_id", dir: "asc" }],
      paging: { per_page: 500, metadata: false }, as: "rows" }),
  ],
  response: {
    month: ref("month"), month_words: ref("month_words"), rows: ref("rows"),
    team_budget: ref("settings.team_budget"), person_budget: ref("settings.person_budget"), approval_line: ref("settings.approval_line"),
  },
  responseShape: {} as { month: string; month_words: string; rows: MonthRow[]; team_budget: number; person_budget: number; approval_line: number },
});

/** PATCH studio/budgets: change the monthly budgets and the approval line. Admins. -1 leaves one as it is. */
export const updateBudgetsRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "budgets", verb: "PATCH",
  description: "Change the team budget, the per-person budget and the approval line (micro-dollars; -1 leaves one alone). This month moves by the difference.",
  input: { team_budget: input.int(), person_budget: input.int(), approval_line: input.int() },
  stack: [
    ...rbac.require("budgets.manage", "Only admins change budgets."),
    s.function.run({ fn: setBudgetsFn, as: "now", input: { actor_id: auth("id"), team_budget: inp("team_budget"), person_budget: inp("person_budget"), approval_line: inp("approval_line") } }),
    settingsRow("settings"),
    changed({ entity: "settings", id: ref("settings.id", { safe: true }), op: "updated", verb: "updated", title: "changed the AI budgets", link: "/settings" }),
  ],
  response: ref("now"),
  responseShape: {} as { team_budget: number; person_budget: number; approval_line: number },
});

/** POST studio/budgets/people/{id}: one person's budget for this month. Admins. */
export const personBudgetRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "budgets/people/{id}", verb: "POST",
  description: "Set one person's budget for this month (micro-dollars). What's reserved and spent stays; what's left moves.",
  input: { id: input.int({ required: true }), budget: input.int({ required: true }) },
  stack: [
    ...rbac.require("budgets.manage", "Only admins change budgets."),
    s.function.run({ fn: setPersonBudgetFn, as: "row", input: { actor_id: auth("id"), person_id: inp("id"), budget: inp("budget") } }),
    changed({ entity: "budget", id: ref("row.id"), op: "updated", verb: "updated", title: "changed a person's AI budget for this month", link: "/settings", privateTo: inp("id") }),
  ],
  response: ref("row"),
  responseShape: {} as MonthRow,
});

/** POST studio/ai-status: at first run, what the deploy reported about Xano AI and the plan. Admins. */
export const aiStatusRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "ai-status", verb: "POST",
  description: "Record whether Xano AI can run here, and what the plan allows, from what the deploy reported.",
  input: { status: input.enum(AI_STATUSES, { required: true }), plan_paid_storage: input.bool(), plan_async: input.bool() },
  stack: [
    ...rbac.require("team.manage", "Only admins set up AI."),
    s.function.run({ fn: aiStatusFn, as: "status", input: { status: inp("status"), error: c.text(""), http_status: c.int(0) } }),
    settingsRow("settings"),
    guard.found("settings", { message: "The workspace has no settings row." }),
    s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ plan_paid_storage: inp("plan_paid_storage"), plan_async: inp("plan_async"), storage_checked: c.bool(true) }) }),
    changed({ entity: "settings", id: ref("settings.id"), op: "updated" }),
  ],
  response: { ai_status: ref("status.ai_status"), ai_status_reason: ref("status.ai_status_reason"), plan_paid_storage: inp("plan_paid_storage"), plan_async: inp("plan_async") },
  responseShape: {} as { ai_status: string; ai_status_reason: string; plan_paid_storage: boolean; plan_async: boolean },
});

/** GET studio/ai-state: whether AI can run here now, in words for this person, and what the plan lets the workspace keep. */
export const aiStateRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "ai-state", verb: "GET",
  description: "Whether Xano AI can run here now, why not in words for you, the fix for an admin, and which kinds this plan can keep.",
  stack: [...rbac.signedIn(), s.function.run({ fn: aiStateFn, as: "state", input: { actor_id: auth("id") } })],
  response: ref("state"),
  responseShape: {} as AiState,
});

/**
 * POST studio/storage-check: the first-run check, once per workspace, made by the first admin who opens Home. It stores a
 * tiny recording privately to learn whether this plan keeps video, music and speech files, and how made files are shown.
 */
export const storageCheckRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "storage-check", verb: "POST",
  description: "Once per workspace: check whether this plan keeps video, music and speech files, and how made files are shown here. Admins.",
  stack: [
    ...rbac.require("team.manage", "Only admins run the first-run check."),
    s.function.run({ fn: storageCheckFn, as: "checked" }),
    settingsRow("settings"),
    guard.found("settings", { message: "The workspace has no settings row." }),
    changed({ entity: "settings", id: ref("settings.id"), op: "updated" }),
  ],
  response: ref("checked"),
  responseShape: {} as { plan_paid_storage: boolean; file_mode: string; storage_checked: boolean },
});

export const studioQueries = [startRunRoute, readRunRoute, stopRunRoute, retryRunRoute, confirmRunRoute, askAdminRoute, budgetsRoute, updateBudgetsRoute, personBudgetRoute, aiStatusRoute, aiStateRoute, storageCheckRoute];
