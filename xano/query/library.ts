// The Library's endpoints. Each is a thin door onto the library functions, which hold the read rule, so the assistant
// and agents get the same answers. A text item downloads from here with headers that make a browser save it and keep
// no copy; a file downloads through a one-minute signed link the screen fetches and saves.
import { apiGroup, auth, c, expr, fl, inp, input, or, query, ref, respond, s, withFilters } from "@xano/sdk";
import { mediaBytesFn } from "../function/library/media.js";
import { rbac } from "../rbac.js";
import { user } from "../table/user.js";
import {
  approveAssetFn, assetLinkFn, assetTextFn, deleteAssetFn, findAssetsFn, getAssetFn, libraryFacetsFn, APPROVE_WORDS,
  type LibraryItem, type LibraryPage,
} from "../function/library/library.js";

export const libraryGroup = apiGroup({ name: "library", canonical: "library", description: "The Library: everything the team made with AI, with how it was made." });

/** GET library/assets: the items this person may see, newest first, a page at a time. */
export const listAssets = query({
  apiGroup: libraryGroup, auth: user,
  name: "assets", verb: "GET",
  description: "Library items you may see, newest first: filter by kind (all, image, video, audio, text), approved only or drafts only, maker, recipe or title words; with each kind's counts by status, and, given where today, yesterday and this week start (ms, in your time zone), how many items each of those date groups holds.",
  input: {
    kind: input.text({ methods: ["trim"] }), approved_only: input.bool(), drafts_only: input.bool(), maker_id: input.int(), recipe_id: input.int(),
    q: input.text({ methods: ["trim"] }), page: input.int(), per_page: input.int(),
    today_from: input.int(), yesterday_from: input.int(), week_from: input.int(),
  },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: findAssetsFn, as: "found", input: {
      actor_id: auth("id"), kind: inp("kind"), approved_only: inp("approved_only"), drafts_only: inp("drafts_only"), maker_id: inp("maker_id"), recipe_id: inp("recipe_id"),
      q: inp("q"), page: inp("page"), per_page: inp("per_page"),
      today_from: inp("today_from"), yesterday_from: inp("yesterday_from"), week_from: inp("week_from"),
    } }),
  ],
  response: ref("found"),
  responseShape: {} as LibraryPage,
});

/** GET library/facets: the makers and recipes the filters offer. */
export const libraryFacets = query({
  apiGroup: libraryGroup, auth: user,
  name: "facets", verb: "GET",
  description: "Who made the items you may see, and which recipes made them: the Library's filter choices.",
  stack: [...rbac.signedIn(), s.function.run({ fn: libraryFacetsFn, as: "facets", input: { actor_id: auth("id") } })],
  response: ref("facets"),
  responseShape: {} as { makers: { id: number; name: string }[]; recipes: { id: number; name: string }[] },
});

/** GET library/assets/{id}: one item with how it was made, and a one-minute link to show or play its file. */
export const readAsset = query({
  apiGroup: libraryGroup, auth: user,
  name: "assets/{id}", verb: "GET",
  description: "One library item with its prompt, model, settings, inputs, maker, cost, run and step, and a one-minute link to its file.",
  input: { id: input.int({ required: true }) },
  stack: [...rbac.signedIn(), s.function.run({ fn: getAssetFn, as: "item", input: { asset_id: inp("id"), actor_id: auth("id") } })],
  response: ref("item"),
  responseShape: {} as LibraryItem,
});

/** GET library/assets/{id}/link: how to download it right now. Answers 200 even where files can't be linked. */
export const assetLink = query({
  apiGroup: libraryGroup, auth: user,
  name: "assets/{id}/link", verb: "GET",
  description: "How to download an item now: a signed link good for 60 seconds, the text route, or why neither works on this server.",
  input: { id: input.int({ required: true }) },
  stack: [...rbac.signedIn(), s.function.run({ fn: assetLinkFn, as: "link", input: { asset_id: inp("id"), actor_id: auth("id") } })],
  response: ref("link"),
  responseShape: {} as { how: "signed" | "table" | "text" | "unavailable"; url: string; blob_id: number; file_name: string; expires_in: number; mime: string },
});

/** GET library/assets/{id}/text: a text item's words as a file to save. Never cached, never shown as a page. */
export const assetText = query({
  apiGroup: libraryGroup, auth: user, history: false,
  name: "assets/{id}/text", verb: "GET",
  description: "Download a text item or transcript as a .txt file.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: assetTextFn, as: "text", input: { asset_id: inp("id"), actor_id: auth("id") } }),
    s.set_var("encoded_name", withFilters(ref("text.file_name"), fl.url_encode_rfc3986())),
    respond.header("Content-Type", "text/plain; charset=utf-8"),
    s.util.set_header({ value: withFilters(c.text('Content-Disposition: attachment; filename="'), fl.concat(ref("text.file_name")), fl.concat(c.text(`"; filename*=UTF-8''`)), fl.concat(ref("encoded_name"))), duplicates: "replace" }),
    respond.header("X-Content-Type-Options", "nosniff"),
    respond.header("Content-Security-Policy", "sandbox; default-src 'none'"),
    respond.header("Cache-Control", "private, no-store"),
  ],
  response: ref("text.body"),
});

/** POST library/assets/{id}/approve: approve an item for use. */
export const approveAsset = query({
  apiGroup: libraryGroup, auth: user,
  name: "assets/{id}/approve", verb: "POST",
  description: "Approve a library item for use outside the team. Members and admins; approving twice keeps the first approval.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.require("library.approve", APPROVE_WORDS.role),
    s.function.run({ fn: approveAssetFn, as: "approved", input: { asset_id: inp("id"), actor_id: auth("id") } }),
  ],
  response: ref("approved"),
  responseShape: {} as { id: number; status: "draft" | "approved"; approved_by: number; approved_at: number | null },
});

/** DELETE library/assets/{id}: delete an item and its file. Its maker or an admin. */
export const deleteAsset = query({
  apiGroup: libraryGroup, auth: user,
  name: "assets/{id}", verb: "DELETE",
  description: "Delete a library item and its file. Only the person who made it, or an admin.",
  input: { id: input.int({ required: true }) },
  stack: [...rbac.signedIn(), s.function.run({ fn: deleteAssetFn, as: "done", input: { asset_id: inp("id"), actor_id: auth("id") } })],
  response: ref("done"),
  responseShape: {} as { deleted: boolean },
});

/**
 * GET library/media/{id}: a table-kept image or recording's bytes (library/media.ts), only to someone allowed to see what it
 * belongs to. Each header is here on purpose: opened as a page, the file downloads and runs nothing, and nothing is cached.
 */
export const mediaBytes = query({
  apiGroup: libraryGroup, auth: user, history: false,
  name: "media/{id}", verb: "GET",
  description: "A made image or recording kept in a table, where this server can't sign private links.",
  input: { id: input.int({ required: true }) },
  stack: [
    ...rbac.signedIn(),
    s.function.run({ fn: mediaBytesFn, as: "stored", input: { blob_id: inp("id"), actor_id: auth("id") } }),
    s.set_var("shown_type", c.text("application/octet-stream")),
    s.conditional({ when: or(
      expr(withFilters(ref("stored.mime"), fl.starts_with("image/")), "=", c.bool(true)),
      expr(withFilters(ref("stored.mime"), fl.starts_with("audio/")), "=", c.bool(true)),
    ), then: [s.update_var("shown_type", ref("stored.mime"))] }),
    s.set_var("plain_name", withFilters(c.text("/[^A-Za-z0-9._ -]+/u"), fl.regex_replace(c.text("_"), ref("stored.name")))),
    s.set_var("encoded_name", withFilters(ref("stored.name"), fl.url_encode_rfc3986())),
    s.util.set_header({ value: withFilters(c.text("Content-Type: "), fl.concat(ref("shown_type"))), duplicates: "replace" }),
    s.util.set_header({ value: withFilters(c.text('Content-Disposition: attachment; filename="'), fl.concat(ref("plain_name")), fl.concat(c.text(`"; filename*=UTF-8''`)), fl.concat(ref("encoded_name"))), duplicates: "replace" }),
    respond.header("X-Content-Type-Options", "nosniff"),
    respond.header("Content-Security-Policy", "sandbox; default-src 'none'"),
    respond.header("Cache-Control", "private, no-store"),
    s.set_var("bytes", withFilters(ref("stored.b64"), fl.base64_decode())),
  ],
  response: ref("bytes"),
});

export const libraryQueries = [listAssets, libraryFacets, readAsset, assetLink, assetText, approveAsset, deleteAsset, mediaBytes];
