// A run's steps, top to bottom in the order they run: what each made, what it's doing now, or why it didn't run. A slow
// step (video, music) shows the time so far against how long its model usually takes, never a made-up percentage. A
// step that failed or was blocked can have its prompt edited and go again on its own. A step that has started or ended is
// a card: its name and model, its state, its time and cost, and what it made inline. A step still waiting its turn is one
// compact row, with what it waits for as a caption, so a whole pipeline fits on a screen. The rail on the left draws how
// the steps hang together (lib/pipeline.ts): a solid line where a step uses the one before it, a dotted one where it only
// runs after it, and a branch where it uses one further up. A run held for an approval or a confirmation says so, in
// amber, on the step it holds back. Each media step keeps a slot shaped like what it makes (a picture's aspect, a clip's
// frame, a recording's strip) until it has made it. A step changing state fades its mark and status in.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AudioLines, Check, Film, Image as ImageIcon, Minus, Pencil, RotateCcw, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ElapsedRange } from "@/components/studio/elapsed-range";
import { usualSeconds, type StepKind } from "@/lib/catalog";
import { money, stepSeconds, type Step } from "@/lib/playground";
import { KIND_LABEL, STEP_WORDS } from "@/lib/recipes";
import { cn } from "@/lib/utils";
import { MediaView } from "@/components/studio/media-view";
import { AudioPlayer } from "@/components/studio/audio-player";
import { StatusBadge, type Tone } from "@/components/kit";
import { fieldLabel, groupByField, readJson } from "@/lib/readable-json";
import { laneX, pipeline, railWidth, slotShape, type Pipeline } from "@/lib/pipeline";

export type RunStep = Step & { label?: string; depends_on?: number[] };

/** Seconds since `from` (epoch ms), ticking while `on`. */
function useSince(from: number | null | undefined, on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return from ? Math.max(0, (now - from) / 1000) : 0;
}

const nameOf = (s: RunStep) => s.label || KIND_LABEL[s.kind] || s.kind;

/** True once `value` differs from what it was on the first render: a change seen live, not a page load. */
function useChangedSince<T>(value: T) {
  const first = useRef(value);
  return first.current !== value;
}
/** The class a mark or a status takes when it changes in front of someone: a short fade and settle on the kit's curve. */
const ARRIVE = "animate-in fade-in zoom-in-90 duration-200 ease-(--ease-out)";

function Mark({ step, held }: { step: RunStep; held: boolean }) {
  const changed = useChangedSince(step.status);
  const base = cn("relative z-10 grid size-6 shrink-0 place-items-center rounded-full border text-caption font-medium tabular-nums", changed && ARRIVE);
  if (step.status === "succeeded") return <span key="ok" className={cn(base, "border-success/40 bg-success/12 text-success")}><Check aria-hidden className="size-3.5" /></span>;
  if (step.status === "working") return <span key="working" className={cn(base, "border-info/40 bg-info/12")}><span aria-hidden className="size-3 animate-spin rounded-full border-2 border-info border-t-transparent motion-reduce:animate-none" /></span>;
  if (["failed", "timed_out", "blocked"].includes(step.status)) return <span key="bad" className={cn(base, step.status === "blocked" ? "border-warning/40 bg-warning/15 text-warning" : "border-destructive/40 bg-destructive/12 text-destructive")}><X aria-hidden className="size-3.5" /></span>;
  if (step.status === "skipped" || step.status === "released") return <span key="off" className={cn(base, "bg-muted text-muted-foreground")}><Minus aria-hidden className="size-3.5" /></span>;
  if (held) return <span key="held" className={cn(base, "border-warning/50 bg-warning/15 text-warning")}>{step.seq}</span>;
  return <span key="queued" className={cn(base, "bg-background text-muted-foreground")}>{step.seq}</span>;
}

/**
 * The slot for what a media step makes, shaped like it: dashed while it waits, shimmering while it's made, faded when it
 * won't be. Words and lookups have no slot; an empty one of the same width keeps the column straight.
 */
export function OutputSlot({ step }: { step: RunStep }) {
  const shape = slotShape(step.kind, step.options);
  if (!shape) return <span aria-hidden className="w-14 shrink-0" />;
  const Icon = shape.kind === "image" ? ImageIcon : shape.kind === "video" ? Film : AudioLines;
  const working = step.status === "working";
  const off = ["skipped", "released", "failed", "timed_out", "blocked"].includes(step.status);
  const word = shape.kind === "image" ? "picture" : shape.kind === "video" ? "clip" : "recording";
  return (
    <span className="grid w-14 shrink-0 place-items-center" data-kit="output-slot" data-state={working ? "working" : off ? "off" : "waiting"}
      title={working ? `Making the ${word}` : off ? `No ${word}: this step didn't run` : `The ${word} shows here once it's made`}>
      <span aria-hidden style={{ width: shape.width, height: shape.height }}
        className={cn("grid place-items-center rounded-[5px] text-muted-foreground transition-opacity duration-200",
          working ? "animate-pulse bg-muted motion-reduce:animate-none" : "border border-dashed bg-muted/40",
          off && "opacity-50")}>
        {shape.kind === "audio"
          ? <span className="flex h-3.5 items-center gap-[2px]">{[6, 11, 14, 8, 12, 5, 9].map((h, i) => <i key={i} style={{ height: h }} className="w-[2px] rounded-full bg-current opacity-60" />)}</span>
          : <Icon className="size-3.5 opacity-70" />}
      </span>
    </span>
  );
}

/** What a finished step made: its words (or its JSON's fields), a picture, a clip or a recording. */
function Made({ step }: { step: RunStep }) {
  const [all, setAll] = useState(false);
  const out = step.output ?? {};
  if (step.kind === "embedding") return <p className="text-caption text-muted-foreground">Found what to look up in Knowledge.</p>;
  if (step.kind === "text" || step.kind === "transcribe") {
    const json = out.json && typeof out.json === "object" ? (out.json as Record<string, unknown>) : null;
    // A JSON reply reads as its fields, each labelled, with lists as lists.
    const groups = json ? groupByField(readJson(JSON.stringify(json)) ?? []) : [];
    if (groups.length) {
      const shown = all ? groups : groups.slice(0, 3);
      return (
        <div className="grid gap-2" data-testid="step-text">
          {shown.map((g, i) => (
            <div key={i} className="grid gap-0.5 text-body leading-relaxed wrap-anywhere text-pretty">
              {g.field && <span className="text-caption text-muted-foreground">{fieldLabel(g.field)}</span>}
              {g.lines.some((l) => l.item)
                ? <ul className="list-disc pl-5">{g.lines.map((l, j) => <li key={j}>{l.text}</li>)}</ul>
                : g.lines.map((l, j) => <p key={j} className="whitespace-pre-wrap">{l.text}</p>)}
            </div>
          ))}
          {groups.length > 3 && <Button variant="link" size="xs" className="h-auto justify-self-start p-0" onClick={() => setAll((v) => !v)}>{all ? "Show less" : "Show all"}</Button>}
        </div>
      );
    }
    const text = json ?Object.entries(json).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n") : String(out.text ?? "");
    const long = text.length > 320;
    return (
      <div className="grid gap-1">
        <p className="text-body leading-relaxed whitespace-pre-wrap wrap-anywhere text-pretty" data-testid="step-text">{long && !all ? `${text.slice(0, 320).trimEnd()}…` : text}</p>
        {long && <Button variant="link" size="xs" className="h-auto justify-self-start p-0" onClick={() => setAll((v) => !v)}>{all ? "Show less" : "Show all"}</Button>}
      </div>
    );
  }
  const media = { url: step.url, blob_id: step.blob_id, mime: (out.file as { mime?: string } | undefined)?.mime };
  if (step.kind === "image") return (
    <div className="grid w-fit max-w-full place-items-center rounded-md border bg-muted/50 p-2 dark:bg-muted/30">
      <MediaView kind="image" media={media} alt={`${nameOf(step)}, made by ${step.model}`} className="max-h-72 w-auto max-w-full rounded-sm object-contain" testId="step-image" />
    </div>
  );
  if (step.kind === "video") return <MediaView kind="video" media={media} className="max-h-80 w-full max-w-lg rounded-md border bg-black" testId="step-video" />;
  return <AudioPlayer media={media} className="max-w-lg" testId="step-audio" label={nameOf(step)} />;
}

const STEP_TONE: Record<string, Tone> = {
  succeeded: "success", working: "info", queued: "neutral", skipped: "neutral", released: "neutral", blocked: "warning", failed: "danger", timed_out: "danger",
};

export function RunSteps({ steps, running, canRetry, onRetryStep, modelLabel = (_k, m) => m, hold = "", why = "" }: {
  steps: RunStep[];
  /** A model's name as the catalog gives it. */ modelLabel?: (kind: string, model: string) => string;
  /** The run is still going: working steps tick. */ running: boolean;
  /** The viewer owns the run and it has ended, so a failed or blocked step can go again. */ canRetry: boolean;
  onRetryStep?: (step: RunStep, prompt: string) => Promise<void>;
  /** What the whole run waits on before its first step can start ("Waiting for approval"), or empty. */ hold?: string;
  /** The kind of step that made it wait (a member's "video"), marked on that step. */ why?: string;
}) {
  const pipe = pipeline(steps);
  // The step that goes next: the one a hold keeps back, or the one a running run starts after the current one.
  const next = steps.find((s) => s.status === "queued");
  const rail: CSSProperties = { gridTemplateColumns: `${railWidth(pipe.lanes)}px minmax(0,1fr)` };
  return (
    <div className="grid gap-2.5">
      <ol className="relative grid gap-3" aria-label="Steps">
        {steps.map((step, i) => {
          const held = !!hold && step === next;
          return (
            <li key={step.id} style={rail} className="relative grid gap-3" data-testid={`run-step-${step.seq}`} data-status={step.status} data-held={held || undefined}>
              <Rail step={step} steps={steps} pipe={pipe} last={i === steps.length - 1} />
              <span className="justify-self-end pt-2.5"><Mark step={step} held={held} /></span>
              {step.status === "queued"
                ? <WaitingRow step={step} steps={steps} modelLabel={modelLabel} badge={held ? hold : running && step === next ? "Up next" : ""} reason={!!why && step.kind === why} />
                : <StepCard step={step} running={running} canRetry={canRetry} onRetryStep={onRetryStep} modelLabel={modelLabel} />}
            </li>
          );
        })}
      </ol>
      {(pipe.branches.length > 0 || Object.values(pipe.joins).includes("after")) && <RailKey />}
    </div>
  );
}

/** The two kinds of line, said once under the steps. */
function RailKey() {
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-1 text-caption text-muted-foreground" data-kit="rail-key">
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 border-t border-foreground/30" />Uses that step's output</span>
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="w-4 border-t border-dashed border-foreground/30" />Runs after it</span>
    </p>
  );
}

/** Mark centres sit 22 px down a row (10 px of padding, then half the 24 px mark); rows are 12 px apart. */
const MID = 22, GAP = 12;

/**
 * This row's part of the rail: the line down to the next mark (solid when the next step uses this one, dotted when it
 * only runs after it), and the branches that start here, end here or pass by. A line whose step has made its output
 * takes the success tint, so the finished part of a run reads as done.
 */
function Rail({ step, steps, pipe, last }: { step: RunStep; steps: RunStep[]; pipe: Pipeline; last: boolean }) {
  const lanes = pipe.lanes;
  const markLeft = railWidth(lanes) - 24;
  const centre = markLeft + 12;
  const tint = (seq: number) => (steps.find((s) => s.seq === seq)?.status === "succeeded" ? "border-success/50" : "border-foreground/20");
  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0" style={{ width: railWidth(lanes) }}>
      {!last && (
        <span className={cn("absolute w-0 border-l transition-colors duration-200", pipe.joins[step.seq] === "after" && "border-dashed", tint(step.seq))}
          style={{ left: centre - 0.5, top: MID + 12, bottom: -(GAP + MID - 12) }} />
      )}
      {pipe.branches.map((b) => {
        const x = laneX(b.lane, lanes);
        const line = cn("absolute transition-colors duration-200", tint(b.from));
        if (b.from === step.seq) return <span key={`${b.from}-${b.to}`} className={cn(line, "rounded-tl-md border-t border-l")} style={{ left: x, width: markLeft - x, top: MID, bottom: -GAP }} />;
        if (b.to === step.seq) return (
          <span key={`${b.from}-${b.to}`}>
            <span className={cn(line, "rounded-bl-md border-b border-l")} style={{ left: x, width: markLeft - x - 1, top: 0, height: MID + 0.5 }} />
            {/* The arrow's tip, at the mark it feeds. */}
            <span className={cn(line, "size-1.5 rotate-45 border-t border-r")} style={{ left: markLeft - 6, top: MID - 2.5 }} />
          </span>
        );
        if (b.from < step.seq && step.seq < b.to) return <span key={`${b.from}-${b.to}`} className={cn(line, "border-l")} style={{ left: x, top: 0, bottom: -GAP }} />;
        return null;
      })}
    </span>
  );
}

/** What a step still waiting its turn waits for: the short line under its name, and the whole sentence on hover. */
function waitsFor(step: RunStep, steps: RunStep[]): { short: string; full: string } {
  const needs = (step.depends_on ?? []).map((n) => steps.find((s) => s.seq === n)).filter(Boolean) as RunStep[];
  if (needs.length) {
    const which = needs.map((n) => `step ${n.seq}`).join(" and ");
    const one = needs.length === 1;
    return { short: `Uses ${which}; skipped if ${one ? "it" : "one"} fails`, full: `Uses ${which}. If ${one ? "that doesn't" : "one of them doesn't"} succeed, this step is skipped.` };
  }
  if (step.seq > 1) return { short: `After step ${step.seq - 1}, whatever happens to it`, full: `Runs after step ${step.seq - 1}. It doesn't use an earlier step, so it runs whatever happens to them.` };
  return { short: "Runs first", full: "Runs first." };
}

/**
 * A step that hasn't started: one 44 px row with its name, model and what it waits for, then its estimate, its output's
 * slot and, on the step that goes next, why it hasn't started ("Waiting for approval") or that it's up next.
 */
function WaitingRow({ step, steps, modelLabel, badge, reason }: { step: RunStep; steps: RunStep[]; modelLabel: (kind: string, model: string) => string; badge: string; reason: boolean }) {
  const waits = waitsFor(step, steps);
  const held = !!badge && badge !== "Up next";
  return (
    <article className={cn("flex min-h-11 min-w-0 items-center gap-3 rounded-lg border bg-card/60 py-0.5 pr-1.5 pl-4 transition-colors duration-200", held && "border-warning/40 bg-card")} data-kit="step-waiting">
      <div className="grid min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className={cn("min-w-0 truncate text-body font-medium", held ? "text-foreground" : "text-muted-foreground")} title={nameOf(step)}>{nameOf(step)}</h3>
          {reason && (
            <span className="inline-flex shrink-0 items-center text-warning" title="This step is why the run waits for an admin">
              <ShieldAlert aria-hidden className="size-3.5" /><span className="sr-only">This step is why the run waits for an admin</span>
            </span>
          )}
          <span className="min-w-0 truncate text-caption text-muted-foreground max-sm:hidden">{modelLabel(step.kind, step.model)}</span>
        </div>
        <p className={cn("truncate text-caption text-muted-foreground", badge && "max-sm:hidden")} title={waits.full}>{waits.short}</p>
        {/* A phone has no room for the pill beside the name: the line under it says the same, in the same tone. */}
        {badge && <p className={cn("flex items-center gap-1.5 text-caption font-medium sm:hidden", held ? "text-warning" : "text-muted-foreground")}><span aria-hidden className="size-1.5 rounded-full bg-current" />{badge}</p>}
      </div>
      {badge && <StatusBadge tone={held ? "warning" : "neutral"} dot className="max-sm:hidden">{badge}</StatusBadge>}
      <span className="shrink-0 text-right text-caption whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden">about {money(step.estimate)}</span>
      <OutputSlot step={step} />
    </article>
  );
}

function StepCard({ step, running, canRetry, onRetryStep, modelLabel }: {
  step: RunStep; running: boolean; canRetry: boolean; onRetryStep?: (step: RunStep, prompt: string) => Promise<void>; modelLabel: (kind: string, model: string) => string;
}) {
  const elapsed = useSince(step.sent_at ?? step.claimed_at ?? null, running && step.status === "working");
  const usual = usualSeconds(step.kind as StepKind, step.model);
  const took = stepSeconds(step);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const editable = canRetry && !!onRetryStep && (step.status === "blocked" || step.status === "failed") && step.kind !== "embedding";
  const startEdit = () => {
    const i = step.input ?? {};
    const fill = (i.fill as { templates?: Record<string, string> } | undefined)?.templates;
    setPrompt(String(fill?.prompt ?? (step.kind === "speech" ? i.text : i.prompt) ?? ""));
    setEditing(true);
  };
  const quiet = step.status === "skipped" || step.status === "released";
  const changed = useChangedSince(step.status);
  const timing = step.status === "succeeded"
    ? [took !== null ? `${took.toFixed(1)} s` : "", money(step.charged)].filter(Boolean).join(" · ")
    : step.status === "working" ? `${Math.floor(elapsed)} s` : "";
  const hasBody = step.status === "succeeded" || (step.status === "working" && !!usual)
    || (["skipped", "released", "failed", "blocked", "timed_out"].includes(step.status) && !!step.detail) || editable || editing;
  return (
    <article className={cn("min-w-0 overflow-hidden rounded-lg border bg-card", quiet && "bg-card/60")}>
      <header className={cn("flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2", hasBody && "border-b")}>
        <h3 className={cn("min-w-0 truncate text-heading", quiet && "text-muted-foreground")} title={nameOf(step)}>{nameOf(step)}</h3>
        <span className="min-w-0 truncate text-caption text-muted-foreground">{modelLabel(step.kind, step.model)}</span>
        {step.attempt > 1 && <span className="text-caption text-muted-foreground">Try {step.attempt}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {timing && <span className="text-caption text-muted-foreground tabular-nums">{timing}</span>}
          <StatusBadge key={step.status} tone={STEP_TONE[step.status] ?? "neutral"} dot className={cn(changed && ARRIVE)}>{STEP_WORDS[step.status] ?? step.status}</StatusBadge>
          {step.status !== "succeeded" && slotShape(step.kind, step.options) && <span className="-my-1 -mr-2.5"><OutputSlot step={step} /></span>}
        </span>
      </header>
      {hasBody && (
        <div className="grid min-w-0 gap-3 p-4">
          {step.status === "succeeded" && <Made step={step} />}

          {step.status === "working" && usual && <div className="max-w-lg"><ElapsedRange elapsed={elapsed} usual={usual} /></div>}

          {["skipped", "released", "failed", "blocked", "timed_out"].includes(step.status) && step.detail && (
            <p className="text-caption text-pretty text-muted-foreground" data-testid={`run-step-${step.seq}-why`}>{step.detail}</p>
          )}

          {editable && !editing && (
            <div><Button variant="outline" size="sm" onClick={startEdit} data-testid={`run-step-${step.seq}-edit`}><Pencil aria-hidden />Edit prompt and retry this step</Button></div>
          )}
          {editing && (
            <form className="grid max-w-xl gap-2" onSubmit={async (e) => {
              e.preventDefault();
              if (!onRetryStep || !prompt.trim()) return;
              setBusy(true);
              try { await onRetryStep(step, prompt.trim()); setEditing(false); } finally { setBusy(false); }
            }}>
              <label htmlFor={`retry-${step.id}`} className="text-caption font-medium text-muted-foreground">New prompt for {nameOf(step)}</label>
              <Textarea id={`retry-${step.id}`} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} className="text-body" />
              <p className="text-caption text-muted-foreground">The failed and skipped steps go again with it. What already worked is kept.</p>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={busy || !prompt.trim()}><RotateCcw aria-hidden />Retry with this prompt</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
              </div>
            </form>
          )}
        </div>
      )}
    </article>
  );
}
