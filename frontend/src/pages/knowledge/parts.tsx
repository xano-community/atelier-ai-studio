// What both Knowledge screens share: the Ask / Sources switch, the source list's data, a source's icon and status,
// and adding files. Adding is one row per file: its progress, then its source in the list; a refusal stays on its
// row with the server's words and a way out. Nothing here decides who may add: the server does.
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { AudioLines, FileText, Play, RotateCw, Upload, X } from "lucide-react";
import { useCan } from "@xano-sdk/rbac/react";
import { Button } from "@/components/ui/button";
import { Segmented, useLoad } from "@/components/kit";
import { StatusBadge } from "@/components/kit";
import { useLive } from "@/base/live";
import { ApiError } from "@/base/request";
import { ACCEPT, knowledgeApi, uploadSource, type Source } from "@/lib/knowledge";
import { cn } from "@/lib/utils";
import { useAiState } from "@/components/studio/ai-status";
import { fetchMedia } from "@/lib/media";

export function KnowledgeTabs({ value }: { value: "ask" | "sources" }) {
  const navigate = useNavigate();
  return (
    <Segmented label="Knowledge" value={value} onChange={(v) => navigate(v === "ask" ? "/knowledge" : "/knowledge/sources")}
      options={[{ value: "ask", label: "Ask", testId: "tab-ask" }, { value: "sources", label: "Sources", testId: "tab-sources" }]} />
  );
}

/** Every source, kept fresh: live when one is added or settles, and every few seconds while one is processing. */
export function useSources() {
  const list = useLoad(() => knowledgeApi.sources(), []);
  useLive("kb_source", list.reload);
  const busy = (list.data?.items ?? []).some((s) => s.status === "processing");
  const reload = list.reload;
  useEffect(() => {
    if (!busy) return;
    const i = setInterval(() => document.visibilityState === "visible" && reload(), 4000);
    return () => clearInterval(i);
  }, [busy, reload]);
  return list;
}

export function SourceIcon({ source, className }: { source: Pick<Source, "kind">; className?: string }) {
  const Icon = source.kind === "recording" ? AudioLines : FileText;
  return <Icon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", className)} />;
}

/** What it's doing while it's processing, in words: "Reading 2 of 8", "Waiting for an admin". */
export const processingWords = (s: Source) => {
  const p = s.progress;
  if (p?.run_status === "waiting_approval") return "Waiting for an admin";
  if (p?.run_status === "needs_confirmation" || p?.run_status === "waiting_confirmation") return "Needs your confirmation";
  if (s.kind === "recording") return p && p.done > 0 ? "Embedding" : "Transcribing";
  if (p && p.total > 1) return `Reading ${Math.min(p.done + 1, p.total)} of ${p.total}`;
  return "Reading";
};

export function SourceStatus({ source }: { source: Source }) {
  if (source.status === "ready") return <StatusBadge tone="success" dot>Ready</StatusBadge>;
  if (source.status === "failed" && source.can_retry) return <StatusBadge tone="warning" dot>Needs a retry</StatusBadge>;
  if (source.status === "failed") return <StatusBadge tone="danger" dot>Couldn't read</StatusBadge>;
  const waiting = source.progress?.run_status && source.progress.run_status !== "queued" && source.progress.run_status !== "running";
  return (
    <StatusBadge tone={waiting ? "warning" : "neutral"}>
      {!waiting && <span aria-hidden className="size-2.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />}
      {processingWords(source)}
    </StatusBadge>
  );
}

/** "PDF · 12 pages", "Recording · 38 min", "Markdown". */
export const aboutSource = (s: Source) => {
  const kind = { pdf: "PDF", text: "Text", markdown: "Markdown", audio: "Recording" }[s.format];
  if (s.format === "audio" && s.duration_s > 0) return `${kind} · ${s.duration_s < 60 ? `${s.duration_s} s` : `${Math.round(s.duration_s / 60)} min`}`;
  if (s.format === "pdf" && s.pages > 0) return `${kind} · ${s.pages} ${s.pages === 1 ? "page" : "pages"}`;
  return kind;
};

type Upload = { key: string; file: File; state: "uploading" | "failed" | "refused"; share: number; reason: string };
const keyOf = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * Adding files: `pick()` opens the picker, `add(files)` takes a drop. Each file uploads with its own key, so a retry
 * after a dropped connection adds it once. A finished upload leaves its row, since its source is in the list now.
 */
export function useAddSources(onAdded: () => void) {
  const canAdd = useCan("knowledge.manage");
  // Reading a source is AI work: while AI is off, adding one is too.
  const { state: ai } = useAiState();
  const aiOff = !!ai && ai.ai_status !== "on";
  const [uploads, setUploads] = useState<Upload[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const aborts = useRef(new Map<string, AbortController>());
  const patch = (key: string, p: Partial<Upload>) => setUploads((all) => all.map((u) => (u.key === key ? { ...u, ...p } : u)));
  const send = useCallback((u: Upload) => {
    const abort = new AbortController();
    aborts.current.set(u.key, abort);
    uploadSource(u.file, u.key, (share) => patch(u.key, { share }), abort.signal).then(
      () => { setUploads((all) => all.filter((x) => x.key !== u.key)); onAdded(); },
      (e: unknown) => {
        if (e instanceof ApiError && e.status === -1) { setUploads((all) => all.filter((x) => x.key !== u.key)); return; }
        const refused = e instanceof ApiError && e.status >= 400 && e.status < 500;
        patch(u.key, { state: refused ? "refused" : "failed", reason: e instanceof Error ? e.message : "That didn't upload. Retry it." });
      },
    ).finally(() => aborts.current.delete(u.key));
  }, [onAdded]);
  const add = useCallback((files: File[]) => {
    const fresh = files.map((file): Upload => ({ key: keyOf(), file, state: "uploading", share: 0, reason: "" }));
    setUploads((all) => [...fresh, ...all]);
    fresh.forEach(send);
  }, [send]);
  const retry = (key: string) => { const u = uploads.find((x) => x.key === key); if (u) { patch(key, { state: "uploading", share: 0, reason: "" }); send({ ...u, state: "uploading" }); } };
  const dismiss = (key: string) => { aborts.current.get(key)?.abort(); setUploads((all) => all.filter((x) => x.key !== key)); };
  const picker = <input ref={input} type="file" multiple accept={ACCEPT} hidden data-testid="source-input" onChange={(e) => { const picked = [...(e.target.files ?? [])]; e.target.value = ""; if (picked.length) add(picked); }} />;
  return { canAdd, aiOff, uploads, add, pick: () => input.current?.click(), picker, retry, dismiss };
}

export function AddButton({ adder, size = "sm", label = "Add" }: { adder: ReturnType<typeof useAddSources>; size?: "sm" | "xs"; label?: string }) {
  if (!adder.canAdd) return null;
  return <>{adder.picker}<Button size={size} variant="outline" data-testid="add-source" onClick={adder.pick} disabled={adder.aiOff}
    title={adder.aiOff ? "Adding a source is off until AI is on: reading it needs AI." : undefined}><Upload />{label}</Button></>;
}

/** One row per file going up, or refused, with the reason and a way out. */
export function UploadRows({ adder, className }: { adder: ReturnType<typeof useAddSources>; className?: string }) {
  if (!adder.uploads.length) return null;
  return (
    <ul aria-label="Uploads" className={cn("flex flex-col gap-1", className)}>
      {adder.uploads.map((u) => {
        const pct = Math.round(u.share * 100);
        const bad = u.state !== "uploading";
        return (
          <li key={u.key} data-testid="upload-row" data-state={u.state} className={cn("flex min-w-0 items-center gap-2 rounded-md border bg-card px-2.5 py-1.5", bad && "border-destructive/40 bg-destructive/5")}>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-caption font-medium">{u.file.name}</span>
                {!bad && <span className="shrink-0 text-micro text-muted-foreground tabular-nums">{pct < 100 ? `${pct}%` : "Starting"}</span>}
              </span>
              {!bad && <span role="progressbar" aria-label={`Uploading ${u.file.name}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} className="block h-0.5 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-foreground/60 transition-[width] duration-150" style={{ width: `${pct}%` }} /></span>}
              {bad && <span role="alert" className="text-caption text-pretty text-muted-foreground"><span className="font-medium text-foreground">{u.state === "refused" ? "Not added." : "Didn't upload."}</span> {u.reason}</span>}
            </span>
            {u.state === "failed" && <Button size="xs" variant="outline" onClick={() => adder.retry(u.key)} className="max-md:min-h-11"><RotateCw />Retry</Button>}
            <Button size="icon-xs" variant="ghost" aria-label={bad ? `Dismiss ${u.file.name}` : `Cancel ${u.file.name}`} onClick={() => adder.dismiss(u.key)} className="text-muted-foreground max-md:size-11"><X /></Button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Play from here": asks how the recording plays now (a short-lived link, or its table-kept bytes on a server that can't
 * sign links, lib/media.ts) and plays it from `start` seconds, in a player that stays where the button was.
 */
export function PlayFrom({ sourceId, start, label = "Play from here", size = "xs" }: { sourceId: number; start: number; label?: string; size?: "xs" | "sm" }) {
  const [state, setState] = useState<{ url: string; error: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const load = async () => {
    setLoading(true);
    try {
      const r = await knowledgeApi.audio(sourceId);
      const url = r.blob_id ? URL.createObjectURL(await fetchMedia(r.blob_id, r.mime)) : r.url;
      setState(url ? { url, error: "" } : { url: "", error: "Playback works once the app runs on Xano cloud: this server can't make private playback links." });
    } catch (e) {
      setState({ url: "", error: e instanceof Error ? e.message : "The recording didn't load. Try again." });
    } finally { setLoading(false); }
  };
  useEffect(() => () => { if (state?.url.startsWith("blob:")) URL.revokeObjectURL(state.url); }, [state?.url]);
  if (state?.url) {
    return (
      <audio ref={audio} controls autoPlay src={state.url.startsWith("blob:") ? state.url : `${state.url}#t=${Math.max(0, start)}`} data-testid="citation-player" className="h-8 w-full max-w-sm"
        onLoadedMetadata={() => { if (audio.current && audio.current.currentTime < start - 1) audio.current.currentTime = start; }}>
        Your browser can't play this recording.
      </audio>
    );
  }
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
      <Button size={size} variant="ghost" data-testid="play-from" disabled={loading} onClick={load} className="max-md:min-h-11">
        {loading ? <span aria-hidden className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" /> : <Play />}{label}
      </Button>
      {state?.error && <span role="status" className="text-caption text-pretty text-muted-foreground">{state.error}</span>}
    </span>
  );
}

export const TEAM_WIDE ="Everyone on the team can see every source. For document-level permissions, use the Company knowledge base template.";
