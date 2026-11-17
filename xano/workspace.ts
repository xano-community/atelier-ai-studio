// Workspace settings — generated from a Xano bundle.
import { workspaceConfig } from "@xano/sdk";

export const workspaceSettings = workspaceConfig({
  name: "ai-studio",
  // AGENT_PROVIDER picks Easel's model: `anthropic` or `google-genai`, each with its own key and model, or `xano-ai` once the
  // Xano AI Router runs agents with tools. The keys stay empty in the template: with none set, Easel says what to add.
  env: {
    MCP_OAUTH_LOGIN_URL: "",
    // The token that lets the first admin set up a production deploy (xano/production.ts). Empty: setup is off.
    SETUP_TOKEN: "",
    AGENT_PROVIDER: "google-genai", ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "claude-opus-5-5", GEMINI_API_KEY: "", GEMINI_MODEL: "gemini-4-hydrogen",
    // What the last deploy said about Xano AI, written after it by `npm run xano:deploy` (scripts/deploy.mjs). Until then, refusals decide.
    XANO_AI_DEPLOY: "unreported",
  },
});
