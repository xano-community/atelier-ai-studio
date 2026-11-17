// The signed-out screens (AUTH.md §6): sign in (one click as a demo person, or email and password), sign up, and
// /join/<token> for an invite or a password reset. Nothing secret is in the bundle: demo sign-in mints a token
// server-side for the listed demo people only. On a desktop, sign-in shows the product beside the form: a still of the
// app in the current theme, so the first screen says what's behind it; the suggested demo person is marked "Start here".
// A phone shows the form alone.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, LoadError } from "@/components/kit";
import { baseApi, type LinkInfo, type Persona } from "./api";
import { useSession } from "./session";

/** A still of the app for sign-in's product panel: one image per theme (paths under frontend/public) and what it shows. */
export type Showcase = { light: string; dark: string; alt: string; title: string; caption: string; width: number; height: number };
export type Brand = { name: string; icon: LucideIcon; tagline: string; showcase?: Showcase; suggested?: string };

const messageOf = (e: unknown) => (e instanceof Error ? e.message : "That didn't work. Try again.");

function Frame({ brand, title, description, children, showcase }: { brand: Brand; title: string; description?: ReactNode; children: ReactNode; showcase?: Showcase }) {
  const column = (
    <main className={showcase ? "mx-auto grid min-h-svh w-full max-w-[27rem] content-center gap-6 p-6" : "mx-auto grid min-h-svh w-full max-w-sm content-center gap-6 p-6"}>
      <div className="flex flex-col gap-2">
        <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground"><brand.icon className="size-5" /></span>
        <h1 className="text-title">{title}</h1>
        {description && <p className="text-body text-muted-foreground">{description}</p>}
      </div>
      {children}
    </main>
  );
  if (!showcase) return column;
  return (
    <div className="grid min-h-svh bg-background lg:grid-cols-[minmax(26rem,1fr)_minmax(0,1.35fr)]">
      {column}
      <ShowcasePanel showcase={showcase} />
    </div>
  );
}

/**
 * The product beside sign-in, desktop only: what the app shows, in a few words, and a still of it in a window frame that
 * runs off the panel's edge. The still follows the theme (the `dark` class), so it never shows a white window on a dark page.
 */
function ShowcasePanel({ showcase: s }: { showcase: Showcase }) {
  const img = "block h-auto w-full";
  return (
    <aside aria-label={s.title} data-testid="sign-in-showcase"
      className="relative hidden overflow-hidden border-l bg-muted/50 lg:flex lg:flex-col lg:justify-center lg:gap-6 lg:py-12 lg:pl-12 dark:bg-muted/20">
      <div className="max-w-md pr-12">
        <h2 className="text-heading">{s.title}</h2>
        <p className="mt-1 text-body text-pretty text-muted-foreground">{s.caption}</p>
      </div>
      <figure className="-mr-px w-[56rem] max-w-none shrink-0 overflow-hidden rounded-l-xl border border-r-0 bg-card shadow-[0_24px_60px_-24px_rgb(0_0_0/0.35)] animate-in fade-in slide-in-from-right-2 duration-250 ease-(--ease-out)">
        <div aria-hidden className="flex h-7 items-center gap-1.5 border-b bg-muted/40 px-3">
          {[0, 1, 2].map((i) => <span key={i} className="size-2 rounded-full bg-foreground/15" />)}
        </div>
        <img src={s.light} alt={s.alt} width={s.width} height={s.height} decoding="async" className={`${img} dark:hidden`} />
        <img src={s.dark} alt={s.alt} width={s.width} height={s.height} decoding="async" className={`${img} hidden dark:block`} />
      </figure>
    </aside>
  );
}

function PasswordField({ id, label, value, onChange, autoComplete, hint }: { id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string; hint?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="password" required autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={hint ? `${id}-hint` : undefined} />
      {hint && <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/**
 * First-admin setup: a production deploy ships with nobody in it, so the person who deployed it sets it up with the backend's
 * SETUP_TOKEN (from xano/.env), names the workspace and becomes its first admin. Shown only while the backend says it needs it.
 */
function SetupPage({ brand, onDone }: { brand: Brand; onDone: () => void }) {
  const { signIn } = useSession();
  const [form, setForm] = useState({ setup_token: "", workspace_name: brand.name, name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = (k: keyof typeof form) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value })) });
  return (
    <Frame brand={brand} title={`Set up ${brand.name}`} description="This backend has nobody in it yet. Set it up with its setup token, and you become its first admin.">
      <form className="grid gap-3" data-testid="setup-form" onSubmit={async (e: FormEvent) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { await signIn((await baseApi.setup({ ...form, setup_token: form.setup_token.trim(), workspace_name: form.workspace_name.trim(), name: form.name.trim(), email: form.email.trim() })).authToken); onDone(); }
        catch (err) { setError(messageOf(err)); }
        finally { setBusy(false); }
      }}>
        <div className="grid gap-1.5">
          <Label htmlFor="setup-token">Setup token</Label>
          <Input id="setup-token" required autoComplete="off" {...field("setup_token")} aria-describedby="setup-token-hint" />
          <p id="setup-token-hint" className="text-xs text-muted-foreground">The SETUP_TOKEN value in xano/.env, as it was deployed.</p>
        </div>
        <div className="grid gap-1.5"><Label htmlFor="setup-workspace">Workspace name</Label><Input id="setup-workspace" required maxLength={60} {...field("workspace_name")} /></div>
        <div className="grid gap-1.5"><Label htmlFor="setup-name">Your name</Label><Input id="setup-name" required autoComplete="name" maxLength={80} {...field("name")} /></div>
        <div className="grid gap-1.5"><Label htmlFor="setup-email">Email</Label><Input id="setup-email" type="email" required autoComplete="email" {...field("email")} /></div>
        <PasswordField id="setup-password" label="Password" value={form.password} onChange={(password) => setForm((f) => ({ ...f, password }))} autoComplete="new-password" hint="At least 8 characters, with a letter and a number." />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>{busy ? "Setting up…" : "Set up and sign in"}</Button>
      </form>
    </Frame>
  );
}

export function SignInPage({ brand }: { brand: Brand }) {
  const { me, signIn } = useSession();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/";
  const [needsSetup, setNeedsSetup] = useState(false);
  useEffect(() => { baseApi.status().then((s) => setNeedsSetup(s.needs_setup), () => setNeedsSetup(false)); }, []);
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [personasError, setPersonasError] = useState<unknown>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => { setPersonasError(null); baseApi.personas().then(setPersonas, setPersonasError); }, []);
  useEffect(load, [load]);
  if (me) return <Navigate to={from} replace />;
  if (needsSetup) return <SetupPage brand={brand} onDone={() => navigate("/", { replace: true })} />;

  const go = async (key: string, mint: () => Promise<{ authToken: string }>) => {
    setBusy(key); setError(null);
    try { await signIn((await mint()).authToken); navigate(from, { replace: true }); }
    catch (e) { setError(messageOf(e)); }
    finally { setBusy(null); }
  };

  return (
    <Frame brand={brand} title={brand.name} description={brand.tagline} showcase={brand.showcase}>
      {personasError ? <LoadError error={personasError} onRetry={load} /> : personas === null ? (
        <div className="grid gap-2">{[0, 1].map((i) => <Skeleton key={`skeleton-${i}`} className="h-14 w-full" />)}</div>
      ) : personas.length > 0 && (
        <div className="grid gap-2" aria-label="Try it as">
          <p className="text-xs font-medium text-muted-foreground">Try it as</p>
          {personas.map((p) => {
            const start = p.key === brand.suggested;
            return (
              <Button key={p.key} variant="outline" className={start ? "h-auto w-full min-w-0 justify-start gap-3 border-foreground/30 py-2 text-left" : "h-auto w-full min-w-0 justify-start gap-3 py-2 text-left"}
                data-testid="demo-login" data-suggested={start || undefined} disabled={!!busy} onClick={() => void go(p.key, () => baseApi.demo(p.key))}>
                <Avatar name={p.label} size="md" decorative />
                <span className="min-w-0 flex-1"><span className="block font-medium">{busy === p.key ? "Signing in…" : `Continue as ${p.label}`}</span><span className="block text-xs font-normal whitespace-normal text-pretty text-muted-foreground">{p.description}</span></span>
                {start && <span className="shrink-0 self-start rounded-full bg-foreground px-2 py-0.5 text-micro font-medium text-background">Start here</span>}
              </Button>
            );
          })}
        </div>
      )}
      {personas && personas.length > 0 && <div className="flex items-center gap-3 text-xs text-muted-foreground"><Separator className="flex-1" />or with your account<Separator className="flex-1" /></div>}
      <form className="grid gap-3" onSubmit={(e: FormEvent) => { e.preventDefault(); void go("email", () => baseApi.login(email.trim(), password)); }}>
        <div className="grid gap-1.5">
          <Label htmlFor="sign-in-email">Email</Label>
          <Input id="sign-in-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <PasswordField id="sign-in-password" label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Button type="submit" disabled={!!busy}>{busy === "email" ? "Signing in…" : "Sign in"}</Button>
      </form>
      <div className="grid gap-1 text-xs text-muted-foreground">
        <p>New here? <Link to="/sign-up" className="font-medium text-foreground underline underline-offset-4">Create an account</Link></p>
        <p>Forgot your password? Ask someone who manages your team for a reset link.</p>
      </div>
    </Frame>
  );
}

export function SignUpPage({ brand }: { brand: Brand }) {
  const { me, signIn } = useSession();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (me) return <Navigate to="/" replace />;
  return (
    <Frame brand={brand} title={`Create your ${brand.name} account`} description="You can explore everything a new member can.">
      <form className="grid gap-3" onSubmit={async (e: FormEvent) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { await signIn((await baseApi.signup(name.trim(), email.trim(), password)).authToken); navigate("/", { replace: true }); }
        catch (err) { setError(messageOf(err)); }
        finally { setBusy(false); }
      }}>
        <div className="grid gap-1.5"><Label htmlFor="sign-up-name">Name</Label><Input id="sign-up-name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="grid gap-1.5"><Label htmlFor="sign-up-email">Email</Label><Input id="sign-up-email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <PasswordField id="sign-up-password" label="Password" value={password} onChange={setPassword} autoComplete="new-password" hint="At least 8 characters, with a letter and a number." />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
      </form>
      <p className="text-xs text-muted-foreground">Already have one? <Link to="/sign-in" className="font-medium text-foreground underline underline-offset-4">Sign in</Link></p>
    </Frame>
  );
}

/** /join/<token>: accept an invite (name + password) or use a reset link (new password), then you're in. */
export function JoinPage({ brand }: { brand: Brand }) {
  const { token: raw = "" } = useParams();
  const { signIn, signOut, me } = useSession();
  const navigate = useNavigate();
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    baseApi.checkLink(raw).then((i) => { setInfo(i); setName(i.name ?? ""); }, setLoadError);
  }, [raw]);
  if (loadError) return <Frame brand={brand} title="This link can't be used"><LoadError title="This link can't be used" error={loadError} /><Link to="/sign-in" className="text-body font-medium underline underline-offset-4">Go to sign in</Link></Frame>;
  if (!info) return <Frame brand={brand} title={brand.name}><Skeleton className="h-32 w-full" /></Frame>;
  const invite = info.kind === "invite";
  return (
    <Frame brand={brand} title={invite ? `Join ${brand.name}` : "Choose a new password"}
      description={invite ? <>{info.from ?? "Someone"} invited <span className="font-medium text-foreground">{info.email}</span> as {/^[aeiou]/i.test(info.role) ? "an" : "a"} {info.role}.</> : <>For <span className="font-medium text-foreground">{info.email}</span>.</>}>
      {me && <p className="text-xs text-muted-foreground">You're signed in as {me.name}. Continuing signs you in as {info.email} instead.</p>}
      <form className="grid gap-3" data-testid="join-form" onSubmit={async (e: FormEvent) => {
        e.preventDefault(); setBusy(true); setError(null);
        try {
          const r = await baseApi.acceptLink(raw, password, invite ? name.trim() : undefined);
          if (me) signOut();
          await signIn(r.authToken);
          navigate("/", { replace: true });
        } catch (err) { setError(messageOf(err)); }
        finally { setBusy(false); }
      }}>
        {invite && <div className="grid gap-1.5"><Label htmlFor="join-name">Your name</Label><Input id="join-name" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></div>}
        <PasswordField id="join-password" label={invite ? "Choose a password" : "New password"} value={password} onChange={setPassword} autoComplete="new-password" hint="At least 8 characters, with a letter and a number." />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <Button type="submit" disabled={busy}>{busy ? "One moment…" : invite ? "Join" : "Save and sign in"}</Button>
      </form>
    </Frame>
  );
}
