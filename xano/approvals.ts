import { defineApprovals } from "@xano-sdk/agents";
import { user } from "./table/user.js";
import { rbac } from "./rbac.js";
import { approveCostlyRun, approveOverBudget } from "./function/runs/approve.js";

/**
 * What an agent asks a person's OK for (AGENT-APPROVALS.md): one entry per action, each a function that does the
 * thing as `actor_id` and re-checks that person's permission. `change_role` is the base app's (an agent asks, a
 * team manager decides; rbac's own set_role runs it). A template adds its domain's actions beside it, and seeds one
 * waiting request for the main persona.
 */
export const approvals = defineApprovals({
  user,
  canonical: "approvals",
  actions: {
    change_role: { fn: rbac.setRoleFn, label: "Change role", editable: "role", approvers: rbac.rolesWith("team.manage") },
    // A member's run above the approval line, or any video by a member: an admin lets it reserve against the owner's budget.
    costly_run: { fn: approveCostlyRun, label: "Approve the run", approvers: rbac.rolesWith("budgets.manage") },
    // A run its owner's budget refused, after they asked: an admin lets it go past the budget, this once.
    over_budget: { fn: approveOverBudget, label: "Approve over budget", approvers: rbac.rolesWith("budgets.manage") },
  },
  seed: [],
});
