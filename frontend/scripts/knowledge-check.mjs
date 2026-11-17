#!/usr/bin/env node
// Knowledge, for real, against a deployed backend with Xano AI on. A member adds a one-page PDF and a two-speaker call
// recording through the upload route; each must become ready in the background, the PDF with page numbers and the
// recording with start times and speakers. Then Ask: a question about the call must be answered with a citation that
// points at the recording and a moment in it; one about nothing in the sources must say it couldn't find it and cite
// nothing; a repeat of the same click must return the same answer without asking again. Rerank has no model the gateway
// prices, so every answer must say it's ranked by similarity. A guest must be able to ask but not upload.
//
//   node frontend/scripts/knowledge-check.mjs --backend <url> --assets <dir> [--long]
//
// <dir> holds guide.pdf (one page), call.mp3 (a 65-second, two-speaker call) and, with --long, handbook.pdf (40 pages,
// read 5 pages a step). It spends real credits, billed to whoever the deploy signed in to Xano AI as: about $0.02, or
// about $0.25 with --long.
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
const assets = opt("assets");
const long = argv.includes("--long");
if (!backend || !assets) { console.error("usage: knowledge-check.mjs --backend <url> --assets <dir> [--long]"); process.exit(2); }
for (const name of ["guide.pdf", "call.mp3", ...(long ? ["handbook.pdf"] : [])]) {
  if (!existsSync(join(assets, name))) { console.error(`✗ ${join(assets, name)} is missing`); process.exit(2); }
}

const errors = [];
const check = (good, what, detail = "") => {
  if (good) console.log(`  ✓ ${what}${detail ? `: ${detail}` : ""}`);
  else { errors.push(what); console.log(`  ✗ ${what}${detail ? `: ${detail}` : ""}`); }
};

const routes = JSON.parse(execFileSync("npx", ["xanosdk", "routes", "./xano/index.ts", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).routes;
const pathOf = (verb, name, params = {}) => {
  const route = routes.find((r) => r.verb === verb && r.ref.split("/").slice(1).join("/") === name && (name !== "sources" || r.path.includes("knowledge")));
  if (!route) throw new Error(`No route ${verb} ${name}`);
  return Object.entries(params).reduce((p, [k, v]) => p.replace(`{${k}}`, encodeURIComponent(String(v))), route.path);
};
const call = async (verb, path, token, body) => {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(backend + path, { method: verb, headers, body: payload, signal: AbortSignal.timeout(300_000) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const signIn = async (persona) => {
  const t = (await call("POST", pathOf("POST", "auth/demo"), null, { persona })).json?.authToken;
  if (!t) { console.error(`✗ couldn't sign in as ${persona}`); process.exit(1); }
  return t;
};
const member = await signIn("priya");
const guest = await signIn("alex");
const tag = Date.now().toString(36);
const dollars = (micro) => `$${(micro / 1_000_000).toFixed(4)}`;
let spent = 0;

const upload = (token, name, type, key) => {
  const form = new FormData();
  form.append("client_id", `${tag}-${key}`);
  form.append("file", new File([readFileSync(join(assets, name))], name, { type }));
  return call("POST", pathOf("POST", "sources"), token, form);
};
/** Follow a source until it's ready or failed. */
const settle = async (id, minutes) => {
  const until = Date.now() + minutes * 60_000;
  for (;;) {
    const { json } = await call("GET", pathOf("GET", "sources/{id}", { id }), member);
    if (json?.source?.status !== "processing" || Date.now() > until) return json;
    await new Promise((r) => setTimeout(r, 3000));
  }
};
const runSpent = async (runId) => (await call("GET", pathOf("GET", "runs/{id}", { id: runId }), member)).json?.run?.spent ?? 0;

console.log("Who may add");
const refused = await upload(guest, "guide.pdf", "application/pdf", "guest");
check(refused.status === 403, "a guest can't add a source", `${refused.status} ${refused.json?.message ?? ""}`);

const add = async (label, name, type, minutes) => {
  console.log(label);
  const started = Date.now();
  const first = await upload(member, name, type, name);
  check(first.status === 200 && first.json?.status === "processing", "the upload starts processing", `${first.status} ${first.json?.message ?? first.json?.status ?? ""}`);
  if (first.status !== 200) return null;
  const again = await upload(member, name, type, name);
  check(again.json?.id === first.json.id, "the same upload sent twice adds one source", `${again.json?.id} vs ${first.json.id}`);
  const done = await settle(first.json.id, minutes);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  check(done?.source?.status === "ready", "it becomes ready", `${done?.source?.status} in ${seconds} s${done?.source?.detail ? `: ${done.source.detail}` : ""}`);
  const cost = await runSpent(first.json.run_id);
  spent += cost;
  console.log(`    ${done?.source?.passages ?? 0} passages, ${dollars(cost)}`);
  return done;
};

const pdf = await add("A one-page PDF", "guide.pdf", "application/pdf", 4);
if (pdf) check(pdf.passages.length > 0 && pdf.passages.every((p) => p.page >= 1), "its passages carry page numbers", pdf.passages.map((p) => p.page).join(", "));

const rec = await add("A two-speaker call", "call.mp3", "audio/mpeg", 5);
if (rec) {
  check(rec.source.kind === "recording" && rec.source.duration_s > 30, "it's a recording with a length", `${rec.source.duration_s} s`);
  check(rec.passages.length > 0 && rec.passages.every((p) => p.start_s >= 0), "its passages carry start times", rec.passages.map((p) => p.start_s).join(", "));
  check(rec.passages.some((p) => /speaker/i.test(p.speaker)), "and speakers", [...new Set(rec.passages.map((p) => p.speaker))].join(", "));
  const play = await call("GET", pathOf("GET", "sources/{id}/audio", { id: rec.source.id }), member);
  check(play.status === 200, "it has a playback link", play.json?.url ? "signed" : "this server can't sign private links (the local Engine); it works on Xano cloud");
}

if (long) {
  const handbook = await add("A 40-page PDF, five pages a step", "handbook.pdf", "application/pdf", 12);
  if (handbook) {
    check(handbook.source.pages === 40, "it reads all 40 pages", `${handbook.source.pages}`);
    const pages = new Set(handbook.passages.map((p) => p.page));
    check(pages.has(1) && pages.has(40), "passages run from page 1 to 40", `${pages.size} pages with passages`);
  }
}

const ask = async (token, question, key) => {
  const started = Date.now();
  const r = await call("POST", pathOf("POST", "ask"), token, { question, client_id: `${tag}-${key}` });
  return { ...r, seconds: ((Date.now() - started) / 1000).toFixed(1) };
};

console.log("Ask about the call");
const a = await ask(member, "What do customers between a medium and a large say about Trail 2 sizing?", "ask1");
check(a.status === 200 && a.json?.state === "answered", "it answers", `${a.status} ${a.json?.state} in ${a.seconds} s: ${a.json?.answer ?? a.json?.message}`);
const recCite = a.json?.citations?.find((c) => c.kind === "recording");
check(!!recCite && recCite.start_s >= 0, "it cites the call at a moment", recCite ? `${recCite.title} at ${recCite.start_s} s, ${recCite.speaker}` : "no recording cited");
check(a.json?.ranking === "similarity", "it says it's ranked by similarity", a.json?.ranking);
const markers = [...(a.json?.answer ?? "").matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
check(markers.length > 0, "the answer marks what it cites", markers.join(", "));
spent += a.json?.spent ?? 0;
console.log(`    ${dollars(a.json?.spent ?? 0)}`);

const again = await ask(member, "What do customers between a medium and a large say about Trail 2 sizing?", "ask1");
check(again.json?.run_id === a.json?.run_id && again.json?.answer === a.json?.answer, "the same click twice asks once", `run ${again.json?.run_id}`);

console.log("Ask about nothing in the sources");
const none = await ask(member, "What time does the Lisbon office cafeteria open on Sundays?", "ask2");
check(none.json?.state === "not_found" || (none.json?.state === "answered" && none.json?.citations?.length === 0), "it says it couldn't find it",
  `${none.json?.state}: ${none.json?.answer}`);
check((none.json?.citations ?? []).length === 0, "and cites nothing");
spent += none.json?.spent ?? 0;

console.log("A guest asks");
const g = await ask(guest, "Which colour is most popular for the Trail 2?", "ask3");
check(g.status === 200 && g.json?.state === "answered" && g.json?.citations?.length > 0, "a guest gets an answer with citations", `${g.json?.state}: ${g.json?.answer ?? g.json?.message}`);
spent += g.json?.spent ?? 0;

console.log(`\nEstimated spend for this check: ${dollars(spent)}`);
if (errors.length) { console.log(`✗ ${errors.length} check(s) failed: ${errors.join("; ")}`); process.exit(1); }
console.log("✓ Knowledge works end to end");
