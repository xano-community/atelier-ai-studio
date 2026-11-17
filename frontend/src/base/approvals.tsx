// /approvals: what waits for this person's OK, and what was decided, from the agents module's approvals. One 48 px row a
// request, the width of the page: who asked (a person's avatar, or Easel or a connected agent in violet with the person it
// works for, "Easel for Sam Rivera"), what it would run with a thumbnail of what it starts from, its estimate in tabular
// figures, and Decline and Approve at the right. The sentence every request shares (the rule that put them here) is said
// once above the list instead of on every row; a row opens for the rest (its own note, an editable value, the link to it in
// context). A decided row folds away and the ones under it close the gap. On a phone a row stacks, with 44 px buttons.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowUpRight, Bot, Check, CheckCheck, ChevronDown, Plug, ShieldCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { refreshPendingCount, useAgents } from "@xano-sdk/agents/react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Ago, Avatar, EmptyState, LoadError, PageHeader, Segmented, StatusBadge, useLoad, type Tone } from "@/components/kit";
import { FromPicture } from "@/components/studio/approval-card";
import { KindTile } from "@/components/studio/kind-icon";
import { Fold, useArrivals, useLeaving } from "@/components/studio/motion";
import { api } from "@/lib/api";
import { dollars } from "@/lib/usage";
import { cn } from "@/lib/utils";
import { requestWords, sharedNote } from "@/lib/waiting";
import { usePendingApprovals } from "./pending";
import { useMe } from "./session";

type View = "pending" | "decided";
type Client = ReturnType<typeof useAgents>["client"];
type Approval = Awaited<ReturnType<Client["approvals"]>>["items"][number];

type StatusView = { label: string; tone: Tone };
const STATUS: Record<"pending" | "approved" | "declined" | "expired", StatusView> = {
  pending: { label: "Waiting for you", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  declined: { label: "Declined", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

/** The kind a run's thumbnail stands for when it doesn't start from a picture: the costliest thing it makes. */
const MAKES = ["video", "music", "image", "speech", "text", "transcribe", "embedding"];

/**
 * Who asked. A request from the app itself carries the app's name as its agent (the run gate asking on the person's
 * behalf), so that one is the person; Easel and connected agents are agents, working for the person.
 */
function actorOf(a: Approval, appName: string, assistantName: string) {
  const label = a.agent_label?.trim();
  if (a.source === "mcp") return { agent: true, name: label || "A connected agent" };
  if (!label || label === appName) return { agent: false, name: a.requester_name || "Someone" };
  return { agent: true, name: label === "Easel" ? assistantName : label };
}

/** "Run Rack fitting clip for the City 3 for Priya Nair" already says who it's for in the column beside it. */
const titleOf = (a: Approval) => (a.requester_name ? a.title.replace(new RegExp(`\\s+for ${a.requester_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "") : a.title);

/** The row's columns: who, the thumbnail, what, when, the cost, then the actions and the toggle. One template, so they line up. */
const COLS = "md:grid md:grid-cols-[11rem_2rem_minmax(0,1fr)_6.5rem_4.5rem_14rem] md:items-center md:gap-x-4";

function RowSkeleton() {
  return (
    <li aria-hidden className={cn("flex min-h-12 items-center gap-3 px-4 py-2", COLS)}>
      <span className="flex items-center gap-2"><Skeleton className="size-6 rounded-full" /><Skeleton className="h-4 w-24" /></span>
      <Skeleton className="size-8 rounded-md max-md:hidden" />
      <Skeleton className="h-4 w-56" />
      <Skeleton className="h-3 w-16 max-md:hidden" />
      <Skeleton className="h-4 w-12 justify-self-end max-md:hidden" />
      <span className="flex gap-2 max-md:hidden"><Skeleton className="h-7 w-16" /><Skeleton className="h-7 w-20" /></span>
    </li>
  );
}

function ApprovalRow({ approval: a, appName, assistantName, shared, onLeave }: {
  approval: Approval; appName: string; assistantName: string;
  /** The sentence said once above the list, so the row doesn't repeat it. */ shared: string;
  onLeave: (id: number) => void;
}) {
  const { client } = useAgents();
  const me = useMe();
  const payload = (a.payload ?? {}) as Record<string, unknown>;
  const runId = Number(payload.run_id ?? 0);
  const run = useLoad(() => (runId ? api.run(runId) : Promise.resolve(null)), [runId]);
  const field = a.editable_field || "";
  const current = field ? payload[field] : undefined;
  const isNumber = typeof current === "number";
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(current ?? ""));
  const [busy, setBusy] = useState<"" | "approve" | "decline">("");
  const [failure, setFailure] = useState("");
  const expired = a.status === "expired" || (a.status === "pending" && !!a.expires_at && a.expires_at <= Date.now());
  const pending = a.status === "pending" && !expired;
  const status = expired ? STATUS.expired : (STATUS as Partial<Record<string, StatusView>>)[a.status] ?? STATUS.pending;
  const actor = actorOf(a, appName, assistantName);
  const forWhom = a.user_id === me.id ? "you" : a.requester_name || "a teammate";
  const words = requestWords(titleOf(a));
  const view = run.data;
  const name = view?.run.title || words.name;
  const cost = view ? dollars(view.run.estimate) : words.cost;
  const note = !isNumber && field && !pending ? String(current ?? "") : a.preview && a.preview !== shared ? a.preview : "";
  const first = view?.steps[0];
  const fromAsset = Number(first?.input?.from_asset ?? 0);
  const makes = MAKES.find((k) => view?.steps.some((s) => s.kind === k)) ?? "text";
  const detailId = `approval-${a.id}-detail`;

  async function decide(kind: "approve" | "decline") {
    setBusy(kind);
    setFailure("");
    try {
      const changed = editing && value !== String(current ?? "");
      if (kind === "approve") await client.approve(a.id, changed ? value : undefined);
      else await client.decline(a.id);
      toast.success(kind === "approve" ? `Approved: ${name}.` : "Declined. Nothing happened, and nothing was charged.");
      onLeave(a.id);
    } catch (e) {
      // A refusal from the action itself (a permission, a limit) says what to do; the request stays waiting.
      setFailure(e instanceof Error ? e.message : "That didn't go through. Try again.");
      setOpen(true);
    } finally {
      refreshPendingCount();
      setBusy("");
    }
  }

  const who = actor.agent ? (
    <span className="flex min-w-0 items-center gap-2" data-testid="approval-actor" title={`${actor.name}, for ${forWhom}`}>
      <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-[28%] bg-agent-wash text-agent-text">{a.source === "mcp" ? <Bot className="size-3.5" /> : <Sparkles className="size-3.5" />}</span>
      <span className="min-w-0 truncate"><span className="font-medium text-agent-text">{actor.name}</span><span className="text-muted-foreground"> for {forWhom === "you" ? "you" : forWhom.split(" ")[0]}</span></span>
    </span>
  ) : (
    <span className="flex min-w-0 items-center gap-2" data-testid="approval-actor" title={actor.name}>
      <Avatar name={actor.name} size="sm" decorative />
      <span className="min-w-0 truncate font-medium">{a.user_id === me.id ? "You" : actor.name}</span>
    </span>
  );

  return (
    <article data-testid="approval-card" data-status={a.status} className="border-t text-body">
      <div className={cn("flex min-h-12 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2", COLS)}>
        {/* Phone: who and when on the first line, then the thumbnail and what, then the buttons. */}
        <div className="flex min-w-0 flex-1 basis-full items-center gap-2 md:contents">
          {who}
          <span className="ml-auto shrink-0 text-caption text-muted-foreground tabular-nums md:hidden">{cost}</span>
        </div>
        <span className="max-md:hidden">
          {fromAsset > 0 ? <FromPicture assetId={fromAsset} kind={makes} className="size-8" /> : runId ? <KindTile kind={makes} /> : <span aria-hidden className="block size-8" />}
        </span>
        <p className="min-w-0 flex-1 basis-full truncate font-medium md:basis-auto" title={name}>
          {runId ? <Link to={a.link || `/runs/${runId}`} className="focus-ring rounded-sm hover:underline">{name}</Link> : name}
          {view && <span className="font-normal text-muted-foreground"> · {view.steps.length} {view.steps.length === 1 ? "step" : "steps"}</span>}
        </p>
        <span className="text-caption text-muted-foreground tabular-nums max-md:hidden">
          {pending ? <Ago value={a.created_at} /> : <Ago value={a.decided_at ?? a.expires_at ?? a.created_at} />}
        </span>
        <span className="text-right font-medium tabular-nums max-md:hidden" data-testid="approval-cost">{cost || "–"}</span>
        <div className="flex basis-full items-center gap-2 md:basis-auto md:justify-end">
          {pending ? (
            <>
              <Button size="sm" variant="ghost" className="max-md:flex-1" onClick={() => void decide("decline")} disabled={!!busy} data-testid="approval-decline">Decline</Button>
              <Button size="sm" variant="outline" className="max-md:flex-1" onClick={() => void decide("approve")} disabled={!!busy || (editing && !value.trim())} data-testid="approval-approve">
                <Check aria-hidden />{busy === "approve" ? "Approving…" : field ? a.approve_label || "Approve" : "Approve"}
              </Button>
            </>
          ) : <StatusBadge tone={status.tone} dot>{status.label}</StatusBadge>}
          <Button size="icon" variant="ghost" className="size-8 text-muted-foreground max-md:size-11" aria-expanded={open} aria-controls={detailId}
            aria-label={open ? "Hide the details" : "Show the details"} onClick={() => setOpen((o) => !o)} data-testid="approval-toggle">
            <ChevronDown aria-hidden className={cn("transition-transform duration-150", open && "rotate-180")} />
          </Button>
        </div>
      </div>
      {open && (
        <div id={detailId} className="grid gap-3 border-t border-dashed bg-muted/25 px-4 py-3 animate-in fade-in duration-150 md:pl-[15rem]">
          {editing && !isNumber ? (
            <Textarea value={value} onChange={(e) => setValue(e.target.value)} rows={4} aria-label={`Edit ${field}`} className="max-w-prose" />
          ) : note ? <p className="max-w-prose text-pretty whitespace-pre-wrap text-muted-foreground">{note}</p> : null}
          {isNumber && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, " ")}:</span>
              {editing
                ? <input type="number" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`Edit ${field}`} className="h-8 w-32 rounded-md border bg-background px-2 tabular-nums focus-ring" />
                : <span className="font-medium tabular-nums">{String(current)}</span>}
            </div>
          )}
          {failure && <p role="alert" className="text-destructive">{failure}</p>}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-caption text-muted-foreground">
            {pending && field && !editing && <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={!!busy} data-testid="approval-edit">Edit before approving</Button>}
            {view && <span>Charged to {forWhom === "you" ? "your" : `${forWhom.split(" ")[0]}'s`} budget, for what it uses</span>}
            <span>{pending ? "Asked " : `${status.label} `}<Ago value={pending ? a.created_at : a.decided_at ?? a.expires_at ?? a.created_at} /></span>
            {a.link && <Link to={a.link} className="focus-ring inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground hover:underline max-md:min-h-11">See it in context<ArrowUpRight aria-hidden className="size-3.5" /></Link>}
          </div>
        </div>
      )}
    </article>
  );
}

export function ApprovalsPage({ appName, assistantName }: { appName: string; assistantName: string }) {
  const { client } = useAgents();
  const [view, setView] = useState<View>("pending");
  const [page, setPage] = useState<Awaited<ReturnType<Client["approvals"]>> | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Decided here: folded away now, and kept out until the list has reloaded without them.
  const [gone, setGone] = useState<ReadonlySet<number>>(new Set());
  const load = useCallback(() => {
    setError(null);
    client.approvals(view).then(setPage, setError);
  }, [client, view]);
  useEffect(() => { setPage(null); load(); }, [load]);
  const { leaving, leave } = useLeaving(useCallback((id: number) => { setGone((g) => new Set(g).add(id)); load(); }, [load]));
  const items = (page?.items ?? []).filter((a) => !gone.has(a.id));
  const arrived = useArrivals(page ? items.map((a) => a.id) : null);
  const waiting = usePendingApprovals();
  // The sidebar's count moves when someone decides elsewhere: follow it.
  useEffect(() => { if (view === "pending" && page && waiting !== page.itemsTotal) load(); }, [waiting]); // eslint-disable-line react-hooks/exhaustive-deps
  const shared = sharedNote(items);
  const shown = items.filter((a) => !leaving.has(a.id)).length;
  return (
    <div data-testid="approvals-page" className="flex flex-col gap-5">
      <PageHeader title="Approvals"
        description={`What waits for your OK: ${assistantName} and connected agents asking first, members' videos, and runs over the approval line.`} />
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Segmented label="Show" value={view} onChange={setView} className="max-md:[&_button]:min-h-11"
            options={[{ value: "pending", label: "Waiting for you", count: waiting || undefined }, { value: "decided", label: "Decided" }]} />
          {shared && shown > 0 && (
            <p className="flex min-w-0 flex-1 basis-72 items-center gap-2 text-caption text-pretty text-muted-foreground" data-testid="approvals-policy">
              <ShieldCheck aria-hidden className="size-4 shrink-0" />{shared}
            </p>
          )}
        </div>
        {error ? <LoadError title="Your approvals didn't load" error={error} onRetry={load} />
          : !page ? <ul aria-hidden className="divide-y rounded-lg border bg-card"><RowSkeleton /><RowSkeleton /><RowSkeleton /></ul>
          : !shown ? (view === "pending"
            ? <EmptyState icon={CheckCheck} title="Nothing is waiting for you"
                description={`When ${assistantName} or a connected agent wants to do something costly, or a member's video needs an OK, it asks here first, and nothing happens until you say yes.`}
                action={<Button asChild size="sm" variant="outline" className="max-md:min-h-11"><Link to="/agents"><Plug />Connect an agent</Link></Button>} />
            : <EmptyState title="Nothing decided yet" description="Requests you approve or decline stay here, with when." />)
          : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <div aria-hidden className={cn("h-9 items-center border-b bg-muted/30 px-4 text-caption font-medium text-muted-foreground max-md:hidden", COLS)}>
                <span>Asked by</span><span /><span>Run</span><span>{view === "pending" ? "Asked" : "Decided"}</span><span className="text-right">Estimate</span><span />
              </div>
              <ul data-testid="approvals-list" className="[&>li:first-child_article]:border-t-0">
                {items.map((a) => (
                  <li key={a.id}>
                    <Fold gone={leaving.has(a.id)} arrived={arrived.has(a.id)}>
                      <ApprovalRow approval={a} appName={appName} assistantName={assistantName} shared={shared} onLeave={leave} />
                    </Fold>
                  </li>
                ))}
              </ul>
            </div>
          )}
      </div>
    </div>
  );
}
