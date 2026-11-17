// Easel, the assistant in the app: the chatbot module's chat, on a model the deployer picks with AGENT_PROVIDER. The default,
// `google-genai`, runs Gemini 4 Hydrogen (GEMINI_MODEL) on the deployer's Gemini key; `anthropic` runs on an Anthropic key.
// `xano-ai` runs Gemini 4 Hydrogen through the Xano AI Router with no key of its own, but the Router refuses an agent with
// tools today ("tools must be a list", 2026-11-17), so it isn't the default yet. Easel isn't a member: it has no role or user row,
// and every tool it calls acts as the person who asked.
//
// Its own model turns are billed outside the spend gate (by the AI Router or the key's provider), so they're recorded (an easel_turn row per message, shown
// on Usage as provider-billed) and never charged to a budget. What it makes with a tool is a run like any other, through
// the spend gate, charged to the person.
//
// With no key set, Easel answers "The assistant needs a model key" with the step to fix it, and makes no model call. Nothing
// else in the app depends on it.
import { agent as agentDef, auth, c, cmp, col, defineFunction, env, expr, fl, guard, inp, input, middleware, obj, ref, s, withFilters, type Statement, type Value } from "@xano/sdk";
import { rbac } from "../../rbac.js";
import { easel_turn } from "../../table/studio/easel_turn.js";
import { user } from "../../table/user.js";

/** Tool calls a turn may make, with a step left over for the answer. */
export const EASEL_MAX_STEPS = 8;
export const EASEL_PROVIDERS = ["google-genai", "anthropic", "xano-ai"] as const;
/** Easel's model on the Xano AI Router. A literal: the Router picks the model before it renders templates. */
export const EASEL_XANO_AI_MODEL = "gemini-4-hydrogen";
export const NO_KEY_TITLE = "The assistant needs a model key.";
export const EASEL_GUEST_WORDS = "Easel is for people who can run AI here. You can still ask Knowledge and browse approved work.";

type EaselState = { ready: boolean; provider: string; model: string; key_name: string; setup: string };

/** Whether Easel can answer from what's set: the provider, whether its key is there, and the step to fix it when not. */
export const easelSetupFn = defineFunction({
  name: "easel/setup",
  description: "From the provider and whether its key is set: whether Easel can answer, and the setup step when it can't.",
  input: { provider: input.text(), anthropic_key_length: input.int(), gemini_key_length: input.int(), anthropic_model: input.text(), gemini_model: input.text() },
  stack: [
    s.set_var("provider", withFilters(inp("provider"), fl.first_notempty(c.text("google-genai")), fl.to_text(), fl.trim(), fl.lower())),
    s.set_var("key_name", c.text("ANTHROPIC_API_KEY")),
    s.set_var("key_set", c.expression("$input.anthropic_key_length > 0")),
    s.set_var("model", withFilters(inp("anthropic_model"), fl.first_notnull(c.text("")))),
    s.conditional({ when: expr(ref("provider"), "=", c.text("google-genai")), then: [
      s.update_var("key_name", c.text("GEMINI_API_KEY")),
      s.update_var("key_set", c.expression("$input.gemini_key_length > 0")),
      s.update_var("model", withFilters(inp("gemini_model"), fl.first_notnull(c.text("")))),
    ] }),
    // Xano AI needs no key of its own: the workspace's Xano AI access is the key.
    s.conditional({ when: expr(ref("provider"), "=", c.text("xano-ai")), then: [
      s.update_var("key_name", c.text("")), s.update_var("key_set", c.bool(true)), s.update_var("model", c.text(EASEL_XANO_AI_MODEL)),
    ] }),
    s.set_var("known", withFilters(c.array([...EASEL_PROVIDERS]), fl.in(ref("provider")))),
    s.set_var("setup", c.text("")),
    s.conditional({ when: expr(ref("known"), "=", c.bool(false)), then: [
      s.update_var("setup", withFilters(c.text("AGENT_PROVIDER is set to \""), fl.concat(ref("provider")),
        fl.concat(c.text(`". An admin sets it to ${EASEL_PROVIDERS.join(", ")} in the workspace's environment variables, then deploys again.`)))),
    ] }),
    s.conditional({ when: [expr(ref("known"), "=", c.bool(true)), expr(ref("key_set"), "=", c.bool(false))], then: [
      s.update_var("setup", withFilters(c.text("An admin adds "), fl.concat(ref("key_name")), fl.concat(c.text(" to the workspace's environment variables (AGENT_PROVIDER is ")), fl.concat(ref("provider")),
        fl.concat(c.text("; anthropic and google-genai are the choices), then deploys again. Everything else in Atelier works without it.")))),
    ] }),
  ],
  response: { ready: c.expression('$var.setup == ""'), provider: ref("provider"), model: ref("model"), key_name: ref("key_name"), setup: ref("setup") },
  responseShape: {} as EaselState,
});

/** Easel's state from the workspace's environment variables. Never reads a key back. */
export const easelReadyFn = defineFunction({
  name: "easel/ready",
  description: "Easel's provider and model, and whether the key it needs is set.",
  stack: [
    s.function.run({ fn: easelSetupFn, as: "state", input: {
      provider: env("AGENT_PROVIDER"),
      anthropic_key_length: withFilters(env("ANTHROPIC_API_KEY"), fl.first_notnull(c.text("")), fl.to_text(), fl.trim(), fl.strlen()),
      gemini_key_length: withFilters(env("GEMINI_API_KEY"), fl.first_notnull(c.text("")), fl.to_text(), fl.trim(), fl.strlen()),
      anthropic_model: env("ANTHROPIC_MODEL"), gemini_model: env("GEMINI_MODEL"),
    } }),
  ],
  response: ref("state"),
  responseShape: {} as EaselState,
});

/**
 * Open a message's turn. A turn this person left open (a reply that failed before it was closed) is closed as failed first,
 * so the open one is always the message in flight.
 */
export const openTurnFn = defineFunction({
  name: "easel/open_turn",
  description: "Open a provider-billed turn for a message to Easel, closing any this person left open as failed.",
  input: { user_id: input.int({ required: true }), conversation_id: input.int(), provider: input.text(), model: input.text() },
  stack: [
    s.db.query({ table: easel_turn, where: [cmp(col("user_id"), "=", inp("user_id")), cmp(col("status"), "=", c.text("open"))], output: ["id"], as: "left_open" }),
    s.foreach({ list: ref("left_open"), as: "stale", body: [
      s.db.patch({ table: easel_turn, fieldValue: ref("stale.id"), data: obj({ status: c.text("failed"), finished_at: c.now() }) }),
    ] }),
    s.db.add({ table: easel_turn, as: "opened", row: {
      user_id: inp("user_id"), conversation_id: withFilters(inp("conversation_id"), fl.first_notnull(c.int(0))), provider: inp("provider"), model: inp("model"),
      status: c.text("open"), input_tokens: c.int(0), output_tokens: c.int(0), usage: c.obj({}), tools: c.array([]),
    } }),
  ],
  response: ref("opened.id"),
  responseShape: 0 as number,
});

/** A run's usage in tokens, bound to `as`, from whichever names the provider reported them under. */
const tokens = (as: string, names: string[]) => [
  ...names.map((name, i) => s.set_var(`${as}_${i}`, withFilters(ref("run_usage"), fl.get(name, c.null())))),
  s.set_var(as, names.slice(1).reduce<Value>((v, _n, i) => withFilters(v, fl.first_notnull(ref(`${as}_${i + 1}`))), ref(`${as}_0`))),
  s.update_var(as, withFilters(ref(as), fl.first_notnull(c.int(0)), fl.to_int())),
];

/** Put a model run's reported usage on the conversation's open turn. */
export const turnUsageFn = defineFunction({
  name: "easel/turn_usage",
  description: "Record the provider's reported usage of an Easel model run on the conversation's open turn.",
  input: { conversation_id: input.int({ required: true }), result: input.json() },
  stack: [
    s.set_var("ran", withFilters(inp("result"), fl.first_notnull(c.obj({})))),
    s.set_var("total_usage", withFilters(ref("ran"), fl.get("totalUsage", c.null()))),
    s.set_var("run_usage", withFilters(ref("ran"), fl.get("usage", c.null()), fl.first_notnull(ref("total_usage")), fl.first_notnull(c.obj({})))),
    ...tokens("in_tokens", ["inputTokens", "promptTokens", "input_tokens"]),
    ...tokens("out_tokens", ["outputTokens", "completionTokens", "output_tokens"]),
    s.db.query({ table: easel_turn, where: [cmp(col("conversation_id"), "=", inp("conversation_id")), cmp(col("status"), "=", c.text("open"))],
      sort: [{ sortBy: "id", dir: "desc" }], output: ["id"], paging: { per_page: 1, metadata: false }, as: "this_turn" }),
    s.set_var("recorded", c.bool(false)),
    s.foreach({ list: ref("this_turn"), as: "turn", body: [
      s.db.patch({ table: easel_turn, fieldValue: ref("turn.id"), data: obj({ usage: ref("run_usage"), input_tokens: ref("in_tokens"), output_tokens: ref("out_tokens") }) }),
      s.update_var("recorded", c.bool(true)),
    ] }),
  ],
  response: ref("recorded"),
  responseShape: false as boolean,
});

/** Close this person's open turn with the tools the reply used. */
export const closeTurnFn = defineFunction({
  name: "easel/close_turn",
  description: "Close a person's open Easel turn as done, with the names of the tools its reply used.",
  input: { user_id: input.int({ required: true }), tools: input.json() },
  stack: [
    s.db.query({ table: easel_turn, where: [cmp(col("user_id"), "=", inp("user_id")), cmp(col("status"), "=", c.text("open"))],
      sort: [{ sortBy: "id", dir: "desc" }], output: ["id"], paging: { per_page: 1, metadata: false }, as: "closing" }),
    s.set_var("closed", c.int(0)),
    s.foreach({ list: ref("closing"), as: "turn", body: [
      s.db.patch({ table: easel_turn, fieldValue: ref("turn.id"), data: obj({ status: c.text("done"), finished_at: c.now(), tools: withFilters(inp("tools"), fl.safe_array()) }) }),
      s.update_var("closed", ref("turn.id")),
    ] }),
  ],
  response: ref("closed"),
  responseShape: 0 as number,
});

/** On every chat route: Easel runs AI for the person, so it's for people who may (guests may not). */
export const easelMember = middleware({
  name: "easel/member",
  description: "Refuses Easel to anyone whose role can't run AI.",
  exceptionPolicy: "rethrow",
  stack: [
    s.db.get({ table: user, fieldValue: auth("id"), output: ["id", "role"], as: "easel_person" }),
    guard.found("easel_person", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("easel_person.role"), "studio.run", EASEL_GUEST_WORDS),
  ],
});

/** Before a message to Easel: open its turn when it can answer. With no key there's none: the reply says what to set up. */
export const easelTurnOpen = middleware({
  name: "easel/turn_open",
  description: "Open a provider-billed easel_turn row for a message to Easel.",
  exceptionPolicy: "rethrow",
  stack: [
    s.util.get_all_input({ as: "turn_request" }),
    s.db.get({ table: user, fieldValue: auth("id"), output: ["id", "role"], as: "turn_person" }),
    guard.found("turn_person", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("turn_person.role"), "studio.run", EASEL_GUEST_WORDS),
    s.function.run({ fn: easelReadyFn, as: "turn_easel" }),
    s.conditional({ when: expr(ref("turn_easel.ready"), "=", c.bool(true)), then: [
      s.function.run({ fn: openTurnFn, as: "opened", input: {
        user_id: auth("id"), conversation_id: withFilters(ref("turn_request.vars.conversation_id", { safe: true }), fl.first_notnull(c.int(0)), fl.to_int()),
        provider: ref("turn_easel.provider"), model: ref("turn_easel.model"),
      } }),
    ] }),
  ],
});

/** After Easel answers: close the turn with the tools it used. Its usage is already on it. */
export const easelTurnClose = middleware({
  name: "easel/turn_close",
  description: "Close the message's easel_turn row with the tools the reply used.",
  exceptionPolicy: "silent",
  stack: [
    s.util.get_all_input({ as: "turn_reply" }),
    s.function.run({ fn: closeTurnFn, as: "closed", input: { user_id: auth("id"), tools: withFilters(ref("turn_reply.vars.result.tool_calls", { safe: true }), fl.safe_array()) } }),
  ],
});

export const easelFunctions = [easelSetupFn, easelReadyFn, openTurnFn, turnUsageFn, closeTurnFn];

type ChatAgent = { tools?: unknown; llm: unknown };

/**
 * Easel on each provider, and the reply step that picks one. The chatbot module builds the chat and one agent (Anthropic,
 * here); this adds the Google and Xano AI agents with the same tools and prompt, and replaces the module's one agent call in
 * its reply function with: no key → the setup answer and no model call; otherwise the provider's agent, and its usage onto
 * the open turn. Returns the extra agents to register.
 */
export function wireEasel(bot: { agent: ChatAgent; replyFn: { stack?: readonly unknown[] } }) {
  const { type: _type, apiKey: _key, model: _model, ...shared } = bot.agent.llm as Record<string, unknown>;
  const onGoogle = agentDef({
    name: "easel_google", description: "Easel, the in-app assistant, on Google Gemini.", tools: bot.agent.tools as never,
    llm: { ...shared, type: "google-genai", apiKey: "{{ $env.GEMINI_API_KEY }}", model: "{{ $env.GEMINI_MODEL }}", temperature: 0.3 } as never,
  });
  const onXano = agentDef({
    name: "easel_xano_ai", description: "Easel, the in-app assistant, on Gemini 4 Hydrogen through the Xano AI Router.", tools: bot.agent.tools as never,
    llm: { ...shared, type: "xano-ai", model: EASEL_XANO_AI_MODEL, temperature: 0.3 } as never,
  });
  const run = (which: unknown) => s.ai.agent.run({ agent: which as never, args: obj({ messages: ref("messages_json") }), allowToolExecution: c.bool(true), as: "run" });
  const stack = (bot.replyFn.stack ?? []) as Statement[];
  const calls = stack.filter((st) => (st as { name?: string }).name === "mvp:call_agent");
  if (calls.length !== 1) {
    throw new Error("wireEasel: the chatbot's reply function no longer has exactly one agent call. Check @xano-sdk/chatbot's generate_reply before upgrading it.");
  }
  const chosen: Statement[] = [
    s.function.run({ fn: easelReadyFn, as: "easel" }),
    s.conditional({
      when: expr(ref("easel.ready"), "=", c.bool(false)),
      then: [s.set_var("run", obj({ result: withFilters(c.text(`**${NO_KEY_TITLE}** `), fl.concat(ref("easel.setup"))), steps: c.array([]) }))],
      else: [
        s.switch({ on: ref("easel.provider"), default: [run(bot.agent)], cases: [
          { when: c.text("google-genai"), break: true, body: [run(onGoogle)] },
          { when: c.text("xano-ai"), break: true, body: [run(onXano)] },
        ] }),
        s.function.run({ fn: turnUsageFn, as: "usage_recorded", input: { conversation_id: inp("conversation_id"), result: ref("run") } }),
      ],
    }),
  ];
  stack.splice(stack.indexOf(calls[0]), 1, ...chosen);
  return [onGoogle, onXano];
}
