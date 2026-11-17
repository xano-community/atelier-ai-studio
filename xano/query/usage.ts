// Home, Usage, an admin's budget answer to "Ask an admin", and "Check again" for AI. Each door is thin: the function behind
// it checks the role, so a test and a route agree.
import { auth, inp, input, query, ref, s } from "@xano/sdk";
import { user } from "../table/user.js";
import { rbac } from "../rbac.js";
import { homeFn, type HomeView } from "../function/studio/home.js";
import { raiseForRunFn, usageFn, type UsageView } from "../function/spend/usage.js";
import { checkAiFn } from "../function/studio/check_ai.js";
import { studioGroup } from "./studio.js";
import { changed } from "../base/index.js";
import { settingsRow } from "../function/spend/begin.js";

/** GET studio/home: Home for the signed-in person, shaped by their role. */
export const homeRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "home", verb: "GET",
  description: "Home: spend against the month's budget (the team's for admins, your own otherwise), runs this week, the library, Knowledge, what's running and waiting, and the most-run recipes.",
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: homeFn, as: "home", input: { actor_id: auth("id") } }),
  ],
  response: ref("home"),
  responseShape: {} as HomeView,
});

/** GET studio/usage?month=2026-11: a month's estimated spend from the ledger. Admins. */
export const usageRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "usage", verb: "GET",
  description: "A month's estimated spend by person (with each key and route), kind, model and day, and each person's budget. Empty month: this one.",
  input: { month: input.text({ methods: ["trim"] }) },
  stack: [
    ...rbac.require("usage.read", "Only admins see the team's usage."),
    s.function.run({ fn: usageFn, as: "usage", input: { actor_id: auth("id"), month: inp("month") } }),
  ],
  response: ref("usage"),
  responseShape: {} as UsageView,
});

/** POST studio/runs/{id}/raise-budget: raise the owner's budget for this month, then approve the run they asked about. */
export const raiseBudgetRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "runs/{id}/raise-budget", verb: "POST",
  description: "Answer an over-budget request by raising its owner's budget for this month (micro-dollars), then approving the run.",
  input: { id: input.int({ required: true }), budget: input.int({ required: true }) },
  stack: [
    ...rbac.require("budgets.manage", "Only admins change budgets."),
    s.function.run({ fn: raiseForRunFn, as: "raised", input: { actor_id: auth("id"), run_id: inp("id"), budget: inp("budget") } }),
  ],
  response: ref("raised"),
  responseShape: {} as { run: { id: number; status: string; detail: string }; budget: { budget: number; reserved: number; spent: number } },
});

/**
 * POST studio/ai-status/check: send one small embedding; AI is on again when it comes back. Admins. Request history is
 * off: starting the check mints the background worker's token.
 */
export const checkAiRoute = query({
  apiGroup: studioGroup, auth: user, history: false,
  name: "ai-status/check", verb: "POST",
  description: "Check whether Xano AI answers again, with one small embedding through the spend gate. The same client_id twice checks once.",
  input: { client_id: input.text({ required: true, methods: ["trim"] }) },
  stack: [
    ...rbac.require("team.manage", "Only admins check whether AI is back."),
    s.function.run({ fn: checkAiFn, as: "checked", input: { actor_id: auth("id"), idem_key: inp("client_id") } }),
    // Every open screen reads the status again: Generate turns back on everywhere at once.
    settingsRow("settings"),
    changed({ entity: "settings", id: ref("settings.id", { safe: true }), op: "updated" }),
  ],
  response: ref("checked"),
  responseShape: {} as { ok: boolean; run_status: string; detail: string; ai_status: string; ai_status_reason: string },
});

export const usageQueries = [homeRoute, usageRoute, raiseBudgetRoute, checkAiRoute];
