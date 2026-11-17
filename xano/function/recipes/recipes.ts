// Recipes: saving one, reading one or the list, estimating it, and starting a run of it. Each takes the person's id, so
// the app's routes, the recipe API and (later) agents share one rule: the spend gate, the roles and the model check
// apply the same way whoever asks.
import { c, cmp, col, cond, defineFunction, expr, fl, guard, inp, input, obj, or, qf, ref, s, withFilters } from "@xano/sdk";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { LEAD_ORDER, recipe, RECIPE_STATES } from "../../table/recipes/recipe.js";
import { recipe_step } from "../../table/recipes/recipe_step.js";
import { ai_run, RUN_VIAS } from "../../table/studio/ai_run.js";
import { asset } from "../../table/library/asset.js";
import { user } from "../../table/user.js";
import { checkModelsFn, modelStateFn } from "../studio/catalog.js";
import { estimateFn } from "../spend/estimate.js";
import { startRunFn } from "../runs/start.js";
import { firstError, planFn, type Plan, type PlanError, type RunStep } from "./plan.js";

export const NO_SUCH_RECIPE = "No such recipe.";
const NOT_FOUND = { errorType: "notfound", message: NO_SUCH_RECIPE } as const;
export const NOT_PUBLISHED = "This recipe is a draft. Publish it before running it from outside the app.";
export const RETIRED_WORDS = "uses a model Xano AI no longer offers";
const LONGEST_NAME = 80;
/** The fields a screen reads about a recipe. */
const RECIPE_FIELDS = ["id", "slug", "name", "description", "status", "inputs", "estimate", "step_count", "lead_kind", "created_by", "updated_by", "updated_at", "created_at"] as const;
const STEP_FIELDS = ["id", "seq", "name", "kind", "model", "prompt", "file", "settings", "options", "depends_on"] as const;

export type RecipeInput = { name: string; label: string; type: "text" | "long_text" | "image" | "audio" | "file" | "knowledge"; required: boolean; hint?: string };
export type RecipeStepView = { id: number; seq: number; name: string; kind: string; model: string; prompt: string; file: string; settings: Record<string, unknown>; options: Record<string, unknown>; depends_on: number[] };
export type Retired = { seq: number; kind: string; model: string; allowed: string[] };
export type RecipeView = {
  id: number; slug: string; name: string; description: string; status: "draft" | "published"; inputs: RecipeInput[]; estimate: number;
  step_count: number; lead_kind: string; created_by: number; updated_by: number; updated_at: number | null; created_at: number;
};

/** One of a recipe's runs, as the recipe's page shows it. */
export type RecipeRunBrief = { id: number; title: string; status: string; owner_id: number; created_at: number };
/**
 * What a recipe's page opens on: how often it has run and how the latest run stands; the inputs this person gave it last,
 * or the team's latest when they haven't run it (to fill the form with, saying whose they were); and the newest run that
 * made something, with the library items it made.
 */
export type RecipeHistory = {
  runs: number; latest: RecipeRunBrief | null;
  last_inputs: { name: string; value: string }[]; last_inputs_by: number;
  made_run: RecipeRunBrief | null; made_ids: number[];
};
const BRIEF = ["id", "title", "status", "owner_id", "created_at"] as const;
/** Finished well enough to have made something. */
const MADE_STATES = ["done", "partial"];

/** Binds `actor`, and refuses anyone whose role can't run AI (guests). */
const runner = (message = "Your role can't use recipes. Ask an admin for access.") => [
  s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "name", "role"], as: "actor" }),
  guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
  rbac.allows(ref("actor.role"), "studio.run", message),
];

/**
 * What a run with these steps is estimated to cost: each step priced at its caps, summed. Binds `priced_steps`
 * ([{ seq, label, kind, model, amount, priced, detail }]), `total` and `unpriced` (the first missing price's words).
 */
const priceSteps = (steps: string) => [
  s.set_var("priced_steps", c.array([])),
  s.set_var("total", c.int(0)),
  s.set_var("unpriced", c.text("")),
  s.foreach({ list: withFilters(ref(steps), fl.safe_array()), as: "to_price", body: [
    s.function.run({ fn: estimateFn, as: "one_price", input: { kind: ref("to_price.kind"), model: ref("to_price.model"), options: withFilters(ref("to_price.options"), fl.first_notnull(c.obj({}))) } }),
    s.update_var("total", withFilters(ref("total"), fl.add(ref("one_price.amount")))),
    s.conditional({ when: [expr(ref("one_price.priced"), "=", c.bool(false)), expr(ref("unpriced"), "=", c.text(""))], then: [s.update_var("unpriced", ref("one_price.detail"))] }),
    s.array.push({ name: "priced_steps", value: obj({
      seq: withFilters(ref("priced_steps"), fl.count(), fl.add(1)), recipe_seq: withFilters(ref("to_price"), fl.get("recipe_seq", 0), fl.first_notnull(c.int(0))),
      label: ref("to_price.label"), kind: ref("to_price.kind"), model: ref("to_price.model"),
      amount: ref("one_price.amount"), priced: ref("one_price.priced"), detail: ref("one_price.detail"),
    }) }),
  ] }),
];

/** The plan's run steps for an estimate (every input at its longest), priced. */
export const estimateRecipeFn = defineFunction({
  name: "recipes/estimate",
  description: "What a run of these steps is estimated to cost, step by step, with every input at its longest. Writes nothing.",
  input: { inputs: input.json(), steps: input.json() },
  stack: [
    s.function.run({ fn: planFn, as: "plan", input: { inputs: inp("inputs"), steps: inp("steps"), values: c.null(), files_given: c.array([]), build: c.bool(true) } }),
    s.set_var("run_steps", withFilters(ref("plan.run_steps", { safe: true }), fl.safe_array())),
    ...priceSteps("run_steps"),
  ],
  response: { ok: ref("plan.ok"), errors: ref("plan.errors"), steps: ref("priced_steps"), total: ref("total"), unpriced: ref("unpriced") },
  responseShape: {} as { ok: boolean; errors: PlanError[]; steps: { seq: number; recipe_seq: number; label: string; kind: string; model: string; amount: number; priced: boolean; detail: string }[]; total: number; unpriced: string },
});

/**
 * Create a recipe (`recipe_id` 0) or replace one's inputs and steps. Refused, with the first problem in words, when a
 * reference doesn't resolve or names a later step, or a model isn't one Xano AI offers.
 */
export const saveRecipeFn = defineFunction({
  name: "recipes/save",
  description: "Create or update a recipe: its name, description, state, input form and steps. Checks references and models first.",
  input: {
    actor_id: input.int({ required: true }), recipe_id: input.int(),
    name: input.text(), description: input.text(), status: input.enum(RECIPE_STATES), inputs: input.json(), steps: input.json(),
  },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "name", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("actor.role"), "recipes.manage", "Your role can't make or change recipes. Ask an admin for access."),
    s.set_var("name", withFilters(inp("name"), fl.first_notnull(c.text("")), fl.trim())),
    guard.require(expr(ref("name"), "!=", c.text("")), { errorType: "badrequest", message: "Give the recipe a name." }),
    guard.require(expr(withFilters(ref("name"), fl.strlen()), "<=", c.int(LONGEST_NAME)), { errorType: "badrequest", message: `Keep the name under ${LONGEST_NAME} characters.` }),
    s.set_var("inputs", withFilters(inp("inputs"), fl.safe_array())),
    s.set_var("steps", withFilters(inp("steps"), fl.safe_array())),
    s.function.run({ fn: planFn, as: "plan", input: { inputs: ref("inputs"), steps: ref("steps"), values: c.null(), files_given: c.array([]), build: c.bool(true) } }),
    ...firstError("plan", "problem"),
    s.precondition({ expr: expr(ref("plan.ok"), "=", c.bool(true)), error_type: "badrequest", error: ref("problem") }),
    // The same model check every run gets: a model the catalog doesn't offer for that kind can't be saved.
    s.function.run({ fn: checkModelsFn, as: "models_ok", input: { steps: ref("steps") } }),
    s.set_var("run_steps", withFilters(ref("plan.run_steps", { safe: true }), fl.safe_array())),
    ...priceSteps("run_steps"),
    s.set_var("status", withFilters(inp("status"), fl.first_notempty(c.text("draft")))),
    // The kind it's shown as: the most defining one it has (LEAD_ORDER), not just its first step's.
    s.array.map({ source: ref("steps"), as: "step_kinds", transform: ref("$this.kind") }),
    s.array.find({ expr: c.array([...LEAD_ORDER]), as: "defining", if: cond.in(ref("$this"), ref("step_kinds")) }),
    s.set_var("lead", withFilters(ref("defining"), fl.first_notempty(withFilters(ref("step_kinds"), fl.first(), fl.first_notnull(c.text("")))))),
    s.set_var("recipe_id", withFilters(inp("recipe_id"), fl.first_notnull(c.int(0)))),
    s.set_var("verb", c.text("updated")),
    s.conditional({
      when: expr(ref("recipe_id"), ">", c.int(0)),
      then: [
        s.db.get({ table: recipe, fieldValue: ref("recipe_id"), output: ["id", "status"], as: "was" }),
        guard.found("was", NOT_FOUND),
        s.conditional({ when: [expr(ref("was.status"), "=", c.text("draft")), expr(ref("status"), "=", c.text("published"))], then: [s.update_var("verb", c.text("published"))] }),
        s.db.patch({ table: recipe, fieldValue: ref("recipe_id"), data: obj({
          name: ref("name"), description: withFilters(inp("description"), fl.first_notnull(c.text("")), fl.trim()), status: ref("status"), inputs: ref("inputs"),
          estimate: ref("total"), step_count: withFilters(ref("steps"), fl.count()), lead_kind: ref("lead"), updated_by: inp("actor_id"), updated_at: c.now(),
        }) }),
        s.db.bulk.delete({ table: recipe_step, where: cmp(col("recipe_id"), "=", ref("recipe_id")) }),
      ],
      else: [
        // The address it's called at: its name in lower case with dashes, and a number after it when that's taken.
        s.set_var("base_slug", withFilters(c.regex(/[^a-z0-9]+/), fl.regex_replace(c.text("-"), withFilters(ref("name"), fl.lower(), fl.strip_accents())))),
        s.update_var("base_slug", withFilters(c.regex(/^-+|-+$/), fl.regex_replace(c.text(""), ref("base_slug")), fl.substr(0, 60))),
        s.conditional({ when: expr(ref("base_slug"), "=", c.text("")), then: [s.update_var("base_slug", c.text("recipe"))] }),
        s.set_var("slug", ref("base_slug")),
        s.set_var("tries", c.int(1)),
        s.db.query({ table: recipe, where: cmp(col("slug"), "=", ref("slug")), returnType: "exists", as: "taken" }),
        s.while({ when: [expr(ref("taken"), "=", c.bool(true)), expr(ref("tries"), "<", c.int(50))], body: [
          s.update_var("tries", withFilters(ref("tries"), fl.add(1))),
          s.update_var("slug", withFilters(ref("base_slug"), fl.concat(c.text("-")), fl.concat(ref("tries")))),
          s.db.query({ table: recipe, where: cmp(col("slug"), "=", ref("slug")), returnType: "exists", as: "taken" }),
        ] }),
        s.db.add({ table: recipe, as: "made", row: {
          slug: ref("slug"), name: ref("name"), description: withFilters(inp("description"), fl.first_notnull(c.text("")), fl.trim()), status: ref("status"),
          inputs: ref("inputs"), estimate: ref("total"), step_count: withFilters(ref("steps"), fl.count()), lead_kind: ref("lead"),
          created_by: inp("actor_id"), updated_by: inp("actor_id"), updated_at: c.now(), is_demo: c.bool(false),
        } }),
        s.update_var("recipe_id", ref("made.id")),
        s.update_var("verb", c.text("created")),
      ],
    }),
    s.set_var("rows", c.array([])),
    s.set_var("at", c.int(0)),
    s.foreach({ list: ref("steps"), as: "one", body: [
      s.set_var("planned", withFilters(ref("plan.steps"), fl.get(withFilters(ref("at"), fl.to_text()), c.obj({})))),
      s.update_var("at", withFilters(ref("at"), fl.add(1))),
      s.array.push({ name: "rows", value: obj({
        recipe_id: ref("recipe_id"), seq: ref("at"),
        name: withFilters(ref("one"), fl.get("name", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.trim()),
        kind: withFilters(ref("one"), fl.get("kind", "")), model: withFilters(ref("one"), fl.get("model", "")),
        prompt: withFilters(ref("one"), fl.get("prompt", ""), fl.first_notnull(c.text("")), fl.to_text()),
        file: withFilters(ref("one"), fl.get("file", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.trim()),
        settings: withFilters(ref("one"), fl.get("settings", c.obj({})), fl.first_notnull(c.obj({}))),
        options: withFilters(ref("one"), fl.get("options", c.obj({})), fl.first_notnull(c.obj({}))),
        depends_on: withFilters(ref("planned"), fl.get("depends_on", c.array([])), fl.safe_array()),
      }) }),
    ] }),
    s.db.bulk.add({ table: recipe_step, items: ref("rows"), as: "made_steps" }),
    changed({ entity: "recipe", id: ref("recipe_id"), op: "updated", verb: ref("verb"), actor: inp("actor_id"),
      title: withFilters(ref("verb"), fl.concat(c.text(" the recipe ")), fl.concat(ref("name"))), link: c.text("/recipes") }),
    s.db.get({ table: recipe, fieldValue: ref("recipe_id"), output: [...RECIPE_FIELDS], as: "saved" }),
  ],
  response: ref("saved"),
  responseShape: {} as RecipeView,
});

/** One recipe with its steps, which of them use a retired model (and what to use instead), and whether this person may change it. */
export const viewRecipeFn = defineFunction({
  name: "recipes/view",
  description: "A recipe, its steps, its retired-model state and whether the reader may edit it. Found by slug or id.",
  input: { actor_id: input.int({ required: true }), slug: input.text(), recipe_id: input.int() },
  stack: [
    ...runner(),
    s.set_var("by_id", withFilters(inp("recipe_id"), fl.first_notnull(c.int(0)), fl.to_int())),
    s.conditional({
      when: expr(ref("by_id"), ">", c.int(0)),
      then: [s.db.get({ table: recipe, fieldValue: inp("recipe_id"), output: [...RECIPE_FIELDS], as: "found" })],
      else: [
        s.set_var("by_slug", withFilters(inp("slug"), fl.first_notnull(c.text("")), fl.to_text())),
        s.db.query({ table: recipe, where: cmp(col("slug"), "=", ref("by_slug")), output: [...RECIPE_FIELDS], returnType: "single", as: "found" }),
      ],
    }),
    guard.found("found", NOT_FOUND),
    s.db.query({ table: recipe_step, where: cmp(col("recipe_id"), "=", ref("found.id")), sort: [{ sortBy: "seq", dir: "asc" }], output: [...STEP_FIELDS], as: "steps" }),
    s.function.run({ fn: modelStateFn, as: "models", input: { steps: ref("steps") } }),
    s.set_var("can_edit", withFilters(c.array(rbac.rolesWith("recipes.manage")), fl.in(ref("actor.role")))),
    // Its runs: how many, the latest, this person's own latest (its inputs fill the form again), and the newest that made something.
    s.db.query({ table: ai_run, where: [cmp(col("recipe_id"), "=", ref("found.id")), cmp(col("kind"), "=", c.text("recipe"))], returnType: "count", as: "run_count" }),
    s.db.query({ table: ai_run, where: [cmp(col("recipe_id"), "=", ref("found.id")), cmp(col("kind"), "=", c.text("recipe"))],
      sort: [{ sortBy: "created_at", dir: "desc" }], output: [...BRIEF], returnType: "single", as: "latest" }),
    s.db.query({ table: ai_run, where: [cmp(col("recipe_id"), "=", ref("found.id")), cmp(col("kind"), "=", c.text("recipe")), cmp(col("owner_id"), "=", inp("actor_id"))],
      sort: [{ sortBy: "created_at", dir: "desc" }], output: ["owner_id", "inputs"], returnType: "single", as: "own_last" }),
    s.conditional({ when: expr(ref("own_last"), "=", c.null()), then: [
      s.db.query({ table: ai_run, where: [cmp(col("recipe_id"), "=", ref("found.id")), cmp(col("kind"), "=", c.text("recipe"))],
        sort: [{ sortBy: "created_at", dir: "desc" }], output: ["owner_id", "inputs"], returnType: "single", as: "team_last" }),
      s.update_var("own_last", ref("team_last")),
    ] }),
    s.set_var("last_inputs", c.array([])),
    s.foreach({ list: withFilters(ref("own_last.inputs", { safe: true }), fl.safe_array()), as: "given", body: [
      // A run with no inputs reads as one empty entry: only named ones are kept.
      s.conditional({ when: expr(withFilters(ref("given"), fl.get("name", ""), fl.first_notnull(c.text(""))), "!=", c.text("")), then: [
        s.array.push({ name: "last_inputs", value: obj({ name: withFilters(ref("given"), fl.get("name", "")), value: withFilters(ref("given"), fl.get("value", "")) }) }),
      ] }),
    ] }),
    s.db.query({ table: ai_run, where: [cmp(col("recipe_id"), "=", ref("found.id")), cmp(col("kind"), "=", c.text("recipe")), cmp(col("status"), "in", c.array(MADE_STATES))],
      sort: [{ sortBy: "created_at", dir: "desc" }], output: [...BRIEF], returnType: "single", as: "made_run" }),
    s.set_var("made_run_id", withFilters(ref("made_run.id", { safe: true }), fl.first_notnull(c.int(-1)))),
    s.db.query({ table: asset, where: [cmp(col("run_id"), "=", ref("made_run_id")), cmp(col("private"), "=", c.bool(false))],
      sort: [{ sortBy: "step_id", dir: "asc" }], output: ["id"], paging: { per_page: 12, metadata: false }, as: "made_rows" }),
    s.array.map({ source: ref("made_rows"), as: "made_ids", transform: ref("$this.id") }),
  ],
  response: {
    recipe: ref("found"), steps: ref("steps"), retired: ref("models.retired"), can_edit: ref("can_edit"),
    history: { runs: ref("run_count"), latest: ref("latest"), last_inputs: ref("last_inputs"),
      last_inputs_by: withFilters(ref("own_last.owner_id", { safe: true }), fl.first_notnull(c.int(0))), made_run: ref("made_run"), made_ids: ref("made_ids") },
  },
  responseShape: {} as { recipe: RecipeView; steps: RecipeStepView[]; retired: Retired[]; can_edit: boolean; history: RecipeHistory },
});

/** How much a recipe is used: its runs, from anywhere (the app, a key, an agent), and when the latest one started. */
export type RecipeUsage = { recipe_id: number; runs: number; last_run: number };

/**
 * Every recipe, by name, with whether any step uses a retired model, and how much each is used (its runs and when it last
 * ran; a recipe never run isn't in `usage`). Drafts are listed too, marked as drafts.
 */
export const listRecipesFn = defineFunction({
  name: "recipes/list",
  description: "All recipes by name: state, step count, estimate, first step's kind, every step's kind, whether a model they use has been retired, and each one's run count and last run.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    ...runner(),
    s.db.query({ table: recipe, sort: [{ sortBy: "name", dir: "asc" }], paging: { per_page: 500, metadata: false }, output: [...RECIPE_FIELDS], as: "rows" }),
    s.db.query({ table: recipe_step, output: ["recipe_id", "kind", "model"], paging: { per_page: 5000, metadata: false }, as: "all_steps" }),
    s.function.run({ fn: modelStateFn, as: "models", input: { steps: ref("all_steps") } }),
    // modelState numbers the steps it was given; map each retired one back to its recipe.
    s.set_var("retired_ids", c.array([])),
    s.foreach({ list: ref("models.retired"), as: "gone", body: [
      s.set_var("gone_step", withFilters(ref("all_steps"), fl.get(withFilters(ref("gone.seq"), fl.sub(1), fl.to_text()), c.obj({})))),
      s.array.push({ name: "retired_ids", value: withFilters(ref("gone_step"), fl.get("recipe_id", 0)) }),
    ] }),
    s.db.query({ table: ai_run, where: [cmp(col("kind"), "=", c.text("recipe")), cmp(col("recipe_id"), ">", c.int(0))], returnType: "aggregate", as: "usage",
      aggregate: { group: [{ name: "recipe_id", as: "recipe_id" }], eval: [{ name: "id", as: "runs", filters: [qf.count()] }, { name: "created_at", as: "last_run", filters: [qf.max()] }] } }),
  ],
  response: { items: ref("rows"), retired_ids: withFilters(ref("retired_ids"), fl.unique()), steps: ref("all_steps"), usage: ref("usage") },
  responseShape: {} as { items: RecipeView[]; retired_ids: number[]; steps: { recipe_id: number; kind: string; model: string }[]; usage: RecipeUsage[] },
});

/** Delete a recipe and its steps. Its past runs stay, with their outputs. */
export const deleteRecipeFn = defineFunction({
  name: "recipes/delete",
  description: "Delete a recipe and its steps. Runs it already made are kept.",
  input: { actor_id: input.int({ required: true }), recipe_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    rbac.allows(ref("actor.role"), "recipes.manage", "Your role can't delete recipes."),
    s.db.get({ table: recipe, fieldValue: inp("recipe_id"), output: ["id", "name"], as: "gone" }),
    guard.found("gone", NOT_FOUND),
    s.db.bulk.delete({ table: recipe_step, where: cmp(col("recipe_id"), "=", inp("recipe_id")) }),
    s.db.del({ table: recipe, fieldValue: inp("recipe_id") }),
    changed({ entity: "recipe", id: inp("recipe_id"), op: "deleted", verb: "deleted", actor: inp("actor_id"), title: withFilters(c.text("deleted the recipe "), fl.concat(ref("gone.name"))), link: c.text("/recipes") }),
  ],
  response: { deleted: c.bool(true) },
});

/** Where an uploaded file goes in each kind's input, and whether that's a list. */
const FILE_SLOT = { image: { key: "images", list: true }, video: { key: "image", list: false }, text: { key: "files", list: true }, transcribe: { key: "audio", list: false } } as const;

/**
 * Start a run of a recipe for `actor_id`, once per idempotency key. `values` holds the text inputs and picks from
 * Knowledge by name; `uploads` the files, in the order the recipe lists its file inputs. Refuses a retired model with
 * 409 and the models its kind allows. A recipe run always carries on in the background: the caller hands it to
 * runs/go after a created run.
 */
export const startRecipeFn = defineFunction({
  name: "recipes/start",
  description: "Start a recipe run once per key: check its models and inputs, build its steps, and start it through the spend gate.",
  input: {
    actor_id: input.int({ required: true }), recipe_id: input.int({ required: true }), values: input.json(), uploads: input.json(),
    via: input.enum(RUN_VIAS, { required: true }), connection_id: input.int(), idem_key: input.text({ required: true }),
    base_url: input.text(), agent_label: input.text(), allow_draft: input.bool(),
  },
  stack: [
    ...runner(),
    s.db.get({ table: recipe, fieldValue: inp("recipe_id"), as: "found" }),
    guard.found("found", NOT_FOUND),
    guard.require(or(expr(ref("found.status"), "=", c.text("published")), expr(inp("allow_draft"), "=", c.bool(true))), { errorType: "badrequest", message: NOT_PUBLISHED }),
    s.db.query({ table: recipe_step, where: cmp(col("recipe_id"), "=", ref("found.id")), sort: [{ sortBy: "seq", dir: "asc" }], output: [...STEP_FIELDS], as: "steps" }),
    s.function.run({ fn: modelStateFn, as: "models", input: { steps: ref("steps") } }),
    s.conditional({ when: expr(ref("models.ok"), "=", c.bool(false)), then: [
      s.set_var("gone", withFilters(ref("models.retired"), fl.first())),
      s.throw({ name: "MODEL_RETIRED", status: 409, value: withFilters(c.text("Step "), fl.concat(ref("gone.seq")), fl.concat(c.text(` ${RETIRED_WORDS}: `)), fl.concat(ref("gone.model")),
        fl.concat(c.text(". Models it can use instead: ")), fl.concat(withFilters(ref("gone.allowed"), fl.join(", "))), fl.concat(c.text(". Someone who can edit recipes can pick one and save it."))) }),
    ] }),
    // The recipe's file inputs, in order, each paired with the upload in the same place.
    s.set_var("uploads", withFilters(inp("uploads"), fl.safe_array())),
    s.set_var("given", c.array([])),
    s.set_var("files_by_name", c.obj({})),
    s.set_var("file_at", c.int(0)),
    s.foreach({ list: withFilters(ref("found.inputs"), fl.safe_array()), as: "def", body: [
      s.conditional({ when: cond.in(withFilters(ref("def"), fl.get("type", "")), c.array(["image", "audio", "file"])), then: [
        s.set_var("upload", withFilters(ref("uploads"), fl.get(withFilters(ref("file_at"), fl.to_text()), c.null()))),
        s.update_var("file_at", withFilters(ref("file_at"), fl.add(1))),
        s.conditional({ when: expr(withFilters(ref("upload"), fl.empty()), "=", c.bool(false)), then: [
          s.storage.read_file_resource({ value: ref("upload"), as: "read" }),
          s.array.push({ name: "given", value: withFilters(ref("def"), fl.get("name", "")) }),
          s.update_var("files_by_name", withFilters(ref("files_by_name"), fl.set(withFilters(ref("def"), fl.get("name", "")), obj({
            resource: ref("upload"), about: obj({ name: ref("read.name"), size: ref("read.size"), mime: ref("read.mime") }), sha: withFilters(ref("read.data"), fl.sha256()),
          })))),
        ] }),
      ] }),
    ] }),
    s.set_var("values", withFilters(inp("values"), fl.first_notnull(c.obj({})))),
    s.conditional({ when: expr(withFilters(ref("values"), fl.is_object()), "=", c.bool(false)), then: [s.update_var("values", c.obj({}))] }),
    s.function.run({ fn: planFn, as: "plan", input: { inputs: ref("found.inputs"), steps: ref("steps"), values: ref("values"), files_given: ref("given"), build: c.bool(true) } }),
    ...firstError("plan", "problem"),
    s.precondition({ expr: expr(ref("plan.ok"), "=", c.bool(true)), error_type: "badrequest", error: ref("problem") }),
    // Each file goes where its step's kind takes one; the fingerprint keeps a resent request the same request.
    s.set_var("run_steps", c.array([])),
    s.foreach({ list: withFilters(ref("plan.run_steps", { safe: true }), fl.safe_array()), as: "rs", body: [
      s.set_var("rs_input", withFilters(ref("rs.input"), fl.first_notnull(c.obj({})))),
      s.set_var("rs_file", withFilters(ref("rs_input"), fl.get("file_input", ""), fl.first_notnull(c.text("")))),
      s.conditional({ when: expr(ref("rs_file"), "!=", c.text("")), then: [
        s.set_var("picked", withFilters(ref("files_by_name"), fl.get(ref("rs_file"), c.null()))),
        s.conditional({ when: expr(ref("picked"), "!=", c.null()), then: [
          s.switch({ on: ref("rs.kind"), cases: Object.entries(FILE_SLOT).map(([kind, slot]) => ({ when: c.text(kind), break: true, body: [
            s.update_var("rs_input", withFilters(ref("rs_input"), fl.set(slot.key, slot.list ? withFilters(c.array([]), fl.append(ref("picked.resource"), c.text(""))) : ref("picked.resource")))),
          ] })) }),
          s.update_var("rs_input", withFilters(ref("rs_input"), fl.set("sources", withFilters(c.array([]), fl.append(ref("picked.about"), c.text("")))), fl.set("file_sha", ref("picked.sha")))),
        ] }),
      ] }),
      s.array.push({ name: "run_steps", value: withFilters(ref("rs"), fl.set("input", ref("rs_input"))) }),
    ] }),
    // "Product launch kit · Trail 2": the recipe, and what the first text input was.
    s.set_var("title", ref("found.name")),
    s.set_var("shown", c.array([])),
    s.foreach({ list: withFilters(ref("found.inputs"), fl.safe_array()), as: "def", body: [
      s.set_var("def_name", withFilters(ref("def"), fl.get("name", ""), fl.to_text())),
      s.set_var("def_type", withFilters(ref("def"), fl.get("type", ""), fl.to_text())),
      s.set_var("def_value", withFilters(ref("values"), fl.get(ref("def_name"), ""), fl.first_notnull(c.text("")), fl.to_text(), fl.trim())),
      s.conditional({ when: cond.in(ref("def_type"), c.array(["image", "audio", "file"])), then: [
        s.update_var("def_value", withFilters(ref("files_by_name"), fl.get(ref("def_name"), c.obj({})), fl.get("about.name", ""), fl.first_notnull(c.text("")))),
      ] }),
      s.conditional({ when: expr(ref("def_value"), "!=", c.text("")), then: [
        s.array.push({ name: "shown", value: obj({ name: ref("def_name"), label: withFilters(ref("def"), fl.get("label", ""), fl.first_notempty(ref("def_name"))), type: ref("def_type"), value: withFilters(ref("def_value"), fl.substr(0, 500)) }) }),
        s.conditional({ when: [expr(ref("title"), "=", ref("found.name")), cond.in(ref("def_type"), c.array(["text", "knowledge"]))], then: [
          s.update_var("title", withFilters(ref("found.name"), fl.concat(c.text(" · ")), fl.concat(withFilters(ref("def_value"), fl.substr(0, 40))))),
        ] }),
      ] }),
    ] }),
    s.function.run({ fn: startRunFn, as: "started", input: {
      owner_id: inp("actor_id"), kind: c.text("recipe"), via: inp("via"), connection_id: withFilters(inp("connection_id"), fl.first_notnull(c.int(0))),
      idem_key: inp("idem_key"), recipe_id: ref("found.id"), title: ref("title"), private: c.bool(false), base_url: inp("base_url"),
      agent_label: withFilters(inp("agent_label"), fl.first_notempty(ref("found.name"))), steps: ref("run_steps"),
    } }),
    s.conditional({ when: expr(ref("started.outcome"), "=", c.text("created")), then: [
      s.db.patch({ table: ai_run, fieldValue: ref("started.run.id"), data: obj({ inputs: ref("shown") }) }),
    ] }),
  ],
  response: ref("started"),
  responseShape: {} as { outcome: "created" | "existing" | "conflict"; run: { id: number; status: string; estimate: number; detail: string; title: string } },
});

export type { Plan, RunStep };
