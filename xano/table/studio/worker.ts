import { f, table } from "@xano/sdk";

/** The name of the one row background steps sign in as. */
export const STEP_WORKER = "steps";

/**
 * Who background steps sign in as when the app calls itself to run one. It holds one system row that nobody has a key
 * to: a token for it is minted per step, lasts two minutes and names the step and attempt it may run. It is never a
 * person's sign-in or an agent's key, so a step can't be started with either.
 */
export const worker = table({
  name: "worker",
  description: "The system sign-in background steps use to call back into the app. One row; tokens are minted per step.",
  auth: true,
  schema: {
    name: f.text({ required: true }),
  },
  index: [{ type: "btree|unique", fields: [{ name: "name", op: "asc" }] }],
  seed: [{ name: STEP_WORKER }],
});
