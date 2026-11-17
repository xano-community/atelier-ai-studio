#!/usr/bin/env node
// The first minute, against a demo deploy and the app in a browser: what a first-time deployer sees before touching anything,
// and, where Xano AI is on, the first run they're asked to try.
//
// Always: Home shows the seeded Marlow world (runs, library, Knowledge, the month's spend), and its spend is the same number
// Usage adds up from the ledger. Every seeded picture and recording shows on this server, including one that can't sign
// private links (the Xano Engine), because seeded files are kept in a table. The sample run is there, and two runs wait for
// Jordan. The first-run checklist names the Playground, the launch kit, Knowledge and Usage.
//
// Without a Xano AI sign-in (the deploy reported AI off): every screen loads, Generate is off with "Generate is off until AI
// is on", Jordan reads "AI isn't switched on here yet" and the command that fixes it, and Sam reads that an admin can switch
// it on, with no command. Nothing is spent.
//
// With one (AI on): the free-plan recipe, "Product page copy and photo", runs end to end and its photo shows, and the seeded
// question "What do riders say about Trail 2 sizing?" is answered from the seeded passages, with citations. About $0.08.
//
//   node frontend/scripts/first-run-check.mjs --backend <url> --app <url> [--wait-sample] [--shots <dir>]
//
// --wait-sample waits up to four minutes for the minute sweep to end the sample run with its clip and no charge.
// --production --setup-token <token> checks a deploy of xano/production.ts instead: empty, set up once with the token, at the
// production budgets.
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
// --frontend, --out and --no-seed also work, as other names for --app, --shots and --production.
const app = (opt("app") ?? opt("frontend"))?.replace(/\/$/, "");
const shots = opt("shots") ?? opt("out");
const waitSample = argv.includes("--wait-sample");
if (!backend || !app) { console.error("usage: first-run-check.mjs --backend <url> --app <url> [--wait-sample] [--shots <dir>]"); process.exit(2); }
if (shots) mkdirSync(shots, { recursive: true });

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
  const form = body instanceof FormData;
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && !form ? { "content-type": "application/json" } : {}) };
  const res = await fetch(backend + path, { method: verb, headers, body: body ? (form ? body : JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(300_000) });
  const bytes = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(bytes.toString("utf8")); } catch { json = null; }
  return { status: res.status, json, bytes, type: res.headers.get("content-type") ?? "" };
};
const signIn = async (persona) => {
  const t = (await call("POST", pathOf("POST", "auth/demo"), null, { persona })).json?.authToken;
  if (!t) { console.error(`✗ couldn't sign in as ${persona}: is this the demo deploy?`); process.exit(1); }
  return t;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --production: the production entry (xano/production.ts) deployed with SETUP_TOKEN. Nothing of the demo is there, the sign-in
// screen offers setup, the token decides who becomes the first admin, and every screen starts empty with its next step.
const productionToken = opt("setup-token");
if (argv.includes("--production") || argv.includes("--no-seed")) {
  if (!productionToken) { console.error("usage: first-run-check.mjs --backend <url> --app <url> --production --setup-token <token>"); process.exit(2); }
  console.log("A production deploy, before setup");
  const status = (await call("GET", pathOf("GET", "auth/status"))).json;
  check(status?.needs_setup === true, "it says it needs its first admin");
  check(((await call("GET", pathOf("GET", "auth/demo/personas"))).json ?? []).length === 0, "no demo person is offered");
  check((await call("POST", pathOf("POST", "auth/demo"), null, { persona: "jordan" })).status >= 400, "demo sign-in finds nobody");
  const setup = (body) => call("POST", pathOf("POST", "auth/setup"), null, { workspace_name: "Marlow", name: "Jo Admin", email: "jo@marlow.example", password: "Studio-first-1", ...body });
  const wrong = await setup({ setup_token: "not-the-token" });
  check(wrong.status === 403 && /setup token isn't right/.test(wrong.json?.message ?? ""), "a wrong token is refused", `${wrong.status} ${wrong.json?.message ?? ""}`);
  const made = await setup({ setup_token: productionToken });
  const admin = made.json?.authToken;
  check(made.status === 200 && !!admin, "the right token makes the first admin and signs them in", String(made.status));
  check((await call("GET", pathOf("GET", "auth/status"))).json?.needs_setup === false, "after that, it's set up");
  const again = await setup({ setup_token: productionToken, email: "second@marlow.example" });
  check(again.status === 403 && /already set up/.test(again.json?.message ?? ""), "a second setup is refused", `${again.status}`);
  console.log("Empty, with the production budgets");
  const home = (await call("GET", pathOf("GET", "home"), admin)).json;
  check(home?.role === "admin", "the new person is an admin");
  check(home?.assets === 0 && home?.sources === 0 && home?.recipe_count === 0 && home?.runs_week === 0, "nothing of the demo world is there", `${home?.assets} items, ${home?.sources} sources, ${home?.recipe_count} recipes`);
  check(home?.team?.budget === 100_000_000 && home?.mine?.budget === 25_000_000, "the team budget is $100 and each person's $25", `${home?.team?.budget} / ${home?.mine?.budget}`);
  const limits = (await call("GET", pathOf("GET", "budgets"), admin)).json;
  check(limits?.approval_line === 500_000, "runs above $0.50 ask an admin first", String(limits?.approval_line));
  check(((await call("GET", pathOf("GET", "prices"), admin)).json ?? []).length > 0, "the price table is there to estimate with");
  console.log(errors.length ? `\n✗ ${errors.length} check(s) failed` : "\n✓ production check passed");
  process.exit(errors.length ? 1 : 0);
}

const jordan = await signIn("jordan");
const sam = await signIn("sam");

const ai = (await call("GET", pathOf("GET", "ai-state"), jordan)).json;
const keyed = ai?.ai_status === "on";
console.log(`Xano AI here: ${ai?.ai_status ?? "unknown"} (${keyed ? "with a key: the first run goes end to end" : "without one: nothing is spent"})`);

console.log("The seeded world");
const home = (await call("GET", pathOf("GET", "home"), jordan)).json;
check(home && home.runs_week + home.runs_last_week >= 20, "Home shows two weeks of runs", `${home?.runs_week} this week, ${home?.runs_last_week} the week before`);
check(home?.assets >= 20 && home?.approved >= 5, "the library has items, some approved", `${home?.assets} items, ${home?.approved} approved`);
check(home?.sources >= 6 && home?.recordings >= 2, "Knowledge has sources and recordings", `${home?.sources} sources, ${home?.recordings} recordings`);
check(home?.waiting?.filter((r) => r.status === "waiting_approval").length >= 2, "two runs wait for Jordan's approval");
const usage = (await call("GET", pathOf("GET", "usage"), jordan)).json;
check(home?.team?.spent > 0 && usage?.total === home.team.spent, "Home's spend is the month's ledger total on Usage", `Home ${home?.team?.spent}, Usage ${usage?.total} micro-dollars`);
check(Array.isArray(usage?.easel) && usage.easel.length > 0, "Usage lists Easel's own turns apart from the budgets", `${usage?.easel?.length ?? 0} rows`);

console.log("Seeded files show on this server");
const images = (await call("GET", pathOf("GET", "assets") + "?kind=image&per_page=12", jordan)).json?.items ?? [];
check(images.length >= 4, "the library has pictures", String(images.length));
let shown = 0;
for (const tile of images) {
  const got = tile.thumb_blob ? await call("GET", pathOf("GET", "media/{id}", { id: tile.thumb_blob }), jordan) : tile.thumb ? await fetch(tile.thumb).then(async (r) => ({ status: r.status, type: r.headers.get("content-type") ?? "", bytes: Buffer.from(await r.arrayBuffer()) })) : null;
  if (got?.status === 200 && got.type.startsWith("image/") && got.bytes.length > 1000) shown++;
}
check(shown === images.length, "every picture's bytes arrive, as the tile asks for them", `${shown} of ${images.length}`);
const sources = (await call("GET", pathOf("GET", "sources"), jordan)).json?.items ?? [];
const recording = sources.find((s) => s.kind === "recording" && s.has_audio);
const play = recording ? (await call("GET", pathOf("GET", "sources/{id}/audio", { id: recording.id }), jordan)).json : null;
const audio = play?.blob_id ? await call("GET", pathOf("GET", "media/{id}", { id: play.blob_id }), jordan) : play?.url ? await fetch(play.url).then(async (r) => ({ status: r.status, type: r.headers.get("content-type") ?? "", bytes: Buffer.from(await r.arrayBuffer()) })) : null;
check(audio?.status === 200 && audio.type.startsWith("audio/"), "a recording's citation plays", recording?.title ?? "no recording");
const guest = await signIn("alex");
const draft = (await call("GET", pathOf("GET", "assets") + "?kind=image&per_page=60", jordan)).json?.items?.find((t) => t.status === "draft" && t.thumb_blob);
if (draft) check((await call("GET", pathOf("GET", "media/{id}", { id: draft.thumb_blob }), guest)).status === 404, "a guest can't fetch a draft's bytes");

console.log("The sample run");
const runsOf = async () => (await call("GET", pathOf("GET", "home"), jordan)).json;
let sample = (home?.running ?? []).find((r) => r.title.startsWith("Teaser clip"));
const library = async () => (await call("GET", pathOf("GET", "assets") + "?kind=video&per_page=10", jordan)).json?.items ?? [];
if (sample) {
  check(true, "the sample run is running on Home", sample.title);
  if (waitSample) {
    const deadline = Date.now() + 4 * 60_000;
    while (Date.now() < deadline && (await runsOf())?.running?.some((r) => r.id === sample.id)) await sleep(10_000);
    const ended = (await call("GET", pathOf("GET", "runs/{id}", { id: sample.id }), jordan)).json;
    check(ended?.run?.status === "done" && ended.run.spent === 0, "the sweep ended it with its clip and charged nothing", `${ended?.run?.status}, spent ${ended?.run?.spent}`);
    check((await library()).some((t) => t.title.startsWith("Teaser clip")), "its clip is in the library");
  }
} else {
  check((await library()).some((t) => t.title.startsWith("Teaser clip")), "the sample run already ended, and its clip is in the library");
}

let spent = 0;
if (keyed) {
  console.log("The first run");
  const recipes = (await call("GET", pathOf("GET", "recipes"), sam)).json?.items ?? [];
  const recipe = recipes.find((r) => r.slug === "product-page-copy-and-photo");
  check(!!recipe, "the free-plan recipe is there", recipe?.name ?? "missing");
  if (recipe) {
    const form = new FormData();
    form.append("client_id", `first-run-${Date.now().toString(36)}`);
    form.append("values", JSON.stringify({ product: "City 3", specs: "Upright commuter, 8-speed hub, dynamo lights, rear rack." }));
    const started = await call("POST", pathOf("POST", "recipes/{id}/runs", { id: recipe.id }), sam, form);
    const id = started.json?.run?.id;
    check(!!id, "Sam starts it", `${started.status} ${started.json?.run?.status ?? started.json?.message ?? ""}`);
    let view = null;
    for (let i = 0; id && i < 60; i++) {
      view = (await call("GET", pathOf("GET", "runs/{id}", { id }), sam)).json;
      if (["done", "partial", "failed", "refused", "declined", "stopped"].includes(view?.run?.status)) break;
      await sleep(3000);
    }
    spent += view?.run?.spent ?? 0;
    check(view?.run?.status === "done", "it ends done, text and image", `${view?.run?.status} ${view?.run?.detail ?? ""}`);
    const photo = view?.steps?.find((s) => s.kind === "image");
    const bytes = photo?.blob_id ? await call("GET", pathOf("GET", "media/{id}", { id: photo.blob_id }), sam) : photo?.url ? await fetch(photo.url).then(async (r) => ({ status: r.status, type: r.headers.get("content-type") ?? "" })) : null;
    check(bytes?.status === 200 && bytes.type.startsWith("image/"), "its photo shows here", photo?.blob_id ? "kept in a table" : "a signed link");
  }
  const asked = await call("POST", pathOf("POST", "ask"), sam, { question: "What do riders say about Trail 2 sizing?", client_id: `first-run-ask-${Date.now().toString(36)}` });
  spent += asked.json?.spent ?? 0;
  const cited = (asked.json?.citations ?? []).map((c) => c.title);
  check(asked.json?.state === "answered" && cited.length > 0, "the seeded question is answered with citations", cited.join(", "));
  check(cited.some((t) => /Halden|Trail 2 spec/.test(t)), "it cites the call or the spec sheet");
  console.log(`  Spent about $${(spent / 1_000_000).toFixed(3)}.`);
}

// The browser: what Jordan and Sam see on Home, the Playground and the Library.
const require = createRequire(import.meta.url);
let puppeteer;
try { puppeteer = require("puppeteer-core"); } catch { console.error("✗ puppeteer-core isn't installed (set NODE_PATH to a folder that has it)"); process.exit(2); }
const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"] });
async function signInAs(name, { width = 1280, height = 860, theme = "light" } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  await page.goto(app + "/sign-in", { waitUntil: "networkidle0" });
  for (const b of await page.$$("button")) if ((await b.evaluate((el) => el.textContent ?? "")).includes(name)) { await b.click(); break; }
  await page.waitForFunction(() => !location.pathname.startsWith("/sign-in"), { timeout: 20_000 });
  return page;
}
const text = (page, sel) => page.$eval(sel, (el) => el.textContent ?? "").catch(() => "");

console.log("What Jordan sees");
const j = await signInAs("Jordan");
await j.goto(app + "/", { waitUntil: "networkidle0" });
const steps = await j.$$eval("[data-first-run-step]", (els) => els.map((el) => el.getAttribute("data-first-run-step")));
const checklist = await text(j, '[data-kit="first-run"]');
check(steps.length ? ["playground", "recipe", "ask", "usage"].every((s) => steps.includes(s)) : /Playground/.test(checklist), "the first-run checklist leads to the Playground, the launch kit, Knowledge and Usage", steps.join(", ") || checklist.slice(0, 80));
if (!keyed) {
  const notice = await text(j, '[data-testid="ai-off"]');
  check(/AI isn't switched on here yet/.test(notice), "Home says AI isn't switched on here yet", notice.slice(0, 90));
  check(/npx @xano\/sdk (login|local stop)/.test(await text(j, '[data-testid="ai-fix"]')), "an admin reads the command that fixes it");
  await j.goto(app + "/playground?kind=image", { waitUntil: "networkidle0" });
  check(await j.$eval('[data-testid="generate"]', (b) => b.disabled).catch(() => false), "Generate is off");
  check(/Generate is off until AI is on/.test(await text(j, '[data-testid="run-why"]')), "and says so");
} else {
  check(!(await j.$('[data-testid="ai-off"]')), "no AI-off notice where AI is on");
}
if (shots) await j.screenshot({ path: join(shots, `first-run-home-${keyed ? "keyed" : "no-key"}.png`), fullPage: true });
await j.goto(app + "/library?kind=image", { waitUntil: "networkidle0" });
await j.waitForFunction(() => [...document.querySelectorAll('[data-testid="asset-tile"] img')].some((img) => img.complete && img.naturalWidth > 0), { timeout: 15_000 }).catch(() => null);
const pictures = await j.$$eval('[data-testid="asset-tile"] img', (imgs) => imgs.filter((img) => img.complete && img.naturalWidth > 0).length);
check(pictures >= 4, "Library tiles show their pictures", `${pictures} drawn`);

if (!keyed) {
  console.log("What Sam sees");
  const s = await signInAs("Sam");
  await s.goto(app + "/", { waitUntil: "networkidle0" });
  const notice = await text(s, '[data-testid="ai-off"]');
  check(/Ask an admin/.test(notice), "a member reads that an admin can switch it on", notice.slice(0, 90));
  check(!(await s.$('[data-testid="ai-fix"]')), "and no command");
  await s.goto(app + "/recipes/product-launch-kit", { waitUntil: "networkidle0" });
  check(await s.$eval('[data-testid="recipe-run"]', (b) => b.disabled).catch(() => false), "a recipe's Run is off too");
}

await browser.close();
console.log(errors.length ? `\n✗ ${errors.length} check(s) failed` : "\n✓ first-run check passed");
process.exit(errors.length ? 1 : 0);
