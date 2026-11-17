// check_run: the run page's runs/view for an agent or Easel. Where a run stands, what waits on whom, and each step's words
// or a one-minute link to its file. A run the person can't see is not found, like one that doesn't exist.
import { c, defineFunction, fl, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { viewRunFn } from "../runs/control.js";
import { dollars } from "../spend/estimate.js";
import { actorInputs } from "./tooling.js";

export type ToolRunStep = { seq: number; label: string; kind: string; status: string; detail: string; text: string; url: string; asset_id: number };

export const checkRunToolFn = defineFunction({
  name: "studio/check_run",
  description: "A run the person may see: its status, what it cost, and each step's result.",
  input: { ...actorInputs, run_id: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: viewRunFn, as: "view", input: { run_id: inp("run_id"), actor_id: inp("actor_id") } }),
    dollars("spent_words", ref("view.run.spent")),
    dollars("estimate_words", ref("view.run.estimate")),
    s.array.map({ source: ref("view.steps"), as: "steps", transform: obj({
      seq: ref("$this.seq"), label: ref("$this.label"), kind: ref("$this.kind"), status: ref("$this.status"), detail: ref("$this.detail"),
      text: withFilters(ref("$this.output"), fl.get("text", ""), fl.first_notnull(c.text("")), fl.to_text(), fl.substr(0, 2000)),
      url: ref("$this.url"), asset_id: withFilters(ref("$this.asset_id"), fl.first_notnull(c.int(0))),
    }) }),
  ],
  response: {
    run_id: ref("view.run.id"), title: ref("view.run.title"), status: ref("view.run.status"), detail: ref("view.run.detail"),
    estimate: ref("estimate_words"), spent: ref("spent_words"), approval_id: ref("view.run.approval_id"),
    link: withFilters(c.text("/runs/"), fl.concat(ref("view.run.id"))), steps: ref("steps"),
  },
  responseShape: {} as { run_id: number; title: string; status: string; detail: string; estimate: string; spent: string; approval_id: number; link: string; steps: ToolRunStep[] },
});
