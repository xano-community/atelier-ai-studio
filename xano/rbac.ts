import { defineRbac } from "@xano-sdk/rbac";
import { user } from "./table/user.js";

/** Who may do what (RBAC.md). Roles are user.role's values (xano/app.ts ROLES). `team.manage` is required. */
export const rbac = defineRbac({
  user,
  canonical: "rbac",
  permissions: {
    "team.manage": ["admin"],
    "studio.run": ["admin", "member"],
    "knowledge.ask": ["admin", "member", "guest"],
    "knowledge.manage": ["admin", "member"],
    "recipes.manage": ["admin", "member"],
    "library.approve": ["admin", "member"],
    "usage.read": ["admin"],
    "budgets.manage": ["admin"],
  },
});
