// Home and Usage, with a stub in the model's seat: steps are marked sent and settled by hand, and every expected amount is
// worked out here from the test prices (text $1 in and $2 out per 1M tokens, a $0.06 clip, each plus 10%).
import { c, cmp, col, fl, ref, s, withFilters, type Statement } from "@xano/sdk";
import { ai_run } from "../table/studio/ai_run.js";
import { asset } from "../table/library/asset.js";
import { ledger } from "../table/studio/ledger.js";
import { user } from "../table/user.js";
import { estimateFn } from "../function/spend/estimate.js";
import { settleFn } from "../function/spend/settle.js";
import { setBudgetsFn, setPersonBudgetFn } from "../function/spend/budgets.js";
import { listPricesFn, raiseForRunFn, setPriceFn, usageFn } from "../function/spend/usage.js";
import { askAdminFn, startRunFn } from "../function/runs/start.js";
import { homeFn } from "../function/studio/home.js";
import { checkAiFn } from "../function/studio/check_ai.js";
import { gateFn } from "../function/runs/execute_step.js";
import { $, clipStep, equal, is, ledgerAgrees, monthRow, num, person, priceRow, settings, start, testPrices, textStep, thisMonth, videoStep, workflowTest, plainTest } from "./fixtures.js";
import { sent, stepsOf } from "./spend.js";

const settle = (as: string, step: string, usage: Record<string, number> = {}) =>
  s.function.run({ fn: settleFn, as, input: { step_id: ref(`${step}.id`), attempt: c.int(1), outcome: c.text("succeeded"), usage: c.obj(usage) } });
const usage = (as: string, who: string) => s.function.run({ fn: usageFn, as, input: { actor_id: ref(`${who}.id`), month: c.text("") } });
const home = (as: string, who: string) => s.function.run({ fn: homeFn, as, input: { actor_id: ref(`${who}.id`) } });
/** Bind `as` to the sum of `field` over the list at `path`. */
const sumOf = (as: string, path: string, field: string) => [
  s.array.map({ source: ref(path), as: `${as}_parts`, transform: ref(`$this.${field}`) }),
  s.set_var(as, withFilters(ref(`${as}_parts`), fl.sum(), fl.to_int())),
];
const size = (as: string, path: string) => s.set_var(as, withFilters(ref(path), fl.safe_array(), fl.count()));
/** The body of an expect.to_throw runs on its own variables, so it finds the person by role itself. */
const findRole = (as: string, role: string) => s.db.query({ table: user, where: cmp(col("role"), "=", c.text(role)), returnType: "single", as });
const refused = (words: string, body: Statement[]) => s.expect.to_throw({ exception: c.text(words), body });

export const usageTests = [
  plainTest({
    name: "usage: totals by person, kind, model and day each add up to the month's settled ledger total",
    description: "Sam runs text and a clip in the app and text with a key; Jordan runs a clip; one of Sam's runs is still held. Usage splits $0.1364 four ways, and the key shows under Sam.",
    stack: [
      settings({ team: 10 * $ }),
      person("jordan", "admin"), person("sam"),
      ...testPrices,
      start("a", "sam", "k1", [textStep(), clipStep()]),
      ...stepsOf("a", 2), sent("step1"), sent("step2"),
      // 1,000 in and 1,000 out: $0.003, plus 10% = $0.0033. The clip: $0.066.
      settle("a1", "step1", { input_tokens: 1000, output_tokens: 1000 }), settle("a2", "step2"),
      s.function.run({ fn: startRunFn, as: "b", input: {
        owner_id: ref("sam.id"), kind: c.text("recipe"), via: c.text("api"), connection_id: c.int(77), idem_key: c.text("k2"), recipe_id: c.int(0),
        title: c.text("With a key"), private: c.bool(false), base_url: c.text(""), agent_label: c.text("Recipe API"), steps: c.array([textStep()] as never),
      } }),
      ...stepsOf("b", 1), sent("step1"),
      // 500 in and 250 out: $0.001, plus 10% = $0.0011.
      settle("b1", "step1", { input_tokens: 500, output_tokens: 250 }),
      start("c", "jordan", "k3", [clipStep()]),
      ...stepsOf("c", 1), sent("step1"), settle("c1", "step1"),
      // Reserved, not yet settled: held, not spent.
      start("d", "sam", "k4", [textStep()]),

      usage("u", "jordan"),
      // $0.0033 + $0.066 + $0.0011 + $0.066.
      num("u.total", 136_400),
      num("u.held", 3_300),
      thisMonth(),
      equal("u.month", ref("month")),
      // The same total, read straight from the ledger.
      s.db.query({ table: ledger, where: cmp(col("state"), "=", c.text("settled")), output: ["amount"], paging: { per_page: 100, metadata: false }, as: "settled_rows" }),
      ...sumOf("ledger_total", "settled_rows", "amount"),
      equal("u.total", ref("ledger_total")),
      ...sumOf("person_total", "u.by_person", "amount"), equal("person_total", ref("ledger_total")),
      ...sumOf("kind_total", "u.by_kind", "amount"), equal("kind_total", ref("ledger_total")),
      ...sumOf("model_total", "u.by_model", "amount"), equal("model_total", ref("ledger_total")),
      ...sumOf("day_total", "u.by_day", "amount"), equal("day_total", ref("ledger_total")),
      ...sumOf("calls", "u.by_kind", "calls"), num("calls", 4),
      // Sam's key is a line of its own under Sam, with no budget of its own.
      s.array.find({ expr: ref("u.by_person"), as: "keyed", if: [cmp(ref("$this.owner_id"), "=", ref("sam.id")), cmp(ref("$this.via"), "=", c.text("api"))] }),
      num("keyed.amount", 1_100), num("keyed.connection_id", 77), num("keyed.calls", 1),
      s.array.find({ expr: ref("u.by_person"), as: "sam_app", if: [cmp(ref("$this.owner_id"), "=", ref("sam.id")), cmp(ref("$this.via"), "=", c.text("ui"))] }),
      num("sam_app.amount", 69_300),
      s.array.find({ expr: ref("u.by_kind"), as: "music", if: cmp(ref("$this.kind"), "=", c.text("music")) }),
      num("music.amount", 132_000), num("music.calls", 2),
      s.array.find({ expr: ref("u.by_model"), as: "texts", if: cmp(ref("$this.model"), "=", c.text("test-text")) }),
      num("texts.amount", 4_400),
      size("rows", "u.rows"), num("rows", 2),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "usage: a member can't read usage or prices; an admin's price change is the next estimate's",
    stack: [
      settings(), person("jordan", "admin"), person("sam"),
      ...testPrices,
      refused("Only admins see the team's usage", [findRole("member", "member"), s.function.run({ fn: usageFn, as: "peek", input: { actor_id: ref("member.id"), month: c.text("") } })]),
      refused("Only admins see and change prices", [findRole("member", "member"), s.function.run({ fn: listPricesFn, as: "prices", input: { actor_id: ref("member.id") } })]),
      refused("Only admins check whether AI is back", [findRole("member", "member"), s.function.run({ fn: checkAiFn, as: "check", input: { actor_id: ref("member.id"), idem_key: c.text("c1") } })]),
      // An admin's check of AI may spend; a member can't start one at all.
      start("check", "jordan", "c0", [textStep()], { kind: "check" }),
      s.function.run({ fn: gateFn, as: "gate", input: { run_id: ref("check.run.id") } }),
      s.expect.to_be_true({ expr: ref("gate.ok") }),
      refused("Only admins check whether AI is back", [findRole("member", "member"), s.function.run({ fn: startRunFn, as: "member_check", input: {
        owner_id: ref("member.id"), kind: c.text("check"), via: c.text("ui"), connection_id: c.int(0), idem_key: c.text("c2"), recipe_id: c.int(0),
        title: c.text("Check"), private: c.bool(true), base_url: c.text(""), agent_label: c.text("Test"), steps: c.array([textStep()] as never),
      } })]),
      refused("A month is written like 2026-11", [findRole("admin", "admin"), s.function.run({ fn: usageFn, as: "bad", input: { actor_id: ref("admin.id"), month: c.text("November") } })]),
      s.function.run({ fn: listPricesFn, as: "prices", input: { actor_id: ref("jordan.id") } }),
      s.array.find({ expr: ref("prices"), as: "clip", if: cmp(ref("$this.model"), "=", c.text("test-clip")) }),
      num("clip.amount", 60_000),
      refused("A price is more than $0", [findRole("admin", "admin"),
        s.function.run({ fn: setPriceFn, as: "free", input: { actor_id: ref("admin.id"), price_id: c.int(1), amount: c.int(0) } })]),
      s.function.run({ fn: setPriceFn, as: "dearer", input: { actor_id: ref("jordan.id"), price_id: ref("clip.id"), amount: c.int(100_000) } }),
      num("dearer.amount", 100_000),
      // $0.10 a clip, plus 10%.
      s.function.run({ fn: estimateFn, as: "next", input: { kind: c.text("music"), model: c.text("test-clip"), options: c.obj({}) } }),
      num("next.amount", 110_000),
    ],
  }),

  workflowTest({
    name: "usage: lowering a person's budget below their spend refuses their next run, and an admin can raise it for that run",
    description: "Sam has spent $0.066. Jordan cuts Sam to $0.05: Sam's next run is over budget at once. Sam asks an admin; Jordan raises Sam to $1, and the run reserves against $1.",
    stack: [
      settings(), person("jordan", "admin"), person("sam"),
      ...testPrices,
      start("a", "sam", "k1", [clipStep()]),
      ...stepsOf("a", 1), sent("step1"), settle("a1", "step1"),
      s.function.run({ fn: setPersonBudgetFn, as: "cut", input: { actor_id: ref("jordan.id"), person_id: ref("sam.id"), budget: c.int(50_000) } }),
      num("cut.budget", 50_000),
      start("b", "sam", "k2", [textStep()]),
      is("b.run.status", "refused"), is("b.run.reason", "over_budget"),
      s.function.run({ fn: askAdminFn, as: "asked", input: { run_id: ref("b.run.id"), actor_id: ref("sam.id") } }),
      is("asked.status", "waiting_approval"),
      refused("Only admins change budgets", [findRole("member", "member"), s.db.query({ table: ai_run, where: cmp(col("status"), "=", c.text("waiting_approval")), returnType: "single", as: "waiting" }),
        s.function.run({ fn: raiseForRunFn, as: "self", input: { actor_id: ref("member.id"), run_id: ref("waiting.id"), budget: c.int(5 * $) } })]),
      s.function.run({ fn: raiseForRunFn, as: "raised", input: { actor_id: ref("jordan.id"), run_id: ref("b.run.id"), budget: c.int(1 * $) } }),
      is("raised.run.status", "queued"),
      thisMonth(),
      monthRow("sams", "person", ref("sam.id")),
      num("sams.budget", 1 * $), num("sams.spent", 66_000), num("sams.reserved", 3_300), num("sams.headroom", 1 * $ - 66_000 - 3_300),
      ...ledgerAgrees(),
    ],
  }),

  plainTest({
    name: "usage: raising the approval line from $0.50 to $2.00 lets a $1.05 recipe run without approval",
    stack: [
      settings(), person("jordan", "admin"), person("sam"),
      // $0.954545 a clip, plus 10%, rounded up: $1.05.
      priceRow("pricey-clip", "music", "clip", 954_545),
      start("a", "sam", "k1", [{ kind: "music", model: "pricey-clip", input: { prompt: "A theme" }, options: {} }], { kind: "recipe" }),
      num("a.run.estimate", 1_050_000),
      is("a.run.status", "waiting_approval"), is("a.run.reason", "costly"),
      s.function.run({ fn: setBudgetsFn, as: "line", input: { actor_id: ref("jordan.id"), team_budget: c.int(-1), person_budget: c.int(-1), approval_line: c.int(2 * $) } }),
      num("line.approval_line", 2 * $),
      start("b", "sam", "k2", [{ kind: "music", model: "pricey-clip", input: { prompt: "A theme" }, options: {} }], { kind: "recipe" }),
      is("b.run.status", "queued"),
      ...ledgerAgrees(),
    ],
  }),

  plainTest({
    name: "home: an admin sees the team's spend and every approval, a member their own, and a guest neither",
    description: "Sam has a run queued and a video waiting; Alex is a guest.",
    stack: [
      settings(), person("jordan", "admin"), person("sam"), person("alex", "guest"),
      ...testPrices,
      start("a", "sam", "k1", [textStep(), clipStep()]),
      is("a.run.status", "queued"),
      start("v", "sam", "k2", [videoStep()]),
      is("v.run.status", "waiting_approval"),

      home("admin", "jordan"),
      s.expect.to_be_true({ expr: ref("admin.sees_team") }),
      num("admin.team.budget", 100 * $), num("admin.team.reserved", 69_300),
      num("admin.mine.spent", 0), num("admin.mine.budget", 25 * $),
      num("admin.runs_week", 2),
      size("admin_running", "admin.running"), num("admin_running", 1),
      equal("admin.running.0.id", ref("a.run.id")),
      size("admin_waiting", "admin.waiting"), num("admin_waiting", 1),
      equal("admin.waiting.0.id", ref("v.run.id")),
      size("admin_steps", "admin.steps"), num("admin_steps", 2),

      home("member", "sam"),
      s.expect.to_be_false({ expr: ref("member.sees_team") }),
      equal("member.team", c.null()),
      num("member.mine.reserved", 69_300),
      size("member_waiting", "member.waiting"), num("member_waiting", 1),

      home("guest", "alex"),
      s.expect.to_be_false({ expr: ref("guest.can_run") }),
      equal("guest.team", c.null()),
      size("guest_running", "guest.running"), num("guest_running", 0),
      size("guest_waiting", "guest.waiting"), num("guest_waiting", 0),
      num("guest.runs_week", 0),
    ],
  }),

  plainTest({
    name: "home: 'Waiting on you' lists the three oldest shared drafts, oldest first, to those who may approve them",
    description: "Five drafts made over a week, one approved item older than all of them and one private draft; Alex is a guest.",
    stack: [
      settings(), person("jordan", "admin"), person("sam"), person("alex", "guest"),
      ...testPrices,
      start("a", "sam", "k1", [textStep()]),
      ...stepsOf("a", 1),
      ...([["Five days old", 5], ["Three days old", 3], ["Two days old", 2], ["A day old", 1], ["Today's", 0]] as const).map(([title, days], i) =>
        s.db.add({ table: asset, as: `draft${i}`, row: { kind: "text", title, model: "test-text", maker_id: ref("sam.id"), run_id: ref("a.run.id"), step_id: ref("step1.id"),
          private: false, status: "draft", created_at: withFilters(c.now(), fl.sub(days * 86_400_000 + 60_000)) } })),
      // Older than every draft, but not waiting: one approved, one kept private by its maker.
      s.db.add({ table: asset, as: "approved", row: { kind: "text", title: "Approved last week", model: "test-text", maker_id: ref("sam.id"), run_id: ref("a.run.id"),
        step_id: ref("step1.id"), private: false, status: "approved", created_at: withFilters(c.now(), fl.sub(9 * 86_400_000)) } }),
      s.db.add({ table: asset, as: "hidden", row: { kind: "text", title: "Private try", model: "test-text", maker_id: ref("sam.id"), run_id: ref("a.run.id"),
        step_id: ref("step1.id"), private: true, status: "draft", created_at: withFilters(c.now(), fl.sub(8 * 86_400_000)) } }),

      home("admin", "jordan"),
      size("admin_drafts", "admin.oldest_drafts"), num("admin_drafts", 3),
      is("admin.oldest_drafts.0.title", "Five days old"), is("admin.oldest_drafts.1.title", "Three days old"), is("admin.oldest_drafts.2.title", "Two days old"),
      equal("admin.oldest_drafts.0.id", ref("draft0.id")), equal("admin.oldest_drafts.0.maker_id", ref("sam.id")),
      is("admin.oldest_drafts.0.maker_name", "Test sam"), is("admin.oldest_drafts.0.agent", ""),
      // A member may approve drafts too.
      home("member", "sam"),
      size("member_drafts", "member.oldest_drafts"), num("member_drafts", 3),
      home("guest", "alex"),
      size("guest_drafts", "guest.oldest_drafts"), num("guest_drafts", 0),
    ],
  }),

  plainTest({
    name: "home: the last seven days of spend are the team's settled charges for an admin and a member's own for them",
    description: "Sam's text and clip settle at $0.0693 and Jordan's clip at $0.066, all today; Sam's held run counts for nothing until it settles.",
    stack: [
      settings(), person("jordan", "admin"), person("sam"),
      ...testPrices,
      start("a", "sam", "k1", [textStep(), clipStep()]),
      ...stepsOf("a", 2), sent("step1"), sent("step2"),
      // 1,000 in and 1,000 out: $0.003, plus 10% = $0.0033. The clip: $0.066.
      settle("a1", "step1", { input_tokens: 1000, output_tokens: 1000 }), settle("a2", "step2"),
      start("c", "jordan", "k2", [clipStep()]),
      ...stepsOf("c", 1), sent("step1"), settle("c1", "step1"),
      start("d", "sam", "k3", [textStep()]),
      // Today, counted the way Usage counts days: whole UTC days since 1970.
      s.set_var("today", withFilters(c.now(), fl.div(86_400_000), fl.floor())),

      home("admin", "jordan"),
      size("admin_days", "admin.spend_days"), num("admin_days", 1),
      equal("admin.spend_days.0.day", ref("today")),
      num("admin.spend_days.0.amount", 135_300),

      home("member", "sam"),
      size("member_days", "member.spend_days"), num("member_days", 1),
      num("member.spend_days.0.amount", 69_300),
    ],
  }),
];
