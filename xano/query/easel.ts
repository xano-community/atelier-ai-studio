// GET studio/easel: whether Easel can answer, on which provider and model, and what an admin sets up when it can't. The panel
// reads it to say so before anyone types. Never returns a key.
import { c, fl, query, ref, s, withFilters } from "@xano/sdk";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import { easelReadyFn } from "../function/studio/easel.js";
import catalog from "../catalog.gen.json" with { type: "json" };
import { studioGroup } from "./studio.js";

/** The catalog's names for text models ("Gemini 3.8 Flash"), which Easel's models are. */
const MODEL_LABELS = Object.fromEntries((catalog.statements.text as { model: string; label: string }[]).map((m) => [m.model, m.label]));

export type EaselStatus = { ready: boolean; provider: string; model: string; label: string; key_name: string; setup: string };

export const easelStatusRoute = query({
  apiGroup: studioGroup, auth: user,
  name: "easel", verb: "GET",
  description: "Easel's provider and model, whether its key is set, and the setup step when it isn't.",
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: easelReadyFn, as: "easel" }),
    s.set_var("label", withFilters(c.obj(MODEL_LABELS), fl.get(ref("easel.model"), ref("easel.model")))),
  ],
  response: {
    ready: ref("easel.ready"), provider: ref("easel.provider"), model: ref("easel.model"), label: ref("label"), key_name: ref("easel.key_name"), setup: ref("easel.setup"),
  },
  responseShape: {} as EaselStatus,
});
