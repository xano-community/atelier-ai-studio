// The first minute and the states around it: a plan that can't keep media files, files kept in a table where private links
// can't be signed, first-admin setup, what each person reads while AI is off, the demo's sample run, and Easel's own turns on
// Usage. Every expected value is written here, never read from the code under test.
import { c, cmp, col, fl, obj, ref, s, withFilters } from "@xano/sdk";
import { workspace_setting } from "../base/tables.js";
import { asset } from "../table/library/asset.js";
import { media_blob } from "../table/library/media_blob.js";
import { ai_run } from "../table/studio/ai_run.js";
import { ai_step } from "../table/studio/ai_step.js";
import { ledger } from "../table/studio/ledger.js";
import { easel_turn } from "../table/studio/easel_turn.js";
import { user } from "../table/user.js";
import { mediaBytesFn, mediaLinkFn, storageCheckFn } from "../function/library/media.js";
import { approveAssetFn } from "../function/library/library.js";
import { finishSamplesFn } from "../function/runs/sweep.js";
import { usageFn } from "../function/spend/usage.js";
import { aiStateFn } from "../function/studio/ai_state.js";
import { runSetupFn } from "../query/authentication/setup.js";
import { $, clipStep, is, num, person, plainTest, says, settings, start, testPrices, textStep, videoStep, workflowTest } from "./fixtures.js";

const who = (as: string, key: string) => s.db.query({ table: user, where: cmp(col("email"), "=", c.text(key + "@studio-test.example")), returnType: "single", as });
const blobOf = (as: string) => s.db.query({ table: media_blob, sort: [{ sortBy: "id", dir: "asc" }], returnType: "single", as });
/** A finished one-step run of `owner`'s with a table-kept picture, and its library item (a draft the team can see). */
const madePicture = (owner: string) => [
  s.db.add({ table: ai_run, as: "pic_run", row: { owner_id: ref(`${owner}.id`), kind: c.text("playground"), idem_key: c.text("pic"), title: c.text("A picture"), status: c.text("done"), private: c.bool(false) } }),
  s.db.add({ table: ai_step, as: "pic_step", row: { run_id: ref("pic_run.id"), seq: c.int(1), kind: c.text("image"), model: c.text("test-image"), status: c.text("succeeded"), attempt: c.int(1) } }),
  s.db.add({ table: media_blob, as: "pic_blob", row: { name: c.text("pic.png"), mime: c.text("image/png"), size: c.int(4), b64: c.text("iVBORw=="), run_id: ref("pic_run.id"), step_id: ref("pic_step.id"), attempt: c.int(1), source_id: c.int(0) } }),
  s.db.add({ table: asset, as: "pic", row: {
    kind: c.text("image"), title: c.text("A picture"), model: c.text("test-image"), maker_id: ref(`${owner}.id`), run_id: ref("pic_run.id"), step_id: ref("pic_step.id"), attempt: c.int(1),
    private: c.bool(false), status: c.text("draft"), file: obj({ mode: c.text("table"), blob_id: ref("pic_blob.id"), name: c.text("pic.png"), mime: c.text("image/png"), size: c.int(4) }),
  } }),
];
const bytes = (as: string, blob: string, actor: string) => s.function.run({ fn: mediaBytesFn, as, input: { blob_id: ref(`${blob}.id`), actor_id: ref(`${actor}.id`) } });

export const firstRunTests = [
  workflowTest({
    name: "plan: a plan that can't keep video, music or speech refuses those kinds before anything is reserved",
    description: "After the first-run check found no paid storage, a video run and a clip run are refused in words with no steps and no money held; a text run starts as usual.",
    stack: [
      settings(), person("sam"), ...testPrices,
      s.db.query({ table: workspace_setting, returnType: "single", as: "row" }),
      s.db.patch({ table: workspace_setting, fieldValue: ref("row.id"), data: obj({ storage_checked: c.bool(true), plan_paid_storage: c.bool(false) }) }),
      start("video", "sam", "v1", [videoStep()]),
      is("video.run.status", "refused"), is("video.run.reason", "plan"),
      says("video.run.detail", "This plan can't save video, voice or music files"), says("video.run.detail", "Nothing was made or charged"),
      start("mixed", "sam", "m1", [textStep(), clipStep()]),
      is("mixed.run.status", "refused"), is("mixed.run.reason", "plan"),
      s.db.query({ table: ai_step, returnType: "count", as: "steps" }), num("steps", 0),
      s.db.query({ table: ledger, returnType: "count", as: "held" }), num("held", 0),
      start("words", "sam", "t1", [textStep()]),
      is("words.run.status", "queued"),
    ],
  }),
  workflowTest({
    name: "media: a table-kept picture reaches whoever may see its item, and reads as not found to anyone else",
    description: "Sam's draft picture: Sam and an admin get its bytes; a guest gets not found until it's approved, then gets it too.",
    stack: [
      settings(), person("jordan", "admin"), person("sam"), person("alex", "guest"),
      ...madePicture("sam"),
      bytes("mine", "pic_blob", "sam"), is("mine.mime", "image/png"), is("mine.b64", "iVBORw=="),
      bytes("admin", "pic_blob", "jordan"), is("admin.name", "pic.png"),
      s.expect.to_throw({ exception: c.text("That file isn't here any more."), body: [blobOf("b"), who("g", "alex"), s.function.run({ fn: mediaBytesFn, as: "x", input: { blob_id: ref("b.id"), actor_id: ref("g.id") } })] }),
      s.function.run({ fn: approveAssetFn, as: "ok", input: { asset_id: ref("pic.id"), actor_id: ref("jordan.id") } }),
      bytes("guest", "pic_blob", "alex"), is("guest.mime", "image/png"),
    ],
  }),
  plainTest({
    name: "media: a recording kept for Knowledge plays for anyone who may ask Knowledge, guests included",
    description: "A source's recording in a table is read by a member and a guest.",
    stack: [
      settings(), person("sam"), person("alex", "guest"),
      s.db.add({ table: media_blob, as: "rec", row: { name: c.text("call.mp3"), mime: c.text("audio/mpeg"), size: c.int(3), b64: c.text("SUQz"), run_id: c.int(0), step_id: c.int(0), attempt: c.int(0), source_id: c.int(7) } }),
      bytes("member", "rec", "sam"), is("member.mime", "audio/mpeg"),
      bytes("guest", "rec", "alex"), is("guest.b64", "SUQz"),
    ],
  }),
  plainTest({
    name: "media: a file shows from its table by id, from a link or only on cloud when kept privately, and not at all without one",
    description: "The one answer every screen asks before showing a made file.",
    stack: [
      s.function.run({ fn: mediaLinkFn, as: "kept", input: { file: c.obj({ mode: "table", blob_id: 5, name: "a.png", mime: "image/png", size: 9 }) } }),
      is("kept.how", "table"), num("kept.blob_id", 5), is("kept.url", ""), is("kept.mime", "image/png"),
      s.function.run({ fn: mediaLinkFn, as: "private", input: { file: c.obj({ path: "/vault/test/clip.mp4", name: "clip.mp4", mime: "video/mp4", size: 9 }) } }),
      // A server that signs private links answers a link; one that can't (the Xano Engine) says it plays on cloud.
      s.expect.to_be_true({ expr: withFilters(c.array(["signed", "cloud_only"]), fl.in(ref("private.how"))) }),
      num("private.blob_id", 0),
      s.function.run({ fn: mediaLinkFn, as: "nothing", input: { file: c.null() } }),
      is("nothing.how", "none"),
    ],
  }),
  workflowTest({
    name: "storage check: the first run learns once what this plan keeps and how made files are shown",
    description: "It stores a tiny recording privately, signs it if it can, removes it, and records the answer; a second check changes nothing.",
    stack: [
      settings(),
      s.function.run({ fn: storageCheckFn, as: "first" }),
      s.expect.to_be_true({ expr: ref("first.storage_checked") }),
      s.expect.to_be_true({ expr: withFilters(c.array(["signed", "table"]), fl.in(ref("first.file_mode"))) }),
      s.db.query({ table: workspace_setting, returnType: "single", as: "row" }),
      s.db.patch({ table: workspace_setting, fieldValue: ref("row.id"), data: obj({ plan_paid_storage: c.bool(false) }) }),
      s.function.run({ fn: storageCheckFn, as: "again" }),
      s.expect.to_be_false({ expr: ref("again.plan_paid_storage") }),
    ],
  }),
  workflowTest({
    name: "setup: the first admin needs the backend's setup token, and a backend is set up once",
    description: "No token set refuses; a wrong token refuses; the right one makes an admin and the settings row at the production budgets; a second setup is refused.",
    stack: [
      s.expect.to_throw({ exception: c.text("Setup is off. Set SETUP_TOKEN on this backend, then try again."), body: [
        s.function.run({ fn: runSetupFn, as: "x", input: { submitted_token: c.text("guess"), expected_token: c.text(""), workspace_name: c.text("Marlow"), name: c.text("Jo"), email: c.text("jo@marlow.example"), password: c.text("Studio-test-1") } }),
      ] }),
      s.expect.to_throw({ exception: c.text("That setup token isn't right."), body: [
        s.function.run({ fn: runSetupFn, as: "x", input: { submitted_token: c.text("guess"), expected_token: c.text("s3cret-token"), workspace_name: c.text("Marlow"), name: c.text("Jo"), email: c.text("jo@marlow.example"), password: c.text("Studio-test-1") } }),
      ] }),
      s.function.run({ fn: runSetupFn, as: "made", input: { submitted_token: c.text("s3cret-token"), expected_token: c.text("s3cret-token"), workspace_name: c.text("Marlow"), name: c.text("Jo"), email: c.text("jo@marlow.example"), password: c.text("Studio-test-1") } }),
      s.db.get({ table: user, fieldValue: ref("made.user_id"), output: ["role", "email"], as: "admin" }),
      is("admin.role", "admin"), is("admin.email", "jo@marlow.example"),
      s.db.query({ table: workspace_setting, returnType: "single", as: "row" }),
      is("row.name", "Marlow"), num("row.team_budget", 100 * $), num("row.person_budget", 25 * $), num("row.approval_line", $ / 2),
      s.expect.to_throw({ exception: c.text("This workspace is already set up. Sign in instead."), body: [
        s.function.run({ fn: runSetupFn, as: "x", input: { submitted_token: c.text("s3cret-token"), expected_token: c.text("s3cret-token"), workspace_name: c.text("Again"), name: c.text("Al"), email: c.text("al@marlow.example"), password: c.text("Studio-test-1") } }),
      ] }),
    ],
  }),
  workflowTest({
    name: "ai state: while AI is off an admin reads what happened, a member that an admin can turn it on, and a plan without paid storage says so",
    description: "Out of credits: the admin reads the credits words and no command; Sam reads to ask an admin. Once the check found no paid storage, both read it.",
    stack: [
      settings(), person("jordan", "admin"), person("sam"),
      s.db.query({ table: workspace_setting, returnType: "single", as: "row" }),
      s.db.patch({ table: workspace_setting, fieldValue: ref("row.id"), data: obj({ ai_status: c.text("no_credits"), ai_status_reason: c.text("Xano AI has run out of credits."), storage_checked: c.bool(true), plan_paid_storage: c.bool(false) }) }),
      s.function.run({ fn: aiStateFn, as: "admin", input: { actor_id: ref("jordan.id") } }),
      is("admin.ai_status", "no_credits"), is("admin.ai_status_reason", "Xano AI has run out of credits."), is("admin.fix_command", ""),
      s.expect.to_be_false({ expr: ref("admin.plan_paid_storage") }),
      s.function.run({ fn: aiStateFn, as: "member", input: { actor_id: ref("sam.id") } }),
      is("member.ai_status", "no_credits"), says("member.ai_status_reason", "Ask an admin to add credits"), is("member.fix_command", ""),
    ],
  }),
  workflowTest({
    name: "sample: the sweep ends the demo's sample run with the clip it carries, as a library item, and charges nothing",
    description: "A running sample a few minutes old: its working step succeeds with its clip, the run is done with nothing spent, and the clip is a draft in the library. A sample just started is left running.",
    stack: [
      settings(), person("jordan", "admin"),
      s.db.add({ table: media_blob, as: "clip", row: { name: c.text("clip.mp4"), mime: c.text("video/mp4"), size: c.int(3), b64: c.text("AAAA"), run_id: c.int(0), step_id: c.int(0), attempt: c.int(0), source_id: c.int(0) } }),
      s.db.add({ table: ai_run, as: "old", row: { owner_id: ref("jordan.id"), kind: c.text("recipe"), idem_key: c.text("sample-old"), title: c.text("Teaser"), status: c.text("running"), sample: c.bool(true),
        created_at: withFilters(c.now(), fl.sub(10 * 60_000)) } }),
      s.db.add({ table: ai_step, as: "old_step", row: { run_id: ref("old.id"), seq: c.int(1), kind: c.text("video"), model: c.text("test-video"), status: c.text("working"), attempt: c.int(1), estimate: c.int(352_000),
        input: obj({ prompt: c.text("A slow pan"), sample_output: obj({ file: obj({ mode: c.text("table"), blob_id: ref("clip.id"), name: c.text("clip.mp4"), mime: c.text("video/mp4"), size: c.int(3) }), duration: c.int(4) }) }) } }),
      s.db.add({ table: ai_run, as: "new", row: { owner_id: ref("jordan.id"), kind: c.text("recipe"), idem_key: c.text("sample-new"), title: c.text("Teaser"), status: c.text("running"), sample: c.bool(true) } }),
      s.function.run({ fn: finishSamplesFn, as: "swept" }),
      num("swept.finished", 1),
      s.db.get({ table: ai_run, fieldValue: ref("old.id"), as: "ended" }),
      is("ended.status", "done"), num("ended.spent", 0), says("ended.detail", "no model was called"),
      s.db.get({ table: ai_step, fieldValue: ref("old_step.id"), as: "step" }),
      is("step.status", "succeeded"), num("step.charged", 0),
      s.expect.to_equal({ expr: ref("step.output.file.blob_id"), value: ref("clip.id") }),
      s.db.query({ table: asset, where: cmp(col("step_id"), "=", ref("old_step.id")), returnType: "single", as: "kept" }),
      is("kept.kind", "video"), is("kept.status", "draft"),
      s.expect.to_equal({ expr: ref("kept.file.blob_id"), value: ref("clip.id") }),
      s.db.query({ table: ledger, returnType: "count", as: "money" }), num("money", 0),
      s.db.get({ table: ai_run, fieldValue: ref("new.id"), as: "still" }), is("still.status", "running"),
    ],
  }),
  plainTest({
    name: "usage: Easel's own turns show by person and model, apart from the money, and turns with no key count for nothing",
    description: "Two of Sam's turns this month add up; a turn with no key set and one last month don't show; the month's spend is untouched.",
    stack: [
      settings(), person("jordan", "admin"), person("sam"),
      s.db.add({ table: easel_turn, as: "t1", row: { user_id: ref("sam.id"), provider: c.text("anthropic"), model: c.text("claude-opus-5-5"), status: c.text("done"), input_tokens: c.int(5000), output_tokens: c.int(400) } }),
      s.db.add({ table: easel_turn, as: "t2", row: { user_id: ref("sam.id"), provider: c.text("anthropic"), model: c.text("claude-opus-5-5"), status: c.text("done"), input_tokens: c.int(3000), output_tokens: c.int(100) } }),
      s.db.add({ table: easel_turn, as: "t3", row: { user_id: ref("sam.id"), provider: c.text("anthropic"), model: c.text("claude-opus-5-5"), status: c.text("no_key"), input_tokens: c.int(0), output_tokens: c.int(0) } }),
      s.db.add({ table: easel_turn, as: "t4", row: { user_id: ref("sam.id"), provider: c.text("anthropic"), model: c.text("claude-opus-5-5"), status: c.text("done"), input_tokens: c.int(9000), output_tokens: c.int(900),
        created_at: withFilters(c.now(), fl.sub(40 * 86_400_000)) } }),
      s.function.run({ fn: usageFn, as: "u", input: { actor_id: ref("jordan.id"), month: c.text("") } }),
      s.expect.to_equal({ expr: withFilters(ref("u.easel"), fl.count()), value: c.int(1) }),
      s.expect.to_equal({ expr: ref("u.easel.0.user_id"), value: ref("sam.id") }),
      num("u.easel.0.turns", 2), num("u.easel.0.input_tokens", 8000), num("u.easel.0.output_tokens", 500), is("u.easel.0.provider", "anthropic"),
      num("u.total", 0),
    ],
  }),
];
