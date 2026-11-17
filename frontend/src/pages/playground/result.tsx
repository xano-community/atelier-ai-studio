// One result pane: the run it shows, kept current live, and everything that can happen to it. A pane reads only its own
// run, so two panes side by side (Compare) never affect each other.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Check, CircleSlash, Clock, CookingPot, Copy, Download, Library, Loader2, RotateCcw, ShieldQuestion, Sparkles, Square, AudioLines, Film, Image as ImageIcon } from "lucide-react";
import { Link } from "react-router";
import { useCan } from "@xano-sdk/rbac/react";
import { toast } from "sonner";
import { modKey, StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ElapsedRange } from "@/components/studio/elapsed-range";
import { useLive } from "@/base/live";
import { api, ApiError } from "@/lib/api";
import { ASPECT_WORDS, usualSeconds, type StepKind } from "@/lib/catalog";
import { sizeOf } from "@/lib/knowledge";
import { isFinal, money, newClickId, paneState, resultLine, type RunRequest, type RunView, type Step } from "@/lib/playground";
import { cn } from "@/lib/utils";
import { mediaBytes, useMedia } from "@/lib/media";
import { MediaNote } from "@/components/studio/media-view";
import { AudioPlayer } from "@/components/studio/audio-player";
import { Prose } from "@/components/studio/prose";

export type Pane = { view: RunView | null; error: string | null; sending: boolean; startedAt: number };
const EMPTY: Pane = { view: null, error: null, sending: false, startedAt: 0 };
const words = (e: unknown) => (e instanceof Error ? e.message : "That didn't work. Try again.");

/** A pane's run: start one, open one from history, and keep it current while it's going. */
export function usePane() {
  const [pane, setPane] = useState<Pane>(EMPTY);
  const runId = pane.view?.run.id ?? 0;
  const going = !!pane.view && !isFinal(pane.view.run.status);
  const latest = useRef(0);

  const load = useCallback(async (id: number): Promise<RunView | null> => {
    const mine = ++latest.current;
    try {
      const view = await api.run(id);
      if (mine === latest.current) setPane((p) => ({ ...p, view, error: null, sending: false, startedAt: p.view?.run.id === id && p.startedAt ? p.startedAt : view.run.created_at }));
      return view;
    } catch (e) {
      if (mine === latest.current) setPane((p) => ({ ...p, error: words(e), sending: false }));
      return null;
    }
  }, []);

  const start = useCallback(async (req: RunRequest, clientId: string, file: File | null) => {
    const mine = ++latest.current;
    setPane({ view: null, error: null, sending: true, startedAt: Date.now() });
    try {
      const started = await api.startRun(req, clientId, file);
      if (mine === latest.current) setPane((p) => ({ ...p, view: { run: started.run, steps: started.steps }, sending: false }));
    } catch (e) {
      if (mine === latest.current) setPane((p) => ({ ...p, error: words(e), sending: false }));
    }
  }, []);

  const clear = useCallback(() => { ++latest.current; setPane(EMPTY); }, []);

  // Live: the run's own changes come on the person's channel. A slow poll covers a socket that missed one.
  useLive(["ai_run", "ai_step", "asset"], () => { if (runId && going) void load(runId); });
  useEffect(() => {
    if (!runId || !going) return;
    const t = setInterval(() => document.visibilityState === "visible" && void load(runId), 8000);
    return () => clearInterval(t);
  }, [runId, going, load]);

  return { pane, start, load, clear, setPane };
}

/** Seconds since `from`, ticking once a second while `on`. */
function useElapsed(from: number, on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return Math.max(0, (now - from) / 1000);
}

const STATE_BADGE = {
  sending: { tone: "neutral", label: "Sending" }, running: { tone: "info", label: "Running" }, waiting: { tone: "warning", label: "Waiting for an admin" },
  confirm: { tone: "warning", label: "Needs your confirmation" }, refused: { tone: "danger", label: "Refused" }, failed: { tone: "danger", label: "Failed" },
  stopped: { tone: "neutral", label: "Stopped" },
} as const;

/** Where a step's made file shows from: its link, or its table-kept bytes (lib/media.ts). */
const mediaOf = (step: Step) => ({ url: step.url, blob_id: step.blob_id, mime: (step.output?.file as { mime?: string } | undefined)?.mime });
const fileSize = (step: Step) => {
  const size = Number((step.output?.file as { size?: number } | undefined)?.size ?? 0);
  return size > 0 ? sizeOf(size) : "";
};

/** A made picture or clip in a frame, with a strip under it saying what it is. */
function Frame({ children, caption, testId }: { children: ReactNode; caption: ReactNode; testId?: string }) {
  return (
    <figure className="min-w-0 overflow-hidden rounded-md border bg-card" data-testid={testId}>
      <div className="grid min-h-48 place-items-center bg-muted/50 p-3 dark:bg-muted/30">{children}</div>
      <figcaption className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 border-t px-3 py-1.5 text-caption text-muted-foreground tabular-nums">{caption}</figcaption>
    </figure>
  );
}
const joined = (parts: (string | false | null | undefined)[]) => parts.filter(Boolean).flatMap((p, i) => (i ? [<span key={`d${i}`} aria-hidden className="text-muted-foreground/60">·</span>, <span key={i}>{p}</span>] : [<span key={i}>{p}</span>]));

function ImageOutput({ step, onExpired, kept }: { step: Step; onExpired: () => void; kept: boolean }) {
  const shown = useMedia(mediaOf(step));
  const [size, setSize] = useState<[number, number] | null>(null);
  const aspect = typeof step.options?.aspect_ratio === "string" ? ASPECT_WORDS[step.options.aspect_ratio] ?? step.options.aspect_ratio : "";
  return (
    <Frame testId="result-frame" caption={<>
      {joined([size ? `${size[0].toLocaleString()} × ${size[1].toLocaleString()}` : "", aspect, fileSize(step)])}
      {kept && <StatusBadge dot className="ml-auto">Draft in the library</StatusBadge>}
    </>}>
      {shown.state === "loading" ? <Skeleton aria-label="Loading" className="aspect-square w-full max-w-md rounded-sm" />
        : shown.state !== "ready" ? <MediaNote state={shown.state === "failed" ? "failed" : shown.state} kind="image" className="w-full border-0 bg-transparent" />
        : <img src={shown.src} alt={`What ${step.model} made for: ${String(step.input?.prompt ?? "")}`} onError={onExpired} data-testid="result-image"
            onLoad={(e) => setSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
            className="max-h-[32rem] w-auto max-w-full rounded-sm object-contain" />}
    </Frame>
  );
}

function VideoOutput({ step, onExpired }: { step: Step; onExpired: () => void }) {
  const shown = useMedia(mediaOf(step));
  const o = step.options ?? {};
  const seconds = Number(step.usage?.seconds ?? step.output?.duration ?? o.seconds ?? 0);
  const res = typeof o.resolution === "string" ? (o.resolution === "4k" ? "4K" : o.resolution) : "";
  const aspect = typeof o.aspect_ratio === "string" ? ASPECT_WORDS[o.aspect_ratio] ?? o.aspect_ratio : "";
  return (
    <Frame testId="result-frame" caption={joined([seconds ? `${seconds} s` : "", res, aspect, o.audio === true ? "With sound" : o.audio === false ? "Silent" : "", fileSize(step)])}>
      {shown.state === "loading" ? <Skeleton aria-label="Loading" className="aspect-video w-full rounded-sm" />
        : shown.state !== "ready" ? <MediaNote state={shown.state === "failed" ? "failed" : shown.state} kind="video" className="w-full border-0 bg-transparent" />
        // The first frame shows as the poster before playing: a fragment start, not a separate image.
        : <video src={shown.src.includes("#") ? shown.src : `${shown.src}#t=0.1`} controls playsInline preload="metadata" onError={onExpired} data-testid="result-video"
            className="max-h-[32rem] w-full rounded-sm bg-black" />}
    </Frame>
  );
}

/** A made file this server couldn't keep a link to: said once, quietly, in the shape the file would have taken. */
function NoFile({ kind }: { kind: string }) {
  const audio = kind === "speech" || kind === "music";
  const what = kind === "image" ? "picture" : kind === "video" ? "clip" : "recording";
  const Icon = kind === "image" ? ImageIcon : kind === "video" ? Film : AudioLines;
  return (
    <div data-testid="result-no-link" className={cn("flex items-center gap-3 rounded-md border border-dashed bg-muted/30 px-4 text-left", audio ? "py-3.5" : "aspect-video justify-center flex-col py-6 text-center")}>
      <Icon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-body font-medium">This {what} plays on Xano cloud</p>
        <p className="text-caption text-pretty text-muted-foreground">This server can't make private file links. What it used and cost is below.</p>
      </div>
    </div>
  );
}

/** The finished output itself: words, an image, a clip or a recording. */
function Output({ step, onExpired, kept }: { step: Step; onExpired: () => void; kept: boolean }) {
  const out = step.output ?? {};
  const retried = useRef(false);
  const expired = () => { if (!retried.current) { retried.current = true; onExpired(); } };
  if (step.kind === "text" || step.kind === "transcribe") {
    const json = out.json;
    if (json !== null && json !== undefined) return <pre className="max-h-[36rem] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-caption leading-5 whitespace-pre-wrap wrap-anywhere" data-testid="result-json">{JSON.stringify(json, null, 2)}</pre>;
    return <Prose text={String(out.text ?? "")} testId="result-text" className="max-h-[36rem] max-w-[68ch] overflow-auto text-body leading-relaxed" />;
  }
  const media = mediaOf(step);
  if (!media.url && !media.blob_id) return <NoFile kind={step.kind} />;
  if (step.kind === "image") return <ImageOutput step={step} onExpired={expired} kept={kept} />;
  if (step.kind === "video") return <VideoOutput step={step} onExpired={expired} />;
  const voice = typeof step.input?.voice === "string" && step.input.voice ? `Voice ${step.input.voice}` : "";
  return (
    <div className="grid gap-3">
      <AudioPlayer media={media} testId="result-audio" label={step.kind === "music" ? "the music" : "the voiceover"} />
      {(voice || fileSize(step)) && <p className="flex flex-wrap gap-x-2 px-0.5 text-caption text-muted-foreground tabular-nums">{joined([voice, fileSize(step)])}</p>}
      {typeof out.lyrics === "string" && out.lyrics && <Prose compact text={out.lyrics} className="text-caption text-muted-foreground" />}
    </div>
  );
}

/** Save a step's file under a name of its own, however this server keeps it. */
async function saveStepFile(step: Step) {
  const blob = await mediaBytes(mediaOf(step));
  const ext = { image: "png", video: "mp4", speech: "wav", music: "wav" }[step.kind as string] ?? "bin";
  const name = String((step.output?.file as { name?: string } | undefined)?.name ?? `atelier-${step.kind}-${step.id}.${ext}`);
  const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** While it works: the shape of what's coming, so nothing jumps when it lands. */
function Working({ kind, elapsed }: { kind: StepKind; elapsed: number }) {
  if (kind === "image") return <div className="grid gap-2"><Skeleton className="aspect-[4/3] w-full rounded-md" /><p className="text-caption text-muted-foreground tabular-nums">{Math.floor(elapsed)} s</p></div>;
  return (
    <div className="grid gap-2.5" aria-label="Working">
      <Skeleton className="h-4 w-11/12" /><Skeleton className="h-4 w-9/12" /><Skeleton className="h-4 w-10/12" /><Skeleton className="h-4 w-7/12" />
      <p className="text-caption text-muted-foreground tabular-nums">{Math.floor(elapsed)} s</p>
    </div>
  );
}

/** Before the first run: where the result will be, what comes with it, and the key that starts it. */
export function ResultPlaceholder({ title, testId, className }: { title: string; testId: string; className?: string }) {
  return (
    <section aria-label={title} data-testid={testId} data-state="idle"
      className={cn("flex min-h-56 min-w-0 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center", className)}>
      <span aria-hidden className="mb-1 grid size-9 place-items-center rounded-full border bg-card text-muted-foreground"><Sparkles className="size-4" /></span>
      <p className="text-body font-medium">{title}</p>
      <p className="max-w-xs text-caption text-pretty text-muted-foreground">It shows with the time it took, what it used and what it cost.</p>
      <p className="text-caption text-muted-foreground">Press <kbd className="rounded-sm border px-1 font-sans text-micro">{modKey("↵")}</kbd> to run</p>
    </section>
  );
}

export function ResultPane({ pane, reload, title, chip, kind, isAdmin, onRunAgain, compact = false, testId = "result", className }: {
  pane: Pane; reload: () => void; title: string; chip?: string; kind: StepKind; isAdmin: boolean;
  /** Start the same settings again (a failed run with nothing to retry, or "Run again"). */ onRunAgain?: () => void;
  /** In Compare: a card per model. */ compact?: boolean; testId?: string; className?: string;
}) {
  const { state, words: why, step } = paneState(pane);
  const view = pane.view;
  const elapsed = useElapsed(pane.startedAt || Date.now(), state === "running" || state === "sending");
  const [busy, setBusy] = useState<string | null>(null);
  const [kept, setKept] = useState<number | null>(null);
  useEffect(() => { setKept(null); }, [view?.run.id]);

  const act = async (what: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(what);
    try { await fn(); if (done) toast.success(done); reload(); }
    catch (e) { toast.error(e instanceof ApiError || e instanceof Error ? e.message : "That didn't work. Try again."); }
    finally { setBusy(null); }
  };
  const usual = step ? usualSeconds(kind, step.model) : null;
  const line = view && state === "done" ? resultLine(view) : null;
  const canRetry = view && (view.run.status === "failed" || view.run.status === "partial");
  const canMakeRecipes = useCan("recipes.manage");

  if (state === "idle") return <ResultPlaceholder title={compact ? `${title}'s result shows here` : "Your result shows here"} testId={testId} className={className} />;

  const seconds = line?.seconds;
  return (
    <section aria-label={title} data-testid={testId} data-state={state} className={cn("flex min-w-0 flex-col rounded-lg border bg-card", className)}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
        <h2 className="min-w-0 truncate text-heading" title={title}>{title}</h2>
        {chip && <span className="shrink-0 text-caption text-muted-foreground">{chip}</span>}
        <span className="ml-auto shrink-0">
          {state === "done" ? (
            <StatusBadge tone="success"><Check aria-hidden className="size-3" />Done{seconds !== null && seconds !== undefined ? ` in ${seconds.toFixed(1)} s` : ""}</StatusBadge>
          ) : (
            <StatusBadge tone={STATE_BADGE[state].tone}>
              {state === "running" || state === "sending" ? <Loader2 aria-hidden className="size-3 animate-spin motion-reduce:animate-none" /> : state === "waiting" || state === "confirm" ? <Clock aria-hidden className="size-3" /> : <AlertCircle aria-hidden className="size-3" />}
              {STATE_BADGE[state].label}
            </StatusBadge>
          )}
        </span>
      </header>

      <div className="grid min-w-0 flex-1 content-start gap-4 p-4" aria-live="polite">
        {(state === "sending" || state === "running") && (usual ? <ElapsedRange elapsed={elapsed} usual={usual} /> : <Working kind={kind} elapsed={elapsed} />)}
        {state === "running" && usual && view && (
          <div><Button variant="outline" size="sm" disabled={busy === "stop"} onClick={() => act("stop", () => api.stopRun(view.run.id), "Stopped")}><Square aria-hidden />Stop</Button></div>
        )}

        {(state === "waiting" || state === "confirm" || state === "refused" || state === "failed" || state === "stopped") && (
          <div className="grid gap-3">
            <p className="flex gap-2 text-body text-pretty" data-testid={`${testId}-why`}>
              {state === "refused" || state === "failed" ? <CircleSlash aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" /> : <ShieldQuestion aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />}
              <span>{why}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {state === "confirm" && view && (
                <Button size="sm" disabled={busy === "confirm"} onClick={() => act("confirm", () => api.confirmRun(view.run.id))}>Confirm and run</Button>
              )}
              {state === "refused" && view?.run.reason === "over_budget" && !isAdmin && (
                <Button variant="outline" size="sm" disabled={busy === "ask"} onClick={() => act("ask", () => api.askAdmin(view.run.id), "Sent to the admins")}>Ask an admin</Button>
              )}
              {canRetry && view && (
                <Button variant="outline" size="sm" disabled={busy === "retry"} onClick={() => act("retry", () => api.retryRun(view.run.id, newClickId()))}><RotateCcw aria-hidden />Retry</Button>
              )}
              {!canRetry && (state === "failed" || state === "stopped") && onRunAgain && (
                <Button variant="outline" size="sm" onClick={onRunAgain}><RotateCcw aria-hidden />Try again</Button>
              )}
            </div>
          </div>
        )}

        {state === "done" && step && (
          <>
            <Output step={step} onExpired={reload} kept={kept !== null} />
            {step.detail && <p className="text-caption text-muted-foreground">{step.detail}</p>}
            {view && view.run.spent > 0 && !line && <p className="text-caption text-muted-foreground">Charged {money(view.run.spent)}</p>}
          </>
        )}
      </div>

      {state === "done" && step && line && (
        <div className="flex min-w-0 shrink-0 flex-wrap items-baseline gap-x-5 gap-y-1 border-t px-4 py-2 text-caption tabular-nums">
          <dl className="flex min-w-0 flex-wrap gap-x-5 gap-y-1" data-testid={`${testId}-line`}>
            {([["Time", seconds !== null && seconds !== undefined ? `${seconds.toFixed(1)} s` : "—"], ["Used", line.usage || "—"], ["Cost", line.cost]] as const).map(([k, v]) => (
              <div key={k} className="flex items-baseline gap-1.5 whitespace-nowrap">
                <dt className="text-muted-foreground">{k}</dt><dd className="font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          {step.brand_applied && <span className="ml-auto text-muted-foreground">Brand kit applied</span>}
        </div>
      )}

      {state === "done" && step && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-t px-3 py-2">
          <Button variant="outline" size="sm" disabled={busy === "use" || !step.asset_id || kept !== null} data-testid={`${testId}-use`} className="mr-1"
            onClick={() => act("use", async () => { const r = await api.useOutput(step.id); setKept(r.asset_id); }, "In the team's library as a draft")}>
            <Library aria-hidden />{kept !== null ? "In the library" : "Use this"}
          </Button>
          {(step.kind === "text" || step.kind === "transcribe") && (
            <Button variant="ghost" size="sm" onClick={() => navigator.clipboard?.writeText(step.output?.json ? JSON.stringify(step.output.json, null, 2) : String(step.output?.text ?? "")).then(() => toast.success("Copied"), () => toast.error("Couldn't copy. Select the text and copy it by hand."))}>
              <Copy aria-hidden />Copy
            </Button>
          )}
          {!!(step.url || step.blob_id) && (
            <Button variant="ghost" size="sm" onClick={() => saveStepFile(step).catch((e) => toast.error(e instanceof Error ? e.message : "It didn't download. Try again."))}><Download aria-hidden />Download</Button>
          )}
          {onRunAgain && <Button variant="ghost" size="sm" onClick={onRunAgain}><RotateCcw aria-hidden />Run again</Button>}
          {canMakeRecipes && view && !compact && (
            <Button variant="ghost" size="sm" asChild data-testid={`${testId}-save-recipe`}>
              <Link to={`/recipes/new?from_run=${view.run.id}`}><CookingPot aria-hidden />Save as recipe</Link>
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
