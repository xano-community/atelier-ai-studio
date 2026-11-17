// Whether Xano AI can run here. Nothing probes a model to find out: the status is written at first run from what the
// deploy reported, and corrected by the first refusal a call meets. Every write is a POST; reading the status never
// writes it.
import { c, cond, defineFunction, expr, fl, guard, inp, input, obj, or, ref, s, withFilters } from "@xano/sdk";
import { AI_STATUSES, workspace_setting } from "../../base/tables.js";
import { settingsRow } from "../spend/begin.js";

/** What admins read under each status: what happened, and how to fix it. */
export const AI_STATUS_WORDS: Record<(typeof AI_STATUSES)[number], string> = {
  on: "",
  signed_out: "This deploy wasn't signed in to Xano AI, so nothing can run. Deploy again while signed in to turn it on.",
  no_credits: "Xano AI has run out of credits. Add credits in your Xano account, then choose Check again.",
  disabled: "Xano AI isn't available on this instance yet. Ask your Xano admin to turn it on, then choose Check again.",
  expired: "The Xano AI sign-in on this machine has expired. Sign in again and deploy, and AI turns back on.",
};

/**
 * Set the status: given outright (from a deploy's report, or "on" after a successful check), or read from a gateway refusal.
 * A refusal saying "not available yet" means AI is off here; HTTP 402 or `credits_exhausted` means out of credits. Any
 * other error leaves the status alone: one failed call isn't an outage.
 */
export const aiStatusFn = defineFunction({
  name: "studio/ai_status",
  description: "Record whether Xano AI can run here: a status given outright, or one read from a gateway refusal.",
  input: {
    status: input.text({ description: "One of on, signed_out, no_credits, disabled, expired. Empty: read it from the error." }),
    error: input.text({ description: "A gateway refusal's message." }),
    http_status: input.int(),
  },
  stack: [
    s.set_var("next", withFilters(inp("status"), fl.first_notnull(c.text("")))),
    guard.require(or(expr(ref("next"), "=", c.text("")), cond.in(ref("next"), c.array([...AI_STATUSES]))),
      { errorType: "badrequest", message: `The status is one of ${AI_STATUSES.join(", ")}.` }),
    s.conditional({ when: expr(ref("next"), "=", c.text("")), then: [
      s.set_var("message", withFilters(inp("error"), fl.first_notnull(c.text("")), fl.lower())),
      s.conditional({
        when: or(expr(inp("http_status"), "=", c.int(402)), expr(withFilters(ref("message"), fl.contains("credits_exhausted")), "=", c.bool(true))),
        then: [s.update_var("next", c.text("no_credits"))],
        elif: [{ when: expr(withFilters(ref("message"), fl.contains("not available yet")), "=", c.bool(true)), then: [s.update_var("next", c.text("disabled"))] }],
      }),
    ] }),
    settingsRow("settings"),
    guard.found("settings", { message: "The workspace has no settings row." }),
    s.conditional({ when: expr(ref("next"), "!=", c.text("")), then: [
      s.set_var("words", withFilters(c.obj(AI_STATUS_WORDS), fl.get(ref("next")))),
      s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ ai_status: ref("next"), ai_status_reason: ref("words") }) }),
    ] }),
    s.db.get({ table: workspace_setting, fieldValue: ref("settings.id"), output: ["ai_status", "ai_status_reason"], as: "now" }),
    guard.found("now", { message: "The workspace has no settings row." }),
  ],
  response: { ai_status: ref("now.ai_status"), ai_status_reason: ref("now.ai_status_reason") },
});
