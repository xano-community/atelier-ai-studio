// What the tool sets are, as built: the MCP server offers exactly twelve tools, the ones that start a run aren't read-only
// (so a read-only key can't call them), every studio MCP tool checks the person before its shared function, each Easel tool
// calls the same function as its MCP twin, and Easel with no model key answers without a model call.
import { describe, expect, it } from "vitest";
import { s } from "@xano/sdk";
import { bot, mcpTools } from "./index";
import { MOST_TOOLS, withinToolLimit } from "./agents/tool-limit";
import { studioMcpTools } from "./tools/mcp/tools";
import { EASEL_TOOL_NAMES, studioAssistantTools } from "./tools/assistant/tools";
import { agentGateFn } from "./function/studio/tooling";

type Encoded = { name?: string; context?: Record<string, unknown> };
const fnId = (fn: Parameters<typeof s.function.run>[0]["fn"]) =>
  ((s.function.run({ fn, as: "x" }) as unknown as Encoded).context as { function: { id: string } }).function.id;
const calls = (stack: unknown) => (stack as Encoded[])
  .filter((st) => st.name === "mvp:function")
  .map((st) => (st.context as { function: { id: string } }).function.id);

const tools = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `tool_${i}` }));

describe("the MCP server's tools", () => {
  it("are exactly twelve: the base app's three, the studio's eight and checking on approvals", () => {
    expect(mcpTools.map((t) => t.name)).toEqual([
      "whats_new", "my_notifications", "request_role_change",
      "list_recipes", "run_recipe", "generate", "ask_knowledge", "find_assets", "get_asset", "check_run", "my_usage",
      "check_approval",
    ]);
    expect(MOST_TOOLS).toBe(12);
  });

  it("stop the build at a thirteenth", () => {
    expect(withinToolLimit(tools(12))).toHaveLength(12);
    expect(() => withinToolLimit(tools(13))).toThrow(/13 tools, and the limit is 12/);
    expect(() => withinToolLimit([...mcpTools, { name: "one_more" }])).toThrow(/one_more/);
  });

  it("mark the three that start a run as writing, so a read-only key is refused, and the rest as reading", () => {
    const readOnly = Object.fromEntries(mcpTools.map((t) => [t.name, (t as { annotations?: { readOnlyHint?: boolean } }).annotations?.readOnlyHint]));
    for (const name of ["run_recipe", "generate", "ask_knowledge", "request_role_change"]) expect(readOnly[name], name).toBe(false);
    for (const name of ["list_recipes", "find_assets", "get_asset", "check_run", "my_usage", "whats_new", "my_notifications", "check_approval"]) expect(readOnly[name], name).toBe(true);
  });

  it("each check the person behind the connection (guests refused) before calling their shared function", () => {
    const gate = fnId(agentGateFn);
    for (const t of studioMcpTools) {
      const ids = calls((t as { stack: unknown }).stack);
      expect(ids[0], t.name).toBe(gate);
      expect(ids).toHaveLength(2);
    }
  });
});

describe("Easel's tools", () => {
  it("call the same shared function as their MCP twins", () => {
    const byName = Object.fromEntries(studioAssistantTools.map((t) => [t.name, t]));
    for (const mcp of studioMcpTools) {
      const easel = byName[EASEL_TOOL_NAMES[mcp.name as keyof typeof EASEL_TOOL_NAMES]];
      expect(easel, mcp.name).toBeDefined();
      const shared = calls((mcp as { stack: unknown }).stack).at(-1);
      expect(calls((easel as { stack: unknown }).stack)).toEqual([shared]);
    }
  });

  it("never name an MCP tool, so the two sets can't collide", () => {
    const mcpNames = new Set(mcpTools.map((t) => t.name));
    for (const t of studioAssistantTools) expect(mcpNames.has(t.name), t.name).toBe(false);
  });
});

describe("Easel's reply", () => {
  const stack = (bot.replyFn as unknown as { stack: Encoded[] }).stack;
  const choice = stack.find((st) => st.name === "mvp:conditional" && JSON.stringify(st.context?.expr).includes("easel.ready"));
  const branch = (key: "if" | "else") => JSON.stringify((choice?.context as Record<string, unknown>)[key]);

  it("has no model call outside the choice of provider", () => {
    expect(stack.filter((st) => st.name === "mvp:call_agent")).toHaveLength(0);
    expect(choice).toBeDefined();
  });

  it("with no model key, answers the setup step and makes no model call", () => {
    expect(branch("if")).toContain("The assistant needs a model key.");
    expect(branch("if")).not.toContain("mvp:call_agent");
  });

  it("with a key, runs the chosen provider's agent and records its usage", () => {
    expect(branch("else").match(/mvp:call_agent/g)).toHaveLength(3);
  });
});
