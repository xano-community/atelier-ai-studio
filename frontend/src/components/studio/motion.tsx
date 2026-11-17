// How a row comes and goes in a list someone is acting on (Approvals, Home's "Waiting on you"): a row they decide folds
// away in 200 ms on the kit's curve, and the rows under it slide up into its place instead of jumping; a row that turns
// up later fades in. Reduced motion keeps only the fade (kit.css), so nothing slides. A page's first paint never animates.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** How long a decided row takes to fold away, in ms: the kit's "slow" duration. */
export const LEAVE_MS = 200;

/** Rows on their way out: `leave(id)` folds the row, then calls `done(id)` once it has gone. */
export function useLeaving(done: (id: number) => void) {
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(new Set());
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);
  const leave = useCallback((id: number) => {
    setLeaving((s) => new Set(s).add(id));
    timers.current.push(window.setTimeout(() => done(id), LEAVE_MS + 20));
  }, [done]);
  return { leaving, leave };
}

/** The ids that weren't in the list the first time it had loaded: rows that arrived while someone was looking. */
export function useArrivals(ids: number[] | null) {
  const seen = useRef<Set<number> | null>(null);
  const fresh = new Set<number>();
  if (ids) {
    if (!seen.current) seen.current = new Set(ids);
    else for (const id of ids) if (!seen.current.has(id)) fresh.add(id);
  }
  useEffect(() => { if (ids && seen.current) for (const id of ids) seen.current.add(id); });
  return fresh;
}

/** A row that folds to nothing when `gone`, and fades in when it `arrived`. */
export function Fold({ gone, arrived, children, className }: { gone: boolean; arrived?: boolean; children: ReactNode; className?: string }) {
  return (
    <div aria-hidden={gone || undefined} data-kit="fold" data-gone={gone || undefined}
      className={cn("grid transition-[grid-template-rows,opacity] duration-200 ease-(--ease-out)", gone ? "pointer-events-none grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
        arrived && "animate-in fade-in slide-in-from-top-1 duration-200", className)}>
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
