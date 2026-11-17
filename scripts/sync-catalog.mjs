#!/usr/bin/env node
// Refresh xano/catalog.gen.json from the live Xano AI catalog: the models each AI statement takes, their labels, tiers,
// options and price text. The backend serves this file to the Playground and refuses a model that isn't in it, so a
// run never reserves money for a model Xano AI doesn't offer.
//
//   node scripts/sync-catalog.mjs [--profile <name>]
//
// The catalog is read with `npx xanosdk ai models --json`. When it can't be read (the hub answers 404 at times, or
// there's no network), the committed file stays as it is and the script says so: a build never loses its model list.
//
// Exit 0 = written or kept, 1 = the catalog came back in a shape this script doesn't know.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "xano", "catalog.gen.json");
const argv = process.argv.slice(2);
const profileAt = argv.findIndex((a) => a === "--profile" || a === "-p");
const profile = profileAt >= 0 ? argv[profileAt + 1] : undefined;

/**
 * Models the catalog lists that the gateway refuses, with the words a person reads. The catalog can't say this itself,
 * so it's kept here by hand and checked when the live proof runs again. A model leaves this list once a call to it works.
 */
const UNAVAILABLE = {
  "claude-haiku-5-5": "Xano AI lists Claude Haiku 5.5 but doesn't serve it yet. Pick another text model.",
};

/** What the Playground and the server read from each model. Everything else in the catalog stays out. */
const keep = (m) => ({
  model: m.model, label: m.label, tier: m.tier ?? "", stage: m.stage ?? "ga", suggested: !!m.suggested,
  price: m.price ?? "", options: m.options ?? {},
});

let live;
try {
  const args = ["xanosdk", "ai", "models", "--json", ...(profile ? ["--profile", profile] : [])];
  live = JSON.parse(execFileSync("npx", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, XANOSDK_NO_UPDATE_CHECK: "1" } }));
} catch (error) {
  // A non-zero exit still prints its JSON document on stdout: read the reason from it when there is one.
  try { live = JSON.parse(String(error.stdout ?? "")); } catch { live = { ok: false, error: { message: error.message } }; }
}

if (!live || live.ok === false || !live.statements) {
  const why = live?.error?.message ?? "the catalog didn't answer";
  if (!existsSync(out)) { console.error(`✗ Couldn't read the Xano AI catalog (${why}), and there's no ${out} to keep.`); process.exit(1); }
  console.log(`! Couldn't read the Xano AI catalog (${why}). Kept the committed xano/catalog.gen.json.`);
  process.exit(0);
}

const statements = {};
for (const [kind, models] of Object.entries(live.statements)) {
  if (!Array.isArray(models)) { console.error(`✗ The catalog's "${kind}" isn't a list of models.`); process.exit(1); }
  // Unlisted models still run when a saved script names them, but no picker offers them: neither does this one.
  statements[kind] = models.filter((m) => m && typeof m.model === "string" && m.listed !== false).map(keep)
    // The suggested model first, then the catalog's own order.
    .sort((a, b) => Number(b.suggested) - Number(a.suggested));
}

const next = {
  source: live.source ?? "live",
  generated_at: live.generated_at ?? "",
  statements,
  unavailable: Object.fromEntries(Object.entries(UNAVAILABLE).filter(([model]) => Object.values(statements).some((list) => list.some((m) => m.model === model)))),
};
const text = `${JSON.stringify(next, null, 2)}\n`;
const before = existsSync(out) ? readFileSync(out, "utf8") : "";
if (before === text) { console.log("✓ xano/catalog.gen.json is already current."); process.exit(0); }
writeFileSync(out, text);
const counts = Object.entries(statements).map(([kind, list]) => `${kind} ${list.length}`).join(", ");
console.log(`✓ Wrote xano/catalog.gen.json from ${next.host || "the live catalog"} (${counts}).`);
