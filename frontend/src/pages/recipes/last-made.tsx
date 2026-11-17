// Above a recipe's form: what its newest finished run made, as small tiles that open each item in the Library, with the
// run it came from, who ran it, when, and how it ended. It's the best answer to "what will pressing Run give me?".
import { Link } from "react-router";
import { ArrowRight, AudioLines, FileText, ImageIcon, Music, Video, type LucideIcon } from "lucide-react";
import { Ago, StatusBadge, useLoad } from "@/components/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { textCard, usePicture } from "@/components/studio/asset-tile";
import { useLive } from "@/base/live";
import { useWorkspace } from "@/base/workspace";
import { KIND_WORD, libraryApi, type AssetTile } from "@/lib/library";
import type { RecipeDetail } from "@/lib/recipes";
import { cn } from "@/lib/utils";
import { runLabel, runStatus } from "./run-words";

const ICON: Record<string, LucideIcon> = { image: ImageIcon, video: Video, music: Music, speech: AudioLines, text: FileText, transcript: FileText };
/** The most tiles shown: one row at the pane's width. */
const SHOWN = 5;

function Picture({ tile }: { tile: AssetTile }) {
  const pic = usePicture(tile.id, tile.thumb, tile.thumb_blob);
  const Icon = ICON[tile.kind] ?? FileText;
  if (!pic.src) return <Icon aria-hidden className="size-5 text-muted-foreground" />;
  return <img src={pic.src} alt="" loading="lazy" decoding="async" onError={pic.expired} className="absolute inset-0 size-full object-cover" />;
}

/** One made thing: the picture, the clip's poster, the words' first line, or the recording's kind, with its kind on hover. */
function Thumb({ tile }: { tile: AssetTile }) {
  const Icon = ICON[tile.kind] ?? FileText;
  const kind = KIND_WORD[tile.kind] ?? tile.kind;
  const words = tile.kind === "text" || tile.kind === "transcript";
  const pictured = tile.kind === "image" || (tile.kind === "video" && (tile.thumb || tile.thumb_blob));
  return (
    <Link to={`/library/${tile.id}`} title={`${tile.title || kind} · ${kind}. Open it in the Library`} data-testid="recipe-made-item"
      className="focus-ring group/made relative grid aspect-square min-w-0 place-items-center overflow-hidden rounded-md border bg-muted/50 transition-colors hover:border-foreground/30">
      {pictured ? <Picture tile={tile} />
        : words ? (
          <span className="absolute inset-0 flex flex-col gap-1 bg-card p-2 text-left">
            <span className="line-clamp-3 text-caption leading-snug font-medium text-foreground">{textCard(tile.excerpt).heading || tile.title}</span>
            <span className="line-clamp-2 text-micro leading-snug text-muted-foreground">{textCard(tile.excerpt).lines}</span>
          </span>
        ) : (
          <span className="grid justify-items-center gap-1 px-1 text-center text-muted-foreground">
            <Icon aria-hidden className="size-5" />
            <span className="line-clamp-2 text-micro text-pretty">{tile.title || kind}</span>
          </span>
        )}
      {/* Words read as words; anything else says its kind in the corner. */}
      {words ? <span className="sr-only">{kind}</span> : (
        <span className="absolute right-1.5 bottom-1.5 grid size-5 place-items-center rounded-sm bg-background/90 text-muted-foreground shadow-xs">
          <Icon aria-hidden className="size-3" /><span className="sr-only">{kind}</span>
        </span>
      )}
    </Link>
  );
}

export function LastMade({ detail }: { detail: RecipeDetail }) {
  const { nameOf } = useWorkspace();
  const { history, recipe } = detail;
  const made = history.made_run;
  const ids = history.made_ids;
  // The recipe's newest library items hold the run's; they're picked out by id, in the order its steps made them.
  const items = useLoad(() => (made && ids.length
    ? libraryApi.list({ kind: "all", approved: false, maker: 0, recipe: recipe.id }, 1, 24) : Promise.resolve(null)), [recipe.id, made?.id, ids.join(",")]);
  // An item renamed, approved or deleted shows here as it is now.
  useLive("asset", items.reload);
  if (!made || !ids.length) return null;
  const tiles = ids.map((id) => items.data?.items.find((t) => t.id === id)).filter(Boolean).slice(0, SHOWN) as AssetTile[];
  if (items.data && !tiles.length) return null;
  const st = runStatus(made.status);
  return (
    <section className="rounded-lg border bg-card" aria-label="What the last run made" data-testid="recipe-last-made">
      <header className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2">
        <h3 className="text-heading">Last made</h3>
        <span className="min-w-0 truncate text-caption text-muted-foreground" title={made.title}>
          {runLabel(made.title, recipe.name)} · {nameOf(made.owner_id).split(" ")[0]} · <Ago value={made.created_at} />
        </span>
        {made.status !== "done" && <StatusBadge tone={st.tone} dot>{st.label}</StatusBadge>}
        <Link to={`/runs/${made.id}`} className="focus-ring ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm text-caption text-muted-foreground hover:text-foreground">
          Open the run<ArrowRight aria-hidden className="size-3.5" />
        </Link>
      </header>
      <div className={cn("grid gap-2 p-3", "grid-cols-3 sm:grid-cols-5")}>
        {!items.data
          ? Array.from({ length: Math.min(SHOWN, ids.length) }, (_, i) => <Skeleton key={i} className={cn("aspect-square w-full rounded-md", i > 2 && "max-sm:hidden")} />)
          : tiles.map((t, i) => <div key={t.id} className={cn("min-w-0", i > 2 && "max-sm:hidden")}><Thumb tile={t} /></div>)}
      </div>
    </section>
  );
}
