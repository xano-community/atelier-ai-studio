#!/usr/bin/env node
// The spend gate under real concurrency, against a deployed backend: what a workflow test can't show, because it runs
// one statement at a time. Requests here go out together.
//
//   1. Runs started at the same moment by someone with no budget row yet this month open one row for them, not two.
//   2. Two runs that each fit the team's budget but not together: exactly one reserves.
//   3. The same request sent five times at once is one run.
//   4. The same client_id with a different request is 409.
//
//   node frontend/scripts/spend-check.mjs --backend <url>
//
// Run it against a fresh deploy (a team budget row that's already open this month is reported, and check 1 then covers
// the person's row only). It starts real runs with a cheap text model; nothing executes them yet, so their reservations
// stay held until the sweep or a reconcile. It puts the team budget back as it found it.
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
if (!backend) { console.error("usage: spend-check.mjs --backend <url>"); process.exit(2); }

const errors = [];
const check = (good, what, detail = "") => {
  if (good) console.log(`✓ ${what}${detail ? `: ${detail}` : ""}`);
  else { errors.push(what); console.log(`✗ ${what}${detail ? `: ${detail}` : ""}`); }
};

const routes = JSON.parse(execFileSync("npx", ["xanosdk", "routes", "./xano/index.ts", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).routes;
const pathOf = (verb, name) => {
  const route = routes.find((r) => r.verb === verb && r.ref.split("/").slice(1).join("/") === name);
  if (!route) throw new Error(`No route ${verb} ${name}`);
  return route.path;
};
const raw = async (verb, path, token, body) => {
  const res = await fetch(backend + path, { method: verb, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const http = async (verb, path, token, body) => {
  const r = await raw(verb, path, token, body);
  if (r.status >= 400) throw new Error(`${verb} ${path}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};

const signIn = async (persona) => (await http("POST", pathOf("POST", "auth/demo"), null, { persona })).authToken;
// The seeded people: the first is the admin, the members follow (xano/app.ts).
const personas = (await http("GET", pathOf("GET", "auth/demo/personas"))).map((p) => p.key);
const [adminKey, ...memberKeys] = ["jordan", "sam", "priya"];
check(memberKeys.every((k) => personas.includes(k)) && personas.includes(adminKey), "the demo people are seeded", personas.join(", "));
const admin = await signIn(adminKey);
const members = await Promise.all(memberKeys.map(signIn));
const me = async (token) => (await http("GET", pathOf("GET", "auth/me"), token)).id;
const memberIds = await Promise.all(members.map(me));

const tag = Date.now().toString(36);
// A cheap text call: about $0.003 with the seeded prices.
const step = (n = 1000) => ({ kind: "text", model: "gemini-3.5-flash-lite", input: { prompt: "Spend check" }, options: { input_tokens: n, output_tokens: n } });
const startRun = (token, clientId, steps = [step()]) => raw("POST", pathOf("POST", "runs"), token, { client_id: clientId, title: "Spend check", private: true, steps });
const budgets = () => http("GET", pathOf("GET", "budgets"), admin);
const teamRow = (b) => b.rows.find((r) => r.scope === "team");
const personRows = (b, id) => b.rows.filter((r) => r.scope === "person" && r.subject_id === id);

// 1. One month row per subject, however many first requests race for it.
const before = await budgets();
const teamWasOpen = !!teamRow(before);
let fresh = memberIds.findIndex((id) => personRows(before, id).length === 0);
if (fresh < 0) {
  // The demo world has spent this month, so every seeded member has a row: invite a new member, who has none.
  const invite = await http("POST", pathOf("POST", "auth/invites"), admin, { email: `spend-${tag}@spend-check.example`, name: "Spend Check", role: "member" });
  const joined = await http("POST", pathOf("POST", "auth/link/accept"), null, { token: invite.token, name: "Spend Check", password: `Spend-check-${tag}-1` });
  members.push(joined.authToken);
  memberIds.push(joined.user_id);
  fresh = members.length - 1;
  console.log("· every seeded member already has a row this month, so a new member was invited for check 1");
}
{
  const opened = await Promise.all(Array.from({ length: 4 }, (_, i) => startRun(members[fresh], `${tag}-open-${i}`)));
  check(opened.every((r) => r.status === 200), "four first runs at once all answer", opened.map((r) => r.status).join(", "));
  const after = await budgets();
  check(personRows(after, memberIds[fresh]).length === 1, "they opened one budget row for the person, not several", `${personRows(after, memberIds[fresh]).length} row(s)`);
  if (teamWasOpen) console.log("! the team's row was already open this month, so only the person's row was raced");
  else check(after.rows.filter((r) => r.scope === "team").length === 1, "and one row for the team", `${after.rows.filter((r) => r.scope === "team").length} row(s)`);
}

// 2. Two runs that each fit, but not together: exactly one reserves.
const probe = await startRun(members[0], `${tag}-probe`);
const estimate = probe.json?.run?.estimate ?? 0;
check(probe.status === 200 && estimate > 0, "a run's estimate comes back", `${estimate} micro-dollars`);
const start = await budgets();
const team = teamRow(start);
const originalBudget = start.team_budget;
// Leave room for one and a half runs.
const squeezed = team.budget - team.headroom + Math.floor(estimate * 1.5);
await http("PATCH", pathOf("PATCH", "budgets"), admin, { team_budget: originalBudget + (squeezed - team.budget), person_budget: -1, approval_line: -1 });
try {
  const squeeze = await budgets();
  check(teamRow(squeeze).headroom >= estimate && teamRow(squeeze).headroom < 2 * estimate, "the team has room for one run, not two", `${teamRow(squeeze).headroom} left`);
  const raced = await Promise.all(Array.from({ length: 6 }, (_, i) => startRun(members[i % members.length], `${tag}-race-${i}`)));
  const statuses = raced.map((r) => r.json?.run?.status);
  // A single text step runs inside the request, so the one that fits may already be done. What matters is that only one got in.
  check(statuses.filter((s) => s !== "refused").length === 1, "six at once: exactly one reserved", statuses.join(", "));
  check(statuses.filter((s) => s === "refused").length === 5, "the other five were refused for the team's budget", raced.find((r) => r.json?.run?.status === "refused")?.json?.run?.detail ?? "");
  const after = await budgets();
  const committed = (r) => r.reserved + r.spent;
  const grew = committed(teamRow(after)) - committed(teamRow(squeeze));
  check(grew > 0 && grew <= estimate, "the team's committed spend grew by one run at most", `${grew} (estimate ${estimate})`);
  check(teamRow(after).headroom === teamRow(after).budget - teamRow(after).reserved - teamRow(after).spent, "what's left is budget − reserved − spent");
} finally {
  await http("PATCH", pathOf("PATCH", "budgets"), admin, { team_budget: originalBudget, person_budget: -1, approval_line: -1 });
}

// 3. One request sent five times at once is one run.
const same = await Promise.all(Array.from({ length: 5 }, () => startRun(members[0], `${tag}-dup`)));
const ids = new Set(same.map((r) => r.json?.run?.id));
check(same.every((r) => r.status === 200) && ids.size === 1, "five copies at once are one run", [...ids].join(", "));
check(same.filter((r) => r.json?.outcome === "created").length === 1, "and exactly one of them created it", same.map((r) => r.json?.outcome).join(", "));

// 4. The same key with a different request is refused.
const other = await startRun(members[0], `${tag}-dup`, [step(2000)]);
check(other.status === 409, "the same client_id with a different request is 409", String(other.status));

console.log(errors.length ? `✗ spend-check: ${errors.length} failed` : "✓ spend-check: all passed");
process.exit(errors.length ? 1 : 0);
