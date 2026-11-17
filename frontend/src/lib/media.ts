// How a screen shows a made file: the one answer for a Library tile, the item sheet, a Knowledge recording and a run's
// output. The server says how (library/media.ts): a one-minute signed link where it can sign private links, or a table-kept
// file's id where it can't (the Xano Engine on a machine). A table-kept file is fetched with the person's own sign-in and
// shown from a blob of the type this app chose, so nothing the file claims about itself decides how it's treated. Neither:
// the file is only in private storage on a server that can't link it, and plays once the app runs on Xano cloud.
import { useEffect, useState } from "react";
import { routePath } from "../../../xano/routes.gen.js";
import { ApiError, XANO_HOST, token } from "@/base/request";

/** What the server answers about a file, in any of its shapes: a link, a table-kept file's id, its type. */
export type MediaRef = { url?: string | null; blob_id?: number | null; mime?: string | null };
export type MediaState = { src: string; state: "loading" | "ready" | "cloud_only" | "none" | "failed" };

/** The words where a file can't be shown on this server. */
export const CLOUD_ONLY_WORDS = "Preview works on Xano cloud: this server can't make private file links.";

/** Types a blob may be shown as. Anything else is bytes to save, never to render. */
const SHOWN = /^(image\/(png|jpeg|webp|gif)|audio\/(mpeg|mp3|wav|x-wav|wave|ogg|webm|aac|mp4)|video\/(mp4|webm))$/;
const shownType = (mime?: string | null) => (mime && SHOWN.test(mime) ? mime : "application/octet-stream");

export const mediaUrl = (blobId: number) => `${XANO_HOST}${routePath("GET media/{id}", { id: blobId })}`;

/** A table-kept file's bytes, through the authed route. Throws in plain words when it can't be read. */
export async function fetchMedia(blobId: number, mime?: string | null): Promise<Blob> {
  const held = token.get();
  const res = await fetch(mediaUrl(blobId), { headers: held ? { authorization: `Bearer ${held}` } : {} });
  if (!res.ok) throw new ApiError(res.status === 404 ? "This file isn't here any more." : "The file didn't load. Try again.", res.status);
  return new Blob([await res.blob()], { type: shownType(mime || res.headers.get("content-type")) });
}

// Recent table-kept files, so a grid and its sheet ask once. A blob's address is dropped when it falls out, and on sign-out.
const KEEP = 48;
const kept = new Map<number, string>();
const asking = new Map<number, Promise<string>>();
function shownBlob(blobId: number, mime?: string | null): Promise<string> {
  const hit = kept.get(blobId);
  if (hit) return Promise.resolve(hit);
  const going = asking.get(blobId);
  if (going) return going;
  const started = fetchMedia(blobId, mime).then((blob) => {
    const url = URL.createObjectURL(blob);
    kept.set(blobId, url);
    if (kept.size > KEEP) {
      const [oldest, address] = kept.entries().next().value!;
      URL.revokeObjectURL(address);
      kept.delete(oldest);
    }
    return url;
  }).finally(() => asking.delete(blobId));
  asking.set(blobId, started);
  return started;
}

/** Drop every kept file, as signing out does. */
export function forgetMedia() {
  for (const address of kept.values()) URL.revokeObjectURL(address);
  kept.clear();
}

/** How a made file shows now: its signed link, a blob of its table-kept bytes, or why it can't. */
export function useMedia(ref: MediaRef | null | undefined): MediaState {
  const blobId = ref?.blob_id ?? 0;
  const url = ref?.url ?? "";
  const [state, setState] = useState<MediaState>(() => (blobId ? { src: kept.get(blobId) ?? "", state: kept.has(blobId) ? "ready" : "loading" } : url ? { src: url, state: "ready" } : { src: "", state: ref ? "cloud_only" : "none" }));
  useEffect(() => {
    if (!blobId) { setState(url ? { src: url, state: "ready" } : { src: "", state: ref ? "cloud_only" : "none" }); return; }
    let live = true;
    setState((s) => (kept.has(blobId) ? { src: kept.get(blobId)!, state: "ready" } : { src: s.state === "ready" && s.src.startsWith("blob:") ? s.src : "", state: "loading" }));
    shownBlob(blobId, ref?.mime).then((src) => live && setState({ src, state: "ready" }), () => live && setState({ src: "", state: "failed" }));
    return () => { live = false; };
  }, [blobId, url, ref?.mime]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** A made file's bytes to save or reuse, however this server keeps it. */
export async function mediaBytes(ref: MediaRef): Promise<Blob> {
  if (ref.blob_id) return fetchMedia(ref.blob_id, ref.mime);
  if (!ref.url) throw new ApiError(CLOUD_ONLY_WORDS, 0);
  const res = await fetch(ref.url);
  if (!res.ok) throw new ApiError("The file didn't download. Try again.", res.status);
  return res.blob();
}
