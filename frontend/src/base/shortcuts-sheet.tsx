// The "?" sheet: every shortcut, the shell's and the domain's. Loaded the first time someone asks for it.
import { useMemo } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { modKey } from "@/components/kit";
import type { GoKey } from "./shortcuts";

const Kbd = ({ children }: { children: string }) => <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1.5 font-mono text-micro text-muted-foreground">{children}</kbd>;

export default function ShortcutsSheet({ open, setOpen, go, actions }: { open: boolean; setOpen: (open: boolean) => void; go: GoKey[]; actions: [string, string][] }) {
  const rows = useMemo<[string, string][]>(() => [
    [modKey("K"), "Search, jump anywhere, run an action"],
    ["/", "Search the list you're on"],
    ["?", "These shortcuts"],
    ...actions,
    ...go.map((g): [string, string] => [`G then ${g.key.toUpperCase()}`, `Go to ${g.label}`]),
  ], [go, actions]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Focus lands on the sheet itself: the list scrolls with the arrow keys, and no ring flashes round it on open. */}
      <DialogContent className="max-w-md" data-kit="shortcuts" onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).focus(); }}>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Single keys work anywhere except while you're typing.</DialogDescription>
        </DialogHeader>
        <dl tabIndex={0} aria-label="Shortcuts" className="focus-ring-inset -mx-1 max-h-[60vh] divide-y overflow-y-auto px-1 text-body">
          {rows.map(([k, what]) => (
            <div key={k + what} className="flex min-h-9 items-center justify-between gap-4 py-1.5">
              <dt className="text-muted-foreground">{what}</dt>
              <dd className="flex shrink-0 items-center gap-1">{k.split(" then ").map((p, i) => <span key={`${i}-${p}`} className="flex items-center gap-1">{i > 0 && <span className="text-caption text-muted-foreground">then</span>}<Kbd>{p}</Kbd></span>)}</dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  );
}
