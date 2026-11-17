// /knowledge/sources: every document and recording the team added, newest first, with where each stands. A source opens
// beside the list with its passages (page, or moment and speaker) and, when it failed, why and how to add it. A drop
// anywhere on the page adds files, for people who may add them.
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { useSearchParams } from "react-router";
import { BookOpen, RotateCw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Ago, DataList, EmptyState, Field, Fields, LoadError, PageHeader, RecordSheet, useLoad, useOpenParam, type Column } from "@/components/kit";
import { AiOffNotice } from "@/components/studio/ai-status";
import { useLive } from "@/base/live";
import { useMe } from "@/base/session";
import { useWorkspace } from "@/base/workspace";
import { clock, knowledgeApi, sizeOf, type Source } from "@/lib/knowledge";
import { Prose } from "@/components/studio/prose";
import { AddButton, KnowledgeTabs, PlayFrom, SourceIcon, SourceStatus, TEAM_WIDE, UploadRows, aboutSource, useAddSources, useSources } from "./parts";

export function KnowledgeSourcesPage() {
  const list = useSources();
  const adder = useAddSources(list.reload);
  const { nameOf } = useWorkspace();
  const [openId, open, close] = useOpenParam();
  const [params, setParams] = useSearchParams();
  const rows = list.data?.items ?? null;
  const current = rows?.find((s) => String(s.id) === openId) ?? null;
  const [over, setOver] = useState(false);

  // ⌘K "Add a source" lands here with ?add=1: open the picker once.
  useEffect(() => {
    if (params.get("add") !== "1" || !adder.canAdd) return;
    setParams((p) => { const n = new URLSearchParams(p); n.delete("add"); return n; }, { replace: true });
    adder.pick();
  }, [params, adder, setParams]);

  const counts = useMemo(() => {
    const all = rows ?? [];
    return { ready: all.filter((s) => s.status === "ready").length, processing: all.filter((s) => s.status === "processing").length, failed: all.filter((s) => s.status === "failed").length };
  }, [rows]);

  const columns = useMemo<Column<Source>[]>(() => [
    { id: "title", header: "Source", primary: true, title: (s) => s.title, cell: (s) => (
      <span className="flex min-w-0 items-center gap-2.5"><SourceIcon source={s} /><span className="truncate font-medium">{s.title}</span></span>
    ) },
    { id: "about", header: "Type", className: "w-40", cell: (s) => <span className="truncate text-muted-foreground">{aboutSource(s)}</span> },
    { id: "status", header: "Status", className: "w-44", cell: (s) => <SourceStatus source={s} /> },
    { id: "passages", header: "Passages", className: "w-24", align: "right", hideBelow: "xl", cell: (s) => <span className="text-muted-foreground tabular-nums">{s.status === "ready" ? s.passages : "—"}</span> },
    { id: "by", header: "Added by", className: "w-36", hideBelow: "xl", cell: (s) => <span className="truncate text-muted-foreground">{nameOf(s.added_by)}</span> },
    { id: "added", header: "Added", className: "w-28", cell: (s) => <span className="truncate text-muted-foreground"><Ago value={s.created_at} /></span> },
  ], [nameOf]);

  const take = (e: DragEvent) => { if (!adder.canAdd || adder.aiOff || ![...e.dataTransfer.types].includes("Files")) return false; e.preventDefault(); return true; };

  return (
    <div className="relative flex flex-col gap-5" data-testid="knowledge-sources"
      onDragOver={(e) => { if (take(e)) setOver(true); }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => { if (!take(e)) return; setOver(false); adder.add([...e.dataTransfer.files]); }}>
      <PageHeader title="Knowledge" description="The team's brand and reference material. Each source is read once, split into passages and embedded, so Ask can cite it."
        actions={<AddButton adder={adder} label="Add a source" />}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <KnowledgeTabs value="sources" />
          {rows && rows.length > 0 && (
            <p className="text-caption text-muted-foreground tabular-nums">
              {counts.ready} ready{counts.processing ? ` · ${counts.processing} processing` : ""}{counts.failed ? ` · ${counts.failed} couldn't be read` : ""}
            </p>
          )}
        </div>
      </PageHeader>
      <AiOffNotice after="Adding a source needs AI to read it." />
      <UploadRows adder={adder} />
      <DataList label="Sources" rows={rows} error={list.error} onRetry={list.reload} columns={columns} rowKey={(s) => s.id} busy={list.loading && !!rows}
        onOpen={(s) => open(s.id)} activeKey={current?.id ?? null} pageSize={25}
        mobileRow={(s) => (
          <span className="flex min-w-0 items-center gap-3">
            <SourceIcon source={s} />
            <span className="flex min-w-0 flex-1 flex-col"><span className="truncate font-medium">{s.title}</span><span className="truncate text-caption text-muted-foreground">{aboutSource(s)} · <Ago value={s.created_at} /></span></span>
            <SourceStatus source={s} />
          </span>
        )}
        empty={<EmptyState icon={BookOpen} title="No sources yet"
          description={adder.canAdd ? "Add a brand guide, a product spec or a recorded call. PDFs, text and Markdown, and audio." : "Nobody has added a source yet. Members and admins can add them."}
          action={adder.canAdd ? <Button size="sm" onClick={adder.pick} disabled={adder.aiOff} title={adder.aiOff ? "Adding a source is off until AI is on: reading it needs AI." : undefined}><Upload />Add a source</Button> : undefined} />} />
      <p className="text-caption text-pretty text-muted-foreground">{TEAM_WIDE}</p>
      <SourceSheet source={current} onClose={close} onRemoved={() => { close(); list.reload(); }} onChanged={list.reload} canRemove={adder.canAdd} addedBy={current ? nameOf(current.added_by) : ""} />
      {over && (
        <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-lg border-2 border-dashed border-foreground/30 bg-background/85">
          <p className="flex items-center gap-2 text-body font-medium"><Upload aria-hidden className="size-4" />Drop to add to Knowledge</p>
        </div>
      )}
    </div>
  );
}

function SourceSheet({ source, onClose, onRemoved, onChanged, canRemove, addedBy }: { source: Source | null; onClose: () => void; onRemoved: () => void; onChanged: () => void; canRemove: boolean; addedBy: string }) {
  const detail = useLoad(() => (source ? knowledgeApi.source(source.id) : Promise.resolve(null)), [source?.id, source?.status]);
  useLive("kb_source", detail.reload);
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const remove = async () => {
    if (!source) return;
    setRemoving(true);
    try { await knowledgeApi.remove(source.id); toast.success(`Removed ${source.title}`); onRemoved(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "That didn't remove. Try again."); }
    finally { setRemoving(false); setConfirming(false); }
  };
  const confirmRun = async () => {
    if (!source?.run_id) return;
    try { await knowledgeApi.confirm(source.run_id); toast.success("Confirmed. It's being read now."); detail.reload(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "That didn't confirm. Try again."); }
  };
  // One key per failure: a double click, or a retry of a request that did arrive, retries once.
  const retryKey = useMemo(() => `${source?.id}-${source?.status}-${Date.now()}`, [source?.id, source?.status]);
  const [retrying, setRetrying] = useState(false);
  const me = useMe();
  const retry = async () => {
    if (!source) return;
    setRetrying(true);
    try { await knowledgeApi.retry(source.id, retryKey); toast.success("Retrying. It'll be ready in a moment."); onChanged(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "That didn't retry. Try again."); }
    finally { setRetrying(false); }
  };
  const passages = detail.data?.passages ?? [];
  return (
    <RecordSheet open={!!source} onClose={onClose} title={source?.title ?? ""} meta={source ? <SourceStatus source={source} /> : undefined}
      actions={source && canRemove && source.status !== "processing" ? (
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)} data-testid="remove-source"><Trash2 />Remove from Knowledge</Button>
      ) : undefined}>
      {source && (
        <div className="flex flex-col gap-5">
          {source.status === "failed" && (
            <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-body text-pretty">
              <span className="font-medium">{source.can_retry ? "It's not finished." : "It couldn't be read."}</span> {source.detail}
              {source.can_retry && (source.added_by === me.id
                ? <div className="mt-2"><Button size="sm" variant="outline" disabled={retrying} onClick={retry} data-testid="retry-source"><RotateCw />Retry</Button></div>
                : <p className="mt-1 text-muted-foreground">The person who added it can retry it.</p>)}
            </div>
          )}
          {source.status === "processing" && source.progress?.run_status === "needs_confirmation" && (
            <div className="flex flex-wrap items-center gap-3 rounded-md border bg-card p-3 text-body">
              <span className="min-w-0 flex-1 text-pretty">{source.detail || "Reading it costs more than the approval line. Confirm it to start."}</span>
              <Button size="sm" onClick={confirmRun}>Confirm and read it</Button>
            </div>
          )}
          {source.status === "processing" && source.progress?.run_status !== "needs_confirmation" && source.detail && (
            <p className="rounded-md border bg-card p-3 text-body text-pretty text-muted-foreground">{source.detail}</p>
          )}
          <Fields>
            <Field label="Type">{aboutSource(source)}</Field>
            <Field label="File"><span className="truncate">{source.file_name}</span><span className="text-muted-foreground">{sizeOf(source.size)}</span></Field>
            <Field label="Added by">{addedBy}, <Ago value={source.created_at} /></Field>
            {source.status === "ready" && <Field label="Passages">{source.passages}</Field>}
          </Fields>
          {source.status === "ready" && (
            <section aria-label="Passages" className="flex flex-col gap-2">
              <h2 className="text-caption font-medium text-muted-foreground">Passages</h2>
              {detail.error ? <LoadError error={detail.error} onRetry={detail.reload} />
                : !detail.data ? Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-16 w-full" />)
                : (
                  <ol className="divide-y overflow-hidden rounded-md border bg-card">
                    {passages.map((p, i) => (
                      <li key={p.id} className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2.5 px-3 py-2.5">
                        <span className="pt-0.5 text-caption text-muted-foreground tabular-nums">{i + 1}</span>
                        <div className="grid min-w-0 gap-1.5">
                          {(p.page > 0 || p.start_s >= 0 || p.speaker) && (
                            <div className="flex min-h-6 flex-wrap items-center gap-x-2 text-caption text-muted-foreground tabular-nums">
                              {p.page > 0 && <span>Page {p.page}</span>}
                              {p.start_s >= 0 && <span>{clock(p.start_s)}</span>}
                              {p.speaker && <span>{p.speaker}</span>}
                              {p.start_s >= 0 && source.has_audio && <span className="ml-auto"><PlayFrom sourceId={source.id} start={p.start_s} label={`Play from ${clock(p.start_s)}`} /></span>}
                            </div>
                          )}
                          <Prose compact text={p.text} className="text-body leading-relaxed" />
                        </div>
                      </li>
                    ))}
                    {source.passages > passages.length && <li className="px-3 py-2 text-caption text-muted-foreground">And {source.passages - passages.length} more.</li>}
                  </ol>
                )}
            </section>
          )}
        </div>
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {source?.title} from Knowledge?</AlertDialogTitle>
            <AlertDialogDescription>Ask stops citing it at once, for everyone. To add it back, upload the file again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction disabled={removing} onClick={(e) => { e.preventDefault(); void remove(); }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </RecordSheet>
  );
}
