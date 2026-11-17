// The results area: one pane, or two side by side when comparing. Each pane follows its own run, so one model being
// refused, waiting or failing never changes what the other shows. Compare's two panes are the same size and shape:
// the same header, the output, then the time, usage and cost strip on one line across both.
import { findModel, tierLabel, type PlaygroundCatalog, type StepKind } from "@/lib/catalog";
import { cn } from "@/lib/utils";
import { ResultPane, type usePane } from "./result";

type PaneHandle = ReturnType<typeof usePane>;

export function Results({ catalog, kind, compare, a, b, modelA, modelB, onRunAgain, className }: {
  catalog: PlaygroundCatalog | null; kind: StepKind; compare: boolean; a: PaneHandle; b: PaneHandle; modelA: string; modelB: string;
  onRunAgain: () => void; className?: string;
}) {
  // A pane opened from history names the model its run used, not the one picked now.
  const nameOf = (pane: PaneHandle, picked: string) => {
    const used = pane.pane.view?.steps[0]?.model ?? picked;
    const m = findModel(catalog, kind, used);
    return { title: m?.label ?? used ?? "Result", chip: m ? tierLabel(m.tier) : undefined };
  };
  const isAdmin = !!catalog?.is_admin;
  const reloadOf = (p: PaneHandle) => () => { if (p.pane.view) void p.load(p.pane.view.run.id); };
  if (!compare) {
    const one = nameOf(a, modelA);
    return (
      <div className={cn("min-w-0", className)}>
        <ResultPane pane={a.pane} reload={reloadOf(a)} title={a.pane.view || a.pane.sending ? one.title : "Result"}
          chip={a.pane.view || a.pane.sending ? one.chip : undefined} kind={kind} isAdmin={isAdmin} onRunAgain={onRunAgain} testId="result-a" className="lg:min-h-[28rem]" />
      </div>
    );
  }
  const first = nameOf(a, modelA), second = nameOf(b, modelB);
  return (
    <div className={cn("grid min-w-0 items-stretch gap-4 md:grid-cols-2", className)} data-testid="compare">
      <ResultPane pane={a.pane} reload={reloadOf(a)} title={first.title} chip={first.chip} kind={kind} isAdmin={isAdmin} compact testId="result-a" className="h-full" />
      <ResultPane pane={b.pane} reload={reloadOf(b)} title={second.title} chip={second.chip} kind={kind} isAdmin={isAdmin} compact testId="result-b" className="h-full" />
    </div>
  );
}
