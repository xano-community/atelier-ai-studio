// Pick a model from the live Xano AI catalog: its name, how it's pitched (fast, balanced, best), the catalog's own price
// words, and the suggested one first. A model the gateway doesn't serve is listed but can't be picked; one with no price
// can be picked and says so, because an admin can fix that under Usage.
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { NO_PRICE_WORDS, modelsFor, tierLabel, unservedReason, type PlaygroundCatalog, type StepKind } from "@/lib/catalog";
import { cn } from "@/lib/utils";
import type { KeyboardEvent } from "react";

/** ⌘↵ runs the Playground: it mustn't also open the picker that has focus. */
export const keepRunKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") e.preventDefault(); };

export function ModelPicker({ catalog, kind, value, onChange, id, label = "Model", exclude, className }: {
  catalog: PlaygroundCatalog | null; kind: StepKind; value: string; onChange: (model: string) => void;
  id: string; label?: string; exclude?: string; className?: string;
}) {
  const models = modelsFor(catalog, kind);
  const chosen = models.find((m) => m.model === value) ?? null;
  const priced = (model: string) => catalog?.priced.includes(model) ?? false;
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <label htmlFor={id} className="text-caption font-medium text-muted-foreground">{label}</label>
      <Select value={value} onValueChange={onChange} disabled={!catalog || !models.length}>
        <SelectTrigger id={id} data-testid={`model-${id}`} onKeyDown={keepRunKey} className="h-8 w-full min-w-0 justify-between gap-2 text-body" aria-label={`${label}: ${chosen?.label ?? "none picked"}`}>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="min-w-0 truncate font-medium" title={chosen?.label}>{chosen?.label ?? (catalog ? "Pick a model" : "Loading models…")}</span>
            {chosen?.tier && <span className="shrink-0 text-caption text-muted-foreground">{tierLabel(chosen.tier)}</span>}
          </span>
        </SelectTrigger>
        <SelectContent position="popper" className="max-h-80 w-[min(28rem,calc(100vw-2rem))]">
          {models.map((m) => {
            const unserved = unservedReason(catalog, m.model);
            const noPrice = !priced(m.model);
            const price = unserved ? "Not served yet" : noPrice ? "No price set" : m.price;
            return (
              <SelectItem key={m.model} value={m.model} disabled={!!unserved || m.model === exclude} className="py-2" data-testid={`model-option-${m.model}`}>
                <span className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_4.5rem] items-baseline gap-x-3 gap-y-0.5">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-medium">{m.label}</span>
                    {m.suggested && <span className="shrink-0 text-caption text-muted-foreground">Suggested</span>}
                    {m.stage === "preview" && <span className="shrink-0 text-caption text-muted-foreground">Preview</span>}
                  </span>
                  <span className="text-right text-caption text-muted-foreground">{m.tier ? tierLabel(m.tier) : ""}</span>
                  <span className="col-span-2 truncate text-caption text-muted-foreground tabular-nums" title={unserved ?? (noPrice ? NO_PRICE_WORDS : m.price)}>
                    {m.model === exclude ? "In the other pane" : price}
                  </span>
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {chosen && (
        <p className="line-clamp-2 text-caption text-pretty text-muted-foreground tabular-nums" title={unservedReason(catalog, chosen.model) ?? (priced(chosen.model) ? chosen.price : NO_PRICE_WORDS)} data-testid={`model-${id}-price`}>
          {unservedReason(catalog, chosen.model) ? "Not served yet" : priced(chosen.model) ? chosen.price : NO_PRICE_WORDS}
        </p>
      )}
    </div>
  );
}
