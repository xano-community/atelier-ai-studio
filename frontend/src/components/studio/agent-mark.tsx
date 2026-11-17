// The one sign that an agent did something for a person: a violet glyph, and "Easel, for Jordan". Violet means an agent and
// nothing else, so it only shows where Easel or someone's connected agent made or asked for a thing.
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";

/** The agent glyph: a small violet disc. `size` "sm" sits in a line of caption text; "md" leads a row. */
export function AgentGlyph({ size = "sm", className }: { size?: "sm" | "md"; className?: string }) {
  return (
    <span aria-hidden data-slot="agent-glyph"
      className={cn("grid shrink-0 place-items-center rounded-full bg-agent-wash text-agent-text", size === "sm" ? "size-4" : "size-6", className)}>
      <Bot className={size === "sm" ? "size-2.5" : "size-3.5"} />
    </span>
  );
}

/** "Easel, for Jordan": the agent, then the person it worked for (their first name, unless `full`). */
export const agentFor = (agent: string, person: string | null | undefined, full = false) => {
  const who = (person ?? "").trim();
  return who ? `${agent}, for ${full ? who : who.split(" ")[0]}` : agent;
};

/** The glyph and "Easel, for Jordan" on one line, truncating with the full words on hover. */
export function AgentBy({ agent, person, full, className }: { agent: string; person: string | null | undefined; full?: boolean; className?: string }) {
  const words = agentFor(agent, person, full);
  return (
    <span data-slot="agent-by" className={cn("inline-flex min-w-0 items-center gap-1.5", className)} title={agentFor(agent, person, true)}>
      <AgentGlyph />
      <span className="truncate text-agent-text">{words}</span>
    </span>
  );
}
