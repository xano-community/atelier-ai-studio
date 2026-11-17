// The demo deploy's starting rows (xano/world.ts), put on their tables in one place. xano/production.ts empties every table's
// seed but the price table's, so a production deploy starts with no people and no demo content.
import { agent } from "./agent.js";
import { approvals } from "./approvals.js";
import { activity, notification } from "./base/index.js";
import { asset } from "./table/library/asset.js";
import { media_blob } from "./table/library/media_blob.js";
import { kb_passage } from "./table/knowledge/kb_passage.js";
import { kb_source } from "./table/knowledge/kb_source.js";
import { recipe } from "./table/recipes/recipe.js";
import { recipe_step } from "./table/recipes/recipe_step.js";
import { ai_run } from "./table/studio/ai_run.js";
import { ai_step } from "./table/studio/ai_step.js";
import { brand, brand_image } from "./table/studio/brand.js";
import { budget_month } from "./table/studio/budget_month.js";
import { ledger } from "./table/studio/ledger.js";
import { easel_turn } from "./table/studio/easel_turn.js";
import { user } from "./table/user.js";
import { rbac } from "./rbac.js";
import {
  SEED_ACTIVITY, SEED_AGENT_KEYS, SEED_APPROVALS, SEED_ASSETS, SEED_BRAND, SEED_BRAND_IMAGES, SEED_KB_SOURCES, SEED_LEDGER, SEED_MEDIA, SEED_MONTHS, SEED_EASEL_TURNS,
  SEED_JOINED, SEED_NOTIFICATIONS, SEED_PASSAGES, SEED_RECIPES, SEED_RECIPE_STEPS, SEED_ROLE_CHANGES, SEED_RUNS, SEED_STEPS,
} from "./world.js";

const seeds: [{ seed?: unknown }, unknown[]][] = [
  [recipe, SEED_RECIPES], [recipe_step, SEED_RECIPE_STEPS], [ai_run, SEED_RUNS], [ai_step, SEED_STEPS], [budget_month, SEED_MONTHS], [ledger, SEED_LEDGER],
  [media_blob, SEED_MEDIA], [asset, SEED_ASSETS], [kb_source, SEED_KB_SOURCES], [kb_passage, SEED_PASSAGES], [brand, SEED_BRAND], [brand_image, SEED_BRAND_IMAGES],
  [easel_turn, SEED_EASEL_TURNS], [agent.agent_connection, SEED_AGENT_KEYS], [approvals.approval, SEED_APPROVALS], [notification, SEED_NOTIFICATIONS], [activity, SEED_ACTIVITY],
];
for (const [table, rows] of seeds) Object.assign(table, { seed: rows });

// The people (seeded by the user table itself) joined weeks before the Library's first item, not at the deploy; and the rbac
// module's role_change table, which it only ever adds to, starts with the changes Jordan made since.
Object.assign(user, { seed: (user.seed as Record<string, unknown>[]).map((row, i) => ({ ...row, created_at: SEED_JOINED[i] })) });
Object.assign(rbac.role_change, { seed: SEED_ROLE_CHANGES });
