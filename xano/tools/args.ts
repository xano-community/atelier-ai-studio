// The arguments and descriptions both tool sets share. An MCP tool and Easel's tool for one capability take the same
// arguments, say the same thing to the model, and call the same shared function; only how the caller signs in differs.
import { input, inp, type Value } from "@xano/sdk";
import { DEFAULT_MODELS, GENERATE_KINDS } from "../function/studio/generate.js";
import catalog from "../catalog.gen.json" with { type: "json" };

/** The catalog's models for a kind, as a model reads them in a description. */
const modelsOf = (kind: string) => {
  const list = (catalog.statements as Record<string, { model: string }[]>)[kind] ?? [];
  return list.map((m) => m.model).join(", ");
};

const REQUEST_ID = input.text({ methods: ["trim"], description: "Your own id for this request. Send the same one when you retry, so it isn't done twice." });

type Capability = { title: string; description: string; input: Record<string, unknown>; args: () => Record<string, Value> };

const pass = (names: string[]) => () => Object.fromEntries(names.map((n) => [n, inp(n)]));

export const CAPABILITIES = {
  list_recipes: {
    title: "List the team's recipes",
    description: "The team's published recipes: slug, what each makes, the inputs it asks for, its estimated cost, and a link. Use it before run_recipe.",
    input: {},
    args: pass([]),
  },
  run_recipe: {
    title: "Run a recipe",
    description: "Start a published recipe for the person, by its slug from list_recipes, with its text inputs by name. Answers at once with the run id and its estimate. A costly run or any video by a member waits for an admin's approval, and an admin's own run above the approval line waits for their click in the app: then it is NOT started, and the answer says so. Recipes that need an uploaded file are run in the app.",
    input: { recipe: input.text({ required: true, methods: ["trim"], description: "The recipe's slug." }), inputs: input.json({ description: "The recipe's inputs by name: { \"product\": \"City 3\" }." }), request_id: REQUEST_ID },
    args: pass(["recipe", "inputs", "request_id"]),
  },
  generate: {
    title: "Make text, an image, a video, speech or music",
    description: `Make one output for the person, charged to their budget. kind: ${GENERATE_KINDS.join(", ")}. Models (default first): text ${DEFAULT_MODELS.text} (${modelsOf("text")}); image ${DEFAULT_MODELS.image} (${modelsOf("image")}); video ${DEFAULT_MODELS.video} (${modelsOf("video")}); speech ${DEFAULT_MODELS.speech}; music ${DEFAULT_MODELS.music}. from_asset starts from a Library item: a picture becomes the image to edit or the video's first frame. Text, image and speech answer with the result; video and music answer at once, so check them with check_run. Every video by a member, and anything above the approval line, waits for an admin's approval; an admin's own run above the line waits for their click in the app. Then nothing is made yet, and the answer says so.`,
    input: {
      kind: input.enum(GENERATE_KINDS, { required: true }),
      prompt: input.text({ required: true, methods: ["trim"], description: "What to make. For speech, the words to say." }),
      model: input.text({ methods: ["trim"], description: "A model for the kind. Leave it out for the default." }),
      options: input.json({ description: "Video: { seconds (4-8), aspect_ratio (\"16:9\", \"9:16\"), resolution (\"720p\", \"1080p\"), audio (true/false) }. Image: { size (\"1K\", \"2K\"), aspect_ratio }. Text: { output_tokens }." }),
      voice: input.text({ methods: ["trim"], description: "Speech only: a voice name, or leave it out for the brand kit's." }),
      from_asset: input.int({ description: "A Library item's id to start from (find_assets)." }),
      use_brand: input.bool({ nullable: true, description: "Add the brand kit to the prompt. On unless you turn it off." }),
      title: input.text({ methods: ["trim"], description: "A short name for what's made." }),
      request_id: REQUEST_ID,
    },
    args: pass(["kind", "prompt", "model", "options", "voice", "from_asset", "use_brand", "title", "request_id"]),
  },
  ask_knowledge: {
    title: "Ask the knowledge base",
    description: "Answer a question only from the team's Knowledge sources (brand guides, product notes, call recordings), with numbered citations to each source used. It is an AI run charged to the person's budget. Quote the citations; never add facts they don't hold.",
    input: { question: input.text({ required: true, methods: ["trim"], description: "The question, in plain words." }), request_id: REQUEST_ID },
    args: pass(["question", "request_id"]),
  },
  find_assets: {
    title: "Find Library items",
    description: "Library items the person may see, newest first: by words in the title, kind (all, image, video, audio, text) and approved_only. Each has an id for get_asset and generate's from_asset, its status (draft or approved) and a link.",
    input: {
      q: input.text({ methods: ["trim"], description: "Words in the title." }),
      kind: input.enum(["all", "image", "video", "audio", "text"]),
      approved_only: input.bool({ description: "Only items approved for use." }),
    },
    args: pass(["q", "kind", "approved_only"]),
  },
  get_asset: {
    title: "Read a Library item",
    description: "One Library item: how it was made (prompt, model, who made and approved it), its words, a one-minute link to its file, and its link in the app.",
    input: { id: input.int({ required: true, description: "The item's id from find_assets." }) },
    args: pass(["id"]),
  },
  check_run: {
    title: "Check a run",
    description: "Where a run stands (queued, running, waiting for approval or confirmation, done, partial, failed), what it cost, and each step's words or a one-minute link to its file.",
    input: { run_id: input.int({ required: true, description: "The run id a tool answered with." }) },
    args: pass(["run_id"]),
  },
  my_usage: {
    title: "My AI spend this month",
    description: "What the person has spent on AI this month, what's held for runs under way, what's left of their budget, and the approval line. Admins also get the team's.",
    input: {},
    args: pass([]),
  },
} satisfies Record<string, Capability>;

export type CapabilityName = keyof typeof CAPABILITIES;
/** Capabilities that start a run and write runs and ledger rows: never read-only. */
export const WRITE_CAPABILITIES: CapabilityName[] = ["run_recipe", "generate", "ask_knowledge"];
