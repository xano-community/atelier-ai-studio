// /library: everything the team made with AI, newest first, under date labels (Today, Yesterday, This week, Earlier):
// pictures, clips, recordings and words. Two ways to look, remembered per browser (a phone starts on the list): a grid,
// where the days flow on from one another and words take short cards two to a square, so no day leaves a row half empty;
// and a dense list with a thumbnail, kind, status, maker, recipe and date. It's a review surface: kind tabs and the status
// filter carry their counts, "Drafts waiting" shows what still needs a look, and a reviewer ticks drafts to approve several
// at once. Filters live in the URL; on a phone the kinds and statuses are one sideways-scrolling row of chips. Both views
// are virtualised: the first page says how many items each date group holds (and how many are words), so every group is
// laid out with placeholders at once, and a page is asked for as it comes into view; a long library scrolls without
// anything moving. /library/:id opens an item's record beside them.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, FlaskConical, LayoutGrid, LibraryBig, List, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState, FilterSelect, LoadError, PageHeader, Segmented, isTyping, useLoad, useUrlState } from "@/components/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { AssetRow, AssetTileSkeleton, AssetTileView, PHONE_ROW_HEIGHT, ROW_COLUMNS, ROW_HEIGHT, TILE_CAPTION, TextTile } from "@/components/studio/asset-tile";
import { useLive } from "@/base/live";
import { useCan } from "@xano-sdk/rbac/react";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  KIND_TABS, PAGE_SIZE, approveMany, gridRows, groupCells, isWords, libraryApi, saveView, savedView, tabCount,
  type AssetPage, type AssetTile, type DateCount, type GridRow, type GroupCells, type HeadSegment, type KindTab, type LibraryFilters, type LibraryView,
} from "@/lib/library";

import { cn } from "@/lib/utils";
import { AssetSheet } from "./asset-sheet";

const GAP = 12;
/** A date header's row, in px. */
const HEAD = 36;
const KIND_VALUES = KIND_TABS.map((t) => t.value) as string[];
type Status = "all" | "drafts" | "approved";

/**
 * The library's items a page at a time. `at(i)` is the item in position i, or undefined while its page is on its way;
 * `want(i)` asks for that page. A live change asks again for the pages already shown, keeping them on screen meanwhile.
 */
type Snapshot = { pages: Map<number, AssetTile[]>; total: number; counts: AssetPage["counts"] | undefined; dates: DateCount[] | undefined; now: number };
/** The last list seen for each filter, so coming back to the Library paints at once while it asks again. */
const seen = new Map<string, Snapshot>();
const SEEN_FOR = 30 * 60_000;
function recall(key: string): Snapshot | undefined {
  const s = seen.get(key);
  return s && Date.now() - s.now < SEEN_FOR ? s : undefined;
}

function usePagedAssets(filters: LibraryFilters) {
  const key = JSON.stringify(filters);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const [first] = useState(() => recall(key));
  const [pages, setPages] = useState<Map<number, AssetTile[]>>(() => first?.pages ?? new Map());
  const [total, setTotal] = useState<number | null>(first?.total ?? null);
  const [counts, setCounts] = useState<AssetPage["counts"] | undefined>(first?.counts);
  const [dates, setDates] = useState<DateCount[] | undefined>(first?.dates);
  const [error, setError] = useState<unknown>(null);
  const asked = useRef(new Set<number>());
  const generation = useRef(0);
  // Every page of one list is asked with the same day boundaries, so the groups' counts agree from page to page.
  const [now, setNow] = useState(() => first?.now ?? Date.now());
  const nowRef = useRef(now);

  const fetchPage = useCallback((page: number) => {
    const mine = generation.current;
    asked.current.add(page);
    libraryApi.list(filtersRef.current, page, PAGE_SIZE, nowRef.current).then(
      (r) => {
        if (mine !== generation.current) return;
        setPages((p) => new Map(p).set(page, r.items));
        setTotal(r.total);
        setCounts(r.counts);
        setDates(r.dates?.length ? r.dates : undefined);
        setError(null);
      },
      (e: unknown) => { if (mine === generation.current) { asked.current.delete(page); setError(e); } },
    );
  }, []);

  const restart = useCallback(() => {
    generation.current += 1;
    nowRef.current = Date.now();
    setNow(nowRef.current);
    asked.current = new Set();
    setPages(new Map());
    setTotal(null);
    setError(null);
    fetchPage(1);
  }, [fetchPage]);
  useEffect(() => {
    // Back on a list seen lately: keep it on screen and ask again for the pages it showed.
    const kept = recall(key);
    if (!kept) { restart(); return; }
    generation.current += 1;
    nowRef.current = kept.now;
    setNow(kept.now);
    asked.current = new Set();
    setPages(kept.pages);
    setTotal(kept.total);
    setCounts(kept.counts);
    setDates(kept.dates);
    setError(null);
    [...kept.pages.keys()].forEach(fetchPage);
  }, [key, restart, fetchPage]);
  useEffect(() => {
    if (total !== null && pages.size) seen.set(key, { pages, total, counts, dates, now: nowRef.current });
  }, [key, pages, total, counts, dates]);

  const want = useCallback((index: number) => {
    const page = Math.floor(index / PAGE_SIZE) + 1;
    if (!asked.current.has(page)) fetchPage(page);
  }, [fetchPage]);
  const refresh = useCallback(() => {
    const shown = [...asked.current];
    if (!shown.length) { fetchPage(1); return; }
    shown.forEach(fetchPage);
  }, [fetchPage]);
  const at = useCallback((i: number) => pages.get(Math.floor(i / PAGE_SIZE) + 1)?.[i % PAGE_SIZE], [pages]);
  const loaded = useMemo(() => [...pages.entries()].sort(([a], [b]) => a - b).flatMap(([, items]) => items), [pages]);
  /** How many items from the top are on hand, with no gap: the part that can be grouped by date. */
  const prefix = useMemo(() => {
    let n = 0;
    for (let p = 1; pages.has(p); p++) { const items = pages.get(p)!; n += items.length; if (items.length < PAGE_SIZE) break; }
    return n;
  }, [pages]);
  return { total, counts, dates, now, at, want, refresh, restart, error, loaded, prefix };
}

/** The scrolling pane the shell gives every page. */
const scrollPane = () => document.querySelector<HTMLElement>('[data-kit="scroll-pane"]');

/** The list's rows: a date group's header, then its items one to a row. */
type ListRow = { type: "head"; segments: HeadSegment[] } | { type: "item"; index: number };
function listRows(groups: GroupCells[]): ListRow[] {
  return groups.flatMap((g) => [
    { type: "head" as const, segments: [{ group: g.group, col: 0, span: 1, drafts: g.drafts }] },
    ...g.cells.flat().sort((a, b) => a - b).map((index) => ({ type: "item" as const, index })),
  ]);
}

/** The first and last item a row holds, so the pages it straddles are asked for. */
const rowItems = (row: GridRow | ListRow | undefined): number[] =>
  !row || row.type === "head" ? [] : row.type === "item" ? [row.index] : row.cells.flatMap((c) => c.cell);

/** Where the grid or list starts in the scroll pane, and how wide it is. */
function useBox() {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    const pane = scrollPane();
    if (!el) return;
    const measure = () => {
      setWidth(el.clientWidth);
      if (pane) setMargin(el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { box, width, margin };
}

type ViewProps = {
  total: number; prefix: number; at: (i: number) => AssetTile | undefined; want: (i: number) => void; openId: number | null; onOpen: (id: number) => void;
  /** Each date group's count, from the first page: the whole layout, before the rest arrive. */
  dates: DateCount[] | undefined; now: number;
  /** The item to keep in place when this view takes over from the other. */
  anchor: { current: Anchor | null };
  selected: Set<number>; onSelect: (ids: number[], on: boolean) => void; canSelect: boolean;
};

/** A date group's label, with "Select N drafts" for a reviewer. */
function GroupHead({ segment, selected, onSelect, canSelect }: { segment: HeadSegment; selected: Set<number>; onSelect: (ids: number[], on: boolean) => void; canSelect: boolean }) {
  const ids = segment.drafts;
  const all = ids.length > 0 && ids.every((id) => selected.has(id));
  return (
    <div data-testid="library-group" className="flex min-w-0 items-end justify-between gap-2 px-1 pb-2" style={{ gridColumn: `${segment.col + 1} / span ${segment.span}` }}>
      <h2 className="truncate text-caption font-medium text-muted-foreground">{segment.group}</h2>
      {canSelect && ids.length > 0 && (
        <button type="button" onClick={() => onSelect(ids, !all)} data-testid="library-group-select"
          className="focus-ring shrink-0 rounded-sm text-caption text-muted-foreground transition-colors hover:text-foreground">
          {all ? "Clear these" : `Select ${ids.length} ${ids.length === 1 ? "draft" : "drafts"}`}
        </button>
      )}
    </div>
  );
}

/** The item someone was looking at when they switched views, and how far below the pane's top it sat. */
type Anchor = { index: number; delta: number };

/** The item nearest the pane's top, among those drawn, to keep in place across a switch of view. */
function anchorNow(): Anchor | null {
  const pane = scrollPane();
  if (!pane) return null;
  const top = pane.getBoundingClientRect().top;
  const shown = [...pane.querySelectorAll<HTMLElement>("[data-library-index]")]
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.bottom > top)
    .sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)[0];
  return shown ? { index: Number(shown.el.dataset.libraryIndex), delta: shown.r.top - top } : null;
}

/**
 * Switching between the grid and the list keeps the item that was at the top where it was: the new view, once it knows
 * its width and where it starts, scrolls to that item's row before it's painted, so the switch doesn't jump to the top.
 */
function useKeepAnchor(anchor: { current: Anchor | null }, rows: (GridRow | ListRow)[], sizeOf: (i: number) => number, margin: number, ready: boolean) {
  useLayoutEffect(() => {
    const a = anchor.current;
    const pane = scrollPane();
    if (!a || !ready || !margin || !pane) return;
    anchor.current = null;
    const r = rows.findIndex((row) => rowItems(row).includes(a.index));
    if (r < 0) return;
    let offset = 0;
    for (let k = 0; k < r; k++) offset += sizeOf(k);
    pane.scrollTop = Math.max(0, margin + offset - a.delta);
  }, [anchor, rows, sizeOf, margin, ready]);
}

/** Ask for the pages of whatever rows are on screen. */
function useWantShown(rows: (GridRow | ListRow)[], first: number, last: number, want: (i: number) => void) {
  useEffect(() => {
    for (let r = first; r <= last; r++) {
      const items = rowItems(rows[r]);
      if (!items.length) continue;
      want(Math.min(...items));
      want(Math.max(...items));
    }
  }, [first, last, rows, want]);
}

function LibraryGrid({ total, prefix, at, want, openId, onOpen, dates, now, anchor, selected, onSelect, canSelect }: ViewProps) {
  const { box, width, margin } = useBox();
  const phone = useIsMobile();
  const minTile = phone ? 150 : 200;
  const columns = Math.max(2, Math.floor((width + GAP) / (minTile + GAP)));
  const tileWidth = width ? (width - GAP * (columns - 1)) / columns : minTile;
  const rowHeight = Math.round(tileWidth - 8 + 8 + TILE_CAPTION + GAP);
  /** Two text cards share a tile's place, one above the other. */
  const cellHeight = rowHeight - GAP;
  const halfHeight = Math.floor((cellHeight - GAP) / 2);
  const rows = useMemo(() => gridRows(groupCells(total, prefix, at, now, dates), columns), [total, prefix, at, now, dates, columns]);
  const sizeOf = useCallback((i: number) => (rows[i]?.type === "head" ? HEAD : rowHeight), [rows, rowHeight]);
  const height = rows.reduce((h, _, i) => h + sizeOf(i), 0) - (rows.length && rows[rows.length - 1].type === "cells" ? GAP : 0);
  useKeepAnchor(anchor, rows, sizeOf, margin, width > 0);

  const v = useVirtualizer({ count: rows.length, getScrollElement: scrollPane, estimateSize: sizeOf, overscan: 3, scrollMargin: margin });
  // A new width or a new header changes the rows' heights: measure again.
  useEffect(() => { v.measure(); }, [sizeOf, v]);
  const shown = v.getVirtualItems();
  useWantShown(rows, shown[0]?.index ?? 0, shown[shown.length - 1]?.index ?? 0, want);

  const tick = useCallback((id: number, on: boolean) => onSelect([id], on), [onSelect]);
  const selecting = selected.size > 0;
  const grid = { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: GAP };
  const tileFor = (i: number, height: number) => {
    const tile = at(i);
    // A place still on its way: a tile's shape, or half a place's card.
    if (!tile) return height < cellHeight ? <Skeleton aria-hidden className="size-full rounded-lg" /> : <AssetTileSkeleton />;
    const ticks = canSelect && tile.status === "draft" ? tick : undefined;
    return isWords(tile.kind)
      ? <TextTile tile={tile} height={height} width={tileWidth} whole={height >= cellHeight} active={tile.id === openId} onOpen={onOpen} selected={selected.has(tile.id)} onSelect={ticks} selecting={selecting} />
      : <AssetTileView tile={tile} active={tile.id === openId} onOpen={onOpen} selected={selected.has(tile.id)} onSelect={ticks} selecting={selecting} />;
  };
  return (
    <div ref={box} data-signature-view="library" data-testid="library-grid" data-kit-peek role="list" aria-label="Library items"
      className="relative w-full" style={{ height }}>
      {shown.map((vr) => {
        const row = rows[vr.index];
        if (!row) return null;
        const y = { transform: `translateY(${vr.start - margin}px)` };
        if (row.type === "head") {
          return (
            <div key={vr.key} role="presentation" className="absolute inset-x-0 top-0 grid items-end" style={{ ...y, ...grid, height: HEAD }}>
              {row.segments.map((s) => <GroupHead key={s.group} segment={s} selected={selected} onSelect={onSelect} canSelect={canSelect} />)}
            </div>
          );
        }
        return (
          <div key={vr.key} className="absolute inset-x-0 top-0 grid" role="presentation" style={{ ...y, ...grid, height: cellHeight }}>
            {row.cells.map(({ col, cell }) => (
              cell.length === 1 && !isWords(at(cell[0])?.kind ?? "")
                ? <div key={`c${cell[0]}`} role="listitem" data-library-index={cell[0]} className="min-w-0" style={{ gridColumn: col + 1 }}>{tileFor(cell[0], cellHeight)}</div>
                : (
                  <div key={`c${cell[0]}`} role="presentation" className="flex min-w-0 flex-col" style={{ gridColumn: col + 1, gap: GAP }}>
                    {cell.map((i) => {
                      const h = cell.length === 1 ? cellHeight : halfHeight;
                      return <div key={i} role="listitem" data-library-index={i} className="min-w-0" style={{ height: h }}>{tileFor(i, h)}</div>;
                    })}
                  </div>
                )
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** The dense list: one row an item under its date group, with the columns' names on top. */
function LibraryList({ total, prefix, at, want, openId, onOpen, dates, now, anchor, selected, onSelect, canSelect }: ViewProps) {
  const { box, margin } = useBox();
  const phone = useIsMobile();
  const rowHeight = phone ? PHONE_ROW_HEIGHT : ROW_HEIGHT;
  const rows = useMemo(() => listRows(groupCells(total, prefix, at, now, dates)), [total, prefix, at, now, dates]);
  const sizeOf = useCallback((i: number) => (rows[i]?.type === "head" ? HEAD : rowHeight), [rows, rowHeight]);
  const height = rows.reduce((h, _, i) => h + sizeOf(i), 0);
  useKeepAnchor(anchor, rows, sizeOf, margin, true);
  const v = useVirtualizer({ count: rows.length, getScrollElement: scrollPane, estimateSize: sizeOf, overscan: 6, scrollMargin: margin });
  useEffect(() => { v.measure(); }, [sizeOf, v]);
  const shown = v.getVirtualItems();
  useWantShown(rows, shown[0]?.index ?? 0, shown[shown.length - 1]?.index ?? 0, want);
  const tick = useCallback((id: number, on: boolean) => onSelect([id], on), [onSelect]);
  const selecting = selected.size > 0;
  return (
    <div className="flex flex-col">
      <div aria-hidden className={cn("grid items-center gap-x-3 border-b pr-2 pb-2 text-caption font-medium text-muted-foreground max-md:hidden", ROW_COLUMNS)}>
        <span /><span /><span>Title</span><span>Kind</span><span>Status</span><span>Made by</span><span>Recipe</span><span>Made</span>
      </div>
      <div ref={box} data-signature-view="library" data-testid="library-list" data-kit-peek role="list" aria-label="Library items" className="relative w-full" style={{ height }}>
        {shown.map((vr) => {
          const row = rows[vr.index];
          if (!row) return null;
          const y = { transform: `translateY(${vr.start - margin}px)`, height: sizeOf(vr.index) };
          if (row.type === "head") {
            return (
              <div key={vr.key} role="presentation" className="absolute inset-x-0 top-0 grid items-end" style={y}>
                <GroupHead segment={row.segments[0]} selected={selected} onSelect={onSelect} canSelect={canSelect} />
              </div>
            );
          }
          const tile = at(row.index);
          return (
            <div key={vr.key} role="listitem" data-library-index={row.index} className="absolute inset-x-0 top-0 py-0.5" style={y}>
              {tile
                ? <AssetRow tile={tile} active={tile.id === openId} onOpen={onOpen} selected={selected.has(tile.id)}
                    onSelect={canSelect && tile.status === "draft" ? tick : undefined} selecting={selecting} />
                : <div aria-hidden className="flex h-full items-center gap-3 px-2 md:pl-11"><Skeleton className="size-10 rounded-md" /><Skeleton className="h-4 w-1/3" /></div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Placeholder tiles for the first page, in the grid's own shape. */
function GridSkeleton({ view }: { view: LibraryView }) {
  if (view === "list") {
    return (
      <div aria-busy="true" aria-label="Loading the library" className="flex flex-col gap-1">
        <span className="mb-2 h-5 w-16 rounded-sm bg-muted" />
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="flex h-14 items-center gap-3 px-2 md:pl-11"><Skeleton className="size-10 rounded-md" /><Skeleton className="h-4 w-1/3" /></div>)}
      </div>
    );
  }
  return (
    <div aria-busy="true" aria-label="Loading the library" className="flex flex-col gap-2">
      <span className="h-5 w-16 rounded-sm bg-muted" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
        {Array.from({ length: 10 }, (_, i) => <AssetTileSkeleton key={i} />)}
      </div>
    </div>
  );
}

/**
 * The phone's one row of kind and status chips, scrolling sideways. While there's more to its right, the row fades out
 * at its right edge, so it reads as a row that scrolls rather than one cut off. On a wider screen it's a plain row.
 */
function ChipRow({ children }: { children: ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const check = () => setMore(el.scrollWidth - el.scrollLeft - el.clientWidth > 1);
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const child of el.children) ro.observe(child);
    return () => { el.removeEventListener("scroll", check); ro.disconnect(); };
  }, []);
  return (
    <div className="relative -mx-4 md:mx-0" data-testid="library-chips" data-more={more || undefined}>
      <div ref={row} className="kit-scroll-x flex items-center gap-2 overflow-x-auto px-4 md:overflow-visible md:px-0">{children}</div>
      <span aria-hidden className={cn("pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-background to-transparent transition-opacity duration-150 md:hidden",
        more ? "opacity-100" : "opacity-0")} />
    </div>
  );
}

/** What a reviewer can do with the drafts they ticked: approve them all, or let go. */
function BulkBar({ count, busy, onApprove, onClear }: { count: number; busy: boolean; onApprove: () => void; onClear: () => void }) {
  return (
    <div className="pointer-events-none sticky bottom-4 z-20 flex justify-center motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2" data-testid="library-bulk">
      <div role="toolbar" aria-label="Selected drafts" className="pointer-events-auto flex items-center gap-2 rounded-lg border bg-popover py-1.5 pr-1.5 pl-3 text-body shadow-lg">
        <span className="font-medium tabular-nums" aria-live="polite">{count} {count === 1 ? "draft" : "drafts"} selected</span>
        <Button size="sm" onClick={onApprove} disabled={busy} data-testid="library-bulk-approve" className="ml-2"><Check aria-hidden />{busy ? "Approving…" : "Approve for use"}</Button>
        <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="Clear the selection (Esc)" title="Clear the selection (Esc)"><X aria-hidden /></Button>
      </div>
    </div>
  );
}

export function LibraryPage() {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const canRun = useCan("studio.run");
  // Everyone who may approve sees drafts too; a guest sees approved items only.
  const seesDrafts = useCan("library.approve");
  const [q, setQ] = useUrlState({ kind: "all", status: "", approved: "", maker: "", recipe: "" });
  const kind: KindTab = KIND_VALUES.includes(q.kind) ? (q.kind as KindTab) : "all";
  // `approved=1` is the older link (Home's "Approved for use" card still sends it).
  const status: Status = !seesDrafts ? "all" : q.status === "drafts" ? "drafts" : q.status === "approved" || q.approved === "1" ? "approved" : "all";
  const filters = useMemo<LibraryFilters>(() => ({ kind, approved: status === "approved", drafts: status === "drafts", maker: Number(q.maker) || 0, recipe: Number(q.recipe) || 0 }),
    [kind, status, q.maker, q.recipe]);
  const list = usePagedAssets(filters);
  const phone = useIsMobile();
  // Until a viewer chooses, a phone gets the list (read now, so the first frame is already the right view).
  const [chosenView, setView] = useState<LibraryView | null>(savedView);
  const narrow = phone || (typeof window !== "undefined" && window.innerWidth < 768);
  const view: LibraryView = chosenView ?? (narrow ? "list" : "grid");
  const anchor = useRef<Anchor | null>(null);
  const chooseView = (v: LibraryView) => {
    if (v !== view) anchor.current = anchorNow();
    setView(v);
    saveView(v);
  };
  const facets = useLoad(() => libraryApi.facets(), []);
  useLive("asset", () => { list.refresh(); facets.reload(); });

  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [approving, setApproving] = useState(false);
  useEffect(() => { setSelected(new Set()); }, [filters]);
  const select = useCallback((ids: number[], on: boolean) => setSelected((s) => {
    const next = new Set(s);
    for (const id of ids) { if (on) next.add(id); else next.delete(id); }
    return next;
  }), []);

  const openId = params.id ? Number(params.id) || null : null;
  useEffect(() => {
    if (!selected.size || openId) return;
    const on = (e: KeyboardEvent) => { if (e.key === "Escape" && !isTyping(e.target)) setSelected(new Set()); };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [selected.size, openId]);

  const approveSelected = async () => {
    const ids = [...selected];
    setApproving(true);
    const { approved, failed } = await approveMany(ids);
    setApproving(false);
    setSelected(new Set(failed.map((f) => f.id)));
    if (approved.length) toast.success(`Approved ${approved.length} ${approved.length === 1 ? "item" : "items"} for use`);
    if (failed.length) toast.error(`${failed.length} ${failed.length === 1 ? "wasn't" : "weren't"} approved: ${failed[0].reason}`, { description: "They're still selected. Try again." });
    list.refresh();
  };

  const open = useCallback((id: number) => navigate({ pathname: `/library/${id}`, search: location.search }), [navigate, location.search]);
  const close = useCallback(() => navigate({ pathname: "/library", search: location.search }), [navigate, location.search]);
  const at = list.loaded.findIndex((t) => t.id === openId);
  const step = (d: number) => {
    const next = list.loaded[at + d];
    if (next) navigate({ pathname: `/library/${next.id}`, search: location.search }, { replace: true });
  };

  const filtering = status !== "all" || !!filters.maker || !!filters.recipe;
  const makerOptions = (facets.data?.makers ?? []).map((m) => ({ value: String(m.id), label: m.name }));
  const recipeOptions = (facets.data?.recipes ?? []).map((r) => ({ value: String(r.id), label: r.name }));
  const shownStates = status === "drafts" ? ["draft"] : status === "approved" || !seesDrafts ? ["approved"] : ["draft", "approved"];
  const counted = list.counts !== undefined;
  const count = list.total === null ? "" : `${list.total.toLocaleString()} ${list.total === 1 ? "item" : "items"}${seesDrafts ? "" : " approved for use"}, newest first`;
  const clearStatus = { status: "", approved: "" };
  const kindTabs = (
    <Segmented<KindTab> label="Kind" value={kind} onChange={(k) => setQ({ kind: k })}
      options={KIND_TABS.map((t) => ({ ...t, count: counted ? tabCount(list.counts, t.value, shownStates) : undefined, testId: `kind-${t.value}` }))} />
  );
  const viewToggle = (
    <Segmented<LibraryView> label="Show as" value={view} onChange={chooseView} data-kit="library-view"
      options={[{ value: "grid", label: "Grid", icon: LayoutGrid, iconOnly: true, testId: "view-grid" }, { value: "list", label: "List", icon: List, iconOnly: true, testId: "view-list" }]} />
  );

  return (
    <div className="flex flex-col gap-4" data-testid="library">
      <PageHeader title="Library"
        description={count ? <span className="tabular-nums" data-testid="library-count">{count}</span> : "Everything the team made with AI, with how it was made."}
        actions={<>{!phone && kindTabs}{viewToggle}</>} />

      <div className="flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center" data-testid="library-filters">
        {/* On a phone the kinds and statuses are one row of chips that scrolls sideways; the pickers get a row of their own. */}
        {(phone || seesDrafts) && (
          <ChipRow>
            {phone && kindTabs}
            {/* A guest only ever sees approved items: a status filter would change nothing for them. */}
            {seesDrafts && (
              <Segmented<Status> label="Status" value={status} onChange={(s) => setQ({ ...clearStatus, status: s === "all" ? "" : s })}
                options={[
                  { value: "all", label: phone ? "Any status" : "All", count: counted ? tabCount(list.counts, kind, ["draft", "approved"]) : undefined, testId: "filter-all" },
                  { value: "drafts", label: "Drafts waiting", count: counted ? tabCount(list.counts, kind, ["draft"]) : undefined, testId: "filter-drafts" },
                  { value: "approved", label: "Approved", count: counted ? tabCount(list.counts, kind, ["approved"]) : undefined, testId: "filter-approved" },
                ]} />
            )}
          </ChipRow>
        )}
        <div className="flex min-w-0 items-center gap-2">
          <FilterSelect label="Made by" allLabel="Made by: anyone" value={q.maker} onChange={(maker) => setQ({ maker })}
            options={makerOptions.map((o) => ({ ...o, label: `Made by: ${o.label}` }))} className="min-w-0 flex-1 md:w-48 md:flex-none" />
          {recipeOptions.length > 0
            ? <FilterSelect label="Recipe" allLabel="Recipe: any" value={q.recipe} onChange={(recipe) => setQ({ recipe })}
                options={recipeOptions.map((o) => ({ ...o, label: `Recipe: ${o.label}` }))} className="min-w-0 flex-1 md:w-56 md:flex-none" />
            : <Button variant="outline" size="sm" disabled className="min-w-0 flex-1 justify-start font-normal md:w-44 md:flex-none" title="Items made by a recipe can be filtered by it once recipes have run.">Recipe: none yet</Button>}
          {filtering && <Button variant="ghost" size="sm" onClick={() => setQ({ ...clearStatus, maker: "", recipe: "" })} className="shrink-0 text-muted-foreground">{phone ? "Clear" : "Clear filters"}</Button>}
        </div>
      </div>

      {list.error && list.total === null ? (
        <LoadError title="The library didn't load" error={list.error} onRetry={list.restart} />
      ) : list.total === null ? (
        <GridSkeleton view={view} />
      ) : list.total === 0 ? (
        status === "drafts" && !filters.maker && !filters.recipe
          ? <EmptyState icon={Check} title="No drafts waiting" description={kind === "all" ? "Everything the team made has been approved for use." : "Every item of this kind has been approved for use."}
              action={<Button variant="outline" size="sm" onClick={() => setQ(clearStatus)}>Show everything</Button>} />
          : filtering || kind !== "all"
          ? <EmptyState icon={LibraryBig} title="Nothing matches" description="No items of this kind with these filters. Try another kind, or clear the filters."
              action={<Button variant="outline" size="sm" onClick={() => setQ({ kind: "all", ...clearStatus, maker: "", recipe: "" })}>Show everything</Button>} />
          : <EmptyState icon={LibraryBig} title="Nothing made yet" description={canRun ? "Everything you generate and choose to keep lands here, with how it was made." : "Approved items show here once the team has made some."}
              action={canRun ? <Button size="sm" onClick={() => navigate("/playground")}><FlaskConical aria-hidden />Open Playground</Button> : undefined} />
      ) : (
        <div className={cn("flex flex-col", selected.size > 0 && "pb-2")}>
          {list.error ? <LoadError title="Some items didn't load" error={list.error} onRetry={list.refresh} className="mb-3" /> : null}
          {view === "list"
            ? <LibraryList total={list.total} prefix={list.prefix} at={list.at} want={list.want} openId={openId} onOpen={open} dates={list.dates} now={list.now} anchor={anchor}
                selected={selected} onSelect={select} canSelect={seesDrafts && status !== "approved"} />
            : <LibraryGrid total={list.total} prefix={list.prefix} at={list.at} want={list.want} openId={openId} onOpen={open} dates={list.dates} now={list.now} anchor={anchor}
                selected={selected} onSelect={select} canSelect={seesDrafts && status !== "approved"} />}
          {selected.size > 0 && <BulkBar count={selected.size} busy={approving} onApprove={() => void approveSelected()} onClear={() => setSelected(new Set())} />}
        </div>
      )}

      <AssetSheet id={openId} preview={list.loaded.find((t) => t.id === openId) ?? null} onClose={close} onChanged={() => { list.refresh(); facets.reload(); }}
        onPrev={at > 0 ? () => step(-1) : undefined} onNext={at >= 0 && at < list.loaded.length - 1 ? () => step(1) : undefined} />
    </div>
  );
}
