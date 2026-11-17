// ask_knowledge: the Ask screen's knowledge/ask for an agent or Easel. The answer comes only from the team's sources, with
// each source it used, so the reply can cite them. It's an AI run through the spend gate like any other, which is why the
// tool needs a key that can write.
import { defineFunction, inp, input, obj, ref, s, withFilters, fl, c } from "@xano/sdk";
import { askFn, type AskView } from "../knowledge/ask.js";
import { actorInputs, idemKey, requestInput } from "./tooling.js";

export const askKnowledgeToolFn = defineFunction({
  name: "studio/ask_knowledge",
  description: "Answer a question only from the team's Knowledge sources, with citations, once per request.",
  input: { ...actorInputs, ...requestInput, question: input.text({ methods: ["trim"] }) },
  stack: [
    ...idemKey("ask_knowledge", obj({ question: withFilters(inp("question"), fl.first_notnull(c.text(""))) })),
    s.function.run({ fn: askFn, as: "asked", input: {
      actor_id: inp("actor_id"), question: inp("question"), idem_key: ref("idem_key"), via: inp("via"), connection_id: inp("connection_id"),
    } }),
  ],
  response: ref("asked"),
  responseShape: {} as AskView,
});
