// A made recording, played in place: a play button, the recording's own waveform (read from its bytes in the browser),
// the time, and a click or arrow key anywhere on the wave to jump. Where the bytes can't be read for a waveform (a link
// on another server that doesn't allow it), the wave is a plain track, so nothing drawn is made up.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Pause, Play } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useMedia, type MediaRef } from "@/lib/media";
import { clock } from "@/lib/knowledge";
import { cn } from "@/lib/utils";
import { MediaNote } from "./media-view";

const BARS = 72;

/** The loudest point in each of `bars` equal slices of the recording, 0 to 1. Null when it can't be read. */
function usePeaks(src: string, bars = BARS) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  useEffect(() => {
    setPeaks(null);
    if (!src) return;
    let live = true;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    (async () => {
      const bytes = await fetch(src).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))));
      const ctx = new Ctx();
      try {
        const audio = await ctx.decodeAudioData(bytes);
        const data = audio.getChannelData(0);
        const size = Math.max(1, Math.floor(data.length / bars));
        const out: number[] = [];
        for (let b = 0; b < bars; b++) {
          let max = 0;
          for (let i = b * size, end = Math.min(data.length, i + size); i < end; i += 16) max = Math.max(max, Math.abs(data[i]));
          out.push(max);
        }
        const top = Math.max(...out, 0.0001);
        if (live) setPeaks(out.map((v) => Math.max(0.06, v / top)));
      } finally { void ctx.close(); }
    })().catch(() => { /* no waveform: the track stays plain */ });
    return () => { live = false; };
  }, [src, bars]);
  return peaks;
}

export function AudioPlayer({ media, className, testId, label = "Recording" }: { media: MediaRef; className?: string; testId?: string; label?: string }) {
  const shown = useMedia(media);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [at, setAt] = useState(0);
  const [length, setLength] = useState(0);
  const peaks = usePeaks(shown.state === "ready" ? shown.src : "");
  const flat = useMemo(() => Array.from({ length: BARS }, () => 0.14), []);
  if (shown.state === "loading") return <Skeleton aria-label="Loading" className={cn("h-16 w-full rounded-md", className)} />;
  if (shown.state !== "ready") return <MediaNote state={shown.state === "failed" ? "failed" : shown.state} kind="audio" className={className} />;

  const share = length ? Math.min(1, at / length) : 0;
  const seekTo = (s: number) => { const a = audio.current; if (a && length) { a.currentTime = Math.max(0, Math.min(length, s)); setAt(a.currentTime); } };
  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    seekTo(((e.clientX - r.left) / r.width) * length);
  };
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 5, ArrowLeft: -5, PageUp: 15, PageDown: -15 }[e.key];
    if (step) { e.preventDefault(); seekTo(at + step); }
    if (e.key === "Home") { e.preventDefault(); seekTo(0); }
    if (e.key === "End") { e.preventDefault(); seekTo(length); }
  };
  const toggle = () => { const a = audio.current; if (!a) return; if (a.paused) void a.play(); else a.pause(); };
  const bars = peaks ?? flat;
  return (
    <div className={cn("flex min-w-0 items-center gap-3 rounded-md border bg-background px-3 py-2.5", className)} data-testid="audio-player">
      <audio ref={audio} src={shown.src} preload="metadata" data-testid={testId} className="hidden"
        onLoadedMetadata={(e) => setLength(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
        onTimeUpdate={(e) => setAt(e.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} />
      <button type="button" onClick={toggle} aria-label={playing ? `Pause ${label}` : `Play ${label}`}
        className="focus-ring grid size-9 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90">
        {playing ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="ml-0.5 size-4" />}
      </button>
      <div role="slider" tabIndex={0} aria-label={`Position in ${label}`} aria-valuemin={0} aria-valuemax={Math.round(length)} aria-valuenow={Math.round(at)}
        aria-valuetext={`${clock(at)} of ${clock(length)}`} onPointerDown={fromPointer} onKeyDown={keys}
        className="focus-ring relative flex h-10 min-w-0 flex-1 cursor-pointer items-center gap-px rounded-sm">
        {bars.map((p, i) => (
          <span key={i} aria-hidden className={cn("min-w-px flex-1 rounded-full transition-colors duration-150", (i + 0.5) / bars.length <= share ? "bg-foreground" : "bg-muted-foreground/35")}
            style={{ height: `${Math.round(p * 100)}%` }} />
        ))}
      </div>
      <span className="w-[5.5rem] shrink-0 text-right text-caption text-muted-foreground tabular-nums">{clock(at)} / {clock(length)}</span>
    </div>
  );
}
