// The app's call back into itself to run a background step. Only a token minted for the worker gets in, and it names the
// one step and attempt it may run: a person's sign-in or an agent's key can't start a step here. The driver that called
// starts the next step once this one answers. Request history is off: the call carries a token.
import { apiGroup, auth, c, expr, fl, guard, query, ref, s, withFilters } from "@xano/sdk";
import { worker } from "../table/studio/worker.js";
import { LOOP_GROUP, LOOP_PATH } from "../function/runs/background.js";
import { executeStepFn } from "../function/runs/execute_step.js";

export const studioLoopGroup = apiGroup({
  name: "studio-loop", canonical: LOOP_GROUP, history: false,
  description: "Background steps: the app's own call to run one step. Only a worker token minted for that step gets through.",
});

export const executeStepRoute = query({
  apiGroup: studioLoopGroup, auth: worker,
  name: LOOP_PATH, verb: "POST",
  description: "Run the one step this worker token names.",
  stack: [
    // Read whole: a token without these keys carries no step.
    s.set_var("extras", auth("extras")),
    s.set_var("step_id", withFilters(ref("extras"), fl.get("step_id", 0), fl.first_notnull(c.int(0)), fl.to_int())),
    s.set_var("attempt", withFilters(ref("extras"), fl.get("attempt", 0), fl.first_notnull(c.int(0)), fl.to_int())),
    guard.require([expr(ref("step_id"), ">", c.int(0)), expr(ref("attempt"), ">", c.int(0))], { errorType: "accessdenied", message: "This token can't run a step." }),
    s.function.run({ fn: executeStepFn, as: "ran", input: { step_id: ref("step_id"), attempt: ref("attempt") } }),
  ],
  response: { status: ref("ran.status"), outcome: ref("ran.outcome") },
  responseShape: {} as { status: string; outcome: string },
});

export const studioLoopQueries = [executeStepRoute];
