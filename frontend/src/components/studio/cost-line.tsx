// What a run with these settings is estimated to cost, from the server's own estimate (the price table plus the gateway's
// margin), and how much of this month's budget is used. Text, speech and transcripts are priced at their caps, so they
// say "up to"; images, clips and music are priced per item, so they say "about". Compare adds both models' estimates.
import { useEffect, useState } from "react";
import { api, type Estimate } from "@/lib/api";
import type { PlaygroundCatalog, StepKind } from "@/lib/catalog";
import { money } from "@/lib/playground";
import { cn } from "@/lib/utils";

const CAPPED: StepKind[] = ["text", "speech", "transcribe"];

export function CostLine({ catalog, kind, models, options, className }: {
  catalog: PlaygroundCatalog | null; kind: StepKind; models: string[]; options: Record<string, unknown>; className?: string;
}) {
  const [est, setEst] = useState<Estimate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const wanted = models.filter(Boolean);
  const key = JSON.stringify([kind, wanted, options]);
  useEffect(() => {
    if (!wanted.length) { setEst(null); return; }
    let live = true;
    const t = setTimeout(() => {
      Promise.all(wanted.map((m) => api.estimate(kind, m, options))).then(
        (e) => { if (live) { setEst(e); setFailed(false); } },
        () => { if (live) setFailed(true); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const b = catalog?.budget;
  const share = b && b.budget > 0 ? Math.min(999, Math.round((b.used / b.budget) * 100)) : null;
  const budgetWords = share === null ? "" : `${share}% of your ${b!.month_words.split(" ")[0]} budget used`;
  let costWords = "Estimating…";
  if (failed) costWords = "No estimate right now";
  else if (est?.some((e) => !e.priced)) costWords = "No price set";
  else if (est) costWords = `${CAPPED.includes(kind) ? "Up to" : "About"} ${money(est.reduce((sum, e) => sum + e.amount, 0))}${est.length > 1 ? " for both" : ""}`;
  return (
    <p className={cn("flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-caption text-muted-foreground tabular-nums", className)} data-testid="cost-line" aria-live="polite">
      <span className="font-medium text-foreground">{costWords}</span>
      {budgetWords && <span className="truncate">{budgetWords}</span>}
    </p>
  );
}
