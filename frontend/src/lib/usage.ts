// Home, Usage, budgets, prices and "Check again": paths from xano/routes.gen.ts, types from the defs (import type only),
// every call through `request()`. The arithmetic the screens show lives here, beside its tests.
import type { InferResponse } from "@xano/sdk";
import type { homeRoute, usageRoute, raiseBudgetRoute, checkAiRoute } from "../../../xano/query/usage.js";
import type { budgetsRoute, personBudgetRoute, updateBudgetsRoute } from "../../../xano/query/studio.js";
import type { listPricesRoute, setPriceRoute } from "../../../xano/query/settings.js";
import { routePath } from "../../../xano/routes.gen.js";
import { qs, request } from "@/base/request";

export type Home = InferResponse<typeof homeRoute>;
export type HomeRun = Home["running"][number];
export type HomeStep = Home["steps"][number];
export type Usage = InferResponse<typeof usageRoute>;
export type Budgets = InferResponse<typeof budgetsRoute>;
export type MonthRow = Budgets["rows"][number];
export type Limits = InferResponse<typeof updateBudgetsRoute>;
export type Price = InferResponse<typeof listPricesRoute>[number];
export type Checked = InferResponse<typeof checkAiRoute>;

export const usageApi = {
  home: () => request<Home>("GET", routePath("GET home")),
  usage: (month: string) => request<Usage>("GET", routePath("GET usage") + qs({ month })),
  budgets: () => request<Budgets>("GET", routePath("GET budgets")),
  /** Micro-dollars; -1 leaves one as it is. */
  setLimits: (l: { team_budget: number; person_budget: number; approval_line: number }) => request<Limits>("PATCH", routePath("PATCH budgets"), l),
  setPersonBudget: (personId: number, budget: number) => request<InferResponse<typeof personBudgetRoute>>("POST", routePath("POST budgets/people/{id}", { id: personId }), { budget }),
  raiseForRun: (runId: number, budget: number) => request<InferResponse<typeof raiseBudgetRoute>>("POST", routePath("POST runs/{id}/raise-budget", { id: runId }), { budget }),
  prices: () => request<Price[]>("GET", routePath("GET prices")),
  setPrice: (id: number, amount: number) => request<InferResponse<typeof setPriceRoute>>("PATCH", routePath("PATCH prices/{id}", { id }), { amount }),
  checkAi: (clientId: string) => request<Checked>("POST", routePath("POST ai-status/check"), { client_id: clientId }),
  /** The first-run check: what this plan keeps, and how made files are shown here. Admins, once. */
  storageCheck: () => request<{ plan_paid_storage: boolean; file_mode: string; storage_checked: boolean }>("POST", routePath("POST storage-check")),
};

const MICRO = 1_000_000;

/** "$38.40", "$100", "$0.0033": what a budget or a month's spend reads as. Whole dollars drop their cents; under a cent keeps four places. */
export function dollars(micro: number): string {
  const d = Math.max(0, micro) / MICRO;
  if (Number.isInteger(d)) return `$${d.toLocaleString("en-US")}`;
  if (d < 0.0001) return "under $0.0001";
  if (d < 0.01) return `$${d.toFixed(4)}`;
  return `$${d.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** What someone typed as dollars ("25", "$0.50", "1,000") in micro-dollars, or null when it isn't an amount. */
export function parseDollars(text: string): number | null {
  const t = text.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{0,6})?$/.test(t)) return null;
  return Math.round(Number(t) * MICRO);
}

/** How far through a budget: 0 to 100, for a meter. A budget of zero is full as soon as anything is used. */
export const share = (used: number, budget: number) => (budget <= 0 ? (used > 0 ? 100 : 0) : Math.min(100, Math.max(0, (used / budget) * 100)));

/**
 * What to raise a person's budget to so a refused run fits: what they've spent and hold, plus the run's estimate, rounded
 * up to the next whole $5. Null when their budget already covers it (the team's budget refused it, not theirs).
 */
export function raiseTo(row: { budget: number; reserved: number; spent: number }, estimate: number): number | null {
  const needed = row.spent + row.reserved + estimate;
  if (needed <= row.budget) return null;
  const step = 5 * MICRO;
  return Math.ceil(needed / step) * step;
}

/** "2026-10" from "2026-11"; "2025-12" from "2026-01". */
export function monthBefore(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** "November 2026", "November" when `short`. */
export function monthName(month: string, short = false): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString("en-GB", short ? { month: "long", timeZone: "UTC" } : { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The days of a month (UTC), for the chart's x axis. */
export function daysIn(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** One bar per day of the month, from the ledger's day groups; days with nothing are 0. */
export function dailySeries(month: string, byDay: { day: number; amount: number }[]): number[] {
  const out = new Array(daysIn(month)).fill(0) as number[];
  for (const d of byDay) if (d.day >= 1 && d.day <= out.length) out[d.day - 1] += d.amount;
  return out;
}

/** The last seven days' charges, oldest first and ending today, from days counted since 1970 in UTC (Home's spend_days). */
export function weekOfSpend(days: { day: number; amount: number }[], now = Date.now()): number[] {
  const today = Math.floor(now / 86_400_000);
  const out = new Array(7).fill(0) as number[];
  for (const d of days) { const i = d.day - (today - 6); if (i >= 0 && i < 7) out[i] += d.amount; }
  return out;
}

/** A model's name short enough for a row: "Nano Banana 2 (Gemini 3.1 Flash Image)" reads "Nano Banana 2"; the full name goes in a tooltip. */
export const shortModelName = (label: string) => label.replace(/\s*\([^)]*\)\s*$/, "").trim() || label;

/** The days to mark on a month's chart: today (when it's this month) and the busiest day, as indexes; -1 when there's none. */
export function markedDays(series: number[], today: number): { today: number; busiest: number } {
  const most = Math.max(0, ...series);
  return { today: today >= 0 && today < series.length ? today : -1, busiest: most > 0 ? series.indexOf(most) : -1 };
}

/** How many of a kind, in its own unit: "31 clips", "118 images", "1,920 calls". */
export function countWords(kind: string, calls: number): string {
  const n = calls.toLocaleString("en-US");
  const one = calls === 1;
  switch (kind) {
    case "image": return `${n} ${one ? "image" : "images"}`;
    case "video": case "music": return `${n} ${one ? "clip" : "clips"}`;
    case "speech": return `${n} ${one ? "voiceover" : "voiceovers"}`;
    case "transcribe": return `${n} ${one ? "recording" : "recordings"}`;
    default: return `${n} ${one ? "call" : "calls"}`;
  }
}

export const KIND_NAME: Record<string, string> = {
  text: "Text", image: "Image", video: "Video", music: "Music", speech: "Speech", transcribe: "Transcribe", embedding: "Embeddings", rerank: "Rerank",
};

export type PersonLine = {
  id: number; name: string; role: string; amount: number; calls: number;
  budget: number; reserved: number; spent: number; hasRow: boolean;
  /** Spend that came through one of their keys or an agent, under them, with no budget of its own. */
  details: { key: string; label: string; amount: number; calls: number }[];
};

const VIA_WORDS: Record<string, string> = { api: "the recipe API", mcp: "an agent", easel: "Easel" };

/**
 * Usage by person: each person's spend with their budget for the month, and what came through each of their keys or
 * agents as a line under them. People with neither a month row nor any spend are left out, except on this month's view,
 * where everyone is listed so an admin can give anyone a budget of their own.
 */
export function peopleLines(u: Usage, everyone: boolean): PersonLine[] {
  const keyName = new Map(u.keys.map((k) => [k.id, k.name]));
  const lines = new Map<number, PersonLine>();
  for (const p of u.people) {
    const row = u.rows.find((r) => r.subject_id === p.id);
    lines.set(p.id, { id: p.id, name: p.name, role: p.role, amount: 0, calls: 0, budget: row?.budget ?? u.person_budget, reserved: row?.reserved ?? 0, spent: row?.spent ?? 0, hasRow: !!row, details: [] });
  }
  for (const g of u.by_person) {
    const line = lines.get(g.owner_id);
    if (!line) continue;
    line.amount += g.amount;
    line.calls += g.calls;
    if (g.via !== "ui") {
      const name = g.connection_id ? keyName.get(g.connection_id) : undefined;
      const label = name ? `key "${name}"` : `through ${VIA_WORDS[g.via] ?? g.via}`;
      line.details.push({ key: `${g.via}-${g.connection_id}`, label, amount: g.amount, calls: g.calls });
    }
  }
  return [...lines.values()]
    .filter((l) => everyone || l.hasRow || l.amount > 0)
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}

/** The price row's unit in words: "per 1M input tokens", "per image (1K)", "per second (720p, no sound)". */
export function unitWords(p: Pick<Price, "unit" | "variant">): string {
  const v = p.variant;
  switch (p.unit) {
    case "input_token": return v ? `per 1M input tokens (${v})` : "per 1M input tokens";
    case "output_token": return "per 1M output tokens";
    case "image": return v ? `per image (${v})` : "per image";
    case "second": {
      const [res, sound] = v.split("/");
      return v ? `per second (${[res, sound === "audio" ? "with sound" : sound === "silent" ? "no sound" : sound].filter(Boolean).join(", ")})` : "per second";
    }
    case "clip": return "per clip";
    default: return `per ${p.unit.replace(/_/g, " ")}${v ? ` (${v})` : ""}`;
  }
}

const PROVIDER: Record<string, string> = { anthropic: "Anthropic", "google-genai": "Google", "xano-ai": "Xano AI" };
const tokenWords = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000).toLocaleString("en-US")}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString("en-US"));

export type EaselLine = { billedBy: string; turns: number; input: number; output: number; words: string; people: { name: string; turns: number }[] };

/**
 * Easel's own model turns in the month, as one line apart from the budgets: who bills them (the deployer's own provider, not
 * Xano credits), and how many tokens and turns, by person. Null when Easel wasn't used.
 */
export function easelLine(u: Pick<Usage, "easel" | "people">): EaselLine | null {
  if (!u.easel.length) return null;
  const providers = [...new Set(u.easel.map((m) => PROVIDER[m.provider] ?? m.provider))];
  const turns = u.easel.reduce((n, m) => n + m.turns, 0);
  const input = u.easel.reduce((n, m) => n + m.input_tokens, 0);
  const output = u.easel.reduce((n, m) => n + m.output_tokens, 0);
  const name = new Map(u.people.map((p) => [p.id, p.name]));
  const byPerson = new Map<number, number>();
  for (const m of u.easel) byPerson.set(m.user_id, (byPerson.get(m.user_id) ?? 0) + m.turns);
  return {
    billedBy: providers.join("/"), turns, input, output,
    words: `${tokenWords(input)} tokens in, ${tokenWords(output)} out · ${turns.toLocaleString("en-US")} ${turns === 1 ? "turn" : "turns"}`,
    people: [...byPerson].map(([id, n]) => ({ name: name.get(id) ?? "Someone", turns: n })).sort((a, b) => b.turns - a.turns),
  };
}
