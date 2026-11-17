// What a gateway error means for the person, the step and the money. Xano AI refuses a request with "Xano AI refused the
// request (HTTP n): …" and `result.status`; a video that isn't ready in time fails with `result.code` "timeout". A refusal
// is made before the gateway does any work, so it isn't billed: the step settles at nothing. A timeout and any other
// failure after the call went out are billed, so they're charged. Two refusals say something about the whole workspace
// (no credits, AI switched off), and they set the AI status every screen reads.
import { c, caught, defineFunction, env, expr, fl, inp, input, or, ref, s, withFilters } from "@xano/sdk";
import { aiStatusFn } from "../studio/ai_status.js";
import { AI_DEPLOY_ENV } from "../studio/ai_state.js";

const has = (words: string) => expr(withFilters(ref("message"), fl.contains(words)), "=", c.bool(true));
const verdict = (outcome: string, reason: string, detail: string, refused: boolean) => [
  s.update_var("outcome", c.text(outcome)),
  s.update_var("reason", c.text(reason)),
  s.update_var("detail", c.text(detail)),
  s.update_var("refused", c.bool(refused)),
];

export const GATEWAY_WORDS = {
  timeout: "It wasn't ready within the time limit. Xano AI still charges for a call it was sent, so it's counted. Try again, or ask for a shorter clip.",
  no_credits: "Xano AI has run out of credits, so nothing was made or charged. An admin can add credits in the Xano account, then try again.",
  disabled: "Xano AI isn't available on this instance yet, so nothing was made or charged. Ask your Xano admin to turn it on.",
  signed_out: "AI isn't switched on here yet, so nothing was made or charged. An admin signs in with npx @xano/sdk login and deploys again.",
  no_gateway_price: "Xano AI can't serve this model yet, so nothing was made or charged. Pick another model.",
  not_found: "This model isn't available right now, so nothing was made or charged. Pick another model.",
  rejected: "Xano AI turned this request down, so nothing was made or charged. Check the settings and try again.",
  bad_file: "The file couldn't be read, so nothing was sent or charged. Files last a day after upload: attach it again and retry.",
  bad_json: "The model's reply wasn't valid JSON. It was still charged. Try again, or loosen the schema.",
  model_error: "The model didn't finish this one. It was sent, so it may be charged. Try again.",
} as const;

export const gatewayErrorFn = defineFunction({
  name: "ai/gateway_error",
  description: "Classify a Xano AI error as timed out, refused (not charged) or failed, in plain words, and update the AI status.",
  input: {
    /** The whole caught error: { code, message, result: { status, code, retryable } }. */
    error: input.json(),
  },
  stack: [
    s.set_var("message", withFilters(inp("error"), fl.get("message", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.lower())),
    s.set_var("http", withFilters(inp("error"), fl.get("result.status", 0), fl.first_notnull(c.int(0)), fl.to_int())),
    s.set_var("code", withFilters(inp("error"), fl.get("result.code", ""), fl.first_notnull(c.text("")), fl.to_text())),
    s.set_var("outcome", c.text("failed")),
    s.set_var("reason", c.text("model_error")),
    s.set_var("detail", c.text(GATEWAY_WORDS.model_error)),
    s.set_var("refused", c.bool(false)),
    s.conditional({
      when: or(expr(ref("code"), "=", c.text("timeout")), has("(timeout)"), has("not ready within")),
      then: verdict("timed_out", "timeout", GATEWAY_WORDS.timeout, false),
      elif: [
        { when: or(expr(ref("http"), "=", c.int(402)), has("credits_exhausted")), then: verdict("failed", "no_credits", GATEWAY_WORDS.no_credits, true) },
        { when: has("not available yet"), then: verdict("failed", "disabled", GATEWAY_WORDS.disabled, true) },
        // Measured on the dev gateway: rerank's model "has no price and cannot be served".
        { when: has("has no price"), then: verdict("failed", "unavailable", GATEWAY_WORDS.no_gateway_price, true) },
        // Measured: a model the catalog lists but the project can't reach answers 404 "was not found".
        { when: or(expr(ref("http"), "=", c.int(404)), has("not found")), then: verdict("failed", "unavailable", GATEWAY_WORDS.not_found, true) },
        { when: [expr(ref("http"), ">=", c.int(400)), expr(ref("http"), "<", c.int(500))], then: verdict("failed", "rejected", GATEWAY_WORDS.rejected, true) },
        // Measured: the statement checks its file before sending ("audio is not a valid file resource"), so nothing is billed.
        { when: [expr(ref("http"), "=", c.int(0)), has("not a valid file resource")], then: verdict("failed", "bad_file", GATEWAY_WORDS.bad_file, true) },
        // A JSON reply that doesn't parse throws after the gateway answered (and billed).
        { when: [expr(ref("http"), "=", c.int(0)), has("json")], then: verdict("failed", "bad_json", GATEWAY_WORDS.bad_json, false) },
      ],
    }),
    // The same refusal comes back when this deploy wasn't signed in to Xano AI (scripts/deploy.mjs records that): then
    // signing in is the fix, and the instance's own setting isn't the cause, so it isn't recorded as switched off.
    s.conditional({ when: [expr(ref("reason"), "=", c.text("disabled")),
      expr(withFilters(env(AI_DEPLOY_ENV), fl.first_notnull(c.text("")), fl.to_text(), fl.contains('"status":"off"')), "=", c.bool(true))], then: [
      ...verdict("failed", "signed_out", GATEWAY_WORDS.signed_out, true),
    ] }),
    s.conditional({ when: or(expr(ref("reason"), "=", c.text("no_credits")), expr(ref("reason"), "=", c.text("disabled"))), then: [
      // The status is a workspace setting; a step never fails because it couldn't be written.
      s.try_catch({
        try: [s.function.run({ fn: aiStatusFn, as: "status", input: { status: c.text(""), error: ref("message"), http_status: ref("http") } })],
        catch: [s.set_var("status_error", caught("message"))],
      }),
    ] }),
  ],
  response: {
    outcome: ref("outcome"), reason: ref("reason"), detail: ref("detail"), refused: ref("refused"),
    /** The gateway's own words, kept on the step for whoever debugs it. Never shown as the person's reason. */
    gateway_message: withFilters(inp("error"), fl.get("message", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.substr(c.int(0), c.int(400))),
  },
});
