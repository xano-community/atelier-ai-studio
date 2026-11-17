// list_recipes: the team's published recipes, what each asks for and what a run is estimated at. The same recipes/list the
// Recipes screen reads, so the role check is the screen's.
import { c, defineFunction, expr, fl, inp, obj, ref, s, withFilters } from "@xano/sdk";
import { listRecipesFn } from "../recipes/recipes.js";
import { dollars } from "../spend/estimate.js";
import { actorInputs } from "./tooling.js";

export type ToolRecipe = { slug: string; name: string; description: string; steps: number; estimate: string; inputs: unknown[]; retired: boolean; link: string };

export const listRecipesToolFn = defineFunction({
  name: "studio/list_recipes",
  description: "Published recipes for an agent or Easel: slug, what it makes, its inputs and its estimate.",
  input: { ...actorInputs },
  stack: [
    s.function.run({ fn: listRecipesFn, as: "list", input: { actor_id: inp("actor_id") } }),
    s.set_var("out", c.array([])),
    s.foreach({ list: ref("list.items"), as: "one", body: [
      s.conditional({ when: expr(ref("one.status"), "=", c.text("published")), then: [
        dollars("one_cost", ref("one.estimate")),
        s.array.push({ name: "out", value: obj({
          slug: ref("one.slug"), name: ref("one.name"), description: withFilters(ref("one.description"), fl.first_notnull(c.text(""))),
          steps: ref("one.step_count"), estimate: ref("one_cost"), inputs: withFilters(ref("one.inputs"), fl.safe_array()),
          retired: withFilters(ref("list.retired_ids"), fl.in(ref("one.id"))), link: withFilters(c.text("/recipes/"), fl.concat(ref("one.slug"))),
        }) }),
      ] }),
    ] }),
  ],
  response: ref("out"),
  responseShape: [] as ToolRecipe[],
});
