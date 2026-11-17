// One library item beside the grid: the thing itself (a picture, a clip or recording that plays, or the words), what can
// be done with it (download, approve for use, start a new run from it, delete), and the record of how it was made. When an
// agent made it, the sheet says so first: "Easel drafted this for Jordan", with Approve beside it. The sheet opens with the
// tile it came from already drawn (the picture, the clip's poster, the words), so nothing slides in empty; the record
// fills in under it. Files show however this server keeps them (lib/media.ts); a one-minute link that has run out by the
// time the player asks is replaced once.
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { Check, Download, FlaskConical, MoreHorizontal, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { DateLabel, EmptyState, Field, Fields, LoadError, RecordSheet, relative, useLoad } from "@/components/kit";
import { useCan } from "@xano-sdk/rbac/react";
import { useLive } from "@/base/live";
import { ApiError } from "@/lib/api";
import { costOf, modelName, spentWords } from "@/lib/knowledge";
import { KIND_WORD, downloadAsset, libraryApi, playgroundUse, type AssetRecord, type AssetTile } from "@/lib/library";
import { useMedia, type MediaRef } from "@/lib/media";
import { MediaNote, MediaView } from "@/components/studio/media-view";
import { AgentBy, AgentGlyph, agentFor } from "@/components/studio/agent-mark";
import { AssetStatus, textCard, usePicture } from "@/components/studio/asset-tile";
import { fieldLabel, groupByField, readJson, splitTitle } from "@/lib/readable-json";

/** The settings worth a glance, in words: "16:9 · 1K", "8 s · 720p · with sound", "voice Kore". */
export function settingWords(settings: Record<string, unknown>): string {
  const s = settings ?? {};
  const asked = (s.request ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  if (s.aspect_ratio) out.push(String(s.aspect_ratio));
  if (s.size) out.push(String(s.size));
  if (s.seconds) out.push(`${s.seconds} s`);
  if (s.resolution) out.push(String(s.resolution));
  if (s.audio !== undefined && (s.seconds || s.resolution)) out.push(s.audio === true || s.audio === "true" ? "with sound" : "silent");
  if (asked.voice) out.push(`voice ${String(asked.voice)}`);
  if (asked.response_format === "json") out.push("JSON");
  return out.join(" · ");
}

/**
 * A clip as its poster and one play button until someone presses it: no player chrome or loading ring before then. The
 * poster is the picture it was made from, when there is one.
 */
function Clip({ media, poster, title, onExpired }: { media: MediaRef | null; poster: string; title: string; onExpired?: () => void }) {
  const shown = useMedia(media);
  const [playing, setPlaying] = useState(false);
  if (media && (shown.state === "failed" || shown.state === "cloud_only")) return <MediaNote state={shown.state} kind="video" />;
  const ready = !!media && shown.state === "ready";
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-md border bg-black" data-testid="asset-video-frame">
      {playing && ready ? (
        <video src={shown.src} poster={poster || undefined} controls autoPlay playsInline onError={onExpired} data-testid="asset-video" className="size-full" />
      ) : (
        <>
          {poster && <img src={poster} alt="" className="absolute inset-0 size-full object-cover" />}
          <button type="button" onClick={() => setPlaying(true)} disabled={!ready} aria-label={`Play ${title}`} data-testid="asset-play"
            className="focus-ring group/play absolute inset-0 grid place-items-center disabled:cursor-default">
            <span className="grid size-12 place-items-center rounded-full bg-background/90 text-foreground shadow-sm transition-transform duration-150 group-hover/play:scale-105 group-disabled/play:opacity-70">
              <Play aria-hidden className="ml-0.5 size-5 fill-current" />
            </span>
          </button>
        </>
      )}
    </div>
  );
}

/** A tile's picture (a clip's poster) at the size the sheet shows it, or "". */
function useTilePicture(tile: AssetTile | null) {
  return usePicture(tile?.id ?? 0, tile?.thumb ?? "", tile?.thumb_blob ?? 0).src;
}

/** What the sheet shows from the tile while the item's record loads: the same picture, poster or words, from the first frame. */
function TilePreview({ tile }: { tile: AssetTile }) {
  const picture = useTilePicture(tile);
  if (tile.kind === "image") {
    return (
      <div className="grid min-h-48 place-items-center overflow-hidden rounded-md border bg-muted/40">
        {picture ? <img src={picture} alt={tile.title} className="max-h-[420px] w-auto max-w-full object-contain" /> : <Skeleton className="h-64 w-full" />}
      </div>
    );
  }
  if (tile.kind === "video") return <Clip media={null} poster={picture} title={tile.title} />;
  if (tile.kind === "text" || tile.kind === "transcript") {
    const { heading, lines } = textCard(tile.excerpt);
    return (
      <div className="flex flex-col gap-3 rounded-md border bg-muted/40 p-3 text-body leading-relaxed wrap-anywhere">
        {heading && <p className="text-heading font-medium">{heading}</p>}
        {lines && <p className="whitespace-pre-line">{lines}</p>}
      </div>
    );
  }
  return <Skeleton className="h-10 w-full rounded-md" />;
}

function Preview({ item, tile, onExpired }: { item: AssetRecord; tile: AssetTile | null; onExpired: () => void }) {
  const poster = useTilePicture(tile && tile.id === item.id ? tile : null);
  const [retried, setRetried] = useState(false);
  const expired = () => { if (!retried) { setRetried(true); onExpired(); } };
  if (item.how === "text") {
    const lines = readJson(item.body);
    if (lines?.length) {
      const { title, rest } = splitTitle(lines);
      return (
        <div data-testid="asset-text" className="flex max-h-80 flex-col gap-3 overflow-y-auto rounded-md border bg-muted/40 p-3 text-body leading-relaxed wrap-anywhere">
          {title && <p className="text-heading font-medium">{title}</p>}
          {groupByField(rest).map((g, i) => (
            <section key={i} className="flex flex-col gap-0.5">
              {g.field && <h4 className="text-caption text-muted-foreground">{fieldLabel(g.field)}</h4>}
              {g.lines.some((l) => l.item)
                ? <ul className="list-disc pl-5">{g.lines.map((l, j) => <li key={j} className="whitespace-pre-wrap">{l.text}</li>)}</ul>
                : g.lines.map((l, j) => <p key={j} className="whitespace-pre-wrap">{l.text}</p>)}
            </section>
          ))}
        </div>
      );
    }
    return (
      <div data-testid="asset-text" className="max-h-80 overflow-y-auto rounded-md border bg-muted/40 p-3 text-body leading-relaxed whitespace-pre-wrap wrap-anywhere">
        {item.body || "No words were kept for this item."}
      </div>
    );
  }
  if (item.how === "unavailable") return <div data-testid="asset-no-link"><MediaNote state="cloud_only" kind={item.kind === "image" ? "image" : item.kind === "video" ? "video" : "audio"} /></div>;
  const media = { url: item.url, blob_id: item.blob_id, mime: item.mime };
  if (item.kind === "image") {
    return (
      <div className="grid place-items-center overflow-hidden rounded-md border bg-muted/40">
        <MediaView kind="image" media={media} alt={item.prompt || item.title} onExpired={expired} testId="asset-image" className="max-h-[420px] w-auto max-w-full object-contain"
          placeholder={poster ? <img src={poster} alt="" className="max-h-[420px] w-auto max-w-full object-contain" /> : undefined} />
      </div>
    );
  }
  if (item.kind === "video") return <Clip media={media} poster={poster} title={item.title || "the clip"} onExpired={expired} />;
  return <MediaView kind="audio" media={media} onExpired={expired} testId="asset-audio" className="w-full" />;
}

function Actions({ item, onApproved, onDeleted }: { item: AssetRecord; onApproved: () => void; onDeleted: () => void }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState<"" | "approve" | "download" | "delete">("");
  const [confirming, setConfirming] = useState(false);
  const use = playgroundUse(item.kind);
  const canRun = useCan("studio.run");

  const approve = async () => {
    setBusy("approve");
    try { await libraryApi.approve(item.id); toast.success("Approved for use"); onApproved(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "It wasn't approved. Try again."); }
    finally { setBusy(""); }
  };
  const download = async () => {
    setBusy("download");
    try { const name = await downloadAsset(item.id); toast.success(`Saved ${name}`); }
    catch (e) { toast.error(e instanceof Error ? e.message : "It didn't download. Try again."); }
    finally { setBusy(""); }
  };
  const remove = async () => {
    setBusy("delete");
    try { await libraryApi.remove(item.id); toast.success(`Deleted ${item.title || "the item"}`); onDeleted(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "It wasn't deleted. Try again."); }
    finally { setBusy(""); setConfirming(false); }
  };

  const approving = item.can_approve && item.status === "draft" && !item.agent;
  const noDownload = item.how === "unavailable" ? "Downloads work on Xano cloud: this server can't link private files." : "";
  const reasonId = `asset-use-why-${item.id}`;
  // On a phone, beside Approve and Use in a new run, Download is its icon (named on hover and to a screen reader).
  const compact = approving && canRun;
  const downloadButton = (
    <Button variant="outline" size="sm" onClick={() => void download()} disabled={!!busy || !!noDownload} data-testid="asset-download"
      aria-label={compact ? "Download" : undefined} title={compact ? "Download" : undefined} className={cn(compact && "max-sm:w-8 max-sm:px-0")}>
      <Download aria-hidden /><span className={cn(compact && "max-sm:sr-only")}>{busy === "download" ? "Downloading…" : "Download"}</span>
    </Button>
  );
  const useButton = (
    <Button variant="outline" size="sm" disabled={!use.tab} data-testid="asset-use" aria-describedby={use.tab ? undefined : reasonId}
      aria-label={compact ? "Use in a new run" : undefined} onClick={() => use.tab && navigate(`/playground?kind=${use.tab}&from=${item.id}`)}>
      <FlaskConical aria-hidden />
      {compact ? <><span className="max-sm:hidden">Use in a new run</span><span aria-hidden className="sm:hidden">New run</span></> : "Use in a new run"}
    </Button>
  );

  return (
    <div className="flex flex-col gap-3">
      {item.agent && <AgentHandoff item={item} busy={busy === "approve"} onApprove={() => void approve()} />}
    {/* One line at any width: the main actions, then everything else under ••• at the right. */}
    <div className="flex min-w-0 items-center gap-2" data-testid="asset-actions">
      {approving && (
        <Button size="sm" onClick={() => void approve()} disabled={!!busy} data-testid="asset-approve"><Check aria-hidden />{busy === "approve" ? "Approving…" : "Approve for use"}</Button>
      )}
      {noDownload ? (
        <Tooltip>
          <TooltipTrigger asChild><span tabIndex={0} className="rounded-md focus-ring">{downloadButton}</span></TooltipTrigger>
          <TooltipContent>{noDownload}</TooltipContent>
        </Tooltip>
      ) : downloadButton}
      {!canRun ? null : use.tab ? useButton : (
        // A disabled button takes no pointer: the reason sits on what holds it, as a tooltip and as the button's description.
        <Tooltip>
          <TooltipTrigger asChild><span tabIndex={0} className="rounded-md focus-ring" data-testid="asset-use-why">{useButton}</span></TooltipTrigger>
          <TooltipContent>{use.words}</TooltipContent>
        </Tooltip>
      )}
      {!canRun || use.tab ? null : <span id={reasonId} className="sr-only">{use.words}</span>}
      {item.can_delete && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions" title="More actions" disabled={!!busy} data-testid="asset-more" className="ml-auto shrink-0 text-muted-foreground hover:text-foreground">
              <MoreHorizontal aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)} data-testid="asset-delete"><Trash2 aria-hidden />Delete…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{item.title || KIND_WORD[item.kind]}”?</AlertDialogTitle>
            <AlertDialogDescription>The item and its file are removed from the Library for everyone. The run that made it keeps its record. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); void remove(); }} disabled={busy === "delete"} data-testid="asset-delete-confirm">
              {busy === "delete" ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    </div>
  );
}

/**
 * An agent's work, handed to a person: who made it for whom, and, while it's a draft, Approve right there. A draft stays
 * the team's to judge; deleting it is how it's sent back.
 */
function AgentHandoff({ item, busy, onApprove }: { item: AssetRecord; busy: boolean; onApprove: () => void }) {
  const draft = item.status === "draft";
  const maker = item.maker_name || "someone";
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-agent/25 bg-agent-wash/50 p-3" data-testid="asset-agent">
      <AgentGlyph size="md" />
      <p className="min-w-48 flex-1 text-body text-pretty">
        <span className="font-medium">{item.agent} {draft ? "drafted" : "made"} this for {maker}.</span>{" "}
        <span className="text-muted-foreground">{draft ? (item.can_approve ? "Approve it for use, or delete it to send it back." : "It's a draft until someone on the team approves it.") : `Approved${item.approver_name ? ` by ${item.approver_name}` : ""}.`}</span>
      </p>
      {draft && item.can_approve && (
        <Button size="sm" onClick={onApprove} disabled={busy} data-testid="asset-approve"><Check aria-hidden />{busy ? "Approving…" : "Approve for use"}</Button>
      )}
    </div>
  );
}

/**
 * Where the item stands, beside its status in the sheet's header: for a draft, the agent that's waiting on it and who can
 * approve it; for an approved item, who approved it and when.
 */
function StandsWith({ status, agent, maker, approver, approvedAt, isPrivate }: {
  status: string; agent: string; maker: string | null; approver?: string; approvedAt?: number | null; isPrivate?: boolean;
}) {
  const waiting = isPrivate ? "Only its maker and admins see it" : agent ? "is waiting for a member or an admin to approve it" : "Waiting for a member or an admin to approve it";
  return (
    <>
      <AssetStatus status={status} />
      {status === "draft" ? (
        <span className="min-w-0 text-caption text-pretty text-muted-foreground [&>[data-slot=agent-by]]:mr-1 [&>[data-slot=agent-by]]:align-middle" data-testid="asset-waiting">
          {agent && !isPrivate && <AgentBy agent={agent} person={maker} full />}
          <span>{waiting}</span>
        </span>
      ) : approver ? (
        <span className="text-caption text-muted-foreground">by {approver}{approvedAt ? ` · ${relative(approvedAt)}` : ""}</span>
      ) : null}
    </>
  );
}

export function AssetSheet({ id, preview = null, onClose, onChanged, onPrev, onNext }: {
  id: number | null;
  /** The tile it was opened from, drawn at once while the record loads. */
  preview?: AssetTile | null;
  onClose: () => void; onChanged: () => void; onPrev?: () => void; onNext?: () => void;
}) {
  const load = useLoad(() => (id ? libraryApi.get(id) : Promise.resolve(null)), [id]);
  useLive("asset", () => { if (id) load.reload(); });
  const item = load.data && load.data.id === id ? load.data : null;
  const missing = load.error instanceof ApiError && load.error.status === 404;
  const files = item?.inputs?.files ?? [];
  const settings = item ? settingWords(item.settings) : "";
  const tile = preview && preview.id === id ? preview : null;
  // The tile stands in for the record while it loads, so the header and the picture are there from the first frame.
  const early = !item && !load.error && tile;
  const shownKind = item?.kind ?? tile?.kind;
  const shownId = item?.id ?? tile?.id;

  return (
    <RecordSheet open={id !== null} onClose={onClose} loading={!item && !load.error && !tile}
      recordId={shownId ? `${KIND_WORD[shownKind ?? ""] ?? shownKind} #${shownId}` : undefined} href={shownId ? `/library/${shownId}` : undefined}
      title={item?.title || tile?.title || (load.error ? "Not available" : "")} onPrev={onPrev} onNext={onNext}
      meta={item ? <StandsWith status={item.status} agent={item.agent} maker={item.maker_name} approver={item.approver_name} approvedAt={item.approved_at} isPrivate={item.private} />
        : tile ? <StandsWith status={tile.status} agent={tile.agent} maker={tile.maker_name} /> : undefined}>
      {early ? (
        <div className="flex flex-col gap-5" aria-busy="true">
          <TilePreview tile={tile} />
          <div className="flex gap-2"><Skeleton className="h-8 w-28" /><Skeleton className="h-8 w-36" /></div>
          <div className="flex flex-col gap-3" aria-hidden>
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="grid min-h-8 grid-cols-[minmax(6rem,auto)_1fr] items-center gap-x-4"><Skeleton className="h-4 w-20" /><Skeleton className="h-4 w-40" /></div>
            ))}
          </div>
        </div>
      ) : load.error && !item ? (
        missing
          ? <EmptyState title="That item isn't in the Library" description="It may have been deleted, or it isn't shared with you. Approved items are the ones guests can see." />
          : <LoadError title="This item didn't load" error={load.error} onRetry={load.reload} />
      ) : item && (
        <div className="flex flex-col gap-5" data-testid="asset-sheet">
          <Preview item={item} tile={tile} onExpired={load.reload} />
          <Actions item={item} onApproved={() => { load.reload(); onChanged(); }} onDeleted={() => { onChanged(); onClose(); }} />
          <Fields>
            {item.prompt && <Field label="Prompt"><span className="whitespace-pre-wrap" data-testid="asset-prompt">{item.prompt}</span></Field>}
            {item.from && (
              <Field label="Started from">
                <Link to={`/library/${item.from.id}`} className="focus-ring inline-flex h-6 items-center rounded-full border px-2 text-caption hover:bg-muted">{item.from.title || KIND_WORD[item.from.kind]}</Link>
              </Field>
            )}
            {files.length > 0 && <Field label="Inputs">{files.map((f) => f.name).join(", ")}</Field>}
            <Field label="Model"><span data-testid="asset-model">{modelName(item.model)}{settings ? <span className="text-muted-foreground"> · {settings}</span> : null}</span></Field>
            <Field label="Cost"><span data-testid="asset-cost">{spentWords(item.estimated_cost)}</span></Field>
            <Field label="Made by"><span>{item.maker_name || "Someone"} · <DateLabel value={item.created_at} />, {new Date(item.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></Field>
            {item.agent && (
              <Field label="Agent">
                <span className="inline-flex min-w-0 items-center gap-1.5" data-testid="asset-agent-row"><AgentGlyph />{agentFor(item.agent, item.maker_name, true)}{item.agent !== "Easel" ? <span className="text-muted-foreground">· with their own key</span> : null}</span>
              </Field>
            )}
            <Field label="From run">
              <span className="min-w-0">{item.run.title || "A run"}{item.run.kind === "recipe" ? " (recipe)" : ""}, step {item.step_seq || 1}</span>
            </Field>
            <Field label="Status">
              {item.status === "approved"
                ? <span>Approved{item.approver_name ? ` by ${item.approver_name}` : ""}{item.approved_at ? ` · ${relative(item.approved_at)}` : ""}</span>
                : <span className="text-muted-foreground">{item.private ? "Draft, only its maker and admins see it" : "Draft, not yet approved for use"}</span>}
            </Field>
            <Field label="Brand kit">{item.brand_applied ? "Added to the prompt" : <span className="text-muted-foreground">Not used</span>}</Field>
            <Field label="Labels">
              <span className="text-muted-foreground">AI-generated · {modelName(item.model)} · {item.status === "approved" ? "reviewed" : "not yet reviewed"}</span>
            </Field>
          </Fields>
          {item.sent_prompt && item.sent_prompt !== item.prompt && (
            <details className="rounded-md border px-3 py-2 text-caption">
              <summary className="cursor-pointer text-muted-foreground">What was sent to the model</summary>
              <p className="mt-2 whitespace-pre-wrap text-body">{item.sent_prompt}</p>
            </details>
          )}
        </div>
      )}
    </RecordSheet>
  );
}
