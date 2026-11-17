// The agents module's provider, around the screens and Easel. It loads just after the shell (app.tsx starts it at once), so
// the module stays out of the first paint, and it reports the approvals count to the sidebar (pending.ts).
import { useEffect, useMemo, type ReactNode } from "react";
import { Link } from "react-router";
import { AgentsProvider, createAgentsClient, usePendingCount } from "@xano-sdk/agents/react";
import { XANO_HOST, token } from "./request";
import { setPendingCount } from "./pending";

const client = createAgentsClient({ agentApiBaseUrl: `${XANO_HOST}/api:agent`, approvalsApiBaseUrl: `${XANO_HOST}/api:approvals`, getToken: () => token.get() });

function PendingCount() {
  const n = usePendingCount();
  useEffect(() => { setPendingCount(n); }, [n]);
  return null;
}

export default function AgentsArea({ userId, children }: { userId: number; children: ReactNode }) {
  const renderLink = useMemo(() => (href: string, label: ReactNode) => <Link to={href}>{label}</Link>, []);
  useEffect(() => () => setPendingCount(0), []);
  return (
    <AgentsProvider client={client} currentUserId={userId} backendUrl={XANO_HOST} renderLink={renderLink}>
      <PendingCount />
      {children}
    </AgentsProvider>
  );
}
