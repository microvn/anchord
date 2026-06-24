import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// your-activity-actions S-002 — the two-tab "Your activity" page shell. The page mounts the REAL
// <ForYouContent> (2a) and <YourActionsContent> (2b S-001), so BOTH feature clients must be mocked
// (pattern copied from for-you-inbox.test.tsx + your-actions.test.tsx). bun's mock.module is
// process-wide + persistent: reset the stores in beforeEach and the mock fns in afterEach so nothing
// leaks into sibling suites. Deep-link tests use MemoryRouter `initialEntries`.

function envelope<T>(data: T) {
  return { data: { success: true, data }, error: null };
}

// --- notifications client (For-you inbox seam) -------------------------------------------------
type NotifRow = {
  id: string;
  type: string;
  refId: string;
  read: boolean;
  createdAt: string;
  slug: string | null;
  workspaceName?: string | null;
};
let notifPages: Record<number, NotifRow[]> = {};
let notifTotal = 0;

const listNotifications = mock(async (page = 1) => {
  const items = notifPages[page] ?? [];
  const loaded = Object.entries(notifPages)
    .filter(([p]) => Number(p) <= page)
    .reduce((n, [, rows]) => n + rows.length, 0);
  return envelope({
    items,
    pagination: {
      page,
      limit: 50,
      total: notifTotal,
      totalPages: Math.max(1, Math.ceil(notifTotal / 50)),
      hasNext: loaded < notifTotal,
      hasPrevious: page > 1,
    },
  });
});
let unreadCount = 0;
const fetchUnreadCount = mock(async () => envelope({ count: unreadCount }));
const markNotificationRead = mock(async () => envelope({ read: true }));
const markAllNotificationsRead = mock(async () => envelope({ marked: 0 }));
const fetchNotificationPreferences = mock(async () => envelope({}));
const updateNotificationPreference = mock(async () => envelope({}));

mock.module("@/features/notifications/services/client", () => ({
  listNotifications,
  fetchUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  fetchNotificationPreferences,
  updateNotificationPreference,
}));

// --- my-activity client (Your-actions feed seam) -----------------------------------------------
type ActRow = {
  id: string;
  type: string;
  actorUserId: string | null;
  actorName: string;
  summary?: string | null;
  target?: string | null;
  workspaceName?: string | null;
  docTitle?: string | null;
  createdAt: string;
};
let actPages: Record<number, ActRow[]> = {};
let actTotal = 0;

const listMyActivity = mock(async (page = 1) => {
  const items = actPages[page] ?? [];
  const loaded = Object.entries(actPages)
    .filter(([p]) => Number(p) <= page)
    .reduce((n, [, rows]) => n + rows.length, 0);
  return envelope({
    items,
    pagination: {
      page,
      limit: 20,
      total: actTotal,
      totalPages: Math.max(1, Math.ceil(actTotal / 20)),
      hasNext: loaded < actTotal,
      hasPrevious: page > 1,
    },
  });
});

mock.module("@/features/your-activity/services/client", () => ({ listMyActivity }));

const { YourActivityPage } = await import(
  "@/features/your-activity/components/your-activity-page"
);

function renderPage(initialEntry = "/me/activity") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <YourActivityPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  notifPages = { 1: [{ id: "n1", type: "reply", refId: "r1", read: false, createdAt: "2026-06-24T10:00:00", slug: "doc-1", workspaceName: "Acme Platform" }] };
  notifTotal = 1;
  unreadCount = 0;
  actPages = { 1: [{ id: "a1", type: "comment", actorUserId: "u-me", actorName: "Me", summary: "commented on", target: "§Intro", workspaceName: "Acme Platform", docTitle: "Doc A", createdAt: "2026-06-24T09:00:00" }] };
  actTotal = 1;
});
afterEach(() => {
  listNotifications.mockClear();
  fetchUnreadCount.mockClear();
  listMyActivity.mockClear();
});

describe("Your activity two-tab page (your-activity-actions S-002)", () => {
  it("AS-009: switching tabs shows the right surface", async () => {
    const user = userEvent.setup();
    renderPage();
    // Default = For you → the 2a inbox surface is mounted, the Your-actions feed is not.
    await waitFor(() => expect(screen.getByTestId("for-you-content")).toBeInTheDocument());
    expect(screen.queryByTestId("your-actions")).not.toBeInTheDocument();

    // Click "Your actions" → the own-action feed (S-001's component) shows, inbox goes away.
    await user.click(screen.getByTestId("me-tab-actions"));
    await waitFor(() => expect(screen.getByTestId("your-actions")).toBeInTheDocument());
    expect(screen.queryByTestId("for-you-content")).not.toBeInTheDocument();

    // Click "For you" → back to the inbox surface.
    await user.click(screen.getByTestId("me-tab-for-you"));
    await waitFor(() => expect(screen.getByTestId("for-you-content")).toBeInTheDocument());
    expect(screen.queryByTestId("your-actions")).not.toBeInTheDocument();
  });

  it("AS-010: a tab is deep-linkable — ?tab=actions lands on Your actions", async () => {
    renderPage("/me/activity?tab=actions");
    await waitFor(() => expect(screen.getByTestId("your-actions")).toBeInTheDocument());
    expect(screen.queryByTestId("for-you-content")).not.toBeInTheDocument();
    expect(screen.getByTestId("me-tab-actions")).toHaveAttribute("aria-selected", "true");
  });

  it("AS-010: no ?tab (or an unknown value) defaults to For you", async () => {
    // Unknown value → default surface.
    renderPage("/me/activity?tab=bogus");
    await waitFor(() => expect(screen.getByTestId("for-you-content")).toBeInTheDocument());
    expect(screen.queryByTestId("your-actions")).not.toBeInTheDocument();
    expect(screen.getByTestId("me-tab-for-you")).toHaveAttribute("aria-selected", "true");
  });

  it("AS-011: the For you tab composes 2a's ForYouContent (no re-implementation)", async () => {
    renderPage();
    // The 2a inbox surface (its own testid + its toolbar) renders under the For you tab — this story
    // mounts it as-is rather than rebuilding the inbox.
    await waitFor(() => expect(screen.getByTestId("for-you-content")).toBeInTheDocument());
    expect(screen.getByTestId("inbox-toolbar")).toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalled();
  });

  it("C-004: the For-you tab shows an unread pill; the Your actions tab shows none", async () => {
    unreadCount = 3;
    const user = userEvent.setup();
    renderPage();
    // For-you tab carries the unread count pill (matching the prototype).
    await waitFor(() => expect(screen.getByTestId("me-tab-for-you-pill")).toHaveTextContent("3"));
    // The Your actions tab trigger itself has no pill child.
    const actionsTab = screen.getByTestId("me-tab-actions");
    expect(actionsTab.textContent ?? "").toBe("Your actions");
    // Switching to Your actions surfaces no unread/mark control on the panel.
    await user.click(actionsTab);
    await waitFor(() => expect(screen.getByTestId("your-actions")).toBeInTheDocument());
    expect(screen.queryByTestId("inbox-toolbar")).not.toBeInTheDocument();
  });

  it("FE-tabs: the tab shell renders both tabs as a single accessible tablist", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(tabs.map((t) => t.textContent?.replace(/\d+$/, "").trim())).toEqual([
      "For you",
      "Your actions",
    ]);
  });
});
