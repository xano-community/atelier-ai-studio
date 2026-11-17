// find_assets and get_asset: the Library's own library/find and library/get, so an agent sees exactly what the person
// would: drafts and approved items for the team, approved items only for a guest, and private ones only for their maker
// and admins. An item someone can't read is not found, the same as one that doesn't exist.
import { c, defineFunction, fl, inp, input, obj, ref, s, withFilters } from "@xano/sdk";
import { findAssetsFn, getAssetFn } from "../library/library.js";
import { actorInputs } from "./tooling.js";

export type ToolAsset = { id: number; kind: string; title: string; status: string; made_by: string | null; model: string; excerpt: string; link: string };

export const findAssetsToolFn = defineFunction({
  name: "studio/find_assets",
  description: "Library items the person may see, newest first, by words in the title, kind and approval.",
  input: {
    ...actorInputs,
    q: input.text({ methods: ["trim"] }),
    /** all, image, video, audio or text. */
    kind: input.enum(["all", "image", "video", "audio", "text"]),
    approved_only: input.bool(),
  },
  stack: [
    s.function.run({ fn: findAssetsFn, as: "found", input: {
      actor_id: inp("actor_id"), kind: withFilters(inp("kind"), fl.first_notempty(c.text("all"))), approved_only: inp("approved_only"),
      maker_id: c.int(0), recipe_id: c.int(0), q: inp("q"), page: c.int(1), per_page: c.int(10),
    } }),
    s.array.map({ source: ref("found.items"), as: "items", transform: obj({
      id: ref("$this.id"), kind: ref("$this.kind"), title: ref("$this.title"), status: ref("$this.status"), made_by: ref("$this.maker_name"),
      model: ref("$this.model"), excerpt: ref("$this.excerpt"), link: withFilters(c.text("/library/"), fl.concat(ref("$this.id"))),
    }) }),
  ],
  response: { items: ref("items"), total: ref("found.total") },
  responseShape: {} as { items: ToolAsset[]; total: number },
});

export type ToolAssetDetail = {
  id: number; kind: string; title: string; status: string; prompt: string; model: string; made_by: string; approved_by: string;
  words: string; url: string; link: string; from_run: number;
};

export const getAssetToolFn = defineFunction({
  name: "studio/get_asset",
  description: "One library item the person may see: how it was made, its words, and a one-minute link to its file.",
  input: { ...actorInputs, id: input.int({ required: true }) },
  stack: [
    s.function.run({ fn: getAssetFn, as: "item", input: { asset_id: inp("id"), actor_id: inp("actor_id") } }),
  ],
  response: {
    id: ref("item.id"), kind: ref("item.kind"), title: ref("item.title"), status: ref("item.status"), prompt: ref("item.prompt"), model: ref("item.model"),
    made_by: ref("item.maker_name"), approved_by: ref("item.approver_name"), words: withFilters(ref("item.body"), fl.substr(0, 4000)), url: ref("item.url"),
    link: withFilters(c.text("/library/"), fl.concat(ref("item.id"))), from_run: ref("item.run.id"),
  },
  responseShape: {} as ToolAssetDetail,
});
