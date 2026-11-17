// The shared tool functions, driven as each wrapper drives them: an MCP tool acts for its connection's person with via
// "mcp" and no turn, Easel's tool for the person chatting with via "easel" and its turn. Nothing here reaches a model: every
// run either waits for a person or is refused by the budget before a call. Costs are worked out by hand from the test
// prices below, plus the gateway's 10%.
import { c, cmp, col, fl, obj, ref, s, withFilters, type Value } from "@xano/sdk";
import { agent } from "../agent.js";
import { approvals } from "../approvals.js";
import { ai_run } from "../table/studio/ai_run.js";
import { ai_step } from "../table/studio/ai_step.js";
import { ledger } from "../table/studio/ledger.js";
import { easel_turn } from "../table/studio/easel_turn.js";
import { deriveKeyFn } from "../function/runs/start.js";
import { saveRecipeFn } from "../function/recipes/recipes.js";
import { askViewFn } from "../function/knowledge/ask.js";
import { agentGateFn } from "../function/studio/tooling.js";
import { generateToolFn } from "../function/studio/generate.js";
import { runRecipeToolFn } from "../function/studio/run_recipe.js";
import { askKnowledgeToolFn } from "../function/studio/ask_knowledge.js";
import { closeTurnFn, easelSetupFn, openTurnFn, turnUsageFn } from "../function/studio/easel.js";
import { approveCostlyRun } from "../function/runs/approve.js";
import { claimStepFn, recordStepFn } from "../function/runs/execute_step.js";
import { approveAssetFn } from "../function/library/library.js";
import { LIBRARY_FILE_WORDS } from "../function/recipes/plan.js";
import { asset } from "../table/library/asset.js";
import { stepsOf } from "./spend.js";
import { $, count, equal, is, num, person, plainTest, priceRow, says, settings, start, workflowTest } from "./fixtures.js";
import { user } from "../table/user.js";

const VIDEO = "veo-3.1-fast-generate-001";
/** 80¢ a second of silent 720p video: a 4 s clip is $0.32, $0.352 with the gateway's 10%. */
const prices = [
  priceRow(VIDEO, "video", "second", 80_000, "720p/silent"),
  priceRow("gemini-3.8-flash", "text", "input_token", 1 * $),
  priceRow("gemini-3.8-flash", "text", "output_token", 2 * $),
  priceRow("gemini-embedding-2", "embedding", "input_token", 1 * $, "text"),
  priceRow("test-image", "image", "image", 40_000, "1K"),
];
const clip = { seconds: 4, resolution: "720p", audio: false };

type Via = { via: "mcp" | "easel"; request?: string; turn?: string };
const who = (actor: string, o: Via) => ({
  actor_id: ref(`${actor}.id`), via: c.text(o.via), connection_id: c.int(0), agent_label: c.text(o.via === "easel" ? "Easel" : "Test agent"),
  turn: c.text(o.turn ?? ""), request_id: c.text(o.request ?? ""),
});
const generate = (as: string, actor: string, o: Via, kind = "video", prompt = "A slow pan across a bike on a stone wall", options: Record<string, unknown> = clip, model = VIDEO, from: Value = c.int(0)) =>
  s.function.run({ fn: generateToolFn, as, input: {
    ...who(actor, o), kind: c.text(kind), model: c.text(model), prompt: c.text(prompt), options: c.obj(options as never), voice: c.text(""),
    from_asset: from, use_brand: c.bool(false), title: c.text(""),
  } });
const ask = (as: string, actor: string, o: Via, question: string) =>
  s.function.run({ fn: askKnowledgeToolFn, as, input: { ...who(actor, o), question: c.text(question) } });
const runs = (as: string, n: number) => count(as, ai_run as never, n);

export const toolTests = [
  workflowTest({
    name: "tools: generate starts a video from a Library picture, and a picture that can't be read back fails the step before anything is sent",
    stack: [
      settings(), person("sam"), person("jordan", "admin"), ...prices,
      // An approved picture in the Library, made the way every output is: a step's result, kept privately.
      start("pic", "sam", "pic-1", [{ kind: "image", model: "test-image", input: { prompt: "The City 3 on a commute" }, options: { size: "1K", samples: 1 } }], { title: "City 3 commute" }),
      ...stepsOf("pic", 1),
      s.function.run({ fn: claimStepFn, as: "pic_claim", input: { step_id: ref("step1.id"), attempt: c.int(1) } }),
      s.function.run({ fn: recordStepFn, as: "pic_rec", input: {
        step_id: ref("step1.id"), attempt: c.int(1), outcome: c.text("succeeded"), reason: c.text(""), detail: c.text(""), refused: c.bool(false),
        output: c.obj({ file: { access: "private", path: "/vault/test/missing-city-3.png", name: "missing-city-3.png", type: "image", size: 1000, mime: "image/png" } } as never),
        usage: c.obj({}), brand_applied: c.bool(false), sent_prompt: c.text(""),
      } }),
      s.db.query({ table: asset, where: cmp(col("step_id"), "=", ref("step1.id")), returnType: "single", as: "photo" }),
      s.function.run({ fn: approveAssetFn, as: "approved", input: { asset_id: ref("photo.id"), actor_id: ref("jordan.id") } }),
      generate("clip", "sam", { via: "easel", turn: "easel:3" }, "video", "A slow push in on the bike", clip, VIDEO, ref("photo.id")),
      is("clip.status", "waiting_approval"),
      says("clip.title", "from City 3 commute"),
      s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref("clip.run_id")), returnType: "single", as: "video_step" }),
      equal("video_step.input.from_asset", ref("photo.id")),
      equal("video_step.input.library_picture", ref("photo.id")),
      // An admin approves it; the picture is read just before the call, and here its file isn't there.
      // (The approvals module marks the request approved as it runs the action.)
      s.db.patch({ table: approvals.approval, fieldValue: ref("clip.approval_id"), data: obj({ status: c.text("approved") }) }),
      s.function.run({ fn: approveCostlyRun, as: "go", input: { run_id: ref("clip.run_id"), actor_id: ref("jordan.id"), requester_id: ref("sam.id") } }),
      is("go.status", "queued"),
      s.function.run({ fn: claimStepFn, as: "tried", input: { step_id: ref("video_step.id"), attempt: c.int(1) } }),
      is("tried.status", "failed"),
      s.db.get({ table: ai_step, fieldValue: ref("video_step.id"), as: "after" }),
      is("after.detail", LIBRARY_FILE_WORDS),
      equal("after.sent_at", c.null()),
      num("after.charged", 0),
      s.db.query({ table: ledger, where: cmp(col("step_id"), "=", ref("video_step.id")), returnType: "single", as: "money" }),
      is("money.state", "released"),
    ],
  }),

  workflowTest({
    name: "tools: a member's video through generate waits for an admin with its estimate, and nothing is made or reserved",
    stack: [
      settings(), person("sam"), person("jordan", "admin"), ...prices,
      generate("asked", "sam", { via: "mcp", request: "v1" }),
      is("asked.status", "waiting_approval"),
      num("asked.estimate_micro", 352_000),
      is("asked.estimate", "$0.35"),
      says("asked.next", "approval_id"),
      s.db.query({ table: approvals.approval, returnType: "count", as: "asked_admins" }),
      num("asked_admins", 1),
      s.db.get({ table: approvals.approval, fieldValue: ref("asked.approval_id"), as: "request" }),
      is("request.action", "costly_run"),
      equal("request.user_id", ref("sam.id")),
      s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref("asked.run_id")), returnType: "single", as: "step" }),
      is("step.status", "queued"),
      equal("step.sent_at", c.null()),
      ...count("held", ledger, 0),
    ],
  }),

  plainTest({
    name: "tools: run_recipe sent twice with the same request_id starts one run, and a new request_id another",
    stack: [
      settings(), person("sam"), person("jordan", "admin"), ...prices,
      s.function.run({ fn: saveRecipeFn, as: "kit", input: {
        actor_id: ref("jordan.id"), recipe_id: c.int(0), name: c.text("Product clip"), description: c.text(""), status: c.text("published"),
        inputs: c.array([{ name: "product", label: "Product", type: "text", required: true }] as never),
        steps: c.array([{ name: "Clip", kind: "video", model: VIDEO, prompt: "A slow pan across the {{input.product}}.", file: "", settings: { use_brand: false }, options: { ...clip, aspect_ratio: "9:16" } }] as never),
      } }),
      ...[["first", "same"], ["again", "same"], ["other", "new"]].map(([as, request]) => s.function.run({ fn: runRecipeToolFn, as, input: {
        ...who("sam", { via: "mcp", request }), recipe: ref("kit.slug"), inputs: c.obj({ product: "City 3" }),
      } })),
      equal("again.run_id", ref("first.run_id")),
      is("first.status", "waiting_approval"),
      s.expect.to_not_equal({ expr: ref("other.run_id"), value: ref("first.run_id") }),
      ...runs("made", 2),
      s.db.query({ table: approvals.approval, returnType: "count", as: "asked_admins" }),
      num("asked_admins", 2),
    ],
  }),

  workflowTest({
    name: "tools: ask_knowledge answers exactly what Ask answers for its run, the same shape from MCP and from Easel",
    stack: [
      // No budget: the question is refused before any model call, and still answers in Ask's own shape.
      settings({ person: 0 }), person("sam"), ...prices,
      ask("over_mcp", "sam", { via: "mcp", request: "q1" }, "What does the City 3 weigh?"),
      ask("from_easel", "sam", { via: "easel", turn: "easel:1" }, "What does the City 3 weigh?"),
      s.function.run({ fn: askViewFn, as: "asked_mcp", input: { run_id: ref("over_mcp.run_id") } }),
      s.function.run({ fn: askViewFn, as: "asked_easel", input: { run_id: ref("from_easel.run_id") } }),
      equal("over_mcp", ref("asked_mcp")),
      equal("from_easel", ref("asked_easel")),
      equal("from_easel.status", ref("over_mcp.status")),
      is("over_mcp.status", "refused"),
      s.db.get({ table: ai_run, fieldValue: ref("over_mcp.run_id"), output: ["reason"], as: "why" }),
      is("why.reason", "over_budget"),
      s.db.get({ table: ai_run, fieldValue: ref("over_mcp.run_id"), as: "mcp_run" }),
      s.db.get({ table: ai_run, fieldValue: ref("from_easel.run_id"), as: "easel_run" }),
      is("mcp_run.via", "mcp"), is("easel_run.via", "easel"), is("mcp_run.kind", "ask"),
      ...count("held", ledger, 0),
    ],
  }),

  workflowTest({
    name: "tools: a guest's agent is refused on every call before anything is read or reserved",
    stack: [
      settings(), person("alex", "guest"), person("sam"), ...prices,
      // A to_throw body has its own variables: it finds the guest itself.
      s.expect.to_throw({ exception: c.text("Guests can't connect an agent"), body: [
        s.db.query({ table: user, where: cmp(col("email"), "=", c.text("alex@studio-test.example")), output: ["id"], returnType: "single", as: "guest" }),
        s.function.run({ fn: agentGateFn, as: "gated", input: { actor_id: ref("guest.id") } }),
      ] }),
      s.function.run({ fn: agentGateFn, as: "member_gate", input: { actor_id: ref("sam.id") } }),
      equal("member_gate.id", ref("sam.id")),
      ...runs("none", 0),
      ...count("held", ledger, 0),
    ],
  }),

  plainTest({
    name: "tools: without a request_id, the same MCP call within ten minutes is one run, and eleven minutes later a new one",
    stack: [
      settings(), person("sam"), person("jordan", "admin"), ...prices,
      // A moment a minute into a ten-minute window, so a minute later is still inside it.
      s.set_var("t0", withFilters(c.now(), fl.div(600_000), fl.floor(), fl.mul(600_000), fl.add(60_000), fl.to_int())),
      ...([["k_first", 0], ["k_resent", 60_000], ["k_later", 660_000]] as const).map(([as, plus]) => s.function.run({ fn: deriveKeyFn, as, input: {
        actor_id: ref("sam.id"), tool: c.text("generate:mcp"), args: c.obj({ kind: "video", prompt: "A slow pan" }), turn: c.text(""), at: withFilters(ref("t0"), fl.add(plus)) as Value,
      } })),
      equal("k_resent", ref("k_first")),
      s.expect.to_not_equal({ expr: ref("k_later"), value: ref("k_first") }),
      // An Easel turn is its own window: the same call in the same turn is the same request.
      s.function.run({ fn: deriveKeyFn, as: "k_turned", input: { actor_id: ref("sam.id"), tool: c.text("generate:mcp"), args: c.obj({ kind: "video", prompt: "A slow pan" }), turn: c.text("easel:4"), at: ref("t0") } }),
      s.expect.to_not_equal({ expr: ref("k_turned"), value: ref("k_first") }),
      // Through generate itself, a resend now is the first run.
      generate("one", "sam", { via: "mcp" }),
      generate("two", "sam", { via: "mcp" }),
      equal("two.run_id", ref("one.run_id")),
      ...runs("made", 1),
    ],
  }),

  workflowTest({
    name: "tools: in one Easel turn the same make_output call is one run, and the next turn's is new",
    stack: [
      settings(), person("sam"), person("jordan", "admin"), ...prices,
      generate("one", "sam", { via: "easel", turn: "easel:5" }),
      generate("same_turn", "sam", { via: "easel", turn: "easel:5" }),
      generate("next_turn", "sam", { via: "easel", turn: "easel:6" }),
      equal("same_turn.run_id", ref("one.run_id")),
      s.expect.to_not_equal({ expr: ref("next_turn.run_id"), value: ref("one.run_id") }),
      s.db.get({ table: ai_run, fieldValue: ref("one.run_id"), as: "row" }),
      is("row.via", "easel"),
      ...runs("made", 2),
    ],
  }),

  workflowTest({
    name: "tools: a read-only key can't reach a tool that writes, and can reach one that reads",
    stack: [
      settings(), person("sam"),
      s.function.run({ fn: agent.connectFn, as: "key", input: { user_id: ref("sam.id"), name: c.text("Reader"), scope: c.text("read"), days: c.int(7) } }),
      s.expect.to_throw({ exception: c.text("read-only"), body: [
        s.db.query({ table: agent.agent_connection, where: cmp(col("name"), "=", c.text("Reader")), output: ["id"], returnType: "single", as: "reader" }),
        s.function.run({ fn: agent.checkKeyFn, as: "write_check", input: { connection_id: ref("reader.id"), write: c.bool(true) } }),
      ] }),
      s.function.run({ fn: agent.checkKeyFn, as: "read_check", input: { connection_id: ref("key.connection.id"), write: c.bool(false) } }),
      equal("read_check.person.id", ref("sam.id")),
    ],
  }),

  workflowTest({
    name: "tools: an Easel make_output by someone over budget is refused before any model call",
    stack: [
      settings({ person: 0 }), person("sam"), ...prices,
      generate("asked", "sam", { via: "easel", turn: "easel:9" }, "text", "Write a tagline for the City 3", { output_tokens: 200 }, "gemini-3.8-flash"),
      is("asked.status", "refused"),
      says("asked.detail", "budget"),
      equal("asked.output", c.null()),
      s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref("asked.run_id")), returnType: "single", as: "step" }),
      equal("step.sent_at", c.null()),
      ...count("held", ledger, 0),
    ],
  }),

  plainTest({
    name: "tools: with no model key Easel can't answer and says which key to set; with one, or on the Xano AI Router, it can",
    stack: [
      s.function.run({ fn: easelSetupFn, as: "no_gemini", input: { provider: c.text("google-genai"), anthropic_key_length: c.int(0), gemini_key_length: c.int(0), anthropic_model: c.text(""), gemini_model: c.text("gemini-3.8-flash") } }),
      equal("no_gemini.ready", c.bool(false)),
      says("no_gemini.setup", "An admin adds GEMINI_API_KEY"),
      s.function.run({ fn: easelSetupFn, as: "no_anthropic", input: { provider: c.text("anthropic"), anthropic_key_length: c.int(0), gemini_key_length: c.int(39), anthropic_model: c.text("claude-opus-5-5"), gemini_model: c.text("") } }),
      equal("no_anthropic.ready", c.bool(false)),
      is("no_anthropic.provider", "anthropic"),
      says("no_anthropic.setup", "ANTHROPIC_API_KEY"),
      // Left unset, Easel is on Google and asks for its key; on the Xano AI Router it needs no key of its own.
      s.function.run({ fn: easelSetupFn, as: "unset", input: { provider: c.text(""), anthropic_key_length: c.int(0), gemini_key_length: c.int(0), anthropic_model: c.text(""), gemini_model: c.text("gemini-4-hydrogen") } }),
      is("unset.provider", "google-genai"),
      says("unset.setup", "GEMINI_API_KEY"),
      s.function.run({ fn: easelSetupFn, as: "router", input: { provider: c.text("xano-ai"), anthropic_key_length: c.int(0), gemini_key_length: c.int(0), anthropic_model: c.text(""), gemini_model: c.text("") } }),
      equal("router.ready", c.bool(true)),
      is("router.provider", "xano-ai"),
      is("router.model", "gemini-4-hydrogen"),
      s.function.run({ fn: easelSetupFn, as: "keyed", input: { provider: c.text("google-genai"), anthropic_key_length: c.int(0), gemini_key_length: c.int(39), anthropic_model: c.text(""), gemini_model: c.text("gemini-3.8-flash") } }),
      equal("keyed.ready", c.bool(true)),
      is("keyed.model", "gemini-3.8-flash"),
      s.function.run({ fn: easelSetupFn, as: "unknown", input: { provider: c.text("openai"), anthropic_key_length: c.int(10), gemini_key_length: c.int(10), anthropic_model: c.text(""), gemini_model: c.text("") } }),
      equal("unknown.ready", c.bool(false)),
      says("unknown.setup", "AGENT_PROVIDER is set to \"openai\""),
    ],
  }),

  workflowTest({
    name: "tools: a message to Easel opens a turn, records the provider's usage, closes with its tools, and charges no budget",
    stack: [
      settings(), person("sam"),
      s.function.run({ fn: openTurnFn, as: "first", input: { user_id: ref("sam.id"), conversation_id: c.int(7), provider: c.text("google-genai"), model: c.text("gemini-3.8-flash") } }),
      // A reply that failed leaves its turn open; the next message closes it as failed.
      s.function.run({ fn: openTurnFn, as: "second", input: { user_id: ref("sam.id"), conversation_id: c.int(7), provider: c.text("google-genai"), model: c.text("gemini-3.8-flash") } }),
      s.db.get({ table: easel_turn, fieldValue: ref("first"), as: "failed_turn" }),
      is("failed_turn.status", "failed"),
      s.function.run({ fn: turnUsageFn, as: "recorded", input: { conversation_id: c.int(7), result: c.obj({ result: "Here it is.", usage: { inputTokens: 1200, outputTokens: 300 } }) } }),
      equal("recorded", c.bool(true)),
      s.function.run({ fn: closeTurnFn, as: "closed", input: { user_id: ref("sam.id"), tools: c.array(["search_library", "make_output"]) } }),
      equal("closed", ref("second")),
      s.db.get({ table: easel_turn, fieldValue: ref("second"), as: "turn" }),
      is("turn.status", "done"),
      num("turn.input_tokens", 1200),
      num("turn.output_tokens", 300),
      equal("turn.tools", c.array(["search_library", "make_output"])),
      is("turn.provider", "google-genai"),
      ...count("held", ledger, 0),
      ...runs("no_runs", 0),
    ],
  }),
];
