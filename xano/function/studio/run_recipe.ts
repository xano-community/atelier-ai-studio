// run_recipe: start a published recipe for the person, through recipes/start like the Run button and the recipe API. It
// answers at once with the run id: a costly run, or a member's video, waits for an admin, and an admin's own run above the
// line waits for their click in the app. A recipe that needs a file can't be run this way; the words say where to run it.
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { recipe } from "../../table/recipes/recipe.js";
import { goFn } from "../runs/background.js";
import { NO_SUCH_RECIPE, startRecipeFn } from "../recipes/recipes.js";
import { actorInputs, idemKey, instanceBase, requestInput, runAnswerFn, type ToolRun } from "./tooling.js";

export const runRecipeToolFn = defineFunction({
  name: "studio/run_recipe",
  description: "Start a published recipe for the person once per request: answers at once with the run, its estimate and what it waits on.",
  input: {
    ...actorInputs,
    ...requestInput,
    recipe: input.text({ required: true, methods: ["trim"] }),
    /** The recipe's text inputs and Knowledge picks, by name. */
    inputs: input.json(),
  },
  stack: [
    s.db.query({ table: recipe, where: cmp(col("slug"), "=", inp("recipe")), output: ["id", "slug"], returnType: "single", as: "found" }),
    guard.found("found", { errorType: "notfound", message: `${NO_SUCH_RECIPE} Use list_recipes for the slugs.` }),
    s.set_var("values", withFilters(inp("inputs"), fl.first_notnull(c.obj({})))),
    ...idemKey("run_recipe", obj({ recipe: ref("found.slug"), inputs: ref("values") })),
    ...instanceBase(),
    s.function.run({ fn: startRecipeFn, as: "started", input: {
      actor_id: inp("actor_id"), recipe_id: ref("found.id"), values: ref("values"), uploads: c.array([]), via: inp("via"), connection_id: inp("connection_id"),
      idem_key: ref("idem_key"), base_url: ref("base"), agent_label: withFilters(inp("agent_label"), fl.first_notempty(c.text("An agent"))), allow_draft: c.bool(false),
    } }),
    s.conditional({ when: expr(ref("started.outcome"), "=", c.text("conflict")), then: [
      s.throw({ name: "IDEMPOTENCY_KEY_REUSED", status: 409, value: c.text("That request_id was already used for a different request. Send a new one for a new run.") }),
    ] }),
    s.conditional({ when: expr(ref("started.outcome"), "=", c.text("created")), then: [
      s.function.run({ fn: goFn, as: "went", input: { run_id: ref("started.run.id"), inline: c.bool(false) } }),
    ] }),
    s.function.run({ fn: runAnswerFn, as: "answer", input: { run_id: ref("started.run.id") } }),
  ],
  response: ref("answer"),
  responseShape: {} as ToolRun,
});
