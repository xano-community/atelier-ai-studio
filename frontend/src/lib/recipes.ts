// Recipes on the frontend: the API, the editor's rules and the words a recipe or a run shows. The reference rules are
// the server's own (xano/lambdas/recipe-plan.ts), run here as they are, so the editor marks exactly what saving refuses.
import type { InferResponse } from "@xano/sdk";
import type {
  apiRunRecipeRoute, estimateRecipeRoute, listRecipesRoute, readRecipeRoute, recipeRunsRoute, runDetailsRoute,
} from "../../../xano/query/recipes.js";
import type { createKeyRoute, listKeysRoute } from "../../../xano/query/keys.js";
import planBody from "./rules/recipe-plan";
import { routePath } from "../../../xano/routes.gen.js";
import { request } from "@/base/request";
import { DEFAULT_OUTPUT_TOKENS, findModel, fitSettings, startingModel, type PlaygroundCatalog, type StepKind } from "./catalog";
import type { RunView, Step } from "./playground";

export type RecipeList = InferResponse<typeof listRecipesRoute>;
export type Recipe = RecipeList["items"][number];
export type RecipeDetail = InferResponse<typeof readRecipeRoute>;
export type Estimate = InferResponse<typeof estimateRecipeRoute>;
export type RecipeRun = InferResponse<typeof recipeRunsRoute>[number];
export type RunDetails = InferResponse<typeof runDetailsRoute>;
export type ApiKey = InferResponse<typeof listKeysRoute>[number];
export type NewKey = InferResponse<typeof createKeyRoute>;
export type ApiRun = InferResponse<typeof apiRunRecipeRoute>;
export type Retired = RecipeDetail["retired"][number];

export type InputType = "text" | "long_text" | "image" | "audio" | "file" | "knowledge";
export type RecipeInput = { name: string; label: string; type: InputType; required: boolean; hint?: string };
/** One step as the editor holds it and the server stores it. */
export type DraftStep = {
  /** The editor's own key for a step, so a card keeps its state when steps move. Never saved. */
  uid?: string;
  name: string; kind: StepKind; model: string; prompt: string; file: string;
  settings: Record<string, unknown>; options: Record<string, unknown>;
};
export type Draft = { name: string; description: string; status: "draft" | "published"; inputs: RecipeInput[]; steps: DraftStep[] };
export type PlanError = { step: number; field: string; ref?: string; message: string };
export type Plan = { ok: boolean; errors: PlanError[]; steps: { seq: number; depends_on: number[]; inputs: string[]; knowledge: string[] }[] };

export const RECIPE_KINDS: StepKind[] = ["text", "image", "video", "speech", "music", "transcribe"];
export const KIND_LABEL: Record<string, string> = { text: "Text", image: "Image", video: "Video", speech: "Speech", music: "Music", transcribe: "Transcribe", embedding: "Knowledge", rerank: "Rerank" };
export const INPUT_TYPES: { value: InputType; label: string }[] = [
  { value: "text", label: "Text" }, { value: "long_text", label: "Long text" }, { value: "knowledge", label: "Pick from Knowledge" },
  { value: "image", label: "Image" }, { value: "audio", label: "Audio" }, { value: "file", label: "File" },
];
export const FILE_INPUTS: InputType[] = ["image", "audio", "file"];
/** What each kind's file slot takes, in words, and which kinds have one at all. */
export const FILE_SLOT: Partial<Record<StepKind, { inputs: InputType[]; steps: StepKind[]; label: string }>> = {
  image: { inputs: ["image"], steps: ["image"], label: "Image to edit" },
  video: { inputs: ["image"], steps: ["image"], label: "Start from an image" },
  text: { inputs: ["image", "audio", "file"], steps: ["image", "speech", "music"], label: "File to read" },
  transcribe: { inputs: ["audio"], steps: ["speech", "music"], label: "Recording" },
};
/** Kinds whose output is words a later prompt can use. */
const WORDS: StepKind[] = ["text", "transcribe"];
export const MOST_STEPS = 10;
export const MOST_FILE_INPUTS = 3;

export const recipesApi = {
  list: () => request<RecipeList>("GET", routePath("GET recipes")),
  get: (slug: string) => request<RecipeDetail>("GET", routePath("GET recipes/{slug}", { slug })),
  create: (d: Draft) => request<Recipe>("POST", routePath("POST recipes"), d),
  update: (id: number, d: Draft) => request<Recipe>("PATCH", routePath("PATCH recipes/{id}", { id }), d),
  remove: (id: number) => request<{ deleted: boolean }>("DELETE", routePath("DELETE recipes/{id}", { id })),
  estimate: (d: Pick<Draft, "inputs" | "steps">) => request<Estimate>("POST", routePath("POST recipes/estimate"), { inputs: d.inputs, steps: d.steps }),
  runs: (id: number) => request<RecipeRun[]>("GET", routePath("GET recipes/{id}/runs", { id })),
  details: (runId: number) => request<RunDetails>("GET", routePath("GET runs/{id}/details", { id: runId })),
  /** Run a recipe from the app. Files go in the order the recipe lists its file inputs. */
  run: (id: number, clientId: string, values: Record<string, string>, files: (File | null)[]) => {
    const form = new FormData();
    form.append("client_id", clientId);
    form.append("values", JSON.stringify(values));
    files.forEach((f, i) => { if (f) form.append(`file_${i + 1}`, f); });
    return request<{ outcome: "created" | "existing"; run: RunView["run"]; steps: Step[] }>("POST", routePath("POST recipes/{id}/runs", { id }), form);
  },
  keys: () => request<ApiKey[]>("GET", routePath("GET keys")),
  createKey: (name: string, days: number) => request<NewKey>("POST", routePath("POST keys"), { name, days }),
  revokeKey: (id: number) => request<{ id: number; revoked: boolean }>("POST", routePath("POST keys/{id}/revoke", { id })),
};

/**
 * A run's inputs as a form's values: only the words a form can take again (a file has to be given anew), only for inputs
 * the recipe still asks for, and never longer than the field allows.
 */
export function lastValues(inputs: RecipeInput[], last: { name: string; value: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of inputs) {
    if (FILE_INPUTS.includes(i.type)) continue;
    const v = last.find((l) => l.name === i.name)?.value;
    if (typeof v === "string" && v.trim()) out[i.name] = v.slice(0, i.type === "long_text" ? 8000 : i.type === "knowledge" ? 200 : 2000);
  }
  return out;
}

/** The server's reference check, run here: errors by step and field, and what each step depends on. */
export function planDraft(d: Pick<Draft, "inputs" | "steps">): Plan {
  return planBody({ $var: { plan_in: { inputs: d.inputs, steps: d.steps } } }) as Plan;
}

/** The errors for one step's field ("prompt", "file", "name", "model"), or for the inputs (step 0). */
export const errorsFor = (plan: Plan, step: number, field?: string) =>
  plan.errors.filter((e) => e.step === step && (!field || e.field === field || e.field.startsWith(`${field}.`)));

let uids = 0;
/** A key for a step card that stays with it when steps move. */
export const stepUid = () => `s${++uids}`;

/** A new step of this kind, on the kind's suggested model, with settings that model allows. */
export function newStep(kind: StepKind, catalog: PlaygroundCatalog | null, n: number): DraftStep {
  const model = startingModel(catalog, kind);
  const fit = fitSettings({}, findModel(catalog, kind, model), kind);
  const options: Record<string, unknown> = {};
  if (kind === "text") options.output_tokens = DEFAULT_OUTPUT_TOKENS;
  if (kind === "image") Object.assign(options, { size: fit.size, aspect_ratio: fit.aspect });
  if (kind === "video") Object.assign(options, { seconds: fit.seconds, resolution: fit.resolution, audio: fit.audio, aspect_ratio: fit.aspect });
  const settings: Record<string, unknown> = kind === "transcribe" ? {} : { use_brand: true };
  if (kind === "text") settings.response_format = "text";
  return { uid: stepUid(), name: `${KIND_LABEL[kind]} ${n}`, kind, model, prompt: "", file: "", settings, options };
}

export type RefChoice = { token: string; label: string; detail: string };

/** What step `index` (from 0) can put in its words: the text inputs and Knowledge picks, and earlier steps that make words. */
export function wordChoices(d: Pick<Draft, "inputs" | "steps">, index: number): RefChoice[] {
  const out: RefChoice[] = [];
  for (const i of d.inputs) {
    if (FILE_INPUTS.includes(i.type) || !i.name) continue;
    out.push({ token: `{{input.${i.name}}}`, label: i.label || i.name, detail: i.type === "knowledge" ? "Passages from Knowledge" : "Input" });
  }
  d.steps.slice(0, index).forEach((s, i) => {
    if (!WORDS.includes(s.kind)) return;
    out.push({ token: `{{step.${i + 1}}}`, label: `${i + 1}. ${s.name || KIND_LABEL[s.kind]}`, detail: s.kind === "text" && s.settings.response_format === "json" ? "The whole reply" : "Its output" });
    if (s.kind === "text" && s.settings.response_format === "json") {
      const props = (s.settings.json_schema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {};
      for (const key of Object.keys(props)) out.push({ token: `{{step.${i + 1}.${key}}}`, label: `${i + 1}. ${s.name || "Text"} → ${key}`, detail: "One field of its reply" });
    }
  });
  return out;
}

/** What step `index` can take as its file: matching file inputs and earlier steps that make that kind of file. */
export function fileChoices(d: Pick<Draft, "inputs" | "steps">, index: number): RefChoice[] {
  const slot = FILE_SLOT[d.steps[index]?.kind];
  if (!slot) return [];
  const out: RefChoice[] = [];
  for (const i of d.inputs) if (slot.inputs.includes(i.type) && i.name) out.push({ token: `{{input.${i.name}}}`, label: i.label || i.name, detail: "Input" });
  d.steps.slice(0, index).forEach((s, i) => {
    if (slot.steps.includes(s.kind)) out.push({ token: `{{step.${i + 1}}}`, label: `${i + 1}. ${s.name || KIND_LABEL[s.kind]}`, detail: `Its ${s.kind === "image" ? "image" : "audio"}` });
  });
  return out;
}

/** Put `token` into `text` at the cursor (or the end), with a space either side where it would touch a word. */
export function insertAt(text: string, token: string, start = text.length, end = start): { text: string; cursor: number } {
  const before = text.slice(0, start), after = text.slice(end);
  const pre = before && !/\s$/.test(before) ? " " : "";
  const post = after && !/^\s/.test(after) ? " " : "";
  const next = `${before}${pre}${token}${post}${after}`;
  return { text: next, cursor: before.length + pre.length + token.length };
}

const STEP_REF = /\{\{\s*step\.(\d+)((?:\.[A-Za-z0-9_]+)?)\s*\}\}/g;
/** Rewrite every `{{step.N}}` by `map` (old number → new). A reference to a removed step stays, and is flagged by the plan. */
function renumber(text: string, map: Record<number, number>): string {
  return text.replace(STEP_REF, (whole, n: string, key: string) => (map[Number(n)] ? `{{step.${map[Number(n)]}${key}}}` : whole));
}
const renumberStep = (s: DraftStep, map: Record<number, number>): DraftStep => ({
  ...s, prompt: renumber(s.prompt, map), file: renumber(s.file, map),
  settings: Object.fromEntries(Object.entries(s.settings).map(([k, v]) => [k, typeof v === "string" ? renumber(v, map) : v])),
});

/**
 * Move a step from `from` to `to` (both from 0). Every reference follows the step it named, so a step that used
 * "step 2" still uses the same step under its new number; one that now names a later step shows the error.
 */
export function moveStep(steps: DraftStep[], from: number, to: number): DraftStep[] {
  if (from === to || to < 0 || to >= steps.length) return steps;
  const order = steps.map((_, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  const map: Record<number, number> = {};
  order.forEach((old, i) => { map[old + 1] = i + 1; });
  return order.map((old) => renumberStep(steps[old], map));
}

/** Remove a step: the steps after it move up, and references to them follow. References to the removed one stay, flagged. */
export function removeStep(steps: DraftStep[], index: number): DraftStep[] {
  const map: Record<number, number> = {};
  steps.forEach((_, i) => { if (i > index) map[i + 1] = i; });
  return steps.filter((_, i) => i !== index).map((s) => renumberStep(s, map));
}

/** Settings the Playground sends that a recipe step keeps. */
const KEPT_SETTINGS = ["system", "response_format", "json_schema", "voice", "instructions", "negative_prompt", "use_brand", "language", "temperature"];
const KEPT_OPTIONS = ["output_tokens", "size", "aspect_ratio", "seconds", "resolution", "audio"];

/**
 * "Save as recipe": a one-step draft with the run's own settings. A run made from a file gets a matching input, so the
 * recipe asks for that file each time.
 */
export function draftFromRun(view: RunView): Draft {
  const step = view.steps[0];
  const kind = (step?.kind ?? "text") as StepKind;
  const i = step?.input ?? {};
  const settings: Record<string, unknown> = {};
  for (const k of KEPT_SETTINGS) if (i[k] !== undefined && i[k] !== null && i[k] !== "") settings[k] = i[k];
  const options: Record<string, unknown> = {};
  for (const k of KEPT_OPTIONS) if (step?.options?.[k] !== undefined) options[k] = step.options[k];
  const prompt = String((kind === "speech" ? i.text ?? i.prompt : kind === "transcribe" ? i.prompt ?? "" : i.prompt) ?? "");
  const hadFile = Array.isArray(i.sources) && (i.sources as unknown[]).length > 0;
  const fileType: InputType | null = !hadFile || !FILE_SLOT[kind] ? null : kind === "transcribe" ? "audio" : kind === "text" ? "file" : "image";
  const inputs: RecipeInput[] = fileType ? [{ name: fileType === "audio" ? "recording" : fileType === "image" ? "image" : "file", label: fileType === "audio" ? "Recording" : fileType === "image" ? "Image" : "File", type: fileType, required: true }] : [];
  return {
    name: view.run.title || `${KIND_LABEL[kind]} recipe`, description: "", status: "draft", inputs,
    steps: [{ uid: stepUid(), name: KIND_LABEL[kind], kind, model: step?.model ?? "", prompt, file: inputs[0] ? `{{input.${inputs[0].name}}}` : "", settings, options }],
  };
}

/** A step in a line: "Text · Gemini 3.8 Flash · JSON", "Video · Veo 3.1 Fast · starts from step 2 · 9:16". */
export function stepSummary(s: Pick<DraftStep, "kind" | "model" | "file" | "settings" | "options">, catalog: PlaygroundCatalog | null): string {
  const label = findModel(catalog, s.kind, s.model)?.label ?? s.model;
  const bits = [KIND_LABEL[s.kind] ?? s.kind, label];
  const from = /\{\{\s*(step|input)\.([A-Za-z0-9_]+)\s*\}\}/.exec(s.file);
  if (from) bits.push(from[1] === "step" ? `uses step ${from[2]}` : `uses ${from[2]}`);
  if (s.kind === "text" && s.settings.response_format === "json") bits.push("JSON");
  if (s.kind === "video" && s.options.seconds) bits.push(`${s.options.seconds} s`);
  if ((s.kind === "image" || s.kind === "video") && s.options.aspect_ratio) bits.push(String(s.options.aspect_ratio));
  if (s.kind === "speech" && s.settings.voice) bits.push(`voice ${s.settings.voice}`);
  return bits.join(" · ");
}

/** A step's settings worth a glance, each on its own: "JSON", "8 s", "720p", "16:9", "voice Kore", "brand kit". */
export function stepBits(s: { kind: string; settings: Record<string, unknown>; options: Record<string, unknown> }): string[] {
  const o = s.options ?? {}, st = s.settings ?? {};
  const bits: string[] = [];
  if (s.kind === "text" && st.response_format === "json") bits.push("JSON");
  if (s.kind === "video" && o.seconds) bits.push(`${o.seconds} s`);
  if (s.kind === "video" && o.resolution) bits.push(String(o.resolution));
  if ((s.kind === "image" || s.kind === "video") && o.aspect_ratio) bits.push(String(o.aspect_ratio));
  if (s.kind === "image" && o.size) bits.push(String(o.size));
  if (s.kind === "video" && o.audio === false) bits.push("silent");
  if (s.kind === "speech" && st.voice) bits.push(`voice ${st.voice}`);
  if (st.use_brand === true) bits.push("brand kit");
  return bits;
}

export type StepUse = { token: string; label: string; detail: string; step?: number };
const REF = /\{\{\s*(input|step)\.([A-Za-z0-9_]+)((?:\.[A-Za-z0-9_]+)?)\s*\}\}/g;
/**
 * What a step takes in, from its prompt and its file slot, each once and in the order written: an input by its label, an
 * earlier step by its number and name ("1. Launch copy"), a field of a JSON reply by its key.
 */
export function stepUses(s: Pick<DraftStep, "prompt" | "file">, inputs: RecipeInput[], steps: { seq: number; name: string; kind: string }[]): StepUse[] {
  const out: StepUse[] = [];
  for (const m of `${s.prompt ?? ""} ${s.file ?? ""}`.matchAll(REF)) {
    const token = m[0].replace(/\s+/g, "");
    if (out.some((u) => u.token === token)) continue;
    if (m[1] === "input") {
      const i = inputs.find((x) => x.name === m[2]);
      out.push({ token, label: i?.label || m[2], detail: i?.type === "knowledge" ? "Passages found in Knowledge" : "What the run form asks for" });
    } else {
      const n = Number(m[2]);
      const from = steps.find((x) => x.seq === n);
      const field = m[3] ? m[3].slice(1) : "";
      out.push({ token, step: n, label: `${from?.name || KIND_LABEL[from?.kind ?? ""] || "Step"}${field ? ` → ${field}` : ""}`, detail: field ? `The ${field} field of step ${n}'s reply` : `What step ${n} made` });
    }
  }
  return out;
}

/** The recipe API call from JavaScript, with the person's own key in an environment variable. */
export function jsFor(host: string, slug: string, inputs: RecipeInput[]): string {
  const url = `${host.replace(/\/$/, "")}/api:studio/recipes/${slug}/run`;
  const text = inputs.filter((i) => !FILE_INPUTS.includes(i.type));
  const files = inputs.filter((i) => FILE_INPUTS.includes(i.type));
  const example = (i: RecipeInput) => (i.type === "knowledge" ? "what to look up" : i.type === "long_text" ? "…" : i.label || i.name);
  const lines = ["const form = new FormData();"];
  if (text.length) lines.push(`form.append("inputs", JSON.stringify(${JSON.stringify(Object.fromEntries(text.map((i) => [i.name, example(i)])))}));`);
  files.forEach((f, n) => lines.push(`form.append("file_${n + 1}", ${f.name}File); // ${typeLabel(f.type).toLowerCase()}`));
  lines.push(
    "",
    `const res = await fetch("${url}", {`,
    `  method: "POST",`,
    `  headers: { Authorization: \`Bearer \${process.env.ATELIER_KEY}\`, "Idempotency-Key": crypto.randomUUID() },`,
    `  body: form,`,
    `});`,
    `const { run, status, poll } = await res.json();`,
  );
  return lines.join("\n");
}
const typeLabel = (t: string) => INPUT_TYPES.find((x) => x.value === t)?.label ?? t;

/** "about $1.05", "under $0.01", "no price set". */
export function aboutCost(micro: number, unpriced = false): string {
  if (unpriced) return "no price set";
  const d = micro / 1_000_000;
  if (d <= 0) return "$0";
  if (d < 0.01) return "under $0.01";
  return `about $${d.toFixed(2)}`;
}

/** The recipe API call, as cURL with the person's own key in an environment variable. */
export function curlFor(host: string, slug: string, inputs: RecipeInput[]): string {
  const url = `${host.replace(/\/$/, "")}/api:studio/recipes/${slug}/run`;
  const text = inputs.filter((i) => !FILE_INPUTS.includes(i.type));
  const files = inputs.filter((i) => FILE_INPUTS.includes(i.type));
  const example = (i: RecipeInput) => (i.type === "knowledge" ? "what to look up" : i.type === "long_text" ? "…" : i.label || i.name);
  const lines = [`curl -X POST \\`, `  ${url} \\`, `  -H "Authorization: Bearer $ATELIER_KEY" \\`, `  -H "Idempotency-Key: $(uuidgen)" \\`];
  if (text.length) lines.push(`  -F 'inputs=${JSON.stringify(Object.fromEntries(text.map((i) => [i.name, example(i)])))}' \\`);
  files.forEach((f, n) => lines.push(`  -F file_${n + 1}=@${f.name}.${f.type === "audio" ? "mp3" : f.type === "image" ? "jpg" : "pdf"} \\`));
  lines[lines.length - 1] = lines[lines.length - 1].replace(/ \\$/, "");
  return lines.join("\n");
}

/** A run's steps in the words the run page shows: done, working, waiting its turn, skipped and why. */
export const STEP_TONE: Record<string, "success" | "info" | "neutral" | "warning" | "danger"> = {
  succeeded: "success", working: "info", queued: "neutral", skipped: "neutral", released: "neutral", blocked: "warning", failed: "danger", timed_out: "danger",
};
export const STEP_WORDS: Record<string, string> = {
  succeeded: "Done", working: "Working", queued: "Waiting", skipped: "Skipped", released: "Not run", blocked: "Blocked", failed: "Failed", timed_out: "Timed out",
};
/** Steps that can go again in a retry. */
export const RETRYABLE = ["failed", "blocked", "timed_out"];

/**
 * When a recipe last ran, for the list's right-hand column: "Today", "Yesterday", the day and month this year ("13 Nov"),
 * or with the year before that ("13 Nov 2025"). Days are the viewer's own.
 */
export function lastRunWords(at: number, now = Date.now()): string {
  const day = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(at);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}
