#!/usr/bin/env node
// Easel, for real, against a deployed backend with a model key set (AGENT_PROVIDER and its key in xano/.env).
//   1. Easel says which model it runs on. With no key it answers "The assistant needs a model key" and the setup step,
//      and the check stops there.
//   2. An approved picture is in the Library (made once with the cheapest image model, then reused).
//   3. A member asks Easel for a 6 second video from it: Easel finds the approved picture, and the video waits for an
//      admin's approval with its estimate, from that picture, charged nothing yet. The reply carries the run for the card.
//   Nothing is approved: no video is made. (A member's video always waits for an admin, whatever length Easel picks, so
//   the check can't start one. An admin's own short clip could start under the approval line, so it doesn't ask as one.)
//
//   node frontend/scripts/assistant-check.mjs --backend <url>
//
// Easel's own turns are billed by the model provider (one or two turns). Xano AI spend: one small image the first time,
// about $0.04, billed to whoever the deploy signed in to Xano AI as.
//
// Exit 0 = pass, 1 = a check failed, 2 = usage.
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const backend = opt("backend")?.replace(/\/$/, "");
if (!backend) { console.error("usage: assistant-check.mjs --backend <url>"); process.exit(2); }

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
const call = async (verb, path, token, body) => {
  const h = token ? { authorization: `Bearer ${token}` } : {};
  if (body) h["content-type"] = "application/json";
  const res = await fetch(backend + path, { method: verb, headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(300_000) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const signIn = async (persona) => {
  const t = (await call("POST", pathOf("POST", "auth/demo"), null, { persona })).json?.authToken;
  if (!t) { console.error(`✗ couldn't sign in as ${persona}`); process.exit(1); }
  return t;
};
let turns = 0;
/** One message to Easel in a new conversation. */
const askEasel = async (token, content) => {
  const conv = await call("POST", pathOf("POST", "chat/conversations/create"), token, {});
  turns++;
  const started = Date.now();
  const sent = await call("POST", pathOf("POST", "chat/conversations/{conversation_id}/send", { conversation_id: conv.json?.id }), token, { content });
  return { ...sent, ms: Date.now() - started };
};
const PICTURE = "City 3 commute";

const admin = await signIn("jordan");
const member = await signIn("sam");

console.log("\n1. Easel's model");
const easel = (await call("GET", pathOf("GET", "easel"), member)).json;
check(!!easel, "GET studio/easel answers", easel ? `${easel.provider} · ${easel.label}` : "");
if (!easel?.ready) {
  const r = await askEasel(member, "Hello");
  check(r.status === 200 && /needs a model key/.test(r.json?.reply ?? ""), "with no key, Easel answers with the setup step", (r.json?.reply ?? "").slice(0, 160));
  check((r.json?.tool_calls ?? []).length === 0, "and calls nothing");
  console.log(errors.length ? `\n✗ ${errors.length} failed` : "\n✓ no model key: Easel says what to set up. Set AGENT_PROVIDER and its key to run the rest.");
  process.exit(errors.length ? 1 : 0);
}

console.log("\n2. An approved picture in the Library");
let found = (await call("GET", pathOf("GET", "assets") + `?kind=image&approved_only=true&q=${encodeURIComponent(PICTURE)}`, admin)).json?.items?.[0];
if (found) check(true, "already there", `#${found.id}`);
else {
  const made = await call("POST", pathOf("POST", "runs"), admin, {
    client_id: crypto.randomUUID(), kind: "image", model: "gemini-3.1-flash-lite-image", title: PICTURE, private: true,
    input: { prompt: "A commuter riding a dark green city bike along a wet morning street, photographed from the side.", use_brand: false }, options: { size: "1K", samples: 1 },
  });
  const step = made.json?.steps?.[0];
  check(made.json?.run?.status === "done", "a small image is made", `${made.json?.run?.status} · $${((made.json?.run?.spent ?? 0) / 1e6).toFixed(4)}`);
  const used = step ? await call("POST", pathOf("POST", "playground/steps/{id}/use", { id: step.id }), admin) : null;
  const id = used?.json?.asset_id;
  const approved = id ? await call("POST", pathOf("POST", "assets/{id}/approve", { id }), admin) : null;
  check(approved?.json?.status === "approved", "kept in the Library and approved", `#${id}`);
  found = { id };
}
if (!found?.id) { console.log(`\n✗ no picture to start from`); process.exit(1); }

const VIDEO_ASK = `Find the approved "${PICTURE}" photo in the Library and make a 6 second 9:16 video from it, with sound, for Instagram.`;
/** The run the reply names for its card, and the run itself. */
const runOf = async (token, reply) => {
  const id = Number((reply.match(/\brun_id:\s*`?(\d+)/) ?? [])[1] ?? 0);
  return id ? { id, view: (await call("GET", pathOf("GET", "runs/{id}", { id }), token)).json } : { id: 0, view: null };
};

console.log("\n3. A member asks Easel for a video from it");
const asked = await askEasel(member, VIDEO_ASK);
const reply = asked.json?.reply ?? "";
const tools = asked.json?.tool_calls ?? [];
check(asked.status === 200, "Easel answers", `${asked.ms} ms · tools: ${tools.join(", ")}`);
check(tools.includes("search_library"), "it looked in the Library");
check(tools.includes("make_output"), "and asked for the video");
const memberRun = await runOf(member, reply);
check(memberRun.id > 0, "the reply names the run for the card", `run ${memberRun.id}`);
const mv = memberRun.view;
check(mv?.run?.status === "waiting_approval", "the video waits for an admin's approval", mv?.run?.detail ?? "");
check(mv?.run?.via === "easel" && mv?.run?.approval_id > 0, "asked by Easel, with an approval request", `approval ${mv?.run?.approval_id}`);
check((mv?.run?.estimate ?? 0) > 0 && (mv?.run?.spent ?? -1) === 0, "with its estimate, and nothing charged", `about $${((mv?.run?.estimate ?? 0) / 1e6).toFixed(2)}`);
const vstep = mv?.steps?.[0];
check(vstep?.kind === "video" && Number(vstep?.input?.from_asset) === Number(found.id), "a video from the approved picture", `${vstep?.model} · ${vstep?.options?.seconds} s · from #${vstep?.input?.from_asset}`);
check(/approv/i.test(reply), "and the reply says it waits for approval", reply.replace(/\s+/g, " ").slice(0, 220));

console.log(`\nEasel turns: ${turns}`);
console.log(errors.length ? `✗ ${errors.length} failed: ${errors.join("; ")}` : "✓ Easel finds approved work and asks a person before it spends on video");
process.exit(errors.length ? 1 : 0);
