// Usage: what a month cost, read from the ledger, which is the record of every charge. Every total here is a sum of settled
// ledger rows that counted against that month's team row, so by person, by kind, by model and by day each add up to the
// same month total. These are estimates from the price table: Xano's credit balance is the final word.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, qf, ref, s, withFilters } from "@xano/sdk";
import { agent } from "../../agent.js";
import { approvals } from "../../approvals.js";
import { changed } from "../../base/index.js";
import { rbac } from "../../rbac.js";
import { budget_month } from "../../table/studio/budget_month.js";
import { ledger } from "../../table/studio/ledger.js";
import { ai_run } from "../../table/studio/ai_run.js";
import { price } from "../../table/studio/price.js";
import { easel_turn } from "../../table/studio/easel_turn.js";
import { user } from "../../table/user.js";
import { readRun } from "../runs/reserve.js";
import { settingsRow } from "./begin.js";
import { setPersonBudgetFn } from "./budgets.js";

/** A price per unit: above nothing (the gateway never charges zero, so neither does an estimate) and below a typo. */
const MOST_PRICE = 1_000 * 1_000_000;

export type UsageGroup = { amount: number; calls: number };
export type UsageView = {
  month: string; this_month: string;
  team: { budget: number; reserved: number; spent: number } | null;
  total: number; held: number;
  by_person: (UsageGroup & { owner_id: number; via: string; connection_id: number })[];
  by_kind: (UsageGroup & { kind: string })[];
  by_model: (UsageGroup & { model: string; kind: string })[];
  by_day: (UsageGroup & { day: number })[];
  rows: { subject_id: number; budget: number; reserved: number; spent: number }[];
  people: { id: number; name: string; role: string }[];
  keys: { id: number; name: string }[];
  team_budget: number; person_budget: number; approval_line: number;
  /** Easel's own model turns: billed by the deployer's provider (Anthropic or Google), never by Xano or against a budget. */
  easel: EaselUsage[];
};
export type EaselUsage = { user_id: number; provider: string; model: string; turns: number; input_tokens: number; output_tokens: number };

/** One aggregate of the month's settled ledger rows, grouped by `group`: each group's charged total and how many calls. */
const settled = (as: string, group: { name: string; as: string; filters?: ReturnType<typeof qf.epochms_day>[] }[]) =>
  s.db.query({ table: ledger, as, returnType: "aggregate",
    where: [cmp(col("team_month_id"), "=", ref("team_id")), cmp(col("state"), "=", c.text("settled"))],
    aggregate: { group, eval: [{ name: "amount", as: "amount", filters: [qf.sum()] }, { name: "id", as: "calls", filters: [qf.count()] }] } });

export const usageFn = defineFunction({
  name: "spend/usage",
  description: "A month's estimated spend from the ledger: by person (and the key or route each came through), by kind, by model and by day, with each person's budget.",
  input: { actor_id: input.int({ required: true }), month: input.text({ description: "\"2026-11\". Empty: this month." }) },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("actor.role"), "usage.read", "Only admins see the team's usage."),
    s.set_var("this_month", withFilters(c.now(), fl.epochms_date("Y-m", "UTC"))),
    s.set_var("month", withFilters(inp("month"), fl.first_notempty(ref("this_month")), fl.to_text(), fl.trim())),
    guard.require(expr(withFilters(c.regex(/^\d{4}-(0[1-9]|1[0-2])$/), fl.regex_test(ref("month"))), "=", c.bool(true)),
      { errorType: "badrequest", message: "A month is written like 2026-11." }),
    settingsRow("settings"),
    guard.found("settings", { message: "The workspace has no settings row." }),
    s.db.query({ table: budget_month, returnType: "single", as: "team",
      where: [cmp(col("scope"), "=", c.text("team")), cmp(col("subject_id"), "=", c.int(0)), cmp(col("month"), "=", ref("month"))] }),
    // A month nobody ran anything in has no team row, and no ledger rows point at -1.
    s.set_var("team_id", withFilters(ref("team.id", { safe: true }), fl.first_notnull(c.int(-1)))),
    settled("by_person", [{ name: "owner_id", as: "owner_id" }, { name: "via", as: "via" }, { name: "connection_id", as: "connection_id" }]),
    settled("by_kind", [{ name: "kind", as: "kind" }]),
    settled("by_model", [{ name: "model", as: "model" }, { name: "kind", as: "kind" }]),
    settled("by_day", [{ name: "created_at", as: "day", filters: [qf.epochms_day("UTC")] }]),
    s.array.map({ source: ref("by_kind"), as: "kind_amounts", transform: ref("$this.amount") }),
    s.db.query({ table: ledger, as: "held_rows", returnType: "aggregate",
      where: [cmp(col("team_month_id"), "=", ref("team_id")), expr(col("held"), "=", c.int(1))],
      aggregate: { group: [{ name: "team_month_id", as: "team_month_id" }], eval: [{ name: "estimate", as: "held", filters: [qf.sum()] }] } }),
    s.db.query({ table: budget_month, where: [cmp(col("scope"), "=", c.text("person")), cmp(col("month"), "=", ref("month"))],
      output: ["subject_id", "budget", "reserved", "spent"], paging: { per_page: 1000, metadata: false }, as: "rows" }),
    s.db.query({ table: user, output: ["id", "name", "role"], sort: [{ sortBy: "name", dir: "asc" }], paging: { per_page: 1000, metadata: false }, as: "people" }),
    s.array.map({ source: ref("by_person"), as: "key_ids", transform: ref("$this.connection_id") }),
    s.set_var("key_list", withFilters(ref("key_ids"), fl.unique(), fl.array_push(c.int(-1)))),
    s.db.query({ table: agent.agent_connection, where: cmp(col("id"), "in", ref("key_list")),
      output: ["id", "name"], paging: { per_page: 1000, metadata: false }, as: "keys" }),
    // Easel's turns in the month, by who asked and the model it ran on: tokens only, since the provider bills them.
    s.set_var("month_starts", withFilters(ref("month"), fl.concat(c.text("-01 00:00:00")), fl.to_epochms("UTC"))),
    s.set_var("month_ends", withFilters(ref("month_starts"), fl.epochms_transform("+1 month", "UTC"))),
    s.db.query({ table: easel_turn, as: "easel", returnType: "aggregate",
      where: [expr(col("created_at"), ">=", ref("month_starts")), expr(col("created_at"), "<", ref("month_ends")), cmp(col("status"), "!=", c.text("no_key"))],
      aggregate: {
        group: [{ name: "user_id", as: "user_id" }, { name: "provider", as: "provider" }, { name: "model", as: "model" }],
        eval: [{ name: "id", as: "turns", filters: [qf.count()] }, { name: "input_tokens", as: "input_tokens", filters: [qf.sum()] }, { name: "output_tokens", as: "output_tokens", filters: [qf.sum()] }],
      } }),
  ],
  response: {
    month: ref("month"), this_month: ref("this_month"),
    team: ref("team"),
    total: withFilters(ref("kind_amounts"), fl.sum(), fl.to_int()),
    held: withFilters(ref("held_rows"), fl.first(), fl.get("held", 0), fl.first_notnull(c.int(0)), fl.to_int()),
    by_person: ref("by_person"), by_kind: ref("by_kind"), by_model: ref("by_model"), by_day: ref("by_day"),
    rows: ref("rows"), people: ref("people"), keys: ref("keys"),
    team_budget: ref("settings.team_budget"), person_budget: ref("settings.person_budget"), approval_line: ref("settings.approval_line"),
    easel: ref("easel"),
  },
  responseShape: {} as UsageView,
});

export type PriceRow = { id: number; model: string; kind: string; unit: string; variant: string; amount: number; later_amount: number; later_from: number; label: string };
const PRICE_FIELDS = ["id", "model", "kind", "unit", "variant", "amount", "later_amount", "later_from", "label"] as const;

export const listPricesFn = defineFunction({
  name: "spend/list_prices",
  description: "Every price row, by kind and model, for the admins' price sheet.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("actor.role"), "budgets.manage", "Only admins see and change prices."),
    s.db.query({ table: price, sort: [{ sortBy: "kind", dir: "asc" }, { sortBy: "model", dir: "asc" }, { sortBy: "unit", dir: "asc" }, { sortBy: "variant", dir: "asc" }],
      output: [...PRICE_FIELDS], paging: { per_page: 1000, metadata: false }, as: "rows" }),
  ],
  response: ref("rows"),
  responseShape: [] as PriceRow[],
});

/** Change one price. The next estimate uses it; runs already reserved keep what they held. */
export const setPriceFn = defineFunction({
  name: "spend/set_price",
  description: "Change one price row's amount (micro-dollars per unit; tokens per 1M). Estimates from now on use it.",
  input: { actor_id: input.int({ required: true }), price_id: input.int({ required: true }), amount: input.int({ required: true }) },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("actor.role"), "budgets.manage", "Only admins see and change prices."),
    guard.require([expr(inp("amount"), ">=", c.int(1)), expr(inp("amount"), "<=", c.int(MOST_PRICE))],
      { errorType: "badrequest", message: "A price is more than $0 and at most $1,000 a unit. Xano never charges nothing, so neither does an estimate." }),
    s.db.get({ table: price, fieldValue: inp("price_id"), output: ["id", "model"], as: "row" }),
    guard.found("row", { message: "No such price. Reload the sheet." }),
    s.db.patch({ table: price, fieldValue: inp("price_id"), data: obj({ amount: inp("amount") }) }),
    changed({ entity: "price", id: inp("price_id"), op: "updated", verb: "updated", actor: inp("actor_id"),
      title: withFilters(c.text("changed the price of "), fl.concat(ref("row.model"))), link: c.text("/usage") }),
    s.db.get({ table: price, fieldValue: inp("price_id"), output: [...PRICE_FIELDS], as: "saved" }),
  ],
  response: ref("saved"),
  responseShape: {} as PriceRow,
});

/**
 * An admin answers "Ask an admin" by raising the person's budget for this month instead of letting the run past once: the
 * budget moves first, then the request is approved, so the run reserves against the raised budget.
 */
export const raiseForRunFn = defineFunction({
  name: "spend/raise_for_run",
  description: "Raise a run's owner's budget for this month, then approve the run they asked an admin about.",
  input: { actor_id: input.int({ required: true }), run_id: input.int({ required: true }), budget: input.int({ required: true }) },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("actor.role"), "budgets.manage", "Only admins change budgets."),
    s.db.get({ table: ai_run, fieldValue: inp("run_id"), output: ["id", "owner_id", "status", "reason", "approval_id"], as: "run" }),
    guard.found("run", { message: "That run no longer exists." }),
    guard.require([expr(ref("run.status"), "=", c.text("waiting_approval")), expr(ref("run.reason"), "=", c.text("over_budget"))],
      { errorType: "badrequest", message: "That run isn't waiting for a budget decision any more." }),
    s.function.run({ fn: setPersonBudgetFn, as: "raised", input: { actor_id: inp("actor_id"), person_id: ref("run.owner_id"), budget: inp("budget") } }),
    changed({ entity: "budget", id: ref("raised.id"), op: "updated", verb: "updated", actor: inp("actor_id"),
      title: c.text("raised a person's AI budget for this month"), link: c.text("/usage"), privateTo: ref("run.owner_id") }),
    s.function.run({ fn: approvals.decide, as: "decided", input: { actor_id: inp("actor_id"), id: ref("run.approval_id"), decision: c.text("approve"), edited: c.text("") } }),
    readRun(inp("run_id")),
    guard.found("result", { message: "That run no longer exists." }),
  ],
  response: { run: ref("result"), budget: ref("raised") },
  responseShape: {} as { run: Record<string, unknown>; budget: { budget: number; reserved: number; spent: number } },
});
