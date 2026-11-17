// The model catalog, as the Playground reads it from GET studio/playground/catalog: which models each kind of work can
// use, what each model takes (shapes, sizes, lengths, voices), whether a model can run here and now, and how long the
// slow kinds usually take. Pure functions, so the rules are tested without a server.

export type StepKind = "text" | "image" | "video" | "speech" | "music" | "transcribe";
/** The Playground's tabs. Audio is speech or music. */
export type Tab = "text" | "image" | "video" | "audio" | "transcribe";
export type AudioMode = "speech" | "music";

export type CatalogModel = {
  model: string; label: string; tier: string; stage: string; suggested: boolean; price: string;
  options: Record<string, unknown>;
};
export type PlaygroundCatalog = {
  statements: Record<string, CatalogModel[]>;
  unavailable: Record<string, string>;
  synced_at: string;
  priced: string[];
  ai_status: "on" | "signed_out" | "no_credits" | "disabled" | "expired";
  ai_status_reason: string;
  /** For an admin, the command that turns AI on here, or "". */
  fix_command: string;
  /** False once the first-run check found this plan can't keep video, music or speech files. */
  plan_paid_storage: boolean;
  can_run: boolean;
  is_admin: boolean;
  budget: { month_words: string; used: number; budget: number };
};

export const TABS: { value: Tab; label: string }[] = [
  { value: "text", label: "Text" }, { value: "image", label: "Image" }, { value: "video", label: "Video" },
  { value: "audio", label: "Audio" }, { value: "transcribe", label: "Transcribe" },
];
export const stepKindOf = (tab: Tab, audio: AudioMode): StepKind => (tab === "audio" ? audio : tab);

/** The kind's models, the suggested one first and the rest in the catalog's order. */
export function modelsFor(catalog: PlaygroundCatalog | null, kind: StepKind): CatalogModel[] {
  const list = catalog?.statements[kind] ?? [];
  return [...list].sort((a, b) => Number(b.suggested) - Number(a.suggested));
}

export const findModel = (catalog: PlaygroundCatalog | null, kind: StepKind, model: string) => modelsFor(catalog, kind).find((m) => m.model === model) ?? null;

/** The model to start on: the suggested one if it can run, else the first that can, else the first. */
export function startingModel(catalog: PlaygroundCatalog | null, kind: StepKind): string {
  const list = modelsFor(catalog, kind);
  const runnable = list.filter((m) => !catalog?.unavailable[m.model] && catalog?.priced.includes(m.model));
  return (runnable[0] ?? list[0])?.model ?? "";
}

export const TIER_LABEL: Record<string, string> = { fast: "Fast", balanced: "Balanced", best: "Best", default: "Standard", "text only": "Text only" };
export const tierLabel = (tier: string) => TIER_LABEL[tier] ?? (tier ? tier[0].toUpperCase() + tier.slice(1) : "");

/** Why a model can't be picked at all (the gateway doesn't serve it), or null. Such a model is shown, but disabled. */
export const unservedReason = (catalog: PlaygroundCatalog | null, model: string): string | null => catalog?.unavailable[model] ?? null;

export const NO_PRICE_WORDS = "No price set: an admin can add one under Usage.";
export const NO_ROLE_WORDS = "Your role can't run AI here. Ask an admin for access.";

/**
 * Why Generate is off for this model right now, or null when it can run. In order: the person's role, Xano AI being off
 * here, the gateway not serving the model, and the model having no price (the gateway never charges zero, so neither do we).
 */
export function blockedReason(catalog: PlaygroundCatalog | null, model: string, kind?: string): string | null {
  if (!catalog) return "Loading the model list…";
  if (!catalog.can_run) return NO_ROLE_WORDS;
  // The notice above says why and what fixes it; the button only says it's off.
  if (catalog.ai_status !== "on") return GENERATE_OFF_WORDS;
  if (kind && !catalog.plan_paid_storage && needsPaidPlan(kind)) return PAID_PLAN_WORDS;
  if (!model) return "Pick a model first.";
  const unserved = unservedReason(catalog, model);
  if (unserved) return unserved;
  if (!catalog.priced.includes(model)) return NO_PRICE_WORDS;
  return null;
}

export const GENERATE_OFF_WORDS = "Generate is off until AI is on.";
/** The kinds whose files a plan without paid storage can't keep. */
export const PAID_KINDS = ["video", "music", "speech"];
export const needsPaidPlan = (kind: string) => PAID_KINDS.includes(kind);
export const PAID_PLAN_WORDS = "Needs a paid plan: this plan can't save video, voice or music files.";

/** What a model takes, read from its catalog options. Missing lists are empty. */
export type ModelChoices = {
  aspectRatios: string[]; imageSizes: string[]; durations: number[]; resolutions: string[]; voices: string[];
  files: string[]; maxSamples: number; temperatureMax: number | null; maxOutputTokens: number | null; maxInputImages: number;
  /** Music: whether "leave out" words are taken, and how long a clip is. */
  negativePrompt: boolean; clipSeconds: number | null;
};
const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function choicesFor(model: CatalogModel | null): ModelChoices {
  const o = model?.options ?? {};
  return {
    aspectRatios: list<string>(o.aspect_ratios), imageSizes: list<string>(o.image_sizes), durations: list<number>(o.durations),
    resolutions: list<string>(o.resolutions), voices: list<string>(o.voices), files: list<string>(o.files),
    maxSamples: num(o.max_samples) ?? 1, temperatureMax: num(o.temperature_max), maxOutputTokens: num(o.max_output_tokens),
    maxInputImages: num(o.max_input_images) ?? 0,
    negativePrompt: o.negative_prompt !== false, clipSeconds: num(o.duration),
  };
}

/** The settings a form holds for the model-dependent choices. */
export type Settings = { aspect: string; size: string; seconds: number; resolution: string; audio: boolean; voice: string; outputTokens: number };

/** The answer cap a text run starts with: generous, because Gemini counts hidden thinking inside it. */
export const DEFAULT_OUTPUT_TOKENS = 4000;

/** Settings that fit this model: each kept when the model allows it, else the model's own first choice. */
export function fitSettings(prev: Partial<Settings>, model: CatalogModel | null, kind: StepKind): Settings {
  const c = choicesFor(model);
  const pick = <T>(want: T | undefined, allowed: T[], fallback: T): T => (want !== undefined && allowed.includes(want) ? want : allowed.length ? allowed[0] : fallback);
  const defaultAspect = kind === "video" ? "16:9" : "1:1";
  const cap = c.maxOutputTokens ?? Infinity;
  return {
    aspect: pick(prev.aspect, c.aspectRatios, defaultAspect) || defaultAspect,
    size: pick(prev.size, c.imageSizes, "1K"),
    // A clip is as long as was asked if the model offers it, else the longest it offers.
    seconds: prev.seconds !== undefined && c.durations.includes(prev.seconds) ? prev.seconds : c.durations.length ? Math.max(...c.durations) : 8,
    resolution: pick(prev.resolution, c.resolutions, "720p"),
    audio: prev.audio ?? false,
    voice: prev.voice && c.voices.includes(prev.voice) ? prev.voice : "",
    outputTokens: Math.min(prev.outputTokens ?? DEFAULT_OUTPUT_TOKENS, cap),
  };
}

export const ASPECT_WORDS: Record<string, string> = {
  "1:1": "1:1 square", "2:3": "2:3 portrait", "3:2": "3:2 landscape", "3:4": "3:4 portrait", "4:3": "4:3 landscape", "4:5": "4:5 portrait",
  "5:4": "5:4 landscape", "9:16": "9:16 vertical", "16:9": "16:9 wide", "21:9": "21:9 cinema",
};

/**
 * How long a background kind usually takes on this model, in seconds: [quickest, slowest]. Measured on the dev gateway
 * on 2026-11-16 where noted (Veo 3.1 Fast, 4 s, 29 s; Lyria 2, 25–27 s); the rest are the same family's measurement
 * scaled by what the catalog says the model does (longer clips, higher quality). A screen shows it as a range, never as
 * progress.
 */
const USUAL: Record<string, [number, number]> = {
  "veo-3.1-fast-generate-001": [25, 90],
  "veo-3.1-generate-001": [40, 180],
  "veo-3.1-lite-generate-001": [20, 75],
  "lyria-002": [20, 40],
  "lyria-3-clip-preview": [20, 60],
  "lyria-3-pro-preview": [60, 240],
};
export function usualSeconds(kind: StepKind, model: string): [number, number] | null {
  if (kind !== "video" && kind !== "music") return null;
  return USUAL[model] ?? (kind === "video" ? [30, 180] : [20, 90]);
}

/** "25 s", "1 min 30 s", "4 min". */
export function secondsWords(s: number): string {
  const whole = Math.max(0, Math.round(s));
  if (whole < 60) return `${whole} s`;
  const m = Math.floor(whole / 60), r = whole % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/**
 * Where the usual range and the elapsed marker sit on a scale running to 1.5 × the slowest usual time, as percentages.
 * Past the end of the scale the marker stays at the end, and `late` says the run is taking longer than usual.
 */
export function rangeLayout(elapsed: number, usual: [number, number]) {
  const scale = usual[1] * 1.5;
  const at = (s: number) => Math.round(Math.min(100, Math.max(0, (s / scale) * 100)) * 10) / 10;
  return { from: at(usual[0]), to: at(usual[1]), marker: at(elapsed), late: elapsed > usual[1], scale };
}
