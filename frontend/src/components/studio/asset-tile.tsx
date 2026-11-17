// A library item at a glance. In the grid: a square that shows the picture, a clip's poster and length, or a recording,
// with its title, where it stands (draft or approved) and who made it underneath; words are a short card with the title
// inside it, two to a square. In the list: a dense row with a thumbnail. An agent's work says so: "Easel, for Jordan" with
// the violet glyph. A draft can carry a tick box (hover, focus or a touch screen shows it) so a reviewer approves several
// at once; an open or ticked item takes the kit's selected tint and a 1px accent ring, and keyboard focus keeps its own ring.
// A picture's link lasts a minute; one that has expired by the time the tile shows again asks for a fresh one, once.
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AudioLines, Check, FileText, ImageIcon, Music, Play, Video, type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, relative } from "@/components/kit";
import { KIND_WORD, duration, libraryApi, repeatsTitle, type AssetTile } from "@/lib/library";
import { useMedia } from "@/lib/media";
import { readJson, splitTitle } from "@/lib/readable-json";
import { modelName } from "@/lib/knowledge";
import { cn } from "@/lib/utils";
import { AgentBy } from "./agent-mark";

const ICON: Record<string, LucideIcon> = { image: ImageIcon, video: Video, music: Music, speech: AudioLines, text: FileText, transcript: FileText };

/** The caption under a tile's square, in px: the gap, a title line, a status-and-maker line and the padding. */
export const TILE_CAPTION = 6 + 20 + 4 + 20 + 4;

/** A picture's address on this server, or "" while it loads or when it can't show. Asks for a fresh link once. */
export function usePicture(id: number, src: string, blob: number) {
  const [url, setUrl] = useState(src);
  const [state, setState] = useState<"ok" | "retried" | "failed">("ok");
  useEffect(() => { setUrl(src); setState("ok"); }, [src]);
  const shown = useMedia(src || blob ? { url, blob_id: blob } : null);
  const expired = () => {
    if (blob || state !== "ok") { setState("failed"); return; }
    setState("retried");
    libraryApi.link(id).then((l) => (l.how === "signed" ? setUrl(l.url) : setState("failed")), () => setState("failed"));
  };
  return { src: shown.state === "ready" && state !== "failed" ? shown.src : "", expired };
}

/** A picture, shown the way this server keeps it (lib/media.ts); the kind's icon while it loads or when it can't. */
function Picture({ id, src, blob, title }: { id: number; src: string; blob: number; title: string }) {
  const pic = usePicture(id, src, blob);
  if (!pic.src) return <ImageIcon aria-hidden className="size-6 text-muted-foreground" />;
  return <img src={pic.src} alt={title} loading="lazy" decoding="async" onError={pic.expired} className="absolute inset-0 size-full object-cover" />;
}

/** Quiet bars that read as "a recording", not a measurement. */
function Bars() {
  return (
    <span aria-hidden className="flex h-7 items-center gap-[3px]">
      {[10, 18, 26, 14, 22, 8, 16].map((h, i) => <i key={i} style={{ height: h }} className="w-[3px] rounded-full bg-current" />)}
    </span>
  );
}

/** A text's heading and the lines under it: a JSON reply reads as its headline and lines, never as braces and quotes. */
export function textCard(excerpt: string): { heading: string; lines: string } {
  const json = readJson(excerpt);
  if (json) {
    const { title, rest } = splitTitle(json);
    return { heading: title ?? "", lines: rest.map((l) => (l.item ? `• ${l.text}` : l.text)).join("\n") };
  }
  const [first = "", ...more] = excerpt.trim().split(/\n+/);
  return { heading: first, lines: more.join("\n") };
}

/** Words as a small card: the heading on up to two lines, three lines under it, each cut at a whole line with an ellipsis. */
function TextCard({ excerpt, wide }: { excerpt: string; wide: boolean }) {
  const { heading, lines } = textCard(excerpt);
  return (
    <span className={cn("absolute inset-0 flex flex-col gap-1.5 bg-card p-3 text-left", wide ? "pt-10" : "pr-10")}>
      {heading ? <span className="line-clamp-2 text-body leading-snug font-medium text-foreground">{heading}</span>
        : <span className="text-caption text-muted-foreground">No words were kept.</span>}
      {lines && <span className={cn("text-caption leading-relaxed whitespace-pre-line text-muted-foreground", wide ? "line-clamp-2" : "line-clamp-3")}>{lines}</span>}
    </span>
  );
}

function Media({ tile, wide }: { tile: AssetTile; wide: boolean }) {
  const Icon = ICON[tile.kind] ?? FileText;
  if (tile.kind === "image") return <Picture id={tile.id} src={tile.thumb} blob={tile.thumb_blob} title={tile.title} />;
  if (tile.kind === "text" || tile.kind === "transcript") return <TextCard excerpt={tile.excerpt} wide={wide} />;
  if (tile.kind === "speech" || tile.kind === "music") return <span className="text-muted-foreground"><Bars /></span>;
  if (tile.kind === "video") {
    // The picture it was made from, when there is one; otherwise a frame that reads as "a clip", not as a missing image.
    if (tile.thumb || tile.thumb_blob) return <Picture id={tile.id} src={tile.thumb} blob={tile.thumb_blob} title={tile.title} />;
    return (
      <span aria-hidden className="absolute inset-0 grid place-items-center bg-gradient-to-b from-muted to-muted-foreground/25">
        <Video className="size-7 text-foreground/45" />
      </span>
    );
  }
  return <Icon aria-hidden className="size-6 text-muted-foreground" />;
}

/** Where an item stands, the same pill the sheet shows. */
export const AssetStatus = ({ status, className }: { status: string; className?: string }) =>
  status === "approved" ? <StatusBadge tone="success" dot className={className}>Approved</StatusBadge> : <StatusBadge dot className={className}>Draft</StatusBadge>;

/** The tick box a reviewer uses: shown on hover or focus, always while something is ticked, and always on touch screens. */
function SelectBox({ title, selected, selecting, onToggle, className }: { title: string; selected: boolean; selecting: boolean; onToggle: () => void; className?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={selected} aria-label={`Select ${title}`} data-testid="asset-select"
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      className={cn("focus-ring grid size-8 shrink-0 place-items-center rounded-md transition-opacity duration-150",
        selected || selecting ? "opacity-100" : "opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100", className)}>
      <span className={cn("grid size-[18px] place-items-center rounded-[5px] border shadow-xs transition-colors",
        selected ? "border-primary-text bg-primary-text text-background" : "border-foreground/40 bg-background/95 text-transparent hover:border-foreground")}>
        <Check aria-hidden className="size-3" strokeWidth={3} />
      </span>
    </button>
  );
}

/** How a tile or row shows it's open or ticked: the kit's selected tint and a 1px ring of the accent, never a heavy outline. */
const PICKED = "bg-selected ring-1 ring-primary-text/50";

/** Who made it, with the agent's glyph when an agent did. */
function MadeBy({ tile }: { tile: AssetTile }) {
  const who = tile.maker_name ?? "Someone";
  return tile.agent ? <AgentBy agent={tile.agent} person={who} /> : <span className="truncate">{who}</span>;
}

const hoverTitle = (tile: AssetTile) => {
  const who = tile.maker_name ?? "Someone";
  return `${tile.title || KIND_WORD[tile.kind]}\n${KIND_WORD[tile.kind] ?? tile.kind} · ${modelName(tile.model)} · ${tile.agent ? `${tile.agent} for ${who}` : who} · ${relative(tile.created_at)}`;
};

/**
 * A text item's words as one run for a preview: the body, not the title again. Its heading shows only when it says
 * something the title doesn't ("City 3: the quiet commuter" under "City 3 page copy"); a first line that repeats the
 * title ("Trail 2 for the newsletter" under "Trail 2 newsletter blurb") is left out.
 */
export function previewWords(tile: Pick<AssetTile, "excerpt" | "title">) {
  const { heading, lines } = textCard(tile.excerpt);
  const shown = heading && !repeatsTitle(heading, tile.title) ? heading : "";
  // A heading that's all there is still shows, rather than "No words were kept".
  return [shown || (lines ? "" : heading), lines].filter(Boolean).join(" ").replace(/\s*\n+\s*/g, " ");
}

/** A text card's fixed parts, in px: padding, the footer line and the gaps between title, words and footer. */
const TEXT_CARD_CHROME = 12 + 6 + 6 + 22 + 12;
/**
 * How many lines (one or two) a card's title takes as drawn, read before the first paint, so the words under it are cut
 * to the room that's really left. A wider card measures again.
 */
function useTitleLines(title: string, width: number) {
  const ref = useRef<HTMLSpanElement>(null);
  const [lines, setLines] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setLines(el.getBoundingClientRect().height > 30 ? 2 : 1);
  }, [title, width]);
  return { ref, lines };
}

/**
 * Words as a short card: the title inside it on up to two lines (all of it on hover), then as many lines of the words as
 * its height holds (cut at a whole line), and where it stands and who made it at the foot. A card that has a tile's whole
 * place to itself shows its words a size up, so it reads as a page, not a box with room to spare. The tick box sits in
 * the card's top row, beside the title, never on it.
 */
export const TextTile = memo(function TextTile({ tile, height, width, whole = false, active, onOpen, selected = false, onSelect, selecting = false }: {
  tile: AssetTile; height: number; active: boolean; onOpen: (id: number) => void;
  /** The card's width in px, for how many lines its title takes. */
  width: number;
  /** It has a tile's whole place, not half. */
  whole?: boolean;
  selected?: boolean; onSelect?: (id: number, on: boolean) => void; selecting?: boolean;
}) {
  const kind = KIND_WORD[tile.kind] ?? tile.kind;
  const title = tile.title || kind;
  const words = previewWords(tile);
  const ticks = !!onSelect;
  const heading = useTitleLines(title, width);
  const lineHeight = whole ? 20 : 18;
  const lines = Math.floor((height - TEXT_CARD_CHROME - heading.lines * 20) / lineHeight);
  return (
    <div className="group/tile relative h-full min-w-0" data-testid="asset-tile" data-kind={tile.kind} data-id={tile.id} data-status={tile.status} data-selected={selected || undefined}>
      <button type="button" onClick={() => (ticks && selecting ? onSelect(tile.id, !selected) : onOpen(tile.id))} aria-current={active || undefined}
        aria-label={ticks && selecting ? `${selected ? "Untick" : "Tick"} ${title}` : undefined} title={hoverTitle(tile)}
        className={cn("focus-ring flex size-full min-w-0 flex-col gap-1.5 rounded-lg border bg-card p-3 text-left transition-colors hover:border-foreground/25",
          (active || selected) && "border-primary-text/60 bg-selected hover:border-primary-text/60")}>
        <span className={cn("flex min-w-0 items-start gap-2", ticks && "pr-7")}>
          <FileText aria-hidden className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" /><span className="sr-only">{kind}: </span>
          <span ref={heading.ref} className="line-clamp-2 min-w-0 text-body leading-5 font-medium text-pretty" data-testid="asset-title">{title}</span>
        </span>
        {lines < 1 ? null : words
          ? <span className={cn("text-pretty text-muted-foreground", whole ? "text-body leading-5" : "text-caption leading-[18px]")}
              style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" }}>{words}</span>
          : <span className="text-caption text-muted-foreground">No words were kept.</span>}
        <span className="mt-auto flex h-[22px] min-w-0 items-center gap-2 text-caption text-muted-foreground">
          <AssetStatus status={tile.status} />
          <MadeBy tile={tile} />
        </span>
      </button>
      {ticks && <SelectBox title={title} selected={selected} selecting={selecting} onToggle={() => onSelect(tile.id, !selected)} className="absolute top-1.5 right-1.5" />}
    </div>
  );
});

/** A small square of the item for a list row: the picture or poster, or the kind's icon. */
function Thumb({ tile }: { tile: AssetTile }) {
  const Icon = ICON[tile.kind] ?? FileText;
  const pictured = tile.kind === "image" || (tile.kind === "video" && (tile.thumb || tile.thumb_blob));
  return (
    <span className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-md border bg-muted/60 text-muted-foreground">
      {pictured ? <Picture id={tile.id} src={tile.thumb} blob={tile.thumb_blob} title="" /> : <Icon aria-hidden className="size-4" />}
      {tile.kind === "video" && pictured && <span aria-hidden className="absolute inset-0 grid place-items-center bg-foreground/15"><Play className="size-3.5 fill-background text-background" /></span>}
    </span>
  );
}

/** The list view's columns, shared by its header and every row. Narrow screens keep the thumbnail, the title and one line under it. */
export const ROW_COLUMNS = "md:grid-cols-[2rem_2.5rem_minmax(0,1fr)_4.5rem_6rem_8.5rem_7.5rem_5.5rem] xl:grid-cols-[2rem_2.5rem_minmax(0,1fr)_4.5rem_6.5rem_9.5rem_9rem_6rem]";
export const ROW_HEIGHT = 56;
export const PHONE_ROW_HEIGHT = 64;

/** One item as a dense row: thumbnail, title, kind, status, who made it, the recipe, and when. */
export const AssetRow = memo(function AssetRow({ tile, active, onOpen, selected = false, onSelect, selecting = false }: {
  tile: AssetTile; active: boolean; onOpen: (id: number) => void;
  selected?: boolean; onSelect?: (id: number, on: boolean) => void; selecting?: boolean;
}) {
  const kind = KIND_WORD[tile.kind] ?? tile.kind;
  const title = tile.title || kind;
  const ticks = !!onSelect;
  const playable = tile.kind === "video" || tile.kind === "music" || tile.kind === "speech";
  return (
    <div className={cn("group/tile relative h-full min-w-0 rounded-md transition-colors", active || selected ? PICKED : "hover:bg-muted/50")}
      data-testid="asset-row" data-kind={tile.kind} data-id={tile.id} data-status={tile.status} data-selected={selected || undefined}>
      <button type="button" onClick={() => (ticks && selecting ? onSelect(tile.id, !selected) : onOpen(tile.id))} aria-current={active || undefined}
        aria-label={ticks && selecting ? `${selected ? "Untick" : "Tick"} ${title}` : undefined} title={hoverTitle(tile)}
        className={cn("focus-ring-inset grid size-full min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-3 rounded-md pr-2 pl-2 text-left text-body md:pl-0", ROW_COLUMNS,
          ticks ? "max-md:pr-11" : "")}>
        <span aria-hidden className="max-md:hidden" />
        <Thumb tile={tile} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{title}</span>
          <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground md:hidden">
            <AssetStatus status={tile.status} /><span className="flex min-w-0 items-center"><MadeBy tile={tile} /></span><span aria-hidden>·</span><span className="shrink-0">{relative(tile.created_at)}</span>
          </span>
          {tile.kind === "text" || tile.kind === "transcript"
            ? <span className="truncate text-caption text-muted-foreground max-md:hidden">{previewWords(tile)}</span>
            : playable && tile.seconds > 0 ? <span className="text-caption text-muted-foreground tabular-nums max-md:hidden">{duration(tile.seconds)}</span> : null}
        </span>
        <span className="truncate text-muted-foreground max-md:hidden">{kind}</span>
        <span className="max-md:hidden"><AssetStatus status={tile.status} /></span>
        <span className="flex min-w-0 items-center text-muted-foreground max-md:hidden"><MadeBy tile={tile} /></span>
        <span className="truncate text-muted-foreground max-md:hidden" title={tile.recipe || undefined}>{tile.recipe || "—"}</span>
        <span className="truncate text-muted-foreground tabular-nums max-md:hidden">{relative(tile.created_at)}</span>
      </button>
      {ticks && <SelectBox title={title} selected={selected} selecting={selecting} onToggle={() => onSelect(tile.id, !selected)}
        className="absolute top-1/2 -translate-y-1/2 max-md:right-1.5 max-md:size-11 md:left-0" />}
    </div>
  );
});

export const AssetTileView = memo(function AssetTileView({ tile, active, onOpen, selected, onSelect, selecting = false, wide = false }: {
  tile: AssetTile; active: boolean; onOpen: (id: number) => void;
  /** Whether it's ticked for a bulk action, and how to tick it. Without `onSelect` it has no checkbox. */
  selected?: boolean; onSelect?: (id: number, on: boolean) => void;
  /** Something is already ticked: a click ticks this one too, instead of opening it. */
  selecting?: boolean;
  /** A wider, shorter tile with the title on up to two lines, as Home shows a few. */
  wide?: boolean;
}) {
  const who = tile.maker_name ?? "Someone";
  const Icon = ICON[tile.kind] ?? FileText;
  const kind = KIND_WORD[tile.kind] ?? tile.kind;
  const playable = tile.kind === "video" || tile.kind === "music" || tile.kind === "speech";
  const title = tile.title || kind;
  const ticks = !!onSelect;
  return (
    <div className="group/tile relative min-w-0" data-testid="asset-tile" data-kind={tile.kind} data-id={tile.id} data-status={tile.status} data-selected={selected || undefined}>
      <button type="button" onClick={() => (ticks && selecting ? onSelect(tile.id, !selected) : onOpen(tile.id))} aria-current={active || undefined}
        aria-label={ticks && selecting ? `${selected ? "Untick" : "Tick"} ${title}` : undefined}
        title={`${title}\n${kind} · ${modelName(tile.model)} · ${tile.agent ? `${tile.agent} for ${who}` : who} · ${relative(tile.created_at)}`}
        className={cn("focus-ring flex w-full min-w-0 flex-col gap-1.5 rounded-lg p-1 text-left transition-colors", (active || selected) && PICKED)}>
        <span className={cn("relative grid w-full place-items-center overflow-hidden rounded-md border bg-muted/60 transition-colors group-hover/tile:border-foreground/25",
          wide ? "aspect-[4/3]" : "aspect-square", (active || selected) && "border-primary-text/40")}>
          <Media tile={tile} wide={wide} />
          {/* A wide tile's caption keeps its line for who made it: the status sits on the picture, on a solid chip. */}
          {wide && <AssetStatus status={tile.status} className="absolute top-2 left-2 bg-background shadow-xs" />}
          <span className="absolute top-2 right-2 grid size-6 place-items-center rounded-md bg-background/90 text-muted-foreground shadow-xs" title={kind}>
            <Icon aria-hidden className="size-3.5" /><span className="sr-only">{kind}</span>
          </span>
          {tile.kind === "video" && (
            <span aria-hidden className="absolute right-2 bottom-2 grid size-7 place-items-center rounded-full bg-background/85 text-foreground shadow-xs"><Play className="size-3.5 fill-current" /></span>
          )}
          {tile.seconds > 0 && playable && (
            <span className="absolute bottom-2 left-2 rounded-sm bg-background/85 px-1.5 text-micro font-medium text-foreground tabular-nums shadow-xs">{duration(tile.seconds)}</span>
          )}
        </span>
        <span className="flex min-w-0 flex-col gap-1 px-0.5 pb-1">
          <span className={cn("block text-body font-medium", wide ? "line-clamp-2 h-10 text-pretty" : "h-5 truncate")}>{title}</span>
          <span className="flex h-5 min-w-0 items-center gap-2 text-caption text-muted-foreground">
            {!wide && <AssetStatus status={tile.status} />}
            {tile.agent ? <AgentBy agent={tile.agent} person={who} /> : <span className="truncate">{who}</span>}
          </span>
        </span>
      </button>
      {ticks && <SelectBox title={title} selected={!!selected} selecting={selecting} onToggle={() => onSelect(tile.id, !selected)} className="absolute top-2 left-2" />}
    </div>
  );
});

/** A tile's shape while its page is on its way, so nothing moves when it lands. */
export function AssetTileSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-1.5 p-1">
      <Skeleton className="aspect-square w-full rounded-md" />
      <div className="flex flex-col gap-1 px-0.5 pb-1">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-5 w-1/2" />
      </div>
    </div>
  );
}
