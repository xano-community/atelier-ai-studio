// How a made image or recording is kept and shown. A server that can sign private links keeps the file in private storage
// and hands out one-minute links (`signed`). One that can't (the Xano Engine on a machine) keeps images and recordings up to
// 5 MB as bytes in a table, behind an authed route that asks the same read rule as the item or source (`table`). The answer
// comes once, from signing the first file made here, and is kept as a workspace setting. A video stays in private storage
// either way, so on a server that can't sign it says it plays on Xano cloud.
import { and, c, cmp, col, cond, defineFunction, expr, fl, guard, inp, input, obj, or, ref, s, statements, withFilters, type Value } from "@xano/sdk";
import { rbac } from "../../rbac.js";
import { workspace_setting } from "../../base/tables.js";
import { asset } from "../../table/library/asset.js";
import { media_blob } from "../../table/library/media_blob.js";
import { ai_run } from "../../table/studio/ai_run.js";
import { user } from "../../table/user.js";
import { settingsRow } from "../spend/begin.js";

/** The largest file a table keeps: what stays quick to send back as one response. */
export const TABLE_LIMIT = 5 * 1024 * 1024;
const PROBE_SECONDS = 5;
const ADMINS = rbac.rolesWith("budgets.manage");

export type MediaFile = { mode?: "table"; blob_id?: number; path?: string; name: string; mime: string; size: number; meta?: Record<string, unknown> };
/** How a screen shows a file now: a signed link, the table route by blob id, only on Xano cloud, or nothing to show. */
export type MediaLink = { how: "signed" | "table" | "cloud_only" | "none"; url: string; blob_id: number; mime: string };

/**
 * After a made image or recording was stored privately in `storedVar`, keep it in a table instead where this server can't
 * sign links. The first file made here answers that question for good. Anything that goes wrong here leaves the privately
 * stored file as it was: a file is never lost to this step. `value` is the file resource the model returned.
 */
export const keepWhereReadable = (storedVar: string, value: Value, owner: { run: Value; step: Value; attempt: Value; source: Value }) => statements(
  s.conditional({ when: expr(ref(storedVar), "!=", c.null()), then: [
    s.try_catch({
      try: [
        settingsRow("media_settings"),
        s.set_var("media_mode", withFilters(ref("media_settings.file_mode", { safe: true }), fl.first_notnull(c.text("")))),
        s.conditional({ when: [expr(ref("media_settings"), "!=", c.null()), expr(ref("media_mode"), "=", c.text(""))], then: [
          s.set_var("media_probe", c.text("")),
          s.try_catch({
            try: [s.storage.sign_private_url({ pathname: ref(`${storedVar}.path`), ttl: c.int(PROBE_SECONDS), as: "media_signed" }), s.update_var("media_probe", ref("media_signed"))],
            catch: [],
          }),
          s.update_var("media_mode", c.text("signed")),
          s.conditional({ when: expr(withFilters(ref("media_probe"), fl.first_notnull(c.text(""))), "=", c.text("")), then: [s.update_var("media_mode", c.text("table"))] }),
          s.db.patch({ table: workspace_setting, fieldValue: ref("media_settings.id"), data: obj({ file_mode: ref("media_mode") }) }),
        ] }),
        s.conditional({ when: expr(ref("media_mode"), "=", c.text("table")), then: [
          s.storage.read_file_resource({ value, as: "media_bytes" }),
          s.conditional({ when: expr(ref("media_bytes.size"), "<=", c.int(TABLE_LIMIT)), then: [
            s.db.add({ table: media_blob, as: "media_row", row: {
              name: ref(`${storedVar}.name`), mime: ref(`${storedVar}.mime`), size: ref("media_bytes.size"),
              b64: withFilters(ref("media_bytes.data"), fl.base64_encode()),
              run_id: owner.run, step_id: owner.step, attempt: owner.attempt, source_id: owner.source, is_demo: c.bool(false),
            } }),
            s.set_var("media_private_path", ref(`${storedVar}.path`)),
            s.update_var(storedVar, obj({
              mode: c.text("table"), blob_id: ref("media_row.id"), name: ref(`${storedVar}.name`), mime: ref(`${storedVar}.mime`),
              size: ref("media_bytes.size"), type: ref(`${storedVar}.type`, { safe: true }), meta: ref(`${storedVar}.meta`, { safe: true }),
            })),
            s.storage.delete_file({ pathname: ref("media_private_path") }),
          ] }),
        ] }),
      ],
      catch: [],
    }),
  ] }),
);

/** How to show a stored file now. The caller has already checked that this person may see it. */
export const mediaLinkFn = defineFunction({
  name: "media/link",
  description: "How to show a made file now: a signed link, the table route, only on Xano cloud, or nothing.",
  input: { file: input.json(), ttl: input.int() },
  stack: [
    s.set_var("held", withFilters(inp("file"), fl.first_notnull(c.obj({})))),
    s.set_var("blob_id", withFilters(ref("held"), fl.get("blob_id", 0), fl.first_notnull(c.int(0)), fl.to_int())),
    s.set_var("path", withFilters(ref("held"), fl.get("path", ""), fl.first_notnull(c.text("")), fl.to_text())),
    s.set_var("mime", withFilters(ref("held"), fl.get("mime", ""), fl.first_notnull(c.text("")), fl.to_text())),
    s.set_var("how", c.text("none")),
    s.set_var("url", c.text("")),
    s.conditional({
      when: and(expr(withFilters(ref("held"), fl.get("mode", "")), "=", c.text("table")), expr(ref("blob_id"), ">", c.int(0))),
      then: [s.update_var("how", c.text("table"))],
      elif: [{ when: expr(ref("path"), "!=", c.text("")), then: [
        s.update_var("how", c.text("cloud_only")),
        s.try_catch({
          try: [s.storage.sign_private_url({ pathname: ref("path"), ttl: withFilters(inp("ttl"), fl.first_notempty(c.int(60))), as: "signed" }), s.update_var("url", ref("signed"))],
          catch: [],
        }),
        s.update_var("url", withFilters(ref("url"), fl.first_notnull(c.text("")))),
        s.conditional({ when: expr(ref("url"), "!=", c.text("")), then: [s.update_var("how", c.text("signed"))] }),
      ] }],
    }),
  ],
  response: { how: ref("how"), url: ref("url"), blob_id: ref("blob_id"), mime: ref("mime") },
  responseShape: {} as MediaLink,
});

/**
 * A table-kept file's name, type and bytes, for someone allowed to see what it belongs to: a Knowledge recording for anyone
 * who may use Knowledge; a made output by the Library's read rule, or the run's own rule while it has no item. Anything else
 * reads as not found.
 */
export const mediaBytesFn = defineFunction({
  name: "media/bytes",
  description: "A table-kept file's bytes, for someone allowed to see the item, run or recording it belongs to.",
  input: { blob_id: input.int({ required: true }), actor_id: input.int({ required: true }) },
  stack: [
    s.db.get({ table: media_blob, fieldValue: inp("blob_id"), output: ["id", "name", "mime", "run_id", "step_id", "attempt", "source_id"], as: "blob" }),
    guard.found("blob", { errorType: "notfound", message: "That file isn't here any more." }),
    s.db.get({ table: user, fieldValue: inp("actor_id"), output: ["id", "role"], as: "actor" }),
    guard.found("actor", { errorType: "unauthorized", message: "Sign in again." }),
    s.set_var("allowed", c.bool(false)),
    s.conditional({
      when: expr(ref("blob.source_id"), ">", c.int(0)),
      then: [s.conditional({ when: cond.in(ref("actor.role"), c.array(rbac.rolesWith("knowledge.ask"))), then: [s.update_var("allowed", c.bool(true))] })],
      else: [
        s.db.query({ table: asset, where: [cmp(col("step_id"), "=", ref("blob.step_id")), cmp(col("attempt"), "=", ref("blob.attempt"))],
          output: ["id", "maker_id", "private", "status"], returnType: "single", as: "item" }),
        s.conditional({
          when: expr(ref("item"), "!=", c.null()),
          then: [s.conditional({ when: or(
            expr(ref("item.maker_id", { safe: true }), "=", ref("actor.id")),
            cond.in(ref("actor.role"), c.array(ADMINS)),
            and(expr(ref("item.private", { safe: true }), "!=", c.bool(true)), expr(ref("actor.role"), "!=", c.text("guest"))),
            and(expr(ref("item.private", { safe: true }), "!=", c.bool(true)), expr(ref("item.status", { safe: true }), "=", c.text("approved"))),
          ), then: [s.update_var("allowed", c.bool(true))] })],
          else: [
            s.db.get({ table: ai_run, fieldValue: ref("blob.run_id"), output: ["owner_id", "private"], as: "run" }),
            s.conditional({ when: and(expr(ref("run"), "!=", c.null()), or(
              expr(ref("run.owner_id", { safe: true }), "=", ref("actor.id")),
              cond.in(ref("actor.role"), c.array(ADMINS)),
              and(expr(ref("run.private", { safe: true }), "!=", c.bool(true)), expr(ref("actor.role"), "!=", c.text("guest"))),
            )), then: [s.update_var("allowed", c.bool(true))] }),
          ],
        }),
      ],
    }),
    guard.require(expr(ref("allowed"), "=", c.bool(true)), { errorType: "notfound", message: "That file isn't here any more." }),
    s.db.get({ table: media_blob, fieldValue: inp("blob_id"), output: ["b64"], as: "bytes" }),
    guard.found("bytes", { errorType: "notfound", message: "That file isn't here any more." }),
  ],
  response: { name: ref("blob.name"), mime: ref("blob.mime"), b64: ref("bytes.b64") },
  responseShape: {} as { name: string; mime: string; b64: string },
});

/** What a table-kept file's bytes become when a later run needs it as a file again (an image to edit, a first frame). */
export const blobAsResource = (blobId: Value, name: Value, as: string) => statements(
  s.set_var(as, c.null()),
  s.db.get({ table: media_blob, fieldValue: blobId, output: ["b64"], as: `${as}_blob` }),
  s.conditional({ when: expr(ref(`${as}_blob`), "!=", c.null()), then: [
    s.storage.create_file_resource({ filename: name, filedata: withFilters(ref(`${as}_blob.b64`, { safe: true }), fl.base64_decode()), as }),
  ] }),
);

/** A tiny silent WAV: what the first-run check stores privately to learn whether this plan keeps audio, then deletes. */
const SILENT_WAV = "UklGRiwAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQgAAAAAAAAAAAAAAA==";
export const NO_PAID_STORAGE_WORDS = "This plan can't save video, voice or music files. Images and text work. Upgrade the workspace to keep the other kinds.";

/**
 * The first-run storage check, once per workspace: store a tiny recording privately and sign it. A plan that refuses to
 * store it can't keep video, music or speech, and those kinds say so before a run starts. Signing it answers how made files
 * are kept here, unless a file made earlier already did. Nothing is called on a model.
 */
export const storageCheckFn = defineFunction({
  name: "media/storage_check",
  description: "Once per workspace: whether this plan stores recordings privately, and whether this server signs private links.",
  stack: [
    settingsRow("settings"),
    guard.found("settings", { message: "The workspace has no settings row." }),
    s.conditional({ when: expr(ref("settings.storage_checked"), "!=", c.bool(true)), then: [
      s.set_var("paid", c.bool(true)),
      s.set_var("mode", withFilters(ref("settings.file_mode"), fl.first_notnull(c.text("")))),
      s.storage.create_file_resource({ filename: c.text("storage-check.wav"), filedata: withFilters(c.text(SILENT_WAV), fl.base64_decode()), as: "tiny" }),
      s.set_var("kept", c.null()),
      s.try_catch({ try: [s.storage.create_audio({ value: ref("tiny"), access: "private", filename: c.text("storage-check.wav"), as: "made" }), s.update_var("kept", ref("made"))], catch: [s.update_var("paid", c.bool(false))] }),
      s.conditional({ when: expr(ref("kept"), "!=", c.null()), then: [
        s.conditional({ when: expr(ref("mode"), "=", c.text("")), then: [
          s.set_var("probe", c.text("")),
          s.try_catch({ try: [s.storage.sign_private_url({ pathname: ref("kept.path"), ttl: c.int(PROBE_SECONDS), as: "signed" }), s.update_var("probe", ref("signed"))], catch: [] }),
          s.update_var("mode", c.text("signed")),
          s.conditional({ when: expr(withFilters(ref("probe"), fl.first_notnull(c.text(""))), "=", c.text("")), then: [s.update_var("mode", c.text("table"))] }),
        ] }),
        s.try_catch({ try: [s.storage.delete_file({ pathname: ref("kept.path") })], catch: [] }),
      ] }),
      s.db.patch({ table: workspace_setting, fieldValue: ref("settings.id"), data: obj({ storage_checked: c.bool(true), plan_paid_storage: ref("paid"), file_mode: ref("mode") }) }),
    ] }),
    settingsRow("now"),
    guard.found("now", { message: "The workspace has no settings row." }),
  ],
  response: { plan_paid_storage: ref("now.plan_paid_storage"), file_mode: ref("now.file_mode"), storage_checked: ref("now.storage_checked") },
  responseShape: {} as { plan_paid_storage: boolean; file_mode: string; storage_checked: boolean },
});

export const mediaFunctions = [mediaLinkFn, mediaBytesFn, storageCheckFn];
