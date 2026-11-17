// What a model call will cost, from the price table: the catalog price for the units it uses, plus the gateway's margin.
// The same arithmetic prices a reservation (from the step's caps) and a settlement (from the usage the gateway returned).
import { and, c, cmp, col, defineFunction, expr, fl, inp, input, ref, s, withFilters, type Value } from "@xano/sdk";
import { ESTIMATE_DEFAULTS, LONG_PROMPT_TOKENS, MARGIN_DENOMINATOR, MARGIN_NUMERATOR, MICRO } from "../../prices.js";
import { price } from "../../table/studio/price.js";

/** One unit's price now, in micro-dollars, or -1 when there's no row. A blank variant is the fallback for any variant. */
export const rateFn = defineFunction({
  name: "spend/rate",
  description: "The current price of one unit of a model (micro-dollars; tokens per 1M), or -1 when it has no price.",
  input: { model: input.text({ required: true }), unit: input.text({ required: true }), variant: input.text() },
  stack: [
    s.db.query({ table: price, where: [cmp(col("model"), "=", inp("model")), cmp(col("unit"), "=", inp("unit")), cmp(col("variant"), "=", inp("variant"))], returnType: "single", as: "row" }),
    s.conditional({ when: and(expr(ref("row"), "=", c.null()), expr(inp("variant"), "!=", c.text(""))), then: [
      s.db.query({ table: price, where: [cmp(col("model"), "=", inp("model")), cmp(col("unit"), "=", inp("unit")), cmp(col("variant"), "=", c.text(""))], returnType: "single", as: "fallback" }),
      s.update_var("row", ref("fallback")),
    ] }),
    s.set_var("rate", c.int(-1)),
    s.conditional({ when: expr(ref("row"), "!=", c.null()), then: [
      s.update_var("rate", ref("row.amount", { safe: true })),
      s.conditional({ when: and(expr(ref("row.later_from", { safe: true }), ">", c.int(0)), expr(c.now(), ">=", ref("row.later_from", { safe: true }))), then: [
        s.update_var("rate", ref("row.later_amount", { safe: true })),
      ] }),
    ] }),
  ],
  response: ref("rate"),
});

const opt = (key: string, fallback: string | number | boolean) => withFilters(inp("options"), fl.get(key, fallback), fl.first_notnull(fallback));
const rate = (as: string, unit: string, variant: Value) =>
  s.function.run({ fn: rateFn, as, input: { model: inp("model"), unit: c.text(unit), variant } });

/**
 * Micro-dollars for one call of `kind` on `model` with these options, margin included and rounded up. `priced` is false,
 * with words saying so, when the model has no price for what's asked: such a call isn't run.
 *
 * Options read: `input_tokens`, `output_tokens` (text, speech, transcription, embeddings), `input_type` (an embedding's
 * input: text, image, audio or video), `size` and `samples` (images), `seconds`, `resolution`, `audio` and `samples`
 * (video), `samples` (music).
 */
export const estimateFn = defineFunction({
  name: "spend/estimate",
  description: "What one model call is estimated to cost, in micro-dollars, from the price table and the gateway's margin.",
  input: { kind: input.text({ required: true }), model: input.text({ required: true }), options: input.json() },
  stack: [
    s.set_var("base", c.int(0)),
    s.set_var("missing", c.bool(false)),
    s.set_var("samples", withFilters(opt("samples", ESTIMATE_DEFAULTS.samples), fl.to_int(), fl.clamp_min(1))),
    s.switch({ on: inp("kind"), default: [s.update_var("missing", c.bool(true))], cases: [
      ...(["text", "speech", "transcribe"] as const).map((kind) => ({ when: c.text(kind), break: true, body: [
        s.set_var("in_tokens", withFilters(opt("input_tokens", ESTIMATE_DEFAULTS.input_tokens), fl.to_int(), fl.clamp_min(0))),
        s.set_var("out_tokens", withFilters(opt("output_tokens", ESTIMATE_DEFAULTS.output_tokens), fl.to_int(), fl.clamp_min(0))),
        s.set_var("tier", c.text("")),
        s.conditional({ when: expr(ref("in_tokens"), ">", c.int(LONG_PROMPT_TOKENS)), then: [s.update_var("tier", c.text("over_100k"))] }),
        rate("in_rate", "input_token", ref("tier")),
        rate("out_rate", "output_token", ref("tier")),
        s.conditional({
          when: [expr(ref("in_rate"), ">=", c.int(0)), expr(ref("out_rate"), ">=", c.int(0))],
          then: [s.update_var("base", withFilters(ref("in_tokens"), fl.mul(ref("in_rate")), fl.add(withFilters(ref("out_tokens"), fl.mul(ref("out_rate")))), fl.div(MICRO)))],
          else: [s.update_var("missing", c.bool(true))],
        }),
      ] })),
      { when: c.text("embedding"), break: true, body: [
        s.set_var("in_tokens", withFilters(opt("input_tokens", ESTIMATE_DEFAULTS.input_tokens), fl.to_int(), fl.clamp_min(0))),
        rate("in_rate", "input_token", withFilters(opt("input_type", ESTIMATE_DEFAULTS.embedding_input), fl.to_text())),
        s.conditional({
          when: expr(ref("in_rate"), ">=", c.int(0)),
          then: [s.update_var("base", withFilters(ref("in_tokens"), fl.mul(ref("in_rate")), fl.div(MICRO)))],
          else: [s.update_var("missing", c.bool(true))],
        }),
      ] },
      { when: c.text("image"), break: true, body: [
        rate("each", "image", withFilters(opt("size", ESTIMATE_DEFAULTS.image_size), fl.to_text())),
        s.conditional({
          when: expr(ref("each"), ">=", c.int(0)),
          then: [s.update_var("base", withFilters(ref("each"), fl.mul(ref("samples"))))],
          else: [s.update_var("missing", c.bool(true))],
        }),
      ] },
      { when: c.text("video"), break: true, body: [
        s.set_var("seconds", withFilters(opt("seconds", ESTIMATE_DEFAULTS.video_seconds), fl.to_decimal(), fl.clamp_min(0))),
        s.set_var("sound", c.text("/silent")),
        s.conditional({ when: expr(withFilters(opt("audio", false), fl.to_text()), "=", c.text("true")), then: [s.update_var("sound", c.text("/audio"))] }),
        s.conditional({ when: expr(withFilters(opt("audio", false), fl.to_text()), "=", c.text("1")), then: [s.update_var("sound", c.text("/audio"))] }),
        rate("per_second", "second", withFilters(opt("resolution", ESTIMATE_DEFAULTS.video_resolution), fl.to_text(), fl.lower(), fl.concat(ref("sound")))),
        s.conditional({
          when: expr(ref("per_second"), ">=", c.int(0)),
          then: [s.update_var("base", withFilters(ref("per_second"), fl.mul(ref("seconds")), fl.mul(ref("samples"))))],
          else: [s.update_var("missing", c.bool(true))],
        }),
      ] },
      { when: c.text("music"), break: true, body: [
        rate("per_clip", "clip", c.text("")),
        s.conditional({
          when: expr(ref("per_clip"), ">=", c.int(0)),
          then: [s.update_var("base", withFilters(ref("per_clip"), fl.mul(ref("samples"))))],
          else: [s.update_var("missing", c.bool(true))],
        }),
      ] },
    ] }),
    s.set_var("amount", c.int(0)),
    s.set_var("detail", c.text("")),
    s.conditional({
      when: expr(ref("missing"), "=", c.bool(true)),
      then: [s.update_var("detail", withFilters(c.text("No price set for "), fl.concat(inp("model")), fl.concat(c.text(": an admin can add one under Usage."))))],
      else: [s.update_var("amount", withFilters(ref("base"), fl.mul(MARGIN_NUMERATOR), fl.div(MARGIN_DENOMINATOR), fl.ceil(), fl.to_int()))],
    }),
  ],
  response: { priced: c.expression("$var.missing == false"), amount: ref("amount"), detail: ref("detail") },
});

/** "$1.05", or "under $0.01" for a sliver: how a screen or a refusal says an amount of micro-dollars. */
export const dollarsFn = defineFunction({
  name: "spend/dollars",
  description: "An amount of micro-dollars in words: \"$1.05\", or \"under $0.01\".",
  input: { amount: input.int() },
  stack: [
    s.set_var("words", withFilters(c.text("$"), fl.concat(withFilters(inp("amount"), fl.clamp_min(0), fl.div(MICRO), fl.number_format(2, ".", ","))))),
    s.conditional({ when: [expr(inp("amount"), ">", c.int(0)), expr(inp("amount"), "<", c.int(MICRO / 100))], then: [s.update_var("words", c.text("under $0.01"))] }),
  ],
  response: ref("words"),
});

/** `s.function.run` of dollarsFn, bound to `as`. */
export const dollars = (as: string, amount: Value) => s.function.run({ fn: dollarsFn, as, input: { amount } });
