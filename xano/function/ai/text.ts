// Text: one call to s.ai.text.generate for a reserved step. `max_tokens` is the cap the estimate assumed, so a call can't
// cost more than was held; on Gemini 3.x that cap includes hidden thinking, which is why the default is generous. An
// empty reply with no finish reason is how the gateway says a prompt was blocked: it's still billed, so it's charged.
// With `response_format: "json"` the reply must parse; one that doesn't is a failure the person can act on.
import { c, defineFunction, expect, expr, fl, input, obj, or, ref, resp, s, withFilters } from "@xano/sdk";
import { ESTIMATE_DEFAULTS } from "../../prices.js";
import { composeStep } from "../brand/compose.js";
import {
  callModel, fellShort, flagFilled, flagSet, forAll, fromAsked, heldRow, NO_RESERVATION, pick, plainCompose, reservedStep, stepRow, succeeded,
  variants, wrapperResponse, type WrapperResult,
} from "./shared.js";

const T = {
  reply: "a reply comes back with what it used",
  blocked: "an empty reply with no finish reason is blocked",
  json: "a JSON reply comes back parsed",
  badJson: "a JSON reply that doesn't parse fails",
  cutJson: "a JSON reply cut off at the length limit fails and keeps the finish reason",
  noReservation: "a step without a reservation is refused",
} as const;
const ALL = Object.values(T);

export const BLOCKED_WORDS = "The model declined this prompt and sent nothing back. Xano AI still charges for it. Change the prompt and try again.";
export const BAD_JSON_WORDS = "The model's reply wasn't valid JSON. It was still charged. Try again, or loosen the schema.";
const CUT_OFF_WORDS = "The reply ran out of room before any text came back: the length limit includes the model's thinking. Raise it and try again.";
const PROMPT_NEEDED = "A text step needs a prompt. Nothing was sent or charged.";

const schema = { type: "object", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["title", "bullets"] };
// Envelopes recorded from the gateway on 2026-11-16.
const RECORDED = {
  reply: { text: "A gravel bike blends the speed of a road bike with the rugged durability of a mountain bike, making it perfect for exploring paved roads, dirt trails, and everything in between.", json: null, model: "claude-sonnet-5-5", finish_reason: "stop", usage: { input_tokens: 22, output_tokens: 59 } },
  blocked: { text: "", json: null, model: "gemini-3.8-flash", finish_reason: null, usage: { input_tokens: 11, output_tokens: 157 } },
  json: { text: "{\"title\": \"Trail 2 Gravel Bike\", \"bullets\": [\"Lightweight frame.\", \"Wide tyres.\"]}", json: { title: "Trail 2 Gravel Bike", bullets: ["Lightweight frame.", "Wide tyres."] }, model: "gemini-3.8-flash", finish_reason: "stop", usage: { input_tokens: 97, output_tokens: 475 } },
  badJson: { text: "Here is your product: Trail 2", json: null, model: "gemini-3.8-flash", finish_reason: "stop", usage: { input_tokens: 97, output_tokens: 40 } },
  // Shaped like the 40-page proof run, which stopped at max_tokens partway through its reply.
  cutJson: { text: "{\"total_pages\": 40, \"pages\": [{\"page\": 1, \"markdown\": \"# Marlow", json: null, model: "gemini-3.8-flash", finish_reason: "max_tokens", usage: { input_tokens: 10400, output_tokens: 4000 } },
};
const prompt = "Write one sentence about a gravel bike.";
const jsonAsk = { prompt: "Give a product title and two bullets for the Trail 2 gravel bike.", response_format: "json", json_schema: schema };
const stepMocks = {
  [T.reply]: stepRow("text", "claude-sonnet-5-5", { prompt }, { output_tokens: 200 }),
  [T.blocked]: stepRow("text", "gemini-3.8-flash", { prompt: "A prompt the model declines." }, { output_tokens: 200 }),
  [T.json]: stepRow("text", "gemini-3.8-flash", jsonAsk),
  [T.badJson]: stepRow("text", "gemini-3.8-flash", jsonAsk),
  [T.cutJson]: stepRow("text", "gemini-3.8-flash", jsonAsk),
  [T.noReservation]: stepRow("text", "gemini-3.8-flash", { prompt }),
};
const entryMocks = { ...forAll(ALL, heldRow), [T.noReservation]: c.null() };
const composeMocks = {
  [T.reply]: plainCompose(prompt), [T.blocked]: plainCompose("A prompt the model declines."),
  [T.json]: plainCompose(jsonAsk.prompt), [T.badJson]: plainCompose(jsonAsk.prompt), [T.cutJson]: plainCompose(jsonAsk.prompt),
};
const modelMocks = {
  [T.reply]: c.obj(RECORDED.reply as never), [T.blocked]: c.obj(RECORDED.blocked as never), [T.json]: c.obj(RECORDED.json as never), [T.badJson]: c.obj(RECORDED.badJson as never),
  [T.cutJson]: c.obj(RECORDED.cutJson as never),
};

const optional = { temperature: ref("temperature"), system: ref("system"), files: ref("files") };

export const textFn = defineFunction({
  name: "ai/text",
  description: "Generate text for a reserved step: send only the settings that were set, and say whether it succeeded, was blocked or failed.",
  input: { step_id: input.int({ required: true }) },
  stack: [
    ...reservedStep("text", { step: stepMocks, entry: entryMocks }),
    composeStep("text", composeMocks),
    s.set_var("prompt", ref("composed.prompt")),
    s.set_var("system", ref("composed.system")),
    flagFilled("system"),
    fromAsked("temperature"), flagSet("temperature"),
    fromAsked("files", c.array([])), flagFilled("files"),
    fromAsked("json_schema"), flagFilled("json_schema"),
    s.set_var("json_mode", withFilters(ref("asked"), fl.get("response_format", "text"), fl.first_notnull(c.text("text")), fl.eq(c.text("json")))),
    s.set_var("max_tokens", withFilters(ref("options"), fl.get("output_tokens", ESTIMATE_DEFAULTS.output_tokens), fl.first_notnull(c.int(ESTIMATE_DEFAULTS.output_tokens)), fl.to_int())),
    s.set_var("mapped", c.null()),
    s.set_var("failed", c.bool(false)),
    s.conditional({
      when: expr(withFilters(ref("prompt"), fl.trim()), "=", c.text("")),
      then: [s.update_var("mapped", obj({ outcome: c.text("failed"), reason: c.text("rejected"), detail: c.text(PROMPT_NEEDED), refused: c.bool(true), output: c.obj({}), usage: c.obj({}) })),
        s.update_var("failed", c.bool(true))],
      else: [
        ...callModel(s.conditional({
          when: expr(ref("json_mode"), "=", c.bool(true)),
          then: [variants(["temperature", "system", "files", "json_schema"], (on) => s.ai.text.generate({
            model: ref("step.model"), prompt: ref("prompt"), max_tokens: ref("max_tokens"), response_format: "json",
            ...pick(on, { ...optional, json_schema: ref("json_schema") }), as: "r", mock: modelMocks,
          }))],
          else: [variants(["temperature", "system", "files"], (on) => s.ai.text.generate({
            model: ref("step.model"), prompt: ref("prompt"), max_tokens: ref("max_tokens"), response_format: "text",
            ...pick(on, optional), as: "r", mock: modelMocks,
          }))],
        })),
      ],
    }),
    s.conditional({ when: expr(ref("failed"), "=", c.bool(false)), then: [
      s.set_var("said", withFilters(ref("r.text", { safe: true }), fl.first_notnull(c.text("")), fl.to_text())),
      s.set_var("finish", ref("r.finish_reason", { safe: true })),
      s.set_var("used", withFilters(ref("r.usage", { safe: true }), fl.first_notnull(c.obj({})))),
      s.set_var("empty", withFilters(ref("said"), fl.trim(), fl.eq(c.text("")))),
      s.conditional({
        when: [expr(ref("empty"), "=", c.bool(true)), expr(ref("finish"), "=", c.text("max_tokens"))],
        then: [fellShort("failed", "max_tokens", CUT_OFF_WORDS, c.obj({ finish_reason: "max_tokens" }), ref("used"))],
        elif: [
          { when: or(expr(ref("empty"), "=", c.bool(true)), expr(ref("finish"), "=", c.text("safety"))), then: [fellShort("blocked", "blocked", BLOCKED_WORDS, obj({ finish_reason: ref("finish") }), ref("used"))] },
          { when: [expr(ref("json_mode"), "=", c.bool(true)), expr(ref("r.json", { safe: true }), "=", c.null())], then: [fellShort("failed", "bad_json", BAD_JSON_WORDS, obj({ text: ref("said"), finish_reason: ref("finish") }), ref("used"))] },
        ],
        else: [
          s.set_var("note", c.text("")),
          s.conditional({ when: expr(ref("finish"), "=", c.text("max_tokens")), then: [s.update_var("note", c.text("The reply hit its length limit, so it may stop mid-sentence."))] }),
          succeeded(obj({ text: ref("said"), json: ref("r.json", { safe: true }), finish_reason: ref("finish") }), ref("used"), ref("note")),
        ],
      }),
    ] }),
  ],
  response: wrapperResponse(ref("composed.applied"), ref("prompt")),
  responseShape: {} as WrapperResult,
  tests: [
    { name: T.reply, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("succeeded")),
      expect.to_equal(resp("output.text"), c.text(RECORDED.reply.text)),
      expect.to_equal(resp("usage.output_tokens"), c.int(59)),
      expect.to_be_false(resp("refused")),
    ] },
    { name: T.blocked, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("blocked")),
      expect.to_equal(resp("reason"), c.text("blocked")),
      expect.to_equal(resp("detail"), c.text(BLOCKED_WORDS)),
      // Billed by the gateway, so it settles from what was used: not refused.
      expect.to_be_false(resp("refused")),
      expect.to_equal(resp("usage.output_tokens"), c.int(157)),
    ] },
    { name: T.json, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("succeeded")),
      expect.to_equal(resp("output.json.title"), c.text("Trail 2 Gravel Bike")),
    ] },
    { name: T.badJson, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("failed")),
      expect.to_equal(resp("reason"), c.text("bad_json")),
      expect.to_start_with(resp("detail"), c.text("The model's reply wasn't valid JSON")),
      expect.to_be_false(resp("refused")),
    ] },
    { name: T.cutJson, input: { step_id: c.int(41) }, expect: [
      expect.to_equal(resp("outcome"), c.text("failed")),
      expect.to_equal(resp("reason"), c.text("bad_json")),
      expect.to_equal(resp("output.finish_reason"), c.text("max_tokens")),
      expect.to_equal(resp("usage.output_tokens"), c.int(4000)),
    ] },
    { name: T.noReservation, input: { step_id: c.int(41) }, expect: [expect.to_throw(c.text(NO_RESERVATION))] },
  ],
});
