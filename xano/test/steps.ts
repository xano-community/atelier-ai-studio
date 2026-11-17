// Steps from claim to library item, with a stub in the model's seat: each test claims a step with the real function,
// then records what a wrapper would have answered for a recorded gateway envelope. Nothing here calls a model. The
// wrappers' own mapping of envelopes is covered by their unit tests (function/ai/*), with the statement mocked.
// Charges are worked out by hand from the test prices in fixtures.ts ($1 in, $2 out per 1M tokens, plus 10%).
import { c, cmp, col, fl, obj, ref, s, withFilters } from "@xano/sdk";
import { agent } from "../agent.js";
import { brand } from "../table/studio/brand.js";
import { asset } from "../table/library/asset.js";
import { ai_run } from "../table/studio/ai_run.js";
import { ai_step } from "../table/studio/ai_step.js";
import { ledger } from "../table/studio/ledger.js";
import { user } from "../table/user.js";
import { workspace_setting } from "../base/tables.js";
import { gatewayErrorFn } from "../function/ai/gateway.js";
import { NO_RESERVATION } from "../function/ai/shared.js";
import { textFn } from "../function/ai/text.js";
import { videoFn } from "../function/ai/video.js";
import { composeFn } from "../function/brand/compose.js";
import { claimStepFn, executeStepFn, recordStepFn } from "../function/runs/execute_step.js";
import { retryRunFn, stopRunFn, viewRunFn } from "../function/runs/control.js";
import { startRunFn } from "../function/runs/start.js";
import { sweepFn } from "../function/runs/sweep.js";
import { equal, is, ledgerAgrees, num, person, says, settings, start, testPrices, textStep, videoStep, workflowTest } from "./fixtures.js";
import { sent, stepsOf } from "./spend.js";

const claim = (as: string, step: string, attempt = 1) => s.function.run({ fn: claimStepFn, as, input: { step_id: ref(`${step}.id`), attempt: c.int(attempt) } });
const execute = (as: string, step: string, attempt = 1) => s.function.run({ fn: executeStepFn, as, input: { step_id: ref(`${step}.id`), attempt: c.int(attempt) } });
type Result = { outcome: string; reason?: string; detail?: string; refused?: boolean; output?: Record<string, unknown>; usage?: Record<string, number>; brand_applied?: boolean; sent_prompt?: string };
/** What a wrapper answered, recorded on the step: the model's seat. */
const record = (as: string, step: string, r: Result, attempt = 1) => s.function.run({ fn: recordStepFn, as, input: {
  step_id: ref(`${step}.id`), attempt: c.int(attempt), outcome: c.text(r.outcome), reason: c.text(r.reason ?? ""), detail: c.text(r.detail ?? ""),
  refused: c.bool(r.refused ?? false), output: c.obj((r.output ?? {}) as never), usage: c.obj(r.usage ?? {}), brand_applied: c.bool(r.brand_applied ?? false), sent_prompt: c.text(r.sent_prompt ?? ""),
} });
const reloadStep = (as: string, step: string) => s.db.get({ table: ai_step, fieldValue: ref(`${step}.id`), as });
const reloadRun = (as: string, run: string) => s.db.get({ table: ai_run, fieldValue: ref(`${run}.run.id`), as });
const entryOf = (as: string, step: string, attempt = 1) => s.db.query({ table: ledger, where: [cmp(col("step_id"), "=", ref(`${step}.id`)), cmp(col("attempt"), "=", c.int(attempt))], returnType: "single", as });
const assets = (as: string, n: number) => [s.db.query({ table: asset, returnType: "count", as }), num(as, n)];
const truthy = (path: string) => s.expect.to_be_true({ expr: ref(path) });

// Recorded from the gateway on 2026-11-16 (results-local.json, results-cloud.json).
const ERRORS = {
  notFound: { code: "ERROR_FATAL", message: "Xano AI refused the request (HTTP 404): Publisher model `projects/xano-dev2/locations/global/publishers/anthropic/models/claude-haiku-5-5` was not found or your project does not have access to it.", name: "Exception", result: { status: 404, retryable: false } },
  noPrice: { code: "ERROR_FATAL", message: "Xano AI refused the request (HTTP 400): Model semantic-ranker-default-005 has no price and cannot be served.", name: "Exception", result: { status: 400, retryable: false } },
  videoTimeout: { code: "ERROR_FATAL", message: "The video was not ready within 20 seconds (timeout). The charge for it is not refunded; raise timeout to wait longer.", name: "Exception", result: { code: "timeout" } },
  // Not reproduced live (it needs an empty balance or AI switched off): the words the gateway's own docs give.
  noCredits: { code: "ERROR_FATAL", message: "Xano AI refused the request (HTTP 402): credits_exhausted", name: "Exception", result: { status: 402, retryable: false } },
  disabled: { code: "ERROR_FATAL", message: "Xano AI refused the request (HTTP 403): Xano AI is not available yet on this instance", name: "Exception", result: { status: 403, retryable: false } },
  // Recorded on the local Engine: a transcription handed a list where one file belongs.
  badFile: { code: "ERROR_FATAL", message: "audio is not a valid file resource: Invalid file resource.", name: "Exception" },
};
const classify = (as: string, error: Record<string, unknown>) => s.function.run({ fn: gatewayErrorFn, as, input: { error: c.obj(error as never) } });

const dependentSteps = () => [textStep(), { ...textStep(), depends_on: [1] }, textStep()];

export const stepTests = [
  workflowTest({
    name: "steps: a blocked reply is recorded blocked, charged from what it used, and makes no library item",
    stack: [
      settings(), person("sam"), ...testPrices,
      start("r", "sam", "k1", [textStep()]),
      ...stepsOf("r", 1),
      claim("taken", "step1"),
      is("taken.status", "sent"), truthy("taken.go"),
      // The text wrapper's answer for the recorded blocked envelope: empty text, no finish reason, 11 in and 157 out.
      record("rec", "step1", { outcome: "blocked", reason: "blocked", detail: "The model declined this prompt.", output: { finish_reason: null }, usage: { input_tokens: 11, output_tokens: 157 } }),
      reloadStep("after", "step1"),
      is("after.status", "blocked"), is("after.reason", "blocked"),
      // (11 × $1 + 157 × $2) per 1M = 325 micro-dollars, plus 10% = 357.5, rounded up.
      num("after.charged", 358),
      entryOf("entry", "step1"),
      is("entry.state", "settled"), num("entry.amount", 358), is("entry.reason", "blocked"),
      ...assets("items", 0),
      reloadRun("run", "r"), is("run.status", "failed"),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "steps: a JSON reply that doesn't parse fails in plain words, is still charged, and makes no library item",
    stack: [
      settings(), person("sam"), ...testPrices,
      start("r", "sam", "k1", [textStep()]),
      ...stepsOf("r", 1),
      claim("taken", "step1"),
      record("rec", "step1", { outcome: "failed", reason: "bad_json", detail: "The model's reply wasn't valid JSON. It was still charged.", output: { text: "Here is your product" }, usage: { input_tokens: 97, output_tokens: 40 } }),
      reloadStep("after", "step1"),
      is("after.status", "failed"), is("after.reason", "bad_json"), says("after.detail", "The model's reply wasn't valid JSON"),
      // 97 + 80 = 177, plus 10% = 194.7, rounded up.
      num("after.charged", 195),
      ...assets("items", 0),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "steps: a video that isn't ready in time ends timed out and is charged in full",
    stack: [
      settings(), person("avery", "admin"), ...testPrices,
      start("r", "avery", "k1", [videoStep()]),
      is("r.run.status", "queued"),
      ...stepsOf("r", 1),
      claim("taken", "step1"),
      classify("gw", ERRORS.videoTimeout),
      is("gw.outcome", "timed_out"), is("gw.reason", "timeout"), s.expect.to_be_false({ expr: ref("gw.refused") }),
      s.function.run({ fn: recordStepFn, as: "rec", input: {
        step_id: ref("step1.id"), attempt: c.int(1), outcome: ref("gw.outcome"), reason: ref("gw.reason"), detail: ref("gw.detail"), refused: ref("gw.refused"),
        output: c.obj({}), usage: c.obj({}), brand_applied: c.bool(false), sent_prompt: c.text(""),
      } }),
      reloadStep("after", "step1"),
      is("after.status", "timed_out"), is("after.reason", "timeout"), says("after.detail", "still charges"),
      // 4 seconds at $0.08, plus 10%: the whole reservation, since a timeout reports no usage.
      num("after.charged", 352_000),
      entryOf("entry", "step1"), is("entry.reason", "timeout"), num("entry.amount", 352_000),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "steps: a success that arrives after the sweep timed the step out is kept, charged once, and becomes one library item",
    stack: [
      settings(), person("sam"), ...testPrices,
      start("r", "sam", "k1", [textStep()]),
      ...stepsOf("r", 1),
      claim("taken", "step1"),
      sent("step1", 11),
      s.function.run({ fn: sweepFn, as: "swept" }),
      num("swept.charged", 1),
      reloadStep("timed", "step1"), is("timed.status", "timed_out"),
      record("late", "step1", { outcome: "succeeded", output: { text: "Fresh ideas, every week." }, usage: { input_tokens: 10, output_tokens: 10 } }),
      s.expect.to_be_false({ expr: ref("late.charged_now") }),
      reloadStep("kept", "step1"),
      is("kept.status", "succeeded"), is("kept.output.text", "Fresh ideas, every week."),
      entryOf("entry", "step1"), num("entry.amount", 3_300),
      ...assets("items", 1),
      s.db.query({ table: asset, returnType: "single", as: "item" }),
      is("item.body", "Fresh ideas, every week."), num("item.estimated_cost", 3_300),
      // Recorded again (a repeated request): still one item, still one charge.
      record("again", "step1", { outcome: "succeeded", output: { text: "Fresh ideas, every week." }, usage: { input_tokens: 10, output_tokens: 10 } }),
      ...assets("still_items", 1),
      entryOf("still", "step1"), num("still.amount", 3_300),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "steps: a successful output becomes a draft library item with how it was made",
    stack: [
      settings(), person("sam"), ...testPrices,
      start("r", "sam", "k1", [{ ...textStep(), input: { prompt: "Write a tagline", use_brand: true, temperature: 0.4 } }], { title: "Tagline for Trail 2" }),
      ...stepsOf("r", 1),
      claim("taken", "step1"),
      record("rec", "step1", { outcome: "succeeded", output: { text: "Ride further.", finish_reason: "stop" }, usage: { input_tokens: 1000, output_tokens: 1000 },
        brand_applied: true, sent_prompt: "Write a tagline" }),
      s.db.query({ table: asset, returnType: "single", as: "item" }),
      is("item.kind", "text"), is("item.status", "draft"), is("item.title", "Tagline for Trail 2"),
      is("item.prompt", "Write a tagline"), is("item.model", "test-text"), is("item.body", "Ride further."),
      equal("item.maker_id", ref("sam.id")), equal("item.run_id", ref("r.run.id")), equal("item.step_id", ref("step1.id")),
      // (1,000 × $1 + 1,000 × $2) per 1M, plus 10%.
      num("item.estimated_cost", 3_300),
      truthy("item.brand_applied"),
      num("item.settings.input_tokens", 1000),
      equal("item.settings.request.temperature", c.decimal(0.4)),
      reloadStep("after", "step1"),
      equal("after.asset_id", ref("item.id")), truthy("after.brand_applied"),
    ],
  }),

  workflowTest({
    name: "steps: a wrapper refuses a step that holds no reservation, or wasn't marked sent",
    stack: [
      settings(), person("sam"), ...testPrices,
      // A member's video waits for an admin, so nothing is reserved for it.
      start("waiting", "sam", "k1", [videoStep()]),
      is("waiting.run.status", "waiting_approval"),
      s.expect.to_throw({ exception: c.text(NO_RESERVATION), body: [
        s.db.query({ table: ai_step, where: cmp(col("model"), "=", c.text("test-video")), returnType: "single", as: "unheld" }),
        s.db.patch({ table: ai_step, fieldValue: ref("unheld.id"), data: obj({ status: c.text("working"), sent_at: c.now() }) }),
        s.function.run({ fn: videoFn, as: "nope", input: { step_id: ref("unheld.id") } }),
      ] }),
      // Reserved but not yet sent: still refused.
      start("queued", "sam", "k2", [textStep()]),
      s.expect.to_throw({ exception: c.text(NO_RESERVATION), body: [
        s.db.query({ table: ai_step, where: cmp(col("model"), "=", c.text("test-text")), returnType: "single", as: "unsent" }),
        s.function.run({ fn: textFn, as: "nope", input: { step_id: ref("unsent.id") } }),
      ] }),
    ],
  }),

  workflowTest({
    name: "steps: a revoked key stops its run before anything is sent, and the money comes back",
    stack: [
      settings(), person("sam"), ...testPrices,
      s.db.add({ table: agent.agent_connection, as: "key", row: { user_id: ref("sam.id"), name: c.text("Zapier"), kind: c.text("key"), scope: c.text("read_write"), revoked: c.bool(false),
        expires_at: withFilters(c.now(), fl.add(86_400_000)) } }),
      s.function.run({ fn: startRunFn, as: "r", input: {
        owner_id: ref("sam.id"), kind: c.text("playground"), via: c.text("api"), connection_id: ref("key.id"), idem_key: c.text("k1"), recipe_id: c.int(0),
        title: c.text("Via the API"), private: c.bool(false), base_url: c.text(""), agent_label: c.text("Recipe API"), steps: c.array([textStep(), textStep()] as never),
      } }),
      is("r.run.status", "queued"),
      ...stepsOf("r", 2),
      s.db.patch({ table: agent.agent_connection, fieldValue: ref("key.id"), data: obj({ revoked: c.bool(true) }) }),
      execute("ran", "step1"),
      is("ran.status", "refused"), is("ran.outcome", ""),
      reloadRun("run", "r"),
      is("run.status", "refused"), is("run.reason", "access"), says("run.detail", "revoked"),
      reloadStep("one", "step1"), is("one.status", "released"), s.expect.to_be_null({ expr: ref("one.sent_at") }),
      reloadStep("two", "step2"), is("two.status", "released"),
      entryOf("entry", "step1"), is("entry.state", "released"), num("entry.amount", 0),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "steps: an owner who lost the right to run AI is refused before anything is sent",
    stack: [
      settings(), person("sam"), ...testPrices,
      start("r", "sam", "k1", [textStep()]),
      ...stepsOf("r", 1),
      s.db.patch({ table: user, fieldValue: ref("sam.id"), data: obj({ role: c.text("guest") }) }),
      execute("ran", "step1"),
      is("ran.status", "refused"),
      reloadRun("run", "r"), is("run.status", "refused"), says("run.detail", "role can no longer run this"),
      reloadStep("one", "step1"), is("one.status", "released"), s.expect.to_be_null({ expr: ref("one.sent_at") }),
      entryOf("entry", "step1"), is("entry.state", "released"),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "steps: a step whose earlier step failed is skipped and released, while a step that doesn't need it still runs",
    stack: [
      settings(), person("sam"), ...testPrices,
      start("r", "sam", "k1", dependentSteps()),
      ...stepsOf("r", 3),
      claim("first", "step1"),
      record("failed", "step1", { outcome: "failed", reason: "model_error", detail: "The model didn't finish this one." }),
      // Executed for real: it never reaches a model, because what it needs failed.
      execute("second", "step2"),
      is("second.status", "skipped"),
      reloadStep("two", "step2"), is("two.status", "skipped"), is("two.reason", "dependency"), s.expect.to_be_null({ expr: ref("two.sent_at") }),
      entryOf("two_entry", "step2"), is("two_entry.state", "released"), num("two_entry.amount", 0),
      claim("third", "step3"), is("third.status", "sent"),
      record("ok", "step3", { outcome: "succeeded", output: { text: "Still here." }, usage: { input_tokens: 1000, output_tokens: 1000 } }),
      reloadRun("run", "r"), is("run.status", "partial"),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "steps: stopping a run releases the steps not sent, and the sent one finishes and is charged",
    stack: [
      settings(), person("sam"), ...testPrices,
      start("r", "sam", "k1", [textStep(), textStep()]),
      ...stepsOf("r", 2),
      claim("first", "step1"),
      s.function.run({ fn: stopRunFn, as: "stopped", input: { run_id: ref("r.run.id"), actor_id: ref("sam.id") } }),
      is("stopped.status", "stopped"), says("stopped.detail", "already sent finishes and is charged"),
      reloadStep("two", "step2"), is("two.status", "released"), is("two.reason", "stopped"),
      entryOf("two_entry", "step2"), is("two_entry.state", "released"),
      reloadStep("one", "step1"), is("one.status", "working"),
      // A step taken but stopped can't be taken again.
      claim("again", "step2"), is("again.status", "not_queued"),
      record("finished", "step1", { outcome: "succeeded", output: { text: "Done." }, usage: { input_tokens: 1000, output_tokens: 1000 } }),
      reloadRun("run", "r"), is("run.status", "stopped"), num("run.spent", 3_300),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "steps: retry gives only what failed a new attempt and reservation, once per click",
    stack: [
      settings(), person("sam"), ...testPrices,
      start("r", "sam", "k1", [textStep(), textStep()]),
      ...stepsOf("r", 2),
      claim("first", "step1"),
      record("ok", "step1", { outcome: "succeeded", output: { text: "Kept." }, usage: { input_tokens: 1000, output_tokens: 1000 } }),
      claim("second", "step2"),
      record("bad", "step2", { outcome: "failed", reason: "model_error" }),
      reloadRun("partial", "r"), is("partial.status", "partial"),
      s.function.run({ fn: retryRunFn, as: "retried", input: { run_id: ref("r.run.id"), actor_id: ref("sam.id"), key: c.text("retry-1") } }),
      is("retried.outcome", "created"), is("retried.run.status", "queued"),
      reloadStep("two", "step2"), is("two.status", "queued"), num("two.attempt", 2), num("two.claimed", 0),
      reloadStep("one", "step1"), is("one.status", "succeeded"), num("one.attempt", 1),
      entryOf("fresh", "step2", 2), is("fresh.state", "reserved"), num("fresh.estimate", 3_300),
      s.function.run({ fn: retryRunFn, as: "repeat", input: { run_id: ref("r.run.id"), actor_id: ref("sam.id"), key: c.text("retry-1") } }),
      is("repeat.outcome", "existing"),
      s.db.query({ table: ledger, returnType: "count", as: "rows" }), num("rows", 3),
      claim("retaken", "step2", 2), is("retaken.status", "sent"),
      record("good", "step2", { outcome: "succeeded", output: { text: "Second time." }, usage: { input_tokens: 1000, output_tokens: 1000 } }, 2),
      reloadRun("done", "r"), is("done.status", "done"),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "steps: the brand kit is added when a step asks for it, left out when it doesn't, and the step says which",
    stack: [
      settings(), person("sam"), ...testPrices,
      s.db.add({ table: brand, as: "kit", row: {
        voice: c.text("Plain, warm and short."), avoid_words: c.array(["synergy", "revolutionary"]), visual_rules: c.text("Soft morning light, no studio backdrops."),
        default_voice: c.text("Kore"), voice_style: c.text("Unhurried"), music_style: c.text("Warm acoustic guitar"),
        colours: c.array([{ name: "Sage", hex: "#9caf88" }, { name: "Chalk", hex: "#f4f1ea" }] as never),
      } }),
      s.function.run({ fn: composeFn, as: "on", input: { kind: c.text("text"), asked: c.obj({ prompt: "Write a tagline", use_brand: true }) } }),
      truthy("on.applied"), says("on.system", "Plain, warm and short."), says("on.system", "synergy, revolutionary"), is("on.prompt", "Write a tagline"),
      s.function.run({ fn: composeFn, as: "off", input: { kind: c.text("text"), asked: c.obj({ prompt: "Write a tagline", use_brand: false }) } }),
      s.expect.to_be_false({ expr: ref("off.applied") }), is("off.system", ""),
      s.function.run({ fn: composeFn, as: "picture", input: { kind: c.text("image"), asked: c.obj({ prompt: "A bike at dawn", use_brand: true }) } }),
      says("picture.prompt", "Soft morning light"), says("picture.prompt", "Sage, Chalk"),
      s.function.run({ fn: composeFn, as: "voice", input: { kind: c.text("speech"), asked: c.obj({ text: "Hello", use_brand: true }) } }),
      is("voice.voice", "Kore"), is("voice.instructions", "Unhurried"),
      // Their own voice wins over the kit's.
      s.function.run({ fn: composeFn, as: "own_voice", input: { kind: c.text("speech"), asked: c.obj({ text: "Hello", voice: "Puck", use_brand: true }) } }),
      is("own_voice.voice", "Puck"),
      start("r", "sam", "k1", [textStep()]),
      ...stepsOf("r", 1),
      claim("taken", "step1"),
      record("rec", "step1", { outcome: "succeeded", output: { text: "Ride further." }, usage: { input_tokens: 10, output_tokens: 10 }, brand_applied: true }),
      reloadStep("after", "step1"), truthy("after.brand_applied"),
    ],
  }),

  workflowTest({
    name: "steps: gateway refusals aren't charged and say why, and no credits or AI switched off set the AI status",
    stack: [
      settings(), person("sam"), ...testPrices,
      classify("gone", ERRORS.notFound),
      is("gone.outcome", "failed"), is("gone.reason", "unavailable"), truthy("gone.refused"), says("gone.detail", "Pick another model"),
      classify("unpriced", ERRORS.noPrice),
      is("unpriced.reason", "unavailable"), truthy("unpriced.refused"),
      classify("unread", ERRORS.badFile),
      is("unread.reason", "bad_file"), truthy("unread.refused"),
      classify("broke", ERRORS.noCredits),
      is("broke.reason", "no_credits"), truthy("broke.refused"),
      s.db.query({ table: workspace_setting, returnType: "single", as: "after_credits" }), is("after_credits.ai_status", "no_credits"),
      classify("off", ERRORS.disabled),
      is("off.reason", "disabled"),
      s.db.query({ table: workspace_setting, returnType: "single", as: "after_off" }), is("after_off.ai_status", "disabled"),
      // A refused call on a sent step settles at nothing.
      start("r", "sam", "k1", [textStep()]),
      ...stepsOf("r", 1),
      claim("taken", "step1"),
      s.function.run({ fn: recordStepFn, as: "rec", input: {
        step_id: ref("step1.id"), attempt: c.int(1), outcome: ref("gone.outcome"), reason: ref("gone.reason"), detail: ref("gone.detail"), refused: ref("gone.refused"),
        output: c.obj({}), usage: c.obj({}), brand_applied: c.bool(false), sent_prompt: c.text(""),
      } }),
      reloadStep("after", "step1"), is("after.status", "failed"), is("after.reason", "unavailable"), num("after.charged", 0),
      entryOf("entry", "step1"), is("entry.state", "settled"), num("entry.amount", 0), is("entry.reason", "refused"),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "steps: a private run is read by its owner and admins only, a team run by anyone but a guest",
    stack: [
      settings(), person("sam"), person("priya"), person("avery", "admin"), person("alex", "guest"), ...testPrices,
      s.function.run({ fn: startRunFn, as: "mine", input: {
        owner_id: ref("sam.id"), kind: c.text("playground"), via: c.text("ui"), connection_id: c.int(0), idem_key: c.text("private-1"), recipe_id: c.int(0),
        title: c.text("Private"), private: c.bool(true), base_url: c.text(""), agent_label: c.text("Test"), steps: c.array([textStep()] as never),
      } }),
      s.function.run({ fn: viewRunFn, as: "own", input: { run_id: ref("mine.run.id"), actor_id: ref("sam.id") } }),
      equal("own.run.id", ref("mine.run.id")), num("own.steps.0.seq", 1),
      s.function.run({ fn: viewRunFn, as: "admin", input: { run_id: ref("mine.run.id"), actor_id: ref("avery.id") } }),
      equal("admin.run.id", ref("mine.run.id")),
      s.expect.to_throw({ exception: c.text("No such run."), body: [
        s.db.query({ table: ai_run, where: cmp(col("idem_key"), "=", c.text("private-1")), returnType: "single", as: "run" }),
        s.db.query({ table: user, where: cmp(col("email"), "=", c.text("priya@studio-test.example")), returnType: "single", as: "other" }),
        s.function.run({ fn: viewRunFn, as: "nope", input: { run_id: ref("run.id"), actor_id: ref("other.id") } }),
      ] }),
      start("team", "sam", "team-1", [textStep()]),
      s.function.run({ fn: viewRunFn, as: "teammate", input: { run_id: ref("team.run.id"), actor_id: ref("priya.id") } }),
      equal("teammate.run.id", ref("team.run.id")),
      s.expect.to_throw({ exception: c.text("No such run."), body: [
        s.db.query({ table: ai_run, where: cmp(col("idem_key"), "=", c.text("team-1")), returnType: "single", as: "run" }),
        s.db.query({ table: user, where: cmp(col("email"), "=", c.text("alex@studio-test.example")), returnType: "single", as: "guest" }),
        s.function.run({ fn: viewRunFn, as: "nope", input: { run_id: ref("run.id"), actor_id: ref("guest.id") } }),
      ] }),
    ],
  }),
];
