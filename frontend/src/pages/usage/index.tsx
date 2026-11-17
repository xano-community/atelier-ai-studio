// /usage (admins): what this month and last cost, by day, by person (with their keys and agents as lines under them), by
// kind and by model, read from the ledger. The limits form sets the team budget, the default person budget and the
// approval line; each person's row this month can have a budget of its own. Prices open in a sheet. Every number is an
// estimate from the price table: Xano's credit balance is the final word.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Lock, Pencil } from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@xano-sdk/rbac/react";
import { Avatar, EmptyState, LoadError, PageHeader, Panel, Segmented, useLoad, useUrlState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KIND_ICON } from "@/components/studio/kind-icon";
import { useLive } from "@/base/live";
import {
  KIND_NAME, countWords, dailySeries, dollars, markedDays, monthBefore, monthName, easelLine, parseDollars, peopleLines, share, shortModelName, usageApi,
  type PersonLine, type Usage,
} from "@/lib/usage";
import { cn } from "@/lib/utils";
import { modelName } from "@/lib/knowledge";
import { api } from "@/lib/api";
import { findModel, type StepKind } from "@/lib/catalog";
import { PricesSheet } from "./prices";

export function UsagePage() {
  const canRead = useCan("usage.read");
  if (!canRead) return <EmptyState icon={Lock} title="Only admins see usage" description="Ask an admin how much of this month's budget you've used. Your own spend shows on Home." />;
  return <UsageScreen />;
}

function UsageScreen() {
  const [q, setQ] = useUrlState({ month: "this" });
  const which = q.month === "last" ? "last" : "this";
  // Months are UTC on the server and here. Empty asks for this month.
  const month = which === "last" ? monthBefore(new Date().toISOString().slice(0, 7)) : "";
  const usage = useLoad(() => usageApi.usage(month), [month]);
  useLive(["ai_run", "ai_step", "budget", "settings", "price"], usage.reload);

  const u = usage.data;
  const current = !!u && u.month === u.this_month;
  return (
    <div className="flex flex-col gap-5" data-testid="usage" data-month={u?.month}>
      <PageHeader title="Usage"
        description={u ? `${monthName(u.month)} · estimates from the price table` : "Estimates from the price table"}
        actions={<Segmented label="Month" value={which} onChange={(v) => setQ({ month: v === "this" ? "" : v })}
          options={[{ value: "this", label: "This month" }, { value: "last", label: "Last month" }]} />} />
      {usage.error && !u ? <LoadError title="Usage didn't load" error={usage.error} onRetry={usage.reload} /> : (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <ByDay usage={u} loading={usage.loading} />
            <ByPerson usage={u} editable={current} onChanged={usage.reload} />
          </div>
          <div className="flex min-w-0 flex-col gap-4">
            <ByKind usage={u} />
            <ByModel usage={u} />
            <LimitsForm usage={u} onSaved={usage.reload} />
          </div>
        </div>
      )}
    </div>
  );
}

function ByDay({ usage: u, loading }: { usage: Usage | null; loading: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const series = useMemo(() => (u ? dailySeries(u.month, u.by_day) : []), [u]);
  const budget = u?.team?.budget ?? u?.team_budget ?? 0;
  const head = u ? `${dollars(u.total)} of ${dollars(budget)}` : "";
  // Today (on this month's chart) and the busiest day carry the accent; every other day is muted.
  const marked = markedDays(series, u && u.month === u.this_month ? new Date().getUTCDate() - 1 : -1);
  const peak = marked.busiest;
  // The scale tops out at a round amount just above the busiest day, so its labels read as money, not as fractions.
  const max = niceCeil(Math.max(...series, 1));
  const W = 560, H = 120, base = 120, top = 8, gap = 2;
  const bw = series.length ? (W - gap * (series.length - 1)) / series.length : 0;
  const day = (i: number) => `${i + 1} ${u ? monthName(u.month, true).slice(0, 3) : ""}`;
  return (
    <Panel title="Spend by day" extra={u ? <span className={cn("text-caption tabular-nums text-muted-foreground", loading && "opacity-60")} data-testid="usage-total">{head}</span> : null}>
      <div className="px-4 pt-3 pb-2">
        {!u ? <Skeleton className="h-[150px] w-full" /> : u.total === 0 ? (
          <p className="py-10 text-center text-body text-muted-foreground">Nothing was charged in {monthName(u.month, true)}.</p>
        ) : (
          <>
            <p className="h-5 text-caption tabular-nums text-muted-foreground" aria-live="polite">
              {hover !== null ? <><span className="font-medium text-foreground">{day(hover)}</span> · {dollars(series[hover])}</>
                : <>Busiest day <span className="font-medium text-foreground">{day(peak)}</span> · {dollars(series[peak])}{marked.today >= 0 && marked.today !== peak ? <> · today {dollars(series[marked.today])}</> : null}{u.held > 0 ? ` · ${dollars(u.held)} held for runs still going` : ""}</>}
            </p>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2">
            <div aria-hidden className="relative w-10 text-right text-micro text-muted-foreground tabular-nums" style={{ height: H }}>
              {[max, max / 2, 0].map((v, i) => (
                <span key={i} className="absolute right-0 -translate-y-1/2" style={{ top: [top, (top + base) / 2, base][i] }}>{axisDollars(v)}</span>
              ))}
            </div>
            <div className="relative">
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={H} role="img" className="block" onMouseLeave={() => setHover(null)}
              aria-label={`Spend each day of ${monthName(u.month)}: ${dollars(u.total)} in all, most on ${day(peak)} (${dollars(series[peak])}).`}>
              <g className="stroke-border" strokeWidth={1} vectorEffect="non-scaling-stroke">
                <line x1={0} y1={top} x2={W} y2={top} vectorEffect="non-scaling-stroke" /><line x1={0} y1={(top + base) / 2} x2={W} y2={(top + base) / 2} vectorEffect="non-scaling-stroke" /><line x1={0} y1={base - 0.5} x2={W} y2={base - 0.5} vectorEffect="non-scaling-stroke" />
              </g>
              {series.map((v, i) => {
                const h = v > 0 ? Math.max(2, ((base - top) * v) / max) : 0;
                const x = i * (bw + gap);
                return (
                  <g key={i} onMouseEnter={() => setHover(i)}>
                    <rect x={x} y={top} width={bw} height={base - top} fill="transparent" />
                    {h > 0 && <path d={bar(x, base - h, bw, h)} data-mark={i === peak ? "busiest" : i === marked.today ? "today" : undefined}
                      className={cn("transition-opacity duration-150", i === peak || i === marked.today ? "fill-primary" : "fill-muted-foreground/35")}
                      opacity={hover === null || hover === i ? 1 : 0.45} />}
                  </g>
                );
              })}
            </svg>
            {/* The busiest bar's own label, above it: HTML, so it isn't stretched with the chart. */}
            {peak >= 0 && (
              <span aria-hidden className="pointer-events-none absolute -translate-x-1/2 -translate-y-full pb-0.5 text-micro font-medium whitespace-nowrap text-foreground tabular-nums"
                style={{ left: `${((peak * (bw + gap) + bw / 2) / W) * 100}%`, top: Math.max(10, base - Math.max(2, ((base - top) * series[peak]) / max)) }}>
                {dollars(series[peak])}
              </span>
            )}
            </div>
            <span />
            <div aria-hidden className="relative mt-1.5 h-4 text-micro text-muted-foreground tabular-nums">
              {ticks(series.length).map((i) => (
                <span key={i} className={cn("absolute", i === 0 ? "left-0" : i === series.length - 1 ? "right-0" : "-translate-x-1/2")}
                  style={i === 0 || i === series.length - 1 ? undefined : { left: `${((i + 0.5) / series.length) * 100}%` }}>{day(i)}</span>
              ))}
            </div>
            </div>
            <table className="sr-only">
              <caption>Spend by day</caption>
              <tbody>{series.map((v, i) => v > 0 && <tr key={i}><th scope="row">{day(i)}</th><td>{dollars(v)}</td></tr>)}</tbody>
            </table>
          </>
        )}
      </div>
    </Panel>
  );
}

/** The next round amount at or above `micro`: 1, 2 or 5 times a power of ten. */
function niceCeil(micro: number) {
  const exp = 10 ** Math.floor(Math.log10(micro));
  const f = micro / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * exp;
}
/** An axis label: "$1", "$0.50", "$0.05", "$0". */
const axisDollars = (micro: number) => {
  const d = micro / 1_000_000;
  if (d === 0) return "$0";
  return d >= 1 ? `$${Number.isInteger(d) ? d : d.toFixed(1)}` : `$${d.toFixed(d >= 0.1 ? 2 : d >= 0.01 ? 2 : 3)}`;
};
/** Which days get a label: the first, every seventh, and the last. */
const ticks = (n: number) => Array.from({ length: n }, (_, i) => i).filter((i) => i === 0 || i === n - 1 || (i % 7 === 0 && n - 1 - i >= 3));

/** A bar with its data end rounded (4 px) and its base square on the axis. */
function bar(x: number, y: number, w: number, h: number) {
  const r = Math.min(4, w / 2, h);
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`;
}

function ByPerson({ usage: u, editable, onChanged }: { usage: Usage | null; editable: boolean; onChanged: () => void }) {
  const lines = useMemo(() => (u ? peopleLines(u, editable) : []), [u, editable]);
  // Bars are drawn against the biggest spender, so who spent most reads at a glance; the share of each budget is a number.
  const most = Math.max(0, ...lines.map((l) => l.spent + l.reserved));
  return (
    <Panel title="By person" data-kit="usage-people">
      {!u ? <div className="grid gap-2 p-4"><Skeleton className="h-6" /><Skeleton className="h-6" /><Skeleton className="h-6" /></div>
        : lines.length === 0 ? <p className="p-4 text-body text-muted-foreground">Nobody used AI in {monthName(u.month, true)}.</p> : (
          <ul className="divide-y">
            {lines.map((l) => <PersonRow key={l.id} line={l} most={most} editable={editable} defaultBudget={u.person_budget} onChanged={onChanged} />)}
          </ul>
        )}
      {u && <EaselRow usage={u} />}
      {u && <p className="border-t px-4 py-2.5 text-caption text-pretty text-muted-foreground">Keys and agents spend from their owner's budget and have none of their own.</p>}
    </Panel>
  );
}

/** Easel's own model turns: billed by the deployer's provider, so shown in tokens, apart from the budgets. */
function EaselRow({ usage: u }: { usage: Usage }) {
  const line = easelLine(u);
  if (!line) return null;
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t px-4 py-2 text-body" data-testid="usage-easel">
      <Avatar name="Easel" kind="agent" size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block text-pretty">Easel <span className="text-caption text-muted-foreground">· billed by {line.billedBy}, not your budget</span></span>
        <span className="block truncate text-caption text-muted-foreground" title={line.people.map((p) => `${p.name}: ${p.turns}`).join(", ")}>
          Its own model turns, for {line.people.map((p) => p.name.split(" ")[0]).join(", ")}
        </span>
      </span>
      <span className="w-full pl-9 text-caption tabular-nums text-muted-foreground sm:w-56 sm:shrink-0 sm:pl-0 sm:text-right">{line.words}</span>
    </div>
  );
}

function PersonRow({ line: l, most, editable, defaultBudget, onChanged }: { line: PersonLine; most: number; editable: boolean; defaultBudget: number; onChanged: () => void }) {
  const used = l.spent + l.reserved;
  const own = l.hasRow && l.budget !== defaultBudget;
  const ofBudget = share(used, l.budget);
  // "<1%" rather than "0%" for a little spend: it isn't nothing.
  const percent = used > 0 && ofBudget < 1 ? "<1%" : `${Math.round(ofBudget)}%`;
  return (
    <li data-testid="usage-person" data-id={l.id}>
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-body">
        <Avatar name={l.name} size="sm" />
        <span className="min-w-0 flex-1 truncate">{l.name}{l.role === "guest" && <span className="text-caption text-muted-foreground"> · guest</span>}</span>
        <span aria-hidden className="hidden h-1.5 w-32 overflow-hidden rounded-full bg-muted sm:block" title={`${dollars(used)} used or held, against the most anyone has spent this month`}>
          <span className={cn("block h-full rounded-full", ofBudget >= 90 ? "bg-warning" : "bg-primary")} style={{ width: `${most > 0 ? Math.max(used > 0 ? 2 : 0, (used / most) * 100) : 0}%` }} />
        </span>
        <span className="shrink-0 text-right text-caption tabular-nums sm:w-36" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ofBudget)}
          aria-label={`${l.name}: ${dollars(used)} of ${dollars(l.budget)} used or held, ${percent} of their budget`}>
          <span className="font-medium">{dollars(l.amount)}</span> <span className="text-muted-foreground">· <span className={cn(ofBudget >= 90 && "text-warning")}>{percent}</span> of {dollars(l.budget)}</span>
        </span>
        {editable && <BudgetEdit line={l} own={own} onChanged={onChanged} />}
      </div>
      {l.details.map((d) => (
        <div key={d.key} className="flex items-center gap-3 pb-2 pr-4 pl-[3.25rem] text-caption text-muted-foreground" data-testid="usage-detail">
          <span className="min-w-0 flex-1 truncate">of which {d.label}</span>
          <span className="shrink-0 tabular-nums">{dollars(d.amount)}</span>
        </div>
      ))}
    </li>
  );
}

function BudgetEdit({ line: l, own, onChanged }: { line: PersonLine; own: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setText(String(l.budget / 1_000_000)); setError(null); } }, [open, l.budget]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const amount = parseDollars(text);
    if (amount === null) { setError("Write an amount in dollars, like 40 or 12.50."); return; }
    setBusy(true);
    try {
      await usageApi.setPersonBudget(l.id, amount);
      toast.success(`${l.name.split(" ")[0]}'s budget this month is ${dollars(amount)}`);
      setOpen(false);
      onChanged();
    } catch (err) { setError(err instanceof Error ? err.message : "That didn't save. Try again."); }
    finally { setBusy(false); }
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`Set ${l.name}'s budget for this month`} title={own ? "Has a budget of their own this month" : "Set a budget for this month"}>
          <Pencil aria-hidden className={cn("size-3.5", own && "text-foreground")} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <form onSubmit={(e) => void save(e)} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor={`budget-${l.id}`}>{l.name.split(" ")[0]}'s budget this month</Label>
            <div className="relative">
              <span aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground">$</span>
              <Input id={`budget-${l.id}`} inputMode="decimal" className="pl-6 tabular-nums" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={error ? true : undefined}
                aria-describedby={`budget-${l.id}-note`} autoFocus />
            </div>
            <p id={`budget-${l.id}-note`} className={cn("text-caption text-pretty", error ? "text-destructive" : "text-muted-foreground")} role={error ? "alert" : undefined}>
              {error ?? `${dollars(l.spent)} spent and ${dollars(l.reserved)} held stay as they are. From next month, the default applies again.`}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function ByKind({ usage: u }: { usage: Usage | null }) {
  const rows = useMemo(() => [...(u?.by_kind ?? [])].sort((a, b) => b.amount - a.amount), [u]);
  return (
    <Panel title="By kind">
      {!u ? <div className="grid gap-2 p-4"><Skeleton className="h-5" /><Skeleton className="h-5" /></div>
        : rows.length === 0 ? <p className="p-4 text-body text-muted-foreground">Nothing yet.</p> : (
          <ul className="divide-y">
            {rows.map((r) => {
              const Icon = KIND_ICON[r.kind] ?? KIND_ICON.text;
              return (
                <li key={r.kind} className="flex min-h-9 items-center gap-3 px-4 py-2 text-body">
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{KIND_NAME[r.kind] ?? r.kind}</span>
                  <span className="w-28 shrink-0 text-right text-caption tabular-nums text-muted-foreground">{countWords(r.kind, r.calls)}</span>
                  <span className="w-16 shrink-0 text-right text-caption font-medium whitespace-nowrap tabular-nums">{dollars(r.amount)}</span>
                </li>
              );
            })}
          </ul>
        )}
    </Panel>
  );
}

function ByModel({ usage: u }: { usage: Usage | null }) {
  const rows = useMemo(() => [...(u?.by_model ?? [])].sort((a, b) => b.amount - a.amount), [u]);
  // A model's name as the catalog says it ("Veo 3.1 Fast"), with its id on hover.
  const catalog = useLoad(() => api.catalog().catch(() => null), []);
  const name = (kind: string, model: string) => findModel(catalog.data ?? null, kind as StepKind, model)?.label ?? modelName(model);
  return (
    <Panel title="By model">
      {!u ? <div className="grid gap-2 p-4"><Skeleton className="h-5" /></div>
        : rows.length === 0 ? <p className="p-4 text-body text-muted-foreground">Nothing yet.</p> : (
          <ul className="divide-y">
            {rows.map((r) => (
              <li key={`${r.model}-${r.kind}`} className="flex min-h-9 items-center gap-3 px-4 py-2 text-body">
                <ModelName full={name(r.kind, r.model)} id={r.model} />
                <span className="w-28 shrink-0 text-right text-caption tabular-nums text-muted-foreground">{countWords(r.kind, r.calls)}</span>
                <span className="w-16 shrink-0 text-right text-caption font-medium whitespace-nowrap tabular-nums">{dollars(r.amount)}</span>
              </li>
            ))}
          </ul>
        )}
    </Panel>
  );
}

/** A model's short name in a row ("Nano Banana 2"), with its full name and id in a tooltip when there's more to say. */
function ModelName({ full, id }: { full: string; id: string }) {
  const short = shortModelName(full);
  const more = short !== full || id !== full;
  const label = <span className="min-w-0 flex-1 truncate" tabIndex={more ? 0 : undefined} aria-label={more ? full : undefined}>{short}</span>;
  if (!more) return label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{label}</TooltipTrigger>
      <TooltipContent><span className="block">{full}</span><span className="block font-mono opacity-70">{id}</span></TooltipContent>
    </Tooltip>
  );
}

const asText = (micro: number) => { const d = micro / 1_000_000; return Number.isInteger(d) ? String(d) : d.toFixed(Math.max(2, String(d).split(".")[1]?.length ?? 0)); };

function LimitsForm({ usage: u, onSaved }: { usage: Usage | null; onSaved: () => void }) {
  const canManage = useCan("budgets.manage");
  const [team, setTeam] = useState("");
  const [person, setPerson] = useState("");
  const [line, setLine] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [prices, setPrices] = useState(false);
  const saved = u ? { team: asText(u.team_budget), person: asText(u.person_budget), line: asText(u.approval_line) } : null;
  useEffect(() => { if (saved) { setTeam(saved.team); setPerson(saved.person); setLine(saved.line); } }, [saved?.team, saved?.person, saved?.line]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = !!saved && (team !== saved.team || person !== saved.person || line !== saved.line);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const t = parseDollars(team), p = parseDollars(person), l = parseDollars(line);
    const next: Record<string, string> = {};
    if (t === null) next.team = "Write an amount in dollars, like 100.";
    if (p === null) next.person = "Write an amount in dollars, like 25.";
    if (l === null) next.line = "Write an amount in dollars, like 0.50.";
    setErrors(next);
    if (t === null || p === null || l === null) return;
    setBusy(true);
    try {
      await usageApi.setLimits({ team_budget: t, person_budget: p, approval_line: l });
      toast.success("Limits saved. The next run uses them.");
      onSaved();
    } catch (err) { setErrors({ form: err instanceof Error ? err.message : "That didn't save. Try again." }); }
    finally { setBusy(false); }
  };

  const field = (id: string, label: string, value: string, set: (v: string) => void, hint: string) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`limit-${id}`}>{label}</Label>
      <div className="relative">
        <span aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted-foreground">$</span>
        <Input id={`limit-${id}`} inputMode="decimal" className="pl-6 tabular-nums" value={value} disabled={!u || !canManage} onChange={(e) => { set(e.target.value); setErrors((all) => ({ ...all, [id]: "", form: "" })); }}
          aria-invalid={errors[id] ? true : undefined} aria-describedby={`limit-${id}-note`} />
      </div>
      <p id={`limit-${id}-note`} className={cn("text-caption text-pretty", errors[id] ? "text-destructive" : "text-muted-foreground")} role={errors[id] ? "alert" : undefined}>{errors[id] || hint}</p>
    </div>
  );

  return (
    <Panel title="Limits" data-kit="usage-limits">
      <form onSubmit={(e) => void save(e)} className="grid gap-3.5 p-4" data-testid="limits-form">
        {field("team", "Team budget per month", team, setTeam, "Every run, key and agent counts towards it.")}
        {field("person", "Each person's budget per month", person, setPerson, "A budget set on someone's row under By person overrides it for the month.")}
        {field("line", "Ask an admin first when a run costs more than", line, setLine, "Video by a member always asks. An admin's own run asks them to confirm.")}
        {errors.form && <p role="alert" className="text-caption text-destructive">{errors.form}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setPrices(true)} disabled={!canManage}>Edit prices</Button>
          <Button type="submit" size="sm" disabled={!dirty || busy}>{busy ? "Saving…" : "Save limits"}</Button>
        </div>
        <p className="text-caption text-pretty text-muted-foreground">
          These are estimates from the template's price table, so Xano's credit balance is the final word.
        </p>
      </form>
      <PricesSheet open={prices} onOpenChange={setPrices} />
    </Panel>
  );
}
