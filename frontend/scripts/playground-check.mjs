#!/usr/bin/env node
// The Playground for real, through the browser, against a deployed app with Xano AI on: one text run, one Compare of two
// text models, and one image, each clicked through the UI as a person would. Each must end done, show its time, usage
// and cost, show the code that made it (with the model and no key or token), and land in the person's history. The
// image is put in the team's library with "Use this".
//
//   node frontend/scripts/playground-check.mjs --app <url> [--persona Jordan] [--shots <dir>] [--skip compare,image]
//
// --app is the deployed frontend (an ephemeral's static URL, or a local Vite dev server pointed at a deployed backend).
// It spends real credits: about $0.10 (the image is most of it), billed to whoever the deploy signed in to Xano AI as.
// The person is an admin, so nothing waits for an approval. Needs puppeteer-core and Chrome (PUPPETEER_EXECUTABLE_PATH).
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const app = opt("app")?.replace(/\/$/, "");
if (!app) { console.error("usage: playground-check.mjs --app <url> [--persona Jordan] [--shots <dir>] [--skip compare,image]"); process.exit(2); }
const persona = opt("persona", "Jordan");
const shots = opt("shots", "");
const skip = new Set((opt("skip", "") || "").split(",").filter(Boolean));
if (shots) mkdirSync(shots, { recursive: true });

const errors = [];
const check = (good, what, detail = "") => {
  if (good) console.log(`  ✓ ${what}${detail ? `: ${detail}` : ""}`);
  else { errors.push(what); console.log(`  ✗ ${what}${detail ? `: ${detail}` : ""}`); }
};

const browser = await puppeteer.launch({
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
await page.setViewport({ width: 1280, height: 900 });
const shot = async (name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }); };

try {
  console.log(`- sign in as ${persona}`);
  await page.goto(app, { waitUntil: "networkidle2" });
  await page.waitForSelector('[data-testid="demo-login"]', { timeout: 30_000 });
  const picked = await page.$$eval('[data-testid="demo-login"]', (bs, who) => { const b = bs.find((x) => x.textContent?.includes(who)); b?.click(); return !!b; }, persona);
  check(picked, `a demo button for ${persona}`);
  await page.waitForFunction(() => !document.querySelector('[data-testid="demo-login"]'), { timeout: 30_000 });

  /** Type into a field, replacing what's there. */
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  const type = async (selector, text) => {
    await page.click(selector);
    await page.$eval(selector, (el) => el.select());
    await page.keyboard.press("Backspace");
    await page.type(selector, text);
  };
  /** Pick a model from a picker by its id. */
  const pickModel = async (picker, model) => {
    await page.click(`[data-testid="model-${picker}"]`);
    await page.waitForSelector(`[data-testid="model-option-${model}"]`, { timeout: 10_000 });
    await page.click(`[data-testid="model-option-${model}"]`);
    await page.waitForFunction(() => !document.querySelector('[role="listbox"]'), { timeout: 5_000 });
  };
  /** Wait for a pane to end, and read what it shows. */
  const settle = async (pane, seconds) => {
    await page.waitForFunction((p) => { const s = document.querySelector(`[data-testid="${p}"]`)?.getAttribute("data-state"); return s && !["sending", "running", "idle"].includes(s); },
      { timeout: seconds * 1000, polling: 500 }, pane);
    return page.$eval(`[data-testid="${pane}"]`, (el, p) => ({
      state: el.getAttribute("data-state"),
      line: el.querySelector(`[data-testid="${p}-line"]`)?.textContent ?? "",
      why: el.querySelector(`[data-testid="${p}-why"]`)?.textContent ?? "",
      text: el.querySelector('[data-testid="result-text"], [data-testid="result-json"]')?.textContent ?? "",
      header: el.querySelector("header")?.textContent ?? "",
    }), pane);
  };
  console.log("- text, Gemini 3.8 Flash");
  await page.goto(`${app}/playground?kind=text`, { waitUntil: "networkidle2" });
  await page.waitForSelector('[data-testid="prompt"]');
  await type('[data-testid="prompt"]', "Write one sentence about a gravel bike for a product page.");
  await pickModel("model-a", "gemini-3.8-flash");
  // ⌘↵ runs, as the button does.
  await page.keyboard.down(mod); await page.keyboard.press("Enter"); await page.keyboard.up(mod);
  const text = await settle("result-a", 120);
  check(text.state === "done", "the text run ended done", text.state === "done" ? text.header : text.why);
  check(text.text.trim().length > 0, "it shows the reply", JSON.stringify(text.text.slice(0, 80)));
  check(/\d+(,\d+)? in \/ \d+(,\d+)? out/.test(text.line) && /\$/.test(text.line), "it shows the tokens and the cost", text.line);
  check(/Done in \d+\.\d s/.test(text.header), "it shows the time taken", text.header.match(/Done in [\d.]+ s/)?.[0] ?? text.header);
  await shot("text-done");

  if (!skip.has("compare")) {
    console.log("- Compare: Gemini 3.8 Flash and Claude Sonnet 5.5");
    await page.click('[data-testid="compare-toggle"]');
    await page.waitForSelector('[data-testid="model-model-b"]');
    await pickModel("model-b", "claude-sonnet-5-5");
    await type('[data-testid="prompt"]', "Write the product page intro for the Trail 2 gravel bike: two sentences, mention 2.4 inch tyre clearance.");
    await page.click('[data-testid="generate"]');
    const [left, right] = [await settle("result-a", 120), await settle("result-b", 120)];
    check(left.state === "done" && right.state === "done", "both panes ended done", `${left.state} / ${right.state}`);
    check(left.header.includes("Gemini 3.8 Flash") && right.header.includes("Claude Sonnet 5.5"), "each pane names its model");
    check(/in \/ .* out/.test(left.line) && /in \/ .* out/.test(right.line) && left.line !== right.line, "each pane has its own tokens and cost", `${left.line} | ${right.line}`);
    await shot("text-compare");
    await page.click('[data-testid="compare-toggle"]');
  }

  if (!skip.has("image")) {
    console.log("- image, Nano Banana 2, 1K");
    await page.goto(`${app}/playground?kind=image`, { waitUntil: "networkidle2" });
    await page.waitForSelector('[data-testid="prompt"]');
    await pickModel("model-a", "gemini-3.1-flash-image");
    await type('[data-testid="prompt"]', "A sage green gravel bike on an oak studio set, morning light from the left, soft shadow.");
    await page.click('[data-testid="generate"]');
    const image = await settle("result-a", 180);
    check(image.state === "done", "the image run ended done", image.state === "done" ? image.header : image.why);
    check(/image/.test(image.line) && /\$/.test(image.line), "it shows what it used and the cost", image.line);
    const shown = await page.waitForFunction(() => { const img = document.querySelector('[data-testid="result-image"]'); return img && img.complete && img.naturalWidth > 0; }, { timeout: 30_000 }).then(() => true, () => false);
    const noLink = !!(await page.$('[data-testid="result-no-link"]'));
    check(shown || noLink, "the image shows from its signed link", shown ? "loaded" : "this server can't sign private files");
    await shot("image-done");
    await page.click('[data-testid="result-a-use"]');
    const kept = await page.waitForFunction(() => document.body.textContent?.includes("Kept in the library as a draft."), { timeout: 15_000 }).then(() => true, () => false);
    check(kept, "Use this puts it in the team's library as a draft");
  }

  console.log("- history");
  const rows = await page.$$eval('[data-kit="history-row"]', (els) => els.map((e) => e.textContent ?? ""));
  check(rows.length >= (skip.has("image") ? 1 : 2), "the runs are in the person's history", `${rows.length} rows`);
  if (!skip.has("compare")) check(rows.some((r) => r.includes("compared")), "the Compare is one line in history");
  check(consoleErrors.length === 0, "no page errors", consoleErrors.join(" | "));
} catch (error) {
  errors.push(String(error));
  console.log(`  ✗ ${error.message ?? error}`);
  await shot("failure").catch(() => {});
} finally {
  await browser.close();
}

console.log(errors.length ? `\n✗ ${errors.length} check(s) failed` : "\n✓ the Playground works end to end");
process.exit(errors.length ? 1 : 0);
