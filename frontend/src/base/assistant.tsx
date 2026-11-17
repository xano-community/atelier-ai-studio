// Easel, the assistant: the chat module's widget, opened from the header's Ask or ⌘K. It says which model it runs on, or
// what an admin sets up when no model key is set (nothing else in the app needs one). A reply that names a run waiting on
// a person shows the studio's run card under it; one that names only an approval shows the module's approval card.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { decorateApprovalReply } from "@xano-sdk/agents/react";
import { useCan } from "@xano-sdk/rbac/react";
import { ChatWidget, createChatClient, type ChatTurn } from "@xano-sdk/chatbot/react";
import { RunCard } from "@/components/studio/approval-card";
import { api, type EaselStatus } from "@/lib/api";
import { XANO_HOST, token } from "./request";
import { useSession } from "./session";

const client = createChatClient({ apiBaseUrl: `${XANO_HOST}/api:chat`, getToken: () => token.get() });

export type EaselConfig = { name: string; welcome: string; suggestions: string[]; followUps?: (reply: ChatTurn) => string[] };

const RUN_ID = /\brun_id:\s*`?(\d+)/;
/** The lines that carry ids for the card, and a link to Approvals the card replaces. */
const CARD_LINES = /^.*(\b(run_id|approval_id):\s*`?\d+|\]\(\/approvals\)).*$/gm;

/** A reply that names a run: the run card under it, and the id lines out of the text. */
export function decorateEaselReply(reply: ChatTurn) {
  const run = reply.content.match(RUN_ID);
  if (run) return { content: reply.content.replace(CARD_LINES, "").trim(), after: <div className="mt-2"><RunCard runId={Number(run[1])} /></div> };
  const d = decorateApprovalReply(reply);
  return d && { ...d, content: d.content.replace(/^.*\]\(\/approvals\).*$/gm, "").trim() };
}

/** Next questions from the tools the last reply used (chips show them as plain words). */
const followUps = (reply: ChatTurn) => {
  const used = reply.tools ?? [];
  if (used.includes("make_output") || used.includes("start_recipe")) return ["How is that run going?", "How much have I spent this month?"];
  if (used.includes("search_library")) return ["Make a 6 second clip from the approved photo", "Which of these are approved?"];
  if (used.includes("ask_knowledge_base")) return ["Write three Instagram captions from that", "What else do our sources say?"];
  return ["What's approved in the Library?", "What recipes can I run?"];
};

/**
 * What the empty panel says. Set up: what Easel does and which model answers. Not set up: an admin reads the exact step
 * (the server's words), and everyone else learns who can fix it and that the rest of the app works meanwhile.
 */
function welcomeFor(config: EaselConfig, status: EaselStatus | null | undefined, admin: boolean) {
  if (!status) return config.welcome;
  if (status.ready) return `${config.welcome} ${config.name} runs on ${status.label}.`;
  return admin
    ? `${config.name} isn't set up yet: it needs a model key. ${status.setup}`
    : `${config.name} isn't set up yet. Once an admin adds a model key, it answers here. Everything else works without it.`;
}

export default function Easel({ config }: { config: EaselConfig }) {
  const navigate = useNavigate();
  const { signOut } = useSession();
  // Whoever can change the team's setup can add the key, so they get the exact step.
  const admin = useCan("budgets.manage");
  // undefined while it's asked, null when the question failed (the panel then just offers to help).
  const [status, setStatus] = useState<EaselStatus | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api.easel().then((s) => { if (live) setStatus(s); }, () => { if (live) setStatus(null); });
    return () => { live = false; };
  }, []);
  const noKey = !!status && !status.ready;
  return (
    <ChatWidget client={client} assistantName={config.name} launcher="none" defaultSize="side" decorateReply={decorateEaselReply}
      followUps={config.followUps ?? followUps} onNavigate={(href) => navigate(href)} placeholder={`Ask ${config.name} to make, find or explain something…`}
      welcome={welcomeFor(config, status, admin)} suggestions={noKey || status === undefined ? [] : config.suggestions} onUnauthorized={signOut} />
  );
}
