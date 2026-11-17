// The small controls every Playground form shares: a labelled choice, the prompt box with its brand-kit switch, a file
// to attach, and an on/off toggle.
import { useEffect, useId, useMemo, useRef, type ReactNode } from "react";
import { Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { keepRunKey } from "@/components/studio/model-picker";


export function Field({ label, hint, htmlFor, children, className }: { label: ReactNode; hint?: ReactNode; htmlFor?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-caption font-medium text-muted-foreground">{label}</label>
        {hint && <span className="truncate text-caption text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** One of a model's own choices (a shape, a size, a length). Hidden when the model offers none. */
export function Choice<T extends string | number>({ label, value, options, onChange, words, testId }: {
  label: string; value: T; options: T[]; onChange: (v: T) => void; words?: (v: T) => string; testId?: string;
}) {
  const id = useId();
  if (!options.length) return null;
  const say = (v: T) => (words ? words(v) : String(v));
  return (
    <Field label={label} htmlFor={id}>
      <Select value={String(value)} onValueChange={(v) => onChange(options.find((o) => String(o) === v) ?? options[0])}>
        <SelectTrigger id={id} className="h-8 w-full text-body" data-testid={testId} onKeyDown={keepRunKey}><SelectValue>{say(value)}</SelectValue></SelectTrigger>
        <SelectContent position="popper">
          {options.map((o) => <SelectItem key={String(o)} value={String(o)} data-testid={testId ? `${testId}-${o}` : undefined}>{say(o)}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** The switch's track and thumb, drawn the same wherever a switch is. */
const Track = ({ on }: { on: boolean }) => (
  <span aria-hidden className={cn("relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors duration-150", on ? "bg-primary" : "bg-muted-foreground/30")}>
    <span className={cn("absolute top-0.5 left-0.5 size-3 rounded-full bg-background shadow-xs transition-transform duration-150 motion-reduce:transition-none", on && "translate-x-3")} />
  </span>
);

/** An on/off switch: a track and thumb, with its label beside it (or only for a screen reader, `bare`). */
export function Toggle({ label, on, onChange, testId, className, bare = false }: { label: string; on: boolean; onChange: (on: boolean) => void; testId?: string; className?: string; bare?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={bare ? label : undefined} onClick={() => onChange(!on)} data-testid={testId}
      className={cn("focus-ring group inline-flex shrink-0 items-center gap-2 rounded-md text-caption text-muted-foreground transition-colors hover:text-foreground max-sm:min-h-11",
        bare ? "max-sm:min-w-11 max-sm:justify-end" : "h-7 px-1.5 hover:bg-muted/50", className)}>
      {!bare && label}
      <Track on={on} />
    </button>
  );
}

/** An on/off setting laid out like a choice beside it: its label above, a control the height of a select. */
export function SwitchField({ label, on, onChange, words, testId }: { label: string; on: boolean; onChange: (on: boolean) => void; words: [string, string]; testId?: string }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      <button id={id} type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} data-testid={testId}
        className="focus-ring flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent pr-2 pl-2.5 text-left text-body shadow-xs transition-colors hover:bg-muted/40 max-sm:min-h-11 dark:bg-input/30 dark:hover:bg-input/50">
        <span className="truncate">{on ? words[1] : words[0]}</span>
        <Track on={on} />
      </button>
    </Field>
  );
}

/** The prompt box. Its label carries whether the brand kit goes with it, and the switch to leave it off this once. */
export function PromptBox({ id, label = "Prompt", value, onChange, placeholder, useBrand, onBrand, rows = 4, testId = "prompt" }: {
  id: string; label?: string; value: string; onChange: (v: string) => void; placeholder: string;
  useBrand?: boolean; onBrand?: (on: boolean) => void; rows?: number; testId?: string;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-caption font-medium text-muted-foreground">{label}</label>
        {onBrand && <Toggle label="Brand kit" on={!!useBrand} onChange={onBrand} testId="brand-toggle" className="-my-1 -mr-1.5 h-6 max-sm:-my-3.5" />}
      </div>
      <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={rows} data-testid={testId}
        className="max-h-80 min-h-24 resize-y text-body leading-relaxed" />
    </div>
  );
}

/** Attach one file: an image to edit, a first frame, a recording. Shows a thumbnail for an image. */
export function FilePick({ label, hint, accept, file, onChange, testId = "file" }: {
  label: string; hint?: string; accept: string; file: File | null; onChange: (f: File | null) => void; testId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const preview = useMemo(() => (file && file.type.startsWith("image/") ? URL.createObjectURL(file) : ""), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  return (
    <Field label={label} hint={hint} htmlFor={id}>
      <input ref={input} id={id} type="file" accept={accept} className="sr-only" data-testid={testId}
        onChange={(e) => { onChange(e.target.files?.[0] ?? null); e.target.value = ""; }} />
      {file ? (
        <div className="flex min-w-0 items-center gap-2 rounded-md border p-1.5">
          {preview ? <img src={preview} alt="" className="size-10 shrink-0 rounded-sm object-cover" /> : <Paperclip aria-hidden className="ml-1 size-4 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate text-body" title={file.name}>{file.name}</span>
          <span className="shrink-0 text-caption text-muted-foreground tabular-nums">{Math.max(1, Math.round(file.size / 1024)).toLocaleString()} KB</span>
          <Button variant="ghost" size="icon-xs" aria-label={`Remove ${file.name}`} onClick={() => onChange(null)}><X aria-hidden /></Button>
        </div>
      ) : (
        <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => input.current?.click()}><Paperclip aria-hidden />Choose a file</Button>
      )}
    </Field>
  );
}
