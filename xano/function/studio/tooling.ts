// What the shared tool functions have in common. Each capability an agent or Easel can use is one function that takes the
// person it acts for (`actor_id`) and the route it came by (`via`), and calls the same functions the app's screens call, so
// the spend gate, the roles and the read rule apply unchanged. The MCP and assistant tools are thin doors onto them.
import { auth, c, cmp, col, defineFunction, expr, fl, guard, inp, input, middleware, ref, s, sys, withFilters, type Value } from "@xano/sdk";
import { ai_run } from "../../table/studio/ai_run.js";
import { user } from "../../table/user.js";
import { deriveKeyFn } from "../runs/start.js";
import { readRun } from "../runs/reserve.js";
import { dollars } from "../spend/estimate.js";

/** The routes a tool call comes by: an outside agent over MCP, or Easel in the app. */
export const TOOL_VIAS = ["mcp", "easel"] as const;

/** Who a shared function acts for and how the call arrived. `turn` is Easel's turn; MCP has none. */
export const actorInputs = {
  actor_id: input.int({ required: true }),
  via: input.enum(TOOL_VIAS, { required: true }),
  /** The person's own agent connection (MCP), or 0 for Easel. */
  connection_id: input.int(),
  /** Whose name an approval card shows as asking: "Easel", or the agent's connection name. */
  agent_label: input.text(),
  turn: input.text(),
};

/** Inputs of a tool that starts a run: a caller's own key, so its retry is the same request. */
export const requestInput = { request_id: input.text({ methods: ["trim"] }) };

export const GUEST_AGENT_WORDS = "Guests can't connect an agent.";

/**
 * Every MCP tool runs this before its shared function: the person behind the connection must still be here and not a
 * guest. Guests see approved work and can ask Knowledge in the app, but can't connect an agent at all.
 */
export const agentGateFn = defineFunction({
  name: "studio/agent_gate",
  description: "Refuse an agent's call unless the person behind its connection still exists and isn't a guest.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "member" }),
    guard.found("member", { errorType: "accessdenied", message: "The person who connected this agent no longer exists." }),
    guard.require(expr(ref("member.role"), "!=", c.text("guest")), { errorType: "accessdenied", message: GUEST_AGENT_WORDS }),
  ],
  response: { id: ref("member.id"), role: ref("member.role") },
});

/** On the agent-key routes: a guest can't connect an agent, so a guest can't make or hold a key. */
export const agentKeysMember = middleware({
  name: "studio/agent_keys_member",
  description: "Refuses the agent-key routes to guests.",
  exceptionPolicy: "rethrow",
  stack: [
    s.db.get({ table: user, fieldValue: auth("id"), output: ["id", "role"], as: "key_person" }),
    guard.found("key_person", { errorType: "unauthorized", message: "Sign in again." }),
    guard.require(expr(ref("key_person.role"), "!=", c.text("guest")), { errorType: "accessdenied", message: GUEST_AGENT_WORDS }),
  ],
});

/**
 * The run's idempotency key, bound to `idem_key`. The caller's own `request_id` when it sent one; otherwise one made from the
 * person, the tool and its arguments, plus Easel's turn, or for MCP (which has no turn) the 10-minute window of the call.
 */
export const idemKey = (tool: string, args: Value) => [
  s.set_var("given_request", withFilters(inp("request_id"), fl.first_notnull(c.text("")), fl.to_text(), fl.trim())),
  s.conditional({
    when: expr(ref("given_request"), "!=", c.text("")),
    then: [s.set_var("idem_key", withFilters(c.text(`tool:${tool}:`), fl.concat(withFilters(ref("given_request"), fl.substr(0, 180)))))],
    else: [
      s.function.run({ fn: deriveKeyFn, as: "derived_key", input: {
        actor_id: inp("actor_id"), tool: withFilters(c.text(`${tool}:`), fl.concat(inp("via"))), args, turn: withFilters(inp("turn"), fl.first_notnull(c.text(""))), at: c.int(0),
      } }),
      s.set_var("idem_key", ref("derived_key")),
    ],
  }),
];

/**
 * Where a run's background steps call back, bound to `base`: this request's address before its route. A tool call may come
 * through an MCP server rather than an API group, so failing that it's the address the app last started a run on.
 */
export const instanceBase = () => [
  s.set_var("base", withFilters(c.regex(/\/(api:|x2\/).*$/), fl.regex_replace(c.text(""), withFilters(sys.apiBaseUrl(), fl.first_notnull(c.text("")))))),
  s.conditional({ when: expr(withFilters(ref("base"), fl.starts_with(c.text("http"))), "=", c.bool(false)), then: [
    s.db.query({ table: ai_run, where: expr(col("base_url"), "!=", c.text("")), sort: [{ sortBy: "id", dir: "desc" }], output: ["base_url"], returnType: "single", as: "last_base" }),
    s.update_var("base", withFilters(ref("last_base.base_url", { safe: true }), fl.first_notnull(c.text("")))),
  ] }),
];

export type ToolRun = {
  run_id: number; status: string; title: string; detail: string; estimate: string; estimate_micro: number; spent: string;
  approval_id: number; link: string; next: string;
};

/** What waits on whom, in words a model passes on. */
const NEXT_WORDS: Record<string, string> = {
  waiting_approval: "It waits for an admin's approval and nothing is charged until then. Say so, and include the lines `approval_id: <approval_id>` and `run_id: <run_id>`.",
  waiting_confirmation: "It is above the approval line, so the person must confirm it in the app themselves; you can't confirm it. Say so, and include the line `run_id: <run_id>`.",
  needs_confirmation: "It is above the approval line, so the person must confirm it in the app themselves. Include the line `run_id: <run_id>`.",
  refused: "It was refused, and nothing was charged. Say why, in the detail's words.",
  queued: "It is under way. Check on it later with the run_id.",
  running: "It is under way. Check on it later with the run_id.",
};

/** A run as a tool answers it: where it stands, what it's estimated at, what waits on whom, and its page. */
export const runAnswerFn = defineFunction({
  name: "studio/run_answer",
  description: "A run's status, estimate, what it waits on and its link, as a tool answers it.",
  input: { run_id: input.int({ required: true }) },
  stack: [
    readRun(inp("run_id"), "answered"),
    guard.found("answered", { message: "That run couldn't be started. Try again." }),
    dollars("estimate_words", ref("answered.estimate")),
    dollars("spent_words", ref("answered.spent")),
    s.set_var("next", withFilters(c.obj(NEXT_WORDS), fl.get(ref("answered.status"), "It has ended. Read its outputs by checking the run_id."))),
  ],
  response: {
    run_id: ref("answered.id"), status: ref("answered.status"), title: ref("answered.title"), detail: ref("answered.detail"),
    estimate: ref("estimate_words"), estimate_micro: ref("answered.estimate"), spent: ref("spent_words"),
    approval_id: ref("answered.approval_id"), link: withFilters(c.text("/runs/"), fl.concat(ref("answered.id"))), next: ref("next"),
  },
  responseShape: {} as ToolRun,
});

/** Easel's open turn for this person, as a key part ("easel:12"), bound to `turn_key`, or "" outside a turn. */
export const easelTurnKey = (person: Value, turnTable: Parameters<typeof s.db.query>[0]["table"]) => [
  s.db.query({ table: turnTable, where: [cmp(col("user_id"), "=", person), cmp(col("status"), "=", c.text("open"))],
    sort: [{ sortBy: "id", dir: "desc" }], output: ["id"], returnType: "single", as: "open_turn" }),
  s.set_var("turn_key", c.text("")),
  s.conditional({ when: expr(ref("open_turn"), "!=", c.null()), then: [s.update_var("turn_key", withFilters(c.text("easel:"), fl.concat(ref("open_turn.id", { safe: true }))))] }),
];
