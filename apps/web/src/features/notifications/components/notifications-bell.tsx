import { useState } from "react";
import { Icon } from "@/components/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUnreadCount } from "@/features/notifications/hooks/use-notifications";
import { UnreadBadge } from "@/features/notifications/components/unread-badge";
import { NotificationPanel } from "@/features/notifications/components/notification-panel";

// The connected notification bell (notifications-email S-006). Replaces the inert GAP-003
// placeholder: real unread badge (polled) + the dropdown panel. radix DropdownMenu owns
// open/close, outside-click, focus + portal (same composition as UserMenu). Opening the bell
// does NOT clear unread (C-009) — the panel only READS the list; clearing is on click.
//
// Styling mirrors the header's other chrome controls (the ~28px hairline-quiet icon button) and
// folds into the avatar menu on mobile — for the menu variant we keep a plain row trigger so the
// folded item reads as "Notifications" with its badge.

export function NotificationsBell({ testid, inMenu }: { testid: string; inMenu?: boolean }) {
  const [open, setOpen] = useState(false);
  const countQuery = useUnreadCount();
  const count = countQuery.data?.count ?? 0;

  const iconBtn =
    "relative inline-flex size-7 flex-none items-center justify-center rounded-md border border-transparent bg-transparent text-muted transition-colors hover:bg-elev hover:text-ink";
  const menuRow =
    "relative flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-[7px] text-left text-[12.5px] text-ink outline-none transition-colors hover:bg-surface focus:bg-surface [&>svg]:flex-none [&>svg]:text-subtle";

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid={testid}
          aria-label="Notifications"
          className={inMenu ? menuRow : iconBtn}
        >
          <Icon name="bell" size={16} />
          {inMenu && <span>Notifications</span>}
          <UnreadBadge count={count} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="overflow-hidden p-0">
        <NotificationPanel onClose={() => setOpen(false)} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
