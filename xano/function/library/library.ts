// The Library: what the team made with AI, each item with how it was made. One read rule for every door (the screens,
// the assistant and agents call these same functions):
//   - a private Playground output is its maker's and the admins' alone, until its maker chooses "Use this";
//   - an item in the team's library is anyone's on the team but a guest's;
//   - a guest sees approved items only.
// An item someone can't read answers exactly as one that doesn't exist, and a file link is made only after the rule
// passes. Files are private: a link lasts a minute.
import { and, c, cmp, col, cond, defineFunction, expr, fl, guard, inp, input, obj, or, qf, ref, s, withFilters, type Value } from "@xano/sdk";
import { agent } from "../../agent.js";
import { changed } from "../../base/functions.js";
import { rbac } from "../../rbac.js";
import { asset, ASSET_KINDS } from "../../table/library/asset.js";
import { recipe } from "../../table/recipes/recipe.js";
import { ai_run } from "../../table/studio/ai_run.js";
import { ai_step } from "../../table/studio/ai_step.js";
import { user } from "../../table/user.js";
import { mediaLinkFn } from "./media.js";
import { media_blob } from "../../table/library/media_blob.js";

export const NO_SUCH_ITEM = "That item isn't in the Library.";
const NOT_FOUND = { errorType: "notfound", message: NO_SUCH_ITEM } as const;
const ADMINS = rbac.rolesWith("budgets.manage");
/** How long a link to a private file lasts. */
export const LIBRARY_LINK_SECONDS = 60;
/** The kind tabs, and the item kinds each holds. */
export const KIND_GROUPS: Record<string, string[]> = {
  all: [...ASSET_KINDS], image: ["image"], video: ["video"], audio: ["speech", "music"], text: ["text", "transcript"],
};
export const TEXT_KINDS = ["text", "transcript"];
const PAGE_DEFAULT = 60;
const PAGE_MOST = 120;
/** How much of a text item a tile shows: enough to fill a card that has a whole tile's place to itself. */
const EXCERPT = 560;
export const APPROVE_WORDS = {
  role: "Your role can't approve library items. Ask a member or an admin.",
  private: "Only items in the team's library can be approved. Choose Use this on the Playground result first.",
};
export const DELETE_WORDS = "Only the person who made it, or an admin, can delete it.";
export const NO_LINK_WORDS = "This server can't make private video links (a Xano Engine on your machine can't). Deploy to Xano cloud to play or download it.";

/** Whether `actor` may read the item in `row`, by the rule above. */
const readable = (row: string, actor: string) => or(
  expr(ref(`${row}.maker_id`), "=", ref(`${actor}.id`)),
  cond.in(ref(`${actor}.role`), c.array(ADMINS)),
  and(expr(ref(`${row}.private`), "!=", c.bool(true)), expr(ref(`${actor}.role`), "!=", c.text("guest"))),
  and(expr(ref(`${row}.private`), "!=", c.bool(true)), expr(ref(`${row}.status`), "=", c.text("approved"))),
);

/** Load the item and the person, and refuse (as not found) an item they can't read. Binds `item` and `actor`. */
const openItem = (assetId: Value, actorId: Value) => [
  s.db.get({ table: asset, fieldValue: assetId, as: "item" }),
  guard.found("item", NOT_FOUND),
  s.db.get({ table: user, fieldValue: actorId, output: ["id", "role", "name"], as: "actor" }),
  guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
  guard.require(readable("item", "actor"), NOT_FOUND),
];

/**
 * How to show the item's file now (library/media.ts): words are read from the text route; a file is a one-minute link, or
 * its table-kept bytes by id where this server can't sign links; a file that's only in private storage on such a server
 * (a video on the Xano Engine) is `unavailable` until it runs on Xano cloud. Binds `url`, `how` and `blob_id` by the names given.
 */
const showFile = (url: string, how: string, blob: string) => [
  s.set_var(url, c.text("")),
  s.set_var(blob, c.int(0)),
  s.set_var(how, c.text("text")),
  s.conditional({ when: cond.notIn(ref("item.kind"), c.array(TEXT_KINDS)), then: [
    s.function.run({ fn: mediaLinkFn, as: "item_link", input: { file: ref("item.file"), ttl: c.int(LIBRARY_LINK_SECONDS) } }),
    s.update_var(url, ref("item_link.url")),
    s.update_var(blob, ref("item_link.blob_id")),
    s.update_var(how, withFilters(c.obj({ signed: "signed", table: "table" }), fl.get(ref("item_link.how"), "unavailable"), fl.first_notnull(c.text("unavailable")))),
  ] }),
];

/** A name to save the item under: its title made safe, and the file's own extension (".txt" for words). */
const saveName = (as: string) => [
  s.set_var("_ext", c.text("txt")),
  s.set_var("_stored_name", withFilters(ref("item.file"), fl.get("name", ""), fl.first_notnull(c.text("")), fl.to_text())),
  s.conditional({ when: expr(withFilters(ref("_stored_name"), fl.contains(c.text("."))), "=", c.bool(true)), then: [
    s.update_var("_ext", withFilters(ref("_stored_name"), fl.split("."), fl.last(), fl.lower())),
  ] }),
  s.set_var("_base", withFilters(c.text("/[^A-Za-z0-9 ._-]+/u"), fl.regex_replace(c.text(""), withFilters(ref("item.title"), fl.first_notnull(c.text("")), fl.to_text())))),
  s.update_var("_base", withFilters(c.text("/\\s+/u"), fl.regex_replace(c.text(" "), ref("_base")), fl.trim(), fl.substr(c.int(0), c.int(80)), fl.trim())),
  s.conditional({ when: expr(ref("_base"), "=", c.text("")), then: [s.update_var("_base", withFilters(c.text("atelier-"), fl.concat(ref("item.kind")), fl.concat(c.text("-")), fl.concat(ref("item.id"))))] }),
  s.set_var(as, withFilters(ref("_base"), fl.concat(c.text(".")), fl.concat(ref("_ext")))),
];

/**
 * Who made it, when an agent did: "Easel" for the assistant, a key's name for an agent someone connected, or empty when the
 * person made it themselves. `connection` is the run's key or MCP connection. Binds the name given.
 */
const agentName = (as: string, via: Value, connection: Value) => [
  s.set_var(as, c.text("")),
  s.conditional({ when: expr(via, "=", c.text("easel")), then: [s.update_var(as, c.text("Easel"))] }),
  s.conditional({ when: cond.in(via, c.array(["api", "mcp"])), then: [
    s.update_var(as, c.text("An agent")),
    s.set_var(`${as}_conn_id`, withFilters(connection, fl.first_notnull(c.int(0)))),
    s.conditional({ when: expr(ref(`${as}_conn_id`), ">", c.int(0)), then: [
      s.db.get({ table: agent.agent_connection, fieldValue: ref(`${as}_conn_id`), output: ["name"], as: `${as}_conn` }),
      s.update_var(as, withFilters(ref(`${as}_conn.name`, { safe: true }), fl.first_notempty(c.text("An agent")))),
    ] }),
  ] }),
];

export type LibraryTile = {
  id: number; kind: string; title: string; status: "draft" | "approved"; maker_id: number; maker_name: string | null;
  /** The agent that made it for its maker ("Easel", a key's name), or empty when they made it themselves. */
  agent: string;
  created_at: number; estimated_cost: number; model: string; excerpt: string; seconds: number;
  /** The recipe that made it (a recipe's runs carry its name as their title), or empty when no recipe did. */
  recipe: string;
  /** A picture's one-minute link, or its table-kept bytes' id where this server can't sign links (library/media.ts). */
  thumb: string; thumb_blob: number;
};

/** The list's filters, as `library/find` reads them from its own variables; `since`, a time items were made at or after. */
const listed = (since?: Value) => [
  cmp(col("private"), "=", c.bool(false)),
  cmp(col("kind"), "in", ref("kinds")),
  cmp(col("status"), "in", ref("states")),
  cmp(col("maker_id"), "=", inp("maker_id"), { ignoreEmpty: true }),
  cmp(col("run_id"), "in", ref("run_ids"), { ignoreEmpty: true }),
  cmp(col("title"), "includes", ref("words"), { ignoreEmpty: true }),
  ...(since ? [cmp(col("created_at"), ">=", since)] : []),
];
const wordsListed = (since?: Value) => [...listed(since), cmp(col("kind"), "in", c.array(TEXT_KINDS))];
const less = (a: string, b: string) => withFilters(ref(a), fl.sub(ref(b)));

/**
 * How many listed items each date group holds, and how many of those are words (two share a place in the grid), so a
 * screen lays out every group before its pages arrive. Items are listed newest first, so each group is one unbroken run
 * of the list. Binds `dates`: Today, Yesterday, This week and Earlier, in that order, or none without the boundaries.
 */
const dateCounts = () => [
  s.set_var("dates", c.array([])),
  s.conditional({ when: [expr(inp("today_from"), ">", c.int(0)), expr(inp("yesterday_from"), ">", c.int(0)), expr(inp("week_from"), ">", c.int(0))], then: [
    s.db.query({ table: asset, where: listed(inp("today_from")), returnType: "count", as: "since_today" }),
    s.db.query({ table: asset, where: wordsListed(inp("today_from")), returnType: "count", as: "since_today_words" }),
    s.db.query({ table: asset, where: listed(inp("yesterday_from")), returnType: "count", as: "since_yesterday" }),
    s.db.query({ table: asset, where: wordsListed(inp("yesterday_from")), returnType: "count", as: "since_yesterday_words" }),
    s.db.query({ table: asset, where: listed(inp("week_from")), returnType: "count", as: "since_week" }),
    s.db.query({ table: asset, where: wordsListed(inp("week_from")), returnType: "count", as: "since_week_words" }),
    s.db.query({ table: asset, where: wordsListed(), returnType: "count", as: "all_words" }),
    s.array.push({ name: "dates", value: obj({ group: c.text("Today"), n: ref("since_today"), words: ref("since_today_words") }) }),
    s.array.push({ name: "dates", value: obj({ group: c.text("Yesterday"), n: less("since_yesterday", "since_today"), words: less("since_yesterday_words", "since_today_words") }) }),
    s.array.push({ name: "dates", value: obj({ group: c.text("This week"), n: less("since_week", "since_yesterday"), words: less("since_week_words", "since_yesterday_words") }) }),
    s.array.push({ name: "dates", value: obj({ group: c.text("Earlier"), n: less("found.itemsTotal", "since_week"), words: less("all_words", "since_week_words") }) }),
  ] }),
];

export const findAssetsFn = defineFunction({
  name: "library/find",
  description: "The team's library items a person may see, newest first: by kind, approved only, maker, recipe or words in the title.",
  input: {
    actor_id: input.int({ required: true }),
    /** all, image, video, audio or text. */
    kind: input.text(),
    approved_only: input.bool(),
    /** Only the drafts waiting for someone to approve them. */
    drafts_only: input.bool(),
    maker_id: input.int(),
    recipe_id: input.int(),
    q: input.text(),
    page: input.int(),
    per_page: input.int(),
    /**
     * Where the screen's date groups start, in ms, from its own time zone: the start of today, of yesterday, and of the
     * week's oldest day. With them, the answer says how many items each group holds (`dates`); without them, `dates` is empty.
     */
    today_from: input.int(),
    yesterday_from: input.int(),
    week_from: input.int(),
  },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    s.set_var("group", withFilters(inp("kind"), fl.first_notempty(c.text("all")))),
    s.set_var("kinds", withFilters(c.obj(KIND_GROUPS), fl.get(ref("group"), c.array(KIND_GROUPS.all)))),
    s.set_var("states", c.array(["draft", "approved"])),
    s.conditional({ when: expr(ref("actor.role"), "=", c.text("guest")), then: [s.update_var("states", c.array(["approved"]))] }),
    // Every status this person may see, for the counts; then the one the filters ask for.
    s.set_var("visible_states", ref("states")),
    s.conditional({ when: expr(ref("actor.role"), "!=", c.text("guest")), then: [
      s.conditional({ when: expr(inp("approved_only"), "=", c.bool(true)), then: [s.update_var("states", c.array(["approved"]))] }),
      s.conditional({ when: [expr(inp("drafts_only"), "=", c.bool(true)), expr(inp("approved_only"), "!=", c.bool(true))], then: [s.update_var("states", c.array(["draft"]))] }),
    ] }),
    s.set_var("page", withFilters(inp("page"), fl.first_notnull(c.int(1)), fl.clamp_min(1))),
    s.set_var("size", withFilters(inp("per_page"), fl.first_notempty(c.int(PAGE_DEFAULT)), fl.clamp_min(1), fl.clamp_max(PAGE_MOST))),
    s.set_var("words", withFilters(inp("q"), fl.first_notnull(c.text("")), fl.trim())),
    // A recipe's items are its runs' items. A recipe with no runs matches nothing (an empty list would match everything).
    s.set_var("run_ids", c.array([])),
    s.conditional({ when: expr(inp("recipe_id"), ">", c.int(0)), then: [
      s.db.query({ table: ai_run, where: cmp(col("recipe_id"), "=", inp("recipe_id")), output: ["id"], paging: { per_page: 5000, metadata: false }, as: "recipe_runs" }),
      s.array.map({ source: ref("recipe_runs"), as: "recipe_run_ids", transform: ref("$this.id") }),
      s.update_var("run_ids", withFilters(ref("recipe_run_ids"), fl.array_push(c.int(-1)))),
    ] }),
    // What each kind holds in each status under the other filters: the kind tabs' and the status filters' counts.
    s.db.query({
      table: asset, returnType: "aggregate", as: "counted",
      where: [
        cmp(col("private"), "=", c.bool(false)),
        cmp(col("status"), "in", ref("visible_states")),
        cmp(col("maker_id"), "=", inp("maker_id"), { ignoreEmpty: true }),
        cmp(col("run_id"), "in", ref("run_ids"), { ignoreEmpty: true }),
        cmp(col("title"), "includes", ref("words"), { ignoreEmpty: true }),
      ],
      aggregate: { group: [{ name: "kind", as: "kind" }, { name: "status", as: "status" }], eval: [{ name: "id", as: "n", filters: [qf.count()] }] },
    }),
    s.db.query({
      table: asset,
      where: listed(),
      bind: [
        { table: user, as: "maker", join: "left", where: expr(col("maker_id"), "=", col("maker.id")) },
        { table: ai_run, as: "made_by", join: "left", where: expr(col("run_id"), "=", col("made_by.id")) },
      ],
      eval: [
        { name: "maker.name", as: "maker_name" }, { name: "made_by.via", as: "via" }, { name: "made_by.connection_id", as: "connection_id" },
        { name: "made_by.recipe_id", as: "made_recipe_id" }, { name: "made_by.title", as: "made_title" },
      ],
      sort: [{ sortBy: "created_at", dir: "desc" }, { sortBy: "id", dir: "desc" }],
      paging: { page: ref("page"), per_page: ref("size"), metadata: true, totals: true },
      as: "found",
    }),
    ...dateCounts(),
    // The recipes these items came from, by their own names (a recipe run's title adds what it was run on).
    s.set_var("row_recipe_ids", c.array([-1])),
    s.foreach({ list: ref("found.items"), as: "made", body: [
      s.conditional({ when: expr(withFilters(ref("made.made_recipe_id", { safe: true }), fl.first_notnull(c.int(0))), ">", c.int(0)), then: [
        s.array.push({ name: "row_recipe_ids", value: ref("made.made_recipe_id") }),
      ] }),
    ] }),
    s.db.query({ table: recipe, where: cmp(col("id"), "in", ref("row_recipe_ids")), output: ["id", "name"],
      paging: { per_page: PAGE_MOST, metadata: false }, as: "made_recipes" }),
    s.set_var("tiles", c.array([])),
    s.foreach({ list: ref("found.items"), as: "row", body: [
      ...agentName("row_agent", ref("row.via", { safe: true }), ref("row.connection_id", { safe: true })),
      s.set_var("thumb", c.text("")),
      s.set_var("thumb_blob", c.int(0)),
      s.set_var("row_recipe", c.text("")),
      s.conditional({ when: expr(withFilters(ref("row.made_recipe_id", { safe: true }), fl.first_notnull(c.int(0))), ">", c.int(0)), then: [
        s.array.find({ expr: ref("made_recipes"), as: "row_recipe_row", if: expr(ref("$this.id"), "=", ref("row.made_recipe_id")) }),
        // A recipe deleted since keeps the name its run was given.
        s.update_var("row_recipe", withFilters(ref("row_recipe_row.name", { safe: true }), fl.first_notempty(withFilters(ref("row.made_title", { safe: true }), fl.first_notnull(c.text("")))))),
      ] }),
      s.conditional({ when: expr(ref("row.kind"), "=", c.text("image")), then: [
        s.function.run({ fn: mediaLinkFn, as: "row_link", input: { file: ref("row.file"), ttl: c.int(LIBRARY_LINK_SECONDS) } }),
        s.update_var("thumb", ref("row_link.url")),
        s.update_var("thumb_blob", ref("row_link.blob_id")),
      ] }),
      // A video's poster is the picture it was made from: the library item it started from, or its run's image step. A
      // picture someone else kept private stays private.
      s.conditional({ when: expr(ref("row.kind"), "=", c.text("video")), then: [
        s.set_var("poster_id", withFilters(ref("row.inputs"), fl.get("from_asset", 0), fl.first_notnull(c.int(0)), fl.to_int())),
        s.set_var("from_seqs", withFilters(ref("row.inputs"), fl.get("from_steps", c.array([])), fl.safe_array())),
        s.conditional({ when: [expr(ref("poster_id"), "=", c.int(0)), expr(withFilters(ref("from_seqs"), fl.count()), ">", c.int(0))], then: [
          s.db.query({ table: ai_step, where: [cmp(col("run_id"), "=", ref("row.run_id")), cmp(col("seq"), "in", ref("from_seqs")), cmp(col("kind"), "=", c.text("image"))],
            output: ["asset_id"], returnType: "single", as: "image_step" }),
          s.update_var("poster_id", withFilters(ref("image_step.asset_id", { safe: true }), fl.first_notnull(c.int(0)))),
        ] }),
        s.conditional({ when: expr(ref("poster_id"), ">", c.int(0)), then: [
          s.db.get({ table: asset, fieldValue: ref("poster_id"), output: ["id", "kind", "file", "private", "maker_id"], as: "poster" }),
          s.conditional({ when: [
            expr(ref("poster.kind", { safe: true }), "=", c.text("image")),
            or(expr(ref("poster.private", { safe: true }), "!=", c.bool(true)), expr(ref("poster.maker_id", { safe: true }), "=", ref("row.maker_id"))),
          ], then: [
            s.function.run({ fn: mediaLinkFn, as: "poster_link", input: { file: ref("poster.file"), ttl: c.int(LIBRARY_LINK_SECONDS) } }),
            s.update_var("thumb", ref("poster_link.url")),
            s.update_var("thumb_blob", ref("poster_link.blob_id")),
          ] }),
        ] }),
      ] }),
      s.update_var("tiles", withFilters(ref("tiles"), fl.array_push(obj({
        id: ref("row.id"), kind: ref("row.kind"), title: ref("row.title"), status: ref("row.status"),
        maker_id: ref("row.maker_id"), maker_name: ref("row.maker_name", { safe: true }), agent: ref("row_agent"), created_at: ref("row.created_at"),
        estimated_cost: ref("row.estimated_cost"), model: ref("row.model"),
        excerpt: withFilters(ref("row.body"), fl.first_notnull(c.text("")), fl.to_text(), fl.substr(c.int(0), c.int(EXCERPT))),
        seconds: withFilters(ref("row.settings"), fl.get("seconds", 0), fl.first_notnull(c.int(0))),
        thumb: ref("thumb"), thumb_blob: ref("thumb_blob"), recipe: ref("row_recipe"),
      })))),
    ] }),
  ],
  response: { items: ref("tiles"), total: ref("found.itemsTotal"), next_page: ref("found.nextPage"), page: ref("page"), counts: ref("counted"), dates: ref("dates") },
  responseShape: {} as LibraryPage,
});

/** A page of tiles, and how many items each kind holds in each status under the same filters (the tabs' counts). */
export type LibraryPage = {
  items: LibraryTile[]; total: number; next_page: number | null; page: number; counts: { kind: string; status: string; n: number }[];
  /** Each date group's items, and the words among them, newest group first; empty when the screen sent no boundaries. */
  dates: { group: "Today" | "Yesterday" | "This week" | "Earlier"; n: number; words: number }[];
};

export type LibraryItem = {
  id: number; created_at: number; kind: string; title: string; prompt: string; sent_prompt: string; model: string;
  settings: Record<string, unknown>; inputs: { files?: { name: string; size: number; mime: string }[]; from_steps?: number[]; from_asset?: number };
  body: string; mime: string; file_name: string; url: string; blob_id: number; how: "signed" | "table" | "text" | "unavailable";
  maker_id: number; maker_name: string; agent: string; estimated_cost: number; brand_applied: boolean; private: boolean;
  status: "draft" | "approved"; approved_by: number; approver_name: string; approved_at: number | null;
  run: { id: number; title: string; kind: string; recipe_id: number }; step_seq: number;
  from: { id: number; title: string; kind: string } | null;
  can_approve: boolean; can_delete: boolean;
};

export const getAssetFn = defineFunction({
  name: "library/get",
  description: "One library item with how it was made, a one-minute link to its file, and what this person may do with it.",
  input: { asset_id: input.int({ required: true }), actor_id: input.int({ required: true }) },
  stack: [
    ...openItem(inp("asset_id"), inp("actor_id")),
    ...showFile("url", "how", "blob_id"),
    ...saveName("file_name"),
    s.db.get({ table: user, fieldValue: ref("item.maker_id"), output: ["name"], as: "maker" }),
    s.set_var("approver_name", c.text("")),
    s.conditional({ when: expr(ref("item.approved_by"), ">", c.int(0)), then: [
      s.db.get({ table: user, fieldValue: ref("item.approved_by"), output: ["name"], as: "approver" }),
      s.update_var("approver_name", withFilters(ref("approver.name", { safe: true }), fl.first_notnull(c.text("")))),
    ] }),
    s.db.get({ table: ai_run, fieldValue: ref("item.run_id"), output: ["id", "title", "kind", "recipe_id", "via", "connection_id"], as: "run" }),
    ...agentName("agent_name", ref("run.via", { safe: true }), ref("run.connection_id", { safe: true })),
    s.db.get({ table: ai_step, fieldValue: ref("item.step_id"), output: ["seq"], as: "step" }),
    // What it started from, when that came from the library and this person may read it too.
    s.set_var("from", c.null()),
    s.set_var("from_id", withFilters(ref("item.inputs"), fl.get("from_asset", 0), fl.first_notnull(c.int(0)))),
    s.conditional({ when: expr(ref("from_id"), ">", c.int(0)), then: [
      s.db.get({ table: asset, fieldValue: ref("from_id"), output: ["id", "title", "kind", "maker_id", "private", "status"], as: "source" }),
      s.conditional({ when: expr(ref("source"), "!=", c.null()), then: [
        s.conditional({ when: readable("source", "actor"), then: [
          s.update_var("from", obj({ id: ref("source.id"), title: ref("source.title"), kind: ref("source.kind") })),
        ] }),
      ] }),
    ] }),
    s.set_var("can_approve", c.bool(false)),
    s.conditional({ when: and(cond.in(ref("actor.role"), c.array(rbac.rolesWith("library.approve"))), expr(ref("item.private"), "!=", c.bool(true))), then: [
      s.update_var("can_approve", c.bool(true)),
    ] }),
    s.set_var("can_delete", c.bool(false)),
    s.conditional({ when: or(expr(ref("item.maker_id"), "=", inp("actor_id")), cond.in(ref("actor.role"), c.array(ADMINS))), then: [
      s.update_var("can_delete", c.bool(true)),
    ] }),
  ],
  response: {
    id: ref("item.id"), created_at: ref("item.created_at"), kind: ref("item.kind"), title: ref("item.title"),
    prompt: ref("item.prompt"), sent_prompt: ref("item.sent_prompt"), model: ref("item.model"),
    settings: withFilters(ref("item.settings"), fl.first_notnull(c.obj({}))), inputs: withFilters(ref("item.inputs"), fl.first_notnull(c.obj({}))),
    body: withFilters(ref("item.body"), fl.first_notnull(c.text(""))),
    mime: withFilters(ref("item.file"), fl.get("mime", ""), fl.first_notnull(c.text(""))), file_name: ref("file_name"), url: ref("url"), blob_id: ref("blob_id"), how: ref("how"),
    maker_id: ref("item.maker_id"), maker_name: withFilters(ref("maker.name", { safe: true }), fl.first_notnull(c.text(""))), agent: ref("agent_name"),
    estimated_cost: ref("item.estimated_cost"), brand_applied: ref("item.brand_applied"), private: ref("item.private"),
    status: ref("item.status"), approved_by: ref("item.approved_by"), approver_name: ref("approver_name"), approved_at: ref("item.approved_at"),
    run: obj({ id: ref("item.run_id"), title: ref("run.title", { safe: true }), kind: ref("run.kind", { safe: true }), recipe_id: withFilters(ref("run.recipe_id", { safe: true }), fl.first_notnull(c.int(0))) }),
    step_seq: withFilters(ref("step.seq", { safe: true }), fl.first_notnull(c.int(0))),
    from: ref("from"), can_approve: ref("can_approve"), can_delete: ref("can_delete"),
  },
  responseShape: {} as LibraryItem,
});

export const assetLinkFn = defineFunction({
  name: "library/link",
  description: "How to download a library item now: a one-minute signed link to its file, the text route for words, or why neither works here.",
  input: { asset_id: input.int({ required: true }), actor_id: input.int({ required: true }) },
  stack: [
    ...openItem(inp("asset_id"), inp("actor_id")),
    ...saveName("file_name"),
    ...showFile("url", "how", "blob_id"),
  ],
  response: {
    how: ref("how"), url: ref("url"), blob_id: ref("blob_id"), file_name: ref("file_name"), expires_in: c.int(LIBRARY_LINK_SECONDS),
    mime: withFilters(ref("item.file"), fl.get("mime", "text/plain"), fl.first_notnull(c.text("text/plain"))),
  },
  responseShape: {} as { how: "signed" | "table" | "text" | "unavailable"; url: string; blob_id: number; file_name: string; expires_in: number; mime: string },
});

/** The words of a text item, for its download route. Same read rule; files go through a signed link instead. */
export const assetTextFn = defineFunction({
  name: "library/text",
  description: "A text item's words and a safe name to save them under. Only for text and transcripts.",
  input: { asset_id: input.int({ required: true }), actor_id: input.int({ required: true }) },
  stack: [
    ...openItem(inp("asset_id"), inp("actor_id")),
    guard.require(cond.in(ref("item.kind"), c.array(TEXT_KINDS)), { errorType: "badrequest", message: "Only text items download here. Ask for the item's link to download a file." }),
    ...saveName("file_name"),
  ],
  response: { body: withFilters(ref("item.body"), fl.first_notnull(c.text(""))), file_name: ref("file_name") },
  responseShape: {} as { body: string; file_name: string },
});

export const approveAssetFn = defineFunction({
  name: "library/approve",
  description: "Approve a library item for use. Needs the library approve permission; approving twice keeps the first approval.",
  input: { asset_id: input.int({ required: true }), actor_id: input.int({ required: true }) },
  stack: [
    ...openItem(inp("asset_id"), inp("actor_id")),
    rbac.allows(ref("actor.role"), "library.approve", APPROVE_WORDS.role),
    guard.require(expr(ref("item.private"), "!=", c.bool(true)), { errorType: "badrequest", message: APPROVE_WORDS.private }),
    s.conditional({ when: expr(ref("item.status"), "!=", c.text("approved")), then: [
      s.db.patch({ table: asset, fieldValue: inp("asset_id"), data: obj({ status: c.text("approved"), approved_by: inp("actor_id"), approved_at: c.now() }) }),
      changed({ entity: "asset", id: inp("asset_id"), op: "updated", verb: "approved", actor: inp("actor_id"),
        title: withFilters(c.text("approved "), fl.concat(withFilters(ref("item.title"), fl.first_notempty(c.text("a library item"))))),
        link: withFilters(c.text("/library/"), fl.concat(inp("asset_id"))) }),
    ] }),
    s.db.get({ table: asset, fieldValue: inp("asset_id"), output: ["id", "status", "approved_by", "approved_at"], as: "after" }),
  ],
  response: ref("after"),
  responseShape: {} as { id: number; status: "draft" | "approved"; approved_by: number; approved_at: number | null },
});

export const deleteAssetFn = defineFunction({
  name: "library/delete",
  description: "Delete a library item and its file. Only its maker or an admin.",
  input: { asset_id: input.int({ required: true }), actor_id: input.int({ required: true }) },
  stack: [
    ...openItem(inp("asset_id"), inp("actor_id")),
    guard.require(or(expr(ref("item.maker_id"), "=", inp("actor_id")), cond.in(ref("actor.role"), c.array(ADMINS))), { errorType: "accessdenied", message: DELETE_WORDS }),
    s.set_var("path", withFilters(ref("item.file"), fl.get("path", ""), fl.first_notnull(c.text("")))),
    s.conditional({ when: expr(ref("path"), "!=", c.text("")), then: [s.try_catch({ try: [s.storage.delete_file({ pathname: ref("path") })], catch: [] })] }),
    s.set_var("blob_id", withFilters(ref("item.file"), fl.get("blob_id", 0), fl.first_notnull(c.int(0)), fl.to_int())),
    s.conditional({ when: expr(ref("blob_id"), ">", c.int(0)), then: [s.db.del({ table: media_blob, fieldValue: ref("blob_id") })] }),
    // The run keeps its record; its step no longer points at an item that's gone.
    s.db.query({ table: ai_step, where: cmp(col("asset_id"), "=", inp("asset_id")), output: ["id"], paging: { per_page: 50, metadata: false }, as: "pointing" }),
    s.foreach({ list: ref("pointing"), as: "one", body: [s.db.patch({ table: ai_step, fieldValue: ref("one.id"), data: obj({ asset_id: c.int(0) }) })] }),
    s.db.del({ table: asset, fieldValue: inp("asset_id") }),
    changed({ entity: "asset", id: inp("asset_id"), op: "deleted", verb: "deleted", actor: inp("actor_id"),
      title: withFilters(c.text("deleted "), fl.concat(withFilters(ref("item.title"), fl.first_notempty(c.text("a library item"))))), link: c.text("/library") }),
  ],
  response: { deleted: c.bool(true) },
  responseShape: {} as { deleted: boolean },
});

export const libraryFacetsFn = defineFunction({
  name: "library/facets",
  description: "What the Library's filters offer: the people who made items in the team's library, and the recipes that made them.",
  input: { actor_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    s.set_var("states", c.array(["draft", "approved"])),
    s.conditional({ when: expr(ref("actor.role"), "=", c.text("guest")), then: [s.update_var("states", c.array(["approved"]))] }),
    s.db.query({ table: asset, where: [cmp(col("private"), "=", c.bool(false)), cmp(col("status"), "in", ref("states"))], returnType: "aggregate",
      aggregate: { group: [{ name: "maker_id", as: "maker_id" }, { name: "run_id", as: "run_id" }] }, as: "groups" }),
    s.array.map({ source: ref("groups"), as: "maker_ids_all", transform: ref("$this.maker_id") }),
    s.array.map({ source: ref("groups"), as: "run_ids_all", transform: ref("$this.run_id") }),
    s.set_var("maker_ids", withFilters(ref("maker_ids_all"), fl.unique(), fl.array_push(c.int(-1)))),
    s.set_var("run_ids", withFilters(ref("run_ids_all"), fl.unique(), fl.array_push(c.int(-1)))),
    s.db.query({ table: user, where: cmp(col("id"), "in", ref("maker_ids")), output: ["id", "name"],
      sort: [{ sortBy: "name", dir: "asc" }], paging: { per_page: 500, metadata: false }, as: "makers" }),
    s.db.query({ table: ai_run, where: [cmp(col("id"), "in", ref("run_ids")), cmp(col("recipe_id"), ">", c.int(0))], output: ["recipe_id", "title"],
      sort: [{ sortBy: "created_at", dir: "desc" }], paging: { per_page: 2000, metadata: false }, as: "recipe_runs" }),
    s.set_var("facet_recipe_ids", c.array([-1])),
    s.foreach({ list: ref("recipe_runs"), as: "frr", body: [s.array.push({ name: "facet_recipe_ids", value: ref("frr.recipe_id") })] }),
    s.db.query({ table: recipe, where: cmp(col("id"), "in", ref("facet_recipe_ids")), output: ["id", "name"],
      paging: { per_page: 2000, metadata: false }, as: "facet_recipes" }),
    s.set_var("recipes", c.array([])),
    s.set_var("seen", c.array([])),
    s.foreach({ list: ref("recipe_runs"), as: "rr", body: [
      s.conditional({ when: cond.notIn(ref("rr.recipe_id"), ref("seen")), then: [
        s.update_var("seen", withFilters(ref("seen"), fl.array_push(ref("rr.recipe_id")))),
        // By the recipe's own name; one deleted since by the name its latest run was given.
        s.array.find({ expr: ref("facet_recipes"), as: "rr_recipe", if: expr(ref("$this.id"), "=", ref("rr.recipe_id")) }),
        s.update_var("recipes", withFilters(ref("recipes"), fl.array_push(obj({
          id: ref("rr.recipe_id"), name: withFilters(ref("rr_recipe.name", { safe: true }), fl.first_notempty(ref("rr.title"))),
        })))),
      ] }),
    ] }),
  ],
  response: { makers: ref("makers"), recipes: ref("recipes") },
  responseShape: {} as { makers: { id: number; name: string }[]; recipes: { id: number; name: string }[] },
});

export const libraryFunctions = [findAssetsFn, getAssetFn, assetLinkFn, assetTextFn, approveAssetFn, deleteAssetFn, libraryFacetsFn];
