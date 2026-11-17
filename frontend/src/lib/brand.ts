// The brand kit's API: read and save the kit, and add, show or remove a reference image. Paths from xano/routes.gen.ts,
// types from the defs (import type only), every JSON call through `request()`. An image goes up as a form.
import type { InferResponse } from "@xano/sdk";
import type { readBrand, addBrandImage } from "../../../xano/query/settings.js";
import { routePath } from "../../../xano/routes.gen.js";
import { ApiError, Unauthorized, XANO_HOST, request, token } from "@/base/request";

export type BrandKit = InferResponse<typeof readBrand>;
export type BrandImage = InferResponse<typeof addBrandImage>;
export type BrandColour = BrandKit["colours"][number];
/** What a save sends: every field, an empty one clears it. */
export type BrandDraft = Pick<BrandKit, "voice" | "avoid_words" | "visual_rules" | "default_voice" | "voice_style" | "music_style" | "colours">;

export const brandApi = {
  read: () => request<BrandKit>("GET", routePath("GET brand")),
  save: (draft: BrandDraft) => request<BrandKit>("PUT", routePath("PUT brand"), draft),
  image: (id: number) => request<{ name: string; url: string }>("GET", routePath("GET brand/images/{id}", { id })),
  removeImage: (id: number) => request<{ removed: boolean }>("DELETE", routePath("DELETE brand/images/{id}", { id })),
  async addImage(file: File): Promise<BrandImage> {
    const form = new FormData();
    form.append("file", file, file.name);
    const res = await fetch(XANO_HOST + routePath("POST brand/images"), {
      method: "POST", body: form, headers: { accept: "application/json", ...(token.get() ? { authorization: `Bearer ${token.get()}` } : {}) },
    }).catch(() => { throw new ApiError("The image didn't reach the server. Check your connection, then try again.", 0); });
    const body = await res.json().catch(() => null) as { message?: string } | null;
    if (res.status === 401) throw new Unauthorized();
    if (res.status >= 500) throw new ApiError("The server had a problem with that image. Try again in a moment.", res.status);
    if (!res.ok) throw new ApiError(body?.message || `That image wasn't added (${res.status}).`, res.status);
    return body as unknown as BrandImage;
  },
};

/** The same limits the server checks, so the page can say so before a round trip. */
export const BRAND_LIMITS = { words: 2000, style: 500, avoid: 40, avoidChars: 60, colours: 6, colourName: 30, images: 3, imageBytes: 2 * 1024 * 1024 } as const;
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp";

/** The draft a kit starts as. */
export const draftOf = (kit: BrandKit): BrandDraft => ({
  voice: kit.voice, avoid_words: [...kit.avoid_words], visual_rules: kit.visual_rules, default_voice: kit.default_voice,
  voice_style: kit.voice_style, music_style: kit.music_style, colours: kit.colours.map((c) => ({ ...c })),
});

export const sameDraft = (a: BrandDraft, b: BrandDraft) => JSON.stringify(a) === JSON.stringify(b);

/** "#4a6b57" or "4A6B57" → "#4A6B57"; anything else → null. */
export function normalHex(value: string): string | null {
  const v = value.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(v)) return `#${v.split("").map((c) => c + c).join("")}`.toUpperCase();
  return /^[0-9a-f]{6}$/i.test(v) ? `#${v}`.toUpperCase() : null;
}

/** Add words to the list: split on commas and new lines, trimmed, each once. */
export function addWords(list: string[], typed: string): string[] {
  const next = [...list];
  for (const w of typed.split(/[,\n]/).map((x) => x.trim()).filter(Boolean)) {
    if (!next.some((x) => x.toLowerCase() === w.toLowerCase())) next.push(w);
  }
  return next;
}

/** Whether the kit has anything in it that a run would get. */
export const isEmptyKit = (d: BrandDraft, images: number) =>
  !d.voice && !d.avoid_words.length && !d.visual_rules && !d.default_voice && !d.voice_style && !d.music_style && !d.colours.length && !images;
