// The app frame (BASELINE.md): every route, provider and piece of chrome a template has, built from one config
// (frontend/src/app.config.tsx). A template writes its screens and that config; this file wires the rest:
//   - signed out: sign-in (demo people + email), sign-up, /join/<token> (invites and resets);
//   - signed in: the kit's AppShell (left sidebar, user menu with Profile · Settings · Shortcuts · Theme · Sign out),
//     the header (⌘K, who's online, the notification bell, Ask), ⌘K with the nav, actions and record search,
//     "?" and g-shortcuts, the assistant, live updates, and the base screens: /notifications, /activity, /settings,
//     /profile, /team, /agents, /approvals, and a 404 for anything else.
import { Suspense, lazy, useCallback, useMemo } from "react";
import { createBrowserRouter, Link, Navigate, Outlet, RouterProvider, useLocation, useMatches, useNavigate, type RouteObject } from "react-router";
import { Bell, Bot, History, Keyboard, Moon, Settings as SettingsIcon, MessageCircle, ShieldCheck, UserPlus, UserRound, Users, type LucideIcon } from "lucide-react";
import { RbacProvider, createRbacClient, useCan } from "@xano-sdk/rbac/react";
import type { EaselConfig } from "./assistant";
import type { Brand, Showcase } from "./auth-pages";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AppShell, CommandPalette, EmptyState, LoadError, setThemeMode, type NavGroup, type PaletteItem } from "@/components/kit";
import { LiveProvider } from "./live";
import { usePendingApprovals } from "./pending";
import { NotificationBell } from "./notifications";
import { OnlineNow } from "./presence";
import { SessionProvider, useSession } from "./session";
import { Shortcuts, goKeys, openShortcuts } from "./shortcuts";
import { WorkspaceProvider, useWorkspace } from "./workspace";
import { XANO_HOST, token } from "./request";

export type AppConfig = {
  /** The product's name (the workspace's Settings name replaces it once signed in), icon, and sign-in line. */
  name: string;
  icon: LucideIcon;
  tagline: string;
  /**
   * Sign-in's product panel (desktop only): a still of the app, in light and dark (files in frontend/public), with what it
   * shows in words. Leave it out for a plain sign-in column.
   */
  showcase?: Showcase;
  /** The demo persona to mark "Start here" on sign-in (its key), or leave it out to mark none. */
  suggestedPersona?: string;
  /**
   * The domain's screens, inside the signed-in shell, each lazy: `{ path: "/jobs", lazy: page(() => import("./pages/jobs"), "JobsPage") }`.
   * "/" is the overview. Add `handle: { wide: true }` to a board or schedule that needs the full width, or
   * `handle: { bleed: true }` to a screen that takes the whole pane and scrolls itself (a SplitView).
   */
  routes: RouteObject[];
  /**
   * The domain's nav groups (a hook, so it can call useCan). The base adds Approvals, Agents and Team after them, in a
   * group labelled "Workspace"; a domain group with that label joins it, its items first.
   */
  useNav: () => NavGroup[];
  /** The domain's ⌘K actions ("New job"), a hook too. Nav items, settings and the base's actions are added. */
  usePaletteActions?: () => PaletteItem[];
  /** Records found as the person types in ⌘K. `go(href)` navigates. */
  search?: (q: string, go: (href: string) => void) => Promise<PaletteItem[]>;
  /** The domain's single-key shortcuts for the "?" sheet: [["N", "New job"]]. Bind them with useHotkey on their screen. */
  shortcuts?: [string, string][];
  /** Each permission in the app's words ("jobs.assign": "assign jobs"), for Team and Profile. */
  permissionLabels: Record<string, string>;
  /** The assistant (CHATBOT.md), opened from the header's Ask, for everyone who can run AI (guests can't). */
  assistant: EaselConfig;
};

/** A lazy route's loader: `lazy: page(() => import("./pages/jobs"), "JobsPage")`. Each screen is its own chunk. */
export const page = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  async () => ({ Component: (await load())[name] });

// One client per module, reading the person's token on every call. Group URLs: backend + /api:<canonical>.
const rbacClient = createRbacClient({ apiBaseUrl: `${XANO_HOST}/api:rbac`, getToken: () => token.get() });
/** Easel runs on the deployer's own model key (base/assistant.tsx), so it answers on a local Engine too. */
const Easel = lazy(() => import("./assistant"));
const openAssistant = () => void import("@xano-sdk/chatbot/react").then((m) => m.openChatWidget());
// What isn't on the first paint loads straight after it: the agents module (around the screens), and the toasts.
// Both start as this module runs, so neither waits on the screen's own chunk.
const agentsArea = import("./agents-area");
const AgentsArea = lazy(() => agentsArea);
const Toaster = lazy(() => import("@/components/ui/sonner").then((m) => ({ default: m.Toaster })));

/** A screen on its way, the first time only: the shape of a page header and a few rows. */
function ScreenPoster() {
  return (
    <div className="flex flex-col gap-6" aria-busy>
      <div className="flex flex-col gap-2"><Skeleton className="h-7 w-48" /><Skeleton className="h-4 w-72 max-w-full" /></div>
      <div className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
    </div>
  );
}

function Frame({ config }: { config: AppConfig }) {
  const { me, signOut } = useSession();
  const navigate = useNavigate();
  const { settings } = useWorkspace();
  const pending = usePendingApprovals();
  const canManage = useCan("team.manage");
  // Easel and agents run AI for the person, so they're for people who may (guests see approved work and ask Knowledge).
  const guest = !useCan("studio.run");
  const domainNav = config.useNav();
  const domainActions = config.usePaletteActions?.() ?? [];
  const handles = useMatches().map((m) => m.handle as { wide?: boolean; bleed?: boolean } | undefined);
  const wide = handles.some((h) => h?.wide);
  const bleed = handles.some((h) => h?.bleed);
  const name = settings?.name || config.name;
  if (typeof document !== "undefined" && document.title !== name) document.title = name;

  // A domain group labelled "Workspace" joins the base's, its items first.
  const domainWorkspace = domainNav.filter((g) => g.label === "Workspace").flatMap((g) => g.items);
  const nav: NavGroup[] = [
    ...domainNav.filter((g) => g.label !== "Workspace"),
    { label: "Workspace", items: [
      ...domainWorkspace,
      { href: "/approvals", label: "Approvals", icon: ShieldCheck, badge: pending, primary: true },
      ...(guest ? [] : [{ href: "/agents", label: "Agents", icon: Bot }]),
      ...(canManage ? [{ href: "/team", label: "Team", icon: Users }] : []),
    ] },
  ];
  const extraScreens = [
    { href: "/notifications", label: "Notifications", icon: Bell },
    { href: "/activity", label: "Activity", icon: History },
    { href: "/settings", label: "Settings", icon: SettingsIcon },
    { href: "/profile", label: "Profile", icon: UserRound },
  ];
  const go = useMemo(() => goKeys(nav, extraScreens), [JSON.stringify(nav.map((g) => g.items.map((i) => i.href)))]); // eslint-disable-line react-hooks/exhaustive-deps
  const items: PaletteItem[] = [
    ...[...nav.flatMap((g) => g.items), ...extraScreens].map((i) => ({ id: i.href, label: i.label, group: "Go to", icon: i.icon, run: () => navigate(i.href) })),
    ...domainActions,
    ...(canManage ? [{ id: "invite", label: "Invite someone", group: "Actions", icon: UserPlus, run: () => navigate("/team?invite=1") }] : []),
    ...(guest ? [] : [{ id: "ask", label: `Ask ${config.assistant.name}`, group: "Actions", icon: MessageCircle, run: openAssistant }]),
    { id: "theme", label: "Switch light / dark", group: "Actions", icon: Moon, run: () => setThemeMode(document.documentElement.classList.contains("dark") ? "light" : "dark") },
    { id: "shortcuts", label: "Keyboard shortcuts", group: "Actions", icon: Keyboard, run: openShortcuts },
  ];
  const search = useCallback((q: string) => (config.search ? config.search(q, (href) => navigate(href)) : Promise.resolve([])), [config, navigate]);
  if (!me) return null;
  return (
    <AppShell brand={{ name, icon: config.icon }} nav={nav} wide={wide} bleed={bleed}
      user={{ name: me.name, email: me.email, detail: me.role.charAt(0).toUpperCase() + me.role.slice(1) }} onSignOut={signOut}
      menu={[
        { label: "Settings", icon: SettingsIcon, onSelect: () => navigate("/settings"), kit: "user-menu-settings" },
        { label: "Keyboard shortcuts", icon: Keyboard, onSelect: openShortcuts, kit: "user-menu-shortcuts" },
      ]}
      headerEnd={<>
        <OnlineNow />
        <NotificationBell />
        {!guest && (
          <Button variant="ghost" size="sm" data-testid="ask-assistant" className="max-sm:size-11" aria-label={`Ask ${config.assistant.name}`} onClick={openAssistant}>
            <MessageCircle className="text-agent-text" /><span className="max-sm:sr-only">Ask</span>
          </Button>
        )}
      </>}>
      <Suspense fallback={<ScreenPoster />}>
        <AgentsArea userId={me.id}>
          <Outlet />
          {!guest && <Suspense fallback={null}><Easel config={config.assistant} /></Suspense>}
        </AgentsArea>
      </Suspense>
      <CommandPalette items={items} search={config.search ? search : undefined} />
      <Shortcuts go={go} actions={config.shortcuts} />
    </AppShell>
  );
}

function Shell({ config }: { config: AppConfig }) {
  const { me } = useSession();
  const location = useLocation();
  if (!me) return <Navigate to="/sign-in" replace state={{ from: location.pathname + location.search }} />;
  return (
    <RbacProvider client={rbacClient} userKey={me.id}>
      <LiveProvider userId={me.id}>
        <WorkspaceProvider>
          <Frame config={config} />
        </WorkspaceProvider>
      </LiveProvider>
    </RbacProvider>
  );
}

function NotFound() {
  return (
    <div className="py-12" data-testid="not-found">
      <EmptyState title="This page doesn't exist" description="The link may be old, or the address has a typo."
        action={<Button asChild size="sm"><Link to="/">Go to the overview</Link></Button>} />
    </div>
  );
}

function RouteError() {
  return (
    <main className="grid min-h-svh place-items-center p-6">
      <LoadError title="This page broke" error="Something on this screen failed. Reload, or go back to the overview." onRetry={() => location.assign("/")} />
    </main>
  );
}

/** The whole app from its config: `export default createApp(config)` in App.tsx. */
export function createApp(config: AppConfig) {
  const brand: Brand = { name: config.name, icon: config.icon, tagline: config.tagline, showcase: config.showcase, suggested: config.suggestedPersona };
  const base = (load: () => Promise<Record<string, unknown>>, pick: (m: Record<string, unknown>) => React.ComponentType) =>
    async () => ({ Component: pick(await load()) });
  // Signed out is its own chunk: someone signed in never loads it.
  const signedOut = (pick: (m: typeof import("./auth-pages")) => React.ComponentType<{ brand: Brand }>) =>
    async () => { const Page = pick(await import("./auth-pages")); return { Component: () => <Page brand={brand} /> }; };
  const router = createBrowserRouter([
    { path: "/sign-in", lazy: signedOut((m) => m.SignInPage) },
    { path: "/sign-up", lazy: signedOut((m) => m.SignUpPage) },
    { path: "/join/:token", lazy: signedOut((m) => m.JoinPage) },
    {
      element: <Shell config={config} />,
      errorElement: <RouteError />,
      children: [
        ...config.routes,
        { path: "/notifications", lazy: base(() => import("./notifications-page"), (m) => m.NotificationsPage as React.ComponentType) },
        { path: "/activity", lazy: base(() => import("./activity"), (m) => m.ActivityPage as React.ComponentType) },
        { path: "/settings", lazy: base(() => import("./settings"), (m) => m.SettingsPage as React.ComponentType) },
        { path: "/profile", lazy: async () => { const { ProfileRoute } = await import("./profile"); return { Component: () => <ProfileRoute labels={config.permissionLabels} /> }; } },
        { path: "/team", lazy: async () => { const { TeamRoute } = await import("./team"); return { Component: () => <TeamRoute labels={config.permissionLabels} /> }; } },
        { path: "/approvals", lazy: async () => { const { ApprovalsPage } = await import("./approvals"); return { Component: () => <ApprovalsPage appName={config.name} assistantName={config.assistant.name} /> }; } },
        { path: "/agents", lazy: async () => { const { AgentsPage } = await import("@xano-sdk/agents/react"); return { Component: () => <AgentsPage appName={config.name} /> }; } },
        { path: "*", element: <NotFound /> },
      ],
    },
  ]);
  return function App() {
    return (
      <TooltipProvider>
        <SessionProvider><RouterProvider router={router} /></SessionProvider>
        <Suspense fallback={null}><Toaster /></Suspense>
      </TooltipProvider>
    );
  };
}
