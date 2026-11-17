// Recipes' endpoints. The app's own (signed in as a person) list, read, save, estimate and run recipes. The recipe API
// (signed in with the person's own read-and-write connection key) runs a published recipe by its slug and reads the
// run back. Every run starts through recipes/start, so the model check, the idempotency key and the spend gate apply
// the same way from the app, a script or an agent. Routes that start a run keep request history off: they mint the
// background worker's token.
import { auth, c, cmp, col, cond, expr, fl, guard, inp, input, obj, query, ref, s, sys, withFilters } from "@xano/sdk";
import { agent } from "../agent.js";
import { approvals } from "../approvals.js";
import { rbac } from "../rbac.js";
import { recipe } from "../table/recipes/recipe.js";
import { ai_run } from "../table/studio/ai_run.js";
import { user } from "../table/user.js";
import { goFn } from "../function/runs/background.js";
import { viewRunFn } from "../function/runs/control.js";
import { deriveKeyFn } from "../function/runs/start.js";
import { dollars } from "../function/spend/estimate.js";
import {
  deleteRecipeFn, estimateRecipeFn, listRecipesFn, NO_SUCH_RECIPE, saveRecipeFn, startRecipeFn, viewRecipeFn,
  type RecipeHistory, type RecipeInput, type RecipeUsage, type RecipeStepView, type RecipeView, type Retired,
} from "../function/recipes/recipes.js";
import type { PlanError } from "../function/recipes/plan.js";
import { studioGroup } from "./studio.js";

/** The app's address for background steps: this request's base, before /api:. */
const baseUrl = () => s.set_var("base", withFilters(c.regex(/\/api:.*$/), fl.regex_replace(c.text(""), sys.apiBaseUrl())));
const MOST_FILES = 3;
const fileInputs = Object.fromEntries(Array.from({ length: MOST_FILES }, (_, i) => [`file_${i + 1}`, input.file()]));
/** The uploads, in the order the recipe lists its file inputs. */
const uploads = () => s.set_var("uploads", withFilters(c.array([]), ...Array.from({ length: MOST_FILES }, (_, i) => fl.append(inp(`file_${i + 1}`), c.text("")))));

const recipeBody = {
  name: input.text({ methods: ["trim"] }), description: input.text({ methods: ["trim"] }),
  status: input.enum(["draft", "published"]), inputs: input.json(), steps: input.json(),
};

/** GET studio/recipes: every recipe by name, with whether a model one uses has been retired. */
export const listRecipesRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "recipes", verb: "GET",
  description: "Every recipe by name: state, steps, estimate, and whether one uses a retired model. Not for guests.",
  stack: [
    ...rbac.require("studio.run", "Your role can't use recipes. Ask an admin for access."),
    s.function.run({ fn: listRecipesFn, as: "list", input: { actor_id: auth("id") } }),
  ],
  response: ref("list"),
  responseShape: {} as { items: RecipeView[]; retired_ids: number[]; steps: { recipe_id: number; kind: string; model: string }[]; usage: RecipeUsage[] },
});

/** GET studio/recipes/{slug}: one recipe, its steps, and which use a retired model (with what to use instead). */
export const readRecipeRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "recipes/{slug}", verb: "GET",
  description: "One recipe by its slug: inputs, steps, retired models, whether you may edit it, and its runs: how many, the latest, your last inputs and what the newest finished run made.",
  input: { slug: input.text({ required: true }) },
  stack: [
    ...rbac.require("studio.run", "Your role can't use recipes. Ask an admin for access."),
    s.function.run({ fn: viewRecipeFn, as: "view", input: { actor_id: auth("id"), slug: inp("slug"), recipe_id: c.int(0) } }),
  ],
  response: ref("view"),
  responseShape: {} as { recipe: RecipeView; steps: RecipeStepView[]; retired: Retired[]; can_edit: boolean; history: RecipeHistory },
});

/** POST studio/recipes: a new recipe. Refused with the first problem when a reference or model doesn't check out. */
export const createRecipeRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "recipes", verb: "POST",
  description: "Create a recipe from its name, inputs and steps. References are checked: a step can use only earlier steps.",
  input: recipeBody,
  stack: [
    ...rbac.require("recipes.manage", "Your role can't make recipes. Ask an admin for access."),
    s.function.run({ fn: saveRecipeFn, as: "saved", input: { actor_id: auth("id"), recipe_id: c.int(0), name: inp("name"), description: inp("description"), status: inp("status"), inputs: inp("inputs"), steps: inp("steps") } }),
  ],
  response: ref("saved"),
  responseShape: {} as RecipeView,
});

/** PATCH studio/recipes/{id}: replace a recipe's name, state, inputs and steps. */
export const updateRecipeRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "recipes/{id}", verb: "PATCH",
  description: "Save a recipe's name, description, state, inputs and steps. Its slug stays, so API calls keep working.",
  input: { id: input.int({ required: true }), ...recipeBody },
  stack: [
    ...rbac.require("recipes.manage", "Your role can't change recipes. Ask an admin for access."),
    s.function.run({ fn: saveRecipeFn, as: "saved", input: { actor_id: auth("id"), recipe_id: inp("id"), name: inp("name"), description: inp("description"), status: inp("status"), inputs: inp("inputs"), steps: inp("steps") } }),
  ],
  response: ref("saved"),
  responseShape: {} as RecipeView,
});

/** DELETE studio/recipes/{id}: delete a recipe. Its runs and their outputs stay. */
export const deleteRecipeRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "recipes/{id}", verb: "DELETE",
  description: "Delete a recipe and its steps. Runs it made are kept.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.require("recipes.manage", "Your role can't delete recipes."),
    s.function.run({ fn: deleteRecipeFn, as: "gone", input: { actor_id: auth("id"), recipe_id: inp("id") } }),
  ],
  response: ref("gone"),
  responseShape: {} as { deleted: boolean },
});

type PricedStep = { seq: number; recipe_seq: number; label: string; kind: string; model: string; amount: number; priced: boolean; detail: string };

/** POST studio/recipes/estimate: the editor's live check and estimate. Writes nothing. */
export const estimateRecipeRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "recipes/estimate", verb: "POST",
  description: "Check a recipe draft's references and estimate a run of it, step by step, with every input at its longest. Writes nothing.",
  input: { inputs: input.json(), steps: input.json() },
  stack: [
    ...rbac.require("studio.run", "Your role can't use recipes. Ask an admin for access."),
    s.function.run({ fn: estimateRecipeFn, as: "est", input: { inputs: inp("inputs"), steps: inp("steps") } }),
  ],
  response: ref("est"),
  responseShape: {} as { ok: boolean; errors: PlanError[]; steps: PricedStep[]; total: number; unpriced: string },
});

type RunView = { id: number; kind: string; via: string; title: string; status: string; reason: string; detail: string; estimate: number; spent: number; private: boolean; approval_id: number; created_at: number; finished_at: number | null };

/**
 * POST studio/recipes/{id}/runs: run a recipe from the app. `values` holds the text inputs and Knowledge picks by name;
 * file inputs come as file_1…file_3 in the order the recipe lists them. `client_id` is the click's own key. A draft can
 * be run here, to try it, by anyone who may run recipes.
 */
export const runRecipeRoute = query({
  apiGroup: studioGroup, auth: user, history: false,
  name: "recipes/{id}/runs", verb: "POST",
  description: "Run a recipe from the app. Answers at once with the run; its steps carry on in the background. The same client_id twice is one run.",
  input: { id: input.int({ required: true }), client_id: input.text({ required: true, methods: ["trim"] }), values: input.json(), ...fileInputs },
  stack: [
    ...rbac.require("studio.run", "Your role can't run recipes. Ask an admin for access."),
    baseUrl(),
    uploads(),
    s.function.run({ fn: startRecipeFn, as: "started", input: {
      actor_id: auth("id"), recipe_id: inp("id"), values: inp("values"), uploads: ref("uploads"), via: c.text("ui"), connection_id: c.int(0),
      idem_key: inp("client_id"), base_url: ref("base"), agent_label: c.text(""), allow_draft: c.bool(true),
    } }),
    s.conditional({ when: expr(ref("started.outcome"), "=", c.text("conflict")), then: [
      s.throw({ name: "IDEMPOTENCY_KEY_REUSED", status: 409, value: c.text("That client_id was already used for a different request. Send a new one for a new run.") }),
    ] }),
    s.conditional({ when: expr(ref("started.outcome"), "=", c.text("created")), then: [
      s.function.run({ fn: goFn, as: "went", input: { run_id: ref("started.run.id"), inline: c.bool(false) } }),
    ] }),
    s.function.run({ fn: viewRunFn, as: "view", input: { run_id: ref("started.run.id"), actor_id: auth("id") } }),
  ],
  response: { outcome: ref("started.outcome"), run: ref("view.run"), steps: ref("view.steps") },
  responseShape: {} as { outcome: "created" | "existing"; run: RunView; steps: unknown[] },
});

type RecipeRunRow = { id: number; owner_id: number; via: string; title: string; status: string; estimate: number; spent: number; created_at: number; finished_at: number | null };

/** GET studio/recipes/{id}/runs: a recipe's recent runs, newest first. */
export const recipeRunsRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "recipes/{id}/runs", verb: "GET",
  description: "A recipe's 25 latest runs, newest first: who ran it, from where, how it ended and what it cost.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.require("studio.run", "Your role can't use recipes. Ask an admin for access."),
    s.db.query({ table: ai_run, where: [cmp(col("recipe_id"), "=", inp("id")), cmp(col("kind"), "=", c.text("recipe"))], sort: [{ sortBy: "created_at", dir: "desc" }],
      paging: { per_page: 25, metadata: false }, output: ["id", "owner_id", "via", "title", "status", "estimate", "spent", "created_at", "finished_at"], as: "rows" }),
  ],
  response: ref("rows"),
  responseShape: [] as RecipeRunRow[],
});

type RunDetails = {
  recipe: { id: number; slug: string; name: string } | null;
  inputs: { name: string; label: string; type: string; value: string }[];
  owner_name: string; connection_name: string;
  approval: { status: string; decided_by: string; decided_at: number | null } | null;
};

/** GET studio/runs/{id}/details: what a run page shows beside its steps: the recipe, its inputs, who ran it, its approval. */
export const runDetailsRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "runs/{id}/details", verb: "GET",
  description: "A run's recipe, inputs, owner, key name and approval, for anyone who may read the run.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.signedIn(),
    // The same read rule as the run itself: an unreadable run answers as if it didn't exist.
    s.function.run({ fn: viewRunFn, as: "view", input: { run_id: inp("id"), actor_id: auth("id") } }),
    s.db.get({ table: ai_run, fieldValue: inp("id"), output: ["id", "owner_id", "recipe_id", "inputs", "approval_id", "connection_id"], as: "run" }),
    guard.found("run", { errorType: "notfound", message: "No such run." }),
    s.db.get({ table: user, fieldValue: ref("run.owner_id"), output: ["name"], as: "owner" }),
    s.set_var("recipe", c.null()),
    s.conditional({ when: expr(ref("run.recipe_id"), ">", c.int(0)), then: [
      s.db.get({ table: recipe, fieldValue: ref("run.recipe_id"), output: ["id", "slug", "name"], as: "found" }),
      s.update_var("recipe", ref("found")),
    ] }),
    s.set_var("connection_name", c.text("")),
    s.conditional({ when: expr(ref("run.connection_id"), ">", c.int(0)), then: [
      s.db.get({ table: agent.agent_connection, fieldValue: ref("run.connection_id"), output: ["name"], as: "line" }),
      s.update_var("connection_name", withFilters(ref("line.name", { safe: true }), fl.first_notnull(c.text("")))),
    ] }),
    s.set_var("approval", c.null()),
    s.conditional({ when: expr(ref("run.approval_id"), ">", c.int(0)), then: [
      s.db.get({ table: approvals.approval, fieldValue: ref("run.approval_id"), output: ["status", "decided_by", "decided_at"], as: "asked" }),
      s.conditional({ when: expr(ref("asked"), "!=", c.null()), then: [
        s.set_var("decider_id", withFilters(ref("asked.decided_by", { safe: true }), fl.first_notnull(c.int(0)))),
        s.db.get({ table: user, fieldValue: ref("decider_id"), output: ["name"], as: "decider" }),
        s.update_var("approval", obj({ status: ref("asked.status", { safe: true }), decided_by: withFilters(ref("decider.name", { safe: true }), fl.first_notnull(c.text(""))), decided_at: ref("asked.decided_at", { safe: true }) })),
      ] }),
    ] }),
  ],
  response: {
    recipe: ref("recipe"), inputs: withFilters(ref("run.inputs"), fl.safe_array()), owner_name: withFilters(ref("owner.name", { safe: true }), fl.first_notnull(c.text(""))),
    connection_name: ref("connection_name"), approval: ref("approval"),
  },
  responseShape: {} as RunDetails,
});

// ── The recipe API: the person's own connection key ──────────────────────────────────────────────────────────────

/**
 * Who may call the recipe API, checked before anything is written: a live, unexpired key (401 otherwise), that can
 * write (403), whose owner is still here, isn't a guest and may run AI (403). Binds `conn` and `person`.
 */
const keyHolder = (write: boolean) => [
  ...agent.connection(false),
  ...(write ? [guard.require(expr(ref("conn.scope"), "=", c.text("read_write")), { errorType: "accessdenied", message: "This key can only read. Create a read and write key in the recipe's API tab." })] : []),
  guard.require(expr(ref("person.role"), "!=", c.text("guest")), { errorType: "accessdenied", message: "Guests can't connect an agent or use the recipe API." }),
  rbac.allows(ref("person.role"), "studio.run", "Your role can't run recipes. Ask an admin for access."),
];

export type ApiRun = {
  run: number; status: string; detail: string; estimate: string; estimate_micro: number; spent_micro: number; poll: string; key: string;
};

/**
 * POST studio/recipes/{slug}/run: run a published recipe with your own key. Text inputs and Knowledge picks go in
 * `inputs`; files as file_1…file_3, in the order the recipe lists them. An `Idempotency-Key` header makes a resend return
 * the first run; without one, the same inputs within 10 minutes are the same request. Answers at once with the run id
 * and where to poll it. A retired model answers 409 with the models its kind allows.
 */
export const apiRunRecipeRoute = query({
  apiGroup: studioGroup, auth: agent.agent_connection, history: false,
  name: "recipes/{slug}/run", verb: "POST",
  description: "Run a published recipe with your own read-and-write key. Answers at once with the run id, its status, its estimate and where to poll it.",
  input: { slug: input.text({ required: true }), inputs: input.json(), ...fileInputs },
  stack: [
    ...keyHolder(true),
    s.db.query({ table: recipe, where: cmp(col("slug"), "=", inp("slug")), output: ["id", "status"], returnType: "single", as: "found" }),
    guard.found("found", { errorType: "notfound", message: NO_SUCH_RECIPE }),
    s.set_var("headers", sys.httpHeaders()),
    s.set_var("given_key", withFilters(ref("headers"), fl.get("Idempotency-Key", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.trim())),
    s.set_var("values", withFilters(inp("inputs"), fl.first_notnull(c.obj({})))),
    s.conditional({
      when: expr(ref("given_key"), "!=", c.text("")),
      then: [s.set_var("idem_key", withFilters(c.text("api:"), fl.concat(withFilters(ref("given_key"), fl.substr(0, 190)))))],
      else: [
        s.function.run({ fn: deriveKeyFn, as: "derived", input: { actor_id: ref("conn.user_id"), tool: withFilters(c.text("recipe-api:"), fl.concat(inp("slug"))), args: ref("values"), turn: c.text(""), at: c.int(0) } }),
        s.set_var("idem_key", ref("derived")),
      ],
    }),
    baseUrl(),
    uploads(),
    s.function.run({ fn: startRecipeFn, as: "started", input: {
      actor_id: ref("conn.user_id"), recipe_id: ref("found.id"), values: ref("values"), uploads: ref("uploads"), via: c.text("api"), connection_id: ref("conn.id"),
      idem_key: ref("idem_key"), base_url: ref("base"), agent_label: withFilters(c.text("Recipe API key "), fl.concat(ref("conn.name"))), allow_draft: c.bool(false),
    } }),
    s.conditional({ when: expr(ref("started.outcome"), "=", c.text("conflict")), then: [
      s.throw({ name: "IDEMPOTENCY_KEY_REUSED", status: 409, value: c.text("That Idempotency-Key was already used for a different request. Send a new key for a new run.") }),
    ] }),
    s.conditional({ when: expr(ref("started.outcome"), "=", c.text("created")), then: [
      s.function.run({ fn: goFn, as: "went", input: { run_id: ref("started.run.id"), inline: c.bool(false) } }),
    ] }),
    s.db.get({ table: ai_run, fieldValue: ref("started.run.id"), output: ["id", "status", "detail", "estimate", "spent"], as: "now" }),
    guard.found("now", { message: "That run couldn't be started. Try again." }),
    dollars("estimate_words", ref("now.estimate")),
  ],
  response: {
    run: ref("now.id"), status: ref("now.status"), detail: ref("now.detail"), estimate: ref("estimate_words"), estimate_micro: ref("now.estimate"), spent_micro: ref("now.spent"),
    poll: withFilters(sys.apiBaseUrl(), fl.concat(c.text("/recipes/runs/")), fl.concat(ref("now.id"))), key: ref("idem_key"),
  },
  responseShape: {} as ApiRun,
});

type ApiStep = { seq: number; label: string; kind: string; status: string; detail: string; text: string; url: string; charged_micro: number };

/** GET studio/recipes/runs/{id}: a run started with your key (or any team run you may see), with each step's result. */
export const apiReadRunRoute = query({
  apiGroup: studioGroup, auth: agent.agent_connection,
  name: "recipes/runs/{id}", verb: "GET",
  description: "Poll a run with your own key: its status, what it cost, and each step's text or a one-minute link to its file.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...keyHolder(false),
    s.function.run({ fn: viewRunFn, as: "view", input: { run_id: inp("id"), actor_id: ref("conn.user_id") } }),
    s.set_var("steps", c.array([])),
    s.foreach({ list: ref("view.steps"), as: "one", body: [
      s.array.push({ name: "steps", value: obj({
        seq: ref("one.seq"), label: ref("one.label"), kind: ref("one.kind"), status: ref("one.status"), detail: ref("one.detail"),
        text: withFilters(ref("one.output"), fl.get("text", ""), fl.first_notnull(c.text(""))), json: withFilters(ref("one.output"), fl.get("json", c.null())),
        url: ref("one.url"), charged_micro: ref("one.charged"),
      }) }),
    ] }),
    dollars("spent_words", ref("view.run.spent")),
  ],
  response: {
    run: ref("view.run.id"), title: ref("view.run.title"), status: ref("view.run.status"), detail: ref("view.run.detail"),
    estimate_micro: ref("view.run.estimate"), spent: ref("spent_words"), spent_micro: ref("view.run.spent"), steps: ref("steps"),
  },
  responseShape: {} as { run: number; title: string; status: string; detail: string; estimate_micro: number; spent: string; spent_micro: number; steps: ApiStep[] },
});

export const recipeQueries = [
  listRecipesRoute, readRecipeRoute, createRecipeRoute, updateRecipeRoute, deleteRecipeRoute, estimateRecipeRoute, runRecipeRoute, recipeRunsRoute,
  runDetailsRoute, apiRunRecipeRoute, apiReadRunRoute,
];
export type { RecipeInput };
