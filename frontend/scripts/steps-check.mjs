#!/usr/bin/env node
// Every kind of model call, for real, against a deployed backend with Xano AI on: one Playground run of each, through
// the same route the app uses. Each must come back stored: text and transcripts as text, images, video and audio as
// private files, and each as a draft library item. Video and music run in the background, so they're followed until
// they end. Rerank has no model the gateway serves yet, so its run must come back refused as unavailable, with nothing
// charged. A repeated click must return the first run.
//
//   node frontend/scripts/steps-check.mjs --backend <url> [--persona jordan] [--skip video,music] [--only video] [--assets <dir>]
//
// It spends real credits (about $0.15, or $0.50 with video), billed to whoever the deploy signed in to Xano AI as. The
// person is an admin, so nothing waits for an approval. `--assets` holds hero.png (an image to edit) and call.mp3 (a
// recording); without them those two runs are skipped.
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
if (!backend) { console.error("usage: steps-check.mjs --backend <url> [--persona jordan] [--skip video,music] [--assets <dir>]"); process.exit(2); }
const persona = opt("persona", "jordan");
const KINDS = ["text", "image", "video", "music", "speech", "transcribe", "embedding", "rerank"];
const only = (opt("only", "") || "").split(",").filter(Boolean);
const skip = new Set([...(opt("skip", "") || "").split(",").filter(Boolean), ...(only.length ? KINDS.filter((k) => !only.includes(k)) : [])]);
const assets = opt("assets", "");

const errors = [];
const check = (good, what, detail = "") => {
  if (good) console.log(`  ✓ ${what}${detail ? `: ${detail}` : ""}`);
  else { errors.push(what); console.log(`  ✗ ${what}${detail ? `: ${detail}` : ""}`); }
};

const routes = JSON.parse(execFileSync("npx", ["xanosdk", "routes", "./xano/index.ts", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).routes;
const pathOf = (verb, name, params = {}) => {
  const route = routes.find((r) => r.verb === verb && r.ref.split("/").slice(1).join("/") === name);
  if (!route) throw new Error(`No route ${verb} ${name}`);
  return Object.entries(params).reduce((p, [k, v]) => p.replace(`{${k}}`, encodeURIComponent(String(v))), route.path);
};
const call = async (verb, path, token, body) => {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(backend + path, { method: verb, headers, body: payload, signal: AbortSignal.timeout(900_000) });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const token = (await call("POST", pathOf("POST", "auth/demo"), null, { persona })).json?.authToken;
if (!token) { console.error(`✗ couldn't sign in as ${persona}`); process.exit(1); }

const tag = Date.now().toString(36);
const FINAL = ["done", "partial", "failed", "refused", "declined", "stopped"];
const dollars = (micro) => `$${(micro / 1_000_000).toFixed(4)}`;

/** Start one run (a form when there's a file), then follow it until it ends. */
let runs = 0;
const run = async ({ kind, model, input = {}, options = {}, file }) => {
  const clientId = `${tag}-${++runs}-${kind}`;
  let body = { client_id: clientId, kind, model, input, options, private: true };
  if (file) {
    const form = new FormData();
    for (const [k, v] of Object.entries(body)) form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    form.append("file", new File([readFileSync(file.path)], file.name, { type: file.type }));
    body = form;
  }
  const started = Date.now();
  const first = await call("POST", pathOf("POST", "runs"), token, body);
  if (first.status !== 200) return { first, view: null, seconds: (Date.now() - started) / 1000, clientId };
  let view = first.json;
  while (!FINAL.includes(view.run.status) && Date.now() - started < 12 * 60_000) {
    await new Promise((r) => setTimeout(r, 3000));
    view = (await call("GET", pathOf("GET", "runs/{id}", { id: view.run.id }), token)).json;
  }
  return { first, view, seconds: (Date.now() - started) / 1000, clientId, body };
};

const KEPT = { text: "text", image: "file", video: "file", music: "file", speech: "file", transcribe: "text" };
const results = [];
const expectStored = async (label, spec, extra = () => {}) => {
  if (skip.has(spec.kind)) { console.log(`- ${label}: skipped`); return null; }
  console.log(`- ${label} (${spec.model})`);
  const r = await run(spec);
  if (!r.view) { check(false, `${label} started`, `${r.first.status} ${JSON.stringify(r.first.json)}`); return r; }
  const step = r.view.steps[0];
  results.push({ label, status: r.view.run.status, seconds: r.seconds, charged: r.view.run.spent, estimate: r.view.run.estimate });
  check(r.view.run.status === "done", `${label} ran to done`, `${r.view.run.status} in ${r.seconds.toFixed(1)} s${step?.detail ? ` (${step.detail})` : ""}`);
  check(step?.status === "succeeded", `${label}'s step succeeded`, step ? `${step.status}${step.reason ? ` / ${step.reason}` : ""}` : "no step");
  if (KEPT[spec.kind] === "file") {
    check(step?.output?.file?.access === "private" && !!step?.output?.file?.path, `${label} is stored as a private file`, step?.output?.file?.path ?? "none");
    if (step?.url) check(step.url.startsWith("http"), `${label} has a signed link`, step.url.split("?")[0]);
    else console.log(`  ! no signed link (the local Engine can't sign private files)`);
  }
  if (KEPT[spec.kind] === "text") check(typeof step?.output?.text === "string" && step.output.text.length > 0, `${label} kept its text`, JSON.stringify(step?.output?.text ?? "").slice(0, 80));
  if (KEPT[spec.kind]) check(step?.asset_id > 0, `${label} became a draft library item`, `asset ${step?.asset_id}`);
  check(step?.charged > 0, `${label} was charged`, `${dollars(step?.charged ?? 0)} of ${dollars(step?.estimate ?? 0)} reserved`);
  await extra(r, step);
  return r;
};

const prompt = "Write one sentence about a gravel bike.";
await expectStored("text", { kind: "text", model: "gemini-3.8-flash", input: { prompt, use_brand: false }, options: { output_tokens: 1000 } }, async (r) => {
  // A repeated click is the same run, not a second one.
  const again = await call("POST", pathOf("POST", "runs"), token, r.body);
  check(again.json?.outcome === "existing" && again.json?.run?.id === r.view.run.id, "the same click again returns the first run", `${again.json?.outcome} #${again.json?.run?.id}`);
});
await expectStored("text as JSON", { kind: "text", model: "gemini-3.8-flash", options: { output_tokens: 3000 }, input: {
  prompt: "Give a product title and two bullets for the Trail 2 gravel bike.", response_format: "json", use_brand: false,
  json_schema: { type: "object", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } } }, required: ["title", "bullets"] },
} }, async (_r, step) => check(typeof step?.output?.json?.title === "string", "the JSON reply came back parsed", step?.output?.json?.title ?? "none"));
await expectStored("text on Claude", { kind: "text", model: "claude-sonnet-5-5", input: { prompt, use_brand: false }, options: { output_tokens: 300 } });

const hero = assets && join(assets, "hero.png");
if (skip.has("image")) console.log("- image edit: skipped");
else if (hero && existsSync(hero)) {
  await expectStored("image edit", { kind: "image", model: "gemini-3.1-flash-image", input: { prompt: "Make the bike sage green. Keep everything else.", use_brand: false }, options: { size: "1K" },
    file: { path: hero, name: "hero.png", type: "image/png" } },
  async (_r, step) => {
    check(step?.output?.edit === true, "it was an edit", String(step?.output?.edit));
    check(step?.output?.edited_from?.[0]?.name === "hero.png", "the edit records its source", JSON.stringify(step?.output?.edited_from ?? []));
  });
} else console.log("- image edit: skipped (no --assets with hero.png)");

await expectStored("speech", { kind: "speech", model: "gemini-3.8-flash-tts", input: { text: "Meet the Trail 2: built for every road you haven't ridden yet.", use_brand: false } });

const recording = assets && join(assets, "call.mp3");
if (skip.has("transcribe")) console.log("- transcribe: skipped");
else if (recording && existsSync(recording)) {
  await expectStored("transcribe", { kind: "transcribe", model: "gemini-3.5-transcribe", file: { path: recording, name: "call.mp3", type: "audio/mpeg" } });
} else console.log("- transcribe: skipped (no --assets with call.mp3)");

await expectStored("embedding", { kind: "embedding", model: "gemini-embedding-2", input: { input: ["The Trail 2 frame is aluminium.", "Medium fits riders 170 to 178 cm."], task_type: "RETRIEVAL_DOCUMENT", dimensions: 768 }, options: { input_tokens: 40 } },
  async (_r, step) => check(step?.output?.count === 2 && step?.output?.dimensions === 768, "two vectors of 768", `${step?.output?.count} × ${step?.output?.dimensions}`));

await expectStored("music", { kind: "music", model: "lyria-002", input: { prompt: "A calm acoustic theme for a product film", use_brand: false } },
  async (r) => check(r.first.json?.run?.status !== "done", "music answered at once and finished in the background", `first answer: ${r.first.json?.run?.status}`));
await expectStored("video", { kind: "video", model: "veo-3.1-fast-generate-001", input: { prompt: "A slow pan across a gravel bike leaning on a stone wall", use_brand: false }, options: { seconds: 4, resolution: "720p", audio: false } },
  async (r, step) => {
    check(r.first.json?.run?.status !== "done", "video answered at once and finished in the background", `first answer: ${r.first.json?.run?.status}`);
    check(step?.output?.duration > 0, "the clip reports its length", `${step?.output?.duration} s`);
  });

// Rerank: the catalog lists no reranker, the price table has none and the gateway can't serve one, so it's refused before
// anything is reserved: by the catalog check (400) before a run row exists, or as a run refused for its price.
if (!skip.has("rerank")) {
  console.log("- rerank (semantic-ranker-default-005)");
  const r = await run({ kind: "rerank", model: "semantic-ranker-default-005", input: { query: "Which size fits 175 cm?", documents: ["Large fits 176 to 186 cm.", "Medium fits 170 to 178 cm."], top_n: 1 } });
  const step = r.view?.steps?.[0];
  const notOffered = r.first.status === 400 && /isn't a model Xano AI offers/.test(r.first.json?.message ?? "");
  const unavailable = notOffered || (r.view?.run?.status === "refused" && r.view?.run?.reason === "no_price") || step?.reason === "unavailable";
  check(unavailable, "rerank comes back unavailable, not as a crash", notOffered ? r.first.json.message : `${r.view?.run?.status} / ${r.view?.run?.reason || step?.reason}: ${r.view?.run?.detail || step?.detail}`);
  check((r.view?.run?.spent ?? 0) === 0, "and nothing was charged", dollars(r.view?.run?.spent ?? 0));
}

console.log("\nkind              status   seconds   charged   reserved");
for (const r of results) console.log(`${r.label.padEnd(17)} ${r.status.padEnd(8)} ${r.seconds.toFixed(1).padStart(7)}   ${dollars(r.charged)}   ${dollars(r.estimate)}`);
console.log(`total charged: ${dollars(results.reduce((t, r) => t + (r.charged ?? 0), 0))}`);
console.log(errors.length ? `✗ steps-check: ${errors.length} failed` : "✓ steps-check: all passed");
process.exit(errors.length ? 1 : 0);
