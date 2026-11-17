// Your Playground history: every run you made here, newest first, both models of a Compare on one line. Nobody else
// sees it; "Use this" is how an output reaches the team's library. One row per run, its columns lined up: what it was,
// the model, what it cost and when, so a week of trying things scans like a log.
import { useEffect, useMemo, useState } from "react";
import { AudioLines, FileText, Film, Image as ImageIcon, Music, Type, type LucideIcon } from "lucide-react";
import { Ago, Panel, PanelList, PanelRow, StatusBadge, useLoad } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { useLive } from "@/base/live";
import { api, type History } from "@/lib/api";
import { groupHistory, money, type HistoryRow } from "@/lib/playground";
import { modelName } from "@/lib/knowledge";
import { cn } from "@/lib/utils";

const KIND_ICON: Record<string, LucideIcon> = { text: Type, image: ImageIcon, video: Film, speech: AudioLines, music: Music, transcribe: FileText };
const STATUS: Record<string, { tone: "neutral" | "info" | "warning" | "danger"; label: string }> = {
  starting: { tone: "info", label: "Starting" }, queued: { tone: "info", label: "Running" }, running: { tone: "info", label: "Running" },
  waiting_approval: { tone: "warning", label: "Waiting" }, needs_confirmation: { tone: "warning", label: "Needs confirming" }, waiting_confirmation: { tone: "warning", label: "Needs confirming" },
  refused: { tone: "danger", label: "Refused" }, declined: { tone: "danger", label: "Declined" }, failed: { tone: "danger", label: "Failed" },
  partial: { tone: "warning", label: "Partly done" }, stopped: { tone: "neutral", label: "Stopped" },
};
/** The row's columns, shared by the header and every row so they line up. */
const COLS = "grid grid-cols-[1rem_minmax(0,1fr)_4.5rem] items-center gap-x-3 sm:grid-cols-[1rem_minmax(0,1fr)_10rem_4.5rem_5.5rem]";

export function PlaygroundHistory({ onOpen, openIds, onLoaded }: { onOpen: (row: HistoryRow) => void; openIds: number[]; onLoaded?: (rows: HistoryRow[]) => void }) {
  const [pages, setPages] = useState(1);
  // Pages load one after another; each later page is appended to the first.
  const first = useLoad(() => loadPages(pages), [pages]);
  useLive("ai_run", first.reload);
  const rows = useMemo(() => (first.data ? groupHistory(first.data.runs, first.data.steps) : []), [first.data]);
  useEffect(() => { if (first.data) onLoaded?.(rows); }, [first.data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Panel title="History" extra={<span className="hidden truncate text-caption text-muted-foreground sm:inline">Private to you until you keep something</span>} data-kit="playground-history">
      {rows.length > 0 && (
        <div aria-hidden className={cn(COLS, "border-b px-4 py-1.5 text-caption text-muted-foreground")}>
          <span /><span>Prompt</span><span className="hidden sm:block">Model</span><span className="hidden text-right sm:block">Cost</span><span className="text-right">When</span>
        </div>
      )}
      <PanelList loading={first.loading && !first.data} error={first.error} onRetry={first.reload} rows={4}
        empty="Nothing yet. What you make here lands in this list, private to you.">
        {rows.map((r) => {
          const Icon = KIND_ICON[r.kind] ?? Type;
          const status = STATUS[r.status];
          const open = r.runIds.some((id) => openIds.includes(id));
          const models = r.compared ? r.models.map(modelName).join(" vs ") : modelName(r.models[0] ?? "");
          return (
            <PanelRow key={r.key} onClick={() => onOpen(r)} className={cn(COLS, "gap-3", open && "bg-selected")} data-kit="history-row">
              <Icon aria-hidden className="size-4 text-muted-foreground" />
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate" title={r.title}>{r.title}</span>
                {r.compared && <span className="shrink-0 text-caption text-muted-foreground">compared</span>}
                {status && <StatusBadge tone={status.tone}>{status.label}</StatusBadge>}
              </span>
              <span className="hidden truncate text-caption text-muted-foreground sm:block" title={models}>{models}</span>
              <span className="hidden text-right text-caption text-muted-foreground tabular-nums sm:block">{r.spent > 0 ? money(r.spent) : "—"}</span>
              <Ago value={r.created_at} className="text-right text-caption whitespace-nowrap text-muted-foreground" />
            </PanelRow>
          );
        })}
      </PanelList>
      {first.data?.more && (
        <div className="border-t px-2 py-1.5">
          <Button variant="ghost" size="sm" onClick={() => setPages((p) => p + 1)} disabled={first.loading}>Show older runs</Button>
        </div>
      )}
    </Panel>
  );
}

async function loadPages(n: number): Promise<History> {
  const all = await Promise.all(Array.from({ length: n }, (_, i) => api.history(i + 1)));
  return { runs: all.flatMap((p) => p.runs), steps: all.flatMap((p) => p.steps), more: all[all.length - 1]?.more ?? false };
}
