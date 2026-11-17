// How many approvals wait for the signed-in person, for the sidebar's badge. The agents module counts them (agents-area.tsx,
// loaded after the first paint) and writes the number here, so the shell shows it without carrying the module.
import { useSyncExternalStore } from "react";

let count = 0;
const listeners = new Set<() => void>();

export function setPendingCount(n: number) {
  if (n === count) return;
  count = n;
  listeners.forEach((l) => l());
}

export const usePendingApprovals = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => count, () => 0);
