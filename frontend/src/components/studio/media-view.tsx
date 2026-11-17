// A made picture, clip or recording, shown however this server keeps it (lib/media.ts): from its link, from its table-kept
// bytes, or, where neither works, a plain note that it plays on Xano cloud. Every screen that shows a made file uses this.
import { forwardRef, type ReactNode } from "react";
import { ImageIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useMedia, type MediaRef } from "@/lib/media";
import { cn } from "@/lib/utils";

type Kind = "image" | "video" | "audio";

/** Where the file can't be shown here, or didn't load: what happened, and the next step. */
export function MediaNote({ state, kind, className }: { state: "cloud_only" | "failed" | "none"; kind: Kind; className?: string }) {
  const word = kind === "image" ? "picture" : kind === "video" ? "clip" : "recording";
  return (
    <div data-testid="media-note" data-state={state} className={cn("flex flex-col items-center gap-1.5 rounded-md border border-dashed bg-muted/40 px-4 py-6 text-center", className)}>
      <ImageIcon aria-hidden className="size-5 text-muted-foreground" />
      <p className="font-medium">{state === "failed" ? `The ${word} didn't load` : "Preview works on Xano cloud"}</p>
      <p className="max-w-sm text-pretty text-caption text-muted-foreground">
        {state === "failed" ? "Reload the page to try again." : state === "none" ? `No ${word} was kept for this step.` : `This server can't make private file links, so the ${word} shows once the app runs on Xano cloud. Its record is still here.`}
      </p>
    </div>
  );
}

export const MediaView = forwardRef<HTMLMediaElement | HTMLImageElement, {
  kind: Kind; media: MediaRef | null | undefined; alt?: string; className?: string; onExpired?: () => void; testId?: string;
  /** Shown while a table-kept file loads. */ placeholder?: ReactNode;
}>(function MediaView({ kind, media, alt = "", className, onExpired, testId, placeholder }, ref) {
  const shown = useMedia(media);
  if (shown.state === "loading") return <>{placeholder ?? <Skeleton aria-label="Loading" className={cn("h-48 w-full rounded-md", kind === "audio" && "h-10")} />}</>;
  if (shown.state !== "ready") return <MediaNote state={shown.state === "failed" ? "failed" : shown.state} kind={kind} />;
  const fromLink = !media?.blob_id;
  const expired = fromLink ? onExpired : undefined;
  if (kind === "image") return <img ref={ref as React.Ref<HTMLImageElement>} src={shown.src} alt={alt} onError={expired} data-testid={testId} className={className} />;
  // Black behind a clip while it loads, so the sheet never flashes white in dark mode.
  if (kind === "video") return <video ref={ref as React.Ref<HTMLVideoElement>} src={shown.src} controls playsInline preload="metadata" onError={expired} data-testid={testId} className={cn("bg-black", className)} />;
  return <audio ref={ref as React.Ref<HTMLAudioElement>} src={shown.src} controls preload="metadata" onError={expired} data-testid={testId} className={className} />;
});
