// The Run tab: the recipe's input form, each field shaped like what it takes (a line, a paragraph, a Knowledge lookup, a file
// to drop), then one line that says what a run costs, whose budget it comes from and whether it waits for an admin, and Run
// (⌘↵). A run answers at once and carries on in the background, so Run opens its page. Pressing Run twice sends one click's
// key twice: one run.
import { useId, useMemo, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router";
import { BookOpen, History, Paperclip, Play, ShieldAlert, TriangleAlert, Upload, X } from "lucide-react";
import { modKey, useHotkey, useLoad } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { blockedReason, GENERATE_OFF_WORDS, needsPaidPlan, type PlaygroundCatalog } from "@/lib/catalog";
import { AiStatusNotice, PaidPlanNotice } from "@/components/studio/ai-status";
import { useLive } from "@/base/live";
import { useMe } from "@/base/session";
import { useWorkspace } from "@/base/workspace";
import { knowledgeApi } from "@/lib/knowledge";
import { money, newClickId } from "@/lib/playground";
import { FILE_INPUTS, INPUT_TYPES, lastValues, recipesApi, type RecipeDetail, type RecipeInput } from "@/lib/recipes";
import { cn } from "@/lib/utils";

const ACCEPT: Record<string, string> = { image: "image/*", audio: "audio/*", file: ".pdf,.txt,.md,image/*,audio/*" };
const ACCEPT_WORDS: Record<string, string> = { image: "An image: JPG, PNG or WebP", audio: "A recording: MP3, WAV or M4A", file: "A PDF, text, image or recording" };
const LONGEST = { text: 2000, long_text: 8000, knowledge: 200 } as const;

/** A field's label row: the label, "Optional" when it is, and what kind of answer it takes on the right. */
function FieldHead({ id, input }: { id: string; input: RecipeInput }) {
  const kind = INPUT_TYPES.find((t) => t.value === input.type)?.label ?? input.type;
  return (
    <div className="flex items-baseline justify-between gap-3">
      <Label htmlFor={id} className="text-body font-medium">
        {input.label || input.name}{!input.required && <span className="font-normal text-muted-foreground">(optional)</span>}
      </Label>
      <span className="shrink-0 text-caption text-muted-foreground">{kind}</span>
    </div>
  );
}

/** A file to give the run: drop it on the box or choose it; once given, its name, size and a way to take it back. */
function FileField({ input, file, onChange }: { input: RecipeInput; file: File | null; onChange: (f: File | null) => void }) {
  const id = useId();
  const picker = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const preview = useMemo(() => (file && file.type.startsWith("image/") ? URL.createObjectURL(file) : ""), [file]);
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onChange(f); };
  return (
    <div className="grid gap-1.5" data-kit="form-field">
      <FieldHead id={id} input={input} />
      <input ref={picker} id={id} type="file" accept={ACCEPT[input.type]} className="sr-only" data-testid={`run-input-${input.name}`}
        aria-describedby={`${id}-note`} onChange={(e) => { onChange(e.target.files?.[0] ?? null); e.target.value = ""; }} />
      {file ? (
        <div className="flex min-h-12 min-w-0 items-center gap-3 rounded-md border bg-background p-1.5 pr-2">
          {preview ? <img src={preview} alt="" className="size-10 shrink-0 rounded-sm object-cover" /> : <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground"><Paperclip className="size-4" /></span>}
          <span className="grid min-w-0 flex-1">
            <span className="truncate text-body" title={file.name}>{file.name}</span>
            <span className="text-caption text-muted-foreground tabular-nums">{(file.size / 1_048_576 >= 1 ? `${(file.size / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1024)).toLocaleString()} KB`)}</span>
          </span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${file.name}`} onClick={() => onChange(null)}><X aria-hidden /></Button>
        </div>
      ) : (
        <button type="button" onClick={() => picker.current?.click()} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
          className={cn("focus-ring flex min-h-16 items-center gap-3 rounded-md border border-dashed bg-muted/30 px-3 py-2.5 text-left transition-colors hover:bg-muted/60", over && "border-foreground bg-muted/60")}>
          <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-md border bg-background text-muted-foreground"><Upload className="size-4" /></span>
          <span className="grid min-w-0">
            <span className="text-body font-medium">Drop a file or choose one</span>
            <span id={`${id}-note`} className="text-caption text-muted-foreground">{input.hint || ACCEPT_WORDS[input.type]}</span>
          </span>
        </button>
      )}
    </div>
  );
}

export function RunForm({ detail, catalog }: { detail: RecipeDetail; catalog: PlaygroundCatalog | null }) {
  const navigate = useNavigate();
  const { recipe, steps, retired } = detail;
  const inputs = (recipe.inputs ?? []) as RecipeInput[];
  const fileInputs = inputs.filter((i) => FILE_INPUTS.includes(i.type));
  // The form opens on the inputs this person gave it last, or the team's latest run's: a run is one press away, and every value can change.
  const { nameOf } = useWorkspace();
  const me = useMe();
  const prefill = useMemo(() => lastValues(inputs, detail.history.last_inputs), [inputs, detail.history.last_inputs]);
  const [values, setValues] = useState<Record<string, string>>(prefill);
  const filled = Object.keys(prefill).length > 0 && inputs.every((i) => FILE_INPUTS.includes(i.type) || (values[i.name] ?? "") === (prefill[i.name] ?? ""));
  const from = detail.history.last_inputs_by === me.id ? "your last run" : `${nameOf(detail.history.last_inputs_by).split(" ")[0]}'s last run`;
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picksKnowledge = inputs.some((i) => i.type === "knowledge");
  const sources = useLoad(() => (picksKnowledge ? knowledgeApi.sources() : Promise.resolve(null)), [picksKnowledge]);
  useLive("kb_source", sources.reload);
  const titles = useMemo(() => (sources.data?.items ?? []).filter((s) => s.status === "ready").map((s) => s.title), [sources.data]);
  const baseId = useId();
  const hasVideo = steps.some((s) => s.kind === "video");
  const waits = hasVideo && !!catalog && !catalog.is_admin;

  const missing = inputs.find((i) => i.required && (FILE_INPUTS.includes(i.type) ? !files[i.name] : !(values[i.name] ?? "").trim()));
  // Kinds this plan can't keep are named before anything runs, step by step.
  const unkeepable = catalog && !catalog.plan_paid_storage ? steps.filter((s) => needsPaidPlan(s.kind)) : [];
  const blocked = !catalog ? "Loading…" : !catalog.can_run ? "Your role can't run recipes." : catalog.ai_status !== "on" ? GENERATE_OFF_WORDS
    : unkeepable.length ? `Needs a paid plan: ${unkeepable.map((s) => `step ${s.seq}, ${(s.name || s.kind).toLowerCase()}`).join("; ")}.`
    : retired.length ? "A model this recipe uses has been retired." : steps.map((s) => blockedReason(catalog, s.model, s.kind)).find(Boolean) ?? null;
  const why = blocked ?? (missing ? `Fill in ${missing.label || missing.name} first.` : null);

  const run = async () => {
    if (why || busy) return;
    setBusy(true);
    setError(null);
    try {
      const started = await recipesApi.run(recipe.id, newClickId(), values, fileInputs.map((i) => files[i.name] ?? null));
      navigate(`/runs/${started.run.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The run didn't start. Try again.");
      setBusy(false);
    }
  };
  useHotkey("Enter", () => void run(), { mod: true });

  const b = catalog?.budget;
  const set = (name: string, v: string) => setValues((all) => ({ ...all, [name]: v }));
  return (
    <form className="grid content-start gap-4" data-testid="recipe-run-form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
      {catalog && catalog.ai_status !== "on" && <AiStatusNotice status={catalog.ai_status} reason={catalog.ai_status_reason} fix={catalog.fix_command} />}
      {catalog && catalog.ai_status === "on" && unkeepable.length > 0 && <PaidPlanNotice />}
      <div className="grid rounded-lg border bg-card">
        <div className="grid content-start gap-5 p-4">
          {inputs.length === 0 && <p className="text-body text-muted-foreground">This recipe asks for nothing. Run it as it is.</p>}
          {filled && (
            <p className="-mb-2 flex flex-wrap items-center gap-x-2 text-caption text-muted-foreground" data-testid="run-prefilled">
              <History aria-hidden className="size-3.5" />Filled in from {from}.
              <button type="button" onClick={() => setValues({})} className="focus-ring rounded-sm font-medium text-foreground underline-offset-4 hover:underline">Clear</button>
            </p>
          )}
          {inputs.map((i, n) => {
            if (FILE_INPUTS.includes(i.type)) return <FileField key={i.name} input={i} file={files[i.name] ?? null} onChange={(f) => setFiles((all) => ({ ...all, [i.name]: f }))} />;
            const id = `${baseId}-${n}`;
            const value = values[i.name] ?? "";
            const longest = LONGEST[i.type as keyof typeof LONGEST] ?? 2000;
            return (
              <div key={i.name} className="grid gap-1.5" data-kit="form-field">
                <FieldHead id={id} input={i} />
                {i.type === "long_text" ? (
                  <>
                    <Textarea id={id} rows={4} value={value} placeholder={i.hint} maxLength={longest} onChange={(e) => set(i.name, e.target.value)} className="min-h-24 text-body" data-testid={`run-input-${i.name}`} />
                    <span className="justify-self-end text-caption text-muted-foreground tabular-nums" aria-live="off">{value.length.toLocaleString()} / {longest.toLocaleString()}</span>
                  </>
                ) : i.type === "knowledge" ? (
                  <>
                    <div className="relative">
                      <BookOpen aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input id={id} value={value} placeholder={i.hint || "What to look up"} list={`kb-${baseId}-${n}`} maxLength={longest} aria-describedby={`${id}-note`}
                        onChange={(e) => set(i.name, e.target.value)} className="pl-8 text-body" data-testid={`run-input-${i.name}`} />
                      <datalist id={`kb-${baseId}-${n}`}>{titles.map((t) => <option key={t} value={t} />)}</datalist>
                    </div>
                    <p id={`${id}-note`} className="text-caption text-muted-foreground">The closest passages in Knowledge are added to the steps that use it{titles.length ? `: pick one of ${titles.length} sources, or type what to find` : ""}.</p>
                  </>
                ) : (
                  <Input id={id} value={value} placeholder={i.hint} maxLength={longest} onChange={(e) => set(i.name, e.target.value)} className="text-body" data-testid={`run-input-${i.name}`} />
                )}
              </div>
            );
          })}
          {error && <p role="alert" className="flex gap-2 text-body text-pretty text-destructive" data-testid="run-error"><TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />{error}</p>}
        </div>

        {/* What pressing Run means, in one place: the cost, whose budget, and whether it waits for an admin first. */}
        <div className="grid gap-3 border-t bg-muted/20 p-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="grid min-w-0 flex-1 basis-56 gap-0.5 text-caption" data-testid="recipe-run-cost">
              <span className="text-body font-medium tabular-nums">Up to {money(recipe.estimate)} a run</span>
              <span className="text-muted-foreground text-pretty tabular-nums">
                Charged to your budget for what it uses{b && b.budget > 0 ? `: ${money(b.used)} of ${money(b.budget)} used in ${b.month_words}` : ""}.
              </span>
            </div>
            <Button type="submit" className="max-sm:w-full" disabled={!!why || busy} title={why ?? undefined} aria-describedby={why ? "recipe-run-why" : undefined} data-testid="recipe-run">
              <Play aria-hidden />{busy ? "Starting…" : waits ? "Ask to run" : "Run"}
              <kbd className="ml-1 rounded-sm border border-current px-1 text-micro opacity-60">{modKey("↵")}</kbd>
            </Button>
          </div>
          {waits && (
            <p className="flex items-start gap-2 text-caption text-pretty" data-testid="recipe-run-approval">
              <ShieldAlert aria-hidden className="mt-px size-4 shrink-0 text-warning" />
              <span>It makes a video, so an admin approves it before it starts. <span className="text-muted-foreground">Nothing is charged until then.</span></span>
            </p>
          )}
          {why ? <p id="recipe-run-why" className="text-caption text-muted-foreground" data-testid="recipe-run-why">{why}</p>
            : <p className="text-caption text-muted-foreground">It runs in the background: you can leave its page, and the bell tells you when it ends.</p>}
        </div>
      </div>
    </form>
  );
}
