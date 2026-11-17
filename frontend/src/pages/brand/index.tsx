// /brand: what makes output sound and look like the company. Voice rules and words to avoid go to text prompts; visual
// rules and colours to image and video prompts, and the reference images to image runs; the voice and music defaults
// to speech and music steps that leave them empty. Every run gets the kit unless it's turned off for that run.
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { Download, ImageIcon, ImagePlus, Mic, Palette, Plus, Trash2, Type, X } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@xano-sdk/rbac/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Ago, EmptyState, LoadError, modKey, PageHeader, useHotkey, useLoad } from "@/components/kit";
import { useLive } from "@/base/live";
import { useWorkspace } from "@/base/workspace";
import {
  BRAND_LIMITS, IMAGE_ACCEPT, addWords, brandApi, draftOf, isEmptyKit, normalHex, sameDraft, type BrandColour, type BrandDraft, type BrandImage, type BrandKit,
} from "@/lib/brand";
import { cn } from "@/lib/utils";

const MODEL_VOICE = "__model__";

export function BrandPage() {
  const canRun = useCan("studio.run");
  if (!canRun) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="Brand kit" />
        <EmptyState icon={Palette} title="The brand kit is for people who run models"
          description="It shapes every run's prompt, and a guest's role can't start runs. Approved work is in the Library." />
      </div>
    );
  }
  return <BrandEditor />;
}

function BrandEditor() {
  const kit = useLoad(() => brandApi.read(), []);
  const canEdit = useCan("recipes.manage");
  const { nameOf } = useWorkspace();
  const [draft, setDraft] = useState<BrandDraft | null>(null);
  const [base, setBase] = useState<BrandKit | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = !!draft && !!base && !sameDraft(draft, draftOf(base));
  // Someone else saved while this page had changes: say so, and let the person choose.
  const theirs = !!kit.data && !!base && dirty && kit.data.updated_at !== base.updated_at;

  useLive("brand", kit.reload);
  useEffect(() => {
    if (!kit.data) return;
    if (!dirty) { setBase(kit.data); setDraft(draftOf(kit.data)); }
    else setBase((b) => (b ? { ...b, images: kit.data!.images } : kit.data));
    // Only a fresh read resets the form, and never over unsaved changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kit.data]);

  const set = <K extends keyof BrandDraft>(key: K, value: BrandDraft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));

  async function save(e?: FormEvent) {
    e?.preventDefault();
    if (!draft || !dirty || saving) return;
    setSaving(true);
    try {
      const saved = await brandApi.save(draft);
      setBase(saved); setDraft(draftOf(saved)); kit.setData(saved); setError(null);
      toast.success("Brand kit saved. New runs use it from now on.");
    } catch (err) { setError(err instanceof Error ? err.message : "That didn't save. Try again."); }
    finally { setSaving(false); }
  }
  const discard = () => { if (kit.data) { setBase(kit.data); setDraft(draftOf(kit.data)); setError(null); } };
  useHotkey("s", () => void save(), { mod: true, enabled: canEdit && dirty });

  const images = base?.images ?? [];
  const empty = draft ? isEmptyKit(draft, images.length) : false;

  return (
    <form onSubmit={save} className="flex flex-col gap-5" data-testid="brand-page" aria-busy={saving}>
      <PageHeader title="Brand kit" description="Added to every run unless it's turned off for that run. The run page says when it was.">
        {base?.updated_at ? <p className="text-caption text-muted-foreground">Last saved by {nameOf(base.updated_by)}, <Ago value={base.updated_at} /></p> : null}
      </PageHeader>

      {kit.error && !draft ? <LoadError error={kit.error} onRetry={kit.reload} /> : !draft || !base ? <BrandSkeleton /> : (
        <>
          {!canEdit && <p className="rounded-md border bg-card p-3 text-body text-pretty text-muted-foreground">You can read the kit. Admins and members who manage recipes can change it.</p>}
          {empty && canEdit && <p className="rounded-md border bg-card p-3 text-body text-pretty text-muted-foreground">Nothing's in the kit yet, so runs go out exactly as written. Start with how the brand sounds.</p>}
          {theirs && (
            <div role="status" className="flex flex-wrap items-center gap-3 rounded-md border bg-card p-3 text-body">
              <span className="min-w-0 flex-1 text-pretty">{nameOf(kit.data!.updated_by)} saved the kit while you were editing. Saving now replaces their changes.</span>
              <Button type="button" size="sm" variant="outline" onClick={discard}>Load their version</Button>
            </div>
          )}
          {error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-body text-pretty">{error}</p>}
          <div className="grid gap-4 lg:grid-cols-3">
            <KitCard icon={Type} title="Voice" goesTo="Added to text prompts as instructions.">
              <TextField label="How we sound" value={draft.voice} onChange={(v) => set("voice", v)} disabled={!canEdit} max={BRAND_LIMITS.words} rows={5}
                placeholder="For example: plain, warm and a little dry. Short sentences. We talk about riding, not specs." testId="brand-voice" />
              <WordsField words={draft.avoid_words} onChange={(v) => set("avoid_words", v)} disabled={!canEdit} />
            </KitCard>
            <KitCard icon={ImageIcon} title="Look" goesTo="Visual rules and colours are added to image and video prompts. Reference images go with image runs.">
              <TextField label="Visual rules" value={draft.visual_rules} onChange={(v) => set("visual_rules", v)} disabled={!canEdit} max={BRAND_LIMITS.words} rows={4}
                placeholder="For example: natural light, real places, no lens flare. Bikes are shown ridden or leaning, never floating." testId="brand-visual" />
              <ColoursField colours={draft.colours} onChange={(v) => set("colours", v)} disabled={!canEdit} />
              <ReferenceImages images={images} canEdit={canEdit} onChanged={kit.reload} />
            </KitCard>
            <KitCard icon={Mic} title="Sound" goesTo="Used by speech and music steps that don't set their own.">
              <VoiceField voice={draft.default_voice} voices={base.voices} onChange={(v) => set("default_voice", v)} disabled={!canEdit} />
              <TextField label="How the voice speaks" value={draft.voice_style} onChange={(v) => set("voice_style", v)} disabled={!canEdit} max={BRAND_LIMITS.style} rows={2}
                placeholder="For example: calm, friendly, medium pace" testId="brand-voice-style" />
              <TextField label="Music style" value={draft.music_style} onChange={(v) => set("music_style", v)} disabled={!canEdit} max={BRAND_LIMITS.style} rows={2}
                placeholder="For example: warm indie, around 100 bpm, no vocals" testId="brand-music" />
            </KitCard>
          </div>
          <p className="text-caption text-pretty text-muted-foreground">
            To see the difference, run the same prompt in the <Link to="/playground" className="underline underline-offset-2 hover:text-foreground">Playground</Link> with the brand kit on, then off.
          </p>
        </>
      )}
      {canEdit && dirty && (
        <div role="region" aria-label="Unsaved changes" data-testid="brand-unsaved"
          className="sticky bottom-3 z-20 mx-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-popover px-3 py-2 text-body shadow-lg">
          <span className="text-pretty">Unsaved changes to the brand kit</span>
          <span className="ml-auto flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={discard} disabled={saving}>Discard</Button>
            <Button type="submit" size="sm" disabled={saving} data-testid="brand-save">{saving ? "Saving…" : "Save changes"}<kbd className="rounded-sm border border-current px-1 font-sans text-micro opacity-60 max-sm:hidden">{modKey("S")}</kbd></Button>
          </span>
        </div>
      )}
    </form>
  );
}

function BrandSkeleton() {
  return (
    <div aria-hidden className="grid gap-4 lg:grid-cols-3">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-lg border bg-card p-4"><Skeleton className="h-5 w-24" /><Skeleton className="h-24 w-full" /><Skeleton className="h-8 w-full" /></div>
      ))}
    </div>
  );
}

function KitCard({ icon: Icon, title, goesTo, children }: { icon: typeof Type; title: string; goesTo: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col rounded-lg border bg-card">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        <h2 id={id} className="text-heading">{title}</h2>
      </header>
      <div className="flex flex-1 flex-col gap-4 p-4">{children}</div>
      <p className="border-t px-4 py-2.5 text-caption text-pretty text-muted-foreground">{goesTo}</p>
    </section>
  );
}

function Label({ htmlFor, children, extra }: { htmlFor?: string; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="text-caption font-medium text-muted-foreground">{children}</label>
      {extra && <span className="text-caption text-muted-foreground tabular-nums">{extra}</span>}
    </div>
  );
}

function TextField({ label, value, onChange, disabled, max, rows, placeholder, testId }: {
  label: string; value: string; onChange: (v: string) => void; disabled: boolean; max: number; rows: number; placeholder: string; testId: string;
}) {
  const id = useId();
  const near = value.length > max * 0.8;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} extra={near ? `${value.length} / ${max}` : undefined}>{label}</Label>
      <Textarea id={id} value={value} rows={rows} maxLength={max} disabled={disabled} placeholder={disabled ? "Not set" : placeholder}
        onChange={(e) => onChange(e.target.value)} data-testid={testId} className="resize-y text-body" />
    </div>
  );
}

/** Words to avoid: typed and added with Enter or a comma, each removable. Backspace in an empty box removes the last. */
function WordsField({ words, onChange, disabled }: { words: string[]; onChange: (v: string[]) => void; disabled: boolean }) {
  const id = useId();
  const [typed, setTyped] = useState("");
  const full = words.length >= BRAND_LIMITS.avoid;
  const commit = () => {
    if (!typed.trim()) return;
    const next = addWords(words, typed).map((w) => w.slice(0, BRAND_LIMITS.avoidChars)).slice(0, BRAND_LIMITS.avoid);
    onChange(next); setTyped("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
    else if (e.key === "Backspace" && !typed && words.length) onChange(words.slice(0, -1));
  };
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} extra={words.length ? `${words.length}` : undefined}>Never say</Label>
      {words.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Words to avoid" data-testid="brand-avoid">
          {words.map((w) => (
            <li key={w} className="inline-flex max-w-full items-center gap-0.5 rounded-md border bg-secondary py-0.5 pr-0.5 pl-2 text-caption text-secondary-foreground">
              <span className="truncate">{w}</span>
              {!disabled && (
                <button type="button" aria-label={`Remove ${w}`} onClick={() => onChange(words.filter((x) => x !== w))}
                  className="focus-ring grid size-5 place-items-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground">
                  <X aria-hidden className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={onKey} onBlur={commit} disabled={full} maxLength={BRAND_LIMITS.avoidChars * 4}
          placeholder={full ? `That's the most the kit holds (${BRAND_LIMITS.avoid})` : "Type a word, then Enter"} className="h-8 text-body" data-testid="brand-avoid-input" />
      )}
      {disabled && !words.length && <p className="text-body text-muted-foreground">None set</p>}
    </div>
  );
}

function VoiceField({ voice, voices, onChange, disabled }: { voice: string; voices: string[]; onChange: (v: string) => void; disabled: boolean }) {
  const id = useId();
  const list = useMemo(() => (voice && !voices.includes(voice) ? [voice, ...voices] : voices), [voice, voices]);
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>Voice</Label>
      <Select value={voice || MODEL_VOICE} onValueChange={(v) => onChange(v === MODEL_VOICE ? "" : v)} disabled={disabled}>
        <SelectTrigger id={id} className="h-8 w-full text-body" data-testid="brand-default-voice"><SelectValue /></SelectTrigger>
        <SelectContent position="popper" className="max-h-72">
          <SelectItem value={MODEL_VOICE}>None: each model's own</SelectItem>
          {list.map((v) => <SelectItem key={v} value={v}>{v}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The palette as swatches. Each opens to its name and hex value; six at most. */
function ColoursField({ colours, onChange, disabled }: { colours: BrandColour[]; onChange: (v: BrandColour[]) => void; disabled: boolean }) {
  const [open, setOpen] = useState<number | null>(null);
  const update = (i: number, c: BrandColour) => onChange(colours.map((x, j) => (j === i ? c : x)));
  const remove = (i: number) => { onChange(colours.filter((_, j) => j !== i)); setOpen(null); };
  const add = () => { onChange([...colours, { name: "", hex: "#808080" }]); setOpen(colours.length); };
  return (
    <div className="grid gap-1.5">
      <Label extra={colours.length ? `${colours.length} of ${BRAND_LIMITS.colours}` : undefined}>Colours</Label>
      <ul className="flex flex-wrap gap-2" aria-label="Brand colours" data-testid="brand-colours">
        {colours.map((c, i) => (
          <li key={i}>
            <Popover open={open === i} onOpenChange={(o) => setOpen(o ? i : null)}>
              <PopoverTrigger asChild disabled={disabled}>
                <button type="button" className="focus-ring group flex w-16 flex-col items-start gap-1 rounded-md text-left disabled:cursor-default"
                  aria-label={`${c.name || "Unnamed colour"}, ${c.hex}${disabled ? "" : ". Edit"}`}>
                  <span className="h-8 w-full rounded-md border border-foreground/10" style={{ background: normalHex(c.hex) ?? "transparent" }} />
                  <span className="w-full truncate text-caption">{c.name || "Unnamed"}</span>
                  <span className="w-full truncate font-mono text-micro text-muted-foreground uppercase">{c.hex}</span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64">
                <ColourEditor colour={c} onChange={(next) => update(i, next)} onRemove={() => remove(i)} onDone={() => setOpen(null)} />
              </PopoverContent>
            </Popover>
          </li>
        ))}
        {!disabled && colours.length < BRAND_LIMITS.colours && (
          <li>
            <button type="button" onClick={add} data-testid="brand-colour-add"
              className="focus-ring flex h-8 w-16 items-center justify-center rounded-md border border-dashed text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
              <Plus aria-hidden className="size-4" /><span className="sr-only">Add a colour</span>
            </button>
          </li>
        )}
      </ul>
      {disabled && !colours.length && <p className="text-body text-muted-foreground">None set</p>}
    </div>
  );
}

function ColourEditor({ colour, onChange, onRemove, onDone }: { colour: BrandColour; onChange: (c: BrandColour) => void; onRemove: () => void; onDone: () => void }) {
  const nameId = useId();
  const hexId = useId();
  const [hex, setHex] = useState(colour.hex);
  const valid = normalHex(hex);
  useEffect(() => setHex(colour.hex), [colour.hex]);
  return (
    <div className="grid gap-3" data-testid="brand-colour-editor">
      <div className="grid gap-1.5">
        <Label htmlFor={nameId}>Name</Label>
        <Input id={nameId} value={colour.name} maxLength={BRAND_LIMITS.colourName} autoFocus placeholder="Fern" className="h-8 text-body"
          onChange={(e) => onChange({ ...colour, name: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onDone(); } }} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={hexId}>Hex value</Label>
        <div className="flex items-center gap-2">
          <input type="color" aria-label="Pick the colour" value={valid ?? "#808080"} onChange={(e) => { const v = e.target.value.toUpperCase(); setHex(v); onChange({ ...colour, hex: v }); }}
            className="focus-ring size-8 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5" />
          <Input id={hexId} value={hex} maxLength={7} className="h-8 font-mono text-body uppercase" aria-invalid={!valid || undefined}
            aria-describedby={!valid ? `${hexId}-err` : undefined}
            onChange={(e) => { setHex(e.target.value); const v = normalHex(e.target.value); if (v) onChange({ ...colour, hex: v }); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); onDone(); } }} />
        </div>
        {!valid && <p id={`${hexId}-err`} className="text-caption text-destructive">Six hex digits, like #336699.</p>}
      </div>
      <div className="flex justify-between gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onRemove}><Trash2 />Remove</Button>
        <Button type="button" variant="outline" size="sm" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

/** Up to three images, added and removed at once (not with Save). Image runs that use the kit are sent them. */
function ReferenceImages({ images, canEdit, onChanged }: { images: BrandImage[]; canEdit: boolean; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const room = BRAND_LIMITS.images - images.length;
  async function add(files: FileList | null) {
    const file = files?.[0];
    if (input.current) input.current.value = "";
    if (!file) return;
    if (!IMAGE_ACCEPT.split(",").includes(file.type)) { toast.error("Reference images can be PNG, JPEG or WebP. Export it as one of those and add it again."); return; }
    if (file.size > BRAND_LIMITS.imageBytes) { toast.error("Reference images can be up to 2 MB. Export a smaller copy (1,500 px on the long side is plenty) and add it again."); return; }
    setAdding(true);
    try { await brandApi.addImage(file); toast.success(`Added ${file.name}. Image runs that use the kit get it from now on.`); onChanged(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "That image wasn't added. Try again."); }
    finally { setAdding(false); }
  }
  return (
    <div className="grid gap-1.5">
      <Label extra={images.length ? `${images.length} of ${BRAND_LIMITS.images}` : undefined}>Reference images</Label>
      <ul className="flex flex-wrap gap-2" aria-label="Reference images" data-testid="brand-images">
        {images.map((img) => <ReferenceTile key={img.id} image={img} canEdit={canEdit} onRemoved={onChanged} />)}
        {canEdit && room > 0 && (
          <li>
            <button type="button" onClick={() => input.current?.click()} disabled={adding} data-testid="brand-image-add"
              className="focus-ring flex size-18 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-caption text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-60">
              <ImagePlus aria-hidden className="size-4" />{adding ? "Adding…" : "Add"}
            </button>
            <input ref={input} type="file" accept={IMAGE_ACCEPT} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void add(e.target.files)} />
          </li>
        )}
      </ul>
      {!canEdit && !images.length && <p className="text-body text-muted-foreground">None added</p>}
      <p className="text-caption text-pretty text-muted-foreground">PNG, JPEG or WebP, up to 2 MB each. Sent after any images of your own; video runs don't take them.</p>
    </div>
  );
}

function ReferenceTile({ image, canEdit, onRemoved }: { image: BrandImage; canEdit: boolean; onRemoved: () => void }) {
  const shown = useLoad(() => brandApi.image(image.id), [image.id]);
  const [removing, setRemoving] = useState(false);
  async function remove() {
    setRemoving(true);
    try { await brandApi.removeImage(image.id); toast.success(`Removed ${image.name} from the kit.`); onRemoved(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "That image wasn't removed. Try again."); setRemoving(false); }
  }
  return (
    <li className={cn("group relative size-18 overflow-hidden rounded-md border bg-muted", removing && "opacity-50")} title={image.name}>
      {shown.data ? <img src={shown.data.url} alt={image.name} className="size-full object-cover" />
        : shown.error ? <span className="grid size-full place-items-center p-1 text-center text-micro text-muted-foreground">Didn't load</span>
        : <Skeleton className="size-full rounded-none" />}
      <span className="absolute inset-x-0 bottom-0 flex justify-end gap-0.5 p-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
        {shown.data && (
          <a href={shown.data.url} download={image.name} aria-label={`Download ${image.name}`}
            className="focus-ring grid size-6 place-items-center rounded-sm bg-background/90 text-foreground hover:bg-background">
            <Download aria-hidden className="size-3.5" />
          </a>
        )}
        {canEdit && (
          <button type="button" onClick={() => void remove()} disabled={removing} aria-label={`Remove ${image.name}`}
            className="focus-ring grid size-6 place-items-center rounded-sm bg-background/90 text-foreground hover:bg-background">
            <Trash2 aria-hidden className="size-3.5" />
          </button>
        )}
      </span>
    </li>
  );
}
