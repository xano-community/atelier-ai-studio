// "Use in a new run": the Playground opened from a library item (?from=<id>). A picture is attached to edit, a recording
// to transcribe, words become the prompt. A stored file can't be handed to a model from the server, so its bytes come
// down through the item's one-minute link and go up again as this run's own file, the same as a file picked by hand.
// Where the server can't make that link, the notice says so and nothing is attached.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { LibraryBig, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { StepKind } from "@/lib/catalog";
import { fetchAssetFile, libraryApi, playgroundUse } from "@/lib/library";

export type FromLibrary = { id: number; title: string; kind: StepKind; state: "loading" | "attached" | "failed"; words: string };

/** Load item `id` into the form: `attach` takes the file for a kind, `prompt` the words. */
export function useFromLibrary(id: number, o: { attach: (kind: StepKind, file: File) => void; prompt: (words: string) => void }) {
  const [from, setFrom] = useState<FromLibrary | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    setFrom({ id, title: "", kind: "text", state: "loading", words: "Getting it from the Library…" });
    (async () => {
      const item = await libraryApi.get(id);
      const use = playgroundUse(item.kind);
      if (!use.tab) throw new Error(use.words);
      const kind = use.tab as StepKind;
      const title = item.title || "a library item";
      if (use.tab === "text") {
        if (!live) return;
        o.prompt(item.body);
        setFrom({ id, title, kind, state: "attached", words: "Its words are in the prompt." });
        return;
      }
      if (live) setFrom({ id, title, kind, state: "loading", words: "Attaching its file…" });
      try {
        const { blob, name, mime } = await fetchAssetFile(id);
        if (!live) return;
        o.attach(kind, new File([blob], name, { type: mime || blob.type }));
        setFrom({ id, title, kind, state: "attached", words: kind === "image" ? "Attached as the image to edit." : "Attached as the recording to transcribe." });
      } catch (e) {
        if (live) setFrom({ id, title, kind, state: "failed", words: `It couldn't be attached: ${e instanceof Error ? e.message : "try again."} You can attach a file by hand.` });
      }
    })().catch((e: unknown) => {
      if (live) setFrom({ id, title: "", kind: "text", state: "failed", words: e instanceof Error ? e.message : "That library item didn't load." });
    });
    return () => { live = false; };
    // Loads once per item; the callbacks only write into the form.
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return [from, setFrom] as const;
}

export function FromLibraryNotice({ from, onClear }: { from: FromLibrary; onClear: () => void }) {
  return (
    <div role="status" data-testid="from-library" data-state={from.state} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2 text-body">
      <LibraryBig aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        {from.title
          ? <>Starting from <Link to={`/library/${from.id}`} className="font-medium underline-offset-2 hover:underline">{from.title}</Link> in the Library. </>
          : null}
        <span className="text-muted-foreground">{from.words}</span>
      </span>
      <Button variant="ghost" size="icon-sm" aria-label="Don't start from the library item" onClick={onClear} className="text-muted-foreground"><X /></Button>
    </div>
  );
}
