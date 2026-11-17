// The Playground's own reads: the model list with what each costs, an estimate for the settings on screen, and the
// person's own history. Runs themselves start through POST studio/runs, the same door every app screen uses, so the
// catalog check, the idempotency key and the spend gate apply to them unchanged.
import { auth, c, cmp, col, expr, fl, guard, inp, input, obj, query, ref, s, withFilters } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { budget_month } from "../table/studio/budget_month.js";
import { price } from "../table/studio/price.js";
import { settingsRow, thisMonth } from "../function/spend/begin.js";
import { dollars, estimateFn } from "../function/spend/estimate.js";
import { CATALOG, PLAYGROUND_KINDS, type CatalogModel } from "../function/studio/catalog.js";
import { aiStateFn } from "../function/studio/ai_state.js";
import { HISTORY_PAGE, historyFn, useOutputFn } from "../function/studio/playground.js";
import { studioGroup } from "./studio.js";

const ADMINS = rbac.rolesWith("budgets.manage");
/** What everyone but an admin reads when AI is off: the fix is an admin's. */

/** The catalog's models for the kinds the Playground offers. */
const offered = Object.fromEntries(PLAYGROUND_KINDS.map((kind) => [kind, CATALOG.statements[kind] ?? []])) as Record<string, CatalogModel[]>;

type PlaygroundCatalog = {
  statements: Record<string, CatalogModel[]>;
  unavailable: Record<string, string>;
  synced_at: string;
  /** Models with at least one price row. One without is shown, but not run. */
  priced: string[];
  ai_status: "on" | "signed_out" | "no_credits" | "disabled" | "expired";
  ai_status_reason: string;
  /** For an admin, the command that turns AI on here, or "". */
  fix_command: string;
  /** False once the first-run check found this plan can't keep video, music or speech files. */
  plan_paid_storage: boolean;
  can_run: boolean;
  is_admin: boolean;
  budget: { month_words: string; used: number; budget: number };
};

/** GET studio/playground/catalog: the models to pick from, which have prices, whether AI can run, and this month's budget. */
export const playgroundCatalog = query({
  apiGroup: studioGroup, auth: user,
  name: "playground/catalog", verb: "GET",
  description: "The Xano AI models the Playground offers, which have a price, whether AI can run here, and your budget this month.",
  stack: [
    ...rbac.signedIn(),
    settingsRow("settings"),
    guard.found("settings", { message: "The workspace has no settings row." }),
    s.db.query({ table: price, output: ["model"], paging: { per_page: 2000, metadata: false }, as: "price_rows" }),
    s.array.map({ source: ref("price_rows"), as: "priced_all", transform: ref("$this.model") }),
    s.set_var("priced", withFilters(ref("priced_all"), fl.unique())),
    ...thisMonth(),
    s.db.query({ table: budget_month, returnType: "single", output: ["budget", "reserved", "spent"], as: "mine",
      where: [cmp(col("scope"), "=", c.text("person")), cmp(col("subject_id"), "=", auth("id")), cmp(col("month"), "=", ref("month"))] }),
    s.set_var("budget", withFilters(ref("mine.budget", { safe: true }), fl.first_notnull(ref("settings.person_budget")))),
    s.set_var("used", withFilters(ref("mine.reserved", { safe: true }), fl.first_notnull(c.int(0)), fl.add(withFilters(ref("mine.spent", { safe: true }), fl.first_notnull(c.int(0)))))),
    s.set_var("is_admin", withFilters(c.array(ADMINS), fl.in(ref("me.role")))),
    s.function.run({ fn: aiStateFn, as: "ai", input: { actor_id: auth("id") } }),
    s.set_var("can_run", withFilters(c.array(rbac.rolesWith("studio.run")), fl.in(ref("me.role")))),
  ],
  response: {
    statements: c.obj(offered as never), unavailable: c.obj(CATALOG.unavailable), synced_at: c.text(CATALOG.generated_at),
    priced: ref("priced"), ai_status: ref("ai.ai_status"), ai_status_reason: ref("ai.ai_status_reason"), fix_command: ref("ai.fix_command"),
    plan_paid_storage: ref("ai.plan_paid_storage"),
    can_run: ref("can_run"), is_admin: ref("is_admin"),
    budget: obj({ month_words: ref("month_words"), used: ref("used"), budget: ref("budget") }),
  },
  responseShape: {} as PlaygroundCatalog,
});

/** POST studio/playground/estimate: what one call with these settings is estimated to cost, from the price table. */
export const playgroundEstimate = query({
  apiGroup: studioGroup, auth: user,
  name: "playground/estimate", verb: "POST",
  description: "Estimate one model call from the price table (micro-dollars, the gateway's margin included). Writes nothing.",
  input: { kind: input.text({ required: true }), model: input.text({ required: true }), options: input.json() },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: estimateFn, as: "priced", input: { kind: inp("kind"), model: inp("model"), options: withFilters(inp("options"), fl.first_notnull(c.obj({}))) } }),
    dollars("words", ref("priced.amount")),
  ],
  response: { priced: ref("priced.priced"), amount: ref("priced.amount"), words: ref("words"), detail: ref("priced.detail") },
  responseShape: {} as { priced: boolean; amount: number; words: string; detail: string },
});

type HistoryRun = { id: number; idem_key: string; title: string; status: string; reason: string; estimate: number; spent: number; created_at: number; finished_at: number | null };
type HistoryStep = { id: number; run_id: number; seq: number; kind: string; model: string; status: string; usage: Record<string, number>; charged: number; estimate: number; asset_id: number };

/** GET studio/playground/history: your own Playground runs, newest first. Nobody else's, whatever their role. */
export const playgroundHistory = query({
  apiGroup: studioGroup, auth: user,
  name: "playground/history", verb: "GET",
  description: `Your own Playground runs, newest first, ${HISTORY_PAGE} a page, with each run's steps. Only you see your history.`,
  input: { page: input.int() },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: historyFn, as: "history", input: { actor_id: auth("id"), page: inp("page") } }),
  ],
  response: ref("history"),
  responseShape: {} as { runs: HistoryRun[]; steps: HistoryStep[]; more: boolean },
});

/**
 * POST studio/playground/steps/{id}/use: "Use this". The step's output is already a draft library item, private to its
 * maker; this puts it in the team's library, still a draft. Only the run's owner can, and only for an output that was kept.
 */
export const playgroundUse = query({
  apiGroup: studioGroup, auth: user,
  name: "playground/steps/{id}/use", verb: "POST",
  description: "Put a Playground output in the team's library as a draft. Only its maker can; the run itself stays private.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.require("studio.run", "Your role can't keep Playground outputs. Ask an admin for access."),
    s.function.run({ fn: useOutputFn, as: "used", input: { step_id: inp("id"), actor_id: auth("id") } }),
  ],
  response: ref("used"),
  responseShape: {} as { asset_id: number },
});

export const playgroundQueries = [playgroundCatalog, playgroundEstimate, playgroundHistory, playgroundUse];
