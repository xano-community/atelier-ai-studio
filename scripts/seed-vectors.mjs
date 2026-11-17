#!/usr/bin/env node
// Embed the seeded Knowledge passages once and commit their vectors, so a deploy shows working Knowledge with no AI:
//
//   npm run seed:vectors
//
// It deploys a one-endpoint backend to a dev-cloud ephemeral (signed in with this project's pinned profile, which needs
// Xano AI), embeds every passage in xano/world-knowledge.ts with the same model, task and size the app uses, writes
// xano/seed-vectors.json keyed by each passage's SHA-256, and deletes the ephemeral. Run it again after changing a
// passage. It costs a fraction of a cent.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "gemini-embedding-2";
const DIMENSIONS = 768;
const BATCH = 50;

const sha = (text) => createHash("sha256").update(text).digest("hex");
const sdk = (args, cwd) => spawnSync("npx", ["xanosdk", ...args, "--json", "--no-refresh"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// The passages, read through tsx so this script sees exactly what the world seeds.
const listed = spawnSync("npx", ["tsx", "-e", "import('./xano/world-knowledge.ts').then((m) => process.stdout.write(JSON.stringify(m.SEED_PASSAGE_TEXTS)))"], { cwd: root, encoding: "utf8" });
if (listed.status) throw new Error(`Couldn't read the passages: ${listed.stderr}`);
const texts = [...new Set(JSON.parse(listed.stdout))];
console.log(`${texts.length} passages to embed.`);

// A throwaway backend: one endpoint that embeds a list, behind a secret made for this run.
const secret = randomBytes(24).toString("hex");
const dir = mkdtempSync(join(tmpdir(), "atelier-seed-vectors-"));
mkdirSync(join(dir, "xano"));
symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
if (existsSync(join(root, "xano.profile.json"))) copyFileSync(join(root, "xano.profile.json"), join(dir, "xano.profile.json"));
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "atelier-seed-vectors", private: true, type: "module" }));
writeFileSync(join(dir, "xano", "index.ts"), `
import { apiGroup, c, expr, guard, inp, input, query, ref, s, workspace } from "@xano/sdk";
const api = apiGroup({ name: "vectors", canonical: "vectors" });
const embed = query({
  name: "embed", verb: "POST", apiGroup: api,
  input: { secret: input.text(), texts: input.json() },
  stack: [
    guard.require(expr(inp("secret"), "=", c.text(${JSON.stringify(secret)})), { errorType: "accessdenied", message: "No." }),
    s.ai.embedding.create({ model: c.text(${JSON.stringify(MODEL)}), input: inp("texts"), task_type: c.text("RETRIEVAL_DOCUMENT"), dimensions: c.int(${DIMENSIONS}), as: "made" }),
  ],
  response: ref("made.embeddings"),
});
export default workspace("atelier-seed-vectors").registerApiGroups([api]).registerQueries([embed]);
`);

let ephemeral = "";
try {
  const deployed = sdk(["deploy", "./xano/index.ts", "--ephemeral"], dir);
  const report = JSON.parse(deployed.stdout || "{}");
  if (deployed.status || !report.url) throw new Error(`The ephemeral didn't deploy: ${deployed.stdout}${deployed.stderr}`);
  ephemeral = report.selector ?? report.destination?.label ?? "";
  console.log(`Embedding on ${report.url}, Xano AI ${report.ai?.status ?? "unknown"}.`);
  const vectors = {};
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const answer = await fetch(`${report.url}/api:vectors/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret, texts: batch }) });
    if (!answer.ok) throw new Error(`Embedding failed (${answer.status}): ${await answer.text()}`);
    const made = await answer.json();
    if (!Array.isArray(made) || made.length !== batch.length) throw new Error(`Expected ${batch.length} vectors, got ${Array.isArray(made) ? made.length : typeof made}.`);
    batch.forEach((text, k) => {
      if (made[k].length !== DIMENSIONS) throw new Error(`A vector has ${made[k].length} numbers, not ${DIMENSIONS}.`);
      vectors[sha(text)] = made[k].map((n) => Math.round(n * 1e6) / 1e6);
    });
  }
  writeFileSync(join(root, "xano", "seed-vectors.json"), `${JSON.stringify({ model: MODEL, dimensions: DIMENSIONS, task_type: "RETRIEVAL_DOCUMENT", vectors })}\n`);
  console.log(`Wrote ${Object.keys(vectors).length} vectors to xano/seed-vectors.json.`);
} finally {
  if (ephemeral) {
    const gone = sdk(["ephemeral", "delete", ephemeral.replace(/^ephemeral:/, ""), "--yes"], dir);
    console.log(gone.status ? `Delete the ephemeral ${ephemeral} by hand: ${gone.stdout}${gone.stderr}` : `Deleted the ephemeral ${ephemeral}.`);
  }
  rmSync(dir, { recursive: true, force: true });
}
