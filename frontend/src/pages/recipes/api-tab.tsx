// The API tab: the same recipe as an HTTP call with your own key (cURL or JavaScript), what it answers, and your keys: make a
// named one (shown once), see when each was last used and when it expires, revoke one. Each key charges your own budget, with
// its name on Usage.
import { useState } from "react";
import { Check, Copy, KeyRound, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Ago, Segmented, StatusBadge, useLoad, type Tone } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useLive } from "@/base/live";
import { XANO_HOST } from "@/lib/api";
import { curlFor, jsFor, recipesApi, type ApiKey, type NewKey, type RecipeDetail, type RecipeInput } from "@/lib/recipes";
import { cn } from "@/lib/utils";

/** Code in a framed block: a header with what it is and Copy, then the code, scrolling sideways rather than wrapping. */
function CodeBlock({ code, label, head, testId }: { code: string; label: string; head?: React.ReactNode; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => toast.error("Couldn't copy. Select it and copy it by hand."));
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border bg-card">
      <div className="flex h-10 items-center gap-2 border-b bg-muted/30 pr-1.5 pl-3">
        <div className="min-w-0 flex-1 text-caption font-medium text-muted-foreground">{head ?? label}</div>
        <Button variant="ghost" size="sm" className="h-7 text-caption" onClick={() => void copy()} aria-label={`Copy ${label}`}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="kit-scroll-x overflow-x-auto p-3 font-mono text-caption leading-relaxed whitespace-pre" data-testid={testId}>{code}</pre>
    </div>
  );
}

const keyState = (k: ApiKey): { tone: Tone; label: string } =>
  k.revoked ? { tone: "neutral", label: "Revoked" } : k.expires_at && k.expires_at < Date.now() ? { tone: "danger", label: "Expired" } : { tone: "success", label: "Active" };

type Lang = "curl" | "js";

export function ApiTab({ detail }: { detail: RecipeDetail }) {
  const { recipe } = detail;
  const host = XANO_HOST || window.location.origin;
  const inputs = (recipe.inputs ?? []) as RecipeInput[];
  const keys = useLoad(() => recipesApi.keys(), []);
  useLive("key", keys.reload);
  const [lang, setLang] = useState<Lang>("curl");
  const [name, setName] = useState("");
  const [days, setDays] = useState(90);
  const [made, setMade] = useState<NewKey | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    setBusy("create");
    try { setMade(await recipesApi.createKey(name.trim(), days)); setName(""); keys.reload(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "The key wasn't made. Try again."); }
    finally { setBusy(null); }
  };
  const revoke = async (k: ApiKey) => {
    setBusy(`revoke-${k.id}`);
    try { await recipesApi.revokeKey(k.id); toast.success(`Revoked ${k.name}. Its next call is refused.`); keys.reload(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "It wasn't revoked. Try again."); }
    finally { setBusy(null); }
  };
  const live = (keys.data ?? []).filter((k) => keyState(k).label === "Active").length;

  return (
    <div className="grid items-start gap-5 @5xl:grid-cols-[minmax(0,1fr)_20rem]" data-testid="recipe-api">
      <section className="grid min-w-0 content-start gap-3">
        {recipe.status !== "published" && (
          <p className="flex gap-2 rounded-lg border bg-card p-3 text-body text-pretty"><TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />This recipe is a draft. Publish it in the editor before calling it from outside the app.</p>
        )}
        <div className="grid gap-1">
          <h3 className="text-heading">Run it from your own code</h3>
          <p className="text-caption text-pretty text-muted-foreground">
            Text inputs go in <code className="font-mono text-foreground">inputs</code> as JSON{inputs.some((i) => ["image", "audio", "file"].includes(i.type)) ? "; files as file_1, file_2… in the order the recipe lists them" : ""}.
            The same <code className="font-mono text-foreground">Idempotency-Key</code> sent again returns the first run, never a second charge.
          </p>
        </div>
        <CodeBlock code={lang === "curl" ? curlFor(host, recipe.slug, inputs) : jsFor(host, recipe.slug, inputs)} label={lang === "curl" ? "the cURL call" : "the JavaScript call"} testId="recipe-curl"
          head={<Segmented<Lang> size="xs" label="Language" value={lang} onChange={setLang} options={[{ value: "curl", label: "cURL" }, { value: "js", label: "JavaScript" }]} className="bg-transparent p-0" />} />
        <div className="mt-2 grid gap-1">
          <h3 className="text-heading">It answers at once</h3>
          <p className="text-caption text-pretty text-muted-foreground">Poll the address with the same key for each step's text or a one-minute link to its file. A run that needs an admin says "waiting_approval"; one whose model was retired answers 409 with the models it can use.</p>
        </div>
        <CodeBlock label="the answer" head="Response · 200" code={`{\n  "run": 4182,\n  "status": "queued",\n  "estimate": "$1.05",\n  "poll": "${host}/api:studio/recipes/runs/4182"\n}`} />
      </section>

      <section className="grid content-start rounded-lg border bg-card" aria-label="Your keys" data-testid="api-keys">
        <div className="flex items-baseline justify-between gap-2 border-b px-4 py-3">
          <h3 className="text-heading">Your keys</h3>
          {keys.data && <span className="text-caption text-muted-foreground tabular-nums">{live} active</span>}
        </div>
        {made && (
          <div className="grid gap-2 border-b bg-success/5 p-4" role="status" data-testid="new-key">
            <p className="text-body font-medium">Copy {made.key.name} now</p>
            <CodeBlock code={made.token} label="the key" head="Key" testId="new-key-token" />
            <p className="text-caption text-muted-foreground">It isn't shown again. Keep it where your code reads it, like ATELIER_KEY.</p>
            <Button variant="outline" size="sm" className="justify-self-start" onClick={() => setMade(null)}>I've copied it</Button>
          </div>
        )}
        {keys.error && !keys.data ? <p className="p-4 text-caption text-destructive">Your keys didn't load. <button className="underline" onClick={keys.reload}>Try again</button></p>
          : !keys.data ? <div className="grid gap-2 p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
          : keys.data.length === 0 ? <p className="px-4 py-3 text-caption text-pretty text-muted-foreground">No keys yet. Each key runs recipes as you and charges your budget.</p>
          : (
            <ul className="divide-y" data-testid="key-list">
              {keys.data.map((k) => {
                const st = keyState(k);
                const on = st.label === "Active";
                return (
                  <li key={k.id} className={cn("grid gap-0.5 px-4 py-2.5", !on && "opacity-70")}>
                    <div className="flex min-h-7 items-center gap-2">
                      <KeyRound aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-body font-medium" title={k.name}>{k.name}</span>
                      <StatusBadge tone={st.tone} dot>{st.label}</StatusBadge>
                    </div>
                    <div className="flex items-center gap-2 pl-5.5">
                      <p className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                        {k.scope === "read" ? "Read only · " : ""}Used <Ago value={k.last_used_at} fallback="never" />{k.expires_at && on ? <> · expires <Ago value={k.expires_at} /></> : null}
                      </p>
                      {on && <Button variant="ghost" size="xs" className="text-muted-foreground" disabled={busy === `revoke-${k.id}`} onClick={() => void revoke(k)} aria-label={`Revoke ${k.name}`}>Revoke</Button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        <form className="grid gap-2 border-t p-4" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <label htmlFor="key-name" className="text-caption font-medium text-muted-foreground">New key, named after where it's used</label>
          <div className="flex gap-2">
            <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Shop sync" maxLength={80} className="h-8 text-body" data-testid="key-name" />
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger aria-label="Lasts for" className="h-8 w-28 shrink-0 text-body"><SelectValue /></SelectTrigger>
              <SelectContent position="popper"><SelectItem value="30">30 days</SelectItem><SelectItem value="90">90 days</SelectItem></SelectContent>
            </Select>
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={!name.trim() || busy === "create"} data-testid="key-create"><KeyRound aria-hidden />Make key</Button>
        </form>
      </section>
    </div>
  );
}
