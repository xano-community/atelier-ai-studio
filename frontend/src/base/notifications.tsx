// Notifications (BASELINE.md): the header bell with the unread count. What it opens (notifications-panel.tsx) and
// /notifications (notifications-page.tsx) load apart from the shell. A new one arrives live (a toast with Open) the moment
// the server writes it.
import { Suspense, lazy, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLoad } from "@/components/kit";
import { baseApi } from "./api";
import { useNotificationPush } from "./live";
import { shellToast } from "./toast";

const NotificationPanel = lazy(() => import("./notifications-panel"));

export const NOTIFICATIONS_CHANGED = "base:notifications-changed";
export const announceNotifications = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));

/**
 * How many unread notifications the signed-in person has, kept current: a new one arriving live, or one read
 * anywhere in the app, updates every place that shows the number (the bell, the overview).
 */
export function useUnreadCount() {
  const unread = useLoad(() => baseApi.unread(), []);
  useEffect(() => {
    window.addEventListener(NOTIFICATIONS_CHANGED, unread.reload);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, unread.reload);
  }, [unread.reload]);
  return { count: unread.data?.count ?? 0, loading: !unread.data };
}

/** The header bell: the unread count, and the latest few when it's opened. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount();
  const navigate = useNavigate();
  useNotificationPush((n) => {
    announceNotifications();
    // Someone already looking at the thing it's about doesn't need telling.
    if (n.link && location.pathname === n.link.split("?")[0]) return;
    shellToast.show(n.title, n.link ? { label: "Open", onClick: () => navigate(n.link) } : undefined);
  });
  const count = unread.count;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="relative max-sm:size-11" data-kit="notification-bell" aria-label={count ? `Notifications, ${count} unread` : "Notifications"}>
              <Bell />
              {count > 0 && (
                <span data-kit="notification-count"
                  className="pointer-events-none absolute top-0.5 right-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-micro leading-none font-medium text-primary-foreground tabular-nums ring-2 ring-background max-sm:top-1.5 max-sm:right-1.5">
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Notifications</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" collisionPadding={8} className="w-[min(22rem,calc(100vw-1rem))] p-0">
        {/* The panel's frame is here from the first frame; its rows arrive with it. */}
        <Suspense fallback={<PanelPoster />}>{open && <NotificationPanel onClose={() => setOpen(false)} />}</Suspense>
      </PopoverContent>
    </Popover>
  );
}

/** What the panel looks like while its code arrives: its header, and rows shaped like the ones coming. */
function PanelPoster() {
  return (
    <div aria-hidden>
      <div className="flex h-11 items-center border-b px-3 text-heading">Notifications</div>
      <div className="flex flex-col gap-3 p-3">
        {[0, 1, 2].map((i) => <div key={i} className="h-9 animate-pulse rounded-md bg-muted" />)}
      </div>
    </div>
  );
}
