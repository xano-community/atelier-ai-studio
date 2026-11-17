// The card under an Easel reply that names a run waiting on a person (violet: the assistant asked for it). What would be
// made, from what, on which model and at what estimate, and the one action that moves it on: an admin approves or
// declines a member's run here, and an admin confirms their own costly run here. Easel can't do either itself: the
// buttons are the person's click in the app. Once it moves, the card follows the run to its end.
import { useState } from "react";
import { Link } from "react-router";
import { ArrowUpRight, Check, Loader2, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import { refreshPendingCount, useAgents } from "@xano-sdk/agents/react";
import { useCan } from "@xano-sdk/rbac/react";
import { Button } from "@/components/ui/button";
import { StatusBadge, useLoad } from "@/components/kit";
import { useLive } from "@/base/live";
import { useSession } from "@/base/session";
import { api } from "@/lib/api";
import { findModel, type StepKind } from "@/lib/catalog";
import { money } from "@/lib/playground";
import { libraryApi } from "@/lib/library";
import { useMedia } from "@/lib/media";
import { cn } from "@/lib/utils";
import { KindTile } from "./kind-icon";

const HEADINGS: Record<string, string> = {
  waiting_approval: "Approval needed", waiting_confirmation: "Confirm to start", needs_confirmation: "Confirm to start",
  queued: "Approved, starting", running: "Making it now", done: "Done", partial: "Partly done", failed: "It failed",
  refused: "Not started", declined: "Declined", stopped: "Stopped",
};
const ACTIVE = ["queued", "running", "starting"];

/** A Library picture the run starts from, as a thumbnail however this server keeps it (lib/media.ts). */
export function FromPicture({ assetId, kind, className = "size-16" }: { assetId: number; kind: string; className?: string }) {
  const item = useLoad(() => (assetId ? libraryApi.get(assetId) : Promise.resolve(null)), [assetId]);
  const picture = item.data?.kind === "image" ? { url: item.data.url, blob_id: item.data.blob_id, mime: item.data.mime } : null;
  const shown = useMedia(picture);
  if (!picture || shown.state !== "ready") return <KindTile kind={kind} className={cn("rounded-md", className)} />;
  return <img src={shown.src} alt={item.data?.title ?? ""} className={cn("shrink-0 rounded-md border object-cover", className)} />;
}

export function RunCard({ runId }: { runId: number }) {
  const { me } = useSession();
  const { client } = useAgents();
  const canApprove = useCan("budgets.manage");
  const view = useLoad(() => api.run(runId), [runId]);
  const catalog = useLoad(() => api.catalog(), []);
  const [busy, setBusy] = useState<"" | "approve" | "decline" | "confirm">("");
  useLive(["ai_run", "ai_step"], () => { if (view.data) view.reload(); }, { pollMs: ACTIVE.includes(view.data?.run.status ?? "") ? 5_000 : 30_000 });

  if (view.loading && !view.data) {
    return <div className="h-28 animate-pulse rounded-lg border border-agent/40 bg-agent-wash/30" data-testid="easel-run-card" aria-label="Loading the run" />;
  }
  if (view.error || !view.data) {
    return (
      <div className="rounded-lg border p-3 text-caption text-muted-foreground" data-testid="easel-run-card">
        This run couldn't be loaded. <Link to={`/runs/${runId}`} className="text-foreground underline underline-offset-2">Open it</Link> to see where it stands.
      </div>
    );
  }
  const { run, steps } = view.data;
  const step = steps[0];
  const kind = (step?.kind ?? "text") as StepKind;
  const label = step ? (findModel(catalog.data, kind, step.model)?.label ?? step.model) : "";
  const fromAsset = Number(step?.input?.from_asset ?? 0);
  const isAdmin = canApprove;
  const mine = run.owner_id === undefined || run.owner_id === me?.id;
  const waitsForAdmin = run.status === "waiting_approval";
  const waitsForMe = (run.status === "waiting_confirmation" || run.status === "needs_confirmation") && mine;
  const asking = waitsForAdmin || waitsForMe;
  const finished = !asking && !ACTIVE.includes(run.status);

  const act = async (which: "approve" | "decline" | "confirm") => {
    setBusy(which);
    try {
      if (which === "confirm") await api.confirmRun(run.id);
      else if (which === "approve") await client.approve(run.approval_id);
      else await client.decline(run.approval_id);
      refreshPendingCount();
      const after = await api.run(run.id);
      view.setData(after);
      if (after.run.status === "refused") toast.error(after.run.detail || "The budget no longer fits, so it didn't start.");
      else toast.success(which === "decline" ? "Declined. Nothing was made or charged." : "Started. It carries on in the background.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy("");
    }
  };

  const who = mine ? "you" : (run.owner_name || "a teammate").split(" ")[0];
  const tone = asking ? "warning" : run.status === "done" ? "success" : ["failed", "refused", "declined"].includes(run.status) ? "danger" : ACTIVE.includes(run.status) ? "info" : "neutral";
  return (
    <section className="overflow-hidden rounded-lg border border-agent/50 bg-card text-card-foreground" data-testid="easel-run-card" data-status={run.status}
      aria-label={`${HEADINGS[run.status] ?? "Run"}: ${run.title}`}>
      <header className="flex min-h-9 items-center gap-2 border-b border-agent/20 bg-agent-wash/60 px-3 py-1.5 text-caption">
        <Sparkles className="size-3.5 shrink-0 text-agent-text" aria-hidden />
        <span className="min-w-0 truncate"><span className="font-medium text-agent-text">Easel</span><span className="text-muted-foreground"> asked for this, for {who}</span></span>
        <StatusBadge tone={tone} dot className="ml-auto">{HEADINGS[run.status] ?? "Run"}</StatusBadge>
      </header>
      <div className="flex gap-3 p-3">
        {fromAsset > 0 ? <FromPicture assetId={fromAsset} kind={kind} /> : <KindTile kind={kind} className="size-16 rounded-md" />}
        <div className="grid min-w-0 flex-1 content-start gap-1 text-caption">
          <p className="text-body font-medium text-foreground [overflow-wrap:anywhere]">{run.title}</p>
          {label && <p className="truncate text-muted-foreground">{label}</p>}
          {run.detail && <p className="text-pretty text-muted-foreground [overflow-wrap:anywhere]">{run.detail}</p>}
        </div>
        <div className="shrink-0 text-right">
          <p className="text-caption text-muted-foreground">{finished && run.spent > 0 ? "Charged" : "Estimate"}</p>
          <p className="text-heading tabular-nums" data-testid="easel-estimate">{money(finished && run.spent > 0 ? run.spent : run.estimate)}</p>
        </div>
      </div>
      <footer className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t px-3 py-2">
        {waitsForAdmin && isAdmin && run.approval_id > 0 && <>
          <Button size="sm" onClick={() => act("approve")} disabled={!!busy} data-testid="easel-approve">
            {busy === "approve" ? <Loader2 className="animate-spin" /> : <Check />}Approve and run
          </Button>
          <Button size="sm" variant="ghost" onClick={() => act("decline")} disabled={!!busy} data-testid="easel-decline">
            {busy === "decline" ? <Loader2 className="animate-spin" /> : <X />}Decline
          </Button>
          <span className="ml-auto text-caption text-muted-foreground">Charged to {mine ? "your" : `${who}'s`} budget</span>
        </>}
        {waitsForAdmin && !isAdmin && <span className="text-caption text-pretty text-muted-foreground">Waiting for an admin. You'll get a notification when they decide.</span>}
        {waitsForMe && <>
          <Button size="sm" onClick={() => act("confirm")} disabled={!!busy} data-testid="easel-confirm">
            {busy === "confirm" ? <Loader2 className="animate-spin" /> : <Check />}Confirm and run
          </Button>
          <span className="ml-auto text-caption text-muted-foreground">Easel can't start it for you</span>
        </>}
        {!asking && (
          <Button asChild size="sm" variant="ghost" className="-ml-2">
            <Link to={`/runs/${run.id}`}>Open the run<ArrowUpRight /></Link>
          </Button>
        )}
      </footer>
    </section>
  );
}
