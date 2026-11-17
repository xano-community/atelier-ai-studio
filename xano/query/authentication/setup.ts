// First-admin setup: the only way into a production deploy, which ships no people and no settings row (xano/production.ts).
// auth/status tells the sign-in screen whether to offer it; auth/setup creates the settings row with the production budgets
// and the first admin, and signs them in. Both are public because nobody has an account yet.
import { c, cmp, col, defineFunction, env, expr, fl, guard, inp, input, obj, query, ref, s, sys, withFilters } from "@xano/sdk";
import { APP } from "../../app.js";
import { Getting_Started_Template_create_event_log } from "../../_shared.js";
import { workspace_setting } from "../../base/tables.js";
import { DEFAULT_APPROVAL_LINE, DEFAULT_PERSON_BUDGET, DEFAULT_TEAM_BUDGET } from "../../prices.js";
import { user } from "../../table/user.js";
import { Authentication } from "../authentication.js";

export const ALREADY_SET_UP = "This workspace is already set up. Sign in instead.";

/**
 * Create the settings row and the first admin, in one transaction, and answer the admin's id. `expected_token` is the
 * backend's SETUP_TOKEN: while it is empty, setup is refused whatever was submitted. A backend with a settings row, or with
 * an admin already, is set up.
 */
export const runSetupFn = defineFunction({
  name: "setup/run",
  description: "Create the first admin and the workspace's settings. Refused unless the setup token matches and nobody has set it up.",
  input: {
    submitted_token: input.text(), expected_token: input.text(),
    workspace_name: input.text({ methods: ["trim"] }), name: input.text({ methods: ["trim"] }),
    email: input.email({ methods: ["trim", "lower"] }), password: input.text(),
  },
  stack: [
    guard.require(expr(withFilters(inp("expected_token"), fl.first_notnull(c.text("")), fl.strlen()), ">=", c.int(1)), { errorType: "accessdenied", message: "Setup is off. Set SETUP_TOKEN on this backend, then try again." }),
    guard.require(expr(inp("submitted_token"), "=", inp("expected_token")), { errorType: "accessdenied", message: "That setup token isn't right." }),
    guard.require(expr(withFilters(inp("workspace_name"), fl.first_notnull(c.text("")), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Name the workspace." }),
    guard.require(expr(withFilters(inp("workspace_name"), fl.strlen()), "<=", c.int(60)), { errorType: "badrequest", message: "Keep the workspace name under 60 characters." }),
    guard.require(expr(withFilters(inp("name"), fl.first_notnull(c.text("")), fl.strlen()), ">=", c.int(1)), { errorType: "badrequest", message: "Add your name." }),
    guard.require(expr(withFilters(inp("email"), fl.first_notnull(c.text("")), fl.strlen()), ">=", c.int(3)), { errorType: "badrequest", message: "Add your email." }),
    guard.require(expr(withFilters(inp("password"), fl.first_notnull(c.text("")), fl.strlen()), ">=", c.int(8)), { errorType: "badrequest", message: "Choose a password of at least 8 characters, with a letter and a number." }),
    s.db.query({ table: workspace_setting, returnType: "count", as: "settings_rows" }),
    guard.require(expr(ref("settings_rows"), "=", c.int(0)), { errorType: "accessdenied", message: ALREADY_SET_UP }),
    s.set_var("admin_id", c.int(0)),
    s.db.transaction({ body: [
      s.db.query({ table: user, where: cmp(col("role"), "=", c.text("admin")), returnType: "count", as: "admins" }),
      guard.require(expr(ref("admins"), "=", c.int(0)), { errorType: "accessdenied", message: ALREADY_SET_UP }),
      s.db.query({ table: user, where: cmp(col("email"), "=", inp("email")), returnType: "count", as: "taken" }),
      guard.require(expr(ref("taken"), "=", c.int(0)), { errorType: "badrequest", message: "That email already has an account here. Use another, or sign in." }),
      s.db.add({ table: workspace_setting, as: "settings", row: {
        name: inp("workspace_name"), timezone: c.text("UTC"), week_start: c.text("monday"),
        team_budget: c.int(DEFAULT_TEAM_BUDGET), person_budget: c.int(DEFAULT_PERSON_BUDGET), approval_line: c.int(DEFAULT_APPROVAL_LINE),
        ai_status: c.text("on"), ai_status_reason: c.text(""), plan_paid_storage: c.bool(true), plan_async: c.bool(false), rerank_unavailable: c.bool(false),
        storage_checked: c.bool(false), file_mode: c.text(""),
      } }),
      s.db.add({ table: user, as: "admin", row: { name: inp("name"), email: inp("email"), password: inp("password"), role: c.text("admin") } }),
      s.update_var("admin_id", ref("admin.id")),
    ] }),
  ],
  response: obj({ user_id: ref("admin_id") }),
  responseShape: {} as { user_id: number },
});

/** GET auth/status: whether this backend still needs its first admin, and its name. Public: the sign-in screen asks first. */
export const authStatus = query({
  name: "auth/status", verb: "GET", apiGroup: Authentication,
  description: "Whether this backend needs first-admin setup, and the workspace's name.",
  stack: [
    s.db.query({ table: workspace_setting, sort: [{ sortBy: "id", dir: "asc" }], output: ["name"], returnType: "single", as: "settings" }),
    s.set_var("needs_setup", c.bool(false)),
    s.conditional({ when: expr(ref("settings"), "=", c.null()), then: [s.update_var("needs_setup", c.bool(true))] }),
  ],
  response: { needs_setup: ref("needs_setup"), name: withFilters(ref("settings.name", { safe: true }), fl.first_notnull(c.text(APP.name))) },
  responseShape: {} as { needs_setup: boolean; name: string },
});

/**
 * POST auth/setup: the first admin of an empty backend, signed in. Only a wrong token counts against the limit, and each
 * address has its own count, so a stranger guessing can't lock out the person who holds the token.
 */
export const authSetup = query({
  name: "auth/setup", verb: "POST", apiGroup: Authentication,
  description: "Set up an empty backend with its setup token: creates the first admin and signs them in.",
  input: {
    setup_token: input.text({ required: true }), workspace_name: input.text({ required: true }), name: input.text({ required: true }),
    email: input.email({ required: true, methods: ["trim", "lower"] }), password: input.text({ required: true }),
  },
  stack: [
    s.conditional({ when: expr(inp("setup_token"), "!=", env("SETUP_TOKEN")), then: [
      s.redis.ratelimit({ key: withFilters(c.text("rl:setup:"), fl.concat(sys.remoteIp())), max: c.int(10), ttl: c.int(300),
        error: c.text("Too many setup attempts. Wait a few minutes and try again.") }),
    ] }),
    s.function.run({ fn: runSetupFn, as: "setup_result", input: {
      submitted_token: inp("setup_token"), expected_token: env("SETUP_TOKEN"), workspace_name: inp("workspace_name"),
      name: inp("name"), email: inp("email"), password: inp("password"),
    } }),
    s.db.get({ table: user, fieldValue: ref("setup_result.user_id"), output: ["id", "created_at", "name", "email", "role"], as: "made" }),
    guard.found("made", { message: "Setup didn't finish. Try again." }),
    s.security.create_auth_token({ table: user, id: ref("made.id"), extras: c.obj({}), expiration: c.int(86400), as: "authToken" }),
    s.function.run({ fn: Getting_Started_Template_create_event_log, as: "event_log", input: {
      user_id: ref("made.id"), account_id: c.int(0), action: c.text("setup"),
      metadata: obj({ id: ref("made.id"), name: ref("made.name"), email: ref("made.email"), role: ref("made.role") }),
    } }),
  ],
  response: { authToken: ref("authToken"), user_id: ref("made.id") },
  responseShape: {} as { authToken: string; user_id: number },
});
