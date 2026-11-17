// Knowledge, with a stub in the model's seat: each test adds a source or asks a question with the real functions, claims
// each step, and records what a wrapper would have answered (pages as JSON, transcript lines, vectors, an answer). Nothing
// here calls a model. Embeddings are hand-made 768-dimension vectors, so distances can be worked out by hand: two unit
// vectors on different axes are 1 apart, and a question at (0.8, 0.6) is 0.2 from the first axis and 0.4 from the second.
import { c, cmp, col, fl, obj, ref, s, withFilters, type Statement, type Value } from "@xano/sdk";
import { notification, workspace_setting } from "../base/tables.js";
import { kb_passage } from "../table/knowledge/kb_passage.js";
import { kb_source } from "../table/knowledge/kb_source.js";
import { ai_step } from "../table/studio/ai_step.js";
import { ledger } from "../table/studio/ledger.js";
import { asset } from "../table/library/asset.js";
import { user } from "../table/user.js";
import { claimStepFn, recordStepFn } from "../function/runs/execute_step.js";
import { KB_WORDS } from "../function/knowledge/absorb.js";
import { ASK_WORDS, askComposeFn, askRetrieveFn, askStartFn, askViewFn, recentQuestionsFn } from "../function/knowledge/ask.js";
import { ADD_DENIED, RETRY_WORDS, addSourceFn, retrySourceFn } from "../function/knowledge/ingest.js";
import { SETTLE_WORDS, tidySourcesFn } from "../function/knowledge/settle.js";
import { $, equal, is, ledgerAgrees, num, person, priceRow, says, plainTest, settings, workflowTest } from "./fixtures.js";

const DIMS = 768;
const axis = (i: number) => Array.from({ length: DIMS }, (_, k) => (k === i ? 1 : 0));
/** A question 0.2 from the first axis and 0.4 from the second, and 1 from every other. */
const BETWEEN = Array.from({ length: DIMS }, (_, k) => (k === 0 ? 0.8 : k === 1 ? 0.6 : 0));

/** The two models Knowledge uses, at test prices: $1 in and $2 out per 1M tokens, and $1 per 1M embedded. */
const knowledgePrices = [
  priceRow("gemini-3.8-flash", "text", "input_token", 1 * $),
  priceRow("gemini-3.8-flash", "text", "output_token", 2 * $),
  priceRow("gemini-embedding-2", "embedding", "input_token", 1 * $, "text"),
];

type Result = { outcome: string; reason?: string; detail?: string; output?: Value; usage?: Record<string, number> };
/** Claim a step with the real function, then record what its wrapper answered: the model's seat. */
const run = (step: string, r: Result, attempt = 1): Statement[] => [
  s.function.run({ fn: claimStepFn, as: `${step}_claim${attempt}`, input: { step_id: ref(`${step}.id`), attempt: c.int(attempt) } }),
  is(`${step}_claim${attempt}.status`, "sent"),
  s.function.run({ fn: recordStepFn, as: `${step}_rec${attempt}`, input: {
    step_id: ref(`${step}.id`), attempt: c.int(attempt), outcome: c.text(r.outcome), reason: c.text(r.reason ?? ""), detail: c.text(r.detail ?? ""),
    refused: c.bool(false), output: r.output ?? c.obj({}), usage: c.obj(r.usage ?? {}), brand_applied: c.bool(false), sent_prompt: c.text(""),
  } }),
];
/** The source's run's steps by seq, bound to step1, step2, … */
const stepsOfSource = (source: string, n: number) => [
  s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref(`${source}.run_id`)), sort: [{ sortBy: "seq", dir: "asc" }], as: "steps" }),
  ...Array.from({ length: n }, (_, i) => s.set_var(`step${i + 1}`, withFilters(ref("steps"), fl.get(String(i))))),
];
const reloadSource = (as: string, id: Value) => s.db.get({ table: kb_source, fieldValue: id, as });
const reloadStep = (as: string, step: string) => s.db.get({ table: ai_step, fieldValue: ref(`${step}.id`), as });
/** Upload `data` as a file named `name`, the way the upload route hands it on. */
const add = (as: string, who: string, name: string, data: string, key = "k1") => [
  s.storage.create_file_resource({ filename: c.text(name), filedata: c.text(data), as: `${as}_file` }),
  s.function.run({ fn: addSourceFn, as: `${as}_id`, input: {
    actor_id: ref(`${who}.id`), file: ref(`${as}_file`), title: c.text(""), idem_key: c.text(key), via: c.text("ui"), base_url: c.text(""),
  } }),
  reloadSource(as, ref(`${as}_id`)),
];
/** `n` copies of one vector, as an embedding step's output. */
const vectors = (as: string, n: number, v: number[] = axis(5)) => [
  s.set_var(`${as}_one`, c.array(v as never)),
  s.array.map({ source: withFilters(c.int(0), fl.range(1, n)), as: `${as}_list`, transform: ref(`${as}_one`) }),
  s.set_var(as, obj({ embeddings: ref(`${as}_list`), count: c.int(n), dimensions: c.int(DIMS) })),
];
const countRows = (as: string, table: typeof kb_passage | typeof ledger | typeof ai_step, where: ReturnType<typeof cmp>[] = []) =>
  s.db.query({ table, where, returnType: "count", as });

/** A PDF's bytes as far as Knowledge looks at them: `pages` page objects, with or without fonts. */
const pdf = (pages: number, fonts = true) => [
  "%PDF-1.4",
  ...Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R ${fonts ? "/Resources << /Font << /F1 1 0 R >> >>" : "/Resources << /XObject << /Im1 9 0 R >> >>"} >> endobj`),
  `2 0 obj << /Type /Pages /Count ${pages} >> endobj`,
  fonts ? "" : "9 0 obj << /Type /XObject /Subtype /Image /Width 800 >> endobj",
  "%%EOF",
].join("\n");
/** A compressed PDF: its page objects are inside object streams, so the file doesn't say how many there are. */
const compressedPdf = "%PDF-1.5\n1 0 obj << /Type /ObjStm /N 12 /First 80 /Filter /FlateDecode >> stream\nx\x9c\nendstream endobj\n%%EOF";
/** What the reading step returns for pages `from` to `to`: one short paragraph each. */
const pagesReply = (from: number, to: number, total: number, empty = false) => c.obj({
  json: { total_pages: total, pages: Array.from({ length: to - from + 1 }, (_, i) => ({ page: from + i, markdown: empty ? "" : `## Page ${from + i}\n\nThe Trail 2 detail on page ${from + i}.` })) },
  finish_reason: "stop",
} as never);

/** A ready source with three live passages on three axes, as a finished upload leaves it. */
const readySource = (who: string) => [
  s.db.add({ table: kb_source, as: "guide", row: {
    title: c.text("Marlow size guide"), kind: c.text("document"), format: c.text("pdf"), file_name: c.text("size-guide.pdf"), mime: c.text("application/pdf"), size: c.int(1000),
    pages: c.int(3), duration_s: c.int(0), status: c.text("ready"), detail: c.text(""), run_id: c.int(0), added_by: ref(`${who}.id`), passages: c.int(3), is_demo: c.bool(false),
  } }),
  ...["Medium fits riders 170 to 178 cm.", "Between sizes, choose the smaller frame.", "The warranty covers the frame for life."].map((text, i) =>
    s.db.add({ table: kb_passage, as: `p${i + 1}`, row: {
      source_id: ref("guide.id"), seq: c.int(i + 1), text: c.text(text), page: c.int(i + 1), start_s: c.int(-1), speaker: c.text(""), batch: c.int(0),
      embedding: c.array(axis(i) as never), live: c.bool(true),
    } })),
];
/** Start an Ask, binding its steps to `<as>_s1`, `<as>_s2`, `<as>_s3`. */
const ask = (as: string, who: string, question: string, key: string) => [
  s.function.run({ fn: askStartFn, as, input: { actor_id: ref(`${who}.id`), question: c.text(question), idem_key: c.text(key), via: c.text("ui"), connection_id: c.int(0) } }),
  s.db.query({ table: ai_step, where: cmp(col("run_id"), "=", ref(`${as}.run.id`)), sort: [{ sortBy: "seq", dir: "asc" }], as: `${as}_steps` }),
  ...[1, 2, 3].map((n) => s.set_var(`${as}_s${n}`, withFilters(ref(`${as}_steps`), fl.get(String(n - 1))))),
];
const embedQuestion = (as: string, v: number[]) => [
  s.set_var(`${as}_vector`, obj({ embeddings: withFilters(c.array([]), fl.append(c.array(v as never), c.text(""))), count: c.int(1), dimensions: c.int(DIMS) })),
  ...run(`${as}_s1`, { outcome: "succeeded", output: ref(`${as}_vector`), usage: { input_tokens: 12 } }),
];
const retrieve = (as: string, run: string) => s.function.run({ fn: askRetrieveFn, as, input: { run_id: ref(`${run}.run.id`) } });
const compose = (as: string, run: string) => s.function.run({ fn: askComposeFn, as, input: { run_id: ref(`${run}.run.id`) } });
const view = (as: string, run: string) => s.function.run({ fn: askViewFn, as, input: { run_id: ref(`${run}.run.id`) } });
const answer = (text: string, cited: number[]) => c.obj({ text, json: { answer: text, cited }, finish_reason: "stop" } as never);
const truthy = (path: string) => s.expect.to_be_true({ expr: ref(path) });
const size = (path: string, n: number) => s.expect.to_equal({ expr: withFilters(ref(path), fl.count()), value: c.int(n) });

const LONG_TURN = "Medium rides long. ".repeat(36).trim();

export const knowledgeTests = [
  workflowTest({
    name: "knowledge: a Markdown file becomes passages at once, embedded in batches of 50, and is ready when every batch is in",
    stack: [
      settings(), person("priya"), ...knowledgePrices,
      // 52 paragraphs of about 715 characters: no two fit one 1,200-character passage, so each is its own.
      ...add("doc", "priya", "handbook.md", Array.from({ length: 52 }, (_, i) => `Paragraph ${i + 1}. ${"Ride the Trail 2 further. ".repeat(27).trim()}`).join("\n\n")),
      is("doc.status", "processing"), is("doc.kind", "document"), is("doc.format", "markdown"), is("doc.title", "handbook"),
      countRows("made", kb_passage), num("made", 52),
      countRows("first_batch", kb_passage, [cmp(col("batch"), "=", c.int(1))]), num("first_batch", 50),
      ...stepsOfSource("doc", 2),
      is("step1.kind", "embedding"), is("step1.input.task_type", "RETRIEVAL_DOCUMENT"), num("step1.input.dimensions", 768),
      equal("step2.input.input.1", c.text(`Paragraph 52. ${"Ride the Trail 2 further. ".repeat(27).trim()}`)),
      ...vectors("fifty", 50), ...vectors("two", 2),
      ...run("step1", { outcome: "succeeded", output: ref("fifty"), usage: { input_tokens: 9000 } }),
      reloadSource("halfway", ref("doc.id")), is("halfway.status", "processing"),
      ...run("step2", { outcome: "succeeded", output: ref("two"), usage: { input_tokens: 400 } }),
      reloadSource("after", ref("doc.id")),
      is("after.status", "ready"), num("after.passages", 52),
      countRows("live", kb_passage, [cmp(col("live"), "=", c.bool(true))]), num("live", 52),
      s.db.query({ table: notification, where: [cmp(col("user_id"), "=", ref("priya.id")), cmp(col("kind"), "=", c.text("knowledge"))], returnType: "single", as: "told" }),
      is("told.title", "handbook is ready to ask about"),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "knowledge: a source that fails after its passages were made never puts them live, and the sweep clears them",
    stack: [
      settings(), person("priya"), ...knowledgePrices,
      ...add("doc", "priya", "handbook.md", Array.from({ length: 52 }, (_, i) => `Paragraph ${i + 1}. ${"Ride the Trail 2 further. ".repeat(27).trim()}`).join("\n\n")),
      ...stepsOfSource("doc", 2),
      ...vectors("fifty", 50),
      ...run("step1", { outcome: "succeeded", output: ref("fifty"), usage: { input_tokens: 9000 } }),
      ...run("step2", { outcome: "blocked", reason: "blocked", detail: "The model declined.", usage: {} }),
      reloadSource("after", ref("doc.id")), is("after.status", "failed"), is("after.detail", SETTLE_WORDS.blocked),
      countRows("live", kb_passage, [cmp(col("live"), "=", c.bool(true))]), num("live", 0),
      countRows("left", kb_passage), num("left", 52),
      s.function.run({ fn: tidySourcesFn, as: "tidied" }),
      countRows("kept", kb_passage), num("kept", 0),
    ],
  }),

  workflowTest({
    name: "knowledge: a 20-page PDF is read five pages a step, becomes passages with page numbers, and is ready",
    stack: [
      settings(), person("sam"), ...knowledgePrices,
      ...add("doc", "sam", "Size guide.pdf", pdf(20)),
      is("doc.format", "pdf"), num("doc.pages", 20), is("doc.title", "Size guide"),
      ...stepsOfSource("doc", 8),
      countRows("planned", ai_step, [cmp(col("run_id"), "=", ref("doc.run_id"))]), num("planned", 8),
      is("step1.kind", "text"), num("step1.input.kb.from", 1), num("step1.input.kb.to", 5), num("step7.input.kb.from", 16), num("step7.input.kb.to", 20),
      is("step2.kind", "embedding"),
      ...[0, 1, 2, 3].flatMap((r) => [
        ...run(`step${2 * r + 1}`, { outcome: "succeeded", output: pagesReply(5 * r + 1, 5 * r + 5, 20), usage: { input_tokens: 5700, output_tokens: 900 } }),
        // What the range read is now the embedding step's input.
        reloadStep(`filled${r}`, `step${2 * r + 2}`),
        equal(`filled${r}.input.input.0`, c.text(`## Page ${5 * r + 1}\n\nThe Trail 2 detail on page ${5 * r + 1}.`)),
        ...vectors(`v${r}`, 5),
        ...run(`step${2 * r + 2}`, { outcome: "succeeded", output: ref(`v${r}`), usage: { input_tokens: 60 } }),
      ]),
      reloadSource("after", ref("doc.id")),
      is("after.status", "ready"), num("after.passages", 20),
      s.db.query({ table: kb_passage, where: cmp(col("source_id"), "=", ref("doc.id")), sort: [{ sortBy: "seq", dir: "asc" }], as: "rows" }),
      num("rows.12.page", 13), says("rows.12.text", "The Trail 2 detail on page 13."),
      // Reading a source is working data: none of it becomes a library item.
      s.db.query({ table: asset, returnType: "count", as: "items" }), num("items", 0),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "knowledge: a PDF that doesn't say its page count is planned for the most, and the first range releases the rest",
    stack: [
      settings(), person("sam"), ...knowledgePrices,
      ...add("doc", "sam", "brochure.pdf", compressedPdf),
      num("doc.pages", 0),
      ...stepsOfSource("doc", 2),
      countRows("planned", ai_step, [cmp(col("run_id"), "=", ref("doc.run_id"))]), num("planned", 20),
      ...run("step1", { outcome: "succeeded", output: pagesReply(1, 3, 3), usage: { input_tokens: 2000, output_tokens: 300 } }),
      reloadSource("counted", ref("doc.id")), num("counted.pages", 3),
      // Ranges from page 6 on, and their embeddings: 18 steps, released before anything was sent.
      countRows("let_go", ai_step, [cmp(col("run_id"), "=", ref("doc.run_id")), cmp(col("status"), "=", c.text("released"))]), num("let_go", 18),
      ...vectors("three", 3),
      ...run("step2", { outcome: "succeeded", output: ref("three"), usage: { input_tokens: 40 } }),
      reloadSource("after", ref("doc.id")), is("after.status", "ready"), num("after.passages", 3),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "knowledge: a scanned PDF with no text layer fails before anything is sent or charged",
    stack: [
      settings(), person("sam"), ...knowledgePrices,
      ...add("doc", "sam", "Warranty terms 2027.pdf", pdf(3, false)),
      is("doc.status", "failed"), is("doc.detail", KB_WORDS.scan), num("doc.run_id", 0),
      countRows("held", ledger), num("held", 0),
    ],
  }),

  workflowTest({
    name: "knowledge: a PDF whose first pages come back with no text fails as a scan, and the rest isn't sent",
    stack: [
      settings(), person("sam"), ...knowledgePrices,
      ...add("doc", "sam", "photos.pdf", pdf(8)),
      ...stepsOfSource("doc", 4),
      ...run("step1", { outcome: "succeeded", output: pagesReply(1, 5, 8, true), usage: { input_tokens: 2000, output_tokens: 50 } }),
      reloadStep("read", "step1"), is("read.status", "failed"), is("read.reason", "no_text"),
      reloadStep("rest", "step3"), is("rest.status", "released"),
      reloadSource("after", ref("doc.id")), is("after.status", "failed"), is("after.detail", KB_WORDS.scan),
      countRows("kept", kb_passage), num("kept", 0),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "knowledge: a PDF range that ends at max_tokens fails the source as too long, and it never becomes ready",
    stack: [
      settings(), person("sam"), ...knowledgePrices,
      ...add("doc", "sam", "catalogue.pdf", pdf(10)),
      ...stepsOfSource("doc", 4),
      // The text wrapper's answer when the JSON was cut off at the length limit.
      ...run("step1", { outcome: "failed", reason: "bad_json", detail: "The model's reply wasn't valid JSON. It was still charged.",
        output: c.obj({ text: "{\"total_pages\": 10, \"pages\": [{\"page\": 1, \"markdown\": \"## Cata", finish_reason: "max_tokens" }), usage: { input_tokens: 3000, output_tokens: 12000 } }),
      reloadStep("read", "step1"), is("read.reason", "too_long"),
      reloadStep("second", "step3"), is("second.status", "released"),
      reloadSource("after", ref("doc.id")),
      is("after.status", "failed"), is("after.detail", KB_WORDS.tooLong), num("after.passages", 0),
      countRows("kept", kb_passage), num("kept", 0),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "knowledge: a recording becomes passages that start at their speaker's turn, and is ready",
    stack: [
      settings(), person("priya"), ...knowledgePrices,
      ...add("call", "priya", "Call with Halden Cycles.mp3", "ID3 recorded call"),
      is("call.kind", "recording"), is("call.format", "audio"), is("call.title", "Call with Halden Cycles"),
      ...stepsOfSource("call", 2),
      is("step1.input.response_format", "json"), is("step1.input.kb.part", "recording"),
      ...run("step1", { outcome: "succeeded", usage: { input_tokens: 2100, output_tokens: 400 }, output: c.obj({ finish_reason: "stop", json: { lines: [
        { start: 0, speaker: "Speaker 1", text: "Thanks for making time today." },
        { start: 252, speaker: "Speaker 2", text: LONG_TURN },
      ] } } as never) }),
      s.db.query({ table: kb_passage, where: cmp(col("source_id"), "=", ref("call.id")), sort: [{ sortBy: "seq", dir: "asc" }], as: "rows" }),
      size("rows", 2),
      num("rows.1.start_s", 252), is("rows.1.speaker", "Speaker 2"), says("rows.1.text", "Speaker 2: Medium rides long."),
      ...vectors("two", 2),
      ...run("step2", { outcome: "succeeded", output: ref("two"), usage: { input_tokens: 200 } }),
      reloadSource("after", ref("call.id")),
      // The last turn starts at 252 and has 108 words: 44 seconds at 2.5 words a second, rounded up.
      is("after.status", "ready"), num("after.duration_s", 296),
    ],
  }),

  workflowTest({
    name: "knowledge: with no rerank model, the rerank step is skipped by design and the answer cites only passages it was given",
    stack: [
      settings(), person("sam"), ...knowledgePrices, ...readySource("sam"),
      ...ask("q", "sam", "Which size fits 175 cm?", "a1"),
      is("q.run.status", "queued"),
      is("q_s2.kind", "rerank"), is("q_s2.status", "skipped"), is("q_s2.reason", "unavailable"), is("q_s2.detail", ASK_WORDS.rerankUnpriced),
      ...embedQuestion("q", BETWEEN),
      retrieve("found", "q"), num("found.found", 2),
      compose("composed", "q"), is("composed.ranking", "similarity"),
      equal("composed.passages", withFilters(c.array([]), fl.append(ref("p1.id"), c.text("")), fl.append(ref("p2.id"), c.text("")))),
      reloadStep("answer_step", "q_s3"),
      says("answer_step.input.prompt", "[1] (Marlow size guide, page 1)\nMedium fits riders 170 to 178 cm."),
      says("answer_step.input.prompt", "[2] (Marlow size guide, page 2)\nBetween sizes, choose the smaller frame."),
      // It cites passage 1, and 7, which it was never given.
      ...run("q_s3", { outcome: "succeeded", output: answer("Riders 170 to 178 cm fit a Medium [1].", [1, 7]), usage: { input_tokens: 900, output_tokens: 120 } }),
      view("v", "q"),
      is("v.state", "answered"), is("v.ranking", "similarity"), is("v.answer", "Riders 170 to 178 cm fit a Medium [1]."),
      size("v.citations", 1),
      equal("v.citations.0.passage_id", ref("p1.id")), num("v.citations.0.page", 1), is("v.citations.0.title", "Marlow size guide"),
      // A document has no recording to play.
      s.expect.to_be_false({ expr: ref("v.citations.0.has_audio") }),
      num("v.sources_used", 1), num("v.sources_total", 1),
      s.db.query({ table: asset, returnType: "count", as: "items" }), num("items", 0),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "knowledge: a question with nothing close enough says it couldn't find it, cites nothing, and sends no answer",
    stack: [
      settings(), person("sam"), ...knowledgePrices, ...readySource("sam"),
      ...ask("q", "sam", "What's the cafe's opening time?", "a1"),
      ...embedQuestion("q", axis(9)),
      retrieve("found", "q"), num("found.found", 0),
      reloadStep("answer_step", "q_s3"), is("answer_step.status", "released"), is("answer_step.reason", "no_match"), num("answer_step.charged", 0),
      view("v", "q"),
      is("v.state", "not_found"), is("v.answer", ASK_WORDS.notFound), size("v.citations", 0),
      ...ledgerAgrees(),
    ],
  }),

  workflowTest({
    name: "knowledge: once the gateway refuses rerank, the answer is ranked by similarity and later questions skip rerank",
    stack: [
      settings(), person("sam"), ...knowledgePrices, ...readySource("sam"),
      ...ask("q", "sam", "Which size fits 175 cm?", "a1"),
      ...embedQuestion("q", BETWEEN),
      retrieve("found", "q"),
      // Rerank has no price today, so it can't be reserved and sent here: this is the step as a refusal leaves it.
      s.db.patch({ table: ai_step, fieldValue: ref("q_s2.id"), data: obj({ status: c.text("failed"), reason: c.text("unavailable"),
        detail: c.text("Xano AI can't serve this model yet, so nothing was made or charged. Pick another model.") }) }),
      compose("composed", "q"), is("composed.ranking", "similarity"),
      s.db.query({ table: workspace_setting, returnType: "single", as: "remembered" }),
      truthy("remembered.rerank_unavailable"),
      ...ask("again", "sam", "And for 180 cm?", "a2"),
      is("again_s2.status", "skipped"), is("again_s2.detail", ASK_WORDS.rerankRefused),
    ],
  }),

  workflowTest({
    name: "knowledge: a guest asks and gets the same passages as a member, and can't add a source",
    stack: [
      settings(), person("sam"), person("alex", "guest"), ...knowledgePrices, ...readySource("sam"),
      // The body runs on its own variables, so it finds the guest itself.
      s.expect.to_throw({ exception: c.text(ADD_DENIED), body: [
        s.db.query({ table: user, where: cmp(col("role"), "=", c.text("guest")), returnType: "single", as: "guest" }),
        ...add("nope", "guest", "notes.md", "A note from a guest."),
      ] }),
      countRows("passages", kb_passage), num("passages", 3),
      ...ask("mine", "sam", "Which size fits 175 cm?", "a1"),
      ...embedQuestion("mine", BETWEEN),
      retrieve("mine_found", "mine"),
      ...ask("theirs", "alex", "Which size fits 175 cm?", "a1"),
      is("theirs.run.status", "queued"),
      ...embedQuestion("theirs", BETWEEN),
      retrieve("theirs_found", "theirs"),
      num("theirs_found.found", 2),
      reloadStep("mine_answer", "mine_s3"), reloadStep("theirs_answer", "theirs_s3"),
      equal("theirs_answer.input.kb_candidates", ref("mine_answer.input.kb_candidates")),
    ],
  }),

  plainTest({
    name: "knowledge: recent questions list only your own, newest first, with the answer and citations they were given",
    stack: [
      settings(), person("sam"), person("alex", "guest"), person("priya"), ...knowledgePrices, ...readySource("sam"),
      ...ask("first", "sam", "Which size fits 175 cm?", "a1"),
      ...embedQuestion("first", BETWEEN), retrieve("first_found", "first"), compose("first_composed", "first"),
      ...run("first_s3", { outcome: "succeeded", output: answer("Riders 170 to 178 cm fit a Medium [1].", [1]), usage: { input_tokens: 900, output_tokens: 120 } }),
      ...ask("second", "sam", "What's the cafe's opening time?", "a2"),
      ...embedQuestion("second", axis(9)), retrieve("second_found", "second"),
      ...ask("theirs", "alex", "Is the frame covered for life?", "a3"),
      s.function.run({ fn: recentQuestionsFn, as: "sams", input: { actor_id: ref("sam.id") } }),
      size("sams.items", 2),
      // Newest first: the question nothing answered, then the one answered from the size guide.
      is("sams.items.0.question", "What's the cafe's opening time?"), is("sams.items.0.state", "not_found"),
      is("sams.items.1.question", "Which size fits 175 cm?"), is("sams.items.1.state", "answered"),
      is("sams.items.1.answer", "Riders 170 to 178 cm fit a Medium [1]."), is("sams.items.1.citations.0.title", "Marlow size guide"),
      equal("sams.items.1.run_id", ref("first.run.id")), s.expect.to_be_greater_than({ expr: ref("sams.items.1.created_at"), value: c.int(0) }),
      s.function.run({ fn: recentQuestionsFn, as: "alexs", input: { actor_id: ref("alex.id") } }),
      size("alexs.items", 1), is("alexs.items.0.question", "Is the frame covered for life?"),
      s.function.run({ fn: recentQuestionsFn, as: "priyas", input: { actor_id: ref("priya.id") } }),
      size("priyas.items", 0),
    ],
  }),

  workflowTest({
    name: "knowledge: when only an embedding call fails, what was read is kept and whoever added it can retry it to ready",
    stack: [
      settings(), person("priya"), person("sam"), ...knowledgePrices,
      ...add("doc", "priya", "handbook.md", Array.from({ length: 52 }, (_, i) => `Paragraph ${i + 1}. ${"Ride the Trail 2 further. ".repeat(27).trim()}`).join("\n\n")),
      ...stepsOfSource("doc", 2),
      // The gateway couldn't be reached for the first batch (the mapper's words for a connection error).
      ...run("step1", { outcome: "failed", reason: "model_error", detail: "The model didn't finish this one. It was sent, so it may be charged. Try again." }),
      ...vectors("two", 2),
      ...run("step2", { outcome: "succeeded", output: ref("two"), usage: { input_tokens: 400 } }),
      reloadSource("failed", ref("doc.id")),
      is("failed.status", "failed"), is("failed.detail", SETTLE_WORDS.embedding), truthy("failed.can_retry"),
      countRows("kept", kb_passage), num("kept", 52),
      // Someone else can't retry it; they can upload it again.
      s.expect.to_throw({ exception: c.text(RETRY_WORDS.notYours), body: [
        s.db.query({ table: user, where: cmp(col("email"), "=", c.text("sam@studio-test.example")), returnType: "single", as: "other" }),
        s.db.query({ table: kb_source, returnType: "single", as: "theirs" }),
        s.function.run({ fn: retrySourceFn, as: "nope", input: { source_id: ref("theirs.id"), actor_id: ref("other.id"), key: c.text("r1") } }),
      ] }),
      s.function.run({ fn: retrySourceFn, as: "retried", input: { source_id: ref("doc.id"), actor_id: ref("priya.id"), key: c.text("r1") } }),
      reloadSource("again", ref("doc.id")), is("again.status", "processing"),
      reloadStep("step1", "step1"), num("step1.attempt", 2), is("step1.status", "queued"),
      ...vectors("fifty", 50),
      ...run("step1", { outcome: "succeeded", output: ref("fifty"), usage: { input_tokens: 9000 } }, 2),
      reloadSource("after", ref("doc.id")),
      is("after.status", "ready"), num("after.passages", 52), s.expect.to_be_false({ expr: ref("after.can_retry") }),
      countRows("live", kb_passage, [cmp(col("live"), "=", c.bool(true))]), num("live", 52),
      ...ledgerAgrees(),
    ],
  }),
];
