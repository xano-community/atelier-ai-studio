// The demo world: Marlow, a bike brand's in-house marketing team, two weeks into their autumn launch. Jordan (1) runs brand and
// the budgets, Sam (2) makes the launch assets, Priya (3) brings customers' voices in from calls, and Alex (4), a freelance
// designer, sees approved work. Rows refer to each other by position, and every date counts back from the deploy through the
// seed clock, in working hours in the deploy's zone. Every image, clip and recording was made by this app's own AI before the
// deploy, and is kept in a table (never a hosted file, which would land private bytes in a public bucket on cloud).
//
// The money adds up: each step that reached a model has a settled ledger row for what it was charged, and each month's budget
// counters are the sums of those rows, so Home's spend, Usage's totals and the budgets agree from the first minute.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import planRecipe from "../frontend/src/lib/rules/recipe-plan.js";
import { APP, DEMO_PEOPLE } from "./app.js";
import {
  DEFAULT_PERSON_BUDGET, DEFAULT_TEAM_BUDGET, ESTIMATE_DEFAULTS, LONG_PROMPT_TOKENS, MARGIN_DENOMINATOR, MARGIN_NUMERATOR, MICRO,
  PRICES, STEP_TIMEOUT_SECONDS,
} from "./prices.js";
import { deployZone, seedClock } from "./seed-clock.js";
import { leadKind } from "./table/recipes/recipe.js";
import { SEED_SOURCES } from "./world-knowledge.js";
import seedVectors from "./seed-vectors.json" with { type: "json" };

export const JORDAN = 1, SAM = 2, PRIYA = 3, ALEX = 4;
const NOW = Date.now();
const SECOND = 1000, MINUTE = 60 * SECOND, DAY = 86_400_000;
/** Every stamp comes from the clock (seed-clock.ts): a time of day in working hours, on a working day, in the past. */
export const SEED_CLOCK = seedClock(NOW, deployZone());
const { at, today } = SEED_CLOCK;
const nameOf = (person: number) => DEMO_PEOPLE[person - 1].name;
/** "2026-11": the UTC month a budget counter is kept by. */
export const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

const TEXT = "gemini-3.8-flash", SONNET = "claude-sonnet-5-5", IMAGE = "gemini-3.1-flash-image", VIDEO = "veo-3.1-fast-generate-001";
const TTS = "gemini-3.8-flash-tts", MUSIC = "lyria-002", EMBED = "gemini-embedding-2", TRANSCRIBE = "gemini-3.5-transcribe";
/** What the brand kit adds to an image or video prompt, as compose writes it. */
const LOOK = "Natural light, real place, no lens flare, photographic, the bike is ridden or leaning, never floating.";

// ── Money: the price table's arithmetic (function/spend/estimate.ts), so a seeded charge is what the app would have charged ──
const rate = (model: string, unit: string, variant: string, when: number) => {
  const row = PRICES.find((r) => r.model === model && r.unit === unit && r.variant === variant)
    ?? PRICES.find((r) => r.model === model && r.unit === unit && r.variant === "");
  if (!row) throw new Error(`The seed uses ${model} (${unit} ${variant}), which has no price.`);
  return row.later_from && when >= row.later_from ? row.later_amount : row.amount;
};
const withMargin = (base: number) => Math.ceil((base * MARGIN_NUMERATOR) / MARGIN_DENOMINATOR);
type Options = Record<string, unknown>;
const num = (v: unknown, fallback: number) => (typeof v === "number" ? v : fallback);
/** Micro-dollars for one call: an estimate from a step's caps, or a charge from the usage the gateway returned. */
export function costOf(kind: string, model: string, o: Options, when: number): number {
  switch (kind) {
    case "text": case "speech": case "transcribe": {
      const inTokens = num(o.input_tokens, ESTIMATE_DEFAULTS.input_tokens), outTokens = num(o.output_tokens, ESTIMATE_DEFAULTS.output_tokens);
      const tier = inTokens > LONG_PROMPT_TOKENS ? "over_100k" : "";
      return withMargin((inTokens * rate(model, "input_token", tier, when) + outTokens * rate(model, "output_token", tier, when)) / MICRO);
    }
    case "embedding": return withMargin((num(o.input_tokens, ESTIMATE_DEFAULTS.input_tokens) * rate(model, "input_token", String(o.input_type ?? "text"), when)) / MICRO);
    case "image": return withMargin(rate(model, "image", String(o.size ?? ESTIMATE_DEFAULTS.image_size), when) * num(o.samples, 1));
    case "video": return withMargin(rate(model, "second", `${String(o.resolution ?? ESTIMATE_DEFAULTS.video_resolution).toLowerCase()}/${o.audio ? "audio" : "silent"}`, when)
      * num(o.seconds, ESTIMATE_DEFAULTS.video_seconds) * num(o.samples, 1));
    case "music": return withMargin(rate(model, "clip", "", when) * num(o.samples, 1));
    default: return 0;
  }
}

// ── Files: each made image, clip and recording is a table row with its bytes, shown through the authed media route ──
const bytesOf = (file: string) => readFileSync(new URL(`./seed-files/${file}`, import.meta.url));
export type MediaRow = { name: string; mime: string; size: number; b64: string; run_id: number; step_id: number; attempt: number; source_id: number; is_demo: true };
export const SEED_MEDIA: MediaRow[] = [];
const MIME: Record<string, string> = { jpg: "image/jpeg", mp3: "audio/mpeg", mp4: "video/mp4" };
/** Keep a seed file in the media table, and answer the stored-file record an asset or a step output holds. */
const keepFile = (file: string, owner: { run?: number; step?: number; source?: number }, meta: Record<string, unknown> = {}) => {
  const bytes = bytesOf(file);
  const mime = MIME[file.split(".").pop()!];
  SEED_MEDIA.push({ name: file, mime, size: bytes.length, b64: bytes.toString("base64"), run_id: owner.run ?? 0, step_id: owner.step ?? 0, attempt: owner.step ? 1 : 0, source_id: owner.source ?? 0, is_demo: true });
  return { mode: "table", blob_id: SEED_MEDIA.length, name: file, mime, size: bytes.length, meta };
};

// ── Recipes: the team's nine, as the editor saved them ──
type RecipeStep = { name: string; kind: string; model: string; prompt: string; file?: string; settings?: Options; options?: Options };
type RecipeSeed = { name: string; description: string; by: number; inputs: Options[]; steps: RecipeStep[]; days: number };
const COPY_SCHEMA = { type: "object", properties: { headline: { type: "string" }, body: { type: "string" }, script: { type: "string" } }, required: ["headline", "body", "script"] };
const PAGE_SCHEMA = { type: "object", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } }, seo: { type: "string" } }, required: ["title", "bullets", "seo"] };
const product = { name: "product", label: "Product", type: "text", required: true };
export const LAUNCH_KIT = "Product launch kit", FREE_PLAN_RECIPE = "Product page copy and photo";
const RECIPES: RecipeSeed[] = [
  { name: LAUNCH_KIT, description: "Copy, hero image, 8 s video, voiceover and a music bed for one product", by: SAM, days: 10, inputs: [product, { name: "points", label: "What to get across", type: "long_text", required: false }], steps: [
    { name: "Launch copy", kind: "text", model: TEXT, prompt: "Write launch copy for the Marlow {{input.product}}: a headline, a short body and a 15 second voiceover script. Get across: {{input.points}}", settings: { response_format: "json", json_schema: COPY_SCHEMA }, options: { output_tokens: 3000 } },
    { name: "Hero image", kind: "image", model: IMAGE, prompt: "A rider on the Marlow {{input.product}} on the kind of ground it's built for, mid-morning light.", options: { size: "1K", aspect_ratio: "4:5" } },
    { name: "8 s video", kind: "video", model: VIDEO, prompt: "The bike ridden past the camera, tracking alongside.", file: "{{step.2}}", options: { seconds: 8, resolution: "720p", audio: false, aspect_ratio: "16:9" } },
    { name: "Voiceover", kind: "speech", model: TTS, prompt: "{{step.1.script}}", settings: { voice: "Kore", instructions: "calm, friendly, medium pace" } },
    { name: "Music bed", kind: "music", model: MUSIC, prompt: "Warm indie, around 100 bpm, no vocals, acoustic guitar and soft drums" },
  ] },
  { name: FREE_PLAN_RECIPE, description: "Product page words and a studio photo: text and image only, so it runs on every plan", by: JORDAN, days: 9, inputs: [product, { name: "specs", label: "Specs", type: "long_text", required: false }], steps: [
    { name: "Page copy", kind: "text", model: TEXT, prompt: "Product page copy for the Marlow {{input.product}}: a title, four bullets and a 150-character SEO description. Specs: {{input.specs}}", settings: { response_format: "json", json_schema: PAGE_SCHEMA }, options: { output_tokens: 3000 } },
    { name: "Studio photo", kind: "image", model: IMAGE, prompt: "The Marlow {{input.product}} leaning against an oak-panelled studio wall on a warm oak floor, soft window light, product photograph.", options: { size: "1K", aspect_ratio: "4:5" } },
  ] },
  { name: "Product photo on our backdrop", description: "Your product shot, placed on the oak studio set", by: SAM, days: 8, inputs: [{ name: "photo", label: "Product photo", type: "image", required: true }], steps: [
    { name: "On the oak set", kind: "image", model: IMAGE, prompt: "Place this bike on the oak studio set: oak-panelled wall, warm oak floor, soft window light. Keep the bike exactly as it is.", file: "{{input.photo}}", options: { size: "1K", aspect_ratio: "4:5" } },
  ] },
  { name: "Call to follow-up email", description: "A call recording in, a summary and a draft email out", by: PRIYA, days: 8, inputs: [{ name: "call", label: "Call recording", type: "audio", required: true }, { name: "to", label: "Who it's to", type: "text", required: true }], steps: [
    { name: "Transcript", kind: "transcribe", model: TRANSCRIBE, prompt: "A sales call between Marlow and a bike shop.", file: "{{input.call}}" },
    { name: "Follow-up email", kind: "text", model: TEXT, prompt: "From this call, write a short follow-up email to {{input.to}}: thank them, list what we heard in three bullets, and say what we'll do next.\n\n{{step.1}}", options: { output_tokens: 700 } },
  ] },
  { name: "Product page copy", description: "Specs from Knowledge in; a title, bullets and SEO text out", by: SAM, days: 7, inputs: [{ name: "source", label: "Find in Knowledge", type: "knowledge", required: true }], steps: [
    { name: "Page copy", kind: "text", model: TEXT, prompt: "Product page copy from these notes: a title, four bullets and a 150-character SEO description.\n{{input.source}}", settings: { response_format: "json", json_schema: PAGE_SCHEMA }, options: { output_tokens: 3000 } },
  ] },
  { name: "Weekly audio briefing", description: "This week's notes, tidied and read aloud for the dealers", by: PRIYA, days: 6, inputs: [{ name: "notes", label: "This week's notes", type: "long_text", required: true }], steps: [
    { name: "Script", kind: "text", model: TEXT, prompt: "Turn these notes into a 20 second spoken briefing for our dealers, in two or three sentences:\n{{input.notes}}", options: { output_tokens: 400 } },
    { name: "Read aloud", kind: "speech", model: TTS, prompt: "{{step.1}}", settings: { voice: "Kore", instructions: "calm, friendly, medium pace" } },
  ] },
  { name: "Teaser clip from a photo", description: "A 4 second clip that starts from one of our photos", by: JORDAN, days: 5, inputs: [{ name: "photo", label: "Photo to start from", type: "image", required: true }, { name: "motion", label: "What moves", type: "text", required: true }], steps: [
    { name: "Clip", kind: "video", model: VIDEO, prompt: "{{input.motion}}", file: "{{input.photo}}", options: { seconds: 4, resolution: "720p", audio: false, aspect_ratio: "16:9" } },
  ] },
  { name: "Social captions", description: "Three captions for one post, in our voice", by: SAM, days: 5, inputs: [{ name: "post", label: "What the post shows", type: "text", required: true }], steps: [
    { name: "Captions", kind: "text", model: TEXT, prompt: "Three short social captions for a post showing {{input.post}}. One line each, no hashtags.", options: { output_tokens: 300 } },
  ] },
  { name: "Music bed", description: "A 30 second bed for a clip, in the brand's music style", by: SAM, days: 4, inputs: [{ name: "mood", label: "Mood", type: "text", required: false }], steps: [
    { name: "Music", kind: "music", model: MUSIC, prompt: "Warm indie, around 100 bpm, no vocals. {{input.mood}}" },
  ] },
];
type Planned = { ok: boolean; errors: unknown[]; steps: { depends_on: number[] }[]; run_steps?: { kind: string; model: string; label: string; options: Options; depends_on: number[] }[] };
const planOf = (r: RecipeSeed, values?: Record<string, string>) =>
  planRecipe({ $var: { plan_in: { inputs: r.inputs, steps: r.steps.map((st) => ({ ...st, file: st.file ?? "", settings: st.settings ?? {}, options: st.options ?? {} })), values, files_given: values ? Object.keys(values) : [], mode: "build", kb_model: EMBED, kb_dimensions: 768 } } }) as Planned;
const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export const SEED_RECIPES = RECIPES.map((r) => {
  const plan = planOf(r);
  if (!plan.ok) throw new Error(`The seeded recipe "${r.name}" doesn't read: ${JSON.stringify(plan.errors)}`);
  const made = at(r.days, "10:15");
  return {
    slug: slugOf(r.name), name: r.name, description: r.description, status: "published", inputs: r.inputs,
    estimate: plan.run_steps!.reduce((sum, st) => sum + costOf(st.kind, st.model, st.options, NOW), 0),
    step_count: r.steps.length, lead_kind: leadKind(r.steps.map((x) => x.kind)), created_by: r.by, updated_by: r.by, updated_at: made, created_at: made, is_demo: true,
  };
});
export const SEED_RECIPE_STEPS = RECIPES.flatMap((r, i) => {
  const plan = planOf(r);
  return r.steps.map((st, k) => ({ recipe_id: i + 1, seq: k + 1, name: st.name, kind: st.kind, model: st.model, prompt: st.prompt, file: st.file ?? "",
    settings: st.settings ?? {}, options: st.options ?? {}, depends_on: plan.steps[k].depends_on }));
});
const recipeId = (name: string) => RECIPES.findIndex((r) => r.name === name) + 1;

// ── Runs: what the team asked for over the last two weeks, each step as it ended ──
type Outcome = "succeeded" | "blocked" | "failed" | "timed_out" | "skipped" | "queued" | "working";
type Keep = { title?: string; prompt?: string; status?: "draft" | "approved"; approvedBy?: number; private?: boolean; body?: string };
type StepSeed = {
  kind: string; model: string; label?: string; input: Options; options?: Options; depends_on?: number[]; optional?: boolean;
  outcome: Outcome; reason?: string; detail?: string; output?: Options; usage?: Options; took?: number; brand?: boolean;
  /** A file this step made, from xano/seed-files/. */
  file?: string; meta?: Record<string, unknown>;
  /** Kept in the library as an item, with how it was made. */
  keep?: Keep;
};
type RunSeed = {
  owner: number; kind: "playground" | "recipe" | "ask" | "ingest"; title: string; when: number; via?: "ui" | "easel" | "mcp";
  /** The agent key it came through (SEED_AGENT_KEYS, by position), when `via` is an agent's. */
  key?: number;
  recipe?: string; inputs?: Options[]; private?: boolean; status?: string; reason?: string; detail?: string;
  steps: StepSeed[]; approval?: "pending" | "approved" | "declined"; sample?: boolean;
};

export const SEED_RUNS: any[] = [];
export const SEED_STEPS: any[] = [];
export const SEED_ASSETS: any[] = [];
type Charge = { step_id: number; run_id: number; owner: number; when: number; estimate: number; amount: number; kind: string; model: string; via: string; key: number; state: "settled" | "released"; reason: string };
const CHARGES: Charge[] = [];
/** Runs that wait on, or were decided by, an admin: their approval rows are made below, in this order. */
const ASKED: { run: number; owner: number; status: "pending" | "approved" | "declined"; when: number }[] = [];

const ENDED: Outcome[] = ["succeeded", "blocked", "failed", "timed_out"];
const ASSET_KIND: Record<string, string> = { text: "text", image: "image", video: "video", music: "music", speech: "speech", transcribe: "transcript" };

function run(r: RunSeed) {
  const runId = SEED_RUNS.length + 1;
  const firstStep = SEED_STEPS.length + 1;
  let clock = r.when + 2 * SECOND;
  let estimate = 0, spent = 0;
  r.steps.forEach((st, i) => {
    const stepId = firstStep + i;
    const options = st.options ?? {};
    const stepEstimate = costOf(st.kind, st.model, options, r.when);
    estimate += st.outcome === "skipped" && st.optional ? 0 : stepEstimate;
    const sent = ENDED.includes(st.outcome);
    const startAt = clock;
    const took = (st.took ?? 4) * SECOND;
    if (sent) clock += took + SECOND;
    // What it was charged: a timeout is charged its estimate (the gateway bills it); anything else by its usage.
    const charged = !sent ? 0 : st.outcome === "timed_out" ? stepEstimate
      : costOf(st.kind, st.model, ["text", "speech", "transcribe", "embedding"].includes(st.kind) ? { ...options, input_tokens: num(st.usage?.input_tokens, 0), output_tokens: num(st.usage?.output_tokens, 0) } : options, r.when);
    spent += charged;
    const file = st.file ? keepFile(st.file, { run: runId, step: stepId }, st.meta) : undefined;
    const output: Options = { ...(st.output ?? {}), ...(file ? { file } : {}) };
    let assetId = 0;
    if (st.keep && st.outcome === "succeeded") {
      SEED_ASSETS.push({
        kind: ASSET_KIND[st.kind], title: st.keep.title ?? r.title, prompt: st.keep.prompt ?? String(st.input.prompt ?? st.input.text ?? ""),
        sent_prompt: String(output.sent_prompt ?? st.input.prompt ?? st.input.text ?? ""), model: st.model,
        settings: { ...options, request: Object.fromEntries(Object.entries(st.input).filter(([k]) => !["prompt", "text", "system", "files", "images", "image", "audio", "fill", "file_input"].includes(k))) },
        inputs: { files: (st.input.sources as unknown[]) ?? [], from_steps: st.depends_on ?? [], from_asset: 0 },
        file: file ?? null, body: st.keep.body ?? String(output.text ?? ""), maker_id: r.owner, estimated_cost: charged, brand_applied: st.brand ?? false,
        run_id: runId, step_id: stepId, attempt: 1, private: st.keep.private ?? false, status: st.keep.status ?? "draft",
        approved_by: st.keep.status === "approved" ? st.keep.approvedBy ?? JORDAN : 0,
        approved_at: st.keep.status === "approved" ? clock + 40 * MINUTE : null, is_demo: true, created_at: clock,
      });
      assetId = SEED_ASSETS.length;
    }
    SEED_STEPS.push({
      run_id: runId, seq: i + 1, label: st.label ?? "", kind: st.kind, model: st.model, input: st.input, options, depends_on: st.depends_on ?? [], optional: st.optional ?? false,
      status: st.outcome, reason: st.reason ?? (st.outcome === "timed_out" ? "timeout" : ""), detail: st.detail ?? "", attempt: 1,
      timeout_s: STEP_TIMEOUT_SECONDS[st.kind as keyof typeof STEP_TIMEOUT_SECONDS] ?? 120, claimed: sent || st.outcome === "working" ? 1 : 0,
      claimed_at: sent || st.outcome === "working" ? startAt : null, sent_at: sent || st.outcome === "working" ? startAt : null,
      finished_at: sent || st.outcome === "skipped" ? clock : null, output: st.outcome === "working" ? {} : output, usage: st.usage ?? {},
      estimate: stepEstimate, charged, brand_applied: st.brand ?? false, asset_id: assetId, created_at: r.when,
    });
    if (sent) CHARGES.push({ step_id: stepId, run_id: runId, owner: r.owner, when: startAt, estimate: stepEstimate, amount: charged, kind: st.kind, model: st.model, via: r.via ?? "ui", key: r.key ?? 0, state: "settled", reason: st.outcome });
    // A step a failure skipped had money held for it, and let it go.
    if (st.outcome === "skipped" && !st.optional && r.status !== "waiting_approval" && r.status !== "declined") {
      CHARGES.push({ step_id: stepId, run_id: runId, owner: r.owner, when: clock, estimate: stepEstimate, amount: 0, kind: st.kind, model: st.model, via: r.via ?? "ui", key: r.key ?? 0, state: "released", reason: "skipped" });
    }
  });
  const outcomes = r.steps.filter((st) => !st.optional).map((st) => st.outcome);
  const good = outcomes.filter((o) => o === "succeeded").length;
  const bad = outcomes.filter((o) => ["blocked", "failed", "timed_out"].includes(o)).length;
  const status = r.status ?? (good && !bad ? "done" : good ? "partial" : "failed");
  const finished = ["done", "partial", "failed", "declined"].includes(status);
  if (r.approval) ASKED.push({ run: runId, owner: r.owner, status: r.approval, when: r.when + 5 * SECOND });
  SEED_RUNS.push({
    owner_id: r.owner, kind: r.kind, via: r.via ?? "ui", connection_id: r.key ?? 0, idem_key: `seed-${runId}`, body_hash: "", recipe_id: r.recipe ? recipeId(r.recipe) : 0,
    inputs: r.inputs ?? [], title: r.title, status, reason: r.reason ?? "", detail: r.detail ?? "", estimate, spent, private: r.private ?? false,
    base_url: "", retry_key: "", approval_id: r.approval ? ASKED.length : 0, finished_at: finished ? clock : null, is_demo: true, sample: r.sample ?? false, created_at: r.when,
  });
  return runId;
}

/** A Playground text step that succeeded, with its usage. */
const text = (prompt: string, said: string, used: [number, number], keep?: Keep, extra: Partial<StepSeed> = {}): StepSeed => ({
  kind: "text", model: TEXT, input: { prompt, use_brand: true }, options: { output_tokens: 4000 }, outcome: "succeeded", brand: true,
  output: { text: said, json: null, finish_reason: "stop", sent_prompt: prompt }, usage: { input_tokens: used[0], output_tokens: used[1] }, took: 4, keep, ...extra,
});
/** An image the app made, with the prompt the person wrote and the brand kit's look added. */
const image = (prompt: string, file: string, keep: Keep | undefined, options: Options = { size: "1K", aspect_ratio: "4:5" }, extra: Partial<StepSeed> = {}): StepSeed => ({
  kind: "image", model: IMAGE, input: { prompt, use_brand: true }, options, outcome: "succeeded", brand: true, file,
  output: { text: "", sent_prompt: `${prompt} ${LOOK}` }, usage: { input_tokens: 58, output_tokens: 1120 }, took: 11, keep: keep && { prompt, ...keep }, ...extra,
});
const speech = (words: string, file: string, used: [number, number], seconds: number, keep?: Keep, extra: Partial<StepSeed> = {}): StepSeed => ({
  kind: "speech", model: TTS, input: { text: words, voice: "Kore", instructions: "calm, friendly, medium pace", use_brand: true }, options: { input_tokens: used[0], output_tokens: used[1] },
  outcome: "succeeded", brand: true, file, meta: { duration: seconds }, output: { voice: "Kore" }, usage: { input_tokens: used[0], output_tokens: used[1] }, took: 4, keep: keep && { prompt: words, ...keep }, ...extra,
});

// The team library's oldest work: taglines and the brand voice, the week the autumn push started.
run({ owner: SAM, kind: "playground", title: "Three taglines for the Trail 2", when: at(10, "09:40"), private: true, steps: [
  text("Three taglines for the Trail 2, our sage-green trail bike. Short, plain, no hype.",
    "1. The Trail 2 likes rough ground. So will you.\n2. Room for 2.4 in tyres, with mud to spare.\n3. Built for long days and the ride home.", [520, 180],
    { title: "Trail 2 taglines", status: "approved", approvedBy: JORDAN }),
] });
run({ owner: SAM, kind: "playground", title: "Read the Trail 2 line in Kore", when: at(10, "14:30"), private: true, steps: [
  { kind: "speech", model: TTS, input: { text: "The Trail 2 likes rough ground. So will you.", voice: "Kore", use_brand: true }, options: { input_tokens: 24, output_tokens: 120 },
    outcome: "succeeded", brand: true, output: { voice: "Kore" }, usage: { input_tokens: 24, output_tokens: 118 }, took: 3 },
] });
run({ owner: JORDAN, kind: "playground", title: "Summarise the brand voice guide", when: at(9, "10:00"), private: true, steps: [
  text("Summarise our brand voice guide in five bullets for a new freelancer.", "• Plain, warm and a little dry.\n• Ride first, then the one spec that matters, exactly once.\n• Talk to one rider as \"you\".\n• Be honest about who a bike isn't for.\n• Never: game-changer, unleash, epic, best-in-class.", [1240, 210],
    undefined, { input: { prompt: "Summarise our brand voice guide in five bullets for a new freelancer.", use_brand: true } }),
] });
const MUSIC_PROMPT = "Warm indie, around 100 bpm, no vocals, acoustic guitar and soft drums. A faster cut for a 15 second clip.";
run({ owner: SAM, kind: "playground", title: "Music bed, faster cut", when: at(9, "16:00"), private: true, steps: [
  { kind: "music", model: MUSIC, input: { prompt: MUSIC_PROMPT, use_brand: true }, outcome: "failed", reason: "model_error", brand: true, took: 25,
    detail: "The model didn't finish this one. It was sent, so it may be charged. Try again.", output: { gateway_message: "Xano AI refused the request (HTTP 500): internal error" } },
] });

// The Trail 2 launch kit: copy, hero and the sound landed; the video ran past its limit and was charged, as the gateway bills it.
const TRAIL_SCRIPT = "This is the Marlow Trail 2. If you're between a medium and a large, take the medium: it rides long. It takes tyres up to 2.4 inches, and the frame has a lifetime warranty. Go and ride it.";
const kitInputs = (productName: string, points: string) => [
  { name: "product", label: "Product", type: "text", value: productName }, { name: "points", label: "What to get across", type: "long_text", value: points },
];
const kitPlan = planOf(RECIPES[0], { product: "Trail 2", points: "x" }).run_steps!;
run({ owner: SAM, kind: "recipe", recipe: LAUNCH_KIT, title: "Product launch kit: Trail 2", when: at(8, "09:55"), approval: "approved",
  inputs: kitInputs("Trail 2", "It rides long (between M and L, take the M), 2.4 in tyre clearance, lifetime frame warranty."), steps: [
    { kind: "text", model: TEXT, label: "Launch copy", input: { prompt: "Write launch copy for the Marlow Trail 2: a headline, a short body and a 15 second voiceover script. Get across: It rides long (between M and L, take the M), 2.4 in tyre clearance, lifetime frame warranty.", response_format: "json", json_schema: COPY_SCHEMA, use_brand: true },
      options: kitPlan[0].options, outcome: "succeeded", brand: true, took: 5, usage: { input_tokens: 820, output_tokens: 640 },
      output: { text: "", json: { headline: "The Trail 2 likes rough ground", body: "Sage green, room for 2.4 in tyres and a frame we cover for as long as you own it. It rides long, so if you're between a medium and a large, take the medium.", script: TRAIL_SCRIPT }, finish_reason: "stop" },
      keep: { title: "Trail 2 launch copy", body: "The Trail 2 likes rough ground\n\nSage green, room for 2.4 in tyres and a frame we cover for as long as you own it. It rides long, so if you're between a medium and a large, take the medium.\n\nVoiceover: " + TRAIL_SCRIPT } },
    { ...image("A rider on the Marlow Trail 2 on the kind of ground it's built for, mid-morning light.", "trail-2-hero-forest.jpg", { title: "Trail 2 hero, forest singletrack", status: "approved", approvedBy: JORDAN }), label: "Hero image", options: kitPlan[1].options, depends_on: [] },
    { kind: "video", model: VIDEO, label: "8 s video", input: { prompt: "The bike ridden past the camera, tracking alongside.", use_brand: true }, options: kitPlan[2].options, depends_on: [2], outcome: "timed_out", brand: true, took: 600,
      detail: "No answer came back within 600 seconds. The gateway still charges for a call it was sent, so it's counted." },
    { ...speech(TRAIL_SCRIPT, "trail-2-voiceover.mp3", [57, 336], 13.5, { title: "Trail 2 voiceover", status: "approved", approvedBy: JORDAN }), label: "Voiceover", options: kitPlan[3].options, depends_on: [1] },
    { kind: "music", model: MUSIC, label: "Music bed", input: { prompt: "Warm indie, around 100 bpm, no vocals, acoustic guitar and soft drums", use_brand: true }, outcome: "succeeded", brand: true, took: 26,
      file: "warm-indie-bed.mp3", meta: { duration: 30 }, output: { lyrics: null, description: "Warm indie instrumental, acoustic guitar and soft drums" }, keep: { title: "Warm indie bed, 30 s" } },
  ] });

run({ owner: JORDAN, kind: "playground", title: "Rewrite the size guide intro", when: at(8, "15:05"), private: true, steps: [
  text("Rewrite the size guide intro so a shop customer gets it in one read.", "Measure your inside leg in bare feet, then read across the table. Between two sizes? Take the smaller for a road bike and the larger for touring. The Trail 2 rides long, so take the medium if you're between a medium and a large.", [610, 140],
    { title: "Size guide intro, rewritten" }),
] });
run({ owner: SAM, kind: "playground", title: "Alt text for the Trail 2 hero", when: at(7, "10:30"), private: true, steps: [
  text("Alt text for the Trail 2 hero photo: a rider on a forest singletrack.", "A rider on a sage-green Marlow Trail 2 rolls along a dry forest singletrack, sun through the pines.", [210, 60], { title: "Trail 2 hero alt text", status: "approved", approvedBy: SAM }),
] });

const pagePlan = planOf(RECIPES[1], { product: "City 3", specs: "x" }).run_steps!;
run({ owner: JORDAN, kind: "recipe", recipe: FREE_PLAN_RECIPE, title: "Product page copy and photo: City 3", when: at(7, "11:20"),
  inputs: [{ name: "product", label: "Product", type: "text", value: "City 3" }, { name: "specs", label: "Specs", type: "long_text", value: "Upright commuter, 8-speed hub, dynamo lights, rear rack, £1,290, slate and oat." }], steps: [
    { kind: "text", model: TEXT, label: "Page copy", input: { prompt: "Product page copy for the Marlow City 3: a title, four bullets and a 150-character SEO description. Specs: Upright commuter, 8-speed hub, dynamo lights, rear rack, £1,290, slate and oat.", response_format: "json", json_schema: PAGE_SCHEMA, use_brand: true },
      options: pagePlan[0].options, outcome: "succeeded", brand: true, took: 4, usage: { input_tokens: 690, output_tokens: 310 },
      output: { text: "", json: { title: "Marlow City 3", bullets: ["Upright and quiet: you arrive in a good mood", "8-speed hub: no chain to clean in the rain", "Dynamo lights that are always there", "Rear rack for the work bag"], seo: "The Marlow City 3: an upright commuter with an 8-speed hub, dynamo lights and a rear rack. £1,290 in slate or oat." }, finish_reason: "stop" },
      keep: { title: "City 3 product page copy", status: "approved", approvedBy: JORDAN, body: "Marlow City 3\n\n• Upright and quiet: you arrive in a good mood\n• 8-speed hub: no chain to clean in the rain\n• Dynamo lights that are always there\n• Rear rack for the work bag\n\nSEO: The Marlow City 3: an upright commuter with an 8-speed hub, dynamo lights and a rear rack. £1,290 in slate or oat." } },
    { ...image("The Marlow City 3 leaning against an oak-panelled studio wall on a warm oak floor, soft window light, product photograph.", "city-3-studio.jpg", { title: "City 3 on the oak set", status: "approved", approvedBy: JORDAN }), label: "Studio photo", options: pagePlan[1].options },
  ] });

run({ owner: SAM, kind: "playground", title: "City 3 commuter, morning street", when: at(6, "10:05"), private: true, steps: [
  image("A commuter riding an upright slate-grey Marlow City 3 city bike with a rear rack along a quiet city street in the early morning, office clothes, wet cobbles.", "city-3-commute.jpg",
    { title: "City 3 commuter, morning street", status: "approved", approvedBy: JORDAN }),
] });
run({ owner: PRIYA, kind: "playground", title: "Dealer newsletter: autumn", when: at(6, "13:45"), private: true, steps: [
  text("Draft a short autumn newsletter for our dealers: Trail 2 sizing, City 3 rack video coming, warranty.", "Autumn at Marlow\n\nThe Trail 2 rides long: between a medium and a large, put riders on the medium. The City 3 rack video lands next week, showing which bolts take the rack and which take the mudguards. And a reminder: every frame is covered for as long as its first owner keeps it.", [480, 190],
    { title: "Dealer newsletter, autumn draft" }),
] });

const HALDEN_TRANSCRIPT = "Speaker 1: Thanks for making time, Riley. I wanted to talk through how the Trail 2 is landing with your customers.\nSpeaker 2: Sure. Overall it's selling well. The sage green is the most popular color by a long way.\nSpeaker 1: Good to hear. What about sizing? We've heard mixed things.\nSpeaker 2: That's the main one. People between a medium and a large keep asking us. We tell them to take the medium, because it rides long.\nSpeaker 2: The reach on the large surprised a few of our test riders. Two of the three people who tried both picked the smaller frame.\nSpeaker 2: Mention the new tire clearance. Customers love that it takes 2.4 inch tires now.\nSpeaker 2: The lifetime frame warranty closes a lot of sales. Put it front and center.";
run({ owner: PRIYA, kind: "recipe", recipe: "Call to follow-up email", title: "Call to follow-up email: Halden Cycles", when: at(6, "15:20"),
  inputs: [{ name: "call", label: "Call recording", type: "audio", value: "halden-cycles-call.mp3" }, { name: "to", label: "Who it's to", type: "text", value: "Riley at Halden Cycles" }], steps: [
    { kind: "transcribe", model: TRANSCRIBE, label: "Transcript", input: { prompt: "A sales call between Marlow and a bike shop.", sources: [{ name: "halden-cycles-call.mp3", size: 195164, mime: "audio/mpeg" }] },
      options: { input_tokens: 2100, output_tokens: 600 }, outcome: "succeeded", took: 2, usage: { input_tokens: 2100, output_tokens: 410 }, output: { text: HALDEN_TRANSCRIPT },
      keep: { title: "Halden Cycles call transcript", prompt: "A sales call between Marlow and a bike shop." } },
    { kind: "text", model: TEXT, label: "Follow-up email", input: { prompt: "From this call, write a short follow-up email to Riley at Halden Cycles: thank them, list what we heard in three bullets, and say what we'll do next.", use_brand: true }, depends_on: [1],
      options: { output_tokens: 700 }, outcome: "succeeded", brand: true, took: 4, usage: { input_tokens: 980, output_tokens: 230 },
      output: { text: "Hi Riley,\n\nThanks for the time today. What we heard:\n• Sage green is the clear favourite.\n• Riders between M and L should take the M: it rides long.\n• The 2.4 in tyre clearance and the lifetime frame warranty sell it.\n\nNext, we'll send a short fit video and the draft copy by Thursday.\n\nPriya" },
      keep: { title: "Follow-up email to Halden Cycles" } },
  ] });

run({ owner: SAM, kind: "recipe", recipe: FREE_PLAN_RECIPE, title: "Product page copy and photo: Trail 2", when: at(5, "14:10"),
  inputs: [{ name: "product", label: "Product", type: "text", value: "Trail 2" }, { name: "specs", label: "Specs", type: "long_text", value: "Hardtail trail bike, 2.4 in tyres, 130 mm fork, £1,850, sage green and slate." }], steps: [
    { kind: "text", model: TEXT, label: "Page copy", input: { prompt: "Product page copy for the Marlow Trail 2: a title, four bullets and a 150-character SEO description. Specs: Hardtail trail bike, 2.4 in tyres, 130 mm fork, £1,850, sage green and slate.", response_format: "json", json_schema: PAGE_SCHEMA, use_brand: true },
      options: pagePlan[0].options, outcome: "succeeded", brand: true, took: 4, usage: { input_tokens: 700, output_tokens: 300 },
      output: { text: "", json: { title: "Marlow Trail 2", bullets: ["Likes rough ground: 130 mm fork and room for 2.4 in tyres", "Rides long: between M and L, take the M", "Frame covered for as long as you own it", "Sage green or slate, £1,850"], seo: "The Marlow Trail 2 hardtail: room for 2.4 in tyres, a 130 mm fork and a lifetime frame warranty. £1,850." }, finish_reason: "stop" },
      keep: { title: "Trail 2 product page copy", status: "approved", approvedBy: JORDAN, body: "Marlow Trail 2\n\n• Likes rough ground: 130 mm fork and room for 2.4 in tyres\n• Rides long: between M and L, take the M\n• Frame covered for as long as you own it\n• Sage green or slate, £1,850\n\nSEO: The Marlow Trail 2 hardtail: room for 2.4 in tyres, a 130 mm fork and a lifetime frame warranty. £1,850." } },
    { ...image("The Marlow Trail 2 leaning against an oak-panelled studio wall on a warm oak floor, soft window light, product photograph.", "trail-2-studio-oak.jpg", { title: "Trail 2 on the oak set" }), label: "Studio photo", options: pagePlan[1].options },
  ] });

run({ owner: SAM, kind: "recipe", recipe: "Social captions", title: "Social captions: City 3 on the morning street", when: at(4, "11:00"),
  inputs: [{ name: "post", label: "What the post shows", type: "text", value: "the City 3 on a wet morning street" }], steps: [
    { ...text("Three short social captions for a post showing the City 3 on a wet morning street. One line each, no hashtags.",
      "Wet cobbles, dry chain.\nUpright, quiet, on time.\nThe City 3 doesn't mind the weather. Neither will you.", [320, 70], { title: "City 3 captions, wet street" }), label: "Captions", options: { output_tokens: 300 } },
  ] });
run({ owner: SAM, kind: "playground", title: "Trail 2 tyre clearance close-up", when: at(4, "15:30"), private: true, steps: [
  image("Close-up of the rear triangle of a sage-green trail bike showing generous clearance around a 2.4 inch knobbly tyre, mud on the tread, outdoors.", "trail-2-tyre-detail.jpg",
    { title: "Trail 2 tyre clearance, close-up" }, { size: "1K", aspect_ratio: "1:1" }),
] });
// Priya wanted a launch kit for a holiday push; video by a member needs an admin, and Jordan said not this month.
run({ owner: PRIYA, kind: "recipe", recipe: LAUNCH_KIT, title: "Product launch kit: holiday gift guide", when: at(4, "16:15"), approval: "declined", status: "declined", reason: "declined",
  detail: "Declined by Jordan Lee. Nothing was charged.", inputs: kitInputs("City 3", "A holiday gift for the commuter in your life."),
  steps: kitPlan.map((st) => ({ kind: st.kind, model: st.model, label: st.label, input: { prompt: "", use_brand: true }, options: st.options, depends_on: st.depends_on, outcome: "skipped" as const, reason: "declined" })) });

run({ owner: SAM, kind: "recipe", recipe: "Product page copy", title: "Product page copy: Trail 2 spec sheet", when: at(3, "09:50"),
  inputs: [{ name: "source", label: "Find in Knowledge", type: "knowledge", value: "Trail 2 sizing and frame" }], steps: [
    { kind: "embedding", model: EMBED, label: "Find “Trail 2 sizing and frame” in Knowledge", input: { input: ["Trail 2 sizing and frame"], task_type: "RETRIEVAL_QUERY", dimensions: 768, kb_input: "source" },
      options: { input_tokens: 14, input_type: "text" }, outcome: "succeeded", took: 1, usage: { input_tokens: 6 }, output: { count: 1, dimensions: 768 } },
    { kind: "text", model: TEXT, label: "Page copy", input: { prompt: "Product page copy from these notes: a title, four bullets and a 150-character SEO description.", response_format: "json", json_schema: PAGE_SCHEMA, use_brand: true }, depends_on: [1],
      options: { output_tokens: 3000 }, outcome: "succeeded", brand: true, took: 4, usage: { input_tokens: 1450, output_tokens: 290 },
      output: { text: "", json: { title: "Trail 2: a hardtail that rides long", bullets: ["A hardtail for rough ground and long days", "Rides long: between two sizes, take the smaller", "Room for 2.4 in tyres on 29 in wheels", "13.9 kg in a medium, lifetime frame warranty"], seo: "Marlow Trail 2: a hardtail that rides long, with room for 2.4 in tyres and a lifetime frame warranty." }, finish_reason: "stop" },
      keep: { title: "Trail 2 page copy from the spec sheet", status: "approved", approvedBy: SAM, body: "Trail 2: a hardtail that rides long\n\n• A hardtail for rough ground and long days\n• Rides long: between two sizes, take the smaller\n• Room for 2.4 in tyres on 29 in wheels\n• 13.9 kg in a medium, lifetime frame warranty" } },
  ] });
run({ owner: JORDAN, kind: "playground", title: "Coast road at dusk, still", when: at(3, "16:40"), private: true, steps: [
  image("A cyclist in cycling kit pedalling a sage-green pedal-powered mountain bicycle on a winding coast road at dusk, sea and cliffs behind, warm low sun after sunset.", "coast-road-dusk-still.jpg",
    { title: "Coast road at dusk", status: "approved", approvedBy: JORDAN }, { size: "1K", aspect_ratio: "16:9" }),
] });

const OAK_TRANSCRIPT = "Speaker 1: Hi Tom, it's Priya from Marlow. I wanted to hear how the City 3 is doing at Oak and Spoke.\nSpeaker 2: It's our best seller for commuters this autumn. People love how upright it is.\nSpeaker 2: The hub gears too. Nobody wants to clean a chain in the rain.\nSpeaker 2: The rack mounts confuse people: they can't tell which bolts are for the rack and which are for the mudguards.\nSpeaker 2: A thirty second voiceover showing where the rack goes would save us a lot of time.\nSpeaker 2: The dynamo lights get asked about most, before the price.\nSpeaker 2: A few riders over a hundred and ninety centimetres want an extra large.";
run({ owner: PRIYA, kind: "recipe", recipe: "Call to follow-up email", title: "Call to follow-up email: Oak & Spoke", when: at(2, "10:40"),
  inputs: [{ name: "call", label: "Call recording", type: "audio", value: "oak-and-spoke-call.mp3" }, { name: "to", label: "Who it's to", type: "text", value: "Tom at Oak & Spoke" }], steps: [
    { kind: "transcribe", model: TRANSCRIBE, label: "Transcript", input: { prompt: "A sales call between Marlow and a bike shop.", sources: [{ name: "oak-and-spoke-call.mp3", size: 278273, mime: "audio/mpeg" }] },
      options: { input_tokens: 2250, output_tokens: 600 }, outcome: "succeeded", took: 2, usage: { input_tokens: 2250, output_tokens: 380 }, output: { text: OAK_TRANSCRIPT },
      keep: { title: "Oak & Spoke call transcript", prompt: "A sales call between Marlow and a bike shop." } },
    { kind: "text", model: TEXT, label: "Follow-up email", input: { prompt: "From this call, write a short follow-up email to Tom at Oak & Spoke: thank them, list what we heard in three bullets, and say what we'll do next.", use_brand: true }, depends_on: [1],
      options: { output_tokens: 700 }, outcome: "succeeded", brand: true, took: 4, usage: { input_tokens: 940, output_tokens: 220 },
      output: { text: "Hi Tom,\n\nThanks for the call. What we heard:\n• Commuters love the City 3's upright position and hub gears.\n• The rack and mudguard bolts confuse people.\n• Dynamo lights come up before the price, and taller riders want an XL.\n\nNext, we're making a 30 second rack video, and I've taken the XL request to the team.\n\nPriya" },
      keep: { title: "Follow-up email to Oak & Spoke" } },
  ] });
// A prompt the model declined: it sent nothing back, and Xano AI still charged for it.
run({ owner: SAM, kind: "playground", title: "A tagline that mocks other brands", when: at(2, "11:15"), private: true, steps: [
  { kind: "text", model: TEXT, input: { prompt: "Write a cheeky tagline mocking a rival brand's riders by name.", use_brand: true }, options: { output_tokens: 4000 }, outcome: "blocked", reason: "blocked", brand: true, took: 3,
    detail: "The model declined this prompt and sent nothing back. Xano AI still charges for it. Change the prompt and try again.",
    output: { text: "", json: null, finish_reason: null, sent_prompt: "Write a cheeky tagline mocking a rival brand's riders by name." }, usage: { input_tokens: 40, output_tokens: 157 } },
] });
for (const [model, said, used] of [
  [TEXT, "The City 3: upright, quiet and dry-chained.", [380, 90]],
  [SONNET, "Ride to work and arrive in a good mood. The City 3.", [380, 40]],
] as const) {
  run({ owner: JORDAN, kind: "playground", title: `City 3 headline, ${model === TEXT ? "Gemini 3.8 Flash" : "Claude Sonnet 5.5"}`, when: at(2, model === TEXT ? "14:20" : "14:21"), private: true, steps: [
    { ...text("One headline for the City 3 product page.", said, [used[0], used[1]], { title: "City 3 headline", private: true }), model },
  ] });
}

run({ owner: SAM, kind: "playground", title: "Caption for the City 3 photo", when: at(1, "10:10"), private: true, steps: [
  text("An Instagram caption for the City 3 commuter photo.", "Morning rain, dry trousers. The rack takes the work bag; the hub gears take the hills.", [260, 50], { title: "City 3 photo caption" }),
] });
run({ owner: SAM, kind: "recipe", recipe: "Product page copy", title: "Product page copy: City 3 notes", when: at(1, "13:30"),
  inputs: [{ name: "source", label: "Find in Knowledge", type: "knowledge", value: "City 3 product notes" }], steps: [
    { kind: "embedding", model: EMBED, label: "Find “City 3 product notes” in Knowledge", input: { input: ["City 3 product notes"], task_type: "RETRIEVAL_QUERY", dimensions: 768, kb_input: "source" },
      options: { input_tokens: 13, input_type: "text" }, outcome: "succeeded", took: 1, usage: { input_tokens: 5 }, output: { count: 1, dimensions: 768 } },
    { kind: "text", model: TEXT, label: "Page copy", input: { prompt: "Product page copy from these notes: a title, four bullets and a 150-character SEO description.", response_format: "json", json_schema: PAGE_SCHEMA, use_brand: true }, depends_on: [1],
      options: { output_tokens: 3000 }, outcome: "succeeded", brand: true, took: 4, usage: { input_tokens: 1380, output_tokens: 280 },
      output: { text: "", json: { title: "City 3: the quiet commuter", bullets: ["Upright, quiet commuting", "8-speed hub and a belt-ready frame", "Dynamo lights, always on hand", "S, M and L, in slate or oat"], seo: "The Marlow City 3 commuter: 8-speed hub, dynamo lights and an upright ride. £1,290." }, finish_reason: "stop" },
      keep: { title: "City 3 page copy from the notes", body: "City 3: the quiet commuter\n\n• Upright, quiet commuting\n• 8-speed hub and a belt-ready frame\n• Dynamo lights, always on hand\n• S, M and L, in slate or oat" } },
  ] });
const BRIEFING_NOTES = "Dealers love the City 3's upright position and hub gears. Rack video goes out Friday. Taller riders asking for an XL.";
const BRIEFING = "This week on the City 3: riders love the upright position and the hub gears. The rack video goes out on Friday.";
run({ owner: PRIYA, kind: "recipe", recipe: "Weekly audio briefing", title: "Weekly audio briefing: City 3", when: at(1, "16:30"),
  inputs: [{ name: "notes", label: "This week's notes", type: "long_text", value: BRIEFING_NOTES }], steps: [
    { ...text(`Turn these notes into a 20 second spoken briefing for our dealers, in two or three sentences:\n${BRIEFING_NOTES}`, BRIEFING, [260, 60], { title: "City 3 briefing script" }), label: "Script", options: { output_tokens: 400 } },
    { ...speech(BRIEFING, "city-3-briefing.mp3", [32, 192], 7.7, { title: "City 3 dealer briefing", status: "approved", approvedBy: PRIYA }), label: "Read aloud", depends_on: [1] },
  ] });
run({ owner: JORDAN, kind: "playground", via: "easel", title: "Three captions for the approved City 3 photo", when: at(1, "16:10"), private: false, steps: [
  text("Three captions for the approved City 3 commuter photo, in our voice.", "Slate grey, rack on, lights on.\nHub gears don't mind the rain.\nArrive in a good mood: the City 3.", [450, 60], { title: "City 3 captions from Easel" }),
] });

// Sam's own agent key: Claude Code, connected to work from his editor. It has no token (one is shown only when a key is
// made), so it can't be used; it shows what an agent's work looks like here.
export const CLAUDE_CODE = 1;
export const SEED_AGENT_KEYS = [
  { user_id: SAM, name: "Claude Code", kind: "key", scope: "read_write", revoked: false, expires_at: NOW + 80 * DAY, last_used_at: today(25), created_at: at(3, "09:30") },
];

// Today: captions, a draft from Sam's agent, a question from Alex, and two runs waiting for Jordan.
run({ owner: SAM, kind: "recipe", recipe: "Social captions", title: "Social captions: Trail 2 tyre close-up", when: today(150),
  inputs: [{ name: "post", label: "What the post shows", type: "text", value: "the Trail 2's 2.4 in tyre clearance, muddy" }], steps: [
    { ...text("Three short social captions for a post showing the Trail 2's 2.4 in tyre clearance, muddy. One line each, no hashtags.",
      "Room for 2.4 in tyres, with mud to spare.\nThe mud got bigger. So did the gap.\nTrail 2: clearance you'll use.", [330, 70], { title: "Trail 2 captions, tyre close-up" }), label: "Captions", options: { output_tokens: 300 } },
  ] });
run({ owner: SAM, kind: "playground", via: "mcp", key: CLAUDE_CODE, title: "Newsletter blurb for the Trail 2", when: today(25), private: false, steps: [
  text("A two-sentence newsletter blurb for the Trail 2, from the spec sheet, in our voice.",
    "Trail 2 for the newsletter\n\nThe Trail 2 likes the ground other bikes avoid: room for 2.4 in tyres and a 130 mm fork. It rides long, so between sizes take the smaller, and its frame is covered for as long as you own it.", [690, 120],
    { title: "Trail 2 newsletter blurb" }),
] });
const cityKit = planOf(RECIPES[0], { product: "City 3", points: "x" }).run_steps!;
run({ owner: SAM, kind: "recipe", recipe: LAUNCH_KIT, title: "Product launch kit: City 3", when: today(95), approval: "pending", status: "waiting_approval", reason: "video",
  detail: "Video runs by members wait for an admin. Nothing is charged until it's approved.",
  inputs: kitInputs("City 3", "Upright, hub gears, dynamo lights, and where the rack goes."),
  steps: cityKit.map((st) => ({ kind: st.kind, model: st.model, label: st.label, input: { prompt: "", use_brand: true }, options: st.options, depends_on: st.depends_on, outcome: "queued" as const })) });
run({ owner: PRIYA, kind: "playground", title: "Rack fitting clip for the City 3", when: today(60), private: true, approval: "pending", status: "waiting_approval", reason: "video",
  detail: "Video runs by members wait for an admin. Nothing is charged until it's approved.", steps: [
    { kind: "video", model: VIDEO, input: { prompt: "Hands fitting a rear rack to a slate City 3 commuter bike, close on the two rack bolts, workshop window light.", use_brand: true },
      options: { seconds: 8, resolution: "720p", audio: false, aspect_ratio: "16:9" }, outcome: "queued" },
  ] });

// ── Knowledge: the sources the team added, each read by its own run ──
const vectors = (seedVectors as { vectors: Record<string, number[]> }).vectors;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const SEED_KB_SOURCES: any[] = [];
export const SEED_PASSAGES: any[] = [];
const ADDED: Record<string, number> = {
  "Marlow brand voice guide": at(10, "09:15"), "Trail 2 spec sheet": at(9, "11:40"), "Marlow size guide": at(9, "14:05"), "Customer call: Halden Cycles": at(7, "16:20"),
  "Dealer call: Oak & Spoke on the City 3": at(3, "11:10"), "City 3 product notes": at(5, "10:50"), "Autumn launch plan": at(5, "09:20"), "Warranty terms 2027": at(2, "15:45"),
};
for (const source of SEED_SOURCES) {
  const when = ADDED[source.title];
  const words = source.passages.reduce((n, p) => n + p.text.length, 0);
  const embedTokens = Math.ceil(words / 4);
  let runId = 0;
  if (source.status === "ready") {
    const reading: StepSeed[] = source.format === "audio"
      ? [{ kind: "text", model: TEXT, label: "Transcribe with speakers and times", input: { prompt: "Transcribe this recording as lines with start seconds and speaker labels.", response_format: "json" }, options: { input_tokens: source.duration_s * 32 + 300, output_tokens: 8000 },
          outcome: "succeeded", took: 8, usage: { input_tokens: source.duration_s * 32 + 280, output_tokens: 1150 }, output: { text: "", finish_reason: "stop" } }]
      : source.format === "pdf"
        ? [{ kind: "text", model: TEXT, label: "Read pages 1 to 1", input: { prompt: "Read pages 1 to 1 of this PDF as Markdown, marking each page.", response_format: "json" }, options: { input_tokens: 1050, output_tokens: 12000 },
            outcome: "succeeded", took: 5, usage: { input_tokens: 1040, output_tokens: 520 }, output: { text: "", finish_reason: "stop" } }]
        : [];
    const embed: StepSeed = { kind: "embedding", model: EMBED, label: "Embed passages", input: { input: [], task_type: "RETRIEVAL_DOCUMENT", dimensions: 768 }, options: { input_tokens: embedTokens + 50, input_type: "text" },
      depends_on: reading.length ? [1] : [], outcome: "succeeded", took: 2, usage: { input_tokens: embedTokens }, output: { count: source.passages.length, dimensions: 768 } };
    runId = run({ owner: source.by, kind: "ingest", title: `Read ${source.title} into Knowledge`, when, private: true, steps: [...reading, embed] });
  }
  const sourceId = SEED_KB_SOURCES.length + 1;
  const bytes = source.file ? bytesOf(source.file).length : Buffer.byteLength(source.passages.map((p) => p.text).join("\n\n"));
  SEED_KB_SOURCES.push({
    title: source.title, kind: source.kind, format: source.format, file_name: source.file_name, mime: source.mime, size: bytes, pages: source.pages, duration_s: source.duration_s,
    status: source.status, detail: source.status === "ready" ? "" : source.detail, run_id: runId, added_by: source.by, passages: source.passages.length, can_retry: false,
    audio: source.format === "audio" ? keepFile(source.file, { source: sourceId }) : null,
    ready_at: source.status === "ready" ? when + 20 * SECOND : null, is_demo: true, created_at: when,
  });
  source.passages.forEach((p, i) => SEED_PASSAGES.push({
    source_id: sourceId, seq: i + 1, text: p.text, page: p.page, start_s: p.start_s, speaker: p.speaker, batch: 1, embedding: vectors[sha(p.text)] ?? null, live: true,
  }));
}

// Questions asked of Knowledge, answered with citations, as an Ask run leaves them: the passages the answer was given (in
// the order it was given them) and the numbers it cited. Each person sees only their own. Rerank has no model on this
// gateway, so it's skipped by design.
/** A seeded passage's id: the source's title and the passage's place in it, from 1. */
const passageId = (title: string, seq: number) => {
  const source = SEED_KB_SOURCES.findIndex((s) => s.title === title) + 1;
  const at = SEED_PASSAGES.findIndex((p) => p.source_id === source && p.seq === seq);
  if (!source || at < 0) throw new Error(`No seeded passage ${seq} in ${title}`);
  return at + 1;
};
const VOICE = "Marlow brand voice guide", SPEC = "Trail 2 spec sheet", HALDEN = "Customer call: Halden Cycles", OAK = "Dealer call: Oak & Spoke on the City 3";
const CITY = "City 3 product notes", PLAN = "Autumn launch plan";
type AskSeed = { who: number; when: number; question: string; answer: string; given: [string, number][]; cited: number[] };
const ASKS: AskSeed[] = [
  { who: JORDAN, when: at(6, "15:30"), question: "How should we write about the warranty?", given: [[VOICE, 6], [HALDEN, 4], [SPEC, 6]], cited: [1, 2],
    answer: "Say it plainly and early: every Marlow frame has a lifetime warranty for the first owner, and the frame is covered for as long as they own it [1]. Don't hedge it with \"terms apply\" in a headline. Dealers say the warranty closes a lot of sales, so put it front and centre [2]." },
  { who: JORDAN, when: at(4, "10:05"), question: "How much can we spend on video each month?", given: [[PLAN, 3], [PLAN, 1]], cited: [1],
    answer: "The plan doesn't set a figure for video alone. It says video is the expensive part, that members ask before running one, and that the team budget is $100 a month, with $25 each [1]." },
  { who: JORDAN, when: at(1, "16:20"), question: "When do dealers get the launch assets?", given: [[PLAN, 2], [PLAN, 1], [HALDEN, 3]], cited: [1, 2],
    answer: "Dealers get the hero image and the voiceover a week before the public launch, so the shop floor says the same thing as the site [1]. Each kit also has copy, an 8 second clip and a music bed [2]." },
  { who: PRIYA, when: at(3, "14:00"), question: "What do riders say about Trail 2 sizing?", given: [[HALDEN, 2], [SPEC, 2], [VOICE, 5]], cited: [1, 2],
    answer: "Riders between a medium and a large are told to take the medium, because the Trail 2 rides long; two of three test riders who tried both picked the smaller frame [1]. The spec sheet says the same: between two sizes, take the smaller one [2]." },
  { who: SAM, when: at(5, "14:15"), question: "What tyre width fits the Trail 2?", given: [[SPEC, 3], [PLAN, 4], [SPEC, 1]], cited: [1, 2],
    answer: "The Trail 2 takes tyres up to 2.4 in on 29 in wheels [1]. The launch plan lists that clearance as one of the three messages that matter [2]." },
  { who: SAM, when: at(1, "11:40"), question: "Which bolts are for the rack on the City 3?", given: [[CITY, 3], [OAK, 2]], cited: [1, 2],
    answer: "Knowledge doesn't say which bolts take the rack. The rack and mudguard mounts sit close together on the rear dropout, and dealers explain which bolt is which every time [1][2]. A short video showing where the rack goes is on the autumn list [1]." },
  { who: ALEX, when: today(40), question: "Is the Trail 2 frame covered by a warranty?", given: [[VOICE, 6], [SPEC, 6]], cited: [1, 2],
    answer: "Yes. Every Marlow frame has a lifetime warranty for the first owner [1], covering the frame for as long as they keep the bike [2]." },
];
for (const a of ASKS) {
  const given = a.given.map(([title, seq]) => passageId(title, seq));
  run({ owner: a.who, kind: "ask", title: `Ask: ${a.question}`, when: a.when, private: true, steps: [
    { kind: "embedding", model: EMBED, input: { input: [a.question], task_type: "RETRIEVAL_QUERY", dimensions: 768 }, options: { input_tokens: 20, input_type: "text" }, outcome: "succeeded", took: 1, usage: { input_tokens: 12 }, output: { count: 1, dimensions: 768 } },
    { kind: "rerank", model: "semantic-ranker-default-005", input: { top_n: 6 }, depends_on: [1], optional: true, outcome: "skipped", reason: "unavailable", detail: "Rerank isn't available on this Xano AI gateway, so passages keep their similarity order." },
    { kind: "text", model: TEXT, input: { prompt: a.question, question: a.question, response_format: "json", kb_candidates: given, kb_passages: given, kb_ranking: "similarity" },
      options: { input_tokens: 3200, output_tokens: 2000 }, depends_on: [1], outcome: "succeeded", took: 4,
      usage: { input_tokens: 2900, output_tokens: 260 }, output: { text: a.answer, json: { answer: a.answer, cited: a.cited }, finish_reason: "stop" } },
  ] });
}

// ── The sample run: a clip from the coast road still, already made, that the minute sweep finishes with no model call ──
const clip = keepFile("coast-road-dusk.mp4", {}, { duration: 4 });
const SAMPLE_RUN = run({ owner: JORDAN, kind: "recipe", recipe: "Teaser clip from a photo", title: "Teaser clip from a photo: coast road at dusk", when: NOW - 70 * SECOND, sample: true, status: "running",
  inputs: [{ name: "photo", label: "Photo to start from", type: "image", value: "coast-road-dusk-still.jpg" }, { name: "motion", label: "What moves", type: "text", value: "The cyclist pedals along the coast road, camera tracking alongside." }], steps: [
    { kind: "video", model: VIDEO, label: "Clip", input: { prompt: "A cyclist pedalling a sage-green mountain bicycle along a coast road at dusk, legs turning the pedals, camera tracking alongside, natural light.", use_brand: true,
      sample_output: { file: clip, duration: 4 }, from_asset: SEED_ASSETS.findIndex((a) => a.title === "Coast road at dusk") + 1, sources: [{ name: "coast-road-dusk-still.jpg", size: bytesOf("coast-road-dusk-still.jpg").length, mime: "image/jpeg" }] },
      options: { seconds: 4, resolution: "720p", audio: false, aspect_ratio: "16:9" }, outcome: "working", brand: true },
  ] });
Object.assign(SEED_MEDIA[clip.blob_id - 1], { run_id: SAMPLE_RUN, step_id: SEED_STEPS.length, attempt: 1 });
export { SAMPLE_RUN };

// ── The ledger and each month's counters, from the charges above ──
type MonthRow = { scope: "team" | "person"; subject_id: number; month: string; budget: number; reserved: number; spent: number; headroom: number };
export const SEED_MONTHS: MonthRow[] = [];
const monthRow = (scope: "team" | "person", subject: number, month: string) => {
  let i = SEED_MONTHS.findIndex((m) => m.scope === scope && m.subject_id === subject && m.month === month);
  if (i < 0) {
    const budget = scope === "team" ? DEFAULT_TEAM_BUDGET : DEFAULT_PERSON_BUDGET;
    SEED_MONTHS.push({ scope, subject_id: subject, month, budget, reserved: 0, spent: 0, headroom: budget });
    i = SEED_MONTHS.length - 1;
  }
  return i + 1;
};
// Every person has this month's row, as Usage lists them, even before they spend.
monthRow("team", 0, monthOf(NOW));
for (let p = 1; p <= DEMO_PEOPLE.length; p++) monthRow("person", p, monthOf(NOW));
export const SEED_LEDGER = CHARGES.sort((a, b) => a.when - b.when).map((ch) => {
  const month = monthOf(ch.when);
  const team = monthRow("team", 0, month), person = monthRow("person", ch.owner, month);
  if (ch.state === "settled") for (const id of [team, person]) {
    const row = SEED_MONTHS[id - 1];
    row.spent += ch.amount;
    row.headroom = row.budget - row.reserved - row.spent;
  }
  return {
    step_id: ch.step_id, attempt: 1, run_id: ch.run_id, owner_id: ch.owner, team_month_id: team, person_month_id: person, state: ch.state, held: 0,
    estimate: ch.estimate, amount: ch.amount, kind: ch.kind, model: ch.model, via: ch.via, connection_id: ch.key, reason: ch.reason, moved_at: ch.when + 30 * SECOND, late: null, created_at: ch.when,
  };
});

// ── Approvals: two runs wait for Jordan; one went through and one was declined ──
export const SEED_APPROVALS = ASKED.map((a) => {
  const r = SEED_RUNS[a.run - 1];
  const cost = `$${(r.estimate / MICRO).toFixed(2)}`;
  const decided = a.status !== "pending";
  return {
    user_id: a.owner, requester_name: nameOf(a.owner), source: "assistant" as const, agent_label: APP.name, connection_id: 0, action: "costly_run", title: `Run ${r.title}, estimated at ${cost}`,
    preview: "Video runs by members wait for an admin. Nothing is charged until it's approved.", link: `/runs/${a.run}`, payload: { run_id: a.run },
    approve_label: "Approve the run", editable_field: "", approver_roles: ",admin,", status: a.status, decided_by: decided ? JORDAN : 0,
    decided_at: decided ? a.when + 25 * MINUTE : null, expires_at: decided ? a.when + 7 * DAY : NOW + 7 * DAY, created_at: a.when,
  };
});

// ── The brand kit, with two reference images ──
export const SEED_BRAND = [{
  voice: "Plain, warm and a little dry. Short sentences. We talk about riding, not specs, and give the spec once, exactly. British spelling.",
  avoid_words: ["game-changer", "unleash", "epic", "best-in-class", "revolutionary", "next-level"],
  visual_rules: "Natural light, real places, no lens flare. Bikes are shown ridden or leaning, never floating. Muted greens, oak and slate.",
  default_voice: "Kore", voice_style: "calm, friendly, medium pace", music_style: "Warm indie, around 100 bpm, no vocals",
  colours: [{ name: "Sage", hex: "#5B7F62" }, { name: "Oat", hex: "#E6DCC8" }, { name: "Slate", hex: "#2E3138" }],
  updated_by: JORDAN, updated_at: at(10, "09:05"), created_at: at(10, "09:05"),
}];
export const SEED_BRAND_IMAGES = [["brand-ref-workshop.jpg", "Workshop, window light.jpg"], ["brand-ref-stone-wall.jpg", "Leaning on a stone wall.jpg"]].map(([file, name]) => {
  const bytes = bytesOf(file);
  return { name, mime: "image/jpeg", size: bytes.length, data: bytes.toString("base64"), added_by: JORDAN, created_at: at(10, "09:08") };
});

// ── Easel's own turns: provider-billed, shown on Usage apart from the budget ──
const turn = (user: number, when: number, inTokens: number, outTokens: number, tools: string[]) => ({
  user_id: user, conversation_id: 0, provider: "anthropic", model: "claude-opus-5-5", status: "done", input_tokens: inTokens, output_tokens: outTokens,
  usage: { input_tokens: inTokens, output_tokens: outTokens }, tools, finished_at: when + 9 * SECOND, created_at: when,
});
export const SEED_EASEL_TURNS = [
  turn(SAM, at(3, "10:20"), 5840, 412, ["search_library", "read_library_item"]),
  turn(PRIYA, at(2, "11:30"), 6120, 380, ["ask_knowledge_base"]),
  turn(JORDAN, at(1, "16:08"), 6410, 520, ["search_library", "make_output"]),
  turn(JORDAN, at(1, "16:12"), 7030, 190, ["check_on_run"]),
];

// ── Notifications and the activity feed ──
const assetNamed = (title: string) => SEED_ASSETS.findIndex((a) => a.title === title) + 1;
export const SEED_NOTIFICATIONS = [
  ...DEMO_PEOPLE.map((_, i) => ({ user_id: i + 1, kind: "welcome", title: `Welcome to ${APP.name}`, body: "Home shows what's running, what was made and the month's spend. Press ⌘K to jump anywhere.", link: "/", actor_id: 0, read_at: null, created_at: at(10, "09:00") })),
  ...SEED_APPROVALS.flatMap((a, i) => (a.status === "pending" ? [{ user_id: JORDAN, kind: "approval", title: a.title, body: a.preview, link: "/approvals", actor_id: a.user_id, read_at: null, created_at: ASKED[i].when }] : [])),
  { user_id: SAM, kind: "approval", title: `Jordan Lee approved ${SEED_RUNS[ASKED[0].run - 1].title}`, body: "", link: `/runs/${ASKED[0].run}`, actor_id: JORDAN, read_at: at(8, "11:00"), created_at: ASKED[0].when + 25 * MINUTE },
  { user_id: SAM, kind: "run", title: "Product launch kit: Trail 2 finished with one step short", body: "The 8 s video ran past its time limit. The copy, hero image, voiceover and music are in the Library.", link: `/runs/${ASKED[0].run}`, actor_id: 0, read_at: null, created_at: at(8, "10:20") },
  { user_id: PRIYA, kind: "approval", title: `${SEED_RUNS[ASKED[1].run - 1].title} wasn't approved`, body: "Declined by Jordan Lee. Nothing was charged.", link: `/runs/${ASKED[1].run}`, actor_id: JORDAN, read_at: null, created_at: ASKED[1].when + 25 * MINUTE },
];
const did = (actor: number, verb: string, entity: string, entityId: number, title: string, link: string, when: number, via = "") =>
  ({ actor_id: actor, actor_name: nameOf(actor), via, verb, entity, entity_id: entityId, title, link, private_to: 0, created_at: when });
const runNamed = (title: string) => SEED_RUNS.findIndex((r) => r.title === title) + 1;
export const SEED_ACTIVITY = [
  did(JORDAN, "updated", "brand", 1, "filled in the brand kit", "/brand", at(10, "09:05")),
  did(SAM, "published", "recipe", recipeId(LAUNCH_KIT), `published ${LAUNCH_KIT}`, `/recipes/${slugOf(LAUNCH_KIT)}`, at(10, "10:15")),
  did(JORDAN, "published", "recipe", recipeId(FREE_PLAN_RECIPE), `published ${FREE_PLAN_RECIPE}`, `/recipes/${slugOf(FREE_PLAN_RECIPE)}`, at(9, "10:15")),
  did(PRIYA, "added", "kb_source", 4, "added Customer call: Halden Cycles to Knowledge", "/knowledge/sources", at(7, "16:20")),
  did(JORDAN, "approved", "asset", assetNamed("Trail 2 hero, forest singletrack"), "approved Trail 2 hero, forest singletrack", `/library/${assetNamed("Trail 2 hero, forest singletrack")}`, at(8, "11:05")),
  did(JORDAN, "approved", "asset", assetNamed("City 3 commuter, morning street"), "approved City 3 commuter, morning street", `/library/${assetNamed("City 3 commuter, morning street")}`, at(6, "11:00")),
  did(PRIYA, "added", "kb_source", 5, "added Dealer call: Oak & Spoke on the City 3 to Knowledge", "/knowledge/sources", at(3, "11:10")),
  did(PRIYA, "approved", "asset", assetNamed("City 3 dealer briefing"), "approved City 3 dealer briefing", `/library/${assetNamed("City 3 dealer briefing")}`, at(1, "17:05")),
  did(JORDAN, "made", "ai_run", runNamed("Three captions for the approved City 3 photo"), "wrote three captions for the approved City 3 photo",
    `/runs/${runNamed("Three captions for the approved City 3 photo")}`, at(1, "16:10"), "Easel"),
  did(SAM, "made", "asset", assetNamed("Trail 2 newsletter blurb"), "drafted Trail 2 newsletter blurb", `/library/${assetNamed("Trail 2 newsletter blurb")}`, today(25), "Claude Code"),
  did(SAM, "asked", "ai_run", ASKED[2].run, "asked for approval to run Product launch kit: City 3", `/runs/${ASKED[2].run}`, today(95)),
].sort((a, b) => a.created_at - b.created_at);

/** What Home's "Spent this month" reads: the team's counter for the month the deploy is in. */
export const homeSpend = () => SEED_MONTHS.find((m) => m.scope === "team" && m.month === monthOf(NOW))?.spent ?? 0;

/**
 * When each person joined: Jordan set the workspace up six weeks ago, Sam a few days later, Priya just before the launch work
 * started and Alex, the freelancer, once there was work to show. Each is before the first thing they made or added.
 */
export const SEED_JOINED: number[] = [at(30, "09:10"), at(27, "10:15"), at(13, "11:30"), at(9, "14:20")];

/** The role changes Jordan made (Team's "Recent changes"): Sam and Priya started as guests and became members to run things; Alex came in as a member and now sees approved work only. */
export const SEED_ROLE_CHANGES = [
  { user_id: SAM, changed_by: JORDAN, from_role: "guest", to_role: "member", created_at: at(27, "10:40") },
  { user_id: PRIYA, changed_by: JORDAN, from_role: "guest", to_role: "member", created_at: at(13, "11:50") },
  { user_id: ALEX, changed_by: JORDAN, from_role: "member", to_role: "guest", created_at: at(9, "14:35") },
];
