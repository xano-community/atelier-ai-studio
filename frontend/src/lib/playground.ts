// What the Playground sends and how it reads what comes back: the request for each kind of work, the click keys that
// make a repeat one run, the history list, and the words for a step's time, usage and cost. Pure functions.
import type { AudioMode, Settings, StepKind, Tab } from "./catalog";

/** A run as GET studio/runs/{id} answers it. */
export type Run = {
  id: number; owner_id?: number; owner_name?: string; kind: string; via: string; title: string; status: string; reason: string; detail: string;
  estimate: number; spent: number; private: boolean; approval_id: number; created_at: number; finished_at: number | null;
};
export type Step = {
  id: number; seq: number; kind: string; model: string; status: string; reason: string; detail: string; attempt: number;
  input: Record<string, unknown>; options: Record<string, unknown>; output: Record<string, unknown>; usage: Record<string, number>;
  estimate: number; charged: number; brand_applied: boolean; asset_id: number; url: string;
  /** A table-kept file's id, where this server can't sign links (lib/media.ts). */
  blob_id?: number;
  sent_at?: number | null; finished_at?: number | null; claimed_at?: number | null;
};
export type RunView = { run: Run; steps: Step[] };

/** What the form on screen holds. Fields a kind doesn't use are ignored. */
export type Form = {
  tab: Tab; audio: AudioMode; model: string; compareModel: string; compare: boolean;
  prompt: string; system: string; json: boolean; schema: string; negative: string; useBrand: boolean;
  speechText: string; voice: string; style: string; language: string; hint: string;
  settings: Settings;
};

/** What POST studio/runs takes for one step, before the click's key and any file. */
export type RunRequest = { kind: StepKind; model: string; input: Record<string, unknown>; options: Record<string, unknown>; title: string };

const tokensIn = (text: string) => Math.max(1, Math.ceil(text.length / 4));
/** About a minute of finished speech is 1,500 audio tokens; people say about 150 words a minute. */
const speechTokens = (text: string) => Math.max(200, Math.ceil((text.trim().split(/\s+/).filter(Boolean).length / 150) * 1500));

/** A run's name in history: the first line of what was asked, cut at a word. */
export function titleFrom(text: string, fallback: string): string {
  const line = text.trim().split(/\n/)[0].replace(/\s+/g, " ");
  if (!line) return fallback;
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  // A cut that lands just before a space already ends on a whole word.
  const space = line[60] === " " ? 60 : cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[,.;:]$/, "")}…`;
}

/** Parse the JSON schema box: an object, or null when it's empty. Throws with words a person can act on. */
export function parseSchema(text: string): Record<string, unknown> | null {
  if (!text.trim()) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("The schema isn't valid JSON. Fix it, or clear it to let the model choose the shape."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The schema must be a JSON object, like {\"type\": \"object\", \"properties\": {…}}.");
  return parsed as Record<string, unknown>;
}

/**
 * The request for the form's kind and model. `model` overrides the form's (Compare's second pane). `seconds` is a
 * recording's length, when known, for the transcription estimate.
 */
export function buildRequest(form: Form, o: { model?: string; recordingSeconds?: number; hasFile?: boolean } = {}): RunRequest {
  const model = o.model ?? form.model;
  const s = form.settings;
  const kind: StepKind = form.tab === "audio" ? form.audio : form.tab;
  switch (kind) {
    case "text": {
      const input: Record<string, unknown> = { prompt: form.prompt, use_brand: form.useBrand, response_format: form.json ? "json" : "text" };
      if (form.system.trim()) input.system = form.system.trim();
      if (form.json) { const schema = parseSchema(form.schema); if (schema) input.json_schema = schema; }
      return { kind, model, input, title: titleFrom(form.prompt, "Text"),
        options: { input_tokens: tokensIn(form.prompt + form.system) + (form.useBrand ? 400 : 0), output_tokens: s.outputTokens } };
    }
    case "image":
      return { kind, model, input: { prompt: form.prompt, use_brand: form.useBrand }, options: { size: s.size, aspect_ratio: s.aspect, samples: 1 },
        title: titleFrom(form.prompt, o.hasFile ? "Image edit" : "Image") };
    case "video": {
      const input: Record<string, unknown> = { prompt: form.prompt, use_brand: form.useBrand };
      if (form.negative.trim()) input.negative_prompt = form.negative.trim();
      return { kind, model, input, options: { seconds: s.seconds, resolution: s.resolution, audio: s.audio, aspect_ratio: s.aspect, samples: 1 }, title: titleFrom(form.prompt, "Video") };
    }
    case "music": {
      const input: Record<string, unknown> = { prompt: form.prompt, use_brand: form.useBrand };
      if (form.negative.trim()) input.negative_prompt = form.negative.trim();
      return { kind, model, input, options: { samples: 1 }, title: titleFrom(form.prompt, "Music") };
    }
    case "speech": {
      const input: Record<string, unknown> = { text: form.speechText, use_brand: form.useBrand };
      if (s.voice) input.voice = s.voice;
      if (form.style.trim()) input.instructions = form.style.trim();
      return { kind, model, input, options: { input_tokens: tokensIn(form.speechText + form.style), output_tokens: speechTokens(form.speechText) }, title: titleFrom(form.speechText, "Speech") };
    }
    case "transcribe": {
      const input: Record<string, unknown> = {};
      if (form.language.trim()) input.language = form.language.trim();
      if (form.hint.trim()) input.prompt = form.hint.trim();
      // About 26 audio tokens a second (65 s measured at 1,672), and a few words of text back for each.
      const secs = o.recordingSeconds && o.recordingSeconds > 0 ? o.recordingSeconds : 600;
      return { kind, model, input, options: { input_tokens: Math.ceil(secs * 26), output_tokens: Math.ceil(secs * 4) }, title: "Transcript" };
    }
  }
}

/** What's missing before a run can start, in words, or null. */
export function missingInput(form: Form, hasFile: boolean): string | null {
  const kind: StepKind = form.tab === "audio" ? form.audio : form.tab;
  if (kind === "speech") return form.speechText.trim() ? null : "Write the words to say first.";
  if (kind === "transcribe") return hasFile ? null : "Attach a recording to transcribe.";
  if (!form.prompt.trim()) return "Write a prompt first.";
  if (kind === "text" && form.json) { try { parseSchema(form.schema); } catch (e) { return (e as Error).message; } }
  if (kind === "text" && form.compare && (!form.compareModel || form.compareModel === form.model)) return "Pick a second, different model to compare with.";
  return null;
}

/** A click's own key. Compare sends the same click as two runs: `<key>:a` and `<key>:b`. */
export const newClickId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
export const compareKeys = (click: string): [string, string] => [`${click}:a`, `${click}:b`];

export const FINAL_STATES = ["done", "partial", "failed", "refused", "declined", "stopped"];
export const isFinal = (status: string) => FINAL_STATES.includes(status);

/** Seconds the model took, from when the step was sent to when it ended, or null before it has both. */
export function stepSeconds(step: Pick<Step, "sent_at" | "finished_at">): number | null {
  if (!step.sent_at || !step.finished_at) return null;
  return Math.max(0, (step.finished_at - step.sent_at) / 1000);
}

/** "$0.10", "$0.0016", "under $0.0001": small amounts keep enough digits to compare two models. */
export function money(micro: number): string {
  const d = Math.max(0, micro) / 1_000_000;
  if (d === 0) return "$0";
  if (d < 0.0001) return "under $0.0001";
  if (d < 0.01) return `$${d.toFixed(4)}`;
  return `$${d.toFixed(2)}`;
}

const n = (v: number) => v.toLocaleString("en-US");
/** What a step used, in a few words: "412 in / 64 out", "1 image", "4 s of video", "1 clip". */
export function usageWords(step: Pick<Step, "kind" | "usage" | "output">): string {
  const u = step.usage ?? {};
  switch (step.kind) {
    case "image": return u.input_tokens ? `${n(u.input_tokens)} in · 1 image out` : "1 image";
    case "video": { const s = Number(u.seconds ?? step.output?.duration ?? 0); return s ? `${s} s of video` : "1 clip"; }
    case "music": return "1 clip";
    default:
      if (u.input_tokens === undefined && u.output_tokens === undefined) return "";
      return `${n(u.input_tokens ?? 0)} in / ${n(u.output_tokens ?? 0)} out`;
  }
}

export type PaneState = "idle" | "sending" | "running" | "waiting" | "confirm" | "refused" | "failed" | "stopped" | "done";
/**
 * Where one result pane stands, and the words it shows. Each pane reads only its own run (or its own request's error),
 * so in Compare one model's refusal or failure never changes what the other pane says.
 */
export function paneState(p: { view?: RunView | null; error?: string | null; sending?: boolean }): { state: PaneState; words: string; step: Step | null } {
  if (p.sending) return { state: "sending", words: "Sending…", step: null };
  if (p.error) return { state: "failed", words: p.error, step: null };
  if (!p.view) return { state: "idle", words: "", step: null };
  const { run, steps } = p.view;
  const step = steps[0] ?? null;
  const why = run.detail || step?.detail || "";
  switch (run.status) {
    case "starting": case "queued": case "running": return { state: "running", words: "", step };
    case "waiting_approval": case "waiting_confirmation": return { state: "waiting", words: why || "Waiting for an admin to approve it. Nothing is charged until then.", step };
    case "needs_confirmation": return { state: "confirm", words: why, step };
    case "refused": case "declined": return { state: "refused", words: why || "This run was refused.", step };
    case "stopped": return { state: "stopped", words: why || "Stopped.", step };
    case "done": return { state: "done", words: step?.detail ?? "", step };
    default: return { state: "failed", words: step?.detail || why || "The model didn't finish. Try again.", step };
  }
}

/** The result line of a finished pane: its time, what it used and what it cost. */
export function resultLine(view: RunView): { seconds: number | null; usage: string; cost: string } {
  const step = view.steps[0];
  return { seconds: step ? stepSeconds(step) : null, usage: step ? usageWords(step) : "", cost: money(view.run.spent) };
}

/** One line in history: a single run, or both runs of one Compare click. */
export type HistoryRow = { key: string; runIds: number[]; title: string; kind: string; models: string[]; spent: number; status: string; created_at: number; compared: boolean };
type HistoryRun = { id: number; idem_key: string; title: string; status: string; spent: number; estimate: number; created_at: number };
type HistoryStep = { run_id: number; kind: string; model: string };

/** Group the history: two runs whose keys are one click's `:a` and `:b` become one "compared" row. Newest first. */
export function groupHistory(runs: HistoryRun[], steps: HistoryStep[]): HistoryRow[] {
  const firstStep = new Map<number, HistoryStep>();
  for (const s of steps) if (!firstStep.has(s.run_id)) firstStep.set(s.run_id, s);
  const rows: HistoryRow[] = [];
  const byClick = new Map<string, HistoryRow>();
  for (const r of runs) {
    const step = firstStep.get(r.id);
    const m = /^(.*):([ab])$/.exec(r.idem_key);
    const click = m?.[1];
    const existing = click ? byClick.get(click) : undefined;
    if (existing) {
      // The `:a` run (the first model) comes first in the row, whichever was made first.
      const aFirst = m?.[2] === "b";
      existing.runIds = aFirst ? [...existing.runIds, r.id] : [r.id, ...existing.runIds];
      if (step) existing.models = aFirst ? [...existing.models, step.model] : [step.model, ...existing.models];
      existing.spent += r.spent;
      existing.compared = true;
      existing.created_at = Math.max(existing.created_at, r.created_at);
      continue;
    }
    const row: HistoryRow = { key: click ?? String(r.id), runIds: [r.id], title: r.title, kind: step?.kind ?? "", models: step ? [step.model] : [], spent: r.spent, status: r.status, created_at: r.created_at, compared: false };
    if (click) byClick.set(click, row);
    rows.push(row);
  }
  return rows.sort((a, b) => b.created_at - a.created_at);
}

/** The form a past run's first step came from, so it can be run again. Files aren't kept, so they're not restored. */
export function formFromStep(step: Pick<Step, "kind" | "model" | "input" | "options">, base: Form): Form {
  const i = step.input ?? {};
  const o = step.options ?? {};
  const text = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  const kind = step.kind as StepKind;
  const tab: Tab = kind === "speech" || kind === "music" ? "audio" : (kind as Tab);
  return {
    ...base, tab, audio: kind === "speech" || kind === "music" ? kind : base.audio, model: step.model, compare: false,
    prompt: kind === "transcribe" ? base.prompt : text("prompt"), system: text("system"),
    json: i.response_format === "json", schema: i.json_schema ? JSON.stringify(i.json_schema, null, 2) : "",
    negative: text("negative_prompt"), useBrand: i.use_brand !== false,
    speechText: text("text"), style: text("instructions"), language: text("language"), hint: kind === "transcribe" ? text("prompt") : base.hint,
    settings: {
      ...base.settings,
      ...(typeof o.aspect_ratio === "string" ? { aspect: o.aspect_ratio } : {}),
      ...(typeof o.size === "string" ? { size: o.size } : {}),
      ...(typeof o.seconds === "number" ? { seconds: o.seconds } : {}),
      ...(typeof o.resolution === "string" ? { resolution: o.resolution } : {}),
      ...(typeof o.audio === "boolean" ? { audio: o.audio } : {}),
      ...(typeof o.output_tokens === "number" && kind === "text" ? { outputTokens: o.output_tokens } : {}),
      ...(typeof i.voice === "string" ? { voice: i.voice } : {}),
    },
  };
}

/**
 * What each kind's prompt starts with, so the first Run works without typing anything: real work for Marlow, in its
 * voice, not a greyed-out example. Speech starts its words to say the same way.
 */
export const STARTERS = {
  text: "Write the product page intro for the Trail 2: two sentences, our voice, mention the 2.4 in tyre clearance and the lifetime frame warranty.",
  image: "The Trail 2 in sage green leaning on a dry-stone wall, morning light from the left, no people.",
  video: "A slow pan across the Trail 2 leaning on a stone wall at dusk, leaves moving in the wind.",
  music: "A calm acoustic theme for a product film, light percussion, hopeful, around 100 bpm, no vocals.",
  speech: "Meet the Trail 2. It likes rough ground. So will you.",
} as const;

/** The prompt to show on switching to `kind`: a starter follows the tab; anything someone wrote stays as it is. */
export function promptForKind(prompt: string, kind: StepKind): string {
  const starters: string[] = Object.values(STARTERS);
  if (prompt.trim() && !starters.includes(prompt)) return prompt;
  if (kind === "text" || kind === "image" || kind === "video" || kind === "music") return STARTERS[kind];
  return prompt;
}
