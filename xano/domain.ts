// The template's own backend: its tables, functions, endpoints, agent tools and assistant tools (BASELINE.md).
// xano/index.ts registers everything listed here, beside the base app and the modules. Put each def in its own
// file (table/<name>.ts, query/<group>.ts, query/<group>/<name>.ts, function/<name>.ts) and list it below.
//
// Every endpoint or tool that writes one of these tables calls `changed(...)` from ./base/index.js in the same
// stack, so open screens update live and the activity feed records it (audit-bundle.mjs checks). Runs, steps, the
// ledger and the month counters announce themselves through studio/changed instead (ids only, private runs to their
// owner alone).
import { ai_run } from "./table/studio/ai_run.js";
import { ai_step } from "./table/studio/ai_step.js";
import { budget_month } from "./table/studio/budget_month.js";
import { ledger } from "./table/studio/ledger.js";
import { price } from "./table/studio/price.js";
import { brand, brand_image } from "./table/studio/brand.js";
import { addImageFn, imageDataFn, readKitFn, removeImageFn, saveKitFn } from "./function/brand/kit.js";
import { settingsGroup, settingsQueries } from "./query/settings.js";
import { brandTests } from "./test/brand.js";
import { worker } from "./table/studio/worker.js";
import { asset } from "./table/library/asset.js";
import { gatewayErrorFn } from "./function/ai/gateway.js";
import { textFn } from "./function/ai/text.js";
import { imageFn } from "./function/ai/image.js";
import { videoFn } from "./function/ai/video.js";
import { musicFn } from "./function/ai/music.js";
import { speechFn } from "./function/ai/speech.js";
import { transcribeFn } from "./function/ai/transcribe.js";
import { embeddingFn } from "./function/ai/embedding.js";
import { rerankFn } from "./function/ai/rerank.js";
import { composeFn } from "./function/brand/compose.js";
import { storeFn } from "./function/library/store.js";
import { claimStepFn, executeStepFn, gateFn, recordStepFn, releaseUnsentFn } from "./function/runs/execute_step.js";
import { driveRunFn, goFn } from "./function/runs/background.js";
import { retryRunFn, stopRunFn, viewRunFn } from "./function/runs/control.js";
import { studioLoopGroup, studioLoopQueries } from "./query/studio-loop.js";
import { stepTests } from "./test/steps.js";
import { beginFn, monthRowsFn } from "./function/spend/begin.js";
import { setBudgetsFn, setPersonBudgetFn } from "./function/spend/budgets.js";
import { dollarsFn, estimateFn, rateFn } from "./function/spend/estimate.js";
import { reconcileFn, reconcileHourly } from "./function/spend/reconcile.js";
import { releaseFn } from "./function/spend/release.js";
import { settleFn } from "./function/spend/settle.js";
import { approveCostlyRun, approveOverBudget } from "./function/runs/approve.js";
import { finishRunFn, stepResultFn } from "./function/runs/finish.js";
import { askAdminFn, confirmRunFn, deriveKeyFn, startRunFn } from "./function/runs/start.js";
import { closeDecidedFn, expireApprovalsFn, finishSamplesFn, sweepEveryMinute, sweepFn } from "./function/runs/sweep.js";
import { aiStatusFn } from "./function/studio/ai_status.js";
import { studioChangedFn } from "./function/studio/changed.js";
import { studioGroup, studioQueries } from "./query/studio.js";
import { playgroundQueries } from "./query/playground.js";
import { checkModelsFn, modelStateFn } from "./function/studio/catalog.js";
import { historyFn, useOutputFn } from "./function/studio/playground.js";
import { spendTests } from "./test/spend.js";
import { runTests } from "./test/runs.js";
import { playgroundTests } from "./test/playground.js";
import { kb_source } from "./table/knowledge/kb_source.js";
import { kb_passage } from "./table/knowledge/kb_passage.js";
import { chunkFn } from "./function/knowledge/chunk.js";
import { transcriptParseFn } from "./function/knowledge/transcript_parse.js";
import { absorbStepFn } from "./function/knowledge/absorb.js";
import { settleSourceFn, tidySourcesFn } from "./function/knowledge/settle.js";
import { addSourceFn, retrySourceFn } from "./function/knowledge/ingest.js";
import { askComposeFn, askFn, askRetrieveFn, askStartFn, askViewFn, recentQuestionsFn } from "./function/knowledge/ask.js";
import { knowledgeGroup, knowledgeQueries } from "./query/knowledge.js";
import { knowledgeTests } from "./test/knowledge.js";
import { libraryFunctions } from "./function/library/library.js";
import { mediaFunctions } from "./function/library/media.js";
import { media_blob } from "./table/library/media_blob.js";
import { libraryGroup, libraryQueries } from "./query/library.js";
import { libraryTests } from "./test/library.js";

import { recipe } from "./table/recipes/recipe.js";
import { recipe_step } from "./table/recipes/recipe_step.js";
import { fillStepFn, planFn } from "./function/recipes/plan.js";
import { deleteRecipeFn, estimateRecipeFn, listRecipesFn, saveRecipeFn, startRecipeFn, viewRecipeFn } from "./function/recipes/recipes.js";
import { recipeQueries } from "./query/recipes.js";
import { keyQueries } from "./query/keys.js";
import { recipeTests } from "./test/recipes.js";
import { homeFn } from "./function/studio/home.js";
import { checkAiFn } from "./function/studio/check_ai.js";
import { listPricesFn, raiseForRunFn, setPriceFn, usageFn } from "./function/spend/usage.js";
import { usageQueries } from "./query/usage.js";
import { usageTests } from "./test/usage.js";
import { easel_turn } from "./table/studio/easel_turn.js";
import { agentGateFn, agentKeysMember, runAnswerFn } from "./function/studio/tooling.js";
import { listRecipesToolFn } from "./function/studio/list_recipes.js";
import { runRecipeToolFn } from "./function/studio/run_recipe.js";
import { generateToolFn } from "./function/studio/generate.js";
import { askKnowledgeToolFn } from "./function/studio/ask_knowledge.js";
import { findAssetsToolFn, getAssetToolFn } from "./function/studio/find_assets.js";
import { checkRunToolFn } from "./function/studio/check_run.js";
import { myUsageToolFn } from "./function/studio/my_usage.js";
import { easelFunctions, easelMember, easelTurnClose, easelTurnOpen } from "./function/studio/easel.js";
import { easelStatusRoute } from "./query/easel.js";
import { authSetup, authStatus, runSetupFn } from "./query/authentication/setup.js";
import { aiStateFn } from "./function/studio/ai_state.js";
import { studioMcpTools } from "./tools/mcp/tools.js";
import { studioAssistantTools } from "./tools/assistant/tools.js";
import { toolTests } from "./test/tools.js";
import { firstRunTests } from "./test/firstrun.js";
import "./seed.js";

export const tables = [price, budget_month, ai_run, ai_step, ledger, worker, brand, brand_image, asset, media_blob, kb_source, kb_passage, recipe, recipe_step, easel_turn];
export const functions = [
  rateFn, estimateFn, dollarsFn, monthRowsFn, beginFn, settleFn, releaseFn, reconcileFn, setBudgetsFn, setPersonBudgetFn,
  studioChangedFn, aiStatusFn, checkModelsFn, historyFn, useOutputFn,
  startRunFn, askAdminFn, confirmRunFn, approveCostlyRun, approveOverBudget, finishRunFn, stepResultFn,
  expireApprovalsFn, closeDecidedFn, finishSamplesFn, sweepFn,
  gatewayErrorFn, composeFn, readKitFn, saveKitFn, addImageFn, removeImageFn, imageDataFn, textFn, imageFn, videoFn, musicFn, speechFn, transcribeFn, embeddingFn, rerankFn, storeFn,
  gateFn, releaseUnsentFn, claimStepFn, recordStepFn, executeStepFn, driveRunFn, goFn, stopRunFn, retryRunFn, viewRunFn,
  chunkFn, transcriptParseFn, absorbStepFn, settleSourceFn, tidySourcesFn, addSourceFn, retrySourceFn, askStartFn, askRetrieveFn, askComposeFn, askViewFn, askFn, recentQuestionsFn,
  ...libraryFunctions, ...mediaFunctions,
  modelStateFn, deriveKeyFn, planFn, fillStepFn, estimateRecipeFn, saveRecipeFn, viewRecipeFn, listRecipesFn, deleteRecipeFn, startRecipeFn,
  homeFn, usageFn, listPricesFn, setPriceFn, raiseForRunFn, checkAiFn, aiStateFn, runSetupFn,
  agentGateFn, runAnswerFn, listRecipesToolFn, runRecipeToolFn, generateToolFn, askKnowledgeToolFn, findAssetsToolFn, getAssetToolFn, checkRunToolFn, myUsageToolFn, ...easelFunctions,
];
/** Easel's chat routes (who may use it, a provider-billed turn row around each message) and the agent-key routes. index.ts attaches them. */
export const middlewares = [easelMember, easelTurnOpen, easelTurnClose, agentKeysMember];
export const apiGroups = [studioGroup, studioLoopGroup, knowledgeGroup, settingsGroup, libraryGroup];
export const queries = [...studioQueries, ...playgroundQueries, ...studioLoopQueries, ...knowledgeQueries, ...settingsQueries, ...libraryQueries, ...recipeQueries, ...keyQueries, ...usageQueries, easelStatusRoute, authStatus, authSetup];

/** Scheduled tasks: the minute sweep and the hourly check of the budget counters against the ledger. */
export const tasks = [sweepEveryMinute, reconcileHourly];

/** Workflow tests, run by `deploy --test`. Each builds its own people, prices and settings: a test run starts empty. */
export const workflowTests = [...spendTests, ...runTests, ...stepTests, ...playgroundTests, ...knowledgeTests, ...brandTests, ...libraryTests, ...recipeTests, ...usageTests, ...toolTests, ...firstRunTests];

/** MCP tools (AGENT-ACCESS.md §2): `agent.tool({...})` defs. index.ts adds `approvals.checkTool("mcp")`. */
export const agentTools = studioMcpTools;
export const agentPrompts = [];
export const agentResources = [];

/** The assistant's domain tools (CHATBOT.md §1): `tool({...})` defs. The base adds what-changed and notifications. */
export const assistantTools = studioAssistantTools;

/** The domain half of the assistant's system prompt: what the app is, its records and roles, which tool when. */
export const assistantPrompt = [
  "You are Easel, the assistant inside Atelier, Marlow's AI studio. People here make marketing copy, images, video, voiceovers and music with AI, keep what they make in the Library, and ground it in the team's Knowledge and brand kit.",
  "The records: recipes (saved, reusable chains of AI steps, run by slug), runs (one request to make something, with steps and an estimated cost), Library items (each image, video, audio or text that was made, a draft until someone approves it for use), Knowledge sources (brand guides, product notes, call recordings) and each person's monthly budget.",
  "Which tool when: browse_recipes then start_recipe for a repeatable job the team has a recipe for; make_output for a single text, image, video, speech or music; search_library then read_library_item to find something already made (prefer approved items when the person wants something to publish); ask_knowledge_base for any question about the brand, products or customers, quoting its citations; check_on_run to see how a run is going or what it made; my_spend for budgets and spend.",
  "To start from a Library picture, pass its id as from_asset. Video and music finish in the background: say it's under way and offer to check on it.",
  "Spending: every run is charged to the person who asked, against their budget. Any video by a member, and anything above the approval line, waits for an admin's approval before anything is made or charged; an admin's own run above the line waits for them to confirm it in the app. You can't approve or confirm anything yourself. Before a costly or video run, say what it will make and its estimate.",
  "When a tool answers waiting_approval, say an admin's approval is needed and include the lines `approval_id: <id>` and `run_id: <id>`. When it answers waiting_confirmation, say they confirm it in the app and include the line `run_id: <id>`. The app shows a card from those lines.",
  "A tool's refusal is the answer: say plainly why and what the person can do instead. Never make up a recipe, item, run, source or price.",
].join(" ");
