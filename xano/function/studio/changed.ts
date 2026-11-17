// Live updates for runs, ids only. The base app's app/changed publishes on `app`, which every signed-in tab hears, and a
// private Playground run is nobody else's business. So a run's changes go to its owner's own channel, and to `app` only
// when the run is visible to the team. Each screen refetches what its person may see.
import { c, defineFunction, expr, fl, inp, input, obj, s, withFilters, type Value } from "@xano/sdk";
import { live } from "../../base/live.js";

export const studioChangedFn = defineFunction({
  name: "studio/changed",
  description: "Tell open screens a run, step or budget changed: on the owner's channel, and on app unless it's private.",
  input: {
    entity: input.text({ required: true }), id: input.int(), op: input.text(),
    owner_id: input.int({ required: true }), private: input.bool(),
  },
  stack: [
    s.realtime.publish({ server: live, channel: withFilters(c.text("users/"), fl.concat(inp("owner_id"))), message: c.text("changed"),
      data: obj({ entity: inp("entity"), id: inp("id"), op: inp("op") }) }),
    s.conditional({ when: expr(inp("private"), "!=", c.bool(true)), then: [
      s.realtime.publish({ server: live, channel: c.text("app"), message: c.text("changed"), data: obj({ entity: inp("entity"), id: inp("id"), op: inp("op") }) }),
    ] }),
  ],
  response: { ok: c.bool(true) },
});

/** After a write to a run: `studioChanged({ entity: "ai_run", id: ref("run.id"), owner: ref("run.owner_id"), private: ref("run.private") })`. */
export const studioChanged = (o: { entity: string; id: Value; owner: Value; private: Value; op?: string }) =>
  s.function.run({ fn: studioChangedFn, as: "_studio_changed", input: { entity: c.text(o.entity), id: o.id, op: c.text(o.op ?? "updated"), owner_id: o.owner, private: o.private } });
