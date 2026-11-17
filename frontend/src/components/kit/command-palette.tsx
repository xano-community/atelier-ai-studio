import { Suspense, lazy, memo, useEffect, useRef, useState } from "react";
import { Search, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { modKey } from "./shortcuts";

export interface PaletteItem {
  id: string;
  label: string;
  /** "Go to", "Actions", "Notes"… Items show grouped in the order their groups first appear. */
  group: string;
  icon?: LucideIcon;
  /** Context beside the label: a status, an owner, a date. */
  hint?: string;
  /** A second line: the words around what matched. */
  detail?: string;
  keywords?: string[];
  shortcut?: string;
  run: () => void;
}

// The palette is mounted with the shell and shown by the browser's own modal <dialog>, which brings the focus trap, the
// inert page, Escape and focus return. Opening it runs no React at all: ⌘K has a 50 ms budget at 4x throttle, and
// rendering a Radix dialog and its list on the key press spent most of it. Its rows arrive just after the first paint:
// nobody can press ⌘K before that, so they stay out of the shell and are already rendered and waiting when the key comes.
// While it is closed, the rows wait: the shell re-renders on every navigation, and re-rendering a hidden list each time would
// spend the navigation budget. Each close remounts them (the session key), so the next open has the current items.
const PaletteBody = memo(lazy(() => import("./palette-body")), (prev, next) => !isCommandPaletteOpen() && sameIds(prev.items, next.items) && prev.search === next.search && prev.placeholder === next.placeholder);
const sameIds = (a: PaletteItem[], b: PaletteItem[]) => a.length === b.length && a.every((it, i) => it.id === b[i].id && it.label === b[i].label);
let dialog: HTMLDialogElement | null = null;
let input: HTMLInputElement | null = null;

export const isCommandPaletteOpen = () => !!dialog?.open;
/** Open the palette from anywhere (a header button, a first-run step). */
export function openCommandPalette() {
  if (!dialog || dialog.open) return;
  dialog.showModal();
  input?.focus();
}
export const closeCommandPalette = () => dialog?.close();
export const toggleCommandPalette = () => (isCommandPaletteOpen() ? closeCommandPalette() : openCommandPalette());
/** The rows say where their input is. One that arrives after a very fast ⌘K takes the focus it missed. */
export function setPaletteInput(el: HTMLInputElement | null) {
  input = el;
  if (el && dialog?.open) el.focus();
}

/**
 * ⌘K / Ctrl K: jump to any screen, run an action, or find a record. `items` are the static ones (nav,
 * actions); `search` finds records as the person types (debounced, newest answer wins).
 */
export function CommandPalette({ items, search, placeholder = "Search or jump to…" }: {
  items: PaletteItem[]; search?: (q: string) => Promise<PaletteItem[]>; placeholder?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Each close starts the body again, so the next open is at the top with nothing typed.
  const [session, setSession] = useState(0);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    dialog = ref.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "k" || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      toggleCommandPalette();
    };
    window.addEventListener("keydown", onKey);
    const t = setTimeout(() => setReady(true), 0);
    return () => { dialog = null; window.removeEventListener("keydown", onKey); clearTimeout(t); };
  }, []);
  return (
    <dialog ref={ref} aria-label="Search" data-kit="palette-dialog"
      onClose={() => setSession((n) => n + 1)}
      onClick={(e) => { if (e.target === e.currentTarget) closeCommandPalette(); }}
      className="top-[12svh] mx-auto w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-lg border bg-popover p-0 text-popover-foreground shadow-lg backdrop:bg-black/40">
      {ready && <Suspense fallback={null}><PaletteBody key={session} items={items} search={search} placeholder={placeholder} /></Suspense>}
    </dialog>
  );
}

/** The header's search button: opens the palette, and says how to open it from the keyboard. */
export function PaletteButton({ className, label = "Search" }: { className?: string; label?: string }) {
  return (
    <button type="button" onClick={openCommandPalette} data-kit="palette-button"
      className={cn("inline-flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-2.5 text-body text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-ring sm:w-64 sm:flex-none", className)}>
      <Search aria-hidden className="size-4 shrink-0" />
      <span className="truncate">{label}…</span>
      <kbd className="ml-auto hidden h-5 items-center rounded border bg-muted/60 px-1.5 font-mono text-micro sm:inline-flex">{modKey("K")}</kbd>
      <span className="sr-only">Open search ({modKey("K")})</span>
    </button>
  );
}
