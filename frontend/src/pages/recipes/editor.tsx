// /recipes/new and /recipes/:slug/edit: a recipe's name, its input form and its steps. Each step is a card with its kind,
// model, prompt and settings. Insert puts an input or an earlier step's output into a prompt, so what a step depends on
// is always what it names; a reference to a step that runs later is shown as an error on that step. Steps move by drag
// or with Move up and Move down, and every reference follows the step it named. The estimate on the right keeps up.
// "Save as recipe" in the Playground opens this with ?from_run=<id>: a one-step draft with that run's settings.
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArrowDown, ArrowUp, ChevronDown, GripVertical, Plus, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { LoadError, PageHeader, useLoad } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { KindTile, KIND_ICON } from "@/components/studio/kind-icon";
import { ModelPicker } from "@/components/studio/model-picker";
import { api } from "@/lib/api";
import { ASPECT_WORDS, choicesFor, findModel, type PlaygroundCatalog, type StepKind } from "@/lib/catalog";
import { money } from "@/lib/playground";
import {
  draftFromRun, errorsFor, FILE_INPUTS, FILE_SLOT, fileChoices, INPUT_TYPES, insertAt, KIND_LABEL, MOST_FILE_INPUTS, MOST_STEPS, moveStep, newStep,
  planDraft, RECIPE_KINDS, recipesApi, removeStep, stepUid, wordChoices, type Draft, type DraftStep, type Estimate, type InputType, type Plan, type RecipeInput,
} from "@/lib/recipes";
import { cn } from "@/lib/utils";
import { Choice, Field, Toggle } from "../playground/fields";

const EMPTY: Draft = { name: "", description: "", status: "draft", inputs: [], steps: [] };
/** An input's name, from its label: "Product name" → product_name. */
export const nameFromLabel = (label: string) => label.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "i_$1").slice(0, 40);
const PROMPT_LABEL: Record<string, string> = { text: "Prompt", image: "Prompt", video: "Prompt", music: "Prompt", speech: "Words to say", transcribe: "Hint (optional)" };
const BRANDABLE: StepKind[] = ["text", "image", "video", "speech", "music"];

export function RecipeEditorPage() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const fromRun = Number(params.get("from_run") ?? 0);
  const navigate = useNavigate();
  const catalog = useLoad(() => api.catalog(), []);
  const source = useLoad(async () => {
    if (slug) return { kind: "recipe" as const, detail: await recipesApi.get(slug) };
    if (fromRun) return { kind: "run" as const, draft: draftFromRun(await api.run(fromRun)) };
    return null;
  }, [slug, fromRun]);
  const [draft, setDraft] = useState<Draft | null>(slug || fromRun ? null : EMPTY);
  useEffect(() => {
    const s = source.data;
    if (!s) return;
    if (s.kind === "run") setDraft(s.draft);
    else {
      const r = s.detail.recipe;
      setDraft({ name: r.name, description: r.description ?? "", status: r.status, inputs: (r.inputs ?? []) as RecipeInput[],
        steps: s.detail.steps.map((x) => ({ uid: stepUid(), name: x.name, kind: x.kind as StepKind, model: x.model, prompt: x.prompt ?? "", file: x.file ?? "", settings: x.settings ?? {}, options: x.options ?? {} })) });
    }
  }, [source.data]);

  if (source.error || catalog.error) {
    return <div className="grid gap-4"><PageHeader title="Recipe" back={{ href: "/recipes", label: "Recipes" }} /><LoadError title="This didn't load" error={source.error ?? catalog.error} onRetry={() => { source.reload(); catalog.reload(); }} /></div>;
  }
  if (!draft || !catalog.data) {
    return <div className="grid gap-4" aria-label="Loading the editor"><Skeleton className="h-9 w-72" /><div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]"><Skeleton className="h-96 w-full" /><Skeleton className="h-48 w-full" /></div></div>;
  }
  const existing = source.data?.kind === "recipe" ? source.data.detail.recipe : null;
  return <Editor key={existing?.id ?? `new-${fromRun}`} initial={draft} catalog={catalog.data} existing={existing} fromRun={fromRun}
    onSaved={(savedSlug) => navigate(`/recipes/${savedSlug}`)} />;
}

function Editor({ initial, catalog, existing, fromRun, onSaved }: {
  initial: Draft; catalog: PlaygroundCatalog; existing: { id: number; slug: string; status: string } | null; fromRun: number; onSaved: (slug: string) => void;
}) {
  // A new recipe starts with one text step, on the suggested model.
  const [draft, setDraft] = useState<Draft>(() => (initial.steps.length ? initial : { ...initial, steps: [newStep("text", catalog, 1)] }));
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const plan = useMemo(() => planDraft(draft), [draft]);
  const estimate = useEstimate(draft, plan.ok);
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));
  const setStep = (i: number, s: DraftStep) => setDraft((d) => ({ ...d, steps: d.steps.map((x, n) => (n === i ? s : x)) }));
  const nameMissing = !draft.name.trim();

  const save = async (status: Draft["status"]) => {
    setTried(true);
    if (nameMissing || !plan.ok) { document.querySelector("[data-invalid='true']")?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    setSaving(true);
    setServerError(null);
    try {
      const body = { ...draft, status };
      const saved = existing ? await recipesApi.update(existing.id, body) : await recipesApi.create(body);
      toast.success(status === "published" ? `${saved.name} is published` : `Saved ${saved.name}`);
      onSaved(saved.slug);
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "It didn't save. Try again.");
      setSaving(false);
    }
  };

  const fileInputCount = draft.inputs.filter((i) => FILE_INPUTS.includes(i.type)).length;
  return (
    <div className="flex flex-col gap-5" data-testid="recipe-editor">
      <PageHeader title={existing ? `Edit ${initial.name}` : fromRun ? "Save as recipe" : "New recipe"} back={{ href: existing ? `/recipes/${existing.slug}` : "/recipes", label: existing ? initial.name : "Recipes" }}
        description={fromRun ? "A one-step draft with your Playground run's settings. Add inputs and steps, then publish it for the team." : "An input form and steps. Each step can use the inputs and what earlier steps made."}
        actions={<>
          <Button variant="ghost" size="sm" asChild><Link to={existing ? `/recipes/${existing.slug}` : "/recipes"}>Cancel</Link></Button>
          <Button variant="outline" size="sm" disabled={saving} onClick={() => void save("draft")} data-testid="recipe-save-draft">{existing?.status === "published" ? "Unpublish and save" : "Save draft"}</Button>
          <Button size="sm" disabled={saving} onClick={() => void save("published")} data-testid="recipe-publish">{existing?.status === "published" ? "Save" : "Publish"}</Button>
        </>} />
      {serverError && <p role="alert" className="flex gap-2 rounded-lg border bg-card p-3 text-body text-pretty" data-testid="recipe-save-error"><TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />{serverError}</p>}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="grid min-w-0 gap-5">
          <section className="grid gap-3 rounded-lg border bg-card p-4" aria-label="About">
            <Field label="Name" htmlFor="recipe-name">
              <Input id="recipe-name" value={draft.name} onChange={(e) => patch({ name: e.target.value })} maxLength={80} placeholder="Product launch kit" className="text-body"
                data-invalid={tried && nameMissing} aria-invalid={tried && nameMissing ? true : undefined} data-testid="recipe-name" />
            </Field>
            {tried && nameMissing && <p role="alert" className="-mt-1 text-caption text-destructive">Give the recipe a name.</p>}
            <Field label="What it's for (optional)" htmlFor="recipe-description">
              <Input id="recipe-description" value={draft.description} onChange={(e) => patch({ description: e.target.value })} maxLength={200} placeholder="Copy, a hero image and a voiceover for a new product" className="text-body" />
            </Field>
          </section>

          <InputsCard inputs={draft.inputs} plan={plan} onChange={(inputs) => patch({ inputs })} fileInputCount={fileInputCount} />

          <section className="grid gap-3" aria-label="Steps">
            <div className="flex items-center gap-2">
              <h2 className="text-heading">Steps</h2>
              <p className="text-caption text-muted-foreground">Run one at a time, top to bottom.</p>
            </div>
            <StepList draft={draft} plan={plan} catalog={catalog} estimate={estimate} setStep={setStep} onSteps={(steps) => patch({ steps })} />
            {draft.steps.length < MOST_STEPS && <AddStep onAdd={(kind) => patch({ steps: [...draft.steps, newStep(kind, catalog, draft.steps.length + 1)] })} />}
          </section>
        </div>
        <EstimatePanel draft={draft} plan={plan} estimate={estimate} />
      </div>
    </div>
  );
}

/** The run's estimate for the steps on screen, refreshed a moment after they stop changing. */
function useEstimate(draft: Draft, ok: boolean) {
  const [est, setEst] = useState<Estimate | null>(null);
  const key = JSON.stringify([draft.inputs, draft.steps]);
  useEffect(() => {
    if (!ok) return;
    let live = true;
    const t = setTimeout(() => { recipesApi.estimate(draft).then((e) => { if (live) setEst(e); }, () => { if (live) setEst(null); }); }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [key, ok]); // eslint-disable-line react-hooks/exhaustive-deps
  return ok ? est : null;
}

function InputsCard({ inputs, plan, onChange, fileInputCount }: { inputs: RecipeInput[]; plan: Plan; onChange: (inputs: RecipeInput[]) => void; fileInputCount: number }) {
  const errors = errorsFor(plan, 0).filter((e) => e.field.startsWith("inputs"));
  const set = (i: number, p: Partial<RecipeInput>) => onChange(inputs.map((x, n) => (n === i ? { ...x, ...p } : x)));
  const add = () => {
    let n = inputs.length + 1;
    while (inputs.some((i) => i.name === `input_${n}`)) n++;
    onChange([...inputs, { name: `input_${n}`, label: `Input ${n}`, type: "text", required: true }]);
  };
  return (
    <section className="rounded-lg border bg-card" aria-label="Inputs" data-testid="recipe-inputs">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <h2 className="text-heading">Inputs</h2>
        <p className="hidden truncate text-caption text-muted-foreground sm:block">What the run form asks for each time.</p>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={add} disabled={inputs.length >= 10} data-testid="input-add"><Plus aria-hidden />Add input</Button>
      </header>
      {inputs.length === 0 ? <p className="px-4 py-3 text-body text-muted-foreground">No inputs: every run is the same. Add one to ask for a product name, a photo or a pick from Knowledge.</p> : (
        <ul className="divide-y">
          {inputs.map((input, i) => {
            const mine = errors.filter((e) => e.field === `inputs.${i}`);
            const fileFull = fileInputCount >= MOST_FILE_INPUTS && !FILE_INPUTS.includes(input.type);
            return (
              <li key={i} className="grid gap-2 px-4 py-3" data-testid={`input-row-${i}`}>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem_auto_auto] sm:items-center">
                  <Input value={input.label} aria-label={`Input ${i + 1} label`} placeholder="Product" className="h-8 text-body" data-testid={`input-label-${i}`}
                    onChange={(e) => { const label = e.target.value; const auto = input.name === nameFromLabel(input.label) || /^input_\d+$/.test(input.name); set(i, { label, ...(auto && nameFromLabel(label) ? { name: nameFromLabel(label) } : {}) }); }} />
                  <Select value={input.type} onValueChange={(v) => set(i, { type: v as InputType })}>
                    <SelectTrigger className="h-8 w-full text-body" aria-label={`Input ${i + 1} type`}><SelectValue /></SelectTrigger>
                    <SelectContent position="popper">{INPUT_TYPES.map((t) => <SelectItem key={t.value} value={t.value} disabled={fileFull && FILE_INPUTS.includes(t.value)}>{t.label}</SelectItem>)}</SelectContent>
                  </Select>
                  <label className="flex items-center gap-2 text-caption text-muted-foreground"><Checkbox checked={input.required} onCheckedChange={(v) => set(i, { required: v === true })} />Required</label>
                  <Button variant="ghost" size="icon" className="size-8" aria-label={`Remove ${input.label || `input ${i + 1}`}`} onClick={() => onChange(inputs.filter((_, n) => n !== i))}><Trash2 aria-hidden /></Button>
                </div>
                <p className="text-caption text-muted-foreground">Used as <code className="font-mono text-foreground">{`{{input.${input.name || "…"}}}`}</code>{input.type === "knowledge" ? ": the run form asks what to look up, and the closest passages go into the prompt." : ""}</p>
                {mine.map((e) => <p key={e.message} role="alert" className="text-caption text-destructive">{e.message}</p>)}
              </li>
            );
          })}
        </ul>
      )}
      {errors.filter((e) => e.field === "inputs").map((e) => <p key={e.message} role="alert" className="border-t px-4 py-2 text-caption text-destructive">{e.message}</p>)}
    </section>
  );
}

/** Add a step of a kind; the new step's prompt takes the focus, so writing it is the next thing. */
function AddStep({ onAdd }: { onAdd: (kind: StepKind) => void }) {
  const added = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="justify-self-start" data-testid="step-add"><Plus aria-hidden />Add a step<ChevronDown aria-hidden /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={(e) => {
        if (!added.current) return;
        added.current = false;
        const prompts = document.querySelectorAll<HTMLElement>('[data-testid^="step-prompt-"]');
        if (prompts.length) { e.preventDefault(); prompts[prompts.length - 1].focus(); }
      }}>
        {RECIPE_KINDS.map((k) => { const Icon = KIND_ICON[k]; return <DropdownMenuItem key={k} onSelect={() => { added.current = true; onAdd(k); }} data-testid={`step-add-${k}`}><Icon aria-hidden />{KIND_LABEL[k]}</DropdownMenuItem>; })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StepList({ draft, plan, catalog, estimate, setStep, onSteps }: {
  draft: Draft; plan: Plan; catalog: PlaygroundCatalog; estimate: Estimate | null; setStep: (i: number, s: DraftStep) => void; onSteps: (s: DraftStep[]) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const move = (from: number, to: number) => {
    onSteps(moveStep(draft.steps, from, to));
    // Keep the moved step's handle focused, so a keyboard can keep moving it.
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="step-handle-${to}"]`)?.focus());
  };
  return (
    <ol className="grid gap-3">
      {draft.steps.map((step, i) => (
        <li key={step.uid ?? i} onDragOver={(e) => { if (dragging !== null) { e.preventDefault(); setOver(i); } }} onDragLeave={() => setOver((o) => (o === i ? null : o))}
          onDrop={(e) => { e.preventDefault(); if (dragging !== null) move(dragging, i); setDragging(null); setOver(null); }}
          className={cn("rounded-lg border bg-card transition-shadow", over === i && dragging !== i && "ring-2 ring-ring/40", dragging === i && "opacity-60")}>
          <StepCard draft={draft} index={i} step={step} plan={plan} catalog={catalog} amount={estimate?.steps.find((s) => s.recipe_seq === i + 1)}
            onChange={(s) => setStep(i, s)} onRemove={() => onSteps(removeStep(draft.steps, i))}
            onMove={(to) => move(i, to)} onDragStart={() => setDragging(i)} onDragEnd={() => { setDragging(null); setOver(null); }} />
        </li>
      ))}
    </ol>
  );
}

function StepCard({ draft, index, step, plan, catalog, amount, onChange, onRemove, onMove, onDragStart, onDragEnd }: {
  draft: Draft; index: number; step: DraftStep; plan: Plan; catalog: PlaygroundCatalog; amount?: Estimate["steps"][number];
  onChange: (s: DraftStep) => void; onRemove: () => void; onMove: (to: number) => void; onDragStart: () => void; onDragEnd: () => void;
}) {
  const seq = index + 1;
  const prompt = useRef<HTMLTextAreaElement>(null);
  const model = findModel(catalog, step.kind, step.model);
  const choices = choicesFor(model);
  const set = (p: Partial<DraftStep>) => onChange({ ...step, ...p });
  const setting = (k: string, v: unknown) => set({ settings: { ...step.settings, [k]: v } });
  const option = (k: string, v: unknown) => set({ options: { ...step.options, [k]: v } });
  const errs = (field: string) => errorsFor(plan, seq, field);
  const words = wordChoices(draft, index);
  const files = fileChoices(draft, index);
  const slot = FILE_SLOT[step.kind];
  const deps = plan.steps[index]?.depends_on ?? [];
  const insert = (token: string) => {
    const el = prompt.current;
    const { text, cursor } = insertAt(step.prompt, token, el?.selectionStart ?? step.prompt.length, el?.selectionEnd ?? step.prompt.length);
    set({ prompt: text });
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(cursor, cursor); });
  };
  const changeKind = (kind: StepKind) => {
    const fresh = newStep(kind, catalog, seq);
    onChange({ ...fresh, name: step.name, prompt: step.prompt, file: FILE_SLOT[kind] ? step.file : "" });
  };
  const changeModel = (m: string) => {
    const c = choicesFor(findModel(catalog, step.kind, m));
    const o = { ...step.options };
    if (c.imageSizes.length && !c.imageSizes.includes(String(o.size))) o.size = c.imageSizes[0];
    if (c.aspectRatios.length && !c.aspectRatios.includes(String(o.aspect_ratio))) o.aspect_ratio = c.aspectRatios[0];
    if (c.durations.length && !c.durations.includes(Number(o.seconds))) o.seconds = Math.max(...c.durations);
    if (c.resolutions.length && !c.resolutions.includes(String(o.resolution))) o.resolution = c.resolutions[0];
    const s = { ...step.settings };
    if (s.voice && !c.voices.includes(String(s.voice))) delete s.voice;
    onChange({ ...step, model: m, options: o, settings: s });
  };
  const promptErrs = errs("prompt");
  const fileErrs = errs("file");
  return (
    <div className="grid gap-3 p-4" data-testid={`step-card-${seq}`}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }} onDragEnd={onDragEnd}
          onKeyDown={(e) => { if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); onMove(index - 1); } if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); onMove(index + 1); } }}
          aria-label={`Step ${seq}. Drag, or press Alt and an arrow key, to move it`} data-testid={`step-handle-${index}`}
          className="focus-ring grid h-8 w-5 cursor-grab place-items-center rounded-sm text-muted-foreground hover:text-foreground active:cursor-grabbing">
          <GripVertical aria-hidden className="size-4" />
        </button>
        <span className="grid size-6 shrink-0 place-items-center rounded-full border text-caption font-medium tabular-nums">{seq}</span>
        <Input value={step.name} onChange={(e) => set({ name: e.target.value })} aria-label={`Step ${seq} name`} maxLength={60} className="h-8 min-w-0 flex-1 basis-40 text-body font-medium" data-testid={`step-name-${seq}`} />
        <Select value={step.kind} onValueChange={(v) => changeKind(v as StepKind)}>
          <SelectTrigger className="h-8 w-36 text-body" aria-label={`Step ${seq} kind`} data-testid={`step-kind-${seq}`}><span className="flex items-center gap-2"><KindTile kind={step.kind} className="size-5 border-0 bg-transparent" />{KIND_LABEL[step.kind]}</span></SelectTrigger>
          <SelectContent position="popper">{RECIPE_KINDS.map((k) => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}</SelectContent>
        </Select>
        <div className="ml-auto flex items-center">
          <Button variant="ghost" size="icon" className="size-8" aria-label={`Move step ${seq} up`} disabled={index === 0} onClick={() => onMove(index - 1)}><ArrowUp aria-hidden /></Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label={`Move step ${seq} down`} disabled={index === draft.steps.length - 1} onClick={() => onMove(index + 1)}><ArrowDown aria-hidden /></Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label={`Remove step ${seq}`} disabled={draft.steps.length === 1} onClick={onRemove}><Trash2 aria-hidden /></Button>
        </div>
      </div>
      {errs("name").map((e) => <p key={e.message} role="alert" className="text-caption text-destructive">{e.message}</p>)}

      <div className="grid gap-3 md:grid-cols-2">
        <ModelPicker id={`step-model-${seq}`} catalog={catalog} kind={step.kind} value={step.model} onChange={changeModel} />
        {slot && (
          <Field label={slot.label} htmlFor={`step-file-${seq}`}>
            <Select value={step.file || "none"} onValueChange={(v) => set({ file: v === "none" ? "" : v })}>
              <SelectTrigger id={`step-file-${seq}`} className="h-8 w-full text-body" data-testid={`step-file-${seq}`} aria-invalid={fileErrs.length ? true : undefined}>
                <SelectValue>{files.find((f) => f.token === step.file)?.label ?? (step.file ? step.file : step.kind === "transcribe" ? "Pick a recording" : "None")}</SelectValue>
              </SelectTrigger>
              <SelectContent position="popper">
                {step.kind !== "transcribe" && <SelectItem value="none">None</SelectItem>}
                {files.map((f) => <SelectItem key={f.token} value={f.token}>{f.label} <span className="text-muted-foreground">· {f.detail}</span></SelectItem>)}
                {files.length === 0 && <div className="px-2 py-1.5 text-caption text-muted-foreground">Add a matching input, or an earlier step that makes one.</div>}
              </SelectContent>
            </Select>
          </Field>
        )}
      </div>
      {fileErrs.map((e) => <p key={e.message} role="alert" className="-mt-1 text-caption text-destructive" data-testid={`step-error-${seq}`}>{e.message}</p>)}

      <div className="grid min-w-0 gap-1.5" data-invalid={promptErrs.length ? "true" : undefined}>
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={`step-prompt-${seq}`} className="text-caption font-medium text-muted-foreground">{PROMPT_LABEL[step.kind]}</label>
          <div className="flex items-center gap-1">
            {BRANDABLE.includes(step.kind) && <Toggle label="Brand kit" on={step.settings.use_brand !== false} onChange={(v) => setting("use_brand", v)} className="-my-1 h-6" />}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs" disabled={!words.length} data-testid={`step-insert-${seq}`} title={words.length ? undefined : "Add an input, or a step before this one that makes words"}><Plus aria-hidden />Insert<ChevronDown aria-hidden /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-w-80">
                <DropdownMenuLabel className="text-caption text-muted-foreground">Put in this prompt</DropdownMenuLabel>
                {words.map((w) => (
                  <DropdownMenuItem key={w.token} onSelect={() => insert(w.token)} data-testid={`insert-${w.token}`}>
                    <span className="grid min-w-0"><span className="truncate">{w.label}</span><span className="truncate text-caption text-muted-foreground">{w.detail} · <code className="font-mono">{w.token}</code></span></span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <Textarea ref={prompt} id={`step-prompt-${seq}`} value={step.prompt} onChange={(e) => set({ prompt: e.target.value })} rows={step.kind === "transcribe" ? 2 : 4}
          aria-invalid={promptErrs.length ? true : undefined} aria-describedby={promptErrs.length ? `step-prompt-${seq}-err` : undefined}
          placeholder={step.kind === "speech" ? "Insert an earlier step's script, or write the words" : step.kind === "transcribe" ? "Names or words it should spell right" : "What to make. Insert an input or an earlier step's output."}
          className="max-h-72 min-h-20 resize-y font-mono text-body" data-testid={`step-prompt-${seq}`} />
        <div id={`step-prompt-${seq}-err`}>
          {promptErrs.map((e) => (
            <p key={e.message} role="alert" className="text-caption text-destructive" data-testid={`step-error-${seq}`}>
{e.message}
            </p>
          ))}
        </div>
        <p className="text-caption text-muted-foreground" data-testid={`step-uses-${seq}`}>
          {deps.length ? `Uses ${deps.map((d) => `step ${d}`).join(" and ")}: if ${deps.length > 1 ? "one doesn't" : "it doesn't"} succeed, this step is skipped.` : seq > 1 ? "Uses no earlier step, so it runs whatever happens to them." : "Runs first."}
          {amount ? ` ${amount.priced ? `About ${money(amount.amount)}.` : "No price set for this model."}` : ""}
        </p>
      </div>

      <KindSettings step={step} choices={choices} setting={setting} option={option} seq={seq} />
    </div>
  );
}

function KindSettings({ step, choices, setting, option, seq }: {
  step: DraftStep; choices: ReturnType<typeof choicesFor>; setting: (k: string, v: unknown) => void; option: (k: string, v: unknown) => void; seq: number;
}) {
  const [schemaText, setSchemaText] = useState(() => (step.settings.json_schema ? JSON.stringify(step.settings.json_schema, null, 2) : ""));
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const s = step.settings, o = step.options;
  switch (step.kind) {
    case "text":
      return (
        <div className="grid gap-3 border-t pt-3">
          <div className="flex flex-wrap items-center gap-3">
            <Toggle label="Return JSON" on={s.response_format === "json"} onChange={(v) => setting("response_format", v ? "json" : "text")} testId={`step-json-${seq}`} />
            <label className="flex items-center gap-2 text-caption text-muted-foreground">Longest reply
              <Input type="number" min={200} max={choices.maxOutputTokens ?? 64000} step={100} value={Number(o.output_tokens ?? 4000)} onChange={(e) => option("output_tokens", Math.max(1, Number(e.target.value) || 0))} className="h-7 w-24 text-body tabular-nums" />
              tokens
            </label>
          </div>
          {s.response_format === "json" && (
            <Field label="Shape of the reply (JSON schema)" hint="Its fields can be inserted into later steps">
              <Textarea rows={5} value={schemaText} className="font-mono text-caption" aria-invalid={schemaError ? true : undefined}
                placeholder='{"type": "object", "properties": {"headline": {"type": "string"}, "script": {"type": "string"}}}'
                onChange={(e) => setSchemaText(e.target.value)}
                onBlur={() => {
                  if (!schemaText.trim()) { setSchemaError(null); setting("json_schema", undefined); return; }
                  try { const v = JSON.parse(schemaText); if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(); setSchemaError(null); setting("json_schema", v); }
                  catch { setSchemaError("That isn't a JSON object. Fix it, or clear it to let the model choose the shape."); }
                }} />
              {schemaError && <p role="alert" className="text-caption text-destructive">{schemaError}</p>}
            </Field>
          )}
          <Field label="Instructions for the model (optional)" htmlFor={`step-system-${seq}`}>
            <Textarea id={`step-system-${seq}`} rows={2} value={String(s.system ?? "")} onChange={(e) => setting("system", e.target.value)} className="text-body" placeholder="Write in the brand's voice. Keep it under 80 words." />
          </Field>
        </div>
      );
    case "image":
      return (
        <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
          <Choice label="Size" value={String(o.size ?? "1K")} options={choices.imageSizes} onChange={(v) => option("size", v)} />
          <Choice label="Shape" value={String(o.aspect_ratio ?? "1:1")} options={choices.aspectRatios} onChange={(v) => option("aspect_ratio", v)} words={(v) => ASPECT_WORDS[v] ?? v} />
        </div>
      );
    case "video":
      return (
        <div className="grid gap-3 border-t pt-3 sm:grid-cols-2 xl:grid-cols-4">
          <Choice label="Length" value={Number(o.seconds ?? 8)} options={choices.durations} onChange={(v) => option("seconds", v)} words={(v) => `${v} s`} />
          <Choice label="Resolution" value={String(o.resolution ?? "720p")} options={choices.resolutions} onChange={(v) => option("resolution", v)} />
          <Choice label="Shape" value={String(o.aspect_ratio ?? "16:9")} options={choices.aspectRatios} onChange={(v) => option("aspect_ratio", v)} words={(v) => ASPECT_WORDS[v] ?? v} />
          <Field label="Sound"><Toggle label="With sound" on={o.audio === true} onChange={(v) => option("audio", v)} className="justify-self-start" /></Field>
        </div>
      );
    case "speech":
      return (
        <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
          <Choice label="Voice" value={String(s.voice ?? choices.voices[0] ?? "")} options={choices.voices} onChange={(v) => setting("voice", v)} />
          <Field label="How it's said (optional)" htmlFor={`step-style-${seq}`}>
            <Input id={`step-style-${seq}`} value={String(s.instructions ?? "")} onChange={(e) => setting("instructions", e.target.value)} className="h-8 text-body" placeholder="Warm and unhurried" />
          </Field>
        </div>
      );
    case "music":
      return choices.negativePrompt ? (
        <div className="grid gap-3 border-t pt-3">
          <Field label="Leave out (optional)" htmlFor={`step-negative-${seq}`}>
            <Input id={`step-negative-${seq}`} value={String(s.negative_prompt ?? "")} onChange={(e) => setting("negative_prompt", e.target.value)} className="h-8 text-body" placeholder="vocals, drums" />
          </Field>
        </div>
      ) : null;
    case "transcribe":
      return (
        <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
          <Field label="Language (optional)" htmlFor={`step-language-${seq}`}>
            <Input id={`step-language-${seq}`} value={String(s.language ?? "")} onChange={(e) => setting("language", e.target.value)} className="h-8 text-body" placeholder="en" />
          </Field>
        </div>
      );
  }
}

function EstimatePanel({ draft, plan, estimate }: { draft: Draft; plan: Plan; estimate: Estimate | null }) {
  const problems = plan.errors.length;
  const hasVideo = draft.steps.some((s) => s.kind === "video");
  return (
    <aside className="grid gap-3 lg:sticky lg:top-4" aria-label="Estimate">
      <section className="rounded-lg border bg-card">
        <h2 className="border-b px-4 py-2.5 text-heading">A run costs about</h2>
        <div className="grid gap-2 p-4" aria-live="polite" data-testid="recipe-estimate">
          {problems > 0 ? (
            <p className="text-caption text-pretty text-muted-foreground">Fix {problems === 1 ? "the problem" : `the ${problems} problems`} in the steps to see the estimate.</p>
          ) : !estimate ? <Skeleton className="h-16 w-full" /> : (
            <>
              <ul className="grid gap-1 text-caption">
                {estimate.steps.map((s) => (
                  <li key={s.seq} className="flex justify-between gap-3"><span className="truncate text-muted-foreground">{s.label}</span><span className="shrink-0 tabular-nums">{s.priced ? money(s.amount) : "no price"}</span></li>
                ))}
              </ul>
              <p className="flex justify-between gap-3 border-t pt-2 text-body font-medium tabular-nums"><span>Up to</span><span>{money(estimate.total)}</span></p>
              <p className="text-caption text-pretty text-muted-foreground">With every input at its longest. Each step is charged for what it uses.</p>
              {estimate.unpriced && <p className="text-caption text-pretty text-destructive">{estimate.unpriced}</p>}
            </>
          )}
        </div>
      </section>
      {hasVideo && <p className="rounded-lg border bg-card p-3 text-caption text-pretty text-muted-foreground">It makes a video, so a member's run waits for an admin to approve it. One approval covers the whole run.</p>}
    </aside>
  );
}
