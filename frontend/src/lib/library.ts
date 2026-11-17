// The Library's API: paths from xano/routes.gen.ts, types from the defs (import type only), every JSON call through
// `request()`. A download never opens a link as a page: a file's one-minute signed link and a text item's own route
// are both fetched and saved under the item's name, so nothing in it runs and nothing is left in a cache.
import type { InferResponse } from "@xano/sdk";
import type { assetLink, libraryFacets, listAssets, readAsset } from "../../../xano/query/library.js";
import { routePath } from "../../../xano/routes.gen.js";
import { ApiError, XANO_HOST, qs, request, token } from "@/base/request";
import { CLOUD_ONLY_WORDS, mediaBytes } from "./media";

export type AssetPage = InferResponse<typeof listAssets>;
export type AssetTile = AssetPage["items"][number];
export type AssetRecord = InferResponse<typeof readAsset>;
export type AssetLink = InferResponse<typeof assetLink>;
export type Facets = InferResponse<typeof libraryFacets>;

/** The kind tabs. Audio holds speech and music; Text holds text and transcripts. */
export const KIND_TABS = [
  { value: "all", label: "All" },
  { value: "image", label: "Images" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
  { value: "text", label: "Text" },
] as const;
export type KindTab = (typeof KIND_TABS)[number]["value"];

export const KIND_WORD: Record<string, string> = { image: "Image", video: "Video", music: "Music", speech: "Speech", text: "Text", transcript: "Transcript" };

/** Items a page. The grid asks for the pages it's about to show. */
export const PAGE_SIZE = 60;

export type LibraryFilters = { kind: KindTab; approved: boolean; maker: number; recipe: number; q?: string; drafts?: boolean };

export const libraryApi = {
  /** A page of items, with how many each date group holds (from where this browser's days start), so the grid is laid out at once. */
  list: (f: LibraryFilters, page: number, perPage = PAGE_SIZE, now = Date.now()) => request<AssetPage>("GET", routePath("GET assets") + qs({
    kind: f.kind, approved_only: f.approved || undefined, drafts_only: f.drafts || undefined, maker_id: f.maker || undefined, recipe_id: f.recipe || undefined, q: f.q || undefined, page, per_page: perPage,
    ...dateBounds(now),
  })),
  facets: () => request<Facets>("GET", routePath("GET facets")),
  get: (id: number) => request<AssetRecord>("GET", routePath("GET assets/{id}", { id })),
  link: (id: number) => request<AssetLink>("GET", routePath("GET assets/{id}/link", { id })),
  approve: (id: number) => request<{ id: number; status: string; approved_by: number; approved_at: number | null }>("POST", routePath("POST assets/{id}/approve", { id })),
  remove: (id: number) => request<{ deleted: boolean }>("DELETE", routePath("DELETE assets/{id}", { id })),
};

/** Save bytes under a name, without opening anything. */
function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** The item's file as bytes, however this server keeps it. Throws in plain words when it can't be read here. */
export async function fetchAssetFile(id: number): Promise<{ blob: Blob; name: string; mime: string }> {
  const link = await libraryApi.link(id);
  if (link.how === "unavailable") throw new ApiError(CLOUD_ONLY_WORDS, 0);
  if (link.how === "text") {
    const res = await fetch(XANO_HOST + routePath("GET assets/{id}/text", { id }), { headers: { authorization: `Bearer ${token.get() ?? ""}` } });
    if (!res.ok) throw new ApiError("The text didn't download. Try again.", res.status);
    return { blob: await res.blob(), name: link.file_name, mime: "text/plain" };
  }
  // A signed link or a table-kept file: lib/media.ts answers both the same way.
  return { blob: await mediaBytes({ url: link.url, blob_id: link.blob_id, mime: link.mime }), name: link.file_name, mime: link.mime };
}

/** Download an item: the file through its signed link, or a text item's words. */
export async function downloadAsset(id: number): Promise<string> {
  const { blob, name } = await fetchAssetFile(id);
  save(blob, name);
  return name;
}

/** "0:08", "1:02". */
export const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

/**
 * Where "Use in a new run" takes an item in the Playground, or why it can't go. Images are edited, recordings
 * transcribed, words become the prompt. No Playground kind takes a video in.
 */
export function playgroundUse(kind: string): { tab: "image" | "transcribe" | "text"; words: string } | { tab: null; words: string } {
  if (kind === "image") return { tab: "image", words: "Opens the Playground with this image attached to edit." };
  if (kind === "speech" || kind === "music") return { tab: "transcribe", words: "Opens the Playground with this recording attached to transcribe." };
  if (kind === "text" || kind === "transcript") return { tab: "text", words: "Opens the Playground with these words as the prompt." };
  return { tab: null, words: "No Playground run takes a video as its input yet." };
}

/** The item kinds each kind tab holds. */
export const TAB_KINDS: Record<KindTab, string[]> = {
  all: ["image", "video", "music", "speech", "text", "transcript"], image: ["image"], video: ["video"], audio: ["speech", "music"], text: ["text", "transcript"],
};

/** How many items a tab holds in the given statuses, from a page's counts. */
export function tabCount(counts: AssetPage["counts"] | undefined, tab: KindTab, statuses: string[]): number {
  return (counts ?? []).filter((c) => TAB_KINDS[tab].includes(c.kind) && statuses.includes(c.status)).reduce((n, c) => n + c.n, 0);
}

/** The date group an item falls in, newest first: Today, Yesterday, This week (the five days before), Earlier. */
export const DATE_GROUPS = ["Today", "Yesterday", "This week", "Earlier"] as const;
export type DateGroup = (typeof DATE_GROUPS)[number];
/** Where this browser's date groups start, in ms: midnight today, yesterday, and six days ago (the week's oldest day). */
export function dateBounds(now = Date.now()) {
  const back = (days: number) => { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - days); return d.getTime(); };
  return { today_from: back(0), yesterday_from: back(1), week_from: back(6) };
}
export function dateGroup(at: number, now = Date.now()): DateGroup {
  const b = dateBounds(now);
  if (at >= b.today_from) return "Today";
  if (at >= b.yesterday_from) return "Yesterday";
  return at >= b.week_from ? "This week" : "Earlier";
}

/**
 * How a viewer likes the Library laid out: tiles, or a dense list. Kept in this browser once they choose; until then (or
 * with storage blocked) a phone shows the list, where a title has the room it needs, and a wider screen the tiles.
 */
export type LibraryView = "grid" | "list";
const VIEW_KEY = "library.view";
export function savedView(): LibraryView | null {
  try { const v = localStorage.getItem(VIEW_KEY); return v === "list" || v === "grid" ? v : null; } catch { return null; }
}
export function saveView(view: LibraryView) {
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* storage off */ }
}

const SMALL_WORDS = new Set(["a", "an", "the", "for", "of", "to", "in", "on", "and", "from", "with", "by", "at", "our", "your"]);
const wordsOf = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter((w) => w && !SMALL_WORDS.has(w));

/**
 * Whether a text's first line only says again what its title says ("Trail 2 for the newsletter" under "Trail 2 newsletter
 * blurb"): a short line, not a sentence, whose words are nearly all in the title. A preview starts after such a line.
 */
export function repeatsTitle(line: string, title: string): boolean {
  const heading = line.trim().replace(/^#+\s*/, "");
  if (!heading || !title) return false;
  if (heading.toLowerCase() === title.trim().toLowerCase()) return true;
  if (heading.length > 80 || /[.!?]$/.test(heading)) return false;
  const words = wordsOf(heading);
  const titled = new Set(wordsOf(title));
  return words.length > 0 && words.filter((w) => titled.has(w)).length / words.length >= 0.6;
}

/** Text items: these show as short cards, two to a tile's place in the grid. */
export const isWords = (kind: string) => kind === "text" || kind === "transcript";

/** One place in the grid: a picture, clip or recording, or up to two text items stacked. Items by their position in the list. */
export type Cell = number[];
/** A date group's places in the grid, and its drafts (for "Select N drafts"). */
export type GroupCells = { group: DateGroup; cells: Cell[]; drafts: number[] };

/** How many items a date group holds, and how many of them are words, as the list's first page says. */
export type DateCount = { group: DateGroup; n: number; words: number };
type Placed = { kind: string; status: string; id: number; created_at: number };

/** The places a group's items take: one each, but words two to a place. */
export const placesFor = (d: Pick<DateCount, "n" | "words">) => d.n - d.words + Math.ceil(d.words / 2);

/**
 * The grid's places, by date group, newest first. Text items pair up two to a place (the second text after the first in the
 * same group joins it), so a run of words takes half the room of a run of pictures.
 *
 * With `dates` (each group's count and its words, from the server) every group is laid out before its pages arrive: the
 * list is newest first, so each group is one unbroken run of positions, and it takes exactly `placesFor` places. The items
 * on hand from the group's start fill its first places; the rest are placeholders holding the positions still on their way,
 * so a page landing fills places in and never adds or removes one. Without `dates`, the items on hand from the top (to
 * `prefix`) are grouped by their own dates, and the rest take a place each after the last group.
 */
export function groupCells(total: number, prefix: number, at: (i: number) => Placed | undefined, now = Date.now(), dates?: DateCount[]): GroupCells[] {
  if (dates?.length && dates.reduce((n, d) => n + d.n, 0) === total) return countedCells(dates, at);
  const groups: GroupCells[] = [];
  let open: Cell | null = null;
  for (let i = 0; i < prefix; i++) {
    const item = at(i)!;
    const g = dateGroup(item.created_at, now);
    let current = groups[groups.length - 1];
    if (!current || current.group !== g) { current = { group: g, cells: [], drafts: [] }; groups.push(current); open = null; }
    if (item.status === "draft") current.drafts.push(item.id);
    if (isWords(item.kind)) {
      if (open && open.length < 2) { open.push(i); open = null; } else { open = [i]; current.cells.push(open); }
    } else current.cells.push([i]);
  }
  if (total > prefix) {
    if (!groups.length) groups.push({ group: "Today", cells: [], drafts: [] });
    for (let i = prefix; i < total; i++) groups[groups.length - 1].cells.push([i]);
  }
  return groups;
}

function countedCells(dates: DateCount[], at: (i: number) => Placed | undefined): GroupCells[] {
  const groups: GroupCells[] = [];
  let start = 0;
  for (const d of dates) {
    const end = start + d.n;
    if (d.n > 0) {
      const g: GroupCells = { group: d.group, cells: [], drafts: [] };
      // The items on hand from the group's start, placed as they are.
      let open: Cell | null = null;
      let i = start;
      for (; i < end; i++) {
        const item = at(i);
        if (!item) break;
        if (item.status === "draft") g.drafts.push(item.id);
        if (isWords(item.kind)) {
          if (open) { open.push(i); open = null; } else { open = [i]; g.cells.push(open); }
        } else g.cells.push([i]);
      }
      // The rest hold the places left. A word still to come may pair with the one waiting alone.
      let left = placesFor(d) - g.cells.length;
      let waiting = end - i;
      if (open && waiting > left) { open.push(i++); waiting--; }
      for (; left > 0; left--) {
        const two = waiting > left;
        g.cells.push(two ? [i, i + 1] : [i]);
        i += two ? 2 : 1;
        waiting -= two ? 2 : 1;
      }
      // Counts that no longer match what arrived (the library changed between pages) still place every item.
      while (i < end) g.cells.push([i++]);
      groups.push(g);
    }
    start = end;
  }
  return groups;
}

/** A header row's labels: each group that starts on it, at its column, spanning its places. */
export type HeadSegment = { group: DateGroup; col: number; span: number; drafts: number[] };
export type GridRow = { type: "head"; segments: HeadSegment[] } | { type: "cells"; cells: { col: number; cell: Cell }[] };

/**
 * The grid's rows. Date groups flow on from one another instead of each starting a new row, so a day with one or two items
 * never leaves the rest of its row empty: each group's label sits over the columns where it starts, in a header row above
 * any row a group starts in.
 */
export function gridRows(groups: GroupCells[], columns: number): GridRow[] {
  const rows: GridRow[] = [];
  let head: HeadSegment[] = [];
  let cells: { col: number; cell: Cell }[] = [];
  const flush = () => {
    if (!cells.length) return;
    if (head.length) rows.push({ type: "head", segments: head });
    rows.push({ type: "cells", cells });
    head = [];
    cells = [];
  };
  let col = 0;
  for (const g of groups) {
    if (!g.cells.length) continue;
    head.push({ group: g.group, col, span: Math.min(g.cells.length, columns - col), drafts: g.drafts });
    for (const cell of g.cells) {
      cells.push({ col, cell });
      col += 1;
      if (col === columns) { flush(); col = 0; }
    }
  }
  flush();
  return rows;
}

/** Approve several drafts: each is its own request, so one that fails leaves the others approved. */
export async function approveMany(ids: number[]): Promise<{ approved: number[]; failed: { id: number; reason: string }[] }> {
  const results = await Promise.allSettled(ids.map((id) => libraryApi.approve(id)));
  const approved: number[] = [];
  const failed: { id: number; reason: string }[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") approved.push(ids[i]);
    else failed.push({ id: ids[i], reason: r.reason instanceof Error ? r.reason.message : "It wasn't approved. Try again." });
  });
  return { approved, failed };
}
