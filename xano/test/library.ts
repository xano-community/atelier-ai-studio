// The Library's rules: a step's output lands as a draft item with how it was made, approving records who and when, a
// guest sees approved items only, an item someone can't read answers as one that doesn't exist, only its maker or an
// admin deletes it, and the filters narrow by kind, approval, maker and recipe. Outputs are recorded with the real
// functions and a stub in the model's seat, as in steps.ts. Charges come from the test prices in fixtures.ts.
import { c, cmp, col, fl, obj, ref, s, withFilters } from "@xano/sdk";
import { asset } from "../table/library/asset.js";
import { recipe } from "../table/recipes/recipe.js";
import { ai_run } from "../table/studio/ai_run.js";
import { ai_step } from "../table/studio/ai_step.js";
import { user } from "../table/user.js";
import { claimStepFn, recordStepFn } from "../function/runs/execute_step.js";
import { startRunFn } from "../function/runs/start.js";
import {
  approveAssetFn, assetLinkFn, assetTextFn, deleteAssetFn, findAssetsFn, getAssetFn, libraryFacetsFn,
  APPROVE_WORDS, DELETE_WORDS, NO_SUCH_ITEM,
} from "../function/library/library.js";
import { useOutputFn } from "../function/studio/playground.js";
import { clipStep, equal, is, num, person, plainTest, priceRow, settings, start, testPrices, textStep, workflowTest } from "./fixtures.js";
import { stepsOf } from "./spend.js";

/** $0.04 an image at 1K. With the 10% margin an image is charged $0.044. */
const imagePrice = priceRow("test-image", "image", "image", 40_000, "1K");
const imageStep = (prompt = "The Trail 2 on the oak set", extra: Record<string, unknown> = {}) =>
  ({ kind: "image", model: "test-image", input: { prompt, ...extra }, options: { size: "1K", samples: 1 } });
/** What the image and audio wrappers keep: a private stored file. */
const keptImage = (name: string) => ({ access: "private", path: "/vault/test/" + name, name, type: "image", size: 48_213, mime: "image/png", meta: { width: 1024, height: 1024 } });
const keptAudio = (name: string) => ({ access: "private", path: "/vault/test/" + name, name, type: "audio", size: 96_000, mime: "audio/mpeg", meta: {} });

/** Claim the run's first step and record a success with this output. Binds the item to `as`, its step to `<as>_step`. */
const madeItem = (as: string, run: string, output: Record<string, unknown>) => [
  ...stepsOf(run, 1),
  s.set_var(as + "_step", ref("step1")),
  s.function.run({ fn: claimStepFn, as: as + "_claim", input: { step_id: ref("step1.id"), attempt: c.int(1) } }),
  s.function.run({ fn: recordStepFn, as: as + "_rec", input: {
    step_id: ref("step1.id"), attempt: c.int(1), outcome: c.text("succeeded"), reason: c.text(""), detail: c.text(""), refused: c.bool(false),
    output: c.obj(output as never), usage: c.obj({}), brand_applied: c.bool(false), sent_prompt: c.text(""),
  } }),
  s.db.query({ table: asset, where: cmp(col("step_id"), "=", ref("step1.id")), returnType: "single", as }),
];
const find = (as: string, actor: string, o: { kind?: string; approved_only?: boolean; maker?: string; recipe_id?: number; q?: string; per_page?: number; page?: number; from?: [number, number, number] } = {}) =>
  s.function.run({ fn: findAssetsFn, as, input: {
    actor_id: ref(actor + ".id"), kind: c.text(o.kind ?? ""), approved_only: c.bool(o.approved_only ?? false),
    maker_id: o.maker ? ref(o.maker + ".id") : c.int(0), recipe_id: c.int(o.recipe_id ?? 0), q: c.text(o.q ?? ""), page: c.int(o.page ?? 1), per_page: c.int(o.per_page ?? 60),
    today_from: c.int(o.from?.[0] ?? 0), yesterday_from: c.int(o.from?.[1] ?? 0), week_from: c.int(o.from?.[2] ?? 0),
  } });
/** Set when an item was made. */
const madeAt = (item: string, at: number) => s.db.patch({ table: asset, fieldValue: ref(item + ".id"), data: obj({ created_at: c.int(at) }) });
const get = (as: string, item: string, actor: string) => s.function.run({ fn: getAssetFn, as, input: { asset_id: ref(item + ".id"), actor_id: ref(actor + ".id") } });
const approve = (as: string, item: string, actor: string) => s.function.run({ fn: approveAssetFn, as, input: { asset_id: ref(item + ".id"), actor_id: ref(actor + ".id") } });
const count = (path: string, n: number) => s.expect.to_equal({ expr: withFilters(ref(path), fl.count()), value: c.int(n) });
/** An expect.to_throw body sees none of the test's variables: these look a person and an item up again inside it. */
const who = (as: string, key: string) => s.db.query({ table: user, where: cmp(col("email"), "=", c.text(key + "@studio-test.example")), returnType: "single", as });
const titled = (as: string, title: string) => s.db.query({ table: asset, where: cmp(col("title"), "=", c.text(title)), returnType: "single", as });
/** A private Playground run, as the app starts one. */
const privateRun = (as: string, owner: string, key: string, step: Record<string, unknown>) => s.function.run({ fn: startRunFn, as, input: {
  owner_id: ref(owner + ".id"), kind: c.text("playground"), via: c.text("ui"), connection_id: c.int(0), idem_key: c.text(key), recipe_id: c.int(0),
  title: c.text("Private try"), private: c.bool(true), base_url: c.text(""), agent_label: c.text("Test"), steps: c.array([step] as never),
} });

export const libraryTests = [
  workflowTest({
    name: "library: an image step's output is a draft item with its prompt, model, cost, maker and run",
    stack: [
      settings(), person("sam"), person("priya"), ...testPrices, imagePrice,
      start("r", "sam", "img-1", [imageStep("The Trail 2 on the oak set", { from_asset: 77 })], { title: "Trail 2, oak set" }),
      ...madeItem("item", "r", { file: keptImage("atelier-image-1-1.png") }),
      is("item.kind", "image"), is("item.status", "draft"), is("item.title", "Trail 2, oak set"),
      is("item.prompt", "The Trail 2 on the oak set"), is("item.model", "test-image"),
      equal("item.maker_id", ref("sam.id")), equal("item.run_id", ref("r.run.id")), equal("item.step_id", ref("item_step.id")),
      // $0.04 plus 10%.
      num("item.estimated_cost", 44_000),
      // Where it started from is recorded as an input, not a setting.
      num("item.inputs.from_asset", 77),
      s.expect.to_be_false({ expr: withFilters(ref("item.settings.request"), fl.has("from_asset")) }),
      // A teammate reads the same record through the library.
      get("seen", "item", "priya"),
      is("seen.prompt", "The Trail 2 on the oak set"), is("seen.model", "test-image"), num("seen.estimated_cost", 44_000),
      equal("seen.maker_id", ref("sam.id")), is("seen.maker_name", "Test sam"), equal("seen.run.id", ref("r.run.id")), num("seen.step_seq", 1),
      is("seen.status", "draft"), is("seen.mime", "image/png"), is("seen.file_name", "Trail 2 oak set.png"),
      // A source that doesn't exist (any more) isn't shown.
      s.expect.to_be_null({ expr: ref("seen.from") }),
      s.expect.to_be_true({ expr: ref("seen.can_approve") }),
      s.expect.to_be_false({ expr: ref("seen.can_delete") }),
      find("listed", "priya"), num("listed.total", 1), equal("listed.items.0.id", ref("item.id")),
      is("listed.items.0.maker_name", "Test sam"), is("listed.items.0.status", "draft"),
    ],
  }),

  workflowTest({
    name: "library: approving records who and when; approving twice keeps the first; a guest can't approve",
    stack: [
      settings(), person("sam"), person("priya"), person("avery", "admin"), person("alex", "guest"), ...testPrices, imagePrice,
      start("r", "sam", "img-1", [imageStep()], { title: "To approve" }),
      ...madeItem("item", "r", { file: keptImage("a.png") }),
      approve("ok", "item", "priya"),
      is("ok.status", "approved"), equal("ok.approved_by", ref("priya.id")),
      s.expect.to_be_greater_than({ expr: ref("ok.approved_at"), value: c.int(0) }),
      approve("again", "item", "avery"),
      equal("again.approved_by", ref("priya.id")), equal("again.approved_at", ref("ok.approved_at")),
      // The guest can read it now it's approved, and still can't approve it.
      get("guest_view", "item", "alex"),
      s.expect.to_be_false({ expr: ref("guest_view.can_approve") }),
      s.expect.to_throw({ exception: c.text(APPROVE_WORDS.role), body: [
        titled("it", "To approve"), who("guest", "alex"),
        s.function.run({ fn: approveAssetFn, as: "refused", input: { asset_id: ref("it.id"), actor_id: ref("guest.id") } }),
      ] }),
    ],
  }),

  workflowTest({
    name: "library: a guest's library holds only approved items, and a draft answers as if it didn't exist",
    stack: [
      settings(), person("sam"), person("priya"), person("alex", "guest"), ...testPrices, imagePrice,
      start("r1", "sam", "img-1", [imageStep("first")], { title: "First" }),
      ...madeItem("first", "r1", { file: keptImage("1.png") }),
      start("r2", "sam", "img-2", [imageStep("second")], { title: "Second" }),
      ...madeItem("second", "r2", { file: keptImage("2.png") }),
      start("r3", "sam", "txt-1", [textStep()], { title: "Third" }),
      ...madeItem("third", "r3", { text: "Ride further." }),
      approve("ok", "second", "priya"),
      find("guest", "alex"), num("guest.total", 1), equal("guest.items.0.id", ref("second.id")), is("guest.items.0.status", "approved"),
      // Asking for a kind doesn't widen it to drafts.
      find("guest_text", "alex", { kind: "text" }), num("guest_text.total", 0),
      find("member", "priya"), num("member.total", 3),
      find("member_approved", "priya", { approved_only: true }), num("member_approved.total", 1),
      s.expect.to_throw({ exception: c.text(NO_SUCH_ITEM), body: [
        titled("draft", "First"), who("guest", "alex"),
        s.function.run({ fn: getAssetFn, as: "peek", input: { asset_id: ref("draft.id"), actor_id: ref("guest.id") } }),
      ] }),
      // An id nobody has gets the very same answer.
      s.expect.to_throw({ exception: c.text(NO_SUCH_ITEM), body: [
        who("guest", "alex"),
        s.function.run({ fn: getAssetFn, as: "none", input: { asset_id: c.int(987_654), actor_id: ref("guest.id") } }),
      ] }),
    ],
  }),

  workflowTest({
    name: "library: a private Playground output is its maker's and the admins' until Use this, then the team's",
    stack: [
      settings(), person("sam"), person("priya"), person("avery", "admin"), ...testPrices, imagePrice,
      privateRun("mine", "sam", "click-1", imageStep()),
      ...madeItem("item", "mine", { file: keptImage("p.png") }),
      s.expect.to_be_true({ expr: ref("item.private") }),
      find("team_before", "priya"), num("team_before.total", 0),
      // Not in anyone's library list yet, the maker's included: it's still a Playground draft.
      find("maker_before", "sam"), num("maker_before.total", 0),
      get("by_maker", "item", "sam"), is("by_maker.status", "draft"),
      s.expect.to_be_false({ expr: ref("by_maker.can_approve") }),
      get("by_admin", "item", "avery"), equal("by_admin.id", ref("item.id")),
      s.expect.to_throw({ exception: c.text(NO_SUCH_ITEM), body: [
        titled("it", "Private try"), who("other", "priya"),
        s.function.run({ fn: getAssetFn, as: "peek", input: { asset_id: ref("it.id"), actor_id: ref("other.id") } }),
      ] }),
      s.expect.to_throw({ exception: c.text(APPROVE_WORDS.private), body: [
        titled("it", "Private try"), who("admin", "avery"),
        s.function.run({ fn: approveAssetFn, as: "early", input: { asset_id: ref("it.id"), actor_id: ref("admin.id") } }),
      ] }),
      s.function.run({ fn: useOutputFn, as: "used", input: { step_id: ref("item_step.id"), actor_id: ref("sam.id") } }),
      find("team_after", "priya"), num("team_after.total", 1), equal("team_after.items.0.id", ref("item.id")),
    ],
  }),

  workflowTest({
    name: "library: only the maker or an admin deletes an item; its step stops pointing at it",
    stack: [
      settings(), person("sam"), person("priya"), person("avery", "admin"), ...testPrices, imagePrice,
      start("r1", "sam", "img-1", [imageStep()], { title: "One" }),
      ...madeItem("first", "r1", { file: keptImage("1.png") }),
      start("r2", "sam", "img-2", [imageStep()], { title: "Two" }),
      ...madeItem("second", "r2", { file: keptImage("2.png") }),
      s.expect.to_throw({ exception: c.text(DELETE_WORDS), body: [
        titled("it", "One"), who("other", "priya"),
        s.function.run({ fn: deleteAssetFn, as: "refused", input: { asset_id: ref("it.id"), actor_id: ref("other.id") } }),
      ] }),
      s.function.run({ fn: deleteAssetFn, as: "by_maker", input: { asset_id: ref("first.id"), actor_id: ref("sam.id") } }),
      s.function.run({ fn: deleteAssetFn, as: "by_admin", input: { asset_id: ref("second.id"), actor_id: ref("avery.id") } }),
      s.db.query({ table: asset, returnType: "count", as: "left" }), num("left", 0),
      s.db.get({ table: ai_step, fieldValue: ref("first_step.id"), as: "step_after" }), num("step_after.asset_id", 0),
      // Deleting again finds nothing.
      s.expect.to_throw({ exception: c.text(NO_SUCH_ITEM), body: [
        who("maker", "sam"),
        s.function.run({ fn: deleteAssetFn, as: "twice", input: { asset_id: c.int(987_654), actor_id: ref("maker.id") } }),
      ] }),
    ],
  }),

  workflowTest({
    name: "library: the filters narrow by kind, maker and recipe, and a recipe with no runs matches nothing",
    stack: [
      settings(), person("sam"), person("priya"), ...testPrices, imagePrice,
      start("r1", "sam", "img-1", [imageStep("Forest loop banner")], { title: "Forest loop banner" }),
      ...madeItem("image", "r1", { file: keptImage("1.png") }),
      start("r2", "priya", "clip-1", [clipStep()], { title: "Warm indie bed", kind: "recipe" }),
      ...madeItem("music", "r2", { file: keptAudio("2.mp3") }),
      start("r3", "priya", "txt-1", [textStep()], { title: "Launch copy" }),
      ...madeItem("words", "r3", { text: "Room for the rough stuff." }),
      // The music came from recipe 5.
      s.db.patch({ table: ai_run, fieldValue: ref("r2.run.id"), data: obj({ recipe_id: c.int(5) }) }),
      find("images", "sam", { kind: "image" }), num("images.total", 1), equal("images.items.0.id", ref("image.id")),
      find("audio", "sam", { kind: "audio" }), num("audio.total", 1), equal("audio.items.0.id", ref("music.id")),
      find("text", "sam", { kind: "text" }), num("text.total", 1), is("text.items.0.excerpt", "Room for the rough stuff."),
      find("by_priya", "sam", { maker: "priya" }), num("by_priya.total", 2),
      s.array.map({ source: ref("by_priya.items"), as: "by_priya_ids", transform: ref("$this.id") }),
      s.expect.to_be_true({ expr: withFilters(ref("by_priya_ids"), fl.in(ref("music.id"))) }),
      s.expect.to_be_true({ expr: withFilters(ref("by_priya_ids"), fl.in(ref("words.id"))) }),
      find("recipe", "sam", { recipe_id: 5 }), num("recipe.total", 1), equal("recipe.items.0.id", ref("music.id")),
      // A tile names the recipe that made it (recipe 5 is gone, so by its run's name); one no recipe made names none.
      is("recipe.items.0.recipe", "Warm indie bed"), is("images.items.0.recipe", ""),
      find("no_runs", "sam", { recipe_id: 6 }), num("no_runs.total", 0),
      find("words_q", "sam", { q: "forest" }), num("words_q.total", 1), equal("words_q.items.0.id", ref("image.id")),
      s.function.run({ fn: libraryFacetsFn, as: "facets", input: { actor_id: ref("sam.id") } }),
      count("facets.makers", 2), count("facets.recipes", 1),
      num("facets.recipes.0.id", 5), is("facets.recipes.0.name", "Warm indie bed"),
    ],
  }),

  workflowTest({
    name: "library: the list says how many items, and how many words, each date group holds, from the screen's own day boundaries",
    stack: [
      settings(), person("sam"), person("priya"), ...testPrices, imagePrice,
      start("r1", "sam", "img-1", [imageStep("one")], { title: "Today's picture" }),
      ...madeItem("pic_today", "r1", { file: keptImage("1.png") }),
      start("r2", "sam", "txt-1", [textStep()], { title: "Today's words" }),
      ...madeItem("words_today", "r2", { text: "Ride further." }),
      start("r3", "sam", "txt-2", [textStep()], { title: "Yesterday's words" }),
      ...madeItem("words_yesterday", "r3", { text: "Ride longer." }),
      start("r4", "sam", "img-2", [imageStep("two")], { title: "This week's picture" }),
      ...madeItem("pic_week", "r4", { file: keptImage("2.png") }),
      start("r5", "sam", "txt-3", [textStep()], { title: "Older words" }),
      ...madeItem("words_old", "r5", { text: "Ride anywhere." }),
      start("r6", "sam", "txt-4", [textStep()], { title: "Older words again" }),
      ...madeItem("words_older", "r6", { text: "Ride everywhere." }),
      // Today starts at 40 000, yesterday at 30 000, the week at 20 000 (the screen's own midnights).
      madeAt("pic_today", 45_000), madeAt("words_today", 44_000), madeAt("words_yesterday", 30_000),
      madeAt("pic_week", 25_000), madeAt("words_old", 19_999), madeAt("words_older", 5_000),
      // One page of two items still answers for the whole list.
      find("all", "priya", { per_page: 2, from: [40_000, 30_000, 20_000] }), num("all.total", 6), count("all.items", 2),
      count("all.dates", 4),
      is("all.dates.0.group", "Today"), num("all.dates.0.n", 2), num("all.dates.0.words", 1),
      is("all.dates.1.group", "Yesterday"), num("all.dates.1.n", 1), num("all.dates.1.words", 1),
      is("all.dates.2.group", "This week"), num("all.dates.2.n", 1), num("all.dates.2.words", 0),
      is("all.dates.3.group", "Earlier"), num("all.dates.3.n", 2), num("all.dates.3.words", 2),
      // The groups follow the filters: the Text tab counts only words.
      find("text", "priya", { kind: "text", page: 2, per_page: 2, from: [40_000, 30_000, 20_000] }), num("text.total", 4),
      num("text.dates.0.n", 1), num("text.dates.1.n", 1), num("text.dates.2.n", 0), num("text.dates.3.n", 2), num("text.dates.3.words", 2),
      // Without the boundaries there are no groups to count.
      find("plain", "priya"), num("plain.total", 6), count("plain.dates", 0),
    ],
  }),

  plainTest({
    name: "library: a tile and the recipe filter name a recipe by its own name, not by what its run was titled",
    stack: [
      settings(), person("sam"), ...testPrices,
      s.db.add({ table: recipe, as: "bed", row: { slug: c.text("audio-bed"), name: c.text("Audio bed"), status: c.text("published"), created_by: ref("sam.id") } }),
      start("r1", "sam", "clip-1", [clipStep()], { title: "Audio bed: autumn teaser", kind: "recipe" }),
      ...madeItem("music", "r1", { file: keptAudio("1.mp3") }),
      s.db.patch({ table: ai_run, fieldValue: ref("r1.run.id"), data: obj({ recipe_id: ref("bed.id") }) }),
      find("all", "sam"), num("all.total", 1), is("all.items.0.recipe", "Audio bed"),
      s.function.run({ fn: libraryFacetsFn, as: "facets", input: { actor_id: ref("sam.id") } }),
      count("facets.recipes", 1), equal("facets.recipes.0.id", ref("bed.id")), is("facets.recipes.0.name", "Audio bed"),
    ],
  }),

  workflowTest({
    name: "library: a download is a one-minute link for a file, and the text route for words",
    stack: [
      settings(), person("sam"), person("alex", "guest"), ...testPrices, imagePrice,
      start("r1", "sam", "img-1", [imageStep()], { title: "Trail 2: dusk / coast" }),
      ...madeItem("image", "r1", { file: keptImage("1.png") }),
      start("r2", "sam", "txt-1", [textStep()], { title: "Launch copy" }),
      ...madeItem("words", "r2", { text: "Room for the rough stuff." }),
      s.function.run({ fn: assetLinkFn, as: "file_link", input: { asset_id: ref("image.id"), actor_id: ref("sam.id") } }),
      num("file_link.expires_in", 60), is("file_link.file_name", "Trail 2 dusk coast.png"), is("file_link.mime", "image/png"),
      // Signed where the server can sign private links; said plainly where it can't, never a broken link.
      s.expect.to_be_true({ expr: withFilters(c.array(["signed", "unavailable"]), fl.in(ref("file_link.how"))) }),
      s.function.run({ fn: assetLinkFn, as: "text_link", input: { asset_id: ref("words.id"), actor_id: ref("sam.id") } }),
      is("text_link.how", "text"), is("text_link.url", ""), is("text_link.file_name", "Launch copy.txt"),
      s.function.run({ fn: assetTextFn, as: "text", input: { asset_id: ref("words.id"), actor_id: ref("sam.id") } }),
      is("text.body", "Room for the rough stuff."),
      s.expect.to_throw({ exception: c.text("Only text items download here"), body: [
        titled("img", "Trail 2: dusk / coast"), who("maker", "sam"),
        s.function.run({ fn: assetTextFn, as: "wrong", input: { asset_id: ref("img.id"), actor_id: ref("maker.id") } }),
      ] }),
      // A guest gets no link to a draft: the same answer as no item.
      s.expect.to_throw({ exception: c.text(NO_SUCH_ITEM), body: [
        titled("img", "Trail 2: dusk / coast"), who("guest", "alex"),
        s.function.run({ fn: assetLinkFn, as: "guest_link", input: { asset_id: ref("img.id"), actor_id: ref("guest.id") } }),
      ] }),
    ],
  }),
];
