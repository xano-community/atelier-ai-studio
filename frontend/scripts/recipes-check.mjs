#!/usr/bin/env node
// Recipes, for real, against a deployed backend with Xano AI on.
//   1. An admin saves a three-step recipe: copy as JSON, an image, and a voiceover that reads the copy's script. A step
//      naming a later step can't be saved. A member runs it from the app: it answers at once and finishes in the
//      background, every step succeeds in order, and the voiceover said exactly the script step 1 wrote. The same click
//      sent again is the same run.
//   2. A run whose first step fails (a JSON reply with no room to answer) ends partial: the step that needs it is skipped
//      and says why, the step that doesn't still runs, and Retry failed steps re-queues only those two.
//   3. The recipe API, with the member's own key: a run answers with its id, status, estimate and where to poll; the same
//      Idempotency-Key returns the same run, and with other inputs is 409. A revoked key is 401, a read-only key 403 and a
//      guest's key 403, and none of them starts a run. A guest can't see recipes at all.
//
//   node frontend/scripts/recipes-check.mjs --backend <url>
//
// It spends real credits, billed to whoever the deploy signed in to Xano AI as: about $0.05 (one small image, a short
// voiceover and a few short texts). It runs no video.
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
if (!backend) { console.error("usage: recipes-check.mjs --backend <url>"); process.exit(2); }

const errors = [];
const check = (good, what, detail = "") => {
  if (good) console.log(`  ✓ ${what}${detail ? `: ${detail}` : ""}`);
  else { errors.push(what); console.log(`  ✗ ${what}${detail ? `: ${detail}` : ""}`); }
};

const routes = JSON.parse(execFileSync("npx", ["xanosdk", "routes", "./xano/index.ts", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).routes;
const pathOf = (verb, name, params = {}, group) => {
  const route = routes.find((r) => r.verb === verb && r.ref.split("/").slice(1).join("/") === name && (!group || r.path.startsWith(`/api:${group}/`)));
  if (!route) throw new Error(`No route ${verb} ${name}`);
  return Object.entries(params).reduce((p, [k, v]) => p.replace(`{${k}}`, encodeURIComponent(String(v))), route.path);
};
const call = async (verb, path, token, body, headers = {}) => {
  const h = { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body) { h["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(backend + path, { method: verb, headers: h, body: payload, signal: AbortSignal.timeout(300_000) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const signIn = async (persona) => {
  const t = (await call("POST", pathOf("POST", "auth/demo"), null, { persona })).json?.authToken;
  if (!t) { console.error(`✗ couldn't sign in as ${persona}`); process.exit(1); }
  return t;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FINAL = ["done", "partial", "failed", "refused", "declined", "stopped"];
/** Poll a run until it ends: the background path, as the run page sees it. */
const until = async (token, id, path = (i) => pathOf("GET", "runs/{id}", { id: i })) => {
  for (let i = 0; i < 90; i++) {
    const r = await call("GET", path(id), token);
    const status = r.json?.run?.status ?? r.json?.status;
    if (FINAL.includes(status)) return r.json;
    await sleep(3000);
  }
  return null;
};
const clickId = () => crypto.randomUUID();
const dollars = (micro) => `$${(micro / 1_000_000).toFixed(4)}`;
let spent = 0;

const admin = await signIn("jordan");
const member = await signIn("sam");
const guest = await signIn("alex");
const tag = Date.now().toString(36);

console.log("\n1. A three-step recipe: text → image → speech");
const COPY_SCHEMA = { type: "object", properties: { headline: { type: "string" }, script: { type: "string" } }, required: ["headline", "script"] };
const kit = {
  name: `QA launch kit ${tag}`, description: "Copy, a picture and a voiceover", status: "published",
  inputs: [{ name: "product", label: "Product", type: "text", required: true }],
  steps: [
    { name: "Launch copy", kind: "text", model: "gemini-3.5-flash-lite", prompt: "Write a headline of at most six words and a voiceover script of at most twelve words for {{input.product}}.",
      file: "", settings: { response_format: "json", json_schema: COPY_SCHEMA, use_brand: false }, options: { output_tokens: 600 } },
    { name: "Picture", kind: "image", model: "gemini-3.1-flash-lite-image", prompt: "A simple product photo of {{input.product}} on a plain light background.",
      file: "", settings: { use_brand: false }, options: { size: "1K", aspect_ratio: "1:1" } },
    { name: "Voiceover", kind: "speech", model: "gemini-3.8-flash-lite-tts", prompt: "{{step.1.script}}", file: "", settings: { use_brand: false }, options: {} },
  ],
};
const backwards = await call("POST", pathOf("POST", "recipes"), admin, { ...kit, name: `QA backwards ${tag}`, steps: [{ ...kit.steps[0], prompt: "Shorten {{step.2}}" }, kit.steps[1]] });
check(backwards.status === 400 && /runs after this one/.test(backwards.json?.message ?? ""), "a step naming a later step can't be saved", `${backwards.status} ${backwards.json?.message ?? ""}`);
const made = await call("POST", pathOf("POST", "recipes"), admin, kit);
check(made.status === 200 && made.json?.slug, "the admin saved the recipe", made.json?.slug ?? `${made.status} ${made.json?.message}`);
const recipe = made.json;
const read = await call("GET", pathOf("GET", "recipes/{slug}", { slug: recipe.slug }), member);
check(JSON.stringify(read.json?.steps?.map((s) => s.depends_on)) === "[[],[],[1]]", "its dependencies come from the references", JSON.stringify(read.json?.steps?.map((s) => s.depends_on)));
check(read.json?.retired?.length === 0, "no step uses a retired model");

const click = clickId();
const startForm = (values) => { const f = new FormData(); f.append("client_id", click); f.append("values", JSON.stringify(values)); return f; };
const t0 = Date.now();
const started = await call("POST", pathOf("POST", "recipes/{id}/runs", { id: recipe.id }), member, startForm({ product: "the Trail 2 gravel bike" }));
check(started.status === 200 && started.json?.outcome === "created", "the member's run started", `${started.status} ${started.json?.run?.status ?? started.json?.message}`);
check(Date.now() - t0 < 15_000, "it answered at once, before the steps ran", `${((Date.now() - t0) / 1000).toFixed(1)} s`);
const runId = started.json?.run?.id;
const again = await call("POST", pathOf("POST", "recipes/{id}/runs", { id: recipe.id }), member, startForm({ product: "the Trail 2 gravel bike" }));
check(again.json?.outcome === "existing" && again.json?.run?.id === runId, "the same click again is the same run");
const ended = runId ? await until(member, runId) : null;
spent += ended?.run?.spent ?? 0;
check(ended?.run?.status === "done", "the run finished in the background", ended?.run?.status ?? "it never finished");
const steps = ended?.steps ?? [];
check(steps.length === 3 && steps.every((s) => s.status === "succeeded"), "every step succeeded", steps.map((s) => `${s.seq}:${s.status}`).join(" "));
check(steps.length === 3 && steps[0].finished_at <= steps[1].sent_at && steps[1].finished_at <= steps[2].sent_at, "the steps ran one at a time, in order");
const script = steps[0]?.output?.json?.script;
check(typeof script === "string" && script.length > 0 && steps[2]?.input?.text === script, "the voiceover said step 1's script", JSON.stringify(steps[2]?.input?.text));
check(steps[1]?.asset_id > 0 && steps[2]?.asset_id > 0, "the image and the voiceover became library items");
check((ended?.run?.spent ?? 0) > 0 && (ended?.run?.spent ?? 0) <= (ended?.run?.estimate ?? 0), "it cost no more than it was estimated at", `${dollars(ended?.run?.spent ?? 0)} of ${dollars(ended?.run?.estimate ?? 0)}`);

console.log("\n2. A step fails: the run ends partial, and a retry re-runs only what failed");
const partial = await call("POST", pathOf("POST", "recipes"), admin, {
  name: `QA partial ${tag}`, status: "published", inputs: [],
  steps: [
    // A JSON reply with room for almost nothing comes back cut off: the step fails, cheaply.
    { name: "Squeezed", kind: "text", model: "gemini-3.5-flash-lite", prompt: "List twenty colours as JSON with a sentence about each.", file: "", settings: { response_format: "json", use_brand: false }, options: { output_tokens: 8 } },
    { name: "Needs it", kind: "text", model: "gemini-3.5-flash-lite", prompt: "Pick one colour from: {{step.1}}", file: "", settings: { use_brand: false }, options: { output_tokens: 50 } },
    { name: "On its own", kind: "text", model: "gemini-3.5-flash-lite", prompt: "Say hello in three words.", file: "", settings: { use_brand: false }, options: { output_tokens: 50 } },
  ],
});
const pf = new FormData(); pf.append("client_id", clickId()); pf.append("values", "{}");
const pStart = await call("POST", pathOf("POST", "recipes/{id}/runs", { id: partial.json?.id }), member, pf);
const pEnded = pStart.json?.run?.id ? await until(member, pStart.json.run.id) : null;
spent += pEnded?.run?.spent ?? 0;
const ps = pEnded?.steps ?? [];
check(pEnded?.run?.status === "partial", "the run ended partial", pEnded?.run?.status);
check(["failed", "blocked"].includes(ps[0]?.status), "the squeezed step didn't succeed", `${ps[0]?.status}: ${ps[0]?.detail}`);
check(ps[1]?.status === "skipped" && /^Skipped, because step 1 /.test(ps[1]?.detail ?? ""), "the step that needs it was skipped and says why", ps[1]?.detail);
check(ps[2]?.status === "succeeded", "the step that doesn't need it still ran");
const retried = await call("POST", pathOf("POST", "runs/{id}/retry", { id: pStart.json?.run?.id }), member, { client_id: clickId() });
const rs = retried.json?.steps ?? [];
check(retried.status === 200 && rs[0]?.attempt === 2 && rs[1]?.attempt === 2 && rs[2]?.attempt === 1, "a retry re-queues only the failed step and the one skipped for it",
  rs.map((s) => `${s.seq}:${s.status}#${s.attempt}`).join(" "));
const rEnded = await until(member, pStart.json?.run?.id);
spent += Math.max(0, (rEnded?.run?.spent ?? 0) - (pEnded?.run?.spent ?? 0));
check(rEnded?.steps?.[2]?.attempt === 1 && rEnded?.steps?.[2]?.status === "succeeded", "what had worked was kept, not run again");

console.log("\n3. The recipe API, with the member's own key");
const tagline = await call("POST", pathOf("POST", "recipes"), admin, {
  name: `QA tagline ${tag}`, status: "published", inputs: [{ name: "product", label: "Product", type: "text", required: true }],
  steps: [{ name: "Tagline", kind: "text", model: "gemini-3.5-flash-lite", prompt: "A four-word tagline for {{input.product}}.", file: "", settings: { use_brand: false }, options: { output_tokens: 60 } }],
});
const slug = tagline.json?.slug;
const runsOf = async () => (await call("GET", pathOf("GET", "recipes/{id}/runs", { id: tagline.json?.id }), member)).json?.length ?? -1;
const key = await call("POST", pathOf("POST", "keys"), member, { name: `QA key ${tag}`, days: 30 });
check(key.status === 200 && typeof key.json?.token === "string", "the member made a named key, shown once", key.json?.key?.name);
const keys = await call("GET", pathOf("GET", "keys"), member);
check(keys.json?.some((k) => k.id === key.json?.key?.id) && !JSON.stringify(keys.json).includes(key.json?.token), "their keys list it, without the token");
const apiRun = (token, inputs, idem) => {
  const f = new FormData(); f.append("inputs", JSON.stringify(inputs));
  return call("POST", pathOf("POST", "recipes/{slug}/run", { slug }), token, f, idem ? { "Idempotency-Key": idem } : {});
};
const idem = `qa-${tag}`;
const a1 = await apiRun(key.json?.token, { product: "City 3 e-bike" }, idem);
check(a1.status === 200 && a1.json?.run > 0 && typeof a1.json?.estimate === "string" && a1.json?.poll?.includes("/recipes/runs/"), "a run by key answers with its id, status, estimate and where to poll",
  `${a1.status} ${JSON.stringify(a1.json)}`);
const a2 = await apiRun(key.json?.token, { product: "City 3 e-bike" }, idem);
check(a2.json?.run === a1.json?.run, "the same Idempotency-Key returns the same run");
const a3 = await apiRun(key.json?.token, { product: "Trail 2" }, idem);
check(a3.status === 409, "the same key with other inputs is 409", `${a3.status} ${a3.json?.message ?? ""}`);
const polled = a1.json?.run ? await until(key.json?.token, a1.json.run, (i) => pathOf("GET", "recipes/runs/{id}", { id: i })) : null;
spent += polled?.spent_micro ?? 0;
check(polled?.status === "done" && polled?.steps?.[0]?.text, "polling with the key shows the finished step", polled?.steps?.[0]?.text);
const details = await call("GET", pathOf("GET", "runs/{id}/details", { id: a1.json?.run }), member);
check(details.json?.connection_name === `QA key ${tag}`, "the run records the key's name", details.json?.connection_name);

const before = await runsOf();
const readOnly = await call("POST", pathOf("POST", "agent/connections", {}, "agent"), member, { name: `QA read ${tag}`, scope: "read", days: 1 });
const r1 = await apiRun(readOnly.json?.token, { product: "x" }, `${idem}-ro`);
check(r1.status === 403, "a read-only key is 403", `${r1.status} ${r1.json?.message ?? ""}`);
const guestKey = await call("POST", pathOf("POST", "agent/connections", {}, "agent"), guest, { name: `QA guest ${tag}`, scope: "read_write", days: 1 });
const r2 = await apiRun(guestKey.json?.token, { product: "x" }, `${idem}-guest`);
check(r2.status === 403, "a guest's key is refused", `${r2.status} ${r2.json?.message ?? ""}`);
await call("POST", pathOf("POST", "keys/{id}/revoke", { id: key.json?.key?.id }), member);
const r3 = await apiRun(key.json?.token, { product: "x" }, `${idem}-revoked`);
check(r3.status === 401, "a revoked key is 401", `${r3.status} ${r3.json?.message ?? ""}`);
check((await runsOf()) === before, "none of them started a run");
const draft = await call("POST", pathOf("POST", "recipes"), admin, { name: `QA draft ${tag}`, status: "draft", inputs: [], steps: [{ name: "Hi", kind: "text", model: "gemini-3.5-flash-lite", prompt: "Hi", file: "", settings: {}, options: { output_tokens: 20 } }] });
const mk2 = await call("POST", pathOf("POST", "keys"), member, { name: `QA key 2 ${tag}`, days: 1 });
const r4 = await call("POST", pathOf("POST", "recipes/{slug}/run", { slug: draft.json?.slug }), mk2.json?.token, { inputs: {} });
check(r4.status === 400 && /draft/i.test(r4.json?.message ?? ""), "a draft can't be run through the API", `${r4.status} ${r4.json?.message ?? ""}`);
await call("POST", pathOf("POST", "keys/{id}/revoke", { id: mk2.json?.key?.id }), member);
const g = await call("GET", pathOf("GET", "recipes"), guest);
check(g.status === 403, "a guest can't see recipes", `${g.status}`);

// Tidy up: the recipes this check made.
for (const id of [recipe?.id, partial.json?.id, tagline.json?.id, draft.json?.id].filter(Boolean)) await call("DELETE", pathOf("DELETE", "recipes/{id}", { id }), admin);

console.log(`\nSpent about ${dollars(spent)}.`);
if (errors.length) { console.log(`\n✗ ${errors.length} check(s) failed`); process.exit(1); }
console.log("\n✓ recipes-check passed");
