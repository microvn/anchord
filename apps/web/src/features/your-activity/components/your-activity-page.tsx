import { useSearchParams } from "react-router-dom";
import { ForYouContent } from "@/features/your-activity/components/for-you-content";
import { YourActionsContent } from "@/features/your-activity/components/your-actions-content";
import {
  YourActivityTabs,
  type YourActivityTab,
} from "@/features/your-activity/components/your-activity-tabs";
import { useUnreadCount } from "@/features/notifications/hooks/use-notifications";
import { usePageMeta } from "@/hooks/use-page-meta";

// your-activity-actions S-002 — the two-tab "Your activity" page (M7: this story owns the tab shell,
// built EXACTLY ONCE). The account-scoped `/me/activity` page (route mounted by 2a) becomes a
// two-tab surface: "For you" (tab 1 = 2a's <ForYouContent>, composed AS-IS — AS-011, no re-impl) and
// "Your actions" (tab 2 = 2b S-001's <YourActionsContent>, the own-action history).
//
// AS-010: the active tab is deep-linkable via `?tab` — `?tab=actions` lands on Your actions; absent
// or any unrecognized value defaults to For you. Switching a tab writes `?tab` so the URL reflects
// (and shares) the active surface (AS-009). C-004: the unread count pill lives only on the For-you
// tab (via useUnreadCount, the same polled slice the bell uses); the Your actions tab has NO unread/
// mark/count concept and shows no pill.

function tabFromParam(value: string | null): YourActivityTab {
  return value === "actions" ? "actions" : "for-you";
}

export function YourActivityPage() {
  usePageMeta("Your activity");
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = tabFromParam(searchParams.get("tab"));
  const unreadCountQuery = useUnreadCount();
  const unreadCount = unreadCountQuery.data?.count ?? 0;

  const selectTab = (next: YourActivityTab) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        // Default tab stays clean-URL: drop `?tab` for For you, set `?tab=actions` otherwise.
        if (next === "for-you") params.delete("tab");
        else params.set("tab", next);
        return params;
      },
      { replace: true },
    );
  };

  return (
    <section
      className="mx-auto max-w-[760px] px-6 py-8"
      data-testid="your-activity-page"
    >
      <header className="mb-[22px]">
        <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.12em] text-subtle">
          Account
        </div>
        <h1 className="font-serif text-[30px] font-medium leading-[1.05] tracking-[-0.02em] text-ink">
          Your activity
        </h1>
        <p className="mt-2 text-sm text-muted">
          Replies, feedback, and the things you do across every workspace you’re in.
        </p>
      </header>

      <YourActivityTabs value={tab} onChange={selectTab} unreadCount={unreadCount} />

      {tab === "actions" ? (
        <div role="tabpanel" id="panel-actions" aria-labelledby="tab-actions">
          <YourActionsContent />
        </div>
      ) : (
        <div role="tabpanel" id="panel-for-you" aria-labelledby="tab-for-you">
          <ForYouContent />
        </div>
      )}
    </section>
  );
}
