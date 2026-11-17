// A recipe's mark: what it makes, at a glance. One kind of step shows that kind's icon; several show each kind it makes, in
// step order, as a small cluster (copy, then a picture, then a clip), so "Product launch kit" doesn't read as "a video".
import { KIND_ICON } from "./kind-icon";
import { KIND_LABEL } from "@/lib/recipes";
import { cn } from "@/lib/utils";

/** The kinds a recipe makes, each once, in the order its steps run. Looking things up in Knowledge isn't something it makes. */
export const madeKinds = (kinds: string[]) => [...new Set(kinds.filter((k) => k !== "embedding" && k !== "rerank"))];

export function RecipeGlyph({ kinds, size = "md", className }: { kinds: string[]; size?: "sm" | "md" | "lg"; className?: string }) {
  const made = madeKinds(kinds);
  const shown = made.slice(0, 4);
  const box = size === "lg" ? "size-11" : size === "sm" ? "size-6 rounded-[5px]" : "size-9";
  const label = made.map((k) => KIND_LABEL[k] ?? k).join(", ");
  if (shown.length <= 1) {
    const Icon = KIND_ICON[shown[0] ?? "text"] ?? KIND_ICON.text;
    return (
      <span role="img" aria-label={`Makes ${label || "text"}`} title={label} className={cn("grid shrink-0 place-items-center rounded-md border bg-muted/40 text-muted-foreground", box, className)}>
        <Icon aria-hidden className={size === "lg" ? "size-5" : size === "sm" ? "size-3.5" : "size-4"} />
      </span>
    );
  }
  return (
    <span role="img" aria-label={`Makes ${label}`} title={label}
      className={cn("grid shrink-0 grid-cols-2 place-items-center gap-px rounded-md border bg-muted/40 text-muted-foreground", size === "sm" ? "p-[3px]" : "p-1", box, className)}>
      {shown.map((k) => {
        const Icon = KIND_ICON[k] ?? KIND_ICON.text;
        return <Icon key={k} aria-hidden className={size === "lg" ? "size-3.5" : size === "sm" ? "size-2" : "size-3"} />;
      })}
      {made.length > 4 && <span className="sr-only">and {made.length - 4} more</span>}
    </span>
  );
}
