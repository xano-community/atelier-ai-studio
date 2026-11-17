import { f, table } from "@xano/sdk";
import { user } from "../user.js";

export const EASEL_TURN_STATES = ["open", "done", "failed", "no_key"] as const;

/**
 * One message someone sent Easel, the in-app assistant, and what its own model turn used. Easel's model is billed by the
 * deployer's provider (Anthropic or Google), not Xano credits, so these rows are shown on Usage as provider-billed and never
 * counted against a budget. Anything Easel makes with a tool is a run of its own, charged to the person like any other.
 */
export const easel_turn = table({
  name: "easel_turn",
  description: "One message to Easel and the provider-billed usage of its model turn. Not counted against budgets.",
  schema: {
    user_id: f.tableRef(user, { required: true }),
    conversation_id: f.int(),
    /** anthropic, google-genai or xano-ai, and the model, when the turn started. */
    provider: f.text(),
    model: f.text(),
    status: f.enum(EASEL_TURN_STATES, { default: "open" }),
    input_tokens: f.int(),
    output_tokens: f.int(),
    /** The provider's usage as it reported it. */
    usage: f.json(),
    /** The names of the tools the turn used, in order. */
    tools: f.json(),
    finished_at: f.timestamp({ nullable: true }),
  },
  index: [
    { type: "btree", fields: [{ name: "user_id", op: "asc" }, { name: "created_at", op: "desc" }] },
    { type: "btree", fields: [{ name: "conversation_id", op: "asc" }, { name: "status", op: "asc" }] },
  ],
});
