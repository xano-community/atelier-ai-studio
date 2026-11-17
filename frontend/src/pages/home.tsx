// Home: what's running, what was just made, how much of the month's budget is used, the team's most-run recipes, and what
// Easel and people's connected agents did. An admin sees the team's spend and every run waiting for approval; a member their
// own spend and their own waiting runs; a guest the approved library and Knowledge. Under what's running, "Waiting on you"
// lists the three oldest drafts nobody has approved, with how long each has waited and an Approve beside it for those who
// may: approving one folds its row away and the next oldest fades in. Runs move from running to done on a live frame,
// without a reload. "Run a recipe" is the one filled button; everything else on the page is quiet.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowRight, AudioLines, BookOpen, Check, CheckCheck, CookingPot, FileText, FlaskConical, ImageIcon, Loader2, MessageCircleQuestion, Music, Play, Plug, ShieldAlert, Video } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@xano-sdk/rbac/react";
import { Ago, Avatar, FirstRun, LoadError, PageHeader, Panel, PanelList, PanelRow, StatCard, openCommandPalette, useLoad, type FirstRunStep } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { AssetTileSkeleton, AssetTileView } from "@/components/studio/asset-tile";
import { AiStatusNotice, PaidPlanNotice } from "@/components/studio/ai-status";
import { KindTile } from "@/components/studio/kind-icon";
import { AgentBy, AgentGlyph } from "@/components/studio/agent-mark";
import { usePicture } from "@/components/studio/asset-tile";
import { Fold, useArrivals, useLeaving } from "@/components/studio/motion";
import { useLive } from "@/base/live";
import { ActivityFeed } from "@/base/activity";
import { useMe } from "@/base/session";
import { secondsWords } from "@/lib/catalog";
import { libraryApi } from "@/lib/library";
import { dollars, share, usageApi, weekOfSpend, type Home, type HomeRun, type HomeStep } from "@/lib/usage";
import { ageWords } from "@/lib/waiting";
import type { PlaygroundCatalog } from "@/lib/catalog";
import { cn } from "@/lib/utils";

const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };
const today = () => new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

/** What a working step is doing, in a few words. */
const DOING: Record<string, string> = {
  text: "writing", image: "making the image", video: "making the video", music: "making the music", speech: "recording the voice",
  transcribe: "transcribing", embedding: "reading Knowledge", rerank: "ranking passages",
};

/** Seconds since `from`, ticking every second while something is on screen. */
function useSecondsSince(from: number[]) {
  const [now, setNow] = useState(() => Date.now());
  const any = from.length > 0;
  useEffect(() => {
    if (!any) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [any]);
  return (at: number) => Math.max(0, (now - at) / 1000);
}

/**
 * The first-run check (POST studio/storage-check), made once per workspace by the first admin who opens Home: whether this
 * plan keeps video, music and speech files, and how made files are shown here. Nothing calls a model.
 */
let storageChecking = false;
function useStorageCheck(d: Home | null, reload: () => void) {
  const isAdmin = useCan("team.manage");
  useEffect(() => {
    if (!d || !isAdmin || d.storage_checked || storageChecking) return;
    storageChecking = true;
    usageApi.storageCheck().then(reload, () => { storageChecking = false; });
  }, [d, isAdmin, reload]);
}

export function HomePage() {
  const me = useMe();
  const home = useLoad(() => usageApi.home(), []);
  useLive(["ai_run", "ai_step", "kb_source", "asset", "recipe", "budget", "settings", "price"], home.reload);
  // A socket can miss a frame: while something runs, a slow poll keeps the list honest.
  const busy = !!home.data && (home.data.running.length > 0 || home.data.ingesting.length > 0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => document.visibilityState === "visible" && home.reload(), 10_000);
    return () => clearInterval(t);
  }, [busy]); // eslint-disable-line react-hooks/exhaustive-deps

  const d = home.data;
  const guest = d ? !d.can_run : false;
  useStorageCheck(d, home.reload);
  const first = me.name.split(" ")[0];
  return (
    <div className="flex flex-col gap-5" data-testid="home" data-role={d?.role}>
      <PageHeader title={`${greeting()}, ${first}`} description={today()}
        actions={!d ? null : guest ? (
          <Button size="sm" asChild><Link to="/knowledge"><MessageCircleQuestion aria-hidden />Ask Knowledge</Link></Button>
        ) : (
          <>
            <Button size="sm" variant="outline" asChild><Link to="/playground"><FlaskConical aria-hidden />Open Playground</Link></Button>
            <Button size="sm" asChild><Link to="/recipes"><Play aria-hidden />Run a recipe</Link></Button>
          </>
        )} />
      {d && d.ai_status !== "on" && (
        <AiStatusNotice status={d.ai_status as PlaygroundCatalog["ai_status"]} reason={d.ai_status_reason} fix={d.fix_command} onChanged={home.reload} />
      )}
      {d && d.ai_status === "on" && !d.plan_paid_storage && !guest && <PaidPlanNotice />}
      {home.error && !d ? <LoadError title="Home didn't load" error={home.error} onRetry={home.reload} /> : (
        <>
          {d && <FirstSteps data={d} />}
          <Stats data={d} />
          {guest ? <GuestBody /> : <MemberBody data={d} reload={home.reload} />}
        </>
      )}
    </div>
  );
}

const LAUNCH_KIT = "Product launch kit", LAUNCH_KIT_SLUG = "product-launch-kit";
const FREE_PLAN_RECIPE = "Product page copy and photo", FREE_PLAN_SLUG = "product-page-copy-and-photo";
/** A recipe's page when the team has it, or the list to pick from. */
const recipeHref = (d: Home, slug: string) => (d.recipes.some((r) => r.slug === slug) ? `/recipes/${slug}` : "/recipes");

const seen = (k: string) => { try { return localStorage.getItem(`seen:${k}`) === "1"; } catch { return false; } };
const mark = (k: string) => { try { localStorage.setItem(`seen:${k}`, "1"); } catch { /* storage off */ } };

/** The first things worth doing here, each done when the data says so. */
function FirstSteps({ data: d }: { data: Home }) {
  const me = useMe();
  const canSeeUsage = useCan("usage.read");
  const navigate = useNavigate();
  const guest = !d.can_run;
  const steps: FirstRunStep[] = guest ? [
    { id: "library", title: "Look through approved work", description: "Every item says how it was made: the prompt, the model and who made it.", onClick: () => { mark("library"); navigate("/library"); }, done: seen("library") },
    { id: "ask", title: "Ask Knowledge a question", description: "Answers come from the team's documents and recordings, each one cited.", href: "/knowledge", done: d.started.ask },
    { id: "palette", title: "Find anything with ⌘K", description: "Jump to a screen, an item or an action from the keyboard.", onClick: () => { mark("palette"); openCommandPalette(); }, done: seen("palette") },
  ] : [
    { id: "playground", title: "Try a model in the Playground", description: "Write, draw, film, speak or transcribe, and see what each run costs.", href: "/playground", done: d.started.playground },
    d.plan_paid_storage
      ? { id: "recipe", title: `Run the ${LAUNCH_KIT}`, description: "Copy, a hero image, an 8 s video, a voiceover and music in one go, charged to your budget.", href: recipeHref(d, LAUNCH_KIT_SLUG), done: d.started.recipe }
      : { id: "recipe", title: `Run ${FREE_PLAN_RECIPE}`, description: "Product page words and a studio photo: text and images run on every plan.", href: recipeHref(d, FREE_PLAN_SLUG), done: d.started.recipe },
    { id: "ask", title: "Ask Knowledge a question", description: "Answers come from the team's documents and recordings, each one cited.", href: "/knowledge", done: d.started.ask },
    canSeeUsage
      ? { id: "usage", title: "Open Usage", description: "What the month cost by person, kind and model, and the budgets that keep it in check.", onClick: () => { mark("usage"); navigate("/usage"); }, done: seen("usage") }
      : { id: "palette", title: "Find anything with ⌘K", description: "Jump to a screen, a recipe, an item or an action from the keyboard.", onClick: () => { mark("palette"); openCommandPalette(); }, done: seen("palette") },
  ];
  return <FirstRun storageKey={`first-run:${me.id}`} title="Get to know Atelier" steps={steps} />;
}

function Stats({ data: d }: { data: Home | null }) {
  const loading = !d;
  const card = "max-sm:p-3";
  if (d && !d.can_run) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        <StatCard className={card} label="Approved for use" value={d.approved} href="/library?approved=1" hint="Work the team has signed off" />
        <StatCard className={card} label="Knowledge" value={`${d.sources} ${d.sources === 1 ? "source" : "sources"}`} href="/knowledge" hint={recordingWords(d)} />
      </div>
    );
  }
  const team = d?.team;
  const money = team ?? d?.mine;
  const used = money ? money.spent + money.reserved : 0;
  const week = d ? weekOfSpend(d.spend_days) : undefined;
  return (
    <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-4">
      <StatCard className={card} loading={loading}
        label={team ? "Spent this month" : "Your spend this month"}
        value={money ? dollars(money.spent) : ""}
        href={team ? "/usage" : undefined}
        trend={week && week.some((v) => v > 0) ? week : undefined}
        hint={!money ? undefined : `${Math.round(share(used, money.budget))}% of ${dollars(money.budget)}${team ? " team budget" : ""}${money.reserved > 0 ? ` · ${dollars(money.reserved)} held` : ""}`} />
      {/* A short label, so the trend has room for its words ("+7 on last week"). */}
      <StatCard className={card} loading={loading} label="Runs" value={d?.runs_week ?? 0}
        delta={d ? { value: d.runs_week - d.runs_last_week, label: "the week before", short: "on last week" } : undefined}
        hint={d ? `${d.runs_last_week} the week before` : undefined} />
      {/* What's waiting for a look, not a total: the drafts someone can approve. */}
      <StatCard className={card} loading={loading} label="Drafts waiting" value={d ? d.assets - d.approved : 0} href="/library?status=drafts"
        hint={d ? `${d.approved} of ${d.assets} in the Library approved` : undefined} />
      <StatCard className={card} loading={loading} label="Knowledge" value={d ? `${d.sources} ${d.sources === 1 ? "source" : "sources"}` : ""} href="/knowledge/sources"
        hint={d ? recordingWords(d) : undefined} />
    </div>
  );
}

function recordingWords(d: Home): string {
  // A source that failed is counted, and said plainly: it needs someone to add it again.
  if (d.failed_sources) return `${d.failed_sources} ${d.failed_sources === 1 ? "needs" : "need"} attention`;
  if (!d.recordings) return d.sources ? "Documents to answer from" : "Nothing added yet";
  const h = Math.floor(d.recording_seconds / 3600), m = Math.round((d.recording_seconds % 3600) / 60);
  const length = h ? `${h} h ${m} min` : `${m} min`;
  return `${d.recordings} ${d.recordings === 1 ? "recording" : "recordings"}, ${length}`;
}

function MemberBody({ data: d, reload }: { data: Home | null; reload: () => void }) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-4">
        <RunningNow data={d} />
        <WaitingOnYou data={d} reload={reload} />
        <RecentlyMade approvedOnly={false} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <AgentActivity data={d} />
        <TeamRecipes data={d} />
        <ActivityFeed title="Team activity" limit={5} entities={["asset", "ai_run", "recipe", "kb_source", "brand"]} />
      </div>
    </div>
  );
}

/**
 * What Easel and people's connected agents did lately ("Claude Code drafted Trail 2 newsletter blurb · for Sam"), with the way to
 * connect one: the same tools Easel has, from Claude, ChatGPT or your own code, charged to the person who connects it.
 */
function AgentActivity({ data: d }: { data: Home | null }) {
  const rows = d?.agent_activity ?? [];
  // Anyone who runs AI can connect an agent of their own; it spends from their budget.
  const canConnect = useCan("studio.run");
  return (
    <Panel title="Agent activity" action={{ href: "/agents", label: "Agents" }} data-kit="agent-activity">
      {!d ? <PanelList loading rows={2} /> : (
        <>
          {rows.length > 0 && (
            <PanelList>
              {rows.map((a) => (
                <PanelRow key={a.id} href={a.link || undefined} className="items-start py-2.5" data-kit="agent-row">
                  <AgentGlyph size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body text-pretty" title={`${a.via} ${a.title}, for ${a.actor_name}`}>
                      <span className="font-medium">{a.via}</span> {a.title}
                    </span>
                    <span className="block text-caption text-muted-foreground">for {a.actor_name.split(" ")[0]} · <Ago value={a.created_at} /></span>
                  </span>
                </PanelRow>
              ))}
            </PanelList>
          )}
          {rows.length === 0 ? (
            <div className="flex flex-col items-start gap-3 p-4" data-testid="connect-agent">
              <p className="text-body text-pretty text-muted-foreground">
                Claude, ChatGPT or your own code can run recipes, generate and find work here, with your budget and approvals. What they do shows here.
              </p>
              {canConnect && <Button size="sm" variant="outline" asChild><Link to="/agents"><Plug aria-hidden />Connect an agent</Link></Button>}
            </div>
          ) : canConnect && (
            <div className="flex min-h-12 items-center gap-3 border-t px-4 py-2" data-testid="connect-agent">
              <p className="min-w-0 flex-1 text-caption text-pretty text-muted-foreground">
                {d.agent_keys ? "Add another from Claude, ChatGPT or your own code." : "Your own agent's work shows here too."}
              </p>
              <Button size="sm" variant="outline" className="shrink-0" asChild><Link to="/agents"><Plug aria-hidden />Connect an agent</Link></Button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function GuestBody() {
  return (
    <div className="flex flex-col gap-4">
      <RecentlyMade approvedOnly title="Recently approved" />
      <section className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4" aria-label="Ask Knowledge">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-md border bg-muted/40 text-muted-foreground"><BookOpen className="size-4" /></span>
        <div className="min-w-56 flex-1">
          <h2 className="text-heading">Ask the team's Knowledge</h2>
          <p className="text-body text-pretty text-muted-foreground">Answers come only from the documents and recordings the team added, with each source cited.</p>
        </div>
        <Button size="sm" variant="outline" asChild><Link to="/knowledge">Ask a question</Link></Button>
      </section>
    </div>
  );
}

function RunningNow({ data: d }: { data: Home | null }) {
  const isAdmin = useCan("budgets.manage");
  const nameOf = useMemo(() => new Map((d?.people ?? []).map((p) => [p.id, p.name])), [d]);
  const stepsOf = useMemo(() => {
    const m = new Map<number, HomeStep[]>();
    for (const s of d?.steps ?? []) m.set(s.run_id, [...(m.get(s.run_id) ?? []), s]);
    return m;
  }, [d]);
  const since = useSecondsSince([...(d?.running ?? []), ...(d?.ingesting ?? [])].map((r) => r.created_at));
  const rows = d ? d.waiting.length + d.running.length + d.ingesting.length : 0;
  return (
    <Panel title="Running now" extra={<span className="text-caption text-muted-foreground">Updates live</span>} data-kit="running-now">
      <PanelList loading={!d} rows={2} empty="Nothing is running. Runs show here while they work, and leave when they end.">
        {rows > 0 && d?.waiting.map((r) => <WaitingRow key={`w-${r.id}`} run={r} owner={nameOf.get(r.owner_id) ?? "Someone"} isAdmin={isAdmin} />)}
        {rows > 0 && d?.running.map((r) => <RunningRow key={`r-${r.id}`} run={r} steps={stepsOf.get(r.id) ?? []} owner={nameOf.get(r.owner_id) ?? "Someone"} seconds={since(r.created_at)} />)}
        {rows > 0 && d?.ingesting.map((src) => (
          <PanelRow key={`k-${src.id}`} href="/knowledge/sources" data-kit="running-row">
            <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
            <span className="min-w-0 flex-1 truncate"><span className="font-medium">{src.title}</span> <span className="text-muted-foreground">· {src.kind === "recording" ? "transcribing the recording" : "reading and indexing"}</span></span>
            <span className="hidden shrink-0 rounded-sm border px-1.5 py-0.5 text-caption text-muted-foreground sm:inline">Knowledge</span>
            <Avatar name={nameOf.get(src.added_by) ?? "Someone"} size="sm" />
          </PanelRow>
        ))}
      </PanelList>
    </Panel>
  );
}

function RunningRow({ run, steps, owner, seconds }: { run: HomeRun; steps: HomeStep[]; owner: string; seconds: number }) {
  const working = steps.find((s) => s.status === "working");
  const at = working?.seq ?? steps.filter((s) => s.status !== "queued").length + 1;
  const where = steps.length > 1
    ? `step ${Math.min(at, steps.length)} of ${steps.length}${working ? `, ${DOING[working.kind] ?? "working"}` : ""}`
    : working ? DOING[working.kind] ?? "working" : run.status === "queued" ? "about to start" : "starting";
  return (
    <PanelRow href={`/runs/${run.id}`} data-kit="running-row">
      <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
      <span className="min-w-0 flex-1 line-clamp-2 sm:truncate" data-testid="running-run" data-id={run.id}><span className="font-medium">{run.title}</span> <span className="text-muted-foreground">· {where}</span></span>
      <span className="shrink-0 text-caption tabular-nums text-muted-foreground" aria-label={`Running for ${secondsWords(seconds)}`}>{secondsWords(seconds)}</span>
      <Avatar name={owner} size="sm" />
    </PanelRow>
  );
}

function WaitingRow({ run, owner, isAdmin }: { run: HomeRun; owner: string; isAdmin: boolean }) {
  const confirm = run.status !== "waiting_approval";
  const cost = run.estimate ? `, about ${dollars(run.estimate)}` : "";
  const words = confirm ? `waiting for your confirmation${cost}`
    : isAdmin ? `${run.reason === "over_budget" ? `over ${owner.split(" ")[0]}'s budget` : `${owner.split(" ")[0]} needs your approval`}${cost}`
    : `waiting for an admin${cost}`;
  return (
    <li data-kit="running-row" className="flex min-h-11 items-center gap-3 px-4 py-2 text-body">
      <ShieldAlert aria-hidden className="size-4 shrink-0 text-warning" />
      <span className="min-w-0 flex-1 line-clamp-2 sm:truncate" data-testid="waiting-run" data-id={run.id}><span className="font-medium">{run.title}</span> <span className="text-muted-foreground">· {words}</span></span>
      <Link to={`/runs/${run.id}`} className="focus-ring inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1 text-body font-medium text-foreground underline-offset-4 hover:underline">
        {isAdmin && !confirm ? "Review" : confirm ? "Confirm" : "Open"}<ArrowRight aria-hidden className="size-3.5" />
      </Link>
    </li>
  );
}

type Draft = Home["oldest_drafts"][number];
const DRAFT_ICON = { image: ImageIcon, video: Video, music: Music, speech: AudioLines, text: FileText, transcript: FileText } as const;

/** A draft at 32 px: its picture, or its kind's icon on the muted tile every list uses. */
function DraftThumb({ draft }: { draft: Draft }) {
  const pic = usePicture(draft.id, draft.thumb, draft.thumb_blob);
  const Icon = DRAFT_ICON[draft.kind as keyof typeof DRAFT_ICON] ?? FileText;
  return (
    <span aria-hidden className="relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted/40 text-muted-foreground">
      {pic.src ? <img src={pic.src} alt="" onError={pic.expired} className="absolute inset-0 size-full object-cover" /> : <Icon className="size-4" />}
    </span>
  );
}

/**
 * The drafts that have waited longest for someone to approve them: the three oldest, each with who made it (an agent's work
 * in violet, "Claude Code, for Sam"), how long it has waited, a link to the item, and Approve for those who may. The panel's
 * link opens the Library on every draft. Shown to whoever may approve library items.
 */
function WaitingOnYou({ data: d, reload }: { data: Home | null; reload: () => void }) {
  const canApprove = useCan("library.approve");
  const [busy, setBusy] = useState(0);
  const { leaving, leave } = useLeaving(useCallback(() => reload(), [reload]));
  const drafts = d?.oldest_drafts ?? [];
  const arrived = useArrivals(d ? drafts.map((x) => x.id) : null);
  if (!canApprove) return null;
  const waiting = d ? d.assets - d.approved : 0;
  const approve = async (draft: Draft) => {
    setBusy(draft.id);
    try {
      await libraryApi.approve(draft.id);
      toast.success(`Approved ${draft.title || "the draft"}. The team can use it now.`);
      leave(draft.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "It wasn't approved. Try again.");
    } finally {
      setBusy(0);
    }
  };
  return (
    <Panel title="Waiting on you" data-kit="waiting-on-you"
      action={waiting > 0 ? { href: "/library?status=drafts", label: `All ${waiting} ${waiting === 1 ? "draft" : "drafts"}` } : undefined}>
      {!d ? <PanelList loading rows={3} /> : drafts.length === 0 ? (
        <p className="flex items-center gap-2 p-4 text-body text-muted-foreground"><CheckCheck aria-hidden className="size-4 shrink-0" />Nothing is waiting for your approval. New drafts show here, oldest first.</p>
      ) : (
        <ul>
          {drafts.map((x, i) => {
            const age = ageWords(x.created_at);
            return (
              <li key={x.id} data-kit="waiting-draft" data-id={x.id}>
                <Fold gone={leaving.has(x.id)} arrived={arrived.has(x.id)}>
                  <div className={cn("flex min-h-12 items-center gap-3 pr-3", i > 0 && "border-t")}>
                    <Link to={`/library/${x.id}`} className="focus-ring-inset flex min-w-0 flex-1 items-center gap-3 self-stretch py-1.5 pl-4 transition-colors hover:bg-muted/50"
                      title={`${x.title || "Untitled"}, waiting ${age}`}>
                      <DraftThumb draft={x} />
                      <span className="grid min-w-0 flex-1">
                        <span className="truncate text-body font-medium">{x.title || "Untitled"}</span>
                        <span className="flex min-w-0 text-caption text-muted-foreground">
                          {x.agent ? <AgentBy agent={x.agent} person={x.maker_name} /> : <span className="truncate">{x.maker_name || "Someone"}</span>}
                          <span className="shrink-0 whitespace-pre tabular-nums sm:hidden"> · {age}</span>
                        </span>
                      </span>
                      <span className="shrink-0 text-caption text-muted-foreground tabular-nums max-sm:hidden" aria-label={`Waiting ${age}`}>{age}</span>
                    </Link>
                    <Button size="sm" variant="outline" className="shrink-0" disabled={busy === x.id || leaving.has(x.id)} onClick={() => void approve(x)} data-testid="waiting-approve">
                      <Check aria-hidden />Approve
                    </Button>
                  </div>
                </Fold>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function RecentlyMade({ approvedOnly, title = "Recently made" }: { approvedOnly: boolean; title?: string }) {
  const navigate = useNavigate();
  const canRun = useCan("studio.run");
  const list = useLoad(() => libraryApi.list({ kind: "all", approved: approvedOnly, maker: 0, recipe: 0 }, 1, 3), [approvedOnly]);
  useLive("asset", list.reload);
  const items = list.data?.items ?? [];
  return (
    <Panel title={title} action={{ href: approvedOnly ? "/library?approved=1" : "/library", label: "Open Library" }} data-kit="recently-made">
      {list.error && !list.data ? <LoadError error={list.error} onRetry={list.reload} className="m-3" />
        : !list.data ? <div aria-hidden className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <div key={i} className={cn(i === 2 && "max-sm:hidden")}><AssetTileSkeleton /></div>)}</div>
        : items.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
            <p className="font-medium">{approvedOnly ? "Nothing approved yet" : "Nothing made yet"}</p>
            <p className="max-w-sm text-body text-pretty text-muted-foreground">{approvedOnly ? "Work the team approves for use shows here." : "Everything you generate lands here, with how it was made."}</p>
            {canRun && !approvedOnly && <Button size="sm" className="mt-3" asChild><Link to="/playground">Open Playground</Link></Button>}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3">
            {items.map((t, i) => <div key={t.id} className={cn("min-w-0", i === 2 && "max-sm:hidden")}><AssetTileView tile={t} active={false} wide onOpen={(id) => navigate(`/library/${id}`)} /></div>)}
          </div>
        )}
    </Panel>
  );
}

function TeamRecipes({ data: d }: { data: Home | null }) {
  const canEdit = useCan("recipes.manage");
  const top = useMemo(() => {
    if (!d) return [];
    const runs = new Map(d.recipe_runs.map((r) => [r.recipe_id, r.runs]));
    return d.recipes.map((r) => ({ ...r, runs: runs.get(r.id) ?? 0 })).sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)).slice(0, 5);
  }, [d]);
  return (
    <Panel title="Team recipes" action={d && d.recipe_count > 0 ? { href: "/recipes", label: `All ${d.recipe_count}` } : undefined} data-kit="team-recipes">
      {!d ? <PanelList loading rows={4} /> : top.length === 0 ? (
        <div className="flex flex-col items-start gap-2 p-4">
          <p className="text-body text-pretty text-muted-foreground">
            {d.recipe_count ? "No recipe has run yet. The ones the team runs most show here." : "No recipes yet. A recipe saves a Playground setup as steps anyone on the team can run."}
          </p>
          {d.recipe_count > 0 ? <Button size="sm" variant="outline" asChild><Link to="/recipes"><CookingPot aria-hidden />See the recipes</Link></Button>
            : canEdit ? <Button size="sm" variant="outline" asChild><Link to="/recipes/new"><CookingPot aria-hidden />New recipe</Link></Button> : null}
        </div>
      ) : (
        <PanelList>
          {top.map((r) => (
            <PanelRow key={r.id} href={`/recipes/${r.slug}`} className="min-h-14 py-2.5">
              <KindTile kind={r.lead_kind || "text"} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{r.name}</span>
                {r.description && <span className="block truncate text-caption text-muted-foreground" title={r.description}>{r.description}</span>}
              </span>
              <span className="shrink-0 text-caption tabular-nums text-muted-foreground">{r.runs} {r.runs === 1 ? "run" : "runs"}</span>
            </PanelRow>
          ))}
        </PanelList>
      )}
    </Panel>
  );
}
