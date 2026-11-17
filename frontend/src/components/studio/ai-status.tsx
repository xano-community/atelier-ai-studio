// When AI can't run here, every screen that starts one says why in the same words: what happened, that everything else still
// works, and the next step. An admin reads the fix (the command to run, or "Check again" once credits are added or AI is
// switched on for the instance); everyone else reads that an admin can turn it on. "Check again" sends one tiny embedding
// through the spend gate: when it comes back, AI is on again for everyone; when it's refused, the reason shown is the
// one it was refused with. A plan that can't keep video, voice or music files says so here too, before anyone runs one.
import { useEffect, useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@xano-sdk/rbac/react";
import { Button } from "@/components/ui/button";
import { useLive } from "@/base/live";
import { request } from "@/base/request";
import { newClickId } from "@/lib/playground";
import { usageApi } from "@/lib/usage";
import { cn } from "@/lib/utils";
import type { AiState } from "../../../../xano/function/studio/ai_state.js";
import { routePath } from "../../../../xano/routes.gen.js";

export type { AiState };
type Status = AiState["ai_status"];

/** Statuses fixed outside the app, where checking again is the next step. A sign-in fix ends in a deploy instead. */
const CHECKABLE: Status[] = ["no_credits", "disabled"];
/** What happened, in one line, per status. */
export const AI_OFF_TITLE: Record<Exclude<Status, "on">, string> = {
  signed_out: "AI isn't switched on here yet.",
  expired: "The Xano AI sign-in on this machine has expired.",
  no_credits: "The workspace owner is out of Xano AI credits.",
  disabled: "Xano AI is switched off on this instance.",
};
/** What a run button says while AI is off. */
export const GENERATE_OFF = "Generate is off until AI is on.";
export const PAID_PLAN_TITLE = "This plan can't save video, voice or music files.";

// One answer for every screen, asked once and again whenever the settings change.
let held: Promise<AiState> | null = null;
const listeners = new Set<(s: AiState) => void>();
const ask = (fresh = false) => {
  if (!held || fresh) {
    held = request<AiState>("GET", routePath("GET ai-state"));
    held.then((s) => listeners.forEach((l) => l(s)), () => { held = null; });
  }
  return held;
};

/** Whether AI can run here now, and what this plan keeps. Null while it loads. */
export function useAiState(): { state: AiState | null; reload: () => void } {
  const [state, setState] = useState<AiState | null>(null);
  useEffect(() => {
    listeners.add(setState);
    ask().then(setState, () => setState(null));
    return () => { listeners.delete(setState); };
  }, []);
  useLive(["settings"], () => void ask(true));
  return { state, reload: () => void ask(true) };
}

export function AiStatusNotice({ status, reason, fix, after, onChanged, className }: {
  status: Status; reason: string; fix?: string;
  /** What still works on this screen, after the reason. */ after?: string;
  onChanged?: () => void; className?: string;
}) {
  const isAdmin = useCan("team.manage");
  const [busy, setBusy] = useState(false);
  if (status === "on") return null;
  const check = async () => {
    setBusy(true);
    try {
      const r = await usageApi.checkAi(newClickId());
      if (r.ok) toast.success("Xano AI answered. Everything can run again.");
      else toast.error(r.detail || r.ai_status_reason || "Xano AI still isn't answering. Try again after the fix.");
      void ask(true);
      onChanged?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The check didn't go through. Try again.");
    } finally { setBusy(false); }
  };
  return (
    <div role="alert" data-testid="ai-off" data-status={status} className={cn("flex flex-wrap items-start gap-3 rounded-lg border border-warning/40 bg-warning/8 p-4 text-body", className)}>
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="grid min-w-0 flex-1 gap-1.5">
        <div className="font-medium">{AI_OFF_TITLE[status]}</div>
        <p className="text-pretty text-muted-foreground">{reason || "An admin can turn it back on."}{after ? ` ${after}` : ""}</p>
        {isAdmin && fix && (
          <p className="text-muted-foreground">Run <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-caption text-foreground" data-testid="ai-fix">{fix}</code>, then deploy again.</p>
        )}
      </div>
      {isAdmin && CHECKABLE.includes(status) && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()} data-testid="ai-check">
          <RefreshCw aria-hidden className={cn(busy && "animate-spin motion-reduce:animate-none")} />{busy ? "Checking…" : "Check again"}
        </Button>
      )}
    </div>
  );
}

/** The screen's notice, from the shared AI state: nothing while AI is on. */
export function AiOffNotice({ after, className }: { after?: string; className?: string }) {
  const { state, reload } = useAiState();
  if (!state || state.ai_status === "on") return null;
  return <AiStatusNotice status={state.ai_status} reason={state.ai_status_reason} fix={state.fix_command} after={after} onChanged={reload} className={className} />;
}

/** A plan that can't keep video, voice or music files, said before anyone runs one. */
export function PaidPlanNotice({ className }: { className?: string }) {
  return (
    <div role="status" data-testid="paid-plan" className={cn("flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/8 p-4 text-body", className)}>
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="grid min-w-0 gap-1">
        <div className="font-medium">{PAID_PLAN_TITLE}</div>
        <p className="text-pretty text-muted-foreground">Images and text work. Upgrade the workspace to keep the other kinds; until then they're marked "needs a paid plan" and don't run.</p>
      </div>
    </div>
  );
}
