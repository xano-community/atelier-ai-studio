// The studio's MCP tools: one thin agent.tool per capability. The module's wrapper checks the connection on every call (a
// live, unexpired key, and read-and-write for a tool that writes); this checks the person behind it isn't a guest, then calls
// the shared function as that person, the way the app's screens do. Inside, `conn` is the connection and `conn.user_id`
// the person; auth("id") is the key, never a person.
import { c, fl, guard, inp, ref, s, withFilters, type Value } from "@xano/sdk";
import { agent } from "../../agent.js";
import { agentGateFn } from "../../function/studio/tooling.js";
import { listRecipesToolFn } from "../../function/studio/list_recipes.js";
import { runRecipeToolFn } from "../../function/studio/run_recipe.js";
import { generateToolFn } from "../../function/studio/generate.js";
import { askKnowledgeToolFn } from "../../function/studio/ask_knowledge.js";
import { findAssetsToolFn, getAssetToolFn } from "../../function/studio/find_assets.js";
import { checkRunToolFn } from "../../function/studio/check_run.js";
import { myUsageToolFn } from "../../function/studio/my_usage.js";
import { CAPABILITIES, WRITE_CAPABILITIES, type CapabilityName } from "../args.js";

/** The person behind the connection, checked on every call before anything is read or reserved. */
export const agentGate = () => [
  guard.found("conn", { errorType: "unauthorized", message: "This agent key no longer exists." }),
  s.function.run({ fn: agentGateFn, as: "gate", input: { actor_id: ref("conn.user_id") } }),
];

const mcpTool = (name: CapabilityName, fn: Parameters<typeof s.function.run>[0]["fn"], logDetail?: Value) => {
  const cap = CAPABILITIES[name];
  return agent.tool({
    name, title: cap.title, description: cap.description,
    access: WRITE_CAPABILITIES.includes(name) ? "write" : "read",
    ...(Object.keys(cap.input).length ? { input: cap.input as never } : {}),
    ...(logDetail ? { logDetail } : {}),
    stack: [
      ...agentGate(),
      s.function.run({ fn, as: "out", input: {
        actor_id: ref("conn.user_id"), via: c.text("mcp"), connection_id: ref("conn.id"), agent_label: ref("conn.name"), turn: c.text(""), ...cap.args(),
      } }),
    ],
    response: ref("out"),
  });
};

export const listRecipesMcp = mcpTool("list_recipes", listRecipesToolFn);
export const runRecipeMcp = mcpTool("run_recipe", runRecipeToolFn, withFilters(c.text("ran the recipe "), fl.concat(inp("recipe"))));
export const generateMcp = mcpTool("generate", generateToolFn, withFilters(c.text("asked for "), fl.concat(inp("kind"))));
export const askKnowledgeMcp = mcpTool("ask_knowledge", askKnowledgeToolFn);
export const findAssetsMcp = mcpTool("find_assets", findAssetsToolFn);
export const getAssetMcp = mcpTool("get_asset", getAssetToolFn);
export const checkRunMcp = mcpTool("check_run", checkRunToolFn);
export const myUsageMcp = mcpTool("my_usage", myUsageToolFn);

/** The eight, in the order an agent reads them. */
export const studioMcpTools = [listRecipesMcp, runRecipeMcp, generateMcp, askKnowledgeMcp, findAssetsMcp, getAssetMcp, checkRunMcp, myUsageMcp];
