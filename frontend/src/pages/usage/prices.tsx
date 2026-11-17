// The price table, for admins: one row per model and unit, each editable in place. Estimates multiply these, so a change
// applies to the next run; runs already reserved keep what they hold. A price is never zero: Xano never charges nothing.
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { LoadError, SearchInput, useLoad } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useLive } from "@/base/live";
import { KIND_NAME, parseDollars, unitWords, usageApi, type Price } from "@/lib/usage";

/** A unit price: per 1M tokens it can be cents or tens of dollars, so it keeps up to six places. */
const priceText = (micro: number) => `$${(micro / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;

export function PricesSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-xl" aria-describedby="prices-about">
        <SheetHeader className="border-b">
          <SheetTitle>Prices</SheetTitle>
          <SheetDescription id="prices-about">What each model costs per unit, from Xano's catalog. Estimates add the gateway's 10%. A change applies to the next run.</SheetDescription>
        </SheetHeader>
        {open && <PriceList />}
      </SheetContent>
    </Sheet>
  );
}

function PriceList() {
  const prices = useLoad(() => usageApi.prices(), []);
  useLive("price", prices.reload);
  const [q, setQ] = useState("");
  const groups = useMemo(() => {
    const words = q.trim().toLowerCase();
    const rows = (prices.data ?? []).filter((p) => !words || p.model.toLowerCase().includes(words) || (KIND_NAME[p.kind] ?? p.kind).toLowerCase().includes(words));
    const by = new Map<string, Price[]>();
    for (const p of rows) by.set(p.kind, [...(by.get(p.kind) ?? []), p]);
    return [...by.entries()];
  }, [prices.data, q]);
  if (prices.error && !prices.data) return <LoadError title="Prices didn't load" error={prices.error} onRetry={prices.reload} className="m-4" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b p-3"><SearchInput value={q} onChange={setQ} placeholder="Find a model" /></div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!prices.data ? <div className="grid gap-2 p-4"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
          : groups.length === 0 ? <p className="p-4 text-body text-muted-foreground">No model matches “{q}”.</p>
          : groups.map(([kind, rows]) => (
            <section key={kind} aria-label={KIND_NAME[kind] ?? kind}>
              <h3 className="sticky top-0 z-10 border-b bg-muted/60 px-4 py-1.5 text-caption font-medium text-muted-foreground backdrop-blur">{KIND_NAME[kind] ?? kind}</h3>
              <ul className="divide-y">{rows.map((p) => <PriceRow key={p.id} price={p} onSaved={prices.reload} />)}</ul>
            </section>
          ))}
      </div>
    </div>
  );
}

function PriceRow({ price: p, onSaved }: { price: Price; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = `price-${p.id}`;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const amount = parseDollars(text);
    if (amount === null || amount <= 0) { setError("Write a price above $0, like 0.075."); return; }
    setBusy(true);
    try {
      await usageApi.setPrice(p.id, amount);
      toast.success(`${p.model}: ${priceText(amount)} ${unitWords(p)}`);
      setEditing(false);
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : "That didn't save. Try again."); }
    finally { setBusy(false); }
  };
  return (
    <li className="px-4 py-2 text-body" data-testid="price-row">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-caption" title={p.model}>{p.model}</span>
          <span className="block text-caption text-muted-foreground">{unitWords(p)}</span>
        </span>
        {!editing ? (
          <>
            <span className="shrink-0 text-caption tabular-nums">{priceText(p.amount)}</span>
            <Button variant="ghost" size="sm" className="h-7" aria-label={`Change the price of ${p.model}, ${unitWords(p)}`}
              onClick={() => { setText(String(p.amount / 1_000_000)); setError(null); setEditing(true); }}>Change</Button>
          </>
        ) : (
          <form onSubmit={(e) => void save(e)} className="flex shrink-0 items-center gap-1.5">
            <label htmlFor={id} className="sr-only">Price of {p.model}, {unitWords(p)}, in dollars</label>
            <div className="relative">
              <span aria-hidden className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-caption text-muted-foreground">$</span>
              <Input id={id} inputMode="decimal" autoFocus className="h-7 w-28 pl-5 text-caption tabular-nums" value={text} onChange={(e) => setText(e.target.value)}
                aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined}
                onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setEditing(false); } }} />
            </div>
            <Button type="submit" size="sm" className="h-7" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
            <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => setEditing(false)}>Cancel</Button>
          </form>
        )}
      </div>
      {editing && error && <p id={`${id}-err`} role="alert" className="mt-1 text-caption text-destructive">{error}</p>}
      {!editing && p.label && <p className="mt-0.5 truncate text-micro text-muted-foreground" title={p.label}>Catalog: {p.label}</p>}
    </li>
  );
}
