#!/usr/bin/env node
// The Library, against a deployed backend and the app in a browser.
//
// API: Sam makes two images and a short text in the Playground and keeps them with "Use this"; each must be a draft item
// with its prompt, model, cost, maker and run. Alex (a guest) must see no drafts, get the same 404 for a draft as for an
// id nobody has, and get 403 approving. Priya approves one: status, approver and time are set, and Alex now sees it. A
// text item downloads with Content-Disposition: attachment and Cache-Control: private, no-store. A file downloads
// through a signed link that must work, then stop working after a minute (--expiry waits for it); a server that can't
// sign private links (a Xano Engine on your machine) must say so in words instead.
//
// Browser: the Library grid is the signature view; an item's record opens at /library/<id> and survives a reload; the
// kind tabs and Approved only narrow it; ⌘K finds an item by its title; "Use in a new run" opens the Playground starting
// from the item. With 300 items (the list endpoint's answers padded out with copies of real tiles, and its date groups'
// counts to match, in the browser only) scrolling the grid moves nothing that's already on screen. --shots <dir> saves the
// screen in light and dark at 1280 and 390 px.
//
//   node frontend/scripts/library-check.mjs --backend <url> --app <url> [--shots <dir>] [--expiry] [--no-make]
//
// It spends real credits, billed to whoever the deploy signed in to Xano AI as: about $0.15 (two images and a text).
// --no-make uses what the library already holds instead (it needs an image and a draft text).
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
const app = opt("app")?.replace(/\/$/, "");
const shots = opt("shots");
const waitExpiry = argv.includes("--expiry");
const make = !argv.includes("--no-make");
if (!backend || !app) { console.error("usage: library-check.mjs --backend <url> --app <url> [--shots <dir>] [--expiry] [--no-make]"); process.exit(2); }
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
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) };
  const res = await fetch(backend + path, { method: verb, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(300_000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
};
const signIn = async (persona) => {
  const t = (await call("POST", pathOf("POST", "auth/demo"), null, { persona })).json?.authToken;
  if (!t) { console.error(`✗ couldn't sign in as ${persona}`); process.exit(1); }
  return t;
};
const sam = await signIn("sam");
const priya = await signIn("priya");
const alex = await signIn("alex");
const tag = Date.now().toString(36);
let spent = 0;

console.log("Who may read");
check((await call("GET", pathOf("GET", "assets"))).status === 401, "the library needs a sign-in");

/** A private Playground run kept in the team's library with "Use this": the item's id. */
async function makeAndKeep(kind, model, input, options, title) {
  const r = await call("POST", pathOf("POST", "runs"), sam, { client_id: `lib-${tag}-${title}`, kind, model, input, options, title, private: true });
  const step = r.json?.steps?.[0];
  spent += r.json?.run?.spent ?? 0;
  if (!step || step.status !== "succeeded") { check(false, `the ${kind} run finished`, `${r.status} ${r.json?.run?.status ?? ""} ${r.json?.run?.detail ?? r.json?.message ?? ""}`); return 0; }
  const kept = await call("POST", pathOf("POST", "playground/steps/{id}/use", { id: step.id }), sam);
  check(kept.status === 200 && kept.json?.asset_id === step.asset_id, `"Use this" puts the ${kind} in the team's library`, `item #${kept.json?.asset_id}`);
  return { id: kept.json?.asset_id ?? 0, run: r.json.run.id, model, prompt: input.prompt, title };
}

let image, words;
if (make) {
  console.log("Making two images and a text (live Xano AI)");
  image = await makeAndKeep("image", "gemini-3.1-flash-image", { prompt: "A sage green gravel bike leaning on an oak workbench, soft morning light, studio photo", use_brand: false },
    { size: "1K", aspect_ratio: "1:1", samples: 1 }, `Trail 2 on the oak bench ${tag}`);
  await makeAndKeep("image", "gemini-3.1-flash-image", { prompt: "A gravel bike on a coast road at dusk, wide shot, warm light", use_brand: false },
    { size: "1K", aspect_ratio: "16:9", samples: 1 }, `Trail 2 on the coast road ${tag}`);
  words = await makeAndKeep("text", "gemini-3.8-flash", { prompt: "Write one sentence of launch copy for a gravel bike called the Trail 2.", use_brand: false, response_format: "text" },
    { input_tokens: 40, output_tokens: 1000 }, `Trail 2 launch line ${tag}`);
} else {
  const items = (await call("GET", pathOf("GET", "assets") + "?per_page=120", sam)).json?.items ?? [];
  // As a made one would be: a draft image of Sam's, which Priya then approves.
  image = items.find((t) => t.kind === "image" && t.maker_name === "Sam Rivera" && t.status === "draft") ?? items.find((t) => t.kind === "image");
  words = items.find((t) => t.kind === "text" && t.status === "draft");
}
if (!image?.id || !words?.id) { console.error("✗ the library needs an image and a draft text to check"); process.exit(1); }

console.log("The record");
const rec = (await call("GET", pathOf("GET", "assets/{id}", { id: image.id }), priya)).json;
if (make) check(rec?.status === "draft", "a kept output starts as a draft", rec?.status);
check(rec?.kind === "image" && (!make || rec.prompt === image.prompt), "it records the prompt", rec?.prompt?.slice(0, 50));
check(!!rec?.model && (!make || rec.model === image.model), "and the model", rec?.model);
check(rec?.estimated_cost > 0, "and what it cost", `${rec?.estimated_cost} micro-dollars`);
check(rec?.maker_name === "Sam Rivera", "and who made it", rec?.maker_name);
check(rec?.run?.id > 0 && (!make || rec.run.id === image.run), "and the run it came from", `run #${rec?.run?.id}, step ${rec?.step_seq}`);
check(rec?.can_approve === true && rec?.can_delete === false, "Priya may approve it but not delete Sam's item");

console.log("Guests see approved items only");
const guestList = (await call("GET", pathOf("GET", "assets") + "?per_page=120", alex)).json;
check(Array.isArray(guestList?.items) && guestList.items.every((t) => t.status === "approved"), "a guest's list holds only approved items", `${guestList?.items?.length ?? "?"} items`);
const peek = await call("GET", pathOf("GET", "assets/{id}", { id: words.id }), alex);
const nobody = await call("GET", pathOf("GET", "assets/{id}", { id: 99_999_999 }), alex);
check(peek.status === 404 && nobody.status === 404 && peek.json?.message === nobody.json?.message, "a draft answers a guest exactly as an unknown id does", `${peek.status} "${peek.json?.message}"`);
const guestApprove = await call("POST", pathOf("POST", "assets/{id}/approve", { id: image.id }), alex);
check(guestApprove.status === 403, "a guest can't approve", `${guestApprove.status} ${guestApprove.json?.message ?? ""}`);

console.log("Approving");
const before = Date.now();
const ok = (await call("POST", pathOf("POST", "assets/{id}/approve", { id: image.id }), priya)).json;
const priyaMe = (await call("GET", pathOf("GET", "auth/me"), priya)).json;
check(ok?.status === "approved", "approving sets the status");
check(ok?.approved_by === priyaMe?.id, "and who approved it");
check(rec?.status === "approved" ? ok?.approved_at > 0 : ok?.approved_at >= before - 5_000, "and when");
const guestAfter = (await call("GET", pathOf("GET", "assets") + "?per_page=120", alex)).json;
check(guestAfter?.items?.some((t) => t.id === image.id), "the guest now sees it");

console.log("Downloads");
const text = await call("GET", pathOf("GET", "assets/{id}/text", { id: words.id }), sam);
check(text.status === 200, "a text item downloads", `${text.status}`);
check(/^attachment;/.test(text.headers.get("content-disposition") ?? ""), "as an attachment", text.headers.get("content-disposition"));
check((text.headers.get("cache-control") ?? "").includes("no-store") && (text.headers.get("cache-control") ?? "").includes("private"), "never cached", text.headers.get("cache-control"));
check(text.headers.get("x-content-type-options") === "nosniff", "and never sniffed into a page");
const link = (await call("GET", pathOf("GET", "assets/{id}/link", { id: image.id }), sam)).json;
if (link?.how === "signed") {
  check(link.expires_in === 60, "a file's link lasts a minute");
  const got = await fetch(link.url);
  check(got.ok && (got.headers.get("content-type") ?? "").startsWith("image/"), "the signed link serves the file", `${got.status} ${got.headers.get("content-type")}`);
  if (waitExpiry) {
    console.log("  … waiting 70 s for the link to run out");
    await new Promise((r) => setTimeout(r, 70_000));
    const late = await fetch(link.url);
    check(!late.ok, "the link stops working after a minute", `${late.status}`);
  }
} else if (link?.how === "table") {
  // A server that can't sign private links (the Xano Engine) keeps made files in a table, behind the authed media route.
  check(link.blob_id > 0 && link.url === "", "where private links can't be signed, the file is kept in a table and served by the media route", `blob ${link.blob_id}`);
} else {
  check(link?.how === "unavailable" && link.url === "", "where private links can't be signed, the answer says so instead of a broken link", link?.how);
  console.log("  · this server can't sign private links: the signed link and its expiry are checked on Xano cloud");
}

// The browser.
const require = createRequire(import.meta.url);
let puppeteer;
try { puppeteer = require("puppeteer-core"); } catch { console.error("✗ puppeteer-core isn't installed (set NODE_PATH to a folder that has it)"); process.exit(2); }
const browser = await puppeteer.launch({ executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--no-sandbox"] });
const problems = [];
/** Sign in by the demo button, the way a person does, in a fresh browser context, in this theme and size. */
async function signInAs(name, { width = 1280, height = 860, theme = "light" } = {}) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.goto(app + "/sign-in", { waitUntil: "networkidle0" });
  const buttons = await page.$$("button");
  for (const b of buttons) {
    const t = await b.evaluate((el) => el.textContent ?? "");
    if (t.includes(name)) { await b.click(); break; }
  }
  await page.waitForFunction(() => !location.pathname.startsWith("/sign-in"), { timeout: 20_000 });
  return page;
}

console.log("The Library screen");
const page = await signInAs("Sam");
await page.goto(app + "/library", { waitUntil: "networkidle0" });
check(!!(await page.$('[data-signature-view="library"]')), "the grid is the signature view");
check(!!(await page.$(`[data-testid="asset-tile"][data-id="${image.id}"]`)), "the new image is on it");
await page.click(`[data-testid="asset-tile"][data-id="${image.id}"]`);
await page.waitForSelector('[data-testid="asset-sheet"]', { timeout: 10_000 });
check(page.url().endsWith(`/library/${image.id}`), "opening an item puts it in the address", page.url().replace(app, ""));
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector('[data-testid="asset-sheet"]', { timeout: 10_000 });
check((await page.$eval('[data-testid="asset-prompt"]', (el) => el.textContent ?? "")).length > 0, "the record survives a reload, prompt and all");
const preview = (await page.$('[data-testid="asset-image"]')) ? "image" : (await page.$('[data-testid="asset-no-link"]')) ? "no-link" : "";
check(preview !== "", "the sheet shows the picture, or says why it can't here", preview);
await page.keyboard.press("Escape");
await page.waitForFunction(() => location.pathname === "/library", { timeout: 5_000 }).catch(() => {});
check(new URL(page.url()).pathname === "/library", "Escape closes it");
// Let the sheet finish sliding away before clicking under it.
await page.waitForFunction(() => !document.querySelector('[data-kit="record-sheet"]'), { timeout: 5_000 }).catch(() => {});

await page.click('[data-testid="kind-text"]');
/** Wait until the grid's tiles satisfy `test` (the list refetches when a tab or filter changes). */
const tilesWhere = (test, arg) => page.waitForFunction(new Function("arg", `const tiles = [...document.querySelectorAll('[data-testid="asset-tile"]')].map((e) => ({ id: Number(e.dataset.id), kind: e.dataset.kind })); return tiles.length > 0 && (${test})(tiles, arg);`), { timeout: 10_000 }, arg).then(() => true, () => false);
check(await tilesWhere("(tiles) => tiles.every((t) => t.kind === 'text' || t.kind === 'transcript')"), "the Text tab holds only words");
await page.click('[data-testid="kind-all"]');
await page.waitForSelector('[data-testid="kind-all"][aria-checked="true"]');
await page.click('[data-testid="filter-approved"]');
check(await tilesWhere("(tiles, ids) => tiles.some((t) => t.id === ids.approved) && !tiles.some((t) => t.id === ids.draft)", { approved: image.id, draft: words.id }),
  "Approved only shows the approved item and not the draft",
  await page.evaluate(() => `${location.search} → ${[...document.querySelectorAll('[data-testid="asset-tile"]')].map((e) => e.dataset.id).join(",")}`));
await page.click('[data-testid="filter-approved"]');

console.log("⌘K");
await page.keyboard.down("Meta"); await page.keyboard.press("k"); await page.keyboard.up("Meta");
await page.waitForSelector("[cmdk-input]", { timeout: 5_000 });
// The words item's own title, or its first two words: what someone would type.
const lookFor = (words.title ?? "launch line").split(/\s+/).slice(0, 2).join(" ");
await page.type("[cmdk-input]", lookFor);
const found = await page.waitForFunction((t) => [...document.querySelectorAll("[cmdk-item]")].find((el) => el.textContent?.includes(t)), { timeout: 10_000 }, words.title ?? "launch line").catch(() => null);
check(!!found, "⌘K finds a library item by its title");
if (found) {
  await found.asElement()?.click();
  await page.waitForSelector('[data-testid="asset-sheet"]', { timeout: 10_000 }).catch(() => {});
  // Items can share a title (a recipe run names its copy and its photo alike): the record opened must carry that title.
  const opened = await page.$eval('[data-testid="asset-sheet"]', () => document.querySelector('[data-slot="sheet-title"]')?.textContent ?? "").catch(() => "");
  check(/\/library\/\d+$/.test(page.url()) && opened.includes(words.title ?? ""), "and opens its record", `${page.url()} ${opened}`);
}

console.log("Use in a new run");
await page.goto(app + `/library/${words.id}`, { waitUntil: "networkidle0" });
await page.waitForSelector('[data-testid="asset-use"]');
await page.click('[data-testid="asset-use"]');
await page.waitForSelector('[data-testid="from-library"]', { timeout: 10_000 });
await page.waitForFunction(() => ["attached", "failed"].includes(document.querySelector('[data-testid="from-library"]')?.getAttribute("data-state") ?? ""), { timeout: 15_000 });
const fromState = await page.$eval('[data-testid="from-library"]', (el) => el.getAttribute("data-state"));
const promptNow = await page.$eval('[data-testid="prompt"], textarea', (el) => el.value).catch(() => "");
check(new URL(page.url()).pathname === "/playground" && fromState === "attached" && promptNow.length > 0, "a text item opens the Playground with its words as the prompt", `${fromState}, ${promptNow.length} characters`);
await page.goto(app + `/library/${image.id}`, { waitUntil: "networkidle0" });
await page.waitForSelector('[data-testid="asset-use"]');
await page.click('[data-testid="asset-use"]');
await page.waitForFunction(() => ["attached", "failed"].includes(document.querySelector('[data-testid="from-library"]')?.getAttribute("data-state") ?? ""), { timeout: 20_000 });
const imageFrom = await page.$eval('[data-testid="from-library"]', (el) => ({ state: el.getAttribute("data-state"), words: el.textContent ?? "" }));
if (link?.how === "signed" || link?.how === "table") check(imageFrom.state === "attached", "an image opens the Playground attached to edit", imageFrom.words);
else check(imageFrom.state === "failed" && /private file links|Xano cloud/.test(imageFrom.words), "where files can't be linked, the Playground says the image couldn't be attached and why", imageFrom.words.slice(0, 90));

console.log("300 items scroll without moving");
const big = await signInAs("Sam");
const real = (await call("GET", pathOf("GET", "assets") + "?per_page=60", sam)).json?.items ?? [];
await big.setRequestInterception(true);
big.on("request", (req) => {
  const u = new URL(req.url());
  if (req.method() !== "GET" || !u.pathname.endsWith("/assets") || !real.length) { void req.continue(); return; }
  const pageNo = Number(u.searchParams.get("page") || 1), per = Number(u.searchParams.get("per_page") || 60);
  // The 300 stand in for the real list, newest first as the server keeps it: copy n of the real item at the same
  // place in its order, so the dates run down the list as real ones do.
  const copy = (n) => { const t = real[Math.floor((n * real.length) / 300)]; return { ...t, id: 1_000_000 + n, title: `${t.title} (${n + 1})`, thumb: "" }; };
  const items = Array.from({ length: Math.max(0, Math.min(per, 300 - (pageNo - 1) * per)) }, (_, i) => copy((pageNo - 1) * per + i));
  // And each date group's count, from the boundaries the screen sent, as the server answers them.
  const from = ["today_from", "yesterday_from", "week_from"].map((k) => Number(u.searchParams.get(k) || 0));
  const all = Array.from({ length: 300 }, (_, n) => copy(n));
  const since = (t, words) => all.filter((c) => c.created_at >= t && (!words || c.kind === "text" || c.kind === "transcript")).length;
  const groups = ["Today", "Yesterday", "This week", "Earlier"];
  const edges = [...from, 0];
  const dates = from.every((t) => t > 0)
    ? groups.map((group, g) => ({ group, n: since(edges[g], false) - (g ? since(edges[g - 1], false) : 0), words: since(edges[g], true) - (g ? since(edges[g - 1], true) : 0) }))
    : [];
  void req.respond({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ items, total: 300, next_page: pageNo * per < 300 ? pageNo + 1 : null, page: pageNo, dates }) });
});
await big.goto(app + "/library", { waitUntil: "networkidle0" });
await big.waitForSelector('[data-testid="asset-tile"]');
const shift = await big.evaluate(async () => {
  let cls = 0;
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: "layout-shift", buffered: false });
  const pane = document.querySelector('[data-kit="scroll-pane"]');
  const grid = document.querySelector('[data-signature-view="library"]');
  const heightBefore = grid.getBoundingClientRect().height;
  const moved = [];
  for (let y = 0; y < pane.scrollHeight; y += 400) {
    pane.scrollTop = y;
    await new Promise((r) => setTimeout(r, 120));
    const tile = document.querySelector('[data-testid="asset-tile"]');
    const top = tile.getBoundingClientRect().top;
    await new Promise((r) => setTimeout(r, 300));
    if (Math.abs(tile.getBoundingClientRect().top - top) > 0.5 && tile.isConnected) moved.push(y);
  }
  pane.scrollTop = pane.scrollHeight;
  await new Promise((r) => setTimeout(r, 800));
  const last = [...document.querySelectorAll('[data-testid="asset-tile"]')].some((el) => el.textContent?.includes("(300)"));
  return { cls, moved, last, same: Math.abs(grid.getBoundingClientRect().height - heightBefore) < 1, rendered: document.querySelectorAll('[data-testid="asset-tile"]').length };
});
check(shift.same, "the grid's height is set from the count, before the pages arrive");
check(shift.moved.length === 0 && shift.cls < 0.01, "nothing on screen moves as pages land", `layout shift ${shift.cls.toFixed(4)}, ${shift.moved.length} moves`);
check(shift.last, "the 300th item is reachable");
check(shift.rendered < 120, "only the rows near the screen are drawn", `${shift.rendered} tiles in the page`);
await big.close();

if (shots) {
  console.log("Screenshots");
  for (const theme of ["light", "dark"]) {
    for (const width of [1280, 390]) {
      const p = await signInAs("Sam", { width, height: width > 500 ? 860 : 844, theme });
      await p.goto(app + "/library", { waitUntil: "networkidle0" });
      await p.screenshot({ path: join(shots, `library-${theme}-${width}.png`) });
      await p.goto(app + `/library/${image.id}`, { waitUntil: "networkidle0" });
      await p.waitForSelector('[data-testid="asset-sheet"]', { timeout: 10_000 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      await p.screenshot({ path: join(shots, `asset-${theme}-${width}.png`) });
      const wide = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      check(!wide, `nothing scrolls sideways at ${width} px (${theme})`);
      await p.close();
    }
  }
  const g = await signInAs("Alex");
  await g.goto(app + "/library", { waitUntil: "networkidle0" });
  await g.screenshot({ path: join(shots, "library-guest-light-1280.png") });
  await g.close();
}

const real404 = problems;
check(real404.length === 0, "no console errors", real404.slice(0, 3).join(" | "));
await browser.close();

console.log(`\nSpent about $${(spent / 1_000_000).toFixed(3)} on Xano AI.`);
if (errors.length) { console.log(`✗ ${errors.length} check(s) failed`); process.exit(1); }
console.log("✓ library-check passed");
