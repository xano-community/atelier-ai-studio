// The Playground: try any Xano AI model on your own content. Pick the kind of work, a model from the live catalog and
// its settings, and run it (⌘↵). Text and images can compare two models side by side. Every result shows its time, what
// it used and what it cost. Runs start through the same door as everything else (POST
// studio/runs), so the catalog check, the click's key and the spend gate all apply; they're private to their maker.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Columns2, Lock, Sparkles } from "lucide-react";
import { EmptyState, LoadError, PageHeader, Segmented, modKey, useHotkey, useLoad, useUrlState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ModelPicker } from "@/components/studio/model-picker";
import { CostLine } from "@/components/studio/cost-line";
import { AiStatusNotice, PaidPlanNotice } from "@/components/studio/ai-status";
import { useLive } from "@/base/live";
import { api } from "@/lib/api";
import {
  blockedReason, choicesFor, findModel, fitSettings, modelsFor, needsPaidPlan, startingModel, stepKindOf, TABS,
  type AudioMode, type PlaygroundCatalog, type StepKind, type Tab,
} from "@/lib/catalog";
import { buildRequest, compareKeys, formFromStep, isFinal, missingInput, newClickId, promptForKind, STARTERS, type Form, type HistoryRow } from "@/lib/playground";
import { cn } from "@/lib/utils";
import { MusicFields, SpeechFields } from "./audio";
import { Results } from "./compare";
import { FromLibraryNotice, useFromLibrary } from "./from-library";
import { PlaygroundHistory } from "./history";
import { ImageFields, type KindFieldsProps } from "./image";
import { usePane } from "./result";
import { TextFields } from "./text";
import { TranscribeFields } from "./transcribe";
import { VideoFields } from "./video";

const TAB_VALUES = TABS.map((t) => t.value);
const FIRST_FORM: Form = {
  tab: "text", audio: "speech", model: "", compareModel: "", compare: false,
  prompt: STARTERS.text, system: "", json: false, schema: "", negative: "", useBrand: true,
  speechText: STARTERS.speech, voice: "", style: "", language: "", hint: "",
  settings: fitSettings({}, null, "text"),
};
/** Tabs whose files a plan without paid storage can't keep: video, and audio (speech and music). */
const PAID_TABS: Tab[] = ["video", "audio"];
/** Kinds that can run two models side by side. */
const COMPARABLE: StepKind[] = ["text", "image"];

/** The model Compare starts its second pane on: the next runnable one in the list. */
const secondModel = (catalog: PlaygroundCatalog | null, kind: StepKind, first: string) =>
  modelsFor(catalog, kind).find((m) => m.model !== first && !blockedReason(catalog, m.model))?.model ?? "";

/** How long a recording is, read in the browser for the transcription estimate. */
function useRecordingSeconds(file: File | null) {
  const [secs, setSecs] = useState<number | undefined>(undefined);
  useEffect(() => {
    setSecs(undefined);
    if (!file || !file.type.startsWith("audio/")) return;
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => { if (Number.isFinite(audio.duration)) setSecs(audio.duration); URL.revokeObjectURL(url); };
    audio.onerror = () => URL.revokeObjectURL(url);
    audio.src = url;
    return () => { audio.onloadedmetadata = null; URL.revokeObjectURL(url); };
  }, [file]);
  return secs;
}

export function PlaygroundPage() {
  const [q, setQ] = useUrlState({ kind: "text", from: "" });
  const tab: Tab = (TAB_VALUES as string[]).includes(q.kind) ? (q.kind as Tab) : "text";
  const catalogLoad = useLoad(() => api.catalog(), []);
  useLive(["settings", "budget"], catalogLoad.reload);
  const catalog = catalogLoad.data;

  const [form, setForm] = useState<Form>({ ...FIRST_FORM, tab });
  const [files, setFiles] = useState<Partial<Record<StepKind, File | null>>>({});
  const a = usePane(), b = usePane();
  const kind = stepKindOf(tab, form.audio);
  const file = files[kind] ?? null;
  const recordingSeconds = useRecordingSeconds(kind === "transcribe" ? file : null);
  const model = findModel(catalog, kind, form.model);
  const choices = choicesFor(model);
  const comparing = form.compare && COMPARABLE.includes(kind);

  const patch = useCallback((p: Partial<Form>) => setForm((f) => ({ ...f, ...p })), []);
  const setting = useCallback((p: Partial<Form["settings"]>) => setForm((f) => ({ ...f, settings: { ...f.settings, ...p } })), []);
  // "Use in a new run" from the Library: its file or words go into the form, and the run records where it started.
  const [from, setFrom] = useFromLibrary(Number(q.from) || 0, {
    attach: (k, f) => setFiles((all) => ({ ...all, [k]: f })),
    prompt: (prompt) => patch({ prompt }),
  });
  const clearFrom = useCallback(() => { setFrom(null); setQ({ from: "" }); }, [setFrom, setQ]);
  const fromHere = from?.state === "attached" && from.kind === kind ? from.id : 0;

  // The tab follows the URL, so back and a shared link open the same kind of work.
  useEffect(() => { setForm((f) => (f.tab === tab ? f : { ...f, tab })); }, [tab]);
  // A starter prompt follows the kind of work; anything typed stays.
  useEffect(() => { setForm((f) => { const prompt = promptForKind(f.prompt, kind); return prompt === f.prompt ? f : { ...f, prompt }; }); }, [kind]);
  // A kind's model comes from its own list; a model's settings fit what it allows.
  useEffect(() => {
    if (!catalog) return;
    setForm((f) => {
      const k = stepKindOf(f.tab, f.audio);
      const list = modelsFor(catalog, k);
      const m = list.some((x) => x.model === f.model) ? f.model : startingModel(catalog, k);
      const second = list.some((x) => x.model === f.compareModel) && f.compareModel !== m ? f.compareModel : secondModel(catalog, k, m);
      const settings = fitSettings(f.settings, findModel(catalog, k, m), k);
      return m === f.model && second === f.compareModel && JSON.stringify(settings) === JSON.stringify(f.settings) ? f : { ...f, model: m, compareModel: second, settings };
    });
  }, [catalog, tab, form.audio, form.model, form.compareModel]);

  const missing = missingInput({ ...form, compare: comparing }, !!file);
  const blocked = blockedReason(catalog, form.model, kind) ?? (comparing ? blockedReason(catalog, form.compareModel, kind) : null);
  const busy = a.pane.sending || b.pane.sending;
  const why = blocked ?? missing;

  const request = useCallback((m?: string) => {
    const r = buildRequest({ ...form, compare: comparing }, { model: m, recordingSeconds, hasFile: !!file });
    // A music model that takes no "leave out" words isn't sent any.
    if (r.kind === "music" && !choicesFor(findModel(catalog, "music", r.model)).negativePrompt) delete r.input.negative_prompt;
    if (fromHere) r.input.from_asset = fromHere;
    return r;
  }, [form, comparing, recordingSeconds, file, catalog, fromHere]);

  // What the estimate prices. A schema that doesn't parse yet blocks the run (and says why), not the page.
  const estimateOptions = useMemo(() => { try { return request().options; } catch { return {}; } }, [request]);

  const run = useCallback(() => {
    if (why || busy) return;
    const click = newClickId();
    if (comparing) {
      const [ka, kb] = compareKeys(click);
      void a.start(request(), ka, file);
      void b.start(request(form.compareModel), kb, file);
    } else {
      b.clear();
      void a.start(request(), click, file);
    }
  }, [why, busy, comparing, request, form.compareModel, file, a, b]);
  useHotkey("Enter", run, { mod: true });

  // A run that ends changes what's left of the budget.
  const ended = [a.pane.view, b.pane.view].filter((v) => v && isFinal(v.run.status)).map((v) => v!.run.id).join(",");
  useEffect(() => { if (ended) catalogLoad.reload(); }, [ended]); // eslint-disable-line react-hooks/exhaustive-deps

  const openHistory = useCallback(async (row: HistoryRow, scroll = true) => {
    const [first, second] = row.runIds;
    if (!second) b.clear();
    const [view, other] = await Promise.all([a.load(first), second ? b.load(second) : Promise.resolve(null)]);
    if (view?.steps[0]) {
      const restored = formFromStep(view.steps[0], form);
      const k = view.steps[0].kind;
      // Both models of a Compare come back as they were picked.
      setForm({ ...restored, compare: !!second, compareModel: other?.steps[0]?.model ?? restored.compareModel });
      const t: Tab = k === "speech" || k === "music" ? "audio" : (k as Tab);
      if (t !== tab) setQ({ kind: t });
      if (scroll) document.querySelector("main")?.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [a, b, form, tab, setQ]);

  // The first visit shows the last thing made of this kind, finished, with the prompt that made it: a real result from
  // the first frame instead of an empty box. Once only, and never over a library item being brought in.
  const preloaded = useRef(false);
  const onHistory = useCallback((rows: HistoryRow[]) => {
    if (preloaded.current) return;
    preloaded.current = true;
    if (q.from || a.pane.view || a.pane.sending) return;
    const last = rows.find((r) => r.kind === kind && r.status === "done" && !r.compared);
    if (last) void openHistory(last, false);
  }, [q.from, a.pane.view, a.pane.sending, kind, openHistory]);

  const openIds = [a.pane.view?.run.id, b.pane.view?.run.id].filter((x): x is number => !!x);
  const generateLabel = comparing ? "Run both" : kind === "text" ? "Run" : "Generate";

  if (catalog && !catalog.can_run) {
    return (
      <div className="flex flex-col gap-6" data-testid="playground">
        <PageHeader title="Playground" description="Try any Xano AI model on your own content." />
        <EmptyState icon={Lock} title="Your role can't run AI here" description="Guests can browse approved Library items and ask Knowledge. Ask an admin if you need to make things." />
      </div>
    );
  }

  const runButton = (
    <Button onClick={run} disabled={!!why || busy || !catalog} data-testid="generate" title={why ?? undefined} aria-describedby={why ? "run-why" : undefined}
      className={cn("disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none", comparing ? "sm:ml-auto" : "w-full")}>
      <Sparkles aria-hidden />{generateLabel}
      <kbd className="ml-1 rounded-sm border border-current px-1 font-sans text-micro opacity-60 max-sm:hidden">{modKey("↵")}</kbd>
    </Button>
  );
  // What's missing or blocked, said under the button rather than left for a greyed-out button to imply.
  const whyLine = why && catalog && <p id="run-why" className={cn("text-caption text-pretty text-muted-foreground", comparing && "sm:order-first sm:mr-auto")} data-testid="run-why">{why}</p>;
  const cost = <CostLine catalog={catalog} kind={kind} models={comparing ? [form.model, form.compareModel] : [form.model]} options={estimateOptions} className={cn(comparing && "sm:flex-1")} />;

  const kindProps: KindFieldsProps = { form, patch, setting, choices, file, setFile: (f) => {
    // A file picked by hand replaces the library item's.
    if (from && from.kind === kind) clearFrom();
    setFiles((all) => ({ ...all, [kind]: f }));
  } };
  const Fields = { text: TextFields, image: ImageFields, video: VideoFields, speech: SpeechFields, music: MusicFields, transcribe: TranscribeFields }[kind];

  const composer = (
    <div className={cn("flex min-w-0 flex-col rounded-lg border bg-card", !comparing && "lg:sticky lg:top-4")} data-testid={kind === "text" ? "text-composer" : "media-form"}>
      <div className={cn("grid gap-3 border-b p-4", comparing && "sm:grid-cols-2 sm:gap-4")}>
        <ModelPicker id="model-a" label={comparing ? "First model" : "Model"} catalog={catalog} kind={kind} value={form.model} onChange={(m) => patch({ model: m })}
          exclude={comparing ? form.compareModel : undefined} />
        {comparing && <ModelPicker id="model-b" label="Second model" catalog={catalog} kind={kind} value={form.compareModel} onChange={(compareModel) => patch({ compareModel })} exclude={form.model} />}
      </div>
      <div className="grid min-w-0 gap-4 p-4"><Fields {...kindProps} /></div>
      <div className={cn("grid gap-2.5 border-t p-4", comparing && "sm:flex sm:flex-wrap sm:items-center sm:gap-x-4")}>{cost}{whyLine}{runButton}</div>
    </div>
  );
  const results = <Results catalog={catalog} kind={kind} compare={comparing} a={a} b={b} modelA={form.model} modelB={form.compareModel} onRunAgain={run} />;

  return (
    <div className="flex flex-col gap-5" data-testid="playground">
      <PageHeader title="Playground" description="Try any Xano AI model on your own content. Every result shows its time, what it used and what it cost." />
      {!!catalogLoad.error && !catalog && <LoadError title="The model list didn't load" error={catalogLoad.error} onRetry={catalogLoad.reload} />}
      {catalog && catalog.ai_status !== "on" && <AiStatusNotice status={catalog.ai_status} reason={catalog.ai_status_reason} fix={catalog.fix_command} after="You can still look through your history." onChanged={catalogLoad.reload} />}
      {catalog && catalog.ai_status === "on" && !catalog.plan_paid_storage && needsPaidPlan(kind) && <PaidPlanNotice />}
      {from && <FromLibraryNotice from={from} onClear={clearFrom} />}

      <div className="flex min-w-0 items-center gap-2" data-testid="playground-toolbar">
        <div className="kit-scroll-x -my-1 flex min-w-0 items-center gap-2 overflow-x-auto py-1">
          <Segmented<Tab> label="Kind of work" value={tab} onChange={(kind) => setQ({ kind })}
            options={TABS.map((t) => ({ ...t, label: catalog && !catalog.plan_paid_storage && PAID_TABS.includes(t.value) ? `${t.label} · paid plan` : t.label, testId: `kind-${t.value}` }))} />
          {tab === "audio" && (
            <Segmented<AudioMode> size="xs" label="Speech or music" value={form.audio} onChange={(audio) => patch({ audio })}
              options={[{ value: "speech", label: "Speech", testId: "audio-speech" }, { value: "music", label: "Music", testId: "audio-music" }]} />
          )}
        </div>
        {COMPARABLE.includes(kind) && (
          <Button variant={comparing ? "secondary" : "ghost"} size="sm" aria-pressed={comparing} onClick={() => { a.clear(); b.clear(); patch({ compare: !form.compare }); }} data-testid="compare-toggle"
            className="ml-auto max-sm:size-8 max-sm:px-0" aria-label={comparing ? "Compare on: two models side by side" : "Compare two models"}>
            <Columns2 aria-hidden /><span className="max-sm:sr-only">{comparing ? "Comparing" : "Compare"}</span>
          </Button>
        )}
      </div>

      {!catalog && !catalogLoad.error ? (
        <div className="grid gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]" aria-label="Loading the Playground">
          <Skeleton className="h-[28rem] w-full rounded-lg" /><Skeleton className="h-[28rem] w-full rounded-lg" />
        </div>
      ) : comparing ? (
        <div className="grid gap-4">{composer}{results}</div>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">{composer}{results}</div>
      )}

      <PlaygroundHistory onOpen={openHistory} openIds={openIds} onLoaded={onHistory} />
    </div>
  );
}
