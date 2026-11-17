// The app's frontend config (BASELINE.md): its name and icon, its screens, its nav, its ⌘K actions and record
// search, its permissions in plain words, and its assistant. The base app (src/base) builds everything else from it:
// sign-in, the shell, notifications, activity, settings, profile, team + invites, agents, approvals, live updates.
import { useNavigate } from "react-router";
import { BookOpen, CookingPot, FlaskConical, Gauge, House, LibraryBig, MessageCircleQuestion, Palette, Play, Plus, Sparkles, Upload } from "lucide-react";
import { useCan } from "@xano-sdk/rbac/react";
import { page, type AppConfig } from "@/base/app";
import { KIND_WORD, libraryApi } from "@/lib/library";

export const config: AppConfig = {
  name: "Atelier",
  icon: Sparkles,
  tagline: "Marlow's AI studio. Pick a person to try it as, or sign in with your account.",
  // Sign-in's product panel: Home as Jordan sees it, captured from the running app in each theme (frontend/public/showcase).
  showcase: {
    light: "/showcase/home-light.webp", dark: "/showcase/home-dark.webp", width: 2560, height: 1720,
    alt: "Atelier's Home: the month's spend, runs waiting for approval, drafts waiting on you, and the team's latest work, including a bike photo and a teaser clip.",
    title: "One studio for the whole team",
    caption: "Copy, pictures, clips, voiceovers and music from your brand kit, each run charged to a budget and approved before it costs anything.",
  },
  suggestedPersona: "jordan",

  // The domain's screens. "/" is Home (pages/home.tsx). Each is lazy, so it loads on its own.
  routes: [
    { path: "/", lazy: page(() => import("./pages/home"), "HomePage") },
    { path: "/usage", lazy: page(() => import("./pages/usage"), "UsagePage") },
    { path: "/playground", lazy: page(() => import("./pages/playground"), "PlaygroundPage"), handle: { wide: true } },
    { path: "/recipes", lazy: page(() => import("./pages/recipes"), "RecipesPage"), handle: { bleed: true } },
    { path: "/recipes/new", lazy: page(() => import("./pages/recipes/editor"), "RecipeEditorPage"), handle: { wide: true } },
    { path: "/recipes/:slug", lazy: page(() => import("./pages/recipes"), "RecipesPage"), handle: { bleed: true } },
    { path: "/recipes/:slug/edit", lazy: page(() => import("./pages/recipes/editor"), "RecipeEditorPage"), handle: { wide: true } },
    { path: "/runs/:id", lazy: page(() => import("./pages/runs/run"), "RunPage"), handle: { wide: true } },
    { path: "/library", lazy: page(() => import("./pages/library"), "LibraryPage") },
    { path: "/library/:id", lazy: page(() => import("./pages/library"), "LibraryPage") },
    { path: "/knowledge", lazy: page(() => import("./pages/knowledge/ask"), "KnowledgeAskPage") },
    { path: "/knowledge/sources", lazy: page(() => import("./pages/knowledge/sources"), "KnowledgeSourcesPage") },
    { path: "/brand", lazy: page(() => import("./pages/brand"), "BrandPage") },
  ],

  // The sidebar's first groups. `primary: true` puts an item in the phone's bottom bar (4 at most, plus More).
  useNav: () => {
    const canRun = useCan("studio.run");
    const canSeeUsage = useCan("usage.read");
    return [
      { items: [
        { href: "/", label: "Home", icon: House, primary: true, exact: true },
        ...(canRun ? [{ href: "/playground", label: "Playground", icon: FlaskConical, primary: true }] : []),
        ...(canRun ? [{ href: "/recipes", label: "Recipes", icon: CookingPot, primary: true }] : []),
        { href: "/library", label: "Library", icon: LibraryBig, primary: true },
        { href: "/knowledge", label: "Knowledge", icon: BookOpen },
      ] },
      // Merged into the base's Workspace group, ahead of its own items.
      { label: "Workspace", items: [
        ...(canRun ? [{ href: "/brand", label: "Brand kit", icon: Palette }] : []),
        ...(canSeeUsage ? [{ href: "/usage", label: "Usage", icon: Gauge }] : []),
      ] },
    ];
  },

  // ⌘K: the domain's actions ("New job"), and the records found as you type.
  usePaletteActions: () => {
    const navigate = useNavigate();
    const canRun = useCan("studio.run");
    const canAddSource = useCan("knowledge.manage");
    const canEditBrand = useCan("recipes.manage");
    const canMakeRecipes = canEditBrand;
    const canSeeUsage = useCan("usage.read");
    return [
      ...(canSeeUsage ? [{ id: "usage.open", label: "See usage and limits", group: "Actions", icon: Gauge, keywords: ["spend", "budget", "cost", "approval line", "prices", "credits"], run: () => navigate("/usage") }] : []),
      ...(canEditBrand ? [{ id: "brand.edit", label: "Edit the brand kit", group: "Actions", icon: Palette, keywords: ["voice", "tone", "colours", "style", "words to avoid", "reference images"], run: () => navigate("/brand") }] : []),
      ...(canRun ? [{ id: "playground-run", label: "Try a model in the Playground", group: "Actions", icon: FlaskConical, keywords: ["run", "generate", "image", "text", "video", "compare"], run: () => navigate("/playground") }] : []),
      ...(canRun ? [{ id: "recipes.run", label: "Run a recipe", group: "Actions", icon: Play, keywords: ["recipe", "launch kit", "workflow", "steps"], run: () => navigate("/recipes") }] : []),
      ...(canMakeRecipes ? [{ id: "recipes.new", label: "New recipe", group: "Actions", icon: Plus, keywords: ["recipe", "create", "steps", "chain", "workflow"], run: () => navigate("/recipes/new") }] : []),
      { id: "library.open", label: "Browse the Library", group: "Actions", icon: LibraryBig, keywords: ["assets", "images", "video", "approved", "download", "made"], run: () => navigate("/library") },
      { id: "knowledge.ask", label: "Ask Knowledge", group: "Actions", icon: MessageCircleQuestion, keywords: ["question", "search", "sources", "cite"], run: () => navigate("/knowledge") },
      ...(canAddSource ? [{ id: "knowledge.add", label: "Add a source to Knowledge", group: "Actions", icon: Upload, keywords: ["upload", "pdf", "recording", "document"], run: () => navigate("/knowledge/sources?add=1") }] : []),
    ];
  },
  // Library items whose title holds what's typed, among the ones this person may see.
  search: async (q, go) => {
    const words = q.trim();
    if (words.length < 2) return [];
    const found = await libraryApi.list({ kind: "all", approved: false, maker: 0, recipe: 0, q: words }, 1, 8);
    return found.items.map((t) => ({
      id: `asset-${t.id}`, label: t.title || KIND_WORD[t.kind], group: "Library", icon: LibraryBig,
      hint: `${KIND_WORD[t.kind] ?? t.kind}${t.status === "approved" ? " · approved" : ""}`, detail: t.maker_name ? `Made by ${t.maker_name}` : undefined,
      run: () => go(`/library/${t.id}`),
    }));
  },

  // Each permission in xano/rbac.ts, in the app's words: Team and Profile say "Admins can manage the team".
  permissionLabels: {
    "team.manage": "manage the team",
    "studio.run": "run AI models and recipes",
    "knowledge.ask": "ask the knowledge base",
    "knowledge.manage": "add and remove knowledge sources",
    "recipes.manage": "create and edit recipes and the brand kit",
    "library.approve": "approve library items for use",
    "usage.read": "see the team's AI usage",
    "budgets.manage": "set budgets, prices and the approval line",
  },

  // Easel: makes, finds and explains with the studio's own actions, and asks a person before video or anything costly.
  assistant: {
    name: "Easel",
    welcome: "Ask Easel to find approved work, answer from Knowledge, run a recipe or make something new. Video and costly runs wait for a person's OK.",
    suggestions: ["What's approved in the Library?", "What does our brand guide say about tone?", "Make a 6 second clip from an approved photo", "How much have I spent this month?"],
  },
};
