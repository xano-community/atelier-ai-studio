#!/usr/bin/env node
// `npm run xano:deploy`: deploy the backend, then tell it what the deploy said about Xano AI. A deploy reports whether this
// machine's sign-in can use Xano AI (and until when, on a Xano Engine), but the running app can't read that report, so it
// goes into the XANO_AI_DEPLOY env value on the backend just deployed. Every screen then shows the right state from the
// first minute: a deploy that wasn't signed in says "AI isn't switched on here yet" with the sign-in command, before anyone
// runs anything. Arguments are passed to `xanosdk deploy` as they are.
import { spawnSync } from "node:child_process";

const run = (args) => spawnSync("npx", ["xanosdk", ...args], { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 });

const deployed = run(["deploy", ...process.argv.slice(2), "--json"]);
let report;
try { report = JSON.parse(deployed.stdout); } catch {
  process.stdout.write(deployed.stdout ?? "");
  process.exit(deployed.status || 1);
}
if (report.ok === false || deployed.status) {
  console.error(`✗ ${report.error?.message ?? "The deploy didn't finish."}`);
  process.exit(deployed.status || 1);
}

console.log(`✓ Deployed to ${report.url}`);
if (report.testRun) console.log(`  Tests: ${JSON.stringify(report.testRun.summary ?? report.testRun)}`);

const ai = report.ai;
if (!ai) {
  console.log("  The deploy said nothing about Xano AI, so the app goes by what its calls are told.");
  process.exit(0);
}
const expires = ai.expiresAt ? Date.parse(ai.expiresAt) : 0;
const said = { status: ai.status, reason: ai.reason ?? "", billing: ai.billing ?? "", expires_ms: Number.isFinite(expires) ? expires : 0 };
if (ai.status === "on") {
  const until = expires ? `, until ${new Date(expires).toLocaleString()}` : "";
  console.log(`  Xano AI is on, billed to ${ai.billing === "instance" ? "the instance owner" : "the signed-in user"}${until}.`);
} else {
  console.log(`  Xano AI is off here (${ai.reason ?? "no sign-in"}). Everything else works; to run models, sign in with \`npx @xano/sdk login\` and deploy again.`);
}

const told = run(["env", "set", "XANO_AI_DEPLOY", JSON.stringify(said), "--to", report.selector, "--yes"]);
if (told.status) {
  console.error("  The backend couldn't be told about Xano AI, so it goes by what its calls are told. Deploy again to retry.");
  process.exit(told.status);
}
