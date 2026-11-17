// generate: one step of any kind an agent can ask for without uploading (text, image, video, speech, music), started through
// runs/start like a Playground run, so the catalog check, the idempotency key and the spend gate are the Playground's. A
// library item can be where it starts: its words go into a text prompt, and a picture becomes the image to edit or the
// video's first frame, attached just before the call. Quick kinds answer with their result; video and music answer at once
// and carry on in the background. A run that needs an admin, or the person's own click, says so instead of acting.
import { c, cond, defineFunction, expr, fl, guard, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { goFn } from "../runs/background.js";
import { viewRunFn } from "../runs/control.js";
import { startRunFn } from "../runs/start.js";
import { checkModelsFn } from "./catalog.js";
import { getAssetFn } from "../library/library.js";
import { actorInputs, idemKey, instanceBase, requestInput, runAnswerFn, type ToolRun } from "./tooling.js";

export const GENERATE_KINDS = ["text", "image", "video", "speech", "music"] as const;
/** The model each kind uses when the caller names none: the catalog's quick, inexpensive choice. */
export const DEFAULT_MODELS: Record<(typeof GENERATE_KINDS)[number], string> = {
  text: "gemini-3.8-flash", image: "gemini-3.1-flash-image", video: "veo-3.1-fast-generate-001", speech: "gemini-3.8-flash-tts", music: "lyria-002",
};
const KIND_LABEL = { text: "Text", image: "Image", video: "Video", speech: "Speech", music: "Music" };
/** Kinds the brand kit is added to unless the caller turns it off. */
const BRANDABLE = ["text", "image", "video", "speech", "music"];
/** Kinds a library picture can start: the image to edit, or the video's first frame. */
const FROM_PICTURE = ["image", "video"];
/** How much of a library item's words go into a text prompt. */
const MOST_SOURCE_CHARS = 8000;
const MOST_RESULT_CHARS = 4000;

export type ToolGenerated = ToolRun & { output: { text: string; url: string; asset_id: number } | null };

export const generateToolFn = defineFunction({
  name: "studio/generate",
  description: "Make one output of a kind (text, image, video, speech, music) for the person through the spend gate, once per request.",
  input: {
    ...actorInputs,
    ...requestInput,
    kind: input.enum(GENERATE_KINDS, { required: true }),
    model: input.text({ methods: ["trim"] }),
    /** What to make; for speech, the words to say. */
    prompt: input.text({ methods: ["trim"] }),
    /** seconds, aspect_ratio, resolution, audio (video); size, aspect_ratio (image); output_tokens (text). */
    options: input.json(),
    voice: input.text({ methods: ["trim"] }),
    /** A library item to start from. */
    from_asset: input.int(),
    use_brand: input.bool({ nullable: true }),
    title: input.text({ methods: ["trim"] }),
  },
  stack: [
    s.set_var("default_model", withFilters(c.obj(DEFAULT_MODELS), fl.get(inp("kind"), ""))),
    s.set_var("model", withFilters(inp("model"), fl.first_notempty(ref("default_model")))),
    s.set_var("words", withFilters(inp("prompt"), fl.first_notnull(c.text("")))),
    guard.require(expr(ref("words"), "!=", c.text("")), { errorType: "badrequest", message: "Say what to make in prompt (for speech, the words to say)." }),
    s.set_var("options", withFilters(inp("options"), fl.first_notnull(c.obj({})))),
    s.set_var("from_id", withFilters(inp("from_asset"), fl.first_notnull(c.int(0)))),
    s.set_var("asked", c.obj({})),
    s.set_var("title", withFilters(inp("title"), fl.first_notnull(c.text("")))),
    s.conditional({ when: expr(ref("title"), "=", c.text("")), then: [
      s.update_var("title", withFilters(c.obj(KIND_LABEL), fl.get(inp("kind"), "Output"), fl.concat(c.text(" with ")), fl.concat(ref("model")))),
    ] }),
    // A library item it starts from: read under the person's own read rule, so an item they can't see isn't found.
    s.conditional({ when: expr(ref("from_id"), ">", c.int(0)), then: [
      s.function.run({ fn: getAssetFn, as: "source", input: { asset_id: ref("from_id"), actor_id: inp("actor_id") } }),
      s.conditional({
        when: cond.in(inp("kind"), c.array(FROM_PICTURE)),
        then: [
          guard.require(expr(ref("source.kind"), "=", c.text("image")), { errorType: "badrequest", message: "Only a picture from the Library can start an image or a video." }),
          // `library_picture` asks for the file to be attached just before the call (recipes/fill_step); `from_asset` records
          // where the output came from, as the Playground does.
          s.update_var("asked", withFilters(ref("asked"), fl.set("from_asset", ref("from_id")), fl.set("library_picture", ref("from_id")),
            fl.set("sources", withFilters(c.array([]), fl.append(obj({ name: ref("source.title"), from_asset: ref("from_id") }), c.text("")))))),
        ],
        else: [
          guard.require(expr(withFilters(ref("source.body"), fl.trim()), "!=", c.text("")), { errorType: "badrequest", message: "That item has no words to start from. A picture can start an image or a video." }),
          s.update_var("words", withFilters(ref("words"), fl.concat(c.text("\n\nStart from this:\n")), fl.concat(withFilters(ref("source.body"), fl.substr(0, MOST_SOURCE_CHARS))))),
          s.update_var("asked", withFilters(ref("asked"), fl.set("from_asset", ref("from_id")))),
        ],
      }),
      s.update_var("title", withFilters(ref("title"), fl.concat(c.text(" from ")), fl.concat(ref("source.title")))),
    ] }),
    s.conditional({
      when: expr(inp("kind"), "=", c.text("speech")),
      then: [
        s.update_var("asked", withFilters(ref("asked"), fl.set("text", ref("words")))),
        s.conditional({ when: expr(withFilters(inp("voice"), fl.first_notnull(c.text(""))), "!=", c.text("")), then: [s.update_var("asked", withFilters(ref("asked"), fl.set("voice", inp("voice"))))] }),
      ],
      else: [s.update_var("asked", withFilters(ref("asked"), fl.set("prompt", ref("words"))))],
    }),
    s.conditional({ when: cond.in(inp("kind"), c.array(BRANDABLE)), then: [
      s.update_var("asked", withFilters(ref("asked"), fl.set("use_brand", withFilters(inp("use_brand"), fl.first_notnull(c.bool(true)))))),
    ] }),
    s.set_var("steps", withFilters(c.array([]), fl.append(obj({ kind: inp("kind"), model: ref("model"), input: ref("asked"), options: ref("options") }), c.text("")))),
    // A model the catalog doesn't offer is refused before any run row or reservation.
    s.function.run({ fn: checkModelsFn, as: "models_ok", input: { steps: ref("steps") } }),
    ...idemKey("generate", obj({ kind: inp("kind"), model: ref("model"), prompt: inp("prompt"), options: ref("options"), voice: inp("voice"), from_asset: ref("from_id"), use_brand: inp("use_brand") })),
    ...instanceBase(),
    s.function.run({ fn: startRunFn, as: "started", input: {
      owner_id: inp("actor_id"), kind: c.text("playground"), via: inp("via"), connection_id: inp("connection_id"), idem_key: ref("idem_key"), recipe_id: c.int(0),
      title: ref("title"), private: c.bool(true), base_url: ref("base"), agent_label: withFilters(inp("agent_label"), fl.first_notempty(c.text("An agent"))), steps: ref("steps"),
    } }),
    s.conditional({ when: expr(ref("started.outcome"), "=", c.text("conflict")), then: [
      s.throw({ name: "IDEMPOTENCY_KEY_REUSED", status: 409, value: c.text("That request_id was already used for a different request. Send a new one for a new run.") }),
    ] }),
    s.conditional({ when: expr(ref("started.outcome"), "=", c.text("created")), then: [
      s.function.run({ fn: goFn, as: "went", input: { run_id: ref("started.run.id"), inline: c.bool(true) } }),
    ] }),
    s.function.run({ fn: runAnswerFn, as: "answer", input: { run_id: ref("started.run.id") } }),
    // A quick kind that already finished answers with what it made: its words, or a one-minute link and its library item.
    s.set_var("output", c.null()),
    s.conditional({ when: expr(ref("answer.status"), "=", c.text("done")), then: [
      s.function.run({ fn: viewRunFn, as: "view", input: { run_id: ref("started.run.id"), actor_id: inp("actor_id") } }),
      s.set_var("made", withFilters(ref("view.steps"), fl.first())),
      s.update_var("output", obj({
        text: withFilters(ref("made.output", { safe: true }), fl.get("text", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.substr(0, MOST_RESULT_CHARS)),
        url: withFilters(ref("made.url", { safe: true }), fl.first_notnull(c.text(""))),
        asset_id: withFilters(ref("made.asset_id", { safe: true }), fl.first_notnull(c.int(0))),
      })),
    ] }),
  ],
  response: {
    run_id: ref("answer.run_id"), status: ref("answer.status"), title: ref("answer.title"), detail: ref("answer.detail"), estimate: ref("answer.estimate"),
    estimate_micro: ref("answer.estimate_micro"), spent: ref("answer.spent"), approval_id: ref("answer.approval_id"), link: ref("answer.link"), next: ref("answer.next"),
    output: ref("output"),
  },
  responseShape: {} as ToolGenerated,
});
