// Home: what's running, what's waiting, how much of the month is spent, and what the team uses most. One read, shaped by
// role: an admin sees the team's spend, a member their own, and a guest only the library and Knowledge. Nothing here
// makes a month row: a person who hasn't run anything this month reads the Settings budget with nothing spent. Whoever
// may approve library items also gets the oldest drafts still waiting for someone to approve them.
import { and, c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, or, qf, ref, s, withFilters } from "@xano/sdk";
import { agent } from "../../agent.js";
import { activity } from "../../base/index.js";
import { rbac } from "../../rbac.js";
import { ai_run } from "../../table/studio/ai_run.js";
import { ai_step } from "../../table/studio/ai_step.js";
import { budget_month } from "../../table/studio/budget_month.js";
import { asset } from "../../table/library/asset.js";
import { kb_source } from "../../table/knowledge/kb_source.js";
import { ledger } from "../../table/studio/ledger.js";
import { recipe } from "../../table/recipes/recipe.js";
import { user } from "../../table/user.js";
import { settingsRow, thisMonth } from "../spend/begin.js";
import { aiStateFn } from "./ai_state.js";
import { mediaLinkFn } from "../library/media.js";

const DAY = 86_400_000;
/** Runs a person starts and watches: an Ask answers inside its request, and an upload shows as its source. */
const WATCHED = ["playground", "recipe"];
const GOING = ["starting", "queued", "running"];
/** The most rows each list on Home shows. */
const SHOWN = 8;
/** The agent activity card's rows. */
const AGENT_ROWS = 4;
/** The oldest drafts "Waiting on you" lists. */
const OLDEST_DRAFTS = 3;
/** How long a picture's link on Home lasts, in seconds; Home reloads on every change, so a minute is plenty. */
const THUMB_SECONDS = 60;

type Money = { budget: number; reserved: number; spent: number };
export type HomeRun = { id: number; title: string; kind: string; status: string; reason: string; owner_id: number; estimate: number; private: boolean; created_at: number };
export type HomeStep = { run_id: number; seq: number; kind: string; label: string; status: string; claimed_at: number | null };
/** Something Easel or a connected agent did for a person: the activity feed's row with its agent's name in `via`. */
export type HomeAgentAct = { id: number; actor_id: number; actor_name: string; via: string; title: string; link: string; created_at: number };
export type HomeSource = { id: number; title: string; kind: string; duration_s: number; added_by: number; created_at: number };
/**
 * A draft waiting for someone to approve it: what it is, who made it (and the agent that made it for them, "Easel" or a key's
 * name, or empty), when, and a picture's one-minute link or its table-kept bytes' id (library/media.ts).
 */
export type HomeDraft = { id: number; kind: string; title: string; maker_id: number; maker_name: string; agent: string; created_at: number; thumb: string; thumb_blob: number };
export type HomeView = {
  role: string; can_run: boolean; sees_team: boolean; month: string; month_words: string;
  ai_status: string; ai_status_reason: string; fix_command: string;
  plan_paid_storage: boolean; storage_checked: boolean; billing: string;
  team: Money | null; mine: Money;
  runs_week: number; runs_last_week: number;
  /**
   * What was charged on each of the last seven days (UTC days since 1970, as Usage counts days), the team's for those who read
   * usage and this person's own otherwise. Days with nothing charged aren't listed.
   */
  spend_days: { day: number; amount: number }[];
  assets: number; approved: number;
  sources: number; failed_sources: number; recordings: number; recording_seconds: number;
  running: HomeRun[]; waiting: HomeRun[]; steps: HomeStep[]; ingesting: HomeSource[];
  /** The oldest drafts no one has approved yet, oldest first, for whoever may approve them; empty for anyone else. */
  oldest_drafts: HomeDraft[];
  people: { id: number; name: string }[];
  recipes: { id: number; slug: string; name: string; description: string; lead_kind: string; step_count: number }[];
  recipe_runs: { recipe_id: number; runs: number }[];
  recipe_count: number;
  /** The latest things Easel and connected agents did, and whether this person has connected an agent of their own. */
  agent_activity: HomeAgentAct[]; agent_keys: number;
  /** What this person has tried, for the first-run checklist. */
  started: { playground: boolean; recipe: boolean; ask: boolean };
};

/** A month row's money, or the Settings budget with nothing used when the row isn't there yet. */
const money = (as: string, row: string, budget: string) =>
  s.set_var(as, obj({
    budget: withFilters(ref(`${row}.budget`, { safe: true }), fl.first_notnull(ref(budget))),
    reserved: withFilters(ref(`${row}.reserved`, { safe: true }), fl.first_notnull(c.int(0))),
    spent: withFilters(ref(`${row}.spent`, { safe: true }), fl.first_notnull(c.int(0))),
  }));

export const homeFn = defineFunction({
  name: "studio/home",
  description: "Home for one person: spend against the month's budget, runs this week, the library and Knowledge, what's running and waiting, and the most-run recipes.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    settingsRow("settings"),
    guard.found("settings", { message: "The workspace has no settings row." }),
    s.function.run({ fn: aiStateFn, as: "ai", input: { actor_id: inp("actor_id") } }),
    ...thisMonth(),
    s.set_var("can_run", c.bool(false)),
    s.conditional({ when: rbac.has(ref("actor.role"), "studio.run"), then: [s.update_var("can_run", c.bool(true))] }),
    s.set_var("sees_team", c.bool(false)),
    s.conditional({ when: rbac.has(ref("actor.role"), "usage.read"), then: [s.update_var("sees_team", c.bool(true))] }),

    // Money: everyone sees their own month; only those who read usage see the team's.
    s.db.query({ table: budget_month, returnType: "single", as: "mine_row",
      where: [cmp(col("scope"), "=", c.text("person")), cmp(col("subject_id"), "=", inp("actor_id")), cmp(col("month"), "=", ref("month"))] }),
    money("mine", "mine_row", "settings.person_budget"),
    s.set_var("team", c.null()),
    s.conditional({ when: expr(ref("sees_team"), "=", c.bool(true)), then: [
      s.db.query({ table: budget_month, returnType: "single", as: "team_row",
        where: [cmp(col("scope"), "=", c.text("team")), cmp(col("subject_id"), "=", c.int(0)), cmp(col("month"), "=", ref("month"))] }),
      money("team_money", "team_row", "settings.team_budget"),
      s.update_var("team", ref("team_money")),
    ] }),

    // The library and Knowledge: what this person may see of them.
    s.set_var("states", c.array(["draft", "approved"])),
    s.conditional({ when: expr(ref("can_run"), "=", c.bool(false)), then: [s.update_var("states", c.array(["approved"]))] }),
    s.db.query({ table: asset, where: [cmp(col("private"), "=", c.bool(false)), cmp(col("status"), "in", ref("states"))], returnType: "count", as: "assets" }),
    s.db.query({ table: asset, where: [cmp(col("private"), "=", c.bool(false)), cmp(col("status"), "=", c.text("approved"))], returnType: "count", as: "approved" }),
    // Every source, failed ones too: the card says how many need attention rather than leaving them out.
    s.db.query({ table: kb_source, returnType: "count", as: "sources" }),
    s.db.query({ table: kb_source, where: cmp(col("status"), "=", c.text("failed")), returnType: "count", as: "failed_sources" }),
    s.db.query({ table: kb_source, where: [cmp(col("status"), "=", c.text("ready")), cmp(col("kind"), "=", c.text("recording"))], output: ["duration_s"],
      paging: { per_page: 5000, metadata: false }, as: "recording_rows" }),
    s.array.map({ source: ref("recording_rows"), as: "recording_lengths", transform: ref("$this.duration_s") }),

    // The last seven days of charges, by UTC day: Home draws them under the month's spend.
    s.set_var("spend_since", withFilters(c.now(), fl.sub(7 * DAY))),
    s.conditional({
      when: expr(ref("sees_team"), "=", c.bool(true)),
      then: [s.db.query({ table: ledger, as: "spend_days", returnType: "aggregate",
        where: [cmp(col("state"), "=", c.text("settled")), cmp(col("created_at"), ">=", ref("spend_since"))],
        aggregate: { group: [{ name: "created_at", as: "day", filters: [qf.epochms_epoch_day()] }], eval: [{ name: "amount", as: "amount", filters: [qf.sum()] }] } })],
      else: [s.db.query({ table: ledger, as: "spend_days", returnType: "aggregate",
        where: [cmp(col("state"), "=", c.text("settled")), cmp(col("owner_id"), "=", inp("actor_id")), cmp(col("created_at"), ">=", ref("spend_since"))],
        aggregate: { group: [{ name: "created_at", as: "day", filters: [qf.epochms_epoch_day()] }], eval: [{ name: "amount", as: "amount", filters: [qf.sum()] }] } })],
    }),

    s.set_var("runs_week", c.int(0)),
    s.set_var("runs_last_week", c.int(0)),
    s.set_var("running", c.array([])),
    s.set_var("waiting", c.array([])),
    s.set_var("steps", c.array([])),
    s.set_var("ingesting", c.array([])),
    s.set_var("recipes", c.array([])),
    s.set_var("recipe_runs", c.array([])),
    s.set_var("recipe_count", c.int(0)),
    s.set_var("owner_ids", c.array([-1])),
    s.set_var("agent_activity", c.array([])),
    s.set_var("agent_keys", c.int(0)),
    s.set_var("oldest_drafts", c.array([])),
    // What waits on this person: the oldest drafts in the shared library, for anyone who may approve them.
    s.conditional({ when: rbac.has(ref("actor.role"), "library.approve"), then: [
      s.db.query({ table: asset, as: "draft_rows",
        where: [cmp(col("private"), "=", c.bool(false)), cmp(col("status"), "=", c.text("draft"))],
        bind: [
          { table: user, as: "maker", join: "left", where: expr(col("maker_id"), "=", col("maker.id")) },
          { table: ai_run, as: "made_by", join: "left", where: expr(col("run_id"), "=", col("made_by.id")) },
        ],
        eval: [{ name: "maker.name", as: "maker_name" }, { name: "made_by.via", as: "via" }, { name: "made_by.connection_id", as: "connection_id" }],
        sort: [{ sortBy: "created_at", dir: "asc" }, { sortBy: "id", dir: "asc" }], paging: { per_page: OLDEST_DRAFTS, metadata: false } }),
      s.foreach({ list: ref("draft_rows"), as: "draft", body: [
        // Made for its maker by an agent: Easel, or the name of the key or connection that ran it.
        s.set_var("draft_agent", c.text("")),
        s.set_var("draft_via", withFilters(ref("draft.via", { safe: true }), fl.first_notnull(c.text("")))),
        s.conditional({ when: expr(ref("draft_via"), "=", c.text("easel")), then: [s.update_var("draft_agent", c.text("Easel"))] }),
        s.conditional({ when: or(expr(ref("draft_via"), "=", c.text("api")), expr(ref("draft_via"), "=", c.text("mcp"))), then: [
          s.update_var("draft_agent", c.text("An agent")),
          s.conditional({ when: expr(withFilters(ref("draft.connection_id", { safe: true }), fl.first_notnull(c.int(0))), ">", c.int(0)), then: [
            s.db.get({ table: agent.agent_connection, fieldValue: ref("draft.connection_id"), output: ["name"], as: "draft_key" }),
            s.update_var("draft_agent", withFilters(ref("draft_key.name", { safe: true }), fl.first_notempty(c.text("An agent")))),
          ] }),
        ] }),
        s.set_var("draft_thumb", c.text("")),
        s.set_var("draft_blob", c.int(0)),
        s.conditional({ when: expr(ref("draft.kind"), "=", c.text("image")), then: [
          s.function.run({ fn: mediaLinkFn, as: "draft_link", input: { file: ref("draft.file"), ttl: c.int(THUMB_SECONDS) } }),
          s.update_var("draft_thumb", ref("draft_link.url")),
          s.update_var("draft_blob", ref("draft_link.blob_id")),
        ] }),
        s.update_var("oldest_drafts", withFilters(ref("oldest_drafts"), fl.array_push(obj({
          id: ref("draft.id"), kind: ref("draft.kind"), title: ref("draft.title"), maker_id: ref("draft.maker_id"),
          maker_name: withFilters(ref("draft.maker_name", { safe: true }), fl.first_notnull(c.text(""))), agent: ref("draft_agent"),
          created_at: ref("draft.created_at"), thumb: ref("draft_thumb"), thumb_blob: ref("draft_blob"),
        })))),
      ] }),
    ] }),
    // A guest doesn't run anything, so Home shows them the library and Knowledge only.
    s.conditional({ when: expr(ref("can_run"), "=", c.bool(true)), then: [
      s.set_var("week_ago", withFilters(c.now(), fl.sub(7 * DAY))),
      s.set_var("two_weeks_ago", withFilters(c.now(), fl.sub(14 * DAY))),
      s.db.query({ table: ai_run, where: [cmp(col("created_at"), ">=", ref("week_ago")), cmp(col("kind"), "!=", c.text("check"))], returnType: "count", as: "this_week" }),
      s.db.query({ table: ai_run, where: [cmp(col("created_at"), ">=", ref("two_weeks_ago")), cmp(col("created_at"), "<", ref("week_ago")), cmp(col("kind"), "!=", c.text("check"))],
        returnType: "count", as: "last_week" }),
      s.update_var("runs_week", ref("this_week")),
      s.update_var("runs_last_week", ref("last_week")),

      // Running: the team's runs, and this person's own private ones.
      s.db.query({ table: ai_run, as: "running_rows",
        where: [cmp(col("status"), "in", c.array(GOING)), cmp(col("kind"), "in", c.array(WATCHED)), or(expr(col("private"), "=", c.bool(false)), expr(col("owner_id"), "=", inp("actor_id")))],
        sort: [{ sortBy: "created_at", dir: "desc" }], paging: { per_page: SHOWN, metadata: false },
        output: ["id", "title", "kind", "status", "reason", "owner_id", "estimate", "private", "created_at"] }),
      s.update_var("running", ref("running_rows")),
      // Waiting on a person: every approval for an admin; a member's own approvals and confirmations.
      s.conditional({
        when: expr(ref("sees_team"), "=", c.bool(true)),
        then: [s.db.query({ table: ai_run, as: "waiting_rows",
          where: or(cmp(col("status"), "=", c.text("waiting_approval")), and(cmp(col("status"), "in", c.array(["needs_confirmation", "waiting_confirmation"])), cmp(col("owner_id"), "=", inp("actor_id")))),
          sort: [{ sortBy: "created_at", dir: "asc" }], paging: { per_page: SHOWN, metadata: false },
          output: ["id", "title", "kind", "status", "reason", "owner_id", "estimate", "private", "created_at"] })],
        else: [s.db.query({ table: ai_run, as: "waiting_rows",
          where: [cmp(col("owner_id"), "=", inp("actor_id")), cmp(col("status"), "in", c.array(["waiting_approval", "needs_confirmation", "waiting_confirmation"]))],
          sort: [{ sortBy: "created_at", dir: "asc" }], paging: { per_page: SHOWN, metadata: false },
          output: ["id", "title", "kind", "status", "reason", "owner_id", "estimate", "private", "created_at"] })],
      }),
      s.update_var("waiting", ref("waiting_rows")),
      s.array.map({ source: ref("running_rows"), as: "running_ids", transform: ref("$this.id") }),
      // Lists are padded with -1 here, before the query: an empty `in` list matches nothing, and filters in a where run as SQL.
      s.set_var("step_run_ids", withFilters(ref("running_ids"), fl.array_push(c.int(-1)))),
      s.db.query({ table: ai_step, where: cmp(col("run_id"), "in", ref("step_run_ids")), as: "step_rows",
        sort: [{ sortBy: "seq", dir: "asc" }], paging: { per_page: 500, metadata: false }, output: ["run_id", "seq", "kind", "label", "status", "claimed_at"] }),
      s.update_var("steps", ref("step_rows")),
      s.db.query({ table: kb_source, where: cmp(col("status"), "=", c.text("processing")), as: "ingesting_rows",
        sort: [{ sortBy: "created_at", dir: "desc" }], paging: { per_page: SHOWN, metadata: false }, output: ["id", "title", "kind", "duration_s", "added_by", "created_at"] }),
      s.update_var("ingesting", ref("ingesting_rows")),

      // The most-run published recipes.
      s.db.query({ table: recipe, where: cmp(col("status"), "=", c.text("published")), returnType: "count", as: "published" }),
      s.update_var("recipe_count", ref("published")),
      s.db.query({ table: ai_run, where: [cmp(col("kind"), "=", c.text("recipe")), cmp(col("recipe_id"), ">", c.int(0))], returnType: "aggregate", as: "counted",
        aggregate: { group: [{ name: "recipe_id", as: "recipe_id" }], eval: [{ name: "id", as: "runs", filters: [qf.count()] }] } }),
      s.array.map({ source: ref("counted"), as: "counted_ids", transform: ref("$this.recipe_id") }),
      s.set_var("run_recipe_ids", withFilters(ref("counted_ids"), fl.array_push(c.int(-1)))),
      s.db.query({ table: recipe, where: [cmp(col("status"), "=", c.text("published")), cmp(col("id"), "in", ref("run_recipe_ids"))], as: "run_recipes",
        paging: { per_page: 500, metadata: false }, output: ["id", "slug", "name", "description", "lead_kind", "step_count"] }),
      s.update_var("recipes", ref("run_recipes")),
      s.update_var("recipe_runs", ref("counted")),

      s.array.map({ source: ref("running_rows"), as: "running_owners", transform: ref("$this.owner_id") }),
      s.array.map({ source: ref("waiting_rows"), as: "waiting_owners", transform: ref("$this.owner_id") }),
      s.array.map({ source: ref("ingesting_rows"), as: "ingesting_owners", transform: ref("$this.added_by") }),
      // What agents did: the activity rows an agent wrote, shared with everyone or with this person.
      s.db.query({ table: activity, as: "agent_rows",
        where: [cmp(col("via"), "!=", c.text("")), or(expr(col("private_to"), "=", c.int(0)), expr(col("private_to"), "=", inp("actor_id")), expr(col("actor_id"), "=", inp("actor_id")))],
        sort: [{ sortBy: "created_at", dir: "desc" }], paging: { per_page: AGENT_ROWS, metadata: false },
        output: ["id", "actor_id", "actor_name", "via", "title", "link", "created_at"] }),
      s.update_var("agent_activity", ref("agent_rows")),
      s.db.query({ table: agent.agent_connection, as: "own_keys", returnType: "count",
        where: [cmp(col("user_id"), "=", inp("actor_id")), cmp(col("kind"), "!=", c.text("sign-in")), cmp(col("revoked"), "!=", c.bool(true))] }),
      s.update_var("agent_keys", ref("own_keys")),
      s.update_var("owner_ids", withFilters(ref("running_owners"), fl.array_merge(ref("waiting_owners")), fl.array_merge(ref("ingesting_owners")), fl.array_push(c.int(-1)), fl.unique())),
    ] }),
    // What this person tried themselves: the demo world's seeded runs don't tick the first-run checklist.
    s.db.query({ table: ai_run, where: [cmp(col("owner_id"), "=", inp("actor_id")), cmp(col("kind"), "=", c.text("playground")), cmp(col("is_demo"), "!=", c.bool(true))], returnType: "exists", as: "tried_playground" }),
    s.db.query({ table: ai_run, where: [cmp(col("owner_id"), "=", inp("actor_id")), cmp(col("kind"), "=", c.text("recipe")), cmp(col("is_demo"), "!=", c.bool(true))], returnType: "exists", as: "tried_recipe" }),
    s.db.query({ table: ai_run, where: [cmp(col("owner_id"), "=", inp("actor_id")), cmp(col("kind"), "=", c.text("ask")), cmp(col("is_demo"), "!=", c.bool(true))], returnType: "exists", as: "tried_ask" }),
    s.db.query({ table: user, where: cmp(col("id"), "in", ref("owner_ids")), output: ["id", "name"], paging: { per_page: 100, metadata: false }, as: "people" }),
  ],
  response: {
    role: ref("actor.role"), can_run: ref("can_run"), sees_team: ref("sees_team"), month: ref("month"), month_words: ref("month_words"),
    ai_status: ref("ai.ai_status"), ai_status_reason: ref("ai.ai_status_reason"), fix_command: ref("ai.fix_command"),
    plan_paid_storage: ref("ai.plan_paid_storage"), storage_checked: ref("ai.storage_checked"), billing: ref("ai.billing"),
    team: ref("team"), mine: ref("mine"),
    runs_week: ref("runs_week"), runs_last_week: ref("runs_last_week"), spend_days: ref("spend_days"),
    assets: ref("assets"), approved: ref("approved"),
    sources: ref("sources"), failed_sources: ref("failed_sources"), recordings: withFilters(ref("recording_lengths"), fl.count()), recording_seconds: withFilters(ref("recording_lengths"), fl.sum()),
    running: ref("running"), waiting: ref("waiting"), steps: ref("steps"), ingesting: ref("ingesting"), people: ref("people"),
    oldest_drafts: ref("oldest_drafts"),
    recipes: ref("recipes"), recipe_runs: ref("recipe_runs"), recipe_count: ref("recipe_count"),
    agent_activity: ref("agent_activity"), agent_keys: ref("agent_keys"),
    started: { playground: ref("tried_playground"), recipe: ref("tried_recipe"), ask: ref("tried_ask") },
  },
  responseShape: {} as HomeView,
});
