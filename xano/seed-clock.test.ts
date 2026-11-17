// @vitest-environment node
// The demo's clock: whatever the moment and the zone a deploy runs in, what the team did lands in working hours, in order, in
// the past, and the same deploy moment always gives the same times. The seeded world is checked against it too.
import { describe, expect, it } from "vitest";
import { TODAY_REACH_MINUTES, WORK_ENDS, WORK_STARTS, deployZone, partsIn, seedClock } from "./seed-clock";
import { SAMPLE_RUN, SEED_ACTIVITY, SEED_APPROVALS, SEED_ASSETS, SEED_CLOCK, SEED_KB_SOURCES, SEED_LEDGER, SEED_EASEL_TURNS, SEED_RUNS, SEED_STEPS } from "./world";

const ZONES = ["America/Los_Angeles", "Europe/London", "Australia/Sydney", "Asia/Kolkata", "UTC"];
const HOUR = 3_600_000;
const minutes = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const working = (ms: number, zone: string) => {
  const p = partsIn(ms, zone);
  const at = p.hour * 60 + p.minute;
  return p.weekday >= 1 && p.weekday <= 5 && at >= minutes(WORK_STARTS) && at <= minutes(WORK_ENDS);
};
// Every hour of a week that crosses a clock change in Europe and the US, and one in the southern summer.
const MOMENTS = [Date.UTC(2026, 9, 22, 0, 7), Date.UTC(2026, 10, 9, 0, 7), Date.UTC(2027, 0, 11, 0, 7)].flatMap((start) => Array.from({ length: 24 * 8 }, (_, h) => start + h * HOUR));

describe("the seed clock", () => {
  it("puts every stamp in working hours, in the past, on the day it names", () => {
    for (const zone of ZONES) {
      for (const now of MOMENTS) {
        const clock = seedClock(now, zone);
        for (const [days, hhmm] of [[1, "09:00"], [1, "18:00"], [3, "09:40"], [10, "16:20"]] as const) {
          const when = clock.at(days, hhmm);
          const p = partsIn(when, zone);
          expect(working(when, zone), `${zone} ${new Date(now).toISOString()} ${days} ${hhmm}`).toBe(true);
          expect(`${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`).toBe(hhmm);
          expect(when).toBeLessThan(now);
        }
        for (const back of [0, 60, TODAY_REACH_MINUTES]) {
          const when = clock.today(back);
          expect(working(when, zone), `${zone} ${new Date(now).toISOString()} today -${back}`).toBe(true);
          expect(when).toBeLessThan(now);
        }
        expect(clock.at(1, WORK_ENDS)).toBeLessThan(clock.today(TODAY_REACH_MINUTES));
      }
    }
  });
  it("tells the story as yesterday's before the working day has had enough of itself, and skips the weekend", () => {
    const mondayEarly = Date.UTC(2026, 10, 9, 16, 0); // Monday 08:00 in Los Angeles
    const clock = seedClock(mondayEarly, "America/Los_Angeles");
    expect(partsIn(clock.today(0), "America/Los_Angeles")).toMatchObject({ weekday: 5, hour: 17, minute: 45 });
    expect(partsIn(clock.at(1, "10:00"), "America/Los_Angeles")).toMatchObject({ weekday: 4 });
  });
  it("refuses a stamp it can't place honestly", () => {
    const clock = seedClock(Date.UTC(2026, 10, 10, 23, 0), "UTC");
    expect(() => clock.at(1, "22:00")).toThrow(/outside working hours/);
    expect(() => clock.today(TODAY_REACH_MINUTES + 1)).toThrow();
  });
});

describe("the Marlow world's clock", () => {
  const zone = deployZone();
  const now = Date.now();
  it("runs in the deploy's own zone", () => expect(SEED_CLOCK.zone).toBe(zone));
  it("starts and ends every finished run in working hours, before the deploy, and never in the future", () => {
    for (const r of SEED_RUNS.filter((x) => x.finished_at)) {
      expect(working(r.created_at, zone), `${r.title} at ${new Date(r.created_at).toISOString()}`).toBe(true);
      expect(r.finished_at).toBeGreaterThanOrEqual(r.created_at);
      expect(r.finished_at).toBeLessThanOrEqual(now);
    }
    for (const r of SEED_RUNS) expect(r.created_at, r.title).toBeLessThanOrEqual(now);
  });
  it("keeps every stamp in the past: steps, items, charges, sources, approvals, Easel's turns and the feed", () => {
    for (const st of SEED_STEPS) for (const t of [st.claimed_at, st.sent_at, st.finished_at]) if (t) expect(t).toBeLessThanOrEqual(now);
    for (const rows of [SEED_ASSETS, SEED_LEDGER, SEED_KB_SOURCES, SEED_APPROVALS, SEED_EASEL_TURNS, SEED_ACTIVITY]) for (const row of rows as { created_at: number }[]) expect(row.created_at).toBeLessThanOrEqual(now);
    for (const s of SEED_KB_SOURCES) expect(working(s.created_at, zone), s.title).toBe(true);
  });
  it("orders each run's work: steps after the run starts, items after their step", () => {
    for (const st of SEED_STEPS) if (st.claimed_at) expect(st.claimed_at).toBeGreaterThanOrEqual(SEED_RUNS[st.run_id - 1].created_at);
    for (const a of SEED_ASSETS) expect(a.created_at).toBeGreaterThanOrEqual(SEED_RUNS[a.run_id - 1].created_at);
    for (const a of SEED_APPROVALS) expect(a.created_at).toBeGreaterThan(SEED_RUNS[a.payload.run_id - 1].created_at);
  });
  it("starts the sample run a moment before the deploy, so Home shows it running", () => {
    const sample = SEED_RUNS[SAMPLE_RUN - 1];
    expect(now - sample.created_at).toBeGreaterThan(0);
    expect(now - sample.created_at).toBeLessThan(5 * 60_000);
  });
});
