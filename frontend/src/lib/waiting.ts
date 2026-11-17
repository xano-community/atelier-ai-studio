// What waits on a person, in words: how long something has waited, and what an approval request is about.

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

/** How long something has waited, as a person would say it: "just now", "40 min", "3 hours", "1 day", "5 days", "3 weeks". */
export function ageWords(since: number, now = Date.now()): string {
  const ms = Math.max(0, now - since);
  if (ms < MINUTE) return "just now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`;
  if (ms < DAY) { const h = Math.floor(ms / HOUR); return `${h} ${h === 1 ? "hour" : "hours"}`; }
  const d = Math.floor(ms / DAY);
  if (d < 14) return `${d} ${d === 1 ? "day" : "days"}`;
  return `${Math.floor(d / 7)} weeks`;
}

/**
 * A run's approval request, from the line it was asked with ("Run Rack fitting clip for the City 3, estimated at $0.70"):
 * the run's name and its estimate. A request that isn't about a run keeps its line, with no cost.
 */
export function requestWords(title: string): { name: string; cost: string } {
  const m = /^Run (.+), estimated at (\$[\d,.]+)$/.exec(title.trim());
  return m ? { name: m[1], cost: m[2] } : { name: title.trim(), cost: "" };
}

/** The one sentence every request in a list shares (the policy that put them there), said once above it; or "". */
export function sharedNote(items: { preview?: string | null; editable_field?: string | null }[]): string {
  const first = items[0]?.preview?.trim() ?? "";
  if (!first || items.some((a) => !!a.editable_field)) return "";
  return items.every((a) => (a.preview ?? "").trim() === first) ? first : "";
}
