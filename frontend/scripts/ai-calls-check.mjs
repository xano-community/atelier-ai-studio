#!/usr/bin/env node
// Only the wrappers call models. Every Xano AI statement in the compiled bundle must sit in a function named ai/<kind>
// (each of which refuses a step without a reservation), and the only agent run allowed is the chatbot's. The source is
// checked too, so a model call can't hide in a helper that a wrapper doesn't own. The one exception is Easel's agent run:
// xano/function/studio/easel.ts writes it, and it is spliced into the chatbot's reply function, which the bundle check
// above holds to the chatbot. Any other model statement in that file still fails.
//
//   node frontend/scripts/ai-calls-check.mjs              compile the bundle and check it
//   node frontend/scripts/ai-calls-check.mjs --self-test  also prove the check fails when a call sits elsewhere
//
// Exit 0 = pass, 1 = a model call outside the wrappers (or the self-test didn't catch its planted one).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const selfTest = process.argv.includes("--self-test");
const MODEL_CALL = /^mvp:ai_/;
const AGENT_RUN = "mvp:call_agent";

/** Every statement in an object's stacks, with the object's kind and name. */
const callsIn = (payload) => {
  const found = [];
  const walk = (node, owner) => {
    if (Array.isArray(node)) node.forEach((n) => walk(n, owner));
    else if (node && typeof node === "object") {
      if (typeof node.name === "string" && (MODEL_CALL.test(node.name) || node.name === AGENT_RUN)) found.push({ ...owner, statement: node.name });
      for (const v of Object.values(node)) walk(v, owner);
    }
  };
  for (const [kind, items] of Object.entries(payload)) {
    if (!Array.isArray(items)) continue;
    for (const item of items) if (item && typeof item === "object") walk(item, { kind, name: item.name });
  }
  return found;
};

const allowed = ({ kind, name, statement }) =>
  kind === "function" && (statement === AGENT_RUN ? name.startsWith("chatbot/") : name.startsWith("ai/"));

/** The bundle's misplaced calls. */
const check = (payload) => callsIn(payload).filter((call) => !allowed(call));

/** Where Easel's agent run is written; it runs inside the chatbot's reply function. */
const EASEL_SOURCE = "xano/function/studio/easel.ts";

/** Source files outside xano/function/ai that write `s.ai.`. */
const sourceHits = () => {
  const hits = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) { if (entry !== "node_modules" && entry !== "lambdas") visit(path); continue; }
      if (!path.endsWith(".ts")) continue;
      const rel = relative(root, path);
      if (rel.startsWith("xano/function/ai/")) continue;
      readFileSync(path, "utf8").split("\n").forEach((line, i) => {
        if (!/\bs\.ai\./.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
        if (rel === EASEL_SOURCE && !line.replace(/\bs\.ai\.agent\.run\(/g, "").match(/\bs\.ai\./)) return;
        hits.push(`${rel}:${i + 1}`);
      });
    }
  };
  visit(join(root, "xano"));
  return hits;
};

const out = join(mkdtempSync(join(tmpdir(), "ai-calls-")), "workspace.json");
execFileSync("npx", ["xanosdk", "export", "./xano/index.ts", "--out", out], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
const payload = JSON.parse(readFileSync(out, "utf8")).payload;

let failed = false;
const calls = callsIn(payload);
const wrappers = new Set(calls.filter((c) => c.name.startsWith("ai/")).map((c) => c.name));
console.log(`· ${calls.length} model statements in the bundle, in ${wrappers.size} wrappers: ${[...wrappers].sort().join(", ")}`);
const misplaced = check(payload);
if (misplaced.length) {
  failed = true;
  for (const m of misplaced) console.log(`✗ ${m.statement} in ${m.kind} "${m.name}": only function/ai/* may call a model`);
} else console.log("✓ every model call in the bundle is in an ai/* wrapper (and the only agent run is the chatbot's)");

const hits = sourceHits();
if (hits.length) {
  failed = true;
  for (const h of hits) console.log(`✗ s.ai. outside xano/function/ai: ${h}`);
} else console.log("✓ no s.ai. in the source outside xano/function/ai");

if (selfTest) {
  // Plant a text call in a function that isn't a wrapper, and an agent run outside the chatbot: both must be caught.
  const planted = structuredClone(payload);
  const victim = planted.function.find((f) => f.name === "runs/sweep");
  victim.run = [...(victim.run ?? []), { name: "mvp:ai_text_generate", input: [] }];
  const otherTask = planted.task?.[0] ?? planted.function.find((f) => f.name === "spend/estimate");
  otherTask.run = [...(otherTask.run ?? []), { name: AGENT_RUN, input: [] }];
  const caught = check(planted);
  const ok = caught.some((c) => c.name === "runs/sweep") && caught.some((c) => c.name === otherTask.name);
  if (ok) console.log(`✓ self-test: a planted call in runs/sweep and an agent run in ${otherTask.name} are both caught`);
  else { failed = true; console.log("✗ self-test: a planted model call was not caught"); }
}

console.log(failed ? "✗ ai-calls-check failed" : "✓ ai-calls-check: all passed");
process.exit(failed ? 1 : 0);
