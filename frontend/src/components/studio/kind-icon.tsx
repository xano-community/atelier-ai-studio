// The one icon for each kind of AI step, so a recipe, a run and the Playground's history look alike.
import { AudioLines, BookOpen, FileText, Film, Image as ImageIcon, Music, Type, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export const KIND_ICON: Record<string, LucideIcon> = {
  text: Type, image: ImageIcon, video: Film, speech: AudioLines, music: Music, transcribe: FileText, embedding: BookOpen, rerank: BookOpen,
};

/** A kind's icon on a small square tile, as a recipe row leads with it. */
export function KindTile({ kind, className }: { kind: string; className?: string }) {
  const Icon = KIND_ICON[kind] ?? Type;
  return (
    <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-md border bg-muted/40 text-muted-foreground", className)}>
      <Icon className="size-4" />
    </span>
  );
}
