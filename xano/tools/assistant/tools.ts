// Easel's tools: one thin tool per capability, signed in as the person chatting (the chatbot gives each tool the user table,
// so auth("id") is them). Each calls the same shared function as the MCP tool, with Easel's open turn as part of a run's key,
// so the model calling a tool twice in one turn starts one run. Names differ from the MCP tools' (a tool's name is its
// identity in the workspace) and read as plain words on the reply's chips.
import { auth, c, ref, s, tool } from "@xano/sdk";
import { easel_turn } from "../../table/studio/easel_turn.js";
import { easelTurnKey } from "../../function/studio/tooling.js";
import { listRecipesToolFn } from "../../function/studio/list_recipes.js";
import { runRecipeToolFn } from "../../function/studio/run_recipe.js";
import { generateToolFn } from "../../function/studio/generate.js";
import { askKnowledgeToolFn } from "../../function/studio/ask_knowledge.js";
import { findAssetsToolFn, getAssetToolFn } from "../../function/studio/find_assets.js";
import { checkRunToolFn } from "../../function/studio/check_run.js";
import { myUsageToolFn } from "../../function/studio/my_usage.js";
import { CAPABILITIES, WRITE_CAPABILITIES, type CapabilityName } from "../args.js";

/** Easel's name for each capability. */
export const EASEL_TOOL_NAMES: Record<CapabilityName, string> = {
  list_recipes: "browse_recipes", run_recipe: "start_recipe", generate: "make_output", ask_knowledge: "ask_knowledge_base",
  find_assets: "search_library", get_asset: "read_library_item", check_run: "check_on_run", my_usage: "my_spend",
};

/** A description as Easel reads it: the other tools it names, by Easel's names for them. */
const inEaselWords = (words: string) =>
  words.replace(new RegExp(`\\b(${Object.keys(EASEL_TOOL_NAMES).join("|")})\\b`, "g"), (m) => EASEL_TOOL_NAMES[m as CapabilityName]);

const easelTool = (name: CapabilityName, fn: Parameters<typeof s.function.run>[0]["fn"]) => {
  const cap = CAPABILITIES[name];
  return tool({
    name: EASEL_TOOL_NAMES[name], title: cap.title, description: inEaselWords(cap.description),
    annotations: WRITE_CAPABILITIES.includes(name) ? { readOnlyHint: false } : { readOnlyHint: true },
    ...(Object.keys(cap.input).length ? { input: cap.input as never } : {}),
    stack: [
      ...easelTurnKey(auth("id"), easel_turn),
      s.function.run({ fn, as: "out", input: {
        actor_id: auth("id"), via: c.text("easel"), connection_id: c.int(0), agent_label: c.text("Easel"), turn: ref("turn_key"), ...cap.args(),
      } }),
    ],
    response: ref("out"),
  });
};

export const studioAssistantTools = [
  easelTool("list_recipes", listRecipesToolFn),
  easelTool("run_recipe", runRecipeToolFn),
  easelTool("generate", generateToolFn),
  easelTool("ask_knowledge", askKnowledgeToolFn),
  easelTool("find_assets", findAssetsToolFn),
  easelTool("get_asset", getAssetToolFn),
  easelTool("check_run", checkRunToolFn),
  easelTool("my_usage", myUsageToolFn),
];
