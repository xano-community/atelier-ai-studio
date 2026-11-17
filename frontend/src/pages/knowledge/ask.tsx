// /knowledge: Ask. A question is answered only from the team's sources, and the answer cites each passage it used: a
// numbered chip in the text, and the passage below it with its source, page or moment, and for a recording a way to
// play from there. The answer takes several seconds (embed, find, write), so the screen says which part it's on. The
// page is a reading column and a rail: the question, a source that couldn't be read (with what fixes it), your newest
// answered question open with its kept answer and cited passages (read back, never asked again), a few questions written
// for the team's sources under it (first, for someone who hasn't asked anything yet), and your own recent questions (each
// reopens its answer); beside it, the sources themselves with where each stands, and Add a source at their head. On a
// phone the rail goes below.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowRight, BookOpen, CircleAlert, CornerDownLeft, RotateCw, Search, SearchX, Sparkles, Upload } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@xano-sdk/rbac/react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Ago, EmptyState, LoadError, PageHeader, useHotkey, useLoad } from "@/components/kit";
import { AiOffNotice, useAiState } from "@/components/studio/ai-status";
import { useLive } from "@/base/live";
import { useMe } from "@/base/session";
import {
  answerKept, answerLine, citedNumbers, citedSources, clock, knowledgeApi, modelName, spentWords, starterQuestions, type Answer, type Asked, type Citation, type Source,
} from "@/lib/knowledge";
import { Prose } from "@/components/studio/prose";
import { cn } from "@/lib/utils";
import { AddButton, KnowledgeTabs, PlayFrom, SourceIcon, SourceStatus, TEAM_WIDE, UploadRows, aboutSource, useAddSources, useSources } from "./parts";

const KEPT = "knowledge:last-answer";
const keyOf = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
const remembered = (): { question: string; answer: Answer } | null => {
  try { const v = sessionStorage.getItem(KEPT); return v ? JSON.parse(v) : null; } catch { return null; }
};
const remember = (v: { question: string; answer: Answer }) => { try { sessionStorage.setItem(KEPT, JSON.stringify(v)); } catch { /* storage off */ } };

export function KnowledgeAskPage() {
  const sources = useSources();
  const adder = useAddSources(sources.reload);
  const recent = useLoad(() => knowledgeApi.questions(), []);
  // A question asked elsewhere (by Easel for you, or in another tab) joins the list.
  useLive("ai_run", recent.reload);
  const all = sources.data?.items ?? [];
  const ready = all.filter((s) => s.status === "ready");
  const [question, setQuestion] = useState(() => remembered()?.question ?? "");
  const [asked, setAsked] = useState<{ question: string; key: string; at?: number } | null>(() => {
    const r = remembered();
    return r ? { question: r.question, key: keyOf() } : null;
  });
  const [answer, setAnswer] = useState<Answer | null>(() => remembered()?.answer ?? null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const top = useRef<HTMLDivElement>(null);
  useHotkey("/", (e) => { e.preventDefault(); input.current?.focus(); });

  // On arrival, with nothing asked yet this visit, your newest answered question is open: its kept answer and the passages
  // it cites, read back as they were (no new call). Someone with no past questions starts from the suggestions instead.
  const [settled, setSettled] = useState(() => answer !== null);
  const newest = recent.data?.items.find((a) => a.state === "answered");
  useEffect(() => {
    if (settled || !recent.data) return;
    setSettled(true);
    if (!newest) return;
    setAsked({ question: newest.question, key: keyOf(), at: newest.created_at });
    setAnswer(newest);
  }, [settled, recent.data, newest]);
  // Until the list says whether there is one, the answer's place is held, so the suggestions don't jump down under it.
  const opening = !settled && !recent.data && !recent.error;

  // The same key on a retry: a request that did reach the server answers with its first result, not a second charge.
  const send = async (q: string, key: string) => {
    setBusy(true); setError(null);
    try {
      const a = await knowledgeApi.ask(q, key);
      setAnswer(a); remember({ question: q, answer: a });
    } catch (e) { setError(e); }
    finally { setBusy(false); recent.reload(); }
  };
  const ask = (q: string) => {
    if (!q || busy) return;
    setSettled(true);
    const next = { question: q, key: keyOf() };
    setAsked(next);
    void send(next.question, next.key);
  };
  const submit = (e?: FormEvent) => { e?.preventDefault(); ask(question.trim()); };
  /** A past question: its kept answer again, at no cost; one that never got an answer is asked again. */
  const reopen = (a: Asked) => {
    setQuestion(a.question);
    top.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (!answerKept(a)) { ask(a.question); return; }
    setSettled(true);
    setError(null);
    setAsked({ question: a.question, key: keyOf(), at: a.created_at });
    setAnswer(a);
    remember({ question: a.question, answer: a });
  };

  const noneReady = !!sources.data && ready.length === 0;
  const { state: ai } = useAiState();
  const aiOff = !!ai && ai.ai_status !== "on";
  const canAsk = !busy && !noneReady && !aiOff;
  const starters = useMemo(() => starterQuestions(ready), [ready]);
  const failed = all.filter((s) => s.status === "failed");
  return (
    <div className="flex flex-col gap-5" data-testid="knowledge-ask" ref={top}>
      <PageHeader title="Knowledge" description="Ask anything about the team's brand and reference material. Every answer comes only from your sources and cites them.">
        <KnowledgeTabs value="ask" />
      </PageHeader>
      <AiOffNotice after="Asking and adding sources need AI." />
      <div className="grid items-start gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="flex flex-col gap-2">
            <form onSubmit={submit} role="search" className="flex min-h-11 items-center gap-2 rounded-lg border bg-card py-1 pr-1 pl-3 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/20">
              <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <label htmlFor="knowledge-question" className="sr-only">Your question</label>
              <input id="knowledge-question" ref={input} value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1000} autoComplete="off" data-testid="ask-input"
                placeholder={noneReady ? "Add a source first, then ask about it" : "Ask a question…"}
                className="h-9 min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-muted-foreground" />
              <Button type="submit" size="sm" disabled={!canAsk || !question.trim()} data-testid="ask-submit"
                title={aiOff ? "Asking is off until AI is on." : !question.trim() ? "Type a question first" : undefined}
                className="disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none">
                Ask<CornerDownLeft aria-hidden className="opacity-60 max-sm:hidden" />
              </Button>
            </form>
            <SourceLine loading={!sources.data && !sources.error} sources={all} />
          </div>
          {failed.length > 0 && <FailedSources sources={failed} adder={adder} onChanged={sources.reload} />}
          <AnswerArea busy={busy} asked={asked} answer={answer} error={error} onRetry={() => asked && void send(asked.question, asked.key)}
            empty={sources.error ? <LoadError title="Your sources didn't load" error={sources.error} onRetry={sources.reload} />
              : noneReady ? <NoSources canAdd={adder.canAdd} aiOff={adder.aiOff} onAdd={adder.pick} processing={all.length > 0} />
              : opening ? <AnswerSkeleton />
              : sources.data ? <Starters asks={starters} disabled={!canAsk} onPick={(q) => { setQuestion(q); ask(q); }} /> : <StartersSkeleton />}
            total={ready.length} />
          {answer && !busy && starters.length > 0 && (
            <Starters asks={starters.filter((q) => q !== asked?.question && q !== question)} disabled={!canAsk} onPick={(q) => { setQuestion(q); ask(q); }} />
          )}
          {!noneReady && <RecentQuestions load={recent} onOpen={reopen} disabled={busy} current={answer?.run_id ?? 0} />}
        </div>
        <SourcesRail sources={sources.data ? all : null} error={sources.error} onRetry={sources.reload} adder={adder} />
      </div>
    </div>
  );
}

/** One quiet line under the question: what answers come from, and what's still being read. */
function SourceLine({ loading, sources }: { loading: boolean; sources: Source[] }) {
  if (loading) return <Skeleton className="h-4 w-72" />;
  if (!sources.length) return null;
  const ready = sources.filter((s) => s.status === "ready").length;
  const reading = sources.filter((s) => s.status === "processing").length;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 px-1 text-caption text-muted-foreground tabular-nums" data-testid="source-summary">
      <span>Answers come only from the {ready} ready {ready === 1 ? "source" : "sources"}, and cite them</span>
      {reading > 0 && <><span aria-hidden>·</span><span>{reading} being read</span></>}
    </p>
  );
}

/**
 * A source that couldn't be read, as a row with what fixes it: Retry when only its embedding failed (whoever added it),
 * otherwise adding the file again, as its reason says. The title opens the source, with its full reason and Remove.
 */
function FailedSources({ sources, adder, onChanged }: { sources: Source[]; adder: ReturnType<typeof useAddSources>; onChanged: () => void }) {
  const me = useMe();
  const [retrying, setRetrying] = useState(0);
  const retry = async (s: Source) => {
    setRetrying(s.id);
    try { await knowledgeApi.retry(s.id, `${s.id}-failed-${s.created_at}`); toast.success("Retrying. It'll be ready in a moment."); onChanged(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "That didn't retry. Try again."); }
    finally { setRetrying(0); }
  };
  return (
    <ul aria-label="Sources that couldn't be read" className="flex flex-col gap-2" data-testid="failed-sources">
      {sources.map((s) => {
        const canRetry = s.can_retry && s.added_by === me.id;
        return (
          <li key={s.id} data-testid="failed-source" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5">
            <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" />
            <p className="min-w-56 flex-1 text-body text-pretty">
              <Link to={`/knowledge/sources?open=${s.id}`} className="focus-ring rounded-sm font-medium hover:underline">{s.title}</Link>
              <span className="text-muted-foreground"> {s.can_retry ? "isn't finished." : "couldn't be read."} {s.detail}</span>
            </p>
            {canRetry ? (
              <Button size="sm" variant="outline" disabled={retrying === s.id} onClick={() => void retry(s)} data-testid="failed-retry" className="max-md:min-h-11 max-sm:ml-7"><RotateCw />{retrying === s.id ? "Retrying…" : "Retry"}</Button>
            ) : !s.can_retry && adder.canAdd ? (
              <Button size="sm" variant="outline" disabled={adder.aiOff} onClick={adder.pick} data-testid="failed-upload" className="max-md:min-h-11 max-sm:ml-7"
                title={adder.aiOff ? "Adding a source is off until AI is on: reading it needs AI." : "Choose the file again, saved as text"}><Upload />Upload again</Button>
            ) : (
              <Button size="sm" variant="ghost" asChild className="text-muted-foreground max-md:min-h-11 max-sm:ml-7"><Link to={`/knowledge/sources?open=${s.id}`}>See why<ArrowRight /></Link></Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The sources beside the question, each with where it stands and a way to its record, and Add a source at their head. */
function SourcesRail({ sources, error, onRetry, adder }: { sources: Source[] | null; error: unknown; onRetry: () => void; adder: ReturnType<typeof useAddSources> }) {
  const ready = (sources ?? []).filter((s) => s.status === "ready").length;
  return (
    <aside aria-label="Sources" className="flex min-w-0 flex-col gap-2 lg:sticky lg:top-4" data-testid="sources-rail">
      <div className="flex min-h-8 items-center justify-between gap-2 px-1">
        <h2 className="text-caption font-medium text-muted-foreground">
          Sources{sources && sources.length > 0 && <span className="font-normal tabular-nums"> · {ready} of {sources.length} ready</span>}
        </h2>
        <AddButton adder={adder} size="sm" label="Add a source" />
      </div>
      <UploadRows adder={adder} />
      {error && !sources ? <LoadError title="Your sources didn't load" error={error} onRetry={onRetry} />
        : !sources ? (
          <div aria-hidden className="divide-y overflow-hidden rounded-lg border bg-card">
            {Array.from({ length: 5 }, (_, i) => <div key={i} className="flex items-center gap-2.5 px-3 py-2.5"><Skeleton className="size-4" /><Skeleton className="h-4 flex-1" /><Skeleton className="h-5 w-14" /></div>)}
          </div>
        ) : sources.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-caption text-pretty text-muted-foreground">No sources yet. PDFs, text and Markdown files, and recorded calls can be added.</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border bg-card">
            {sources.map((s) => (
              <li key={s.id}>
                <Link to={`/knowledge/sources?open=${s.id}`} data-testid="rail-source" title={s.title}
                  className="focus-ring-inset flex min-h-12 items-center gap-2.5 px-3 py-2 transition-colors hover:bg-muted/50">
                  <SourceIcon source={s} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-body">{s.title}</span>
                    <span className="truncate text-caption text-muted-foreground">{aboutSource(s)} · <Ago value={s.created_at} /></span>
                  </span>
                  <SourceStatus source={s} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      <div className="flex flex-col gap-1.5 px-1">
        <Link to="/knowledge/sources" className="focus-ring inline-flex w-fit items-center gap-1 rounded-sm text-caption font-medium text-primary-text hover:underline max-sm:min-h-11">
          Every source and its passages<ArrowRight aria-hidden className="size-3" />
        </Link>
        <p className="text-caption text-pretty text-muted-foreground">{TEAM_WIDE}</p>
      </div>
    </aside>
  );
}

/** Your own last few questions: the question, the answer's first line, what it cited, and when. Only you see them. */
function RecentQuestions({ load, onOpen, disabled, current }: {
  load: { data: { items: Asked[] } | null | undefined; error: unknown; reload: () => void }; onOpen: (a: Asked) => void; disabled: boolean; current: number;
}) {
  const items = load.data?.items;
  return (
    <section aria-labelledby="recent-questions" className="flex flex-col gap-1.5" data-testid="recent-questions">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <h2 id="recent-questions" className="text-caption font-medium text-muted-foreground">Your recent questions</h2>
        <span className="text-caption text-muted-foreground">Only you see these</span>
      </div>
      {load.error && !items ? <LoadError title="Your questions didn't load" error={load.error} onRetry={load.reload} />
        : !items ? (
          <div aria-hidden className="divide-y overflow-hidden rounded-lg border bg-card">
            {Array.from({ length: 3 }, (_, i) => <div key={i} className="flex flex-col gap-1.5 px-3 py-2.5"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-3.5 w-11/12" /><Skeleton className="h-5 w-40" /></div>)}
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-caption text-pretty text-muted-foreground">Questions you ask show here with their answers, so you can open one again without asking twice.</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border bg-card">
            {items.map((a) => {
              const kept = answerKept(a);
              const cited = citedSources(a.citations);
              return (
                <li key={a.run_id}>
                  <button type="button" onClick={() => onOpen(a)} disabled={disabled} data-testid="recent-question" aria-current={a.run_id === current || undefined}
                    title={kept ? "Show this answer again" : "Ask this again"}
                    className={cn("focus-ring-inset group flex w-full min-w-0 flex-col gap-1 px-3 py-2.5 text-left transition-colors hover:bg-muted/50 disabled:opacity-60",
                      a.run_id === current && "bg-selected shadow-[inset_2px_0_0_var(--primary-text)] hover:bg-selected")}>
                    <span className="flex min-w-0 items-baseline gap-3">
                      <span className="min-w-0 flex-1 truncate text-body font-medium">{a.question}</span>
                      <span className="shrink-0 text-caption text-muted-foreground tabular-nums"><Ago value={a.created_at} /></span>
                    </span>
                    <span className="truncate text-caption text-muted-foreground">
                      {a.state === "answered" ? answerLine(a.answer) : a.state === "not_found" ? "Not found in your sources." : "No answer was kept. Click to ask it again."}
                    </span>
                    {cited.length > 0 && (
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5 pt-0.5" aria-label="Cited sources">
                        {cited.slice(0, 3).map((c) => (
                          <span key={c.id} className="inline-flex h-5 max-w-56 min-w-0 items-center gap-1 rounded-sm border bg-background px-1.5 text-micro text-muted-foreground">
                            <SourceIcon source={c} className="size-3" /><span className="truncate">{c.title}</span>
                          </span>
                        ))}
                        {cited.length > 3 && <span className="text-micro text-muted-foreground">+{cited.length - 3} more</span>}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
    </section>
  );
}

/** The suggestions' shape while the sources load. */
function StartersSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-1.5">
      <Skeleton className="h-4 w-20" />
      <div className="divide-y overflow-hidden rounded-lg border bg-card">{Array.from({ length: 4 }, (_, i) => <div key={i} className="px-3 py-3"><Skeleton className="h-4 w-3/4" /></div>)}</div>
    </div>
  );
}

/** Questions to start with, written for the team's own sources: one compact list, a click asks it. */
function Starters({ asks, disabled, onPick, title = "Try asking" }: { asks: string[]; disabled: boolean; onPick: (q: string) => void; title?: string }) {
  if (!asks.length) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-1.5" data-testid="ask-starters">
      <h2 className="px-1 text-caption font-medium text-muted-foreground">{title}</h2>
      <ul className="divide-y overflow-hidden rounded-lg border bg-card">
        {asks.map((q) => (
          <li key={q}>
            <button type="button" disabled={disabled} onClick={() => onPick(q)} data-testid="ask-starter"
              className="focus-ring-inset group flex min-h-10 w-full items-center gap-3 px-3 py-2 text-left text-body transition-colors hover:bg-muted/50 disabled:opacity-60 max-sm:min-h-11">
              <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-pretty">{q}</span>
              <ArrowRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NoSources({ canAdd, aiOff, onAdd, processing }: { canAdd: boolean; aiOff: boolean; onAdd: () => void; processing: boolean }) {
  if (processing) return <EmptyState icon={BookOpen} title="Your first sources are being read" description="Ask works as soon as one is ready. It usually takes under a minute." action={<Button size="sm" variant="outline" asChild><Link to="/knowledge/sources">See their progress</Link></Button>} />;
  return (
    <EmptyState icon={BookOpen} title="Nothing to ask about yet"
      description={!canAdd ? "Nobody has added a source yet. Ask a member or an admin to add one." : aiOff ? "Once AI is on, add a brand guide, a product spec or a recorded call: reading one needs AI." : "Add a brand guide, a product spec or a recorded call. Ask answers only from what's here, and cites it."}
      action={canAdd ? <Button size="sm" onClick={onAdd} disabled={aiOff}><Upload />Add a source</Button> : undefined} />
  );
}

/** Where the request is, by how long it's taken: the steps run in order inside one request. */
function useStage(busy: boolean) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (!busy) { setStage(0); return; }
    const a = setTimeout(() => setStage(1), 1200);
    const b = setTimeout(() => setStage(2), 3500);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [busy]);
  return ["Reading your question", "Finding the closest passages", "Writing the answer from them"][stage];
}

function AnswerArea({ busy, asked, answer, error, onRetry, empty, total }: {
  busy: boolean; asked: { question: string; at?: number } | null; answer: Answer | null; error: unknown; onRetry: () => void; empty: ReactNode; total: number;
}) {
  const stage = useStage(busy);
  if (busy) {
    return (
      <div aria-live="polite" aria-busy className="flex gap-3" data-testid="ask-working">
        <AnswerMark />
        <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-1">
          <p className="flex items-center gap-2 text-body text-muted-foreground"><span aria-hidden className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />{stage}…</p>
          <Skeleton className="h-4 w-11/12" /><Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }
  if (error) return <LoadError title="That question didn't go through" error={error} onRetry={asked ? onRetry : undefined} />;
  if (!answer) return empty;
  return <AnswerView answer={answer} total={total} question={answer.question || asked?.question || ""} at={asked?.at} />;
}

/** An answer's shape while your recent questions load: the question, three lines, two cited passages. */
function AnswerSkeleton() {
  return (
    <div aria-hidden className="overflow-hidden rounded-lg border bg-card" data-testid="ask-opening">
      <div className="border-b px-4 py-3"><Skeleton className="h-5 w-2/3" /></div>
      <div className="flex gap-3 p-4">
        <Skeleton className="size-8 shrink-0 rounded-md" />
        <div className="flex flex-1 flex-col gap-2 pt-1"><Skeleton className="h-4 w-11/12" /><Skeleton className="h-4 w-4/5" /><Skeleton className="h-4 w-1/2" /></div>
      </div>
      <div className="divide-y border-t">
        {[0, 1].map((i) => <div key={i} className="flex flex-col gap-2 px-4 py-3"><Skeleton className="h-4 w-40" /><Skeleton className="h-4 w-11/12" /></div>)}
      </div>
    </div>
  );
}

/** The question an answer is for, at the head of its card, with when it was asked. */
function QuestionHead({ question, at }: { question: string; at?: number }) {
  if (!question) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 border-b px-4 py-3">
      <h2 className="min-w-0 text-body font-medium text-pretty" data-testid="ask-question">{question}</h2>
      {at ? <span className="shrink-0 text-caption text-muted-foreground tabular-nums">Asked <Ago value={at} /></span> : null}
    </div>
  );
}

const AnswerMark = () => (
  <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md border bg-card text-muted-foreground"><Sparkles className="size-4" /></span>
);

function AnswerView({ answer, total, question, at }: { answer: Answer; total: number; question: string; at?: number }) {
  // The model numbers passages in the order it was given them; show them as 1, 2, 3 in the order the answer cites them.
  const parts = useMemo(() => citedNumbers(answer.answer), [answer]);
  const order = useMemo(() => {
    const seen: number[] = [];
    for (const p of parts) if ("cite" in p) for (const n of p.cite) if (!seen.includes(n) && answer.citations.some((c) => c.n === n)) seen.push(n);
    for (const c of answer.citations) if (!seen.includes(c.n)) seen.push(c.n);
    return seen;
  }, [parts, answer]);
  const shown = (n: number) => order.indexOf(n) + 1;
  const cited = order.map((n) => answer.citations.find((c) => c.n === n)!).filter(Boolean);

  if (answer.state === "waiting" || answer.state === "refused" || answer.state === "failed") {
    const words = { waiting: "This question is waiting.", refused: "This question wasn't asked.", failed: "This question couldn't be answered." }[answer.state];
    return (
      <div role="alert" data-testid="ask-problem" className="flex gap-3 rounded-lg border bg-card p-4">
        <CircleAlert aria-hidden className={cn("mt-0.5 size-4 shrink-0", answer.state === "waiting" ? "text-warning" : "text-destructive")} />
        <div className="min-w-0 flex-1 text-body text-pretty"><p className="font-medium">{words}</p><p className="text-muted-foreground">{answer.detail || "Try again in a moment."}</p></div>
        {answer.state === "refused" && answer.reason === "over_budget" && <AskAdmin runId={answer.run_id} />}
      </div>
    );
  }
  if (answer.state === "not_found") {
    return (
      <div className="overflow-hidden rounded-lg border bg-card" data-testid="ask-answer" data-state="not_found">
        <QuestionHead question={question} at={at} />
        <div className="flex gap-3 p-4">
          <SearchX aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 text-body text-pretty">
            <p className="font-medium">I couldn't find this in your sources.</p>
            <p className="text-muted-foreground">Nothing in the {total} {total === 1 ? "source" : "sources"} here is close enough to answer it. Try other words, or add a source that covers it.</p>
          </div>
        </div>
      </div>
    );
  }
  const ranking = answer.ranking === "rerank" ? "ranked by relevance" : "ranked by similarity";
  return (
    <article className="overflow-hidden rounded-lg border bg-card" data-testid="ask-answer" data-state="answered">
      <QuestionHead question={question} at={at} />
      <div className="flex gap-3 p-4">
        <AnswerMark />
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-body leading-6 text-pretty text-foreground" data-testid="ask-text">
            {parts.map((p, i) => ("text" in p ? <span key={i}>{p.text}</span> : <Chips key={i} numbers={p.cite.map(shown).filter((n) => n > 0)} />))}
          </p>
          <p className="mt-2.5 text-caption text-muted-foreground tabular-nums" data-testid="ask-meta">
            From {answer.sources_used} of {answer.sources_total} {answer.sources_total === 1 ? "source" : "sources"} · {ranking} · {modelName(answer.model)} · {spentWords(answer.spent)}
          </p>
        </div>
      </div>
      {cited.length > 0 && (
        <ol aria-label="Sources cited" className="divide-y border-t bg-muted/20">
          {cited.map((c) => <CitationCard key={c.passage_id} c={c} n={shown(c.n)} />)}
        </ol>
      )}
    </article>
  );
}

/** One or more citations as small numbered chips, each a link to its passage below. Never the raw "[1, 2]". */
function Chips({ numbers }: { numbers: number[] }) {
  if (!numbers.length) return null;
  return (
    <span className="ml-1 inline-flex gap-0.5 align-[1px]">
      {[...new Set(numbers)].map((n) => (
        <a key={n} href={`#cite-${n}`} aria-label={`Source ${n}`} data-testid="cite-chip"
          className="focus-ring inline-grid h-4 min-w-4 place-items-center rounded-sm border bg-background px-1 text-micro leading-none font-medium text-muted-foreground tabular-nums no-underline transition-colors hover:border-foreground/30 hover:text-foreground">{n}</a>
      ))}
    </span>
  );
}

function CitationCard({ c, n }: { c: Citation; n: number }) {
  const recording = c.kind === "recording";
  const where = [c.page > 0 ? `Page ${c.page}` : "", c.start_s >= 0 ? clock(c.start_s) : "", c.speaker].filter(Boolean).join(" · ");
  const quote = c.text.length > 360 ? `${c.text.slice(0, 357).trimEnd()}…` : c.text;
  return (
    <li id={`cite-${n}`} data-testid="citation" className="grid scroll-mt-20 grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 px-4 py-3 target:bg-selected">
      <span className="mt-px grid h-5 min-w-5 place-items-center rounded-sm border bg-background text-micro font-medium text-muted-foreground tabular-nums">{n}</span>
      <div className="grid min-w-0 gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption">
          <SourceIcon source={{ kind: c.kind }} className="size-3.5" />
          <Link to={`/knowledge/sources?open=${c.source_id}`} className="focus-ring min-w-0 truncate rounded-sm font-medium text-foreground hover:underline" title={c.title}>{c.title}</Link>
          {where && <span className="text-muted-foreground tabular-nums">{where}</span>}
          {recording && c.has_audio && <span className="ml-auto"><PlayFrom sourceId={c.source_id} start={c.start_s} label={`Play from ${clock(c.start_s)}`} /></span>}
        </div>
        <blockquote className="border-l-2 pl-3">
          <Prose compact text={quote} className="text-caption leading-5 text-muted-foreground" />
        </blockquote>
      </div>
    </li>
  );
}

/** A question your budget refused can go to the admins, who can let it past or raise your budget. Admins raise their own. */
function AskAdmin({ runId }: { runId: number }) {
  const isAdmin = useCan("budgets.manage");
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  if (isAdmin) return null;
  if (state === "sent") return <p role="status" className="shrink-0 self-center text-caption text-muted-foreground">Sent to the admins</p>;
  const send = async () => {
    setState("busy");
    try { await api.askAdmin(runId); setState("sent"); toast.success("Sent to the admins. You'll hear when they decide."); }
    catch (e) { setState("idle"); toast.error(e instanceof Error ? e.message : "That didn't send. Try again."); }
  };
  return <Button size="sm" variant="outline" className="shrink-0 self-start" disabled={state === "busy"} onClick={() => void send()}>Ask an admin</Button>;
}
