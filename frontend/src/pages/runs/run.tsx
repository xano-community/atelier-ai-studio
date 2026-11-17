// /runs/:id: one run and its steps, kept current live. A recipe run carries on in the background, so this page can be
// left and opened again: it shows where the run stands now. Beside the steps: what it was estimated to cost and what
// it has cost, what it was given, and how its approval went. A run waiting, refused or declined says why, and what to do
// next, once: an admin who can approve it reads "Needs your approval" with Decline and Approve; anyone else reads who it
// waits on. The status sits in one badge, beside the title.
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { Check, CircleSlash, CircleStop, Clock, Loader2, RotateCcw, ShieldQuestion } from "lucide-react";
import { toast } from "sonner";
import { Ago, EmptyState, LoadError, StatusBadge, useLoad } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RunSteps, type RunStep } from "@/components/studio/run-steps";
import { AiOffNotice } from "@/components/studio/ai-status";
import { useLive } from "@/base/live";
import { useMe } from "@/base/session";
import { useWorkspace } from "@/base/workspace";
import { useCan } from "@xano-sdk/rbac/react";
import { refreshPendingCount, useAgents } from "@xano-sdk/agents/react";
import { api, ApiError } from "@/lib/api";
import { findModel, type StepKind } from "@/lib/catalog";
import { isFinal, money, newClickId, type RunView } from "@/lib/playground";
import { recipesApi, RETRYABLE } from "@/lib/recipes";
import { dollars, raiseTo, usageApi } from "@/lib/usage";
import { runStatus } from "../recipes";

const VIA: Record<string, string> = { ui: "", api: "with an API key", mcp: "by an agent", easel: "by Easel" };

export function RunPage() {
  const id = Number(useParams().id);
  const me = useMe();
  const isAdmin = useCan("budgets.manage");
  const view = useLoad(() => api.run(id), [id]);
  const details = useLoad(() => recipesApi.details(id), [id]);
  const catalog = useLoad(() => api.catalog(), []);
  const modelLabel = (kind: string, model: string) => findModel(catalog.data, kind as StepKind, model)?.label ?? model;
  const going = !!view.data && !isFinal(view.data.run.status);
  const reload = useCallback(() => { view.reload(); details.reload(); }, [view, details]);
  useLive(["ai_run", "ai_step", "asset"], () => { if (view.data) view.reload(); });
  // A socket can miss a frame: while it's going, a slow poll keeps the page honest.
  useEffect(() => {
    if (!going) return;
    const t = setInterval(() => document.visibilityState === "visible" && view.reload(), 8000);
    return () => clearInterval(t);
  }, [going]); // eslint-disable-line react-hooks/exhaustive-deps
  const [busy, setBusy] = useState<string | null>(null);

  if (view.error && !view.data) {
    const missing = view.error instanceof ApiError && view.error.status === 404;
    return missing
      ? <EmptyState icon={CircleSlash} title="No such run" description="It may be someone's private Playground run, or the link is wrong." action={<Button size="sm" variant="outline" asChild><Link to="/recipes">Recipes</Link></Button>} />
      : <LoadError title="This run didn't load" error={view.error} onRetry={reload} />;
  }
  if (!view.data) return <div className="grid gap-4" aria-label="Loading the run"><Skeleton className="h-9 w-80" /><div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]"><Skeleton className="h-96" /><Skeleton className="h-64" /></div></div>;

  const { run } = view.data;
  const steps = view.data.steps as RunStep[];
  const d = details.data;
  const mine = run.owner_id === me.id;
  const st = runStatus(run.status);
  const working = steps.find((s) => s.status === "working");
  const done = steps.filter((s) => !["queued", "working"].includes(s.status)).length;
  const failed = steps.filter((s) => RETRYABLE.includes(s.status));
  const canRetry = mine && (run.status === "partial" || run.status === "failed") && failed.length > 0;

  const act = async (what: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(what);
    try { await fn(); if (ok) toast.success(ok); reload(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "That didn't work. Try again."); }
    finally { setBusy(null); }
  };
  const retry = (edits: { step_id: number; prompt: string }[] = []) => act("retry", () => api.retryRun(run.id, newClickId(), edits), "Retrying the failed steps");
  // Running, as opposed to waiting on a person: only then does a step tick, and Stop apply.
  const live = ["starting", "queued", "running"].includes(run.status);
  // An admin who can decide it reads that it's theirs to decide; everyone else, that it waits for an admin.
  const decides = run.status === "waiting_approval" && isAdmin && !mine && run.approval_id > 0;
  const chip = run.status === "running" ? `Running · step ${Math.min(steps.length, (working?.seq ?? done + 1))} of ${steps.length}` : decides ? "Needs your approval" : st.label;
  const hold = run.status === "waiting_approval" ? "Waiting for approval" : ["needs_confirmation", "waiting_confirmation"].includes(run.status) ? "Waiting to confirm" : "";
  const who = d?.owner_name || "Someone";
  // A recipe run shows the form it was given; a Playground run has no form, so it shows what was asked of the model.
  const shownInputs: { key: string; label: string; value: string; note?: string }[] = (d?.inputs ?? []).filter((i) => i.name)
    .map((i) => ({ key: i.name, label: i.label, value: i.value, note: i.type === "knowledge" ? " (from Knowledge)" : undefined }));
  if (d && !shownInputs.length && run.kind === "playground" && steps[0]) {
    const first = steps[0];
    const asked = (first.input ?? {}) as Record<string, unknown>;
    const words = String(asked.prompt ?? asked.text ?? "");
    shownInputs.push({ key: "model", label: steps.length > 1 ? "Models" : "Model", value: [...new Set(steps.map((s) => modelLabel(s.kind, s.model)))].join(" and ") });
    if (words) shownInputs.push({ key: "prompt", label: first.kind === "speech" ? "Script" : "Prompt", value: words });
    if (asked.use_brand !== undefined) shownInputs.push({ key: "brand", label: "Brand kit", value: asked.use_brand ? "Added to the prompt" : "Left out for this run" });
  }
  const via = VIA[run.via] ?? "";

  return (
    <div className="flex flex-col gap-5" data-testid="run-page" data-status={run.status}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {d?.recipe && <Link to={`/recipes/${d.recipe.slug}`} className="focus-ring -ml-1 mb-1 inline-flex rounded-sm px-1 text-caption text-muted-foreground hover:text-foreground">← {d.recipe.name}</Link>}
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-title text-pretty wrap-anywhere">{run.title}</h1>
            <span data-testid="run-status"><StatusBadge tone={live ? "info" : st.tone} dot={!live && run.status !== "done"}>
              {live ? <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" /> : run.status === "done" ? <Check aria-hidden className="size-3" /> : null}
              {chip}
            </StatusBadge></span>
          </div>
          <p className="mt-0.5 text-body text-muted-foreground">Started by {who}{via ? ` ${via}` : ""}{d?.connection_name ? ` (${d.connection_name})` : ""} · <Ago value={run.created_at} /></p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {(live || run.status === "waiting_approval") && (mine || isAdmin) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" disabled={busy === "stop"} onClick={() => act("stop", () => api.stopRun(run.id), "Stopped")} data-testid="run-stop" className="h-8 text-muted-foreground max-sm:-ml-2.5"><CircleStop aria-hidden />Stop</Button>
              </TooltipTrigger>
              <TooltipContent>Steps not yet sent are released. A step already sent finishes and is charged.</TooltipContent>
            </Tooltip>
          )}
          {canRetry && <Button variant="outline" size="sm" disabled={busy === "retry"} onClick={() => void retry()} data-testid="run-retry"><RotateCcw aria-hidden />Retry failed steps</Button>}
        </div>
      </header>

      <Notice view={view.data} mine={mine} isAdmin={isAdmin} busy={busy} act={act} failedCount={failed.length} />
      {canRetry && <AiOffNotice after="Retrying a step needs AI; what this run made stays here." />}
      {decides && <Decide run={run} owner={who} busy={busy} act={act} />}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="min-w-0" aria-label="Steps">
          <RunSteps steps={steps} running={live} canRetry={canRetry} onRetryStep={(s, prompt) => retry([{ step_id: s.id, prompt }])} modelLabel={modelLabel}
            hold={hold} why={run.status === "waiting_approval" && run.reason === "video" ? "video" : ""} />
        </section>
        <aside className="grid gap-4">
          <section className="rounded-lg border bg-card" aria-label="Cost">
            <h2 className="flex h-11 items-center border-b px-4 text-heading">Cost</h2>
            <div className="grid gap-2 p-4 text-body tabular-nums">
              <p className="flex items-baseline justify-between"><span className="text-muted-foreground">{going ? "Spent so far" : "Spent"}</span><span className="text-heading" data-testid="run-spent">{money(run.spent)}</span></p>
              <p className="flex items-baseline justify-between"><span className="text-muted-foreground">Estimated</span><span>{money(run.estimate)}</span></p>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${money(run.spent)} of ${money(run.estimate)} estimated`}>
                <span className="block h-full rounded-full bg-foreground/60" style={{ width: `${run.estimate ? Math.min(100, (run.spent / run.estimate) * 100) : 0}%` }} />
              </div>
              <p className="mt-1 text-caption text-pretty text-muted-foreground">Charged to {mine ? "your" : `${who}'s`} budget. A step is charged for what it used, and one that was never sent costs nothing.</p>
            </div>
          </section>
          {shownInputs.length > 0 && (
            <section className="rounded-lg border bg-card" aria-label="Inputs" data-testid="run-inputs">
              <h2 className="flex h-11 items-center border-b px-4 text-heading">Inputs</h2>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 p-4 text-body">
                {shownInputs.map((i) => <div key={i.key} className="contents"><dt className="text-muted-foreground">{i.label}</dt><dd className="line-clamp-3 wrap-anywhere" title={i.value}>{i.value}{i.note ? <span className="text-muted-foreground">{i.note}</span> : null}</dd></div>)}
              </dl>
            </section>
          )}
          {d?.approval && d.approval.status !== "pending" && (
            <section className="rounded-lg border bg-card animate-in fade-in duration-200" aria-label="Approval">
              <div className="flex h-11 items-center justify-between gap-2 border-b px-4">
                <h2 className="text-heading">Approval</h2>
                <StatusBadge dot tone={d.approval.status === "approved" ? "success" : d.approval.status === "declined" ? "danger" : "neutral"}>
                  {d.approval.status === "approved" ? "Approved" : d.approval.status === "declined" ? "Declined" : "Expired"}
                </StatusBadge>
              </div>
              <p className="p-4 text-body text-pretty" data-testid="run-approval">
                {d.approval.status === "approved" ? <>Approved by {d.approval.decided_by || "an admin"}{d.approval.decided_at ? <> <Ago value={d.approval.decided_at} /></> : null}. One approval covers the whole run.</>
                  : d.approval.status === "declined" ? `Declined by ${d.approval.decided_by || "an admin"}. Nothing was charged.`
                  : "Nobody approved it in time. Nothing was charged."}
              </p>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}


/** Why a run is waiting, refused, declined or stopped, in the run's own words, with the next step. */
function Notice({ view, mine, isAdmin, busy, act, failedCount }: {
  view: RunView; mine: boolean; isAdmin: boolean; busy: string | null; act: (what: string, fn: () => Promise<unknown>, ok?: string) => Promise<void>; failedCount: number;
}) {
  const { run } = view;
  const { people } = useWorkspace();
  const waiting = ["waiting_approval", "needs_confirmation", "waiting_confirmation"].includes(run.status);
  const refused = ["refused", "declined"].includes(run.status);
  if (!waiting && !refused && run.status !== "stopped" && run.status !== "partial") return null;
  // An admin deciding someone else's run reads the decision card instead: the run's own words speak to its owner.
  if (run.status === "waiting_approval" && isAdmin && !mine) return null;
  const words = run.status === "partial"
    ? `${failedCount} ${failedCount === 1 ? "step" : "steps"} didn't finish. What worked is kept${mine ? ", and Retry failed steps runs only those again" : ""}.`
    : run.status === "waiting_approval" ? `${run.detail || "It waits for an admin. Nothing is charged until it's approved."} ${waitsOn(people, mine)}`
    : run.detail || (waiting ? "Waiting for you to confirm. Nothing is charged until then." : "This run didn't start.");
  return (
    <div role="status" className="flex flex-wrap items-start gap-3 rounded-lg border bg-card p-4 text-body" data-testid="run-notice">
      {waiting ? <Clock aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" /> : refused ? <CircleSlash aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" /> : <ShieldQuestion aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      <p className="min-w-0 flex-1 text-pretty">{words}</p>
      <div className="flex gap-2">
        {mine && (run.status === "needs_confirmation" || run.status === "waiting_confirmation") && (
          <Button size="sm" disabled={busy === "confirm"} onClick={() => act("confirm", () => api.confirmRun(run.id), "Confirmed. It's running.")}>Confirm and run</Button>
        )}
        {mine && run.status === "refused" && run.reason === "over_budget" && !isAdmin && (
          <Button size="sm" variant="outline" disabled={busy === "ask"} onClick={() => act("ask", () => api.askAdmin(run.id), "Sent to the admins")}>Ask an admin</Button>
        )}
      </div>
    </div>
  );
}

/** Who a run waiting for approval waits on, by name: the admins, who are the ones who can approve it. */
export function waitsOn(people: { name: string; role: string }[], mine: boolean): string {
  const admins = people.filter((p) => p.role === "admin").map((p) => p.name);
  const told = mine ? " You'll get a notification when they decide." : "";
  if (!admins.length) return `It's with the team's admins.${told}`;
  const names = admins.length === 1 ? admins[0] : `${admins.slice(0, -1).join(", ")} or ${admins[admins.length - 1]}`;
  return `${names} can approve it.${told}`;
}

/**
 * An admin's decision on a run that waits for one, where they're already looking. A run over its owner's budget can be
 * let past once, or the owner's budget raised for the month by enough to cover it (to the next $5); a costly run is
 * approved or declined. Approving reserves for the run's owner, never the admin.
 */
function Decide({ run, owner, busy, act }: {
  run: RunView["run"]; owner: string; busy: string | null; act: (what: string, fn: () => Promise<unknown>, ok?: string) => Promise<void>;
}) {
  const { client } = useAgents();
  const over = run.reason === "over_budget";
  const budgets = useLoad(() => (over ? usageApi.budgets() : Promise.resolve(null)), [over]);
  const row = budgets.data?.rows.find((r) => r.scope === "person" && r.subject_id === run.owner_id);
  const to = over && budgets.data ? raiseTo(row ?? { budget: budgets.data.person_budget, reserved: 0, spent: 0 }, run.estimate) : null;
  const first = owner.split(" ")[0];
  const decided = (fn: () => Promise<unknown>) => async () => { await fn(); refreshPendingCount(); };
  return (
    <section aria-label="Your decision" data-testid="run-decide" className="flex flex-wrap items-center gap-3 rounded-lg border border-warning/40 bg-card p-4 text-body">
      <ShieldQuestion aria-hidden className="size-4 shrink-0 text-warning" />
      <p className="min-w-0 flex-1 basis-64 text-pretty">
        {over
          ? <>{first} asked to go past {row ? <>their {dollars(row.budget)} budget</> : "their budget"} for this run, estimated at {dollars(run.estimate)}.</>
          : <>Needs your approval as admin. {first} asked to run it, estimated at {dollars(run.estimate)} and charged to {first}'s budget. Nothing is charged until you approve.</>}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void act("decline", decided(() => client.decline(run.approval_id)), "Declined. Nothing was charged.")}>Decline</Button>
        {over && to !== null && (
          <Button size="sm" variant="outline" disabled={!!busy} data-testid="run-raise"
            onClick={() => void act("raise", decided(() => usageApi.raiseForRun(run.id, to)), `${first}'s budget is ${dollars(to)} this month. The run is on its way.`)}>
            Raise {first}'s budget to {dollars(to)}
          </Button>
        )}
        <Button size="sm" disabled={!!busy} data-testid="run-approve"
          onClick={() => void act("approve", decided(() => client.approve(run.approval_id)), "Approved. It starts within a minute.")}>
          {over ? "Approve this run once" : "Approve"}
        </Button>
      </div>
    </section>
  );
}
