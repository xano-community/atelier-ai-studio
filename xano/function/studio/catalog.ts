// The model list: xano/catalog.gen.json, written by scripts/sync-catalog.mjs from the live Xano AI catalog. The
// Playground reads it through GET studio/playground/catalog, and every route that starts a run checks its steps here
// first, so a model Xano AI doesn't offer (or lists but doesn't serve) is refused before anything is stored or reserved.
import { c, defineFunction, expr, fl, inp, input, or, ref, s, withFilters } from "@xano/sdk";
import generated from "../../catalog.gen.json" with { type: "json" };

export type CatalogModel = {
  model: string; label: string; tier: string; stage: string; suggested: boolean;
  /** The catalog's own words for the price ("$0.067 per 1K image, $0.101 2K, $0.151 4K"). */
  price: string;
  /** What the model takes: aspect_ratios, image_sizes, durations, resolutions, voices, files, max_samples… */
  options: Record<string, unknown>;
};
export type Catalog = {
  source: string; generated_at: string;
  statements: Record<string, CatalogModel[]>;
  /** Models the catalog lists that the gateway refuses, with the words a person reads. */
  unavailable: Record<string, string>;
};
export const CATALOG = generated as Catalog;

/** The kinds the Playground offers. Embeddings and rerank do their work in Knowledge. */
export const PLAYGROUND_KINDS = ["text", "image", "video", "music", "speech", "transcribe"] as const;

/** "kind:model" for every model the catalog offers for that kind. */
export const KNOWN_MODELS = Object.entries(CATALOG.statements).flatMap(([kind, list]) => list.map((m) => `${kind}:${m.model}`));
export const UNAVAILABLE_MODELS = Object.keys(CATALOG.unavailable);

export const UNKNOWN_MODEL_WORDS = " isn't a model Xano AI offers for this kind of step. Pick one from the Playground's model list.";
export const UNAVAILABLE_MODEL_WORDS = " is listed by Xano AI but isn't served yet. Pick another model.";

/** Refuse a run whose steps name a model the catalog doesn't offer for their kind, or one the gateway doesn't serve. */
export const checkModelsFn = defineFunction({
  name: "studio/check_models",
  description: "Refuse (400) a list of steps when one names a model the Xano AI catalog doesn't offer for its kind, or one it doesn't serve yet.",
  input: { steps: input.json({ required: true }) },
  stack: [
    s.set_var("known", c.array(KNOWN_MODELS)),
    s.set_var("unserved", c.array(UNAVAILABLE_MODELS)),
    s.foreach({ list: withFilters(inp("steps"), fl.safe_array()), as: "one", body: [
      s.set_var("one_model", withFilters(ref("one"), fl.get("model", ""), fl.first_notnull(c.text("")), fl.to_text())),
      s.set_var("one_key", withFilters(ref("one"), fl.get("kind", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.concat(c.text(":")), fl.concat(ref("one_model")))),
      s.precondition({ expr: expr(withFilters(ref("known"), fl.in(ref("one_key"))), "=", c.bool(true)), error_type: "badrequest",
        error: withFilters(ref("one_model"), fl.concat(c.text(UNKNOWN_MODEL_WORDS))) }),
      s.precondition({ expr: expr(withFilters(ref("unserved"), fl.in(ref("one_model"))), "=", c.bool(false)), error_type: "badrequest",
        error: withFilters(ref("one_model"), fl.concat(c.text(UNAVAILABLE_MODEL_WORDS))) }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

/** For each kind, the models a step of that kind can use now: offered by the catalog and served by the gateway. */
export const SERVED_MODELS: Record<string, string[]> = Object.fromEntries(Object.entries(CATALOG.statements).map(([kind, list]) =>
  [kind, list.map((m) => m.model).filter((m) => !UNAVAILABLE_MODELS.includes(m))]));

/**
 * The same rule as check_models, answered rather than thrown: which steps name a model the catalog no longer offers for
 * their kind or the gateway doesn't serve (a retired model), and the models each such kind can use instead. A saved
 * recipe reads it to show its retired state, and its runs are refused with it.
 */
export const modelStateFn = defineFunction({
  name: "studio/model_state",
  description: "Which steps use a retired model (not offered for its kind, or not served), and the models their kinds allow.",
  input: { steps: input.json({ required: true }) },
  stack: [
    s.set_var("known", c.array(KNOWN_MODELS)),
    s.set_var("unserved", c.array(UNAVAILABLE_MODELS)),
    s.set_var("served", c.obj(SERVED_MODELS as never)),
    s.set_var("retired", c.array([])),
    s.set_var("seq", c.int(0)),
    s.foreach({ list: withFilters(inp("steps"), fl.safe_array()), as: "one", body: [
      s.update_var("seq", withFilters(ref("seq"), fl.add(1))),
      s.set_var("one_kind", withFilters(ref("one"), fl.get("kind", ""), fl.first_notnull(c.text("")), fl.to_text())),
      s.set_var("one_model", withFilters(ref("one"), fl.get("model", ""), fl.first_notnull(c.text("")), fl.to_text())),
      s.set_var("one_key", withFilters(ref("one_kind"), fl.concat(c.text(":")), fl.concat(ref("one_model")))),
      s.conditional({ when: or(
        expr(withFilters(ref("known"), fl.in(ref("one_key"))), "=", c.bool(false)),
        expr(withFilters(ref("unserved"), fl.in(ref("one_model"))), "=", c.bool(true)),
      ), then: [
        s.array.push({ name: "retired", value: withFilters(c.obj({}), fl.set("seq", ref("seq")), fl.set("kind", ref("one_kind")), fl.set("model", ref("one_model")),
          fl.set("allowed", withFilters(ref("served"), fl.get(ref("one_kind"), c.array([])), fl.safe_array()))) }),
      ] }),
    ] }),
  ],
  response: { ok: withFilters(ref("retired"), fl.count(), fl.eq(c.int(0))), retired: ref("retired") },
  responseShape: {} as { ok: boolean; retired: { seq: number; kind: string; model: string; allowed: string[] }[] },
});
