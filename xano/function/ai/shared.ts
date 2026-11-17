// What every model wrapper shares. A wrapper is the only place a model is called, and it calls one only for a step
// that holds a reservation and was marked sent: so no route, tool or script can reach a model past the spend gate.
// A wrapper sends only the optional settings that were set (Claude 5.x refuses an empty `temperature`), so each
// statement is written once per combination of the settings it can leave out.
import { c, caught, cmp, col, expr, fl, guard, inp, obj, ref, s, statements, withFilters, type Statement, type Value } from "@xano/sdk";
import { ai_step } from "../../table/studio/ai_step.js";
import { ledger } from "../../table/studio/ledger.js";
import { gatewayErrorFn } from "./gateway.js";
import { keepWhereReadable } from "../library/media.js";

/** Per-test mock values, keyed by the wrapper's own test names. */
export type Mocks = Record<string, Value>;
const only = (m: Mocks | undefined) => (m && Object.keys(m).length ? { mock: m } : {});

export const NO_RESERVATION = "A model is called only for a step that holds a reservation. Start it as a run.";

/**
 * Bind `step` (the reserved, sent step), `asked` (its input) and `options`. Refuses unless the step is this wrapper's
 * kind, is running, was marked sent, and its attempt still holds money in the ledger.
 */
export const reservedStep = (kind: string, mocks: { step?: Mocks; entry?: Mocks } = {}) => statements(
  s.db.get({ table: ai_step, fieldValue: inp("step_id"), as: "step", ...only(mocks.step) }),
  guard.found("step", { errorType: "accessdenied", message: NO_RESERVATION }),
  guard.require(expr(ref("step.kind"), "=", c.text(kind)), { errorType: "badrequest", message: `This step isn't a ${kind} step.` }),
  s.db.query({ table: ledger, where: [cmp(col("step_id"), "=", inp("step_id")), cmp(col("attempt"), "=", ref("step.attempt"))], returnType: "single", as: "held_entry", ...only(mocks.entry) }),
  guard.require(expr(ref("held_entry.held", { safe: true }), "=", c.int(1)), { errorType: "accessdenied", message: NO_RESERVATION }),
  guard.require([expr(ref("step.status"), "=", c.text("working")), expr(ref("step.sent_at"), "!=", c.null())], { errorType: "accessdenied", message: NO_RESERVATION }),
  s.set_var("asked", withFilters(ref("step.input"), fl.first_notnull(c.obj({})))),
  s.set_var("options", withFilters(ref("step.options"), fl.first_notnull(c.obj({})))),
);

/** `name` from the step's input, or `fallback`. */
export const fromAsked = (name: string, fallback: Value = c.null()) =>
  s.set_var(name, withFilters(ref("asked"), fl.get(name, c.null()), fl.first_notnull(fallback)));
/** `has_<name>`: true when a number or flag was given (0 counts). */
export const flagSet = (name: string) => s.set_var(`has_${name}`, withFilters(ref(name), fl.null(), fl.not()));
/** `has_<name>`: true when text, a list or an object isn't empty. */
export const flagFilled = (name: string) => s.set_var(`has_${name}`, withFilters(ref(name), fl.empty(), fl.not()));

/**
 * One statement per combination of the optional settings: a tree of conditionals on `has_<flag>`, with `leaf` writing
 * the statement for the set that's on. Each leaf carries the same mocks, so a test sees its value whichever leaf runs.
 */
export const variants = (flags: string[], leaf: (on: Set<string>) => Statement, on = new Set<string>()): Statement => {
  if (!flags.length) return leaf(on);
  const [first, ...rest] = flags;
  return s.conditional({
    when: expr(ref(`has_${first}`), "=", c.bool(true)),
    then: [variants(rest, leaf, new Set([...on, first]))],
    else: [variants(rest, leaf, on)],
  });
};

/** `{ key: value }` for each optional setting that's on. */
export const pick = (on: Set<string>, values: Record<string, Value>) =>
  Object.fromEntries(Object.entries(values).filter(([k]) => on.has(k)));

/**
 * Call the model: `call` binds `r`. A thrown error is classified into `mapped`; a result is left in `r` for the
 * wrapper to read. Binds `failed` (true when it threw).
 */
export const callModel = (call: Statement) => statements(
  s.set_var("r", c.null()),
  s.set_var("failed", c.bool(false)),
  s.set_var("mapped", c.null()),
  s.try_catch({
    try: [call],
    catch: [
      s.update_var("failed", c.bool(true)),
      s.function.run({ fn: gatewayErrorFn, as: "gateway", input: { error: caught() } }),
      s.update_var("mapped", obj({
        outcome: ref("gateway.outcome"), reason: ref("gateway.reason"), detail: ref("gateway.detail"), refused: ref("gateway.refused"),
        output: obj({ gateway_message: ref("gateway.gateway_message") }), usage: c.obj({}),
      })),
    ],
  }),
);

/** A successful call's result, in the shape every wrapper answers with. */
export const succeeded = (output: Value, usage: Value, detail: Value = c.text("")) =>
  s.update_var("mapped", obj({ outcome: c.text("succeeded"), reason: c.text(""), detail, refused: c.bool(false), output, usage }));
/** A call that reached the model and came back without what was asked: charged as sent. */
export const fellShort = (outcome: "blocked" | "failed", reason: string, detail: string, output: Value = c.obj({}), usage: Value = c.obj({})) =>
  s.update_var("mapped", obj({ outcome: c.text(outcome), reason: c.text(reason), detail: c.text(detail), refused: c.bool(false), output, usage }));

/**
 * Keep a made file privately. A store that fails after the model made the file still charges (it was billed), and says
 * so. Binds `stored` (the stored file) or leaves `mapped` failed. An image or recording moves into a table where this
 * server can't sign links (library/media.ts), so it can still be shown; a video stays in private storage.
 */
export const storePrivately = (kind: "image" | "video" | "audio", value: Value, filename: Value, mocks?: Mocks) => {
  const store = { image: s.storage.create_image, video: s.storage.create_video, audio: s.storage.create_audio }[kind];
  return statements(
    s.set_var("stored", c.null()),
    s.try_catch({
      try: [store({ value, access: "private", filename, as: "kept", ...only(mocks) }), s.update_var("stored", ref("kept"))],
      catch: [s.set_var("store_error", caught("message"))],
    }),
    ...(kind === "video" ? [] : keepWhereReadable("stored", value, { run: ref("step.run_id"), step: ref("step.id"), attempt: ref("step.attempt"), source: c.int(0) })),
  );
};

/** The file's name: the kind, the step and its attempt. */
export const fileName = (ext: string) =>
  withFilters(c.text("atelier-"), fl.concat(ref("step.kind")), fl.concat(c.text("-")), fl.concat(ref("step.id")), fl.concat(c.text("-")), fl.concat(ref("step.attempt")), fl.concat(c.text(`.${ext}`)));

export const STORE_FAILED = "The model made it, but it couldn't be saved. It was still charged. Try again.";

/** What every wrapper answers. */
export const wrapperResponse = (brand: Value, sentPrompt: Value) => ({
  outcome: ref("mapped.outcome"), reason: ref("mapped.reason"), detail: ref("mapped.detail"), refused: ref("mapped.refused"),
  output: ref("mapped.output"), usage: ref("mapped.usage"), brand_applied: brand, sent_prompt: sentPrompt,
});

export type WrapperResult = {
  outcome: "succeeded" | "blocked" | "failed" | "timed_out"; reason: string; detail: string; refused: boolean;
  output: Record<string, unknown>; usage: Record<string, unknown>; brand_applied: boolean; sent_prompt: string;
};

/** What a wrapper's own unit tests read in place of the step and its ledger row. */
export const stepRow = (kind: string, model: string, asked: Record<string, unknown>, options: Record<string, unknown> = {}) => c.obj({
  id: 41, run_id: 9, seq: 1, kind, model, status: "working", attempt: 1, claimed: 1, sent_at: 1794842669595, timeout_s: 120,
  input: asked, options, depends_on: [], optional: false,
} as never);
export const heldRow = c.obj({ id: 5, step_id: 41, attempt: 1, held: 1, state: "reserved" });
/** The same mock for every named test. */
export const forAll = (names: string[], value: Value) => Object.fromEntries(names.map((n) => [n, value]));
/** What compose answers when the brand kit isn't asked for. */
export const plainCompose = (prompt: string, extra: Record<string, unknown> = {}) =>
  c.obj({ prompt, system: "", voice: "", instructions: "", applied: false, references: [], reference_names: [], ...extra } as never);
/** A stored private file, as create_image/create_video/create_audio answer. */
export const storedFile = (type: string, name: string, mime: string, meta: Record<string, unknown> = {}) =>
  c.obj({ access: "private", path: `/vault/test/${name}`, name, type, size: 1000, mime, meta } as never);
