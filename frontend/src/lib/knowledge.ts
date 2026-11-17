// Knowledge's API: the team's sources and Ask. Paths from xano/routes.gen.ts, types from the defs (import type only),
// every JSON call through `request()`. An upload goes as a form, with progress, through the same base URL and token.
import type { InferResponse } from "@xano/sdk";
import type { askRoute, listSources, readSource, recentQuestions } from "../../../xano/query/knowledge.js";
import { routePath } from "../../../xano/routes.gen.js";
import { ApiError, Unauthorized, XANO_HOST, request, token } from "@/base/request";

export type Source = InferResponse<typeof listSources>["items"][number];
export type SourceDetail = InferResponse<typeof readSource>;
export type Passage = SourceDetail["passages"][number];
export type Answer = InferResponse<typeof askRoute>;
export type Citation = Answer["citations"][number];
/** One of your own past questions, with the answer as it was given. */
export type Asked = InferResponse<typeof recentQuestions>["items"][number];

export const knowledgeApi = {
  sources: () => request<InferResponse<typeof listSources>>("GET", routePath("GET sources")),
  source: (id: number) => request<SourceDetail>("GET", routePath("GET sources/{id}", { id })),
  remove: (id: number) => request<{ removed: boolean }>("DELETE", routePath("DELETE sources/{id}", { id })),
  retry: (id: number, client_id: string) => request<Source>("POST", routePath("POST sources/{id}/retry", { id }), { client_id }),
  audio: (id: number) => request<{ url: string; blob_id: number; mime: string | null }>("GET", routePath("GET sources/{id}/audio", { id })),
  ask: (question: string, client_id: string) => request<Answer>("POST", routePath("POST ask"), { question, client_id }),
  /** Your own recent questions, newest first. Nobody else's. */
  questions: () => request<InferResponse<typeof recentQuestions>>("GET", routePath("GET questions")),
  /** Confirm your own processing run that's above the approval line (it then starts). */
  confirm: (runId: number) => request<unknown>("POST", routePath("POST runs/{id}/confirm", { id: runId })),
};

/** What Knowledge takes, for the file picker. The server checks again and says why it refused. */
export const ACCEPT = ".pdf,.txt,.md,.markdown,.mp3,.m4a,.wav,.aiff,.aif,.ogg,.flac,.webm,.aac,application/pdf,text/plain,text/markdown,audio/*";

/**
 * Upload one file as a new source. `clientId` is this file's own key: sending it again (a retry after a dropped
 * connection) adds the source once. `onProgress` gets 0 to 1 while the bytes go up.
 */
export function uploadSource(file: File, clientId: string, onProgress: (share: number) => void, signal?: AbortSignal): Promise<Source> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", XANO_HOST + routePath("POST sources"));
    xhr.setRequestHeader("accept", "application/json");
    const t = token.get();
    if (t) xhr.setRequestHeader("authorization", `Bearer ${t}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onerror = () => reject(new ApiError("The upload didn't reach the server. Check your connection, then retry.", 0));
    xhr.onabort = () => reject(new ApiError("Cancelled.", -1));
    xhr.onload = () => {
      let body: { message?: string } | null = null;
      try { body = JSON.parse(xhr.responseText); } catch { body = null; }
      if (xhr.status === 401) { reject(new Unauthorized()); return; }
      if (xhr.status >= 500) { reject(new ApiError("The server had a problem with that upload. Retry in a moment.", xhr.status)); return; }
      if (xhr.status >= 400) { reject(new ApiError(body?.message || `That didn't upload (${xhr.status}).`, xhr.status)); return; }
      resolve(body as unknown as Source);
    };
    signal?.addEventListener("abort", () => xhr.abort());
    const form = new FormData();
    form.append("client_id", clientId);
    form.append("file", file, file.name);
    xhr.send(form);
  });
}

/** "4:12", or "1:02:03" past an hour. */
export const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};
/** "38 min", "1 h 12 min", "45 s". */
export const lengthOf = (seconds: number) => {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`;
};
export const sizeOf = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
/** "$0.005", "under $0.001": what an Ask cost, from micro-dollars. */
export const costOf = (micro: number) => (micro <= 0 ? "$0" : micro < 1000 ? "under $0.001" : `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 3 : 2)}`);
/** What something cost, as a person says it: "nothing charged", "under $0.001", or "about $0.07". */
export const spentWords = (micro: number) => (micro <= 0 ? "nothing charged" : micro < 1000 ? "under $0.001" : `about ${costOf(micro)}`);
/** "claude-sonnet-5-5" → "Claude Sonnet 5.5", "gemini-3.8-flash" → "Gemini 3.8 Flash": a model id as a name. */
export const modelName = (id: string) => id.split("-").reduce<string[]>((out, w) => {
  if (/^\d+$/.test(w) && /\d$/.test(out[out.length - 1] ?? "")) out[out.length - 1] += `.${w}`;
  else out.push(/^\d/.test(w) || !w ? w : /^(tts|hd|xl)$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1));
  return out;
}, []).join(" ");

/** A run of an answer's text, or the citation numbers at that point. */
export type AnswerPart = { text: string } | { cite: number[] };
/**
 * An answer split at its citation marks, so each mark shows as chips and never as raw brackets. Models write "[2]",
 * "[1, 2]", "[1][3]", "[1] [3]" and "[1-3]"; each becomes one list of numbers, and the space before a mark goes with it.
 */
export function citedNumbers(text: string): AnswerPart[] {
  const parts: AnswerPart[] = [];
  // A comma between two marks ("[1], [2]") belongs to them; one after the last mark is the sentence's.
  const mark = /\s*((?:\[\s*\d+(?:\s*(?:,|-|–)\s*\d+)*\s*\](?:\s*,(?=\s*\[))?\s*)+)/g;
  let last = 0;
  for (const m of text.matchAll(mark)) {
    const nums: number[] = [];
    for (const group of m[1].matchAll(/\[([^\]]+)\]/g)) {
      for (const piece of group[1].split(",")) {
        const range = piece.split(/-|–/).map((x) => Number(x.trim()));
        if (range.length === 2 && range[0] <= range[1] && range[1] - range[0] < 20) for (let n = range[0]; n <= range[1]; n++) nums.push(n);
        else nums.push(range[0]);
      }
    }
    // "[2024]" is a year, not a citation: it stays as text.
    if (nums.some((n) => n > 99)) continue;
    const before = text.slice(last, m.index);
    if (before) parts.push({ text: before });
    parts.push({ cite: [...new Set(nums.filter((n) => Number.isFinite(n) && n > 0))] });
    // A space the mark swallowed before the next word comes back; one before punctuation doesn't.
    const after = text.slice((m.index ?? 0) + m[0].length);
    last = (m.index ?? 0) + m[0].length;
    if (/\s$/.test(m[0]) && after && !/^[.,;:!?)]/.test(after)) parts.push({ text: " " });
  }
  const rest = text.slice(last);
  if (rest) parts.push({ text: rest });
  return parts;
}

/** An answer as one plain line for a list: its words without the citation marks. */
export const answerLine = (answer: string) =>
  citedNumbers(answer).map((p) => ("text" in p ? p.text : "")).join("").replace(/\s+/g, " ").trim();

/** Whether a past question's answer was kept, so it can be shown again without asking. */
export const answerKept = (a: Pick<Asked, "state">) => a.state === "answered" || a.state === "not_found";

/** The sources an answer cites, each once, in the order it cites them. */
export function citedSources(citations: Pick<Citation, "source_id" | "title" | "kind">[]) {
  const seen = new Map<number, { id: number; title: string; kind: Citation["kind"] }>();
  for (const c of citations) if (!seen.has(c.source_id)) seen.set(c.source_id, { id: c.source_id, title: c.title, kind: c.kind });
  return [...seen.values()];
}

/**
 * Questions to start with, written for the sources a team has: a specific question for each source we know, then, for
 * sources we don't, one plain question about what each says. At most four.
 */
const KNOWN_QUESTIONS: [string, string][] = [
  ["Customer call: Halden Cycles", "Which Trail 2 frame should a rider between a medium and a large pick?"],
  ["Dealer call: Oak & Spoke on the City 3", "What do dealers get asked most about the City 3?"],
  ["Marlow brand voice guide", "Which words does our brand voice guide rule out?"],
  ["Autumn launch plan", "What goes into each autumn launch kit, and who gets it first?"],
  ["Trail 2 spec sheet", "How much tyre clearance does the Trail 2 have?"],
  ["City 3 product notes", "What confuses riders about the City 3's rack mounts?"],
];
export function starterQuestions(ready: Pick<Source, "title" | "kind">[], most = 4): string[] {
  const titles = new Set(ready.map((s) => s.title));
  const known = KNOWN_QUESTIONS.filter(([t]) => titles.has(t)).map(([, q]) => q);
  const knownTitles = new Set(KNOWN_QUESTIONS.map(([t]) => t));
  const others = ready.filter((s) => !knownTitles.has(s.title)).map((s) => (s.kind === "recording" ? `What came up in ${s.title}?` : `What does ${s.title} say?`));
  return [...known, ...others].slice(0, most);
}
