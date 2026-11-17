// What the studio's workflow tests build their worlds from. A test run starts with an empty database, so each test makes its
// own settings row, people and prices. Prices here are test numbers chosen so the arithmetic is easy to check by hand,
// never read from xano/prices.ts: a test's expected value doesn't come from the code it tests.
import { c, cmp, col, expr, fl, ref, s, withFilters, workflowTest as sdkWorkflowTest, type Value } from "@xano/sdk";
import { workspace_setting } from "../base/tables.js";
import { budget_month } from "../table/studio/budget_month.js";
import { ledger } from "../table/studio/ledger.js";
import { price } from "../table/studio/price.js";
import { user } from "../table/user.js";
import { startRunFn } from "../function/runs/start.js";

// A test reads rows it just made, and a missing row should fail that test: the null-safety warning doesn't apply.
export const workflowTest: typeof sdkWorkflowTest = (def) => sdkWorkflowTest({ ...def, diagnostics: { allow: ["stack.drill-maybe-null"] } });
/** A test that reads only what its functions answer. */
export const plainTest = sdkWorkflowTest;

/** $1 in micro-dollars. */
export const $ = 1_000_000;

export const settings = (o: { team?: number; person?: number; line?: number } = {}) => s.db.add({ table: workspace_setting, as: "settings", row: {
  name: c.text("Test studio"), timezone: c.text("UTC"), week_start: c.text("monday"),
  team_budget: c.int(o.team ?? 100 * $), person_budget: c.int(o.person ?? 25 * $), approval_line: c.int(o.line ?? $ / 2),
  ai_status: c.text("on"), ai_status_reason: c.text(""), plan_paid_storage: c.bool(true), plan_async: c.bool(false),
} });

export const person = (key: string, role = "member") => s.db.add({ table: user, as: key, row: {
  name: c.text(`Test ${key}`), email: c.text(`${key}@studio-test.example`), password: c.text("Studio-test-1"), role: c.text(role),
} });

export const priceRow = (model: string, kind: string, unit: string, amount: number, variant = "", later?: { amount: number; from: number }) =>
  s.db.add({ table: price, as: `price_${model.replace(/[^a-z0-9]/gi, "_")}_${unit}_${variant.replace(/[^a-z0-9]/gi, "_")}`, row: {
    model: c.text(model), kind: c.text(kind), unit: c.text(unit), variant: c.text(variant), amount: c.int(amount),
    later_amount: c.int(later?.amount ?? 0), later_from: c.int(later?.from ?? 0), label: c.text("test price"),
  } });

/** A text model at $1 in and $2 out per 1M tokens, and a $0.06 music clip. */
export const testPrices = [
  priceRow("test-text", "text", "input_token", 1 * $),
  priceRow("test-text", "text", "output_token", 2 * $),
  priceRow("test-clip", "music", "clip", 60_000),
  priceRow("test-video", "video", "second", 80_000, "720p/silent"),
];

/** A text step: (in × $1 + out × $2) per 1M tokens, plus 10%. 1,000 in and 1,000 out is $0.0033. */
export const textStep = (input_tokens = 1000, output_tokens = 1000) => ({ kind: "text", model: "test-text", input: { prompt: "Write a tagline" }, options: { input_tokens, output_tokens } });
/** A $0.06 clip, plus 10%: $0.066. */
export const clipStep = (samples = 1) => ({ kind: "music", model: "test-clip", input: { prompt: "A calm theme" }, options: { samples } });
/** 4 seconds at $0.08 a second, plus 10%: $0.352. */
export const videoStep = () => ({ kind: "video", model: "test-video", input: { prompt: "A slow pan" }, options: { seconds: 4, resolution: "720p", audio: false } });

type Step = Record<string, unknown>;
export const start = (as: string, owner: string, key: string, steps: Step[], o: { via?: string; title?: string; kind?: string } = {}) =>
  s.function.run({ fn: startRunFn, as, input: {
    owner_id: ref(`${owner}.id`), kind: c.text(o.kind ?? "playground"), via: c.text(o.via ?? "ui"), connection_id: c.int(0), idem_key: c.text(key),
    recipe_id: c.int(0), title: c.text(o.title ?? "Test run"), private: c.bool(false), base_url: c.text(""), agent_label: c.text("Test"),
    steps: c.array(steps as never),
  } });

export const thisMonth = (as = "month") => s.set_var(as, withFilters(c.now(), fl.epochms_date("Y-m", "UTC")));
export const monthRow = (as: string, scope: "team" | "person", subject: Value, month: Value = ref("month")) =>
  s.db.query({ table: budget_month, as, returnType: "single", where: [cmp(col("scope"), "=", c.text(scope)), cmp(col("subject_id"), "=", subject), cmp(col("month"), "=", month)] });

export const equal = (path: string, value: Value) => s.expect.to_equal({ expr: ref(path), value });
export const is = (path: string, value: string) => equal(path, c.text(value));
export const num = (path: string, n: number) => equal(path, c.int(n));
export const says = (path: string, words: string) => s.expect.to_contain({ expr: ref(path), value: c.text(words) });
export const count = (as: string, table: typeof ledger | typeof budget_month, n: number) => [
  s.db.query({ table, returnType: "count", as }),
  s.expect.to_equal({ expr: ref(as), value: c.int(n) }),
];

/**
 * The money invariant, computed here from the ledger rather than by the code under test: every month row's reserved
 * equals the sum of its held ledger rows, spent the sum of its settled ones, and headroom is budget − reserved − spent.
 */
export const ledgerAgrees = () => [
  s.db.query({ table: budget_month, as: "check_rows" }),
  s.foreach({ list: ref("check_rows"), as: "check_row", body: [
    s.set_var("check_column", c.text("person_month_id")),
    s.conditional({ when: expr(ref("check_row.scope"), "=", c.text("team")), then: [s.update_var("check_column", c.text("team_month_id"))] }),
    s.db.query({ table: ledger, where: [expr(col("held"), "=", c.int(1))], output: ["team_month_id", "person_month_id", "estimate"], as: "check_held_all" }),
    s.db.query({ table: ledger, where: [cmp(col("state"), "=", c.text("settled"))], output: ["team_month_id", "person_month_id", "amount"], as: "check_settled_all" }),
    s.array.filter({ expr: ref("check_held_all"), if: expr(withFilters(ref("$this"), fl.get(ref("check_column"))), "=", ref("check_row.id")), as: "check_held" }),
    s.array.filter({ expr: ref("check_settled_all"), if: expr(withFilters(ref("$this"), fl.get(ref("check_column"))), "=", ref("check_row.id")), as: "check_settled" }),
    s.array.map({ source: ref("check_held"), as: "check_held_amounts", transform: ref("$this.estimate") }),
    s.array.map({ source: ref("check_settled"), as: "check_settled_amounts", transform: ref("$this.amount") }),
    s.expect.to_equal({ expr: ref("check_row.reserved"), value: withFilters(ref("check_held_amounts"), fl.sum()) }),
    s.expect.to_equal({ expr: ref("check_row.spent"), value: withFilters(ref("check_settled_amounts"), fl.sum()) }),
    s.expect.to_equal({ expr: ref("check_row.headroom"), value: withFilters(ref("check_row.budget"), fl.sub(ref("check_row.reserved")), fl.sub(ref("check_row.spent"))) }),
  ] }),
];
