// Whether AI can run here right now, as every screen and the first-run check read it. Nothing calls a model to find out.
// The workspace setting holds what refusals said (no credits, AI switched off on the instance). What the deploy reported
// rides in the XANO_AI_DEPLOY env value that `npm run xano:deploy` writes after each deploy (scripts/deploy.mjs): a deploy
// that wasn't signed in to Xano AI is `signed_out`, and a Xano Engine's sign-in that has passed its expiry is `expired`.
// Admins read the fix; everyone else reads that an admin can turn it on.
import { c, cond, defineFunction, env, expr, fl, guard, inp, input, ref, s, withFilters } from "@xano/sdk";
import { rbac } from "../../rbac.js";
import { user } from "../../table/user.js";
import { settingsRow } from "../spend/begin.js";

/** The env value scripts/deploy.mjs writes: { status, reason, billing, expires_ms }, as the deploy reported it. */
export const AI_DEPLOY_ENV = "XANO_AI_DEPLOY";
/** What it holds until a deploy reports: the setting alone decides. */
export const AI_DEPLOY_UNREPORTED = "unreported";
/** The command that signs a machine in to Xano AI. */
export const SIGN_IN_COMMAND = "npx @xano/sdk login";
/** The command that stops a Xano Engine started before it could take a sign-in. */
export const RESTART_COMMAND = "npx @xano/sdk local stop";

export const AI_STATE_WORDS = {
  signed_out: "This deploy wasn't signed in to Xano AI. Everything else works, and what's here stays browsable. To run models, sign in and deploy again.",
  restart: "This Xano Engine started before it could take a Xano AI sign-in. Everything else works, and what's here stays browsable. Stop the engine, then deploy again.",
  expired: "Nothing can run until it's renewed. Everything else works. Sign in again and deploy, and AI turns back on.",
  member: "Everything else works, and you can look through what's here. Ask an admin to switch it on.",
  member_credits: "The workspace is out of Xano AI credits, so runs are paused. Nothing was charged. Ask an admin to add credits.",
} as const;

export type AiState = {
  ai_status: "on" | "signed_out" | "no_credits" | "disabled" | "expired";
  ai_status_reason: string;
  /** For admins, the command that fixes it, or "". */
  fix_command: string;
  /** False only once the first-run storage check found this plan can't keep video, music or speech files. */
  plan_paid_storage: boolean;
  storage_checked: boolean;
  /** How made files are kept: "signed", "table", or "" until the first one says. */
  file_mode: string;
  /** Who Xano AI bills here, when the deploy said: "user" (whoever signed in) or "instance". */
  billing: string;
};

export const aiStateFn = defineFunction({
  name: "studio/ai_state",
  description: "Whether AI can run here now and why not, in words for this person, and what the plan lets this workspace keep.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    settingsRow("settings"),
    guard.found("settings", { message: "The workspace has no settings row." }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    s.set_var("status", ref("settings.ai_status")),
    s.set_var("reason", withFilters(ref("settings.ai_status_reason"), fl.first_notnull(c.text("")))),
    s.set_var("reported", c.obj({})),
    s.try_catch({ try: [s.update_var("reported", withFilters(env(AI_DEPLOY_ENV), fl.json_decode(), fl.first_notnull(c.obj({}))))], catch: [] }),
    s.conditional({ when: expr(withFilters(ref("reported"), fl.is_object()), "!=", c.bool(true)), then: [s.update_var("reported", c.obj({}))] }),
    s.set_var("deploy_status", withFilters(ref("reported"), fl.get("status", ""), fl.first_notnull(c.text("")), fl.to_text())),
    s.set_var("expires_ms", withFilters(ref("reported"), fl.get("expires_ms", 0), fl.first_notnull(c.int(0)), fl.to_int())),
    s.conditional({
      when: expr(ref("deploy_status"), "=", c.text("off")),
      then: [
        s.update_var("status", c.text("signed_out")),
        s.update_var("reason", c.text(AI_STATE_WORDS.signed_out)),
        s.conditional({ when: expr(withFilters(ref("reported"), fl.get("reason", ""), fl.first_notnull(c.text(""))), "=", c.text("restart-to-enable")), then: [s.update_var("reason", c.text(AI_STATE_WORDS.restart))] }),
      ],
      elif: [{ when: [expr(ref("expires_ms"), ">", c.int(0)), expr(c.now(), ">", ref("expires_ms"))], then: [
        s.update_var("status", c.text("expired")),
        s.update_var("reason", c.text(AI_STATE_WORDS.expired)),
      ] }],
    }),
    s.set_var("is_admin", c.bool(false)),
    s.conditional({ when: cond.in(ref("actor.role"), c.array(rbac.rolesWith("team.manage"))), then: [s.update_var("is_admin", c.bool(true))] }),
    s.set_var("fix", c.text("")),
    s.conditional({
      when: expr(ref("is_admin"), "=", c.bool(true)),
      then: [
        s.conditional({ when: cond.in(ref("status"), c.array(["signed_out", "expired"])), then: [s.update_var("fix", c.text(SIGN_IN_COMMAND))] }),
        s.conditional({ when: expr(ref("reason"), "=", c.text(AI_STATE_WORDS.restart)), then: [s.update_var("fix", c.text(RESTART_COMMAND))] }),
      ],
      else: [s.conditional({ when: expr(ref("status"), "!=", c.text("on")), then: [
        s.update_var("reason", c.text(AI_STATE_WORDS.member)),
        s.conditional({ when: expr(ref("status"), "=", c.text("no_credits")), then: [s.update_var("reason", c.text(AI_STATE_WORDS.member_credits))] }),
      ] })],
    }),
    s.set_var("paid", c.bool(true)),
    s.conditional({ when: [expr(ref("settings.storage_checked"), "=", c.bool(true)), expr(ref("settings.plan_paid_storage"), "=", c.bool(false))], then: [s.update_var("paid", c.bool(false))] }),
  ],
  response: {
    ai_status: ref("status"), ai_status_reason: ref("reason"), fix_command: ref("fix"),
    plan_paid_storage: ref("paid"), storage_checked: withFilters(ref("settings.storage_checked"), fl.first_notnull(c.bool(false))),
    file_mode: withFilters(ref("settings.file_mode"), fl.first_notnull(c.text(""))),
    billing: withFilters(ref("reported"), fl.get("billing", ""), fl.first_notnull(c.text("")), fl.to_text()),
  },
  responseShape: {} as AiState,
});
