// @vitest-environment node
// The Marlow world holds together: the money adds up to what Home and Usage show, every library item points at the run and
// step that made it, every file is kept in a table and small, Knowledge has a vector for every passage, the waiting runs are in
// Jordan's approvals, the sample run ends with no model call, and the production entry ships none of it. A workflow test
// starts with an empty database, so the seed itself is checked here.
import { describe, expect, it } from "vitest";
import { DEMO_PEOPLE } from "./app";
import { KB_WORDS } from "./function/knowledge/absorb";
import { PAID_STORAGE_KINDS } from "./function/runs/start";
import { KB_DIMENSIONS } from "./table/knowledge/kb_passage";
import { price } from "./table/studio/price";
import {
  ALEX, FREE_PLAN_RECIPE, JORDAN, LAUNCH_KIT, SAM, SAMPLE_RUN, SEED_APPROVALS, SEED_ASSETS, SEED_BRAND, SEED_BRAND_IMAGES, SEED_KB_SOURCES, SEED_LEDGER, SEED_MEDIA,
  SEED_MONTHS, SEED_EASEL_TURNS, SEED_NOTIFICATIONS, SEED_PASSAGES, SEED_RECIPES, SEED_RECIPE_STEPS, SEED_RUNS, SEED_STEPS, homeSpend, monthOf,
} from "./world";

const KB = 1024;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const settled = SEED_LEDGER.filter((l) => l.state === "settled");
const thisMonth = new Date().toISOString().slice(0, 7);

describe("the money", () => {
  it("adds up to Home's spend: the team's counter this month is the sum of this month's charges", () => {
    const team = SEED_MONTHS.findIndex((m) => m.scope === "team" && m.month === thisMonth) + 1;
    const charged = sum(settled.filter((l) => monthOf(l.created_at) === thisMonth).map((l) => l.amount));
    expect(charged).toBeGreaterThan(0);
    expect(sum(settled.filter((l) => l.team_month_id === team).map((l) => l.amount))).toBe(charged);
    expect(homeSpend()).toBe(charged);
  });
  it("keeps every month counter equal to the charges counted against it, with nothing held", () => {
    SEED_MONTHS.forEach((m, i) => {
      const counted = settled.filter((l) => (m.scope === "team" ? l.team_month_id : l.person_month_id) === i + 1);
      expect(m.spent, `${m.scope} ${m.subject_id} ${m.month}`).toBe(sum(counted.map((l) => l.amount)));
      expect(m.reserved).toBe(0);
      expect(m.headroom).toBe(m.budget - m.spent);
    });
    for (const l of SEED_LEDGER) {
      expect(SEED_MONTHS[l.team_month_id - 1]).toMatchObject({ scope: "team", subject_id: 0, month: monthOf(l.created_at) });
      expect(SEED_MONTHS[l.person_month_id - 1]).toMatchObject({ scope: "person", subject_id: l.owner_id, month: monthOf(l.created_at) });
      expect(l.held).toBe(0);
    }
  });
  it("charges each run what its steps were charged, and holds one ledger row per step that reached a model", () => {
    SEED_RUNS.forEach((r, i) => {
      const rows = SEED_LEDGER.filter((l) => l.run_id === i + 1);
      expect(r.spent, r.title).toBe(sum(rows.filter((l) => l.state === "settled").map((l) => l.amount)));
      for (const l of rows) {
        const step = SEED_STEPS[l.step_id - 1];
        expect(step.run_id).toBe(i + 1);
        if (l.state === "settled") expect(step.charged).toBe(l.amount);
        expect(step.sent_at === null).toBe(l.state === "released");
      }
    });
    const reachedModel = SEED_STEPS.filter((st) => ["succeeded", "blocked", "failed", "timed_out"].includes(st.status));
    expect(settled.map((l) => l.step_id).sort((a, b) => a - b)).toEqual(reachedModel.map((st) => SEED_STEPS.indexOf(st) + 1));
  });
  it("charges a timed-out video in full, and a declined or waiting run nothing", () => {
    const timedOut = SEED_STEPS.find((st) => st.status === "timed_out")!;
    expect(timedOut).toMatchObject({ kind: "video", reason: "timeout" });
    expect(timedOut.charged).toBe(timedOut.estimate);
    for (const r of SEED_RUNS.filter((r) => ["declined", "waiting_approval"].includes(r.status))) expect(r.spent, r.title).toBe(0);
  });
  it("starts every budget at the defaults Usage edits", () => {
    for (const m of SEED_MONTHS) expect(m.budget).toBe(m.scope === "team" ? 100_000_000 : 25_000_000);
    for (let p = 1; p <= DEMO_PEOPLE.length; p++) expect(SEED_MONTHS.some((m) => m.scope === "person" && m.subject_id === p && m.month === thisMonth)).toBe(true);
  });
});

describe("the runs", () => {
  it("are about forty, over two weeks, in every state the app shows", () => {
    expect(SEED_RUNS.length).toBeGreaterThanOrEqual(36);
    expect(SEED_RUNS.length).toBeLessThanOrEqual(44);
    const states = new Set(SEED_RUNS.map((r) => r.status));
    for (const s of ["done", "partial", "failed", "waiting_approval", "declined", "running"]) expect(states, s).toContain(s);
    const oldest = Math.min(...SEED_RUNS.map((r) => r.created_at));
    expect(Date.now() - oldest).toBeLessThan(16 * 86_400_000);
    expect(Date.now() - oldest).toBeGreaterThan(9 * 86_400_000);
  });
  it("number their steps from 1 and point each step at an earlier one it needs", () => {
    SEED_RUNS.forEach((r, i) => {
      const steps = SEED_STEPS.filter((st) => st.run_id === i + 1);
      expect(steps.length, r.title).toBeGreaterThan(0);
      expect(steps.map((st) => st.seq)).toEqual(steps.map((_, k) => k + 1));
      for (const st of steps) for (const d of st.depends_on) expect(d).toBeLessThan(st.seq);
      if (r.recipe_id) expect(r.recipe_id).toBeLessThanOrEqual(SEED_RECIPES.length);
    });
  });
  it("include the launch kit that ended partial: the video timed out, and the voiceover and music still ran", () => {
    const kit = SEED_RUNS.findIndex((r) => r.status === "partial" && r.title.startsWith(LAUNCH_KIT)) + 1;
    expect(SEED_STEPS.filter((st) => st.run_id === kit).map((st) => [st.kind, st.status])).toEqual([
      ["text", "succeeded"], ["image", "succeeded"], ["video", "timed_out"], ["speech", "succeeded"], ["music", "succeeded"],
    ]);
  });
});

describe("the sample run", () => {
  const sample = SEED_RUNS[SAMPLE_RUN - 1];
  const steps = SEED_STEPS.filter((st) => st.run_id === SAMPLE_RUN);
  it("is the one running run, started a moment before the deploy, with nothing reserved or charged", () => {
    expect(SEED_RUNS.filter((r) => r.sample)).toEqual([sample]);
    expect(SEED_RUNS.filter((r) => r.status === "running")).toEqual([sample]);
    expect(sample).toMatchObject({ owner_id: JORDAN, status: "running", spent: 0, base_url: "", is_demo: true });
    expect(Date.now() - sample.created_at).toBeLessThan(5 * 60_000);
    expect(SEED_LEDGER.filter((l) => l.run_id === SAMPLE_RUN)).toEqual([]);
  });
  it("carries the clip it ends with, already kept, so finishing it calls no model", () => {
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "video", status: "working", charged: 0, output: {} });
    const made = steps[0].input.sample_output as { file: { mode: string; blob_id: number } };
    expect(made.file.mode).toBe("table");
    expect(SEED_MEDIA[made.file.blob_id - 1]).toMatchObject({ mime: "video/mp4", run_id: SAMPLE_RUN, step_id: SEED_STEPS.indexOf(steps[0]) + 1 });
    expect(SEED_ASSETS.some((a) => a.run_id === SAMPLE_RUN)).toBe(false);
  });
  it("names the still it was made from, so the clip's tile shows that picture as its poster", () => {
    const from = steps[0].input.from_asset as number;
    expect(SEED_ASSETS[from - 1]).toMatchObject({ kind: "image", title: "Coast road at dusk", maker_id: JORDAN });
  });
});

describe("the library", () => {
  it("holds about thirty items, some approved, each pointing at the step that made it", () => {
    expect(SEED_ASSETS.length).toBeGreaterThanOrEqual(26);
    expect(SEED_ASSETS.length).toBeLessThanOrEqual(34);
    expect(SEED_ASSETS.filter((a) => a.status === "approved").length).toBeGreaterThanOrEqual(8);
    SEED_ASSETS.forEach((a, i) => {
      const step = SEED_STEPS[a.step_id - 1];
      expect(SEED_RUNS[a.run_id - 1], a.title).toBeDefined();
      expect(step.run_id).toBe(a.run_id);
      expect(step.status).toBe("succeeded");
      expect(step.asset_id).toBe(i + 1);
      expect(a.estimated_cost).toBe(step.charged);
      expect(a.maker_id).toBe(SEED_RUNS[a.run_id - 1].owner_id);
      if (a.status === "approved") expect(a.approved_by).toBeGreaterThan(0);
    });
  });
  it("has an approved City 3 photo for the assistant to find", () => {
    expect(SEED_ASSETS.find((a) => a.kind === "image" && a.title.includes("City 3") && a.status === "approved" && !a.private)).toBeDefined();
  });
});

describe("the files", () => {
  it("are all kept in a table, so they show on a server that can't sign links and never land in a public bucket", () => {
    const held = [...SEED_ASSETS.map((a) => a.file), ...SEED_STEPS.map((st) => st.output?.file), ...SEED_KB_SOURCES.map((s) => s.audio)].filter(Boolean);
    expect(held.length).toBeGreaterThan(10);
    for (const f of held) {
      expect(f.mode).toBe("table");
      expect(f.path).toBeUndefined();
      expect(SEED_MEDIA[f.blob_id - 1]).toMatchObject({ name: f.name, mime: f.mime, size: f.size });
    }
  });
  it("stay inside the media budget: images under 200 KB, recordings under 400 KB, the clip under 1.5 MB, about 6 MB in all", () => {
    for (const m of SEED_MEDIA) {
      const most = m.mime.startsWith("image/") ? 200 * KB : m.mime.startsWith("audio/") ? 400 * KB : 1.5 * KB * KB;
      expect(m.size, m.name).toBeLessThanOrEqual(most);
      expect(Buffer.from(m.b64, "base64").length).toBe(m.size);
    }
    const total = sum(SEED_MEDIA.map((m) => m.size)) + sum(SEED_BRAND_IMAGES.map((i) => i.size));
    expect(total).toBeLessThan(6 * KB * KB);
  });
});

describe("knowledge", () => {
  it("has a vector for every passage, so it answers on a deploy with no AI", () => {
    expect(SEED_PASSAGES.length).toBeGreaterThan(20);
    for (const p of SEED_PASSAGES) {
      expect(p.embedding, p.text.slice(0, 40)).toHaveLength(KB_DIMENSIONS);
      expect(p.live).toBe(true);
    }
  });
  it("holds six to ten sources, recordings that play from a cited moment, and a scan that failed in words", () => {
    expect(SEED_KB_SOURCES.length).toBeGreaterThanOrEqual(6);
    expect(SEED_KB_SOURCES.length).toBeLessThanOrEqual(10);
    SEED_KB_SOURCES.forEach((s, i) => {
      const passages = SEED_PASSAGES.filter((p) => p.source_id === i + 1);
      expect(s.passages, s.title).toBe(passages.length);
      if (s.status === "ready") expect(SEED_RUNS[s.run_id - 1]).toMatchObject({ kind: "ingest", owner_id: s.added_by, status: "done" });
    });
    const recordings = SEED_KB_SOURCES.filter((s) => s.kind === "recording");
    expect(recordings.length).toBeGreaterThanOrEqual(2);
    for (const r of recordings) {
      const id = SEED_KB_SOURCES.indexOf(r) + 1;
      expect(SEED_MEDIA[r.audio.blob_id - 1].source_id).toBe(id);
      expect(SEED_PASSAGES.filter((p) => p.source_id === id).every((p) => p.start_s >= 0 && p.speaker)).toBe(true);
    }
    expect(SEED_KB_SOURCES.find((s) => s.title === "Warranty terms 2027")).toMatchObject({ status: "failed", detail: KB_WORDS.scan, passages: 0, run_id: 0 });
  });
  it("keeps past questions the way Ask stores them, citing only passages each was given, for each demo person who signs in", () => {
    const asks = SEED_RUNS.map((r, i) => ({ r, id: i + 1 })).filter(({ r }) => r.kind === "ask");
    for (const { r, id } of asks) {
      const answer = SEED_STEPS.find((s) => s.run_id === id && s.seq === 3);
      expect(r.private, r.title).toBe(true);
      expect(`Ask: ${answer.input.question}`).toBe(r.title);
      const given: number[] = answer.input.kb_passages;
      expect(given.length, r.title).toBeGreaterThan(0);
      for (const pid of given) expect(SEED_PASSAGES[pid - 1], r.title).toBeDefined();
      const cited: number[] = answer.output.json.cited;
      expect(cited.length, r.title).toBeGreaterThan(0);
      expect(cited.every((n) => n >= 1 && n <= given.length), r.title).toBe(true);
      expect(answer.output.json.answer).toBe(answer.output.text);
    }
    for (const person of [JORDAN, SAM, ALEX]) expect(asks.some(({ r }) => r.owner_id === person), `person ${person}`).toBe(true);
  });
  it("answers the seeded question about Trail 2 sizing from a call and the spec sheet", () => {
    const sizing = SEED_PASSAGES.filter((p) => /take the medium|rides long/i.test(p.text)).map((p) => SEED_KB_SOURCES[p.source_id - 1].title);
    expect(sizing).toEqual(expect.arrayContaining(["Customer call: Halden Cycles", "Trail 2 spec sheet"]));
  });
});

describe("recipes", () => {
  it("are the team's nine, published, with the launch kit's five steps in order", () => {
    expect(SEED_RECIPES).toHaveLength(9);
    for (const r of SEED_RECIPES) expect(r).toMatchObject({ status: "published", is_demo: true });
    const kit = SEED_RECIPES.findIndex((r) => r.name === LAUNCH_KIT) + 1;
    const steps = SEED_RECIPE_STEPS.filter((st) => st.recipe_id === kit);
    expect(steps.map((st) => st.kind)).toEqual(["text", "image", "video", "speech", "music"]);
    expect(steps[2].options).toMatchObject({ seconds: 8 });
    expect(steps[2].depends_on).toEqual([2]);
    expect(steps[3].depends_on).toEqual([1]);
  });
  it("include one that runs on a plan without paid storage: text and image only", () => {
    const free = SEED_RECIPES.findIndex((r) => r.name === FREE_PLAN_RECIPE) + 1;
    const kinds = SEED_RECIPE_STEPS.filter((st) => st.recipe_id === free).map((st) => st.kind);
    expect(kinds).toEqual(["text", "image"]);
    for (const k of kinds) expect(PAID_STORAGE_KINDS as readonly string[]).not.toContain(k);
  });
  it("estimate a run at every input's longest, and the launch kit above the approval line", () => {
    const kit = SEED_RECIPES.find((r) => r.name === LAUNCH_KIT)!;
    expect(kit.estimate).toBeGreaterThan(500_000);
    for (const r of SEED_RECIPES) expect(r.estimate, r.name).toBeGreaterThan(0);
  });
});

describe("approvals, notifications and the brand kit", () => {
  it("leave two runs waiting for Jordan, each in his notifications", () => {
    const pending = SEED_APPROVALS.filter((a) => a.status === "pending");
    expect(pending).toHaveLength(2);
    for (const a of pending) {
      const r = SEED_RUNS[a.payload.run_id - 1];
      expect(r).toMatchObject({ status: "waiting_approval", owner_id: a.user_id, approval_id: SEED_APPROVALS.indexOf(a) + 1 });
      expect(a).toMatchObject({ action: "costly_run", approver_roles: ",admin," });
      expect(a.expires_at).toBeGreaterThan(Date.now());
      expect(SEED_NOTIFICATIONS.some((n) => n.user_id === JORDAN && n.kind === "approval" && n.title === a.title && !n.read_at)).toBe(true);
    }
    for (const a of SEED_APPROVALS.filter((x) => x.status !== "pending")) expect(a.decided_by).toBe(JORDAN);
  });
  it("fill the brand kit: voice, words to avoid, look, sound, colours and two reference images", () => {
    expect(SEED_BRAND).toHaveLength(1);
    expect(SEED_BRAND[0]).toMatchObject({ default_voice: "Kore", music_style: expect.stringContaining("Warm indie") });
    expect(SEED_BRAND[0].avoid_words).toContain("game-changer");
    for (const c of SEED_BRAND[0].colours) expect(c.hex).toMatch(/^#[0-9A-F]{6}$/);
    expect(SEED_BRAND_IMAGES.length).toBeGreaterThanOrEqual(1);
    expect(SEED_BRAND_IMAGES.length).toBeLessThanOrEqual(3);
  });
  it("record Easel's own turns as provider-billed, apart from the ledger", () => {
    expect(SEED_EASEL_TURNS.length).toBeGreaterThan(0);
    for (const t of SEED_EASEL_TURNS) expect(t).toMatchObject({ provider: "anthropic", status: "done" });
    expect(SEED_LEDGER.every((l) => l.via !== "easel" || SEED_RUNS[l.run_id - 1].via === "easel")).toBe(true);
  });
});

describe("the production entry", () => {
  it("ships no demo rows: no people, no settings row, no content, only the price table", async () => {
    const demo = (await import("./index")).default;
    const seeded = demo.tables().filter((t) => Array.isArray(t.seed) && t.seed.length > 0).map((t) => t.name);
    expect(seeded).toEqual(expect.arrayContaining(["user", "workspace_setting", "demo_persona", "ai_run", "asset", "kb_passage", "media_blob", "approval"]));
    const production = (await import("./production")).default;
    const left = production.tables().filter((t) => typeof t.seed === "function" || (Array.isArray(t.seed) && t.seed.length > 0)).map((t) => t.name);
    expect(left).toEqual([price.name]);
  });
});
