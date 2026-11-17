// What each model costs, as numbers. The catalog (`npx xanosdk ai models --json`) gives prices only as display text, so
// this file turns each one into rows the server can multiply, checked by hand against the text kept in `label`.
// Read from the live catalog on 2026-11-16. The price table is seeded from these rows, and an admin can edit them.
//
// Money is integer micro-dollars everywhere ($1 = 1_000_000), the gateway's own unit. Token prices are per 1M tokens.

export const MICRO = 1_000_000;

/**
 * The gateway charges about 10% over the catalog price (measured on 2026-11-16: an image priced $0.067 cost $0.0739, a
 * $0.32 video cost $0.352, a $0.06 clip cost $0.066). Every estimate adds it, and screens call the result an estimate.
 */
export const MARGIN_NUMERATOR = 11;
export const MARGIN_DENOMINATOR = 10;

/** A new workspace's monthly budgets and approval line. Admins change them under Usage. */
export const DEFAULT_TEAM_BUDGET = 100 * MICRO;
export const DEFAULT_PERSON_BUDGET = 25 * MICRO;
export const DEFAULT_APPROVAL_LINE = MICRO / 2;

export const PRICE_KINDS = ["text", "image", "video", "speech", "transcribe", "embedding", "music"] as const;
export const PRICE_UNITS = ["input_token", "output_token", "image", "second", "clip"] as const;

/**
 * What an estimate assumes when a step doesn't say. Text caps include hidden thinking (Gemini counts it inside
 * max_tokens), so the answer cap is generous.
 */
export const ESTIMATE_DEFAULTS = {
  input_tokens: 2_000,
  output_tokens: 4_000,
  image_size: "1K",
  video_seconds: 8,
  video_resolution: "720p",
  samples: 1,
  embedding_input: "text",
} as const;

/** Text prices change above this many prompt tokens for models that list a second tier (variant "over_100k"). */
export const LONG_PROMPT_TOKENS = 100_000;

/** How long a step may run once sent, by kind, before the sweep calls it timed out (plus a minute's grace). */
export const STEP_TIMEOUT_SECONDS: Record<(typeof PRICE_KINDS)[number] | "rerank", number> = {
  text: 120, image: 120, video: 600, speech: 120, transcribe: 180, embedding: 120, music: 180, rerank: 60,
};
export const SWEEP_GRACE_SECONDS = 60;

type Kind = (typeof PRICE_KINDS)[number];
type Unit = (typeof PRICE_UNITS)[number];
export type PriceRow = {
  model: string; kind: Kind; unit: Unit; variant: string; amount: number;
  /** A price the catalog says takes over later, and when (epoch ms, UTC). 0 when there's none. */
  later_amount: number; later_from: number; label: string;
};

const NEW_YEAR_2027 = Date.UTC(2027, 0, 1);
const DECEMBER_2026 = Date.UTC(2026, 11, 1);
const $ = (dollars: number) => Math.round(dollars * MICRO);

const tokens = (model: string, kind: Kind, label: string, input: number, output: number | null, later?: { from: number; input: number; output: number }, variant = ""): PriceRow[] => [
  { model, kind, unit: "input_token", variant, amount: $(input), later_amount: later ? $(later.input) : 0, later_from: later?.from ?? 0, label },
  ...(output === null ? [] : [{ model, kind, unit: "output_token" as const, variant, amount: $(output), later_amount: later ? $(later.output) : 0, later_from: later?.from ?? 0, label }]),
];
const images = (model: string, label: string, sizes: Record<string, number>): PriceRow[] =>
  Object.entries(sizes).map(([size, dollars]) => ({ model, kind: "image", unit: "image", variant: size, amount: $(dollars), later_amount: 0, later_from: 0, label }));
/** Per second, by resolution: [with audio, without]. */
const video = (model: string, label: string, byResolution: Record<string, [number, number]>): PriceRow[] =>
  Object.entries(byResolution).flatMap(([res, [audio, silent]]) => [
    { model, kind: "video" as const, unit: "second" as const, variant: `${res}/audio`, amount: $(audio), later_amount: 0, later_from: 0, label },
    { model, kind: "video" as const, unit: "second" as const, variant: `${res}/silent`, amount: $(silent), later_amount: 0, later_from: 0, label },
  ]);
const clip = (model: string, label: string, dollars: number): PriceRow =>
  ({ model, kind: "music", unit: "clip", variant: "", amount: $(dollars), later_amount: 0, later_from: 0, label });

export const PRICES: PriceRow[] = [
  // Text: per 1M input / output tokens.
  ...tokens("gemini-3.8-flash", "text", "$0.75 / $3.75 per 1M tokens until Dec 31, then $1.50 / $7.50", 0.75, 3.75, { from: NEW_YEAR_2027, input: 1.5, output: 7.5 }),
  ...tokens("gemini-4-argon", "text", "$2 / $10 per 1M tokens until Nov 30, then $4 / $20", 2, 10, { from: DECEMBER_2026, input: 4, output: 20 }),
  ...tokens("gemini-3.5-flash-lite", "text", "$0.30 / $2.50 per 1M tokens", 0.3, 2.5),
  ...tokens("gemini-3.5-flash", "text", "$1.50 / $9 per 1M tokens", 1.5, 9),
  ...tokens("claude-fable-5-1", "text", "$10 / $50 per 1M tokens", 10, 50),
  ...tokens("claude-opus-5-5", "text", "$4 / $20 per 1M tokens", 4, 20),
  ...tokens("claude-sonnet-5-5", "text", "$2 / $10 per 1M tokens", 2, 10),
  ...tokens("claude-haiku-5-5", "text", "$0.10 / $0.50 per 1M tokens up to 100K prompt; $0.50 / $2.50 above", 0.1, 0.5),
  ...tokens("claude-haiku-5-5", "text", "$0.10 / $0.50 per 1M tokens up to 100K prompt; $0.50 / $2.50 above", 0.5, 2.5, undefined, "over_100k"),
  // Images: per image, by size.
  ...images("gemini-3.1-flash-image", "$0.067 per 1K image, $0.101 2K, $0.151 4K", { "1K": 0.067, "2K": 0.101, "4K": 0.151 }),
  ...images("gemini-3-pro-image", "$0.134 per 1K image, $0.134 2K, $0.240 4K", { "1K": 0.134, "2K": 0.134, "4K": 0.24 }),
  ...images("gemini-3.1-flash-lite-image", "$0.034 per 1K image", { "1K": 0.034 }),
  ...images("gemini-nano-banana-2.1", "$0.034 per 1K image, $0.050 2K, $0.113 4K", { "1K": 0.034, "2K": 0.05, "4K": 0.113 }),
  // Video: per second, with or without audio, by resolution.
  ...video("veo-3.1-fast-generate-001", "$0.10/s with audio, $0.08/s without (1080p: $0.12/s, $0.10/s; 4K: $0.30/s, $0.25/s)",
    { "720p": [0.1, 0.08], "1080p": [0.12, 0.1], "4k": [0.3, 0.25] }),
  ...video("veo-3.1-generate-001", "$0.40/s with audio, $0.20/s without (4K: $0.60/s, $0.40/s)",
    { "720p": [0.4, 0.2], "1080p": [0.4, 0.2], "4k": [0.6, 0.4] }),
  ...video("veo-3.1-lite-generate-001", "$0.05/s with audio, $0.03/s without (1080p: $0.08/s, $0.05/s)",
    { "720p": [0.05, 0.03], "1080p": [0.08, 0.05] }),
  // Speech: text in / audio out, per 1M tokens.
  ...tokens("gemini-3.8-flash-tts", "speech", "$0.50 text in / $9 audio out per 1M tokens until Dec 31, then $1 / $18", 0.5, 9, { from: NEW_YEAR_2027, input: 1, output: 18 }),
  ...tokens("gemini-3.8-flash-lite-tts", "speech", "$0.50 text in / $6 audio out per 1M tokens until Dec 31, then $1 / $12", 0.5, 6, { from: NEW_YEAR_2027, input: 1, output: 12 }),
  // Transcription: audio in / text out, per 1M tokens.
  ...tokens("gemini-3.5-transcribe", "transcribe", "$2 audio in / $12 text out per 1M tokens", 2, 12),
  // Embeddings: input only, per 1M tokens, by what's embedded.
  ...tokens("gemini-embedding-2", "embedding", "Text $0.20 per 1M tokens; image $0.45; audio $6.50; video $12", 0.2, null, undefined, "text"),
  ...tokens("gemini-embedding-2", "embedding", "Text $0.20 per 1M tokens; image $0.45; audio $6.50; video $12", 0.45, null, undefined, "image"),
  ...tokens("gemini-embedding-2", "embedding", "Text $0.20 per 1M tokens; image $0.45; audio $6.50; video $12", 6.5, null, undefined, "audio"),
  ...tokens("gemini-embedding-2", "embedding", "Text $0.20 per 1M tokens; image $0.45; audio $6.50; video $12", 12, null, undefined, "video"),
  ...tokens("gemini-embedding-001", "embedding", "$0.15 per 1M tokens", 0.15, null, undefined, "text"),
  // Music: per clip.
  clip("lyria-002", "$0.06 per clip", 0.06),
  clip("lyria-3-clip-preview", "$0.04 per clip", 0.04),
  clip("lyria-3-pro-preview", "$0.08 per clip", 0.08),
];
