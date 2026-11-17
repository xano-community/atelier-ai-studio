// Reading a recipe's references (frontend/src/lib/rules/recipe-plan.ts) and finishing a step's words just before it runs
// (frontend/src/lib/rules/recipe-fill.ts). Both bodies are plain functions the editor runs too, so what the editor marks as an
// error is exactly what saving refuses.
import { lam } from "@xano/sdk/node";
import { c, cmp, col, defineFunction, expr, fl, guard, inp, input, obj, qf, ref, s, withFilters } from "@xano/sdk";
import { kb_passage } from "../../table/knowledge/kb_passage.js";
import { kb_source } from "../../table/knowledge/kb_source.js";
import { KB_DIMENSIONS } from "../../table/knowledge/kb_passage.js";
import { ai_step } from "../../table/studio/ai_step.js";
import { asset } from "../../table/library/asset.js";
import { blobAsResource } from "../library/media.js";
import { KB_EMBED_MODEL } from "../knowledge/absorb.js";
import { ANSWER_FROM, MOST_DISTANCE, NEAREST } from "../knowledge/nearest.js";

export type PlanError = { step: number; field: string; ref?: string; message: string };
export type RunStep = { kind: string; model: string; label: string; recipe_seq?: number; input: Record<string, unknown>; options: Record<string, unknown>; depends_on: number[] };
export type Plan = {
  ok: boolean; errors: PlanError[];
  steps: { seq: number; depends_on: number[]; inputs: string[]; knowledge: string[]; step_refs: number }[];
  run_steps?: RunStep[]; kb_steps?: number;
};

const PLAN_BODY = lam.file("../../../frontend/src/lib/rules/recipe-plan.ts");
const FILL_BODY = lam.file("../../../frontend/src/lib/rules/recipe-fill.ts");
const BROKEN = "This recipe couldn't be read. Open it in the editor and save it again.";

/**
 * Check a recipe's inputs and steps and work out what each step depends on. With `values` (a run's inputs; `{}` for an
 * empty form) or `estimate`, it also answers the run's steps, with every unknown length priced at its cap.
 */
export const planFn = defineFunction({
  name: "recipes/plan",
  description: "Read a recipe's references: errors, each step's dependencies, and with values the steps a run starts with.",
  input: { inputs: input.json(), steps: input.json(), values: input.json(), files_given: input.json(), build: input.bool() },
  stack: [
    s.set_var("plan_in", obj({
      inputs: withFilters(inp("inputs"), fl.safe_array()), steps: withFilters(inp("steps"), fl.safe_array()), values: inp("values"),
      files_given: withFilters(inp("files_given"), fl.safe_array()), kb_model: c.text(KB_EMBED_MODEL), kb_dimensions: c.int(KB_DIMENSIONS),
    })),
    s.conditional({ when: expr(inp("build"), "=", c.bool(true)), then: [s.update_var("plan_in", withFilters(ref("plan_in"), fl.set("mode", c.text("build"))))] }),
    s.lambda({ as: "planned", code: PLAN_BODY }),
    // A body that throws answers its error text rather than failing: only an object is a plan.
    s.precondition({ expr: expr(withFilters(ref("planned"), fl.is_object()), "=", c.bool(true)), error_type: "badrequest", error: c.text(BROKEN) }),
  ],
  response: ref("planned"),
  responseShape: {} as Plan,
});

/** A plan's first error, as a sentence: "Step 3: …". */
export const firstError = (plan: string, as: string) => [
  s.set_var(`${as}_first`, withFilters(ref(`${plan}.errors`), fl.safe_array(), fl.first())),
  s.set_var(as, withFilters(ref(`${as}_first`), fl.get("message", ""), fl.first_notnull(c.text("")), fl.to_text())),
  s.conditional({ when: expr(withFilters(ref(`${as}_first`), fl.get("step", 0), fl.first_notnull(c.int(0))), ">", c.int(0)), then: [
    s.update_var(as, withFilters(c.text("Step "), fl.concat(withFilters(ref(`${as}_first`), fl.get("step", 0))), fl.concat(c.text(": ")), fl.concat(ref(as)))),
  ] }),
];

/** Where each kind's file goes in what's sent to the model, and whether it's a list. */
const FILE_SLOT = { image: { key: "images", list: true }, video: { key: "image", list: false }, text: { key: "files", list: true }, transcribe: { key: "audio", list: false } } as const;
export const FILE_GONE = "The file this step uses from an earlier step isn't available any more. Run the recipe again.";
export const LIBRARY_FILE_WORDS = "The Library picture this starts from couldn't be read back on this server, so nothing was sent or charged. Open it in the Library and choose Use in a new run.";
/** How long a Library picture's link lasts while the step reads it. */
const LIBRARY_READ_SECONDS = 60;

/**
 * Just before a recipe step is sent: fill its words from the earlier steps it names and the passages found for any pick
 * from Knowledge, and hand it an earlier step's file. Answers ok, or why it can't run (nothing has been sent).
 */
export const fillStepFn = defineFunction({
  name: "recipes/fill_step",
  description: "Finish a step's prompt from earlier outputs and Knowledge passages, and attach an earlier step's file or a Library picture.",
  input: { step_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: ai_step, fieldValue: inp("step_id"), output: ["id", "run_id", "kind", "input"], as: "step" }),
    guard.found("step", { message: "No such step." }),
    s.set_var("asked", withFilters(ref("step.input"), fl.first_notnull(c.obj({})))),
    s.set_var("fill", withFilters(ref("asked"), fl.get("fill", c.null()))),
    s.set_var("ok", c.bool(true)),
    s.set_var("detail", c.text("")),
    s.conditional({ when: expr(withFilters(ref("fill"), fl.is_object()), "=", c.bool(true)), then: [
      s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref("step.run_id")), output: ["seq", "kind", "status", "output", "input"], as: "siblings" }),
      s.set_var("outputs", c.obj({})),
      s.foreach({ list: ref("siblings"), as: "sib", body: [
        s.conditional({ when: expr(ref("sib.status"), "=", c.text("succeeded")), then: [
          s.set_var("sib_out", withFilters(ref("sib.output"), fl.first_notnull(c.obj({})))),
          s.update_var("outputs", withFilters(ref("outputs"), fl.set(withFilters(ref("sib.seq"), fl.to_text()), obj({
            text: withFilters(ref("sib_out"), fl.get("text", c.null())), json: withFilters(ref("sib_out"), fl.get("json", c.null())),
          })))),
        ] }),
      ] }),
      // Each pick from Knowledge: the passages nearest what was asked, in similarity order, numbered with where they're from.
      s.set_var("knowledge", c.obj({})),
      s.foreach({ list: withFilters(ref("fill"), fl.get("kb", c.array([])), fl.safe_array()), as: "kb", body: [
        s.array.find({ expr: ref("siblings"), as: "kb_step", if: expr(ref("$this.seq"), "=", ref("kb.seq")) }),
        s.set_var("asked_for", withFilters(ref("kb_step.input", { safe: true }), fl.get("input", c.array([])), fl.safe_array(), fl.first(), fl.first_notnull(c.text("")))),
        s.set_var("vector", withFilters(ref("kb_step.output", { safe: true }), fl.get("embeddings", c.array([])), fl.safe_array(), fl.first())),
        s.set_var("context", withFilters(c.text("Nothing in Knowledge was close to \""), fl.concat(ref("asked_for")), fl.concat(c.text("\".")))),
        s.conditional({ when: expr(withFilters(ref("vector"), fl.is_array()), "=", c.bool(true)), then: [
          s.db.query({ table: kb_passage, where: cmp(col("live"), "=", c.bool(true)),
            eval: [{ name: "embedding", as: "distance", filters: [qf.vector_cos_distance(ref("vector"))] }],
            sort: [{ sortBy: "distance", dir: "asc" }], paging: { per_page: NEAREST, metadata: false },
            output: ["id", "source_id", "text", "page", "start_s", "distance"], as: "hits" }),
          s.array.filter({ expr: ref("hits"), if: expr(ref("$this.distance"), "<=", c.decimal(MOST_DISTANCE)), as: "near_all" }),
          s.set_var("near", withFilters(ref("near_all"), fl.array_slice(0, ANSWER_FROM))),
          s.conditional({ when: expr(withFilters(ref("near"), fl.count()), ">", c.int(0)), then: [
            s.array.map({ source: ref("near"), as: "near_sources", transform: ref("$this.source_id") }),
            s.db.query({ table: kb_source, where: cmp(col("id"), "in", ref("near_sources")), output: ["id", "title"], paging: { per_page: ANSWER_FROM, metadata: false }, as: "titles" }),
            s.update_var("context", c.text("")),
            s.set_var("number", c.int(0)),
            s.foreach({ list: ref("near"), as: "hit", body: [
              s.update_var("number", withFilters(ref("number"), fl.add(1))),
              s.array.find({ expr: ref("titles"), as: "hit_source", if: expr(ref("$this.id"), "=", ref("hit.source_id")) }),
              s.update_var("context", withFilters(ref("context"), fl.concat(c.text("[")), fl.concat(ref("number")), fl.concat(c.text("] (")),
                fl.concat(withFilters(ref("hit_source.title", { safe: true }), fl.first_notnull(c.text("A source")))), fl.concat(c.text(")\n")), fl.concat(ref("hit.text")), fl.concat(c.text("\n\n")))),
            ] }),
          ] }),
        ] }),
        s.update_var("knowledge", withFilters(ref("knowledge"), fl.set(ref("kb.name"), ref("context")))),
      ] }),
      s.set_var("fill_in", obj({ fill: ref("fill"), outputs: ref("outputs"), knowledge: ref("knowledge") })),
      s.lambda({ as: "filled", code: FILL_BODY }),
      s.precondition({ expr: expr(withFilters(ref("filled"), fl.is_object()), "=", c.bool(true)), error_type: "badrequest", error: c.text(BROKEN) }),
      s.set_var("fields", withFilters(ref("filled.fields"), fl.first_notnull(c.obj({})))),
      ...["prompt", "system", "instructions", "negative_prompt"].map((field) => s.conditional({ when: expr(withFilters(ref("fields"), fl.has(field)), "=", c.bool(true)), then: [
        field === "prompt"
          ? s.conditional({
            when: expr(withFilters(ref("fill"), fl.get("speech", false), fl.first_notnull(c.bool(false))), "=", c.bool(true)),
            then: [s.update_var("asked", withFilters(ref("asked"), fl.set("text", withFilters(ref("fields"), fl.get("prompt", "")))))],
            else: [s.update_var("asked", withFilters(ref("asked"), fl.set("prompt", withFilters(ref("fields"), fl.get("prompt", "")))))],
          })
          : s.update_var("asked", withFilters(ref("asked"), fl.set(field, withFilters(ref("fields"), fl.get(field, ""))))),
      ] })),
      // An earlier step's file: what the model made there, while it's still on hand.
      s.set_var("file_from", withFilters(ref("fill"), fl.get("file_from", 0), fl.first_notnull(c.int(0)), fl.to_int())),
      s.conditional({ when: expr(ref("file_from"), ">", c.int(0)), then: [
        s.array.find({ expr: ref("siblings"), as: "from", if: expr(ref("$this.seq"), "=", ref("file_from")) }),
        s.set_var("made", withFilters(ref("from.output", { safe: true }), fl.get("resource", c.null()))),
        s.conditional({
          when: [expr(ref("from.status", { safe: true }), "=", c.text("succeeded")), expr(withFilters(ref("made"), fl.empty()), "=", c.bool(false))],
          then: [
            s.switch({ on: ref("step.kind"), cases: Object.entries(FILE_SLOT).map(([kind, slot]) => ({ when: c.text(kind), break: true, body: [
              s.update_var("asked", withFilters(ref("asked"), fl.set(slot.key, slot.list ? withFilters(c.array([]), fl.append(ref("made"), c.text(""))) : ref("made")))),
            ] })) }),
            s.update_var("asked", withFilters(ref("asked"), fl.set("sources", withFilters(c.array([]), fl.append(obj({ name: withFilters(c.text("Step "), fl.concat(ref("file_from")), fl.concat(c.text("'s output"))), from_step: ref("file_from") }), c.text("")))))),
          ],
          else: [s.update_var("ok", c.bool(false)), s.update_var("detail", c.text(FILE_GONE))],
        }),
      ] }),
      s.db.patch({ table: ai_step, fieldValue: inp("step_id"), data: obj({ input: ref("asked") }) }),
    ] }),
    // A Library picture an agent or Easel started an image or a video from: read from storage just before the call and handed
    // over as the image to edit or the first frame. A file that can't be read fails the step before anything is sent.
    s.set_var("from_library", withFilters(ref("asked"), fl.get("library_picture", 0), fl.first_notnull(c.int(0)), fl.to_int())),
    s.set_var("library_slot", withFilters(c.obj({ image: "images", video: "image" }), fl.get(ref("step.kind"), ""))),
    s.conditional({ when: [expr(ref("ok"), "=", c.bool(true)), expr(ref("from_library"), ">", c.int(0)), expr(ref("library_slot"), "!=", c.text("")),
      expr(withFilters(ref("asked"), fl.get(ref("library_slot"), c.null()), fl.empty()), "=", c.bool(true))], then: [
      s.set_var("library_file", c.null()),
      s.db.get({ table: asset, fieldValue: ref("from_library"), output: ["id", "kind", "file"], as: "picture" }),
      s.set_var("picture_path", withFilters(ref("picture.file", { safe: true }), fl.get("path", ""), fl.first_notnull(c.text("")))),
      s.set_var("picture_name", withFilters(c.text("library-"), fl.concat(ref("from_library")), fl.concat(c.text(".")),
        fl.concat(withFilters(ref("picture.file", { safe: true }), fl.get("mime", "image/png"), fl.first_notnull(c.text("image/png")), fl.split("/"), fl.last(), fl.string_replace("jpeg", "jpg"))))),
      // A picture kept in a table (where this server can't sign links) becomes a file again straight from its bytes.
      s.set_var("picture_blob", withFilters(ref("picture.file", { safe: true }), fl.get("blob_id", 0), fl.first_notnull(c.int(0)), fl.to_int())),
      s.conditional({ when: expr(ref("picture_blob"), ">", c.int(0)), then: [
        s.try_catch({ try: [
          ...blobAsResource(ref("picture_blob"), ref("picture_name"), "blob_file"),
          s.conditional({ when: expr(ref("blob_file"), "!=", c.null()), then: [s.update_var("library_file", ref("blob_file"))] }),
        ], catch: [] }),
      ] }),
      s.conditional({ when: expr(ref("picture_path"), "!=", c.text("")), then: [
        s.try_catch({ try: [
          s.storage.sign_private_url({ pathname: ref("picture_path"), ttl: c.int(LIBRARY_READ_SECONDS), as: "picture_url" }),
          s.api.request({ url: ref("picture_url"), method: "GET", timeout: 60, as: "fetched" }),
          s.conditional({ when: expr(ref("fetched.response.status"), "=", c.int(200)), then: [
            s.storage.create_file_resource({ filename: ref("picture_name"), filedata: ref("fetched.response.result"), as: "made_file" }),
            s.update_var("library_file", ref("made_file")),
          ] }),
        ], catch: [] }),
      ] }),
      s.conditional({
        when: expr(ref("library_file"), "=", c.null()),
        then: [s.update_var("ok", c.bool(false)), s.update_var("detail", c.text(LIBRARY_FILE_WORDS))],
        else: [
          s.conditional({
            when: expr(ref("step.kind"), "=", c.text("image")),
            then: [s.update_var("asked", withFilters(ref("asked"), fl.set("images", withFilters(c.array([]), fl.append(ref("library_file"), c.text(""))))))],
            else: [s.update_var("asked", withFilters(ref("asked"), fl.set("image", ref("library_file"))))],
          }),
          s.db.patch({ table: ai_step, fieldValue: inp("step_id"), data: obj({ input: ref("asked") }) }),
        ],
      }),
    ] }),
  ],
  response: { ok: ref("ok"), detail: ref("detail") },
  responseShape: {} as { ok: boolean; detail: string },
});
