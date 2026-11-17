// The spend gate, with a stub in the model's seat: each test does what a model call's wrapper would (mark a step sent,
// report usage) by calling the same functions directly, and checks the money by hand-worked numbers. Two requests
// truly at once can't happen in a workflow test (it runs one statement at a time), so frontend/scripts/spend-check.mjs
// proves the races against a deploy.
import { c, cmp, col, fl, obj, ref, s, withFilters } from "@xano/sdk";
import { ai_step } from "../table/studio/ai_step.js";
import { ai_run } from "../table/studio/ai_run.js";
import { budget_month } from "../table/studio/budget_month.js";
import { ledger } from "../table/studio/ledger.js";
import { user } from "../table/user.js";
import { estimateFn } from "../function/spend/estimate.js";
import { releaseFn } from "../function/spend/release.js";
import { settleFn } from "../function/spend/settle.js";
import { reconcileFn } from "../function/spend/reconcile.js";
import { setBudgetsFn } from "../function/spend/budgets.js";
import { stepResultFn } from "../function/runs/finish.js";
import { $, clipStep, count, equal, is, ledgerAgrees, monthRow, num, person, priceRow, says, settings, start, testPrices, textStep, thisMonth, workflowTest, plainTest } from "./fixtures.js";

const estimate = (as: string, kind: string, model: string, options: Record<string, unknown>) =>
  s.function.run({ fn: estimateFn, as, input: { kind: c.text(kind), model: c.text(model), options: c.obj(options as never) } });

/** Bind `steps` to a run's steps in order, and `step1`, `step2`, … to each. */
export const stepsOf = (run: string, n: number) => [
  s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref(`${run}.run.id`)), sort: [{ sortBy: "seq", dir: "asc" }], as: "steps" }),
  ...Array.from({ length: n }, (_, i) => s.set_var(`step${i + 1}`, withFilters(ref("steps"), fl.get(String(i))))),
];
/** What a wrapper commits just before the gateway call. */
export const sent = (step: string, minutesAgo = 0) => s.db.patch({ table: ai_step, fieldValue: ref(`${step}.id`), data: obj({
  status: c.text("working"), claimed_at: withFilters(c.now(), fl.sub(minutesAgo * 60_000)), sent_at: withFilters(c.now(), fl.sub(minutesAgo * 60_000)),
}) });
const settle = (as: string, step: string, outcome: string, usage: Record<string, number> = {}) =>
  s.function.run({ fn: settleFn, as, input: { step_id: ref(`${step}.id`), attempt: c.int(1), outcome: c.text(outcome), usage: c.obj(usage) } });

export const spendTests = [
  plainTest({
    name: "spend: an estimate is the catalog price for what's used, plus the gateway's 10%",
    description: "Text by tokens, an image by size, video by the second, a clip each, a later price once its date has passed, and no price at all.",
    stack: [
      priceRow("gemini-3.8-flash", "text", "input_token", 750_000),
      priceRow("gemini-3.8-flash", "text", "output_token", 3_750_000),
      priceRow("gemini-3.1-flash-image", "image", "image", 67_000, "1K"),
      priceRow("veo-3.1-fast-generate-001", "video", "second", 80_000, "720p/silent"),
      priceRow("lyria-002", "music", "clip", 60_000),
      priceRow("price-went-up", "image", "image", 1 * $, "1K", { amount: 2 * $, from: 1000 }),
      // 1,000 in at $0.75/1M + 2,000 out at $3.75/1M = $0.00825, plus 10% = $0.009075.
      estimate("text", "text", "gemini-3.8-flash", { input_tokens: 1000, output_tokens: 2000 }),
      num("text.amount", 9_075),
      // The gateway charged $0.0739 for this image on 2026-11-16: $0.067 plus 10% is $0.0737.
      estimate("image", "image", "gemini-3.1-flash-image", { size: "1K" }),
      num("image.amount", 73_700),
      // Measured: 4 seconds without sound cost $0.352.
      estimate("video", "video", "veo-3.1-fast-generate-001", { seconds: 4, resolution: "720p", audio: false }),
      num("video.amount", 352_000),
      // Measured: one clip cost $0.066.
      estimate("music", "music", "lyria-002", {}),
      num("music.amount", 66_000),
      estimate("later", "image", "price-went-up", { size: "1K" }),
      num("later.amount", 2_200_000),
      estimate("unpriced", "image", "no-such-model", { size: "1K" }),
      s.expect.to_be_false({ expr: ref("unpriced.priced") }),
      says("unpriced.detail", "No price set for no-such-model: an admin can add one under Usage."),
      // A size the model has no price for isn't guessed.
      estimate("no_size", "image", "gemini-3.1-flash-image", { size: "4K" }),
      s.expect.to_be_false({ expr: ref("no_size.priced") }),
    ],
  }),

  workflowTest({
    name: "spend: a run that doesn't fit the person's budget is refused in words, with nothing held",
    description: "Sam has $0.40 left of $25 and asks for a $1.05 run: refused, the words name both amounts and the month, and no ledger row or counter moves.",
    stack: [
      settings({ line: 5 * $ }),
      person("sam"),
      // $0.954545 a clip, plus 10%, rounded up: $1.05.
      priceRow("pricey-clip", "music", "clip", 954_545),
      thisMonth(),
      s.db.add({ table: budget_month, as: "sams", row: { scope: c.text("person"), subject_id: ref("sam.id"), month: ref("month"),
        budget: c.int(25 * $), reserved: c.int(0), spent: c.int(24_600_000), headroom: c.int(400_000) } }),
      start("r", "sam", "k1", [{ kind: "music", model: "pricey-clip", input: {}, options: {} }]),
      is("r.outcome", "created"),
      is("r.run.status", "refused"),
      is("r.run.reason", "over_budget"),
      num("r.run.estimate", 1_050_000),
      says("r.run.detail", "This run is estimated at $1.05, and you have $0.40 left of your $25.00 budget for "),
      says("r.run.detail", "Ask an admin"),
      ...count("ledger_rows", ledger, 0),
      monthRow("after", "person", ref("sam.id")),
      num("after.reserved", 0), num("after.spent", 24_600_000), num("after.headroom", 400_000),
      // The team's row was taken from and given back in the same transaction.
      monthRow("team", "team", c.int(0)),
      num("team.reserved", 0), num("team.headroom", 100 * $),
      ...stepsOf("r", 1),
      is("step1.status", "skipped"),
      // Sam's $24.60 was spent before this test began, so it has no ledger rows: the invariant check doesn't apply here.
    ],
  }),

  workflowTest({
    name: "spend: a reservation holds the estimate on the team and the person, one ledger row per step",
    description: "This month's rows are opened with the Settings budgets, both take the total, and each step gets its own held ledger row.",
    stack: [
      settings({ team: 10 * $, person: 2 * $ }),
      person("sam"),
      ...testPrices,
      // $0.0033 + $0.066 = $0.0693.
      start("r", "sam", "k1", [textStep(), clipStep()]),
      is("r.run.status", "queued"),
      num("r.run.estimate", 69_300),
      thisMonth(),
      monthRow("team", "team", c.int(0)),
      num("team.budget", 10 * $), num("team.reserved", 69_300), num("team.spent", 0), num("team.headroom", 10 * $ - 69_300),
      monthRow("mine", "person", ref("sam.id")),
      num("mine.budget", 2 * $), num("mine.reserved", 69_300), num("mine.headroom", 2 * $ - 69_300),
      ...count("ledger_rows", ledger, 2),
      ...stepsOf("r", 2),
      s.db.query({ table: ledger, where: cmp(col("step_id"), "=", ref("step1.id")), returnType: "single", as: "first" }),
      is("first.state", "reserved"), num("first.held", 1), num("first.estimate", 3_300), num("first.attempt", 1),
      equal("first.team_month_id", ref("team.id")), equal("first.person_month_id", ref("mine.id")),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "spend: the team's budget refuses before the person's is touched",
    description: "A $1.05 run against a $1 team budget: refused with the team's words, and the person's row is as it was.",
    stack: [
      settings({ team: 1 * $, person: 25 * $, line: 5 * $ }),
      person("sam"),
      priceRow("pricey-clip", "music", "clip", 954_545),
      start("r", "sam", "k1", [{ kind: "music", model: "pricey-clip", input: {}, options: {} }]),
      is("r.run.status", "refused"),
      says("r.run.detail", "The team has $1.00 left of its $1.00 budget for "),
      thisMonth(),
      monthRow("mine", "person", ref("sam.id")),
      num("mine.reserved", 0), num("mine.headroom", 25 * $),
      monthRow("team", "team", c.int(0)),
      num("team.reserved", 0), num("team.headroom", 1 * $),
      ...count("ledger_rows", ledger, 0),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "spend: settling charges what was used, a clip at its price, and releasing gives the rest back",
    description: "Three steps reserved: text settles from its token usage, music (no usage) at its per-clip price, and a never-sent step is released to zero.",
    stack: [
      settings({ team: 10 * $ }),
      person("sam"),
      ...testPrices,
      // Reserved: $0.0033 + $0.066 + $0.0033 = $0.0726.
      start("r", "sam", "k1", [textStep(), clipStep(), textStep()]),
      num("r.run.estimate", 72_600),
      ...stepsOf("r", 3),
      sent("step1"), sent("step2"),
      // 500 in + 250 out: $0.0005 + $0.0005 = $0.001, plus 10% = $0.0011.
      settle("text", "step1", "succeeded", { input_tokens: 500, output_tokens: 250 }),
      s.expect.to_be_true({ expr: ref("text.moved") }),
      num("text.amount", 1_100),
      settle("clip", "step2", "succeeded"),
      num("clip.amount", 66_000),
      s.function.run({ fn: releaseFn, as: "let_go", input: { step_id: ref("step3.id"), attempt: c.int(1), reason: c.text("stopped") } }),
      s.expect.to_be_true({ expr: ref("let_go.moved") }),
      thisMonth(),
      monthRow("team", "team", c.int(0)),
      num("team.reserved", 0), num("team.spent", 67_100), num("team.headroom", 10 * $ - 67_100),
      monthRow("mine", "person", ref("sam.id")),
      num("mine.reserved", 0), num("mine.spent", 67_100),
      s.db.query({ table: ledger, where: cmp(col("step_id"), "=", ref("step3.id")), returnType: "single", as: "released" }),
      is("released.state", "released"), num("released.amount", 0), num("released.held", 0),
      s.db.get({ table: ai_step, fieldValue: ref("step1.id"), as: "charged_step" }),
      num("charged_step.charged", 1_100),
      // A sent step isn't released: it may have been billed.
      s.function.run({ fn: releaseFn, as: "refused_release", input: { step_id: ref("step1.id"), attempt: c.int(1), reason: c.text("stopped") } }),
      s.expect.to_be_true({ expr: ref("refused_release.sent") }),
      s.expect.to_be_false({ expr: ref("refused_release.moved") }),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "spend: a blocked text is charged at its reservation",
    description: "The gateway answers a blocked prompt with empty text and bills it: the step ends blocked and the reservation becomes the charge.",
    stack: [
      settings(),
      person("sam"),
      ...testPrices,
      start("r", "sam", "k1", [textStep()]),
      ...stepsOf("r", 1),
      sent("step1"),
      s.function.run({ fn: stepResultFn, as: "result", input: { step_id: ref("step1.id"), attempt: c.int(1), outcome: c.text("blocked"),
        output: c.obj({ text: "" }), usage: c.obj({}), detail: c.text("The model declined this prompt.") } }),
      s.expect.to_be_true({ expr: ref("result.charged_now") }),
      num("result.amount", 3_300),
      s.db.get({ table: ai_step, fieldValue: ref("step1.id"), as: "after" }),
      is("after.status", "blocked"), is("after.reason", "blocked"), num("after.charged", 3_300),
      s.db.query({ table: ledger, where: cmp(col("step_id"), "=", ref("step1.id")), returnType: "single", as: "entry" }),
      is("entry.state", "settled"), is("entry.reason", "blocked"), num("entry.amount", 3_300),
      s.db.get({ table: ai_run, fieldValue: ref("r.run.id"), as: "run" }),
      is("run.status", "failed"), num("run.spent", 3_300),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "spend: settling twice moves the money once, and keeps the second result on the ledger",
    stack: [
      settings(),
      person("sam"),
      ...testPrices,
      start("r", "sam", "k1", [textStep()]),
      ...stepsOf("r", 1),
      sent("step1"),
      settle("once", "step1", "succeeded", { input_tokens: 1000, output_tokens: 1000 }),
      s.expect.to_be_true({ expr: ref("once.moved") }),
      settle("twice", "step1", "succeeded", { input_tokens: 9000, output_tokens: 9000 }),
      s.expect.to_be_false({ expr: ref("twice.moved") }),
      thisMonth(),
      monthRow("team", "team", c.int(0)),
      num("team.spent", 3_300), num("team.reserved", 0),
      s.db.query({ table: ledger, where: cmp(col("step_id"), "=", ref("step1.id")), returnType: "single", as: "entry" }),
      num("entry.amount", 3_300),
      is("entry.late.outcome", "succeeded"),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "spend: a reservation made last month settles against last month",
    description: "Held on October's rows, settled on November 1st: October's counters move, this month's don't.",
    stack: [
      settings(),
      person("sam"),
      ...testPrices,
      s.db.add({ table: budget_month, as: "old_team", row: { scope: c.text("team"), subject_id: c.int(0), month: c.text("2000-10"), budget: c.int(100 * $), reserved: c.int(3_300), spent: c.int(0), headroom: c.int(100 * $ - 3_300) } }),
      s.db.add({ table: budget_month, as: "old_mine", row: { scope: c.text("person"), subject_id: ref("sam.id"), month: c.text("2000-10"), budget: c.int(25 * $), reserved: c.int(3_300), spent: c.int(0), headroom: c.int(25 * $ - 3_300) } }),
      // A run that reserves now, so this month's rows exist and hold something of their own.
      start("now_run", "sam", "k-now", [textStep()]),
      // The October run: its step and the ledger row it reserved then.
      s.db.add({ table: ai_run, as: "old_run", row: { owner_id: ref("sam.id"), kind: c.text("playground"), via: c.text("ui"), idem_key: c.text("k-october"), title: c.text("October run"), status: c.text("running"), estimate: c.int(3_300) } }),
      s.db.add({ table: ai_step, as: "old_step", row: { run_id: ref("old_run.id"), seq: c.int(1), kind: c.text("text"), model: c.text("test-text"), options: c.obj({ input_tokens: 1000, output_tokens: 1000 }),
        status: c.text("working"), attempt: c.int(1), timeout_s: c.int(120), sent_at: c.now(), estimate: c.int(3_300) } }),
      s.db.add({ table: ledger, as: "old_entry", row: { step_id: ref("old_step.id"), attempt: c.int(1), run_id: ref("old_run.id"), owner_id: ref("sam.id"),
        team_month_id: ref("old_team.id"), person_month_id: ref("old_mine.id"), state: c.text("reserved"), held: c.int(1), estimate: c.int(3_300), amount: c.int(0) } }),
      s.function.run({ fn: settleFn, as: "late", input: { step_id: ref("old_step.id"), attempt: c.int(1), outcome: c.text("succeeded"), usage: c.obj({ input_tokens: 1000, output_tokens: 1000 }) } }),
      s.db.get({ table: budget_month, fieldValue: ref("old_team.id"), as: "october_team" }),
      num("october_team.reserved", 0), num("october_team.spent", 3_300),
      s.db.get({ table: budget_month, fieldValue: ref("old_mine.id"), as: "october_mine" }),
      num("october_mine.reserved", 0), num("october_mine.spent", 3_300),
      thisMonth(),
      monthRow("team", "team", c.int(0)),
      num("team.reserved", 3_300), num("team.spent", 0),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "spend: the counters are rebuilt from the ledger when they drift",
    stack: [
      settings({ team: 10 * $ }),
      person("sam"),
      ...testPrices,
      start("r", "sam", "k1", [textStep(), clipStep()]),
      thisMonth(),
      monthRow("team", "team", c.int(0)),
      s.db.patch({ table: budget_month, fieldValue: ref("team.id"), data: obj({ reserved: c.int(999), spent: c.int(5), headroom: c.int(7) }) }),
      s.function.run({ fn: reconcileFn, as: "fixed", input: { month: c.text("") } }),
      num("fixed.fixed", 1),
      num("fixed.checked", 2),
      s.db.get({ table: budget_month, fieldValue: ref("team.id"), as: "rebuilt" }),
      num("rebuilt.reserved", 69_300), num("rebuilt.spent", 0), num("rebuilt.headroom", 10 * $ - 69_300),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "spend: a budget change moves this month's budget and what's left by the difference",
    description: "From $10 to $12 with $0.0693 held: the budget and what's left both rise $2, what's held stays. Only admins change it.",
    stack: [
      settings({ team: 10 * $, person: 2 * $ }),
      person("avery", "admin"),
      person("sam"),
      ...testPrices,
      start("r", "sam", "k1", [textStep(), clipStep()]),
      s.function.run({ fn: setBudgetsFn, as: "now", input: { actor_id: ref("avery.id"), team_budget: c.int(12 * $), person_budget: c.int(1 * $), approval_line: c.int(-1) } }),
      num("now.team_budget", 12 * $), num("now.person_budget", 1 * $), num("now.approval_line", $ / 2),
      thisMonth(),
      monthRow("team", "team", c.int(0)),
      num("team.budget", 12 * $), num("team.reserved", 69_300), num("team.headroom", 12 * $ - 69_300),
      monthRow("mine", "person", ref("sam.id")),
      num("mine.budget", 1 * $), num("mine.headroom", 1 * $ - 69_300),
      s.expect.to_throw({ exception: c.text("Only admins change budgets"), body: [
        s.db.query({ table: user, where: cmp(col("email"), "=", c.text("sam@studio-test.example")), returnType: "single", as: "sam" }),
        s.function.run({ fn: setBudgetsFn, as: "nope", input: { actor_id: ref("sam.id"), team_budget: c.int(1), person_budget: c.int(-1), approval_line: c.int(-1) } }),
      ] }),
      ...ledgerAgrees(),
    ],
  }),
];
