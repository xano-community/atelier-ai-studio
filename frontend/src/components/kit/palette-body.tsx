import { useEffect, useMemo, useRef, useState } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command";
import { closeCommandPalette, setPaletteInput, type PaletteItem } from "./command-palette";

const WAIT_MS = 150;
const SHORTEST = 2;

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/** The typed words in `text`, set in the foreground so the eye finds why a record matched. */
function Marked({ text, q }: { text: string; q: string }) {
  const wanted = words(q);
  if (!wanted.length) return <>{text}</>;
  const parts = text.split(new RegExp(`(${wanted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi")).filter(Boolean);
  return <>{parts.map((p, i) => (wanted.includes(p.toLowerCase()) ? <span key={i} className="font-medium text-foreground">{p}</span> : p))}</>;
}

/**
 * The palette's input and rows. It starts again on each close, so the next open is at the top with nothing typed. cmdk
 * filters the static items; records found on the server always match what was typed.
 */
export default function PaletteBody({ items, search, placeholder }: {
  items: PaletteItem[]; search?: (q: string) => Promise<PaletteItem[]>; placeholder: string;
}) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<PaletteItem[]>([]);
  // A record search is in flight: say so, never "No matches" before the answer is in.
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setPaletteInput(inputRef.current); return () => setPaletteInput(null); }, []);

  const wanted = q.trim();
  useEffect(() => {
    setFailed(false);
    if (!search || wanted.length < SHORTEST) { setFound([]); setSearching(false); return; }
    let live = true;
    setSearching(true);
    const t = setTimeout(() => {
      search(wanted).then(
        (r) => { if (live) { setFound(r); setSearching(false); } },
        () => { if (live) { setFound([]); setFailed(true); setSearching(false); } },
      );
    }, WAIT_MS);
    return () => { live = false; clearTimeout(t); };
  }, [wanted, search, attempt]);

  const groups = useMemo(() => {
    const all = [...items, ...found.map((f) => ({ ...f, keywords: [...(f.keywords ?? []), q] }))];
    const m = new Map<string, PaletteItem[]>();
    for (const it of all) m.set(it.group, [...(m.get(it.group) ?? []), it]);
    return [...m.entries()];
  }, [items, found, q]);

  return (
    <Command className="**:data-[slot=command-input-wrapper]:h-11 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-item]]:min-h-9 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1.5">
      <CommandInput ref={inputRef} placeholder={placeholder} value={q} onValueChange={setQ} data-kit="command-input" />
      <CommandList data-kit="command-palette" className="max-h-[min(24rem,60svh)]">
        {!searching && !failed && <CommandEmpty>Nothing matches “{wanted}”. Try fewer words.</CommandEmpty>}
        {failed && (
          <div role="alert" data-testid="search-failed" className="flex items-center justify-center gap-2 px-3 py-4 text-caption text-muted-foreground">
            Search didn't load.
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="rounded-sm font-medium text-foreground underline underline-offset-2 focus-ring">Try again</button>
          </div>
        )}
        {groups.map(([group, list]) => (
          <CommandGroup key={group} heading={group}>
            {list.map((it) => {
              const Icon = it.icon;
              return (
                <CommandItem key={`${group}:${it.id}`} value={`${it.label} ${it.hint ?? ""} ${group} ${it.id}`} keywords={it.keywords}
                  onSelect={() => { closeCommandPalette(); it.run(); }} data-kit="palette-row">
                  {Icon && <Icon aria-hidden className="text-muted-foreground" />}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 truncate" title={it.label}>{it.label}</span>
                      {it.hint && <span className="min-w-0 shrink-0 truncate text-caption text-muted-foreground">{it.hint}</span>}
                    </span>
                    {it.detail && <span className="min-w-0 truncate text-caption text-muted-foreground"><Marked text={it.detail} q={wanted} /></span>}
                  </span>
                  {it.shortcut && <CommandShortcut>{it.shortcut}</CommandShortcut>}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
        {searching && <div role="status" className="px-3 py-4 text-center text-caption text-muted-foreground">Searching…</div>}
      </CommandList>
    </Command>
  );
}
