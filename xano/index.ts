// The workspace: the base app and every module, wired around the template's own domain (xano/domain.ts).
// Owned by the base app (modules/base). A template edits app.ts, domain.ts, rbac.ts, agent.ts and approvals.ts;
// it doesn't need to touch this file.
import { workspace } from "@xano/sdk";
import { APPROVALS_PROMPT_RULE, registerAgents } from "@xano-sdk/agents";
import { createChatbot } from "@xano-sdk/chatbot";
import { registerMcpOauth } from "@xano-sdk/mcp-oauth";
import { Getting_Started_Template_create_event_log } from "./_shared.js";
import { Authentication } from "./query/authentication.js";
import { auth_login } from "./query/authentication/auth_login_POST.js";
import { auth_me } from "./query/authentication/auth_me_GET.js";
import { auth_signup } from "./query/authentication/auth_signup_POST.js";
import { account } from "./table/account.js";
import { event_log } from "./table/event_log.js";
import { user } from "./table/user.js";
import { workspaceSettings } from "./workspace.js";
import { APP } from "./app.js";
import { BASE_ASSISTANT_RULES, baseAssistantTools, registerBase } from "./base/index.js";
import { baseAgentTools, connected } from "./base/agent-tools.js";
import { agent, mcpOauthOptions } from "./agent.js";
import { approvals } from "./approvals.js";
import { rbac } from "./rbac.js";
import * as domain from "./domain.js";
import { withinToolLimit } from "./agents/tool-limit.js";
import { EASEL_MAX_STEPS, easelMember, easelTurnClose, easelTurnOpen, wireEasel } from "./function/studio/easel.js";
import { agentKeysMember } from "./function/studio/tooling.js";

const app = workspace(APP.slug)
  .registerWorkspace(workspaceSettings)
  .registerMiddleware(domain.middlewares)
  .registerTables([user, account, event_log, ...domain.tables])
  .registerFunctions([Getting_Started_Template_create_event_log, ...domain.functions])
  .registerApiGroups([Authentication, ...domain.apiGroups])
  .registerQueries([auth_signup, auth_login, auth_me, ...domain.queries])
  .registerTasks(domain.tasks)
  .registerWorkflowTests(domain.workflowTests);

registerBase(app);

// Agents (AGENT-ACCESS.md): the MCP server with the base and domain tools, its ChatGPT/Claude sign-in twin, approvals.
// Guests can't connect an agent: the key routes refuse them, and every tool refuses a guest's connection.
agent.group.middleware = { pre: [agentKeysMember] };
// The module's approval check reads `conn` without asking whether its sign-in row exists yet: it gets the base tools' first
// statements too, before agent.serve builds it and its sign-in twin.
const checkApproval = approvals.checkTool("mcp");
const checkSpec = (checkApproval as unknown as Record<symbol, { stack: unknown[] } | undefined>)[Symbol.for("@xano-sdk/agents.tool-spec")];
if (!checkSpec) throw new Error("approvals.checkTool no longer carries its tool spec: check @xano-sdk/agents before upgrading it.");
checkSpec.stack.unshift(...connected());
export const mcpTools = withinToolLimit([...baseAgentTools, ...domain.agentTools, checkApproval]);
agent.serve({ tools: mcpTools, prompts: domain.agentPrompts, resources: domain.agentResources });
registerMcpOauth(app, mcpOauthOptions);
registerAgents(app, { access: agent, approvals });
rbac.register(app);

// Easel, the assistant (CHATBOT.md): the base tools, the studio's, and checking on approvals, on the model AGENT_PROVIDER
// picks (function/studio/easel.ts). Each message opens a provider-billed turn row, and guests can't use it.
const assistantTools = [...baseAssistantTools, ...domain.assistantTools, approvals.checkTool("assistant")];
export const bot = createChatbot({
  authTable: user, canonical: "chat", tools: assistantTools,
  llm: {
    type: "anthropic", apiKey: "{{ $env.ANTHROPIC_API_KEY }}", model: "{{ $env.ANTHROPIC_MODEL }}", maxSteps: EASEL_MAX_STEPS,
    systemPrompt: [domain.assistantPrompt, BASE_ASSISTANT_RULES, APPROVALS_PROMPT_RULE].join(" "),
  },
});
const easelAgents = wireEasel(bot);
bot.group.middleware = { pre: [easelMember] };
bot.authenticated.sendMessage.middleware = { pre: [easelTurnOpen], post: [easelTurnClose] };
app.registerTables([bot.conversation, bot.message]).registerAgents([bot.agent, ...easelAgents]).registerFunctions([bot.replyFn])
  .registerApiGroups([bot.group]).registerQueries(bot.queries);
app.registerTools(assistantTools);   // the package only references tools: register them on the workspace too
export default app;                  // the default export must be the workspace

export { Authentication, account, auth_login, auth_me, auth_signup, event_log, user, workspaceSettings };
