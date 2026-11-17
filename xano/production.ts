// The production entry: the same workspace as index.ts, with none of the demo world. No demo person, no Marlow content and no
// settings row ship, so demo sign-in finds nobody and first-admin setup (auth/setup, with the backend's SETUP_TOKEN) is the
// only way in; setup writes the settings row with the production budgets ($100 a month for the team, $25 each, approval
// above $0.50). The price table is the one seed kept: it is the product's prices, not demo data, and admins edit it.
// Because the rows are emptied here, at build time, a `--seed` or a `--replace` deploy of this entry still lands an empty
// workspace. `npm run xano:deploy:production` deploys it, with SETUP_TOKEN set in xano/.env. Deploy `index.ts` for the demo.
import app from "./index.js";
import { price } from "./table/studio/price.js";

for (const table of app.tables()) if (table.name !== price.name) Object.assign(table, { seed: [] });

export default app;
