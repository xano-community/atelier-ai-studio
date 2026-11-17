// What the bell opens, and the row /notifications shares. Loaded the first time it's needed, so none of it is in the shell:
// the bell itself only has to show a number.
import { useCallback, useEffect } from "react";
import { Link, useNavigate } from "react-router";
import { Bell, BellOff, BookOpen, CheckCheck, Play, ShieldCheck, Sparkles, UserPlus, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Ago, LoadError, useLoad } from "@/components/kit";
import { cn } from "@/lib/utils";
import { baseApi, type Notification } from "./api";
import { NOTIFICATIONS_CHANGED, announceNotifications, useUnreadCount } from "./notifications";

/** Each kind of notification's mark: what it's about, at a glance. */
const KIND_ICON: Record<string, LucideIcon> = { approval: ShieldCheck, run: Play, knowledge: BookOpen, invite: UserPlus, welcome: Sparkles };

/** One notification as a row: unread ones carry a dot and stronger text; opening one marks it read. */
export function NotificationRow({ n, onOpen, compact = false }: { n: Notification; onOpen: (n: Notification) => void; compact?: boolean }) {
  const unread = !n.read_at;
  const Icon = KIND_ICON[n.kind] ?? Bell;
  return (
    <li>
      <button type="button" onClick={() => onOpen(n)} data-kit="notification" data-unread={unread || undefined}
        className={cn("flex w-full min-w-0 items-start gap-3 text-left transition-colors hover:bg-muted/50 active:bg-muted focus-ring-inset", compact ? "px-3 py-2.5" : "px-4 py-3")}>
        <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><Icon className="size-3.5" /></span>
        <span className="min-w-0 flex-1">
          <span className={cn("line-clamp-2 text-body wrap-anywhere", unread ? "font-medium text-foreground" : "text-muted-foreground")} title={n.title}>{n.title}</span>
          {n.body && !compact && <span className="mt-0.5 line-clamp-2 text-caption text-muted-foreground" title={n.body}>{n.body}</span>}
          <Ago value={n.created_at} className="mt-0.5 block text-caption text-muted-foreground" />
        </span>
        <span aria-hidden className={cn("mt-2 size-1.5 shrink-0 rounded-full", unread ? "bg-primary" : "bg-transparent")} />
        {unread && <span className="sr-only">Unread</span>}
      </button>
    </li>
  );
}

/** Opening one reads it, then goes where it points. */
export function useOpenNotification() {
  const navigate = useNavigate();
  return useCallback(async (n: Notification) => {
    if (!n.read_at) { await baseApi.readNotification(n.id).catch(() => {}); announceNotifications(); }
    if (n.link) navigate(n.link);
  }, [navigate]);
}

/** The latest eight, Mark all read, and See all. */
export default function NotificationPanel({ onClose }: { onClose: () => void }) {
  const unread = useUnreadCount();
  const latest = useLoad(() => baseApi.notifications(), []);
  const openOne = useOpenNotification();
  useEffect(() => {
    window.addEventListener(NOTIFICATIONS_CHANGED, latest.reload);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, latest.reload);
  }, [latest.reload]);
  return (
    <div data-kit="notification-panel">
      <div className="flex h-11 items-center justify-between gap-2 border-b pr-1.5 pl-3">
        <span className="text-heading">Notifications</span>
        <Button variant="ghost" size="sm" disabled={!unread.count} onClick={async () => { await baseApi.readAll(); announceNotifications(); }}><CheckCheck />Mark all read</Button>
      </div>
      {latest.error ? <LoadError error={latest.error} onRetry={latest.reload} className="m-3" />
        : !latest.data ? <div className="flex flex-col gap-3 p-3">{[0, 1, 2].map((i) => <Skeleton key={`skeleton-${i}`} className="h-9 w-full" />)}</div>
        : latest.data.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
            <BellOff aria-hidden className="size-5 text-muted-foreground" />
            <p className="text-body font-medium">You're all caught up</p>
            <p className="text-caption text-muted-foreground">Approvals, finished runs and invites show up here.</p>
          </div>
        )
        : <ul className="max-h-96 min-h-0 divide-y overflow-y-auto">{latest.data.items.slice(0, 8).map((n) => <NotificationRow key={n.id} n={n} compact onOpen={(x) => { onClose(); void openOne(x); }} />)}</ul>}
      <div className="border-t p-1">
        <Button asChild variant="ghost" size="sm" className="w-full"><Link to="/notifications" onClick={onClose}>See all notifications</Link></Button>
      </div>
    </div>
  );
}
