// The domain's API (CRAFT.md §4, the one contract): paths from xano/routes.gen.ts, types from the defs with
// `import type`, every call through `request()`. The base app's own endpoints are in src/base/api.ts.
import type { InferResponse } from "@xano/sdk";
import type { playgroundEstimate, playgroundHistory, playgroundUse } from "../../../xano/query/playground.js";
import type { EaselStatus } from "../../../xano/query/easel.js";
import { routePath } from "../../../xano/routes.gen.js";
import { qs, request } from "@/base/request";
import type { PlaygroundCatalog } from "./catalog";
import type { RunRequest, RunView } from "./playground";

export { ApiError, XANO_HOST, qs, request, token } from "@/base/request";
export { baseApi } from "@/base/api";
export type { Me, Person } from "@/base/api";

export type Estimate = InferResponse<typeof playgroundEstimate>;
export type History = InferResponse<typeof playgroundHistory>;
export type Used = InferResponse<typeof playgroundUse>;
export type Started = RunView & { outcome: "created" | "existing" };

/** POST studio/runs takes a form when there's a file: every other field goes as JSON text beside it. */
function runBody(r: RunRequest, clientId: string, file: File | null) {
  const body = { client_id: clientId, kind: r.kind, model: r.model, input: r.input, options: r.options, title: r.title, private: true };
  if (!file) return body;
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  form.append("file", file);
  return form;
}

export const api = {
  catalog: () => request<PlaygroundCatalog>("GET", routePath("GET playground/catalog")),
  estimate: (kind: string, model: string, options: Record<string, unknown>) => request<Estimate>("POST", routePath("POST playground/estimate"), { kind, model, options }),
  history: (page = 1) => request<History>("GET", routePath("GET playground/history") + qs({ page })),
  useOutput: (stepId: number) => request<Used>("POST", routePath("POST playground/steps/{id}/use", { id: stepId })),

  /** Start a private Playground run. The same click id twice is one run. */
  startRun: (r: RunRequest, clientId: string, file: File | null = null) => request<Started>("POST", routePath("POST runs"), runBody(r, clientId, file)),
  run: (id: number) => request<RunView>("GET", routePath("GET runs/{id}", { id })),
  stopRun: (id: number) => request<RunView["run"]>("POST", routePath("POST runs/{id}/stop", { id })),
  /** Retry the failed steps. `edits` gives a blocked or failed step a new prompt first. */
  retryRun: (id: number, clientId: string, edits: { step_id: number; prompt: string }[] = []) =>
    request<Started>("POST", routePath("POST runs/{id}/retry", { id }), edits.length ? { client_id: clientId, edits } : { client_id: clientId }),
  confirmRun: (id: number) => request<RunView["run"]>("POST", routePath("POST runs/{id}/confirm", { id })),
  askAdmin: (id: number) => request<RunView["run"]>("POST", routePath("POST runs/{id}/ask-admin", { id })),
  /** Whether Easel can answer, on which model, and what to set up when it can't. */
  easel: () => request<EaselStatus>("GET", routePath("GET easel")),
};

export type { EaselStatus };
