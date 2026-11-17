// /notifications: everything, or only unread, paged.
import { useEffect } from "react";
import { BellOff, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, LoadError, PageHeader, Pager, StatusTabs, useLoad, useUrlState } from "@/components/kit";
import { baseApi } from "./api";
import { NOTIFICATIONS_CHANGED, announceNotifications } from "./notifications";
import { NotificationRow, useOpenNotification } from "./notifications-panel";

export function NotificationsPage() {
  const [q, setQ] = useUrlState({ show: "all", page: "1" });
  const list = useLoad(() => baseApi.notifications({ unread: q.show === "unread", page: Number(q.page) || 1 }), [q.show, q.page]);
  const openOne = useOpenNotification();
  useEffect(() => {
    window.addEventListener(NOTIFICATIONS_CHANGED, list.reload);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, list.reload);
  }, [list.reload]);
  return (
    <div className="flex max-w-3xl flex-col gap-4" data-testid="notifications-page">
      <PageHeader title="Notifications" description="What needs you, newest first. Opening one marks it read."
        actions={<Button variant="outline" size="sm" onClick={async () => { await baseApi.readAll(); announceNotifications(); }}><CheckCheck />Mark all read</Button>}>
        <StatusTabs value={q.show} onChange={(v) => setQ({ show: v, page: "1" })} options={[{ value: "all", label: "All" }, { value: "unread", label: "Unread" }]} />
      </PageHeader>
      {list.error ? <LoadError title="Your notifications didn't load" error={list.error} onRetry={list.reload} />
        : !list.data ? <div className="flex flex-col gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={`skeleton-${i}`} className="h-16 w-full" />)}</div>
        : list.data.items.length === 0 ? (
          <EmptyState icon={BellOff} title={q.show === "unread" ? "No unread notifications" : "No notifications yet"}
            description={q.show === "unread" ? "You've read everything." : "When something needs you, it shows up here and on the bell."}
            action={q.show === "unread" ? <Button variant="outline" size="sm" onClick={() => setQ({ show: "all", page: "1" })}>Show all</Button> : undefined} />
        ) : (
          <div className="overflow-hidden rounded-lg border bg-card">
            <ul className="divide-y">{list.data.items.map((n) => <NotificationRow key={n.id} n={n} onOpen={(x) => void openOne(x)} />)}</ul>
            {list.data.pageTotal > 1 && <div className="border-t px-4 py-2"><Pager page={list.data.curPage} pageTotal={list.data.pageTotal} onPage={(p) => setQ({ page: String(p) })} /></div>}
          </div>
        )}
    </div>
  );
}
