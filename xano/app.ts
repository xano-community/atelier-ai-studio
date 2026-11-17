// The app's name, roles and demo people: the first backend file a template edits (BASELINE.md).
// `xano/table/user.ts` reads ROLES and DEMO_PEOPLE from here (modules/base/install.mjs wired it), so the role
// enum, the seeded people, the demo sign-in and the invite form all follow this one file.

export const APP = {
  /** Shown in the sidebar, the sign-in screen and the MCP sign-in page. Admins can rename it in Settings. */
  name: "Atelier",
  /** The repo slug. It names the workspace and the ChatGPT/Claude sign-in page's API group. */
  slug: "ai-studio",
} as const;

/** user.role's values, most trusted first. Every permission in xano/rbac.ts names some of these. */
export const ROLES = ["admin", "member", "guest"] as const;
export type Role = (typeof ROLES)[number];

/** What a sign-up gets, and the invite form's default: the least-privileged role. */
export const SIGNUP_ROLE: Role = "member";

/**
 * One demo person per role a visitor should try, in seed order: rows in other tables refer to them by
 * position (`user_id: 1` is the first). They sign in with one click through auth/demo, never a password.
 */
export const DEMO_PEOPLE: readonly { key: string; name: string; email: string; role: Role; description: string }[] = [
  { key: "jordan", name: "Jordan Lee", email: "jordan@marlow.example", role: "admin", description: "Head of brand. Sets budgets, approves costly runs" },
  { key: "sam", name: "Sam Rivera", email: "sam@marlow.example", role: "member", description: "Content lead. Runs recipes and makes launch assets" },
  { key: "priya", name: "Priya Nair", email: "priya@marlow.example", role: "member", description: "Customer insights. Adds call recordings to Knowledge" },
  { key: "alex", name: "Alex Kim", email: "alex@studio-kim.example", role: "guest", description: "Freelance designer. Sees approved work and can ask Knowledge" },
];

/**
 * What the activity feed shows on a fresh deploy: a few believable lines by the demo people and their agents,
 * so the overview isn't empty (BASELINE.md). `actor` is a DEMO_PEOPLE position (1 = the first); `via` names the
 * agent that did it for them; `title` is the rest of a sentence after their name.
 */
export type SeedActivity = { actor: number; via?: string; verb: string; entity: string; entity_id: number; title: string; link?: string; minutesAgo: number };
export const SEED_ACTIVITY: SeedActivity[] = [];

/** The seeded people's shared, deliberately public password (AUTH.md §4). Never used to sign in. */
export const DEMO_PASSWORD = "DemoPass123";
