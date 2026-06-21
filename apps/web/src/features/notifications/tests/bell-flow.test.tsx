import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

// notifications-email S-006 — the in-app bell read surface (FE half of AS-012..AS-018).
//
// We mock the SERVICE CLIENT (the Eden thunks) — the seam every hook calls — so the REAL hooks
// (useUnreadCount/useNotifications/useMarkRead/useMarkAllRead) + REAL bell + panel run over a real
// QueryClient. The mock backs an in-memory store that mirrors the backend's (userId)-scoped
// semantics for THIS caller (read-own is enforced server-side; here we only model the one caller's
// rows). bun's mock.module is process-wide + persistent — reset the store in beforeEach and the
// mock fns in afterEach so nothing leaks into sibling suites.

type Row = {
  id: string;
  type: string;
  refId: string;
  read: boolean;
  createdAt: string;
  slug: string | null;
  docTitle?: string | null;
  actorName?: string | null;
  snippet?: string | null;
};

let store: Row[] = [];

function envelope<T>(data: T) {
  return { data: { success: true, data }, error: null };
}

const listNotifications = mock(async () =>
  envelope({
    items: [...store].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    pagination: {
      page: 1,
      limit: 20,
      total: store.length,
      totalPages: store.length === 0 ? 0 : 1,
      hasNext: false,
      hasPrevious: false,
    },
  }),
);
const fetchUnreadCount = mock(async () => envelope({ count: store.filter((r) => !r.read).length }));
const markNotificationRead = mock(async (id: string) => {
  const row = store.find((r) => r.id === id);
  if (row) row.read = true;
  return envelope({ read: true });
});
const markAllNotificationsRead = mock(async () => {
  let n = 0;
  for (const r of store) if (!r.read) { r.read = true; n++; }
  return envelope({ marked: n });
});

mock.module("@/features/notifications/services/client", () => ({
  listNotifications,
  fetchUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
}));

const { NotificationsBell } = await import("@/features/notifications/components/notifications-bell");

// A location probe so we can assert the deep-link navigation target (AS-014.T2).
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location">{loc.pathname + loc.hash}</div>;
}

function renderBell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/w/ws-1"]}>
        <NotificationsBell testid="header-notifications" />
        <Routes>
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function row(id: string, opts: Partial<Row> = {}): Row {
  return {
    id,
    type: "thread_activity",
    refId: `ref-${id}`,
    read: false,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    slug: "slug" in opts ? (opts.slug as string | null) : `doc-${id}`,
    ...opts,
  };
}

beforeEach(() => {
  store = [];
});
afterEach(() => {
  listNotifications.mockClear();
  fetchUnreadCount.mockClear();
  markNotificationRead.mockClear();
  markAllNotificationsRead.mockClear();
});

describe("notifications bell flow (notifications-email S-006)", () => {
  it("AS-013: the unread badge shows the caller's unread count", async () => {
    store = [row("a"), row("b"), row("c", { read: true })];
    renderBell();
    await waitFor(() => expect(screen.getByTestId("notifications-badge")).toHaveTextContent("2"));
  });

  it("AS-016: with zero notifications, no badge — and opening the bell shows 'You're all caught up'", async () => {
    store = [];
    const user = userEvent.setup();
    renderBell();
    await waitFor(() => expect(fetchUnreadCount).toHaveBeenCalled());
    expect(screen.queryByTestId("notifications-badge")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("header-notifications"));
    expect(await screen.findByTestId("notifications-empty")).toHaveTextContent("You're all caught up");
  });

  it("C-009: opening the bell does NOT mark anything read (no mark call, badge unchanged)", async () => {
    store = [row("a"), row("b")];
    const user = userEvent.setup();
    renderBell();
    await waitFor(() => expect(screen.getByTestId("notifications-badge")).toHaveTextContent("2"));
    await user.click(screen.getByTestId("header-notifications"));
    await screen.findByTestId("notification-panel");
    expect(markNotificationRead).not.toHaveBeenCalled();
    expect(markAllNotificationsRead).not.toHaveBeenCalled();
    expect(screen.getByTestId("notifications-badge")).toHaveTextContent("2");
  });

  it("AS-014: clicking one unread row marks JUST it, decrements the badge, and deep-links to its thread", async () => {
    store = [row("a", { createdAt: "2026-06-20T10:00:00Z" }), row("b", { createdAt: "2026-06-20T09:00:00Z" })];
    const user = userEvent.setup();
    renderBell();
    await waitFor(() => expect(screen.getByTestId("notifications-badge")).toHaveTextContent("2"));
    await user.click(screen.getByTestId("header-notifications"));
    const panel = await screen.findByTestId("notification-panel");
    // Click row "a" (refId ref-a, slug doc-a).
    await user.click(within(panel).getByTestId("notification-row-a"));
    // AS-014.T2: navigated to the row's deep-link.
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/d/doc-a#annotation-ref-a"),
    );
    expect(markNotificationRead).toHaveBeenCalledWith("a");
    expect(markNotificationRead).toHaveBeenCalledTimes(1); // ONLY that row
    // Badge decrements to 1 (b stays unread).
    await waitFor(() => expect(screen.getByTestId("notifications-badge")).toHaveTextContent("1"));
  });

  it("AS-015: 'mark all read' clears every unread row and the badge disappears", async () => {
    store = [row("a"), row("b"), row("c"), row("d")];
    const user = userEvent.setup();
    renderBell();
    await waitFor(() => expect(screen.getByTestId("notifications-badge")).toHaveTextContent("4"));
    await user.click(screen.getByTestId("header-notifications"));
    await screen.findByTestId("notification-panel");
    await user.click(screen.getByTestId("notifications-mark-all"));
    expect(markAllNotificationsRead).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId("notifications-badge")).not.toBeInTheDocument());
  });

  it("AS-018: 'mark all read' is disabled when nothing is unread (idempotent no-op surface)", async () => {
    store = [row("a", { read: true }), row("b", { read: true })];
    const user = userEvent.setup();
    renderBell();
    await waitFor(() => expect(fetchUnreadCount).toHaveBeenCalled());
    await user.click(screen.getByTestId("header-notifications"));
    await screen.findByTestId("notification-panel");
    expect(screen.getByTestId("notifications-mark-all")).toBeDisabled();
  });

  it("AS-026/AS-027/AS-028: a comment-type row renders '{actor} … {docTitle}' + the snippet", async () => {
    store = [
      row("a", {
        type: "thread_activity",
        actorName: "Mara",
        docTitle: "Refund Spec",
        snippet: "can we cap the partial refund at 50%",
      }),
    ];
    const user = userEvent.setup();
    renderBell();
    await waitFor(() => expect(screen.getByTestId("notifications-badge")).toHaveTextContent("1"));
    await user.click(screen.getByTestId("header-notifications"));
    const panel = await screen.findByTestId("notification-panel");
    // Headline names the actor + the doc title (AS-026/AS-027).
    expect(within(panel).getByTestId("notification-row-a")).toHaveTextContent("Mara commented in Refund Spec");
    // The comment excerpt renders on its own line (AS-028) as inert text.
    expect(within(panel).getByTestId("notification-snippet-a")).toHaveTextContent(
      "can we cap the partial refund at 50%",
    );
  });

  it("AS-029: an `invited` row (no actor/snippet) renders the generic per-type summary, no snippet line", async () => {
    store = [row("a", { type: "invited", slug: null, docTitle: null, actorName: null, snippet: null })];
    const user = userEvent.setup();
    renderBell();
    await waitFor(() => expect(screen.getByTestId("notifications-badge")).toHaveTextContent("1"));
    await user.click(screen.getByTestId("header-notifications"));
    const panel = await screen.findByTestId("notification-panel");
    // Generic per-type summary; no actor/title interpolation, no snippet element.
    expect(within(panel).getByTestId("notification-row-a")).toHaveTextContent("You were invited to a document");
    expect(within(panel).queryByTestId("notification-snippet-a")).not.toBeInTheDocument();
  });

  it("an `invited`-style row with no slug marks read but does NOT navigate (no deep-link)", async () => {
    store = [row("a", { type: "invited", slug: null })];
    const user = userEvent.setup();
    renderBell();
    await waitFor(() => expect(screen.getByTestId("notifications-badge")).toHaveTextContent("1"));
    await user.click(screen.getByTestId("header-notifications"));
    const panel = await screen.findByTestId("notification-panel");
    await user.click(within(panel).getByTestId("notification-row-a"));
    expect(markNotificationRead).toHaveBeenCalledWith("a");
    // No deep-link → stays on the start route.
    expect(screen.getByTestId("location")).toHaveTextContent("/w/ws-1");
  });
});
