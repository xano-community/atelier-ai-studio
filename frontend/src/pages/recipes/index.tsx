// /recipes and /recipes/:slug: every recipe in a list, each marked with what it makes, and the one open beside it with four
// tabs. Run fills its form and starts a run, with its cost and whether it waits for an admin said before Run; Steps shows the
// recipe as a pipeline (each step's kind, model, settings and what it uses); API is the same recipe as an HTTP call with your
// own key; Runs is what it made lately, as a table. A recipe whose model Xano AI stopped offering says so, and can't run until
// someone who edits recipes picks another model.
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  AlignLeft, AudioLines, BookOpen, CookingPot, Image as ImageIcon, Paperclip, Pencil, Plus, Search, Sparkles, TriangleAlert, Type, type LucideIcon,
} from "lucide-react";
import { Ago, Avatar, EmptyState, LoadError, Segmented, SplitView, StatusBadge, useLoad, useUrlState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { KindTile } from "@/components/studio/kind-icon";
import { RecipeGlyph } from "@/components/studio/recipe-glyph";
import { AgentGlyph } from "@/components/studio/agent-mark";
import { useLive } from "@/base/live";
import { useWorkspace } from "@/base/workspace";
import { api } from "@/lib/api";
import { findModel, type PlaygroundCatalog } from "@/lib/catalog";
import { money } from "@/lib/playground";
import {
  aboutCost, INPUT_TYPES, KIND_LABEL, lastRunWords, recipesApi, stepBits, stepUses, type RecipeDetail, type RecipeInput, type RecipeRun,
} from "@/lib/recipes";
import { cn } from "@/lib/utils";
import { RunForm } from "./run-form";
import { LastMade } from "./last-made";
import { runLabel, runStatus } from "./run-words";
import { ApiTab } from "./api-tab";

type Tab = "run" | "steps" | "api" | "runs";
const TABS: { value: Tab; label: string }[] = [{ value: "run", label: "Run" }, { value: "steps", label: "Steps" }, { value: "api", label: "API" }, { value: "runs", label: "Runs" }];

export function RecipesPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const list = useLoad(() => recipesApi.list(), []);
  useLive("recipe", list.reload);
  const [filter, setFilter] = useState("");
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (list.data?.items ?? []).filter((r) => !q || r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q));
  }, [list.data, filter]);
  const kindsOf = useMemo(() => {
    const m = new Map<number, string[]>();
    for (const s of list.data?.steps ?? []) m.set(s.recipe_id, [...(m.get(s.recipe_id) ?? []), s.kind]);
    return m;
  }, [list.data]);
  const retired = new Set(list.data?.retired_ids ?? []);
  // How much each is used: its runs and when it last ran. A recipe never run isn't listed there.
  const usage = useMemo(() => new Map((list.data?.usage ?? []).map((u) => [u.recipe_id, u])), [list.data]);

  const listPane = (
    <div className="flex min-h-full flex-col" data-testid="recipe-list">
      <div className="flex items-center gap-2 px-4 pt-4 pb-3">
        <h1 className="text-title">Recipes</h1>
        <Button size="sm" variant="outline" className="ml-auto" asChild data-testid="recipe-new"><Link to="/recipes/new"><Plus aria-hidden />New</Link></Button>
      </div>
      {(list.data?.items.length ?? 0) > 0 && (
        <div className="px-4 pb-3">
          <div className="relative">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter recipes" aria-label="Filter recipes" className="h-8 pl-7 text-body" />
          </div>
        </div>
      )}
      {list.error && !list.data ? <LoadError className="mx-4" title="The recipes didn't load" error={list.error} onRetry={list.reload} />
        : !list.data ? (
          <ul className="border-t" aria-label="Loading recipes">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => <li key={i} className="flex h-12 items-center gap-3 border-b px-4"><Skeleton className="size-6 rounded-[5px]" /><span className="grid flex-1 gap-1"><Skeleton className="h-3.5 w-40" /><Skeleton className="h-3 w-28" /></span><Skeleton className="h-3 w-14" /></li>)}
          </ul>
        )
        : list.data.items.length === 0 ? null
        : rows.length === 0 ? <p className="px-4 py-6 text-body text-muted-foreground">No recipe matches "{filter}".</p>
        : (
          <ul className="border-t" aria-label="Recipes, with their runs and when each last ran">
            {rows.map((r) => {
              const used = usage.get(r.id);
              return (
                <li key={r.id}>
                  <Link to={`/recipes/${r.slug}`} data-testid={`recipe-row-${r.slug}`} aria-current={r.slug === slug ? "page" : undefined}
                    className={cn("focus-ring-inset flex h-12 items-center gap-3 border-b px-4 transition-colors hover:bg-muted/50", r.slug === slug && "bg-selected hover:bg-selected")}>
                    <RecipeGlyph kinds={kindsOf.get(r.id) ?? [r.lead_kind]} size="sm" />
                    <span className="grid min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-body font-medium" title={r.name}>{r.name}</span>
                        {retired.has(r.id) ? <StatusBadge tone="danger" dot>Model retired</StatusBadge> : r.status === "draft" && <StatusBadge dot>Draft</StatusBadge>}
                      </span>
                      <span className="truncate text-caption text-muted-foreground tabular-nums" title={r.description || undefined}>
                        {r.step_count} {r.step_count === 1 ? "step" : "steps"} · {aboutCost(r.estimate)}{r.step_count > 1 ? " a run" : ""}
                      </span>
                    </span>
                    {/* Two right-aligned figures: how often it ran, and when it last did. */}
                    <span className="grid shrink-0 justify-items-end text-caption tabular-nums" data-testid={`recipe-usage-${r.slug}`}
                      title={used ? `${used.runs} ${used.runs === 1 ? "run" : "runs"}, the latest on ${new Date(used.last_run).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}` : "Not run yet"}>
                      <span className={used ? "font-medium text-foreground" : "text-muted-foreground"}>{used ? `${used.runs.toLocaleString()} ${used.runs === 1 ? "run" : "runs"}` : "No runs"}</span>
                      <span className="text-muted-foreground">{used ? lastRunWords(used.last_run) : "–"}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
    </div>
  );

  const empty = list.data && list.data.items.length === 0;
  return (
    <SplitView listLabel="Recipes" open={!!slug} onBack={() => navigate("/recipes")} backLabel="Recipes" className={empty ? "md:grid-cols-1" : undefined}
      list={empty ? <EmptyRecipes /> : listPane}
      detail={empty ? null : slug ? <RecipeDetailPane slug={slug} /> : <PickOne count={list.data?.items.length ?? 0} />} />
  );
}

/** No recipes yet: what one is, and the two ways to make one. */
function EmptyRecipes() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 p-4 sm:p-6" data-testid="recipes-empty">
      <header>
        <h1 className="text-title">Recipes</h1>
        <p className="mt-0.5 text-body text-pretty text-muted-foreground">A saved setup anyone on the team can run: an input form and one or more steps, each able to use what earlier steps made.</p>
      </header>
      <EmptyState icon={CookingPot} title="No recipes yet"
        description="Start from a blank recipe, or try something in the Playground and save it as a recipe from its result."
        action={<div className="flex flex-wrap justify-center gap-2">
          <Button size="sm" asChild><Link to="/recipes/new"><Plus aria-hidden />New recipe</Link></Button>
          <Button size="sm" variant="outline" asChild><Link to="/playground"><Sparkles aria-hidden />Open the Playground</Link></Button>
        </div>} />
      <ol className="grid gap-3 text-body sm:grid-cols-3">
        {[
          ["Ask for inputs", "A product name, a photo, a pick from Knowledge. The run form asks for them each time."],
          ["Chain the steps", "Copy, then an image, then a voiceover that reads the copy. Insert adds an earlier step's output to a prompt."],
          ["Run it anywhere", "From the app, with your own API key, or by an agent. Every run goes through the team's budgets."],
        ].map(([title, body], i) => (
          <li key={title} className="rounded-lg border bg-card p-4">
            <span className="text-caption font-medium text-muted-foreground tabular-nums">{i + 1}</span>
            <h2 className="mt-1 text-heading">{title}</h2>
            <p className="mt-1 text-caption text-pretty text-muted-foreground">{body}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PickOne({ count }: { count: number }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="grid max-w-sm justify-items-center gap-2">
        <span aria-hidden className="grid size-10 place-items-center rounded-md border bg-muted/40 text-muted-foreground"><CookingPot className="size-5" /></span>
        <p className="text-heading">Pick a recipe</p>
        <p className="text-body text-pretty text-muted-foreground">{count} {count === 1 ? "recipe" : "recipes"} on the team. Open one to run it, see its steps, or call it from your own code.</p>
      </div>
    </div>
  );
}

function RecipeDetailPane({ slug }: { slug: string }) {
  const [q, setQ] = useUrlState({ tab: "run" });
  const tab = (TABS.some((t) => t.value === q.tab) ? q.tab : "run") as Tab;
  const detail = useLoad(() => recipesApi.get(slug), [slug]);
  const catalog = useLoad(() => api.catalog(), []);
  const { nameOf } = useWorkspace();
  // A run starting or ending changes the header's count and status, and what "Last made" shows.
  useLive(["recipe", "ai_run"], detail.reload);
  if (detail.error && !detail.data) return <div className="p-4 sm:p-6"><LoadError title="This recipe didn't load" error={detail.error} onRetry={detail.reload} /></div>;
  if (!detail.data) {
    return (
      <div className="grid gap-4 p-4 sm:p-6" aria-label="Loading the recipe">
        <div className="flex gap-3"><Skeleton className="size-11 rounded-md" /><div className="grid flex-1 gap-2"><Skeleton className="h-6 w-64" /><Skeleton className="h-4 w-80" /></div></div>
        <Skeleton className="h-7 w-56" /><Skeleton className="h-64 w-full" />
      </div>
    );
  }
  const { recipe, steps, retired, can_edit, history } = detail.data;
  const last = history.latest ? runStatus(history.latest.status) : null;
  return (
    <div className="@container flex flex-col gap-5 p-4 sm:p-6" data-testid="recipe-detail">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <RecipeGlyph kinds={steps.map((s) => s.kind)} size="lg" />
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-title wrap-anywhere">{recipe.name}</h2>
            {retired.length ? <StatusBadge tone="danger" dot>Model retired</StatusBadge> : recipe.status === "published" ? <StatusBadge tone="success" dot>Published</StatusBadge> : <StatusBadge dot>Draft</StatusBadge>}
            {/* How much it's used and how its latest run stands: the Runs tab, at a glance. */}
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <button type="button" onClick={() => setQ({ tab: "runs" })} data-testid="recipe-run-count"
                className="focus-ring inline-flex h-6 items-center rounded-sm text-caption text-muted-foreground tabular-nums hover:text-foreground">
                {history.runs ? `${history.runs.toLocaleString()} ${history.runs === 1 ? "run" : "runs"}` : "Not run yet"}
              </button>
              {history.latest && last && (
                <Link to={`/runs/${history.latest.id}`} className="focus-ring inline-flex items-center gap-1.5 rounded-sm text-caption text-muted-foreground hover:text-foreground"
                  title={`The latest run: ${history.latest.title}`} data-testid="recipe-last-status">
                  <span aria-hidden>·</span> latest <StatusBadge tone={last.tone} dot>{last.label}</StatusBadge>
                </Link>
              )}
            </span>
          </div>
          {recipe.description && <p className="mt-0.5 text-body text-pretty text-muted-foreground">{recipe.description}</p>}
          <p className="mt-1 text-caption text-muted-foreground tabular-nums">
            {steps.length} {steps.length === 1 ? "step" : "steps"} · up to {money(recipe.estimate)} a run · by {nameOf(recipe.created_by)}{recipe.updated_at ? <> · updated <Ago value={recipe.updated_at} /></> : null}
          </p>
        </div>
        {can_edit && <Button variant="outline" size="sm" asChild data-testid="recipe-edit"><Link to={`/recipes/${recipe.slug}/edit`}><Pencil aria-hidden />Edit</Link></Button>}
      </header>
      {retired.length > 0 && <RetiredNotice retired={retired} canEdit={can_edit} slug={recipe.slug} catalog={catalog.data} />}
      <Segmented<Tab> label="Recipe view" value={tab} onChange={(t) => setQ({ tab: t })} options={TABS.map((t) => ({ ...t, testId: `recipe-tab-${t.value}` }))} />
      {tab === "run" && (
        <div className="grid items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="grid min-w-0 content-start gap-4">
            <LastMade detail={detail.data} />
            <RunForm key={recipe.id} detail={detail.data} catalog={catalog.data} />
          </div>
          <WhatItMakes detail={detail.data} catalog={catalog.data} onSteps={() => setQ({ tab: "steps" })} />
        </div>
      )}
      {tab === "steps" && <StepsTab detail={detail.data} catalog={catalog.data} />}
      {tab === "api" && <ApiTab detail={detail.data} />}
      {tab === "runs" && <RunsTab recipeId={recipe.id} recipeName={recipe.name} />}
    </div>
  );
}

const modelLabel = (catalog: PlaygroundCatalog | null, kind: string, model: string) => findModel(catalog, kind as never, model)?.label ?? model;

/** Beside the form: what one run makes, step by step, so the cost and the wait make sense before pressing Run. */
function WhatItMakes({ detail, catalog, onSteps }: { detail: RecipeDetail; catalog: PlaygroundCatalog | null; onSteps: () => void }) {
  const { steps } = detail;
  return (
    <section className="rounded-lg border bg-card" aria-label="What a run makes" data-testid="recipe-makes">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h3 className="text-heading">What a run makes</h3>
        <button type="button" onClick={onSteps} className="focus-ring rounded-sm text-caption text-muted-foreground hover:text-foreground">See the steps</button>
      </div>
      <ol className="flex flex-col py-1.5">
        {steps.map((st, i) => (
          <li key={st.id} className="relative flex items-center gap-3 px-4 py-1.5">
            {i < steps.length - 1 && <span aria-hidden className="absolute top-[38px] -bottom-1.5 left-8 w-px bg-border" />}
            <KindTile kind={st.kind} />
            <span className="grid min-w-0">
              <span className="truncate text-body font-medium">{st.name}</span>
              <span className="truncate text-caption text-muted-foreground" title={modelLabel(catalog, st.kind, st.model)}>{KIND_LABEL[st.kind] ?? st.kind} · {modelLabel(catalog, st.kind, st.model)}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Which step's model is gone, what its kind can use now, and who can fix it. */
export function RetiredNotice({ retired, canEdit, slug, catalog }: { retired: RecipeDetail["retired"]; canEdit: boolean; slug: string; catalog: PlaygroundCatalog | null }) {
  const label = (kind: string, model: string) => catalog?.statements[kind]?.find((m) => m.model === model)?.label ?? model;
  return (
    <div role="alert" data-testid="recipe-retired" className="flex flex-wrap items-start gap-3 rounded-lg border bg-card p-4 text-body">
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="font-medium">This recipe can't run: Xano AI no longer offers a model it uses</p>
        {retired.map((r) => (
          <p key={r.seq} className="text-pretty text-muted-foreground">
            Step {r.seq} uses {r.model}. {r.allowed.length ? `It can use ${r.allowed.slice(0, 3).map((m) => label(r.kind, m)).join(", ")}${r.allowed.length > 3 ? " or another" : ""} instead.` : "No model is offered for that kind of step now."}
          </p>
        ))}
        <p className="text-muted-foreground">{canEdit ? "Edit the recipe and pick another model, then save it." : "Ask someone who edits recipes to pick another model."} Its API answers 409 until then.</p>
      </div>
      {canEdit && <Button size="sm" variant="outline" asChild><Link to={`/recipes/${slug}/edit`}>Pick a model</Link></Button>}
    </div>
  );
}

export const INPUT_ICON: Record<string, LucideIcon> = { text: Type, long_text: AlignLeft, knowledge: BookOpen, image: ImageIcon, audio: AudioLines, file: Paperclip };
const typeLabel = (t: string) => INPUT_TYPES.find((x) => x.value === t)?.label ?? t;

/** The recipe as a pipeline: what it asks for, then each step as a card (kind, model, settings, what it uses, its cost). */
function StepsTab({ detail, catalog }: { detail: RecipeDetail; catalog: PlaygroundCatalog | null }) {
  const inputs = (detail.recipe.inputs ?? []) as RecipeInput[];
  const { recipe, steps } = detail;
  const est = useLoad(() => recipesApi.estimate({ inputs, steps: steps as never }), [recipe.id, recipe.updated_at]);
  const amountOf = (seq: number) => est.data?.steps.find((s) => s.recipe_seq === seq);
  return (
    <div className="grid gap-5" data-testid="recipe-steps">
      <section aria-label="Inputs" className="grid gap-2">
        <h3 className="text-caption font-medium text-muted-foreground">It asks for</h3>
        {inputs.length === 0 ? <p className="text-body text-muted-foreground">Nothing: every run is the same.</p> : (
          <ul className="grid gap-2 @2xl:grid-cols-2">
            {inputs.map((i) => {
              const Icon = INPUT_ICON[i.type] ?? Type;
              return (
                <li key={i.name} className="flex min-h-12 items-center gap-3 rounded-lg border bg-card px-3 py-2 text-body">
                  <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Icon className="size-3.5" /></span>
                  <span className="grid min-w-0 flex-1">
                    <span className="truncate font-medium">{i.label || i.name}</span>
                    <span className="truncate text-caption text-muted-foreground">{typeLabel(i.type)}{i.hint ? ` · "${i.hint}"` : ""}</span>
                  </span>
                  <span className="shrink-0 text-caption text-muted-foreground">{i.required ? "Required" : "Optional"}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label="Steps" className="grid gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-caption font-medium text-muted-foreground">Then, one step at a time</h3>
          {est.data && (
            <p className="text-caption text-muted-foreground tabular-nums" data-testid="recipe-steps-total">
              Up to {est.data.unpriced ? "more than " : ""}{money(est.data.total)} a run
            </p>
          )}
        </div>
        <ol className="grid">
          {steps.map((s, n) => {
            const price = amountOf(s.seq);
            const uses = stepUses(s, inputs, steps);
            const bits = stepBits(s);
            const last = n === steps.length - 1;
            return (
              <li key={s.id} className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3" data-testid={`recipe-step-${s.seq}`}>
                <div aria-hidden className="flex flex-col items-center pt-4">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full border bg-card text-caption font-medium tabular-nums">{s.seq}</span>
                  {!last && <span className="w-px flex-1 bg-border" />}
                </div>
                <article className={cn("rounded-lg border bg-card p-3 sm:p-4", !last && "mb-2")} aria-label={`Step ${s.seq}: ${s.name}`}>
                  <div className="flex items-start gap-3">
                    <KindTile kind={s.kind} />
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <h4 className="truncate text-body font-medium"><span className="sr-only">Step {s.seq}: </span>{s.name}</h4>
                      <p className="truncate text-caption text-muted-foreground">{KIND_LABEL[s.kind] ?? s.kind} · {modelLabel(catalog, s.kind, s.model)}</p>
                    </div>
                    <div className="grid shrink-0 justify-items-end gap-1">
                      {price && <span className="text-caption text-muted-foreground tabular-nums">{price.priced ? aboutCost(price.amount) : "no price set"}</span>}
                      {s.kind === "video" && <StatusBadge tone="warning" dot>Needs approval</StatusBadge>}
                    </div>
                  </div>
                  {(uses.length > 0 || bits.length > 0) && (
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t pt-3 text-caption">
                      {uses.length > 0 && <span className="text-muted-foreground">Uses</span>}
                      {uses.map((u) => (
                        <span key={u.token} className="inline-flex h-6 items-center gap-1 rounded-md border bg-muted/40 px-2" title={u.detail}>
                          {u.step ? <span className="font-medium tabular-nums text-muted-foreground">{u.step}.</span> : null}{u.label}
                        </span>
                      ))}
                      {uses.length > 0 && bits.length > 0 && <span aria-hidden className="mx-1 h-4 w-px bg-border" />}
                      {bits.map((b) => <span key={b} className="inline-flex h-6 items-center rounded-md px-1.5 text-muted-foreground ring-1 ring-border ring-inset">{b}</span>)}
                    </div>
                  )}
                </article>
              </li>
            );
          })}
        </ol>
      </section>

      <p className="flex items-start gap-2 text-caption text-pretty text-muted-foreground">
        <AgentGlyph className="mt-px" />
        <span>Runs from this app, from your own code with your own key (the API tab), and from agents as <code className="font-mono text-foreground">run_recipe</code>. Every run is charged to whoever started it.</span>
      </p>
    </div>
  );
}

export { runStatus };
const AGENT_VIA: Record<string, string> = { api: "API key", mcp: "an agent", easel: "Easel" };


function RunsTab({ recipeId, recipeName }: { recipeId: number; recipeName: string }) {
  const runs = useLoad(() => recipesApi.runs(recipeId), [recipeId]);
  useLive("ai_run", runs.reload);
  const { nameOf } = useWorkspace();
  const cols = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 @xl:grid-cols-[minmax(0,1fr)_6rem_10.5rem_3.5rem_5.5rem]";
  if (runs.error && !runs.data) return <LoadError title="The runs didn't load" error={runs.error} onRetry={runs.reload} />;
  if (!runs.data) return <div className="grid gap-px overflow-hidden rounded-lg border">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-11 w-full rounded-none" />)}</div>;
  if (!runs.data.length) return <EmptyState icon={BookOpen} title="Not run yet" description="Its runs show here, newest first, with who ran it, how it ended and what it cost." />;
  return (
    <div className="overflow-hidden rounded-lg border bg-card" data-testid="recipe-runs" role="table" aria-label="Runs of this recipe">
      <div role="row" className={cn(cols, "h-9 border-b bg-muted/30 px-4 text-caption font-medium text-muted-foreground")}>
        <span role="columnheader">Run</span>
        <span role="columnheader" className="@max-xl:hidden">Who</span>
        <span role="columnheader" className="@max-xl:sr-only">Status</span>
        <span role="columnheader" className="text-right @max-xl:hidden">Cost</span>
        <span role="columnheader" className="text-right @max-xl:hidden">When</span>
      </div>
      <div role="rowgroup" className="divide-y">
        {runs.data.map((r: RecipeRun) => {
          const st = runStatus(r.status);
          const agent = AGENT_VIA[r.via];
          const who = nameOf(r.owner_id);
          return (
            <Link key={r.id} to={`/runs/${r.id}`} role="row" className={cn(cols, "focus-ring-inset min-h-11 px-4 py-2 text-body transition-colors hover:bg-muted/50")}>
              <span role="cell" className="grid min-w-0">
                <span className="truncate font-medium" title={r.title}>{runLabel(r.title, recipeName)}</span>
                <span className="truncate text-caption text-muted-foreground @xl:hidden">{who} · <Ago value={r.created_at} /></span>
              </span>
              <span role="cell" className="flex min-w-0 items-center gap-2 @max-xl:hidden">
                {agent ? <AgentGlyph size="md" /> : <Avatar name={who} size="sm" />}
                <span className="min-w-0 truncate" title={agent ? `${who}, through ${agent}` : who}>{who.split(" ")[0]}{agent ? <span className="text-muted-foreground"> · {agent}</span> : null}</span>
              </span>
              <span role="cell"><StatusBadge tone={st.tone} dot>{st.label}</StatusBadge></span>
              <span role="cell" className="text-right text-caption text-muted-foreground tabular-nums @max-xl:hidden">{r.spent ? money(r.spent) : "–"}</span>
              <span role="cell" className="text-right text-caption text-muted-foreground @max-xl:hidden"><Ago value={r.created_at} /></span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

