// Keyboard (BASELINE.md): "?" lists every shortcut, and "g" then a letter goes to a screen (G then O: Overview).
// The letters come from the nav itself, the first free letter of each label, so a template gets them for free.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { isTyping, useHotkey, type NavGroup } from "@/components/kit";

const OPEN = "base:shortcuts";
export const openShortcuts = () => window.dispatchEvent(new Event(OPEN));

export type GoKey = { key: string; label: string; href: string };

/** "g" + a letter for each screen: the first letter of its label that no earlier screen took. */
export function goKeys(nav: NavGroup[], extra: { label: string; href: string }[]): GoKey[] {
  const taken = new Set<string>();
  const out: GoKey[] = [];
  for (const it of [...nav.flatMap((g) => g.items), ...extra]) {
    if (out.some((o) => o.href === it.href)) continue;
    const letter = [...it.label.toLowerCase()].find((ch) => /[a-z]/.test(ch) && !taken.has(ch));
    if (!letter) continue;
    taken.add(letter);
    out.push({ key: letter, label: it.label, href: it.href });
  }
  return out;
}

const ShortcutsSheet = lazy(() => import("./shortcuts-sheet"));

/** Mount once in the shell. `actions` are the domain's single-key shortcuts (["N", "New job"]). */
export function Shortcuts({ go, actions = [] }: { go: GoKey[]; actions?: [string, string][] }) {
  const [open, setOpen] = useState(false);
  // Mounted from the first open on, so closing it can play out.
  const [asked, setAsked] = useState(false);
  if (open && !asked) setAsked(true);
  const navigate = useNavigate();
  const pendingG = useRef<number>(0);
  useHotkey("?", () => setOpen(true));
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN, on);
    return () => window.removeEventListener(OPEN, on);
  }, []);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const k = e.key.toLowerCase();
      if (pendingG.current && Date.now() - pendingG.current < 1200) {
        pendingG.current = 0;
        const hit = go.find((g) => g.key === k);
        if (hit) { e.preventDefault(); navigate(hit.href); }
        return;
      }
      if (k === "g") pendingG.current = Date.now();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [go, navigate]);
  return asked ? <Suspense fallback={null}><ShortcutsSheet open={open} setOpen={setOpen} go={go} actions={actions} /></Suspense> : null;
}
