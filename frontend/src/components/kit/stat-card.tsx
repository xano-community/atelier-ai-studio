import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowDownRight, ArrowUpRight, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * A small trend line in the chart hue, with a soft area under it. Values are plotted left to right. It's
 * anchored at zero (counts: a week of 9, 10, 9 is flat, not a cliff); `fromZero={false}` for a scale that
 * doesn't start at 0, like a temperature.
 */
export function Sparkline({ values, className, label, fromZero = true }: { values: number[]; className?: string; label?: string; fromZero?: boolean }) {
  if (values.length < 2) return null;
  const w = 120, h = 32, pad = 2;
  const max = Math.max(...values), min = fromZero ? Math.min(0, ...values) : Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [pad + (i * (w - pad * 2)) / (values.length - 1), h - pad - ((v - min) * (h - pad * 2)) / span] as const);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)} ${h} L${pts[0][0].toFixed(1)} ${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={label ?? `Trend: ${values.join(", ")}`}
      className={cn("h-8 w-full text-chart-1", className)}>
      <path d={area} fill="currentColor" opacity={0.12} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * One number that matters, what it means, and where it's heading. `delta` is the change against the
 * previous period, and `delta.label` names that period ("the previous 7 days"): it's read out as "up 6 from
 * the previous 7 days". `delta.short` is a word or two shown after the number ("+7 on last week"). `goodWhen` says which
 * direction is good (so a rising backlog reads as a warning).
 * With `href`, the whole card opens the list behind the number. Cards in a grid row are all one height. `meter` is how
 * full something is (0 to 100), drawn as a thin bar under the number: a month's spend against its budget.
 */
export function StatCard({ label, value, hint, trend, delta, meter, goodWhen = "up", href, loading, className }: {
  label: string; value: ReactNode; hint?: ReactNode; trend?: number[]; meter?: { value: number; label: string };
  delta?: { value: number; label?: string; short?: string }; goodWhen?: "up" | "down"; href?: string; loading?: boolean; className?: string;
}) {
  const body = (
    <>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-0.5 text-body text-muted-foreground">
          <span className="truncate" title={label}>{label}</span>
          {href && <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" />}
        </span>
        {delta && delta.value !== 0 && !loading && (() => {
          const up = delta.value > 0;
          const good = up === (goodWhen === "up");
          const Arrow = up ? ArrowUpRight : ArrowDownRight;
          const said = `${up ? "Up" : "Down"} ${Math.abs(delta.value)} from ${delta.label ?? "the previous period"}`;
          return (
            <span className={cn("inline-flex shrink-0 items-center gap-0.5 text-caption font-medium tabular-nums", good ? "text-success" : "text-warning")} title={said}>
              <Arrow aria-hidden className="size-3.5" />
              <span aria-hidden>{up ? "+" : "−"}{Math.abs(delta.value)}{delta.short ? <span className="font-normal"> {delta.short}</span> : null}</span>
              <span className="sr-only">{said}</span>
            </span>
          );
        })()}
      </div>
      {/* The trend sits beside the number (both 32 px tall), so every card in a row is the same compact height. */}
      <div className="flex h-8 items-end justify-between gap-3">
        {loading ? <Skeleton className="h-8 w-16" /> : <div className={cn("shrink-0 text-metric whitespace-nowrap tabular-nums", value === 0 && "text-muted-foreground")} title={typeof value === "string" || typeof value === "number" ? String(value) : undefined}>{value}</div>}
        {/* The number never truncates: the trend line gives up its width first. */}
        {trend && !loading && <div className="flex min-w-0 max-w-24 flex-1 justify-end max-sm:max-w-14"><Sparkline values={trend} className="h-8 w-full" label={`${label}, trend`} /></div>}
      </div>
      {meter && !loading && (
        <div role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(meter.value)} aria-label={meter.label} className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <span className={cn("block h-full rounded-full", meter.value >= 90 ? "bg-warning" : "bg-foreground/60")} style={{ width: `${Math.min(100, Math.max(0, meter.value))}%` }} />
        </div>
      )}
      {hint && <div className="truncate text-caption text-muted-foreground" title={typeof hint === "string" ? hint : undefined}>{hint}</div>}
    </>
  );
  const cls = cn("group flex h-full min-w-0 flex-col gap-1 rounded-lg border bg-card p-4", href && "transition-colors hover:bg-muted/50 active:bg-muted focus-ring", className);
  return href
    ? <Link to={href} data-kit="stat-card" className={cls}>{body}</Link>
    : <div data-kit="stat-card" className={cls}>{body}</div>;
}

/** Count rows per day for the last `days` days (oldest first): the series a Sparkline wants. */
export function perDay<T>(rows: T[], at: (row: T) => number | string | null | undefined, days = 14, now = Date.now()): number[] {
  const out = new Array(days).fill(0) as number[];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const first = start.getTime() - (days - 1) * 86_400_000;
  for (const r of rows) {
    const v = at(r);
    if (v === null || v === undefined || v === "") continue;
    const i = Math.floor((new Date(v).getTime() - first) / 86_400_000);
    if (i >= 0 && i < days) out[i]++;
  }
  return out;
}
