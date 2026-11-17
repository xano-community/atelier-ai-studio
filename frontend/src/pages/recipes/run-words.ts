// How a recipe run is said: its state as a badge's tone and words, and its own name inside the recipe's.
import type { Tone } from "@/components/kit";

const RUN_STATUS: Record<string, { tone: Tone; label: string }> = {
  starting: { tone: "info", label: "Starting" }, queued: { tone: "info", label: "Queued" }, running: { tone: "info", label: "Running" },
  waiting_approval: { tone: "warning", label: "Waiting for an admin" }, needs_confirmation: { tone: "warning", label: "Needs confirming" }, waiting_confirmation: { tone: "warning", label: "Needs confirming" },
  done: { tone: "success", label: "Done" }, partial: { tone: "warning", label: "Partly done" }, failed: { tone: "danger", label: "Failed" },
  refused: { tone: "danger", label: "Refused" }, declined: { tone: "danger", label: "Declined" }, stopped: { tone: "neutral", label: "Stopped" },
};
export const runStatus = (s: string) => RUN_STATUS[s] ?? { tone: "neutral" as const, label: s };

/** A recipe run's own words: "City 3" from "Product launch kit: City 3" (or "Product launch kit · City 3"). */
export const runLabel = (title: string, recipe: string) =>
  title.startsWith(`${recipe}: `) ? title.slice(recipe.length + 2) : title.startsWith(`${recipe} · `) ? title.slice(recipe.length + 3) : title;
