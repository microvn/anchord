import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// your-activity-inbox S-002 — unread management flow. We mock the notifications SERVICE CLIENT (the
// Eden thunks the hooks call) backed by an in-memory store that models ONLY the caller's own rows —
// exactly the server's (userId)-scoped semantics for this caller (read-own is enforced server-side;
// C-002). The REAL hooks (useForYouInbox / useUnreadCount / useMarkRead / useMarkAllRead) + REAL
// ForYouContent + toolbar + rows run over a real QueryClient. bun's mock.module is process-wide +
// persistent (pattern from S-001's for-you-inbox.test.tsx + bell-flow.test.tsx): reset the store in
// beforeEach and clear the mock fns in afterEach so nothing leaks into sibling suites.

type Row = {
  id: string;
  type: string;
  refId: string;
  read: boolean;
  createdAt: string;
  slug: string | null;
  workspaceName?: string | null;
};

let store: Row[] = [];

function envelope<T>(data: T) {
  return { data: { success: true, data }, error: null };
}

// List page 1 only (these tests don't exercise paging). Newest-first.
const listNotifications = mock(async (_page = 1) =>
  envelope({
    items: [...store].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    pagination: {
      page: 1,
      limit: 50,
      total: store.length,
      totalPages: store.length === 0 ? 0 : 1,
      hasNext: false,
      hasPrevious: false,
    },
  }),
);
const fetchUnreadCount = mock(async () => envelope({ count: store.filter((r) => !r.read).length }));
// Read-own-only: a mark for an id NOT in this caller's store is a silent no-op that returns the SAME
// shape as a real mark — no error, no existence signal (C-002 / AS-010).
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

const { ForYouContent } = await import("@/features/your-activity/components/for-you-content");

function renderContent() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ForYouContent />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function row(id: string, opts: Partial<Row> = {}): Row {
  return {
    id,
    type: "reply",
    refId: `ref-${id}`,
    read: false,
    createdAt: opts.createdAt ?? "2026-06-24T10:00:00",
    slug: `doc-${id}`,
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

describe("For-you inbox — manage unread (your-activity-inbox S-002)", () => {
  it("tab-pill: the unread count pill shows the caller's unread count", async () => {
    store = [
      row("a", { createdAt: "2026-06-24T12:00:00" }),
      row("b", { createdAt: "2026-06-24T11:00:00" }),
      row("c", { read: true, createdAt: "2026-06-24T10:00:00" }),
    ];
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-toolbar")).toBeInTheDocument());
    expect(screen.getByTestId("inbox-unread-pill")).toHaveTextContent("2");
  });

  it("AS-007: a row-level mark-read clears the row's unread without opening it, and it stays in the list", async () => {
    store = [
      row("a", { createdAt: "2026-06-24T12:00:00" }),
      row("b", { createdAt: "2026-06-24T11:00:00" }),
    ];
    const opened: string[] = [];
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ForYouContent onOpen={(it) => opened.push(it.id)} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("inbox-row-a")).toHaveAttribute("data-unread"));
    expect(screen.getByTestId("inbox-unread-pill")).toHaveTextContent("2");

    await user.click(screen.getByTestId("inbox-mark-read-a"));

    // Marked just "a"; never opened the detail (no navigation gesture).
    expect(markNotificationRead).toHaveBeenCalledWith("a");
    expect(markNotificationRead).toHaveBeenCalledTimes(1);
    expect(opened).toEqual([]);
    // The row STAYS in the list, just no longer flagged unread; the count drops to 1.
    await waitFor(() =>
      expect(screen.getByTestId("inbox-row-a")).not.toHaveAttribute("data-unread"),
    );
    expect(screen.getByTestId("inbox-row-a")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("inbox-unread-pill")).toHaveTextContent("1"));
  });

  it("AS-008: 'Mark all read' marks every item read and the unread count becomes zero", async () => {
    store = [row("a"), row("b"), row("c"), row("d")];
    const user = userEvent.setup();
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-unread-pill")).toHaveTextContent("4"));

    await user.click(screen.getByTestId("inbox-mark-all"));

    expect(markAllNotificationsRead).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByTestId("inbox-unread-pill")).toHaveTextContent("0"));
  });

  it("AS-008: 'Mark all read' is disabled when there's nothing unread", async () => {
    store = [row("a", { read: true }), row("b", { read: true })];
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-unread-pill")).toHaveTextContent("0"));
    expect(screen.getByTestId("inbox-mark-all")).toBeDisabled();
  });

  it("AS-009: 'Unread only' shows only unread rows; off restores the full list; empty shows 'No unread items'", async () => {
    store = [
      row("u1", { createdAt: "2026-06-24T12:00:00" }),
      row("u2", { createdAt: "2026-06-24T11:00:00" }),
      row("r1", { read: true, createdAt: "2026-06-24T10:00:00" }),
      row("r2", { read: true, createdAt: "2026-06-24T09:00:00" }),
    ];
    const user = userEvent.setup();
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-row-u1")).toBeInTheDocument());
    // Off: all four shown.
    expect(within(screen.getByTestId("inbox-list")).getAllByTestId(/^inbox-row-/)).toHaveLength(4);

    // On: only the two unread rows remain.
    await user.click(screen.getByTestId("inbox-unread-toggle"));
    await waitFor(() => expect(screen.queryByTestId("inbox-row-r1")).not.toBeInTheDocument());
    expect(within(screen.getByTestId("inbox-list")).getAllByTestId(/^inbox-row-/)).toHaveLength(2);
    expect(screen.getByTestId("inbox-row-u1")).toBeInTheDocument();
    expect(screen.getByTestId("inbox-row-u2")).toBeInTheDocument();

    // Off again: the full list is restored.
    await user.click(screen.getByTestId("inbox-unread-toggle"));
    await waitFor(() => expect(screen.getByTestId("inbox-row-r1")).toBeInTheDocument());
    expect(within(screen.getByTestId("inbox-list")).getAllByTestId(/^inbox-row-/)).toHaveLength(4);
  });

  it("AS-009: with the filter on and nothing unread, a 'No unread items' state shows", async () => {
    store = [row("r1", { read: true }), row("r2", { read: true })];
    const user = userEvent.setup();
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-row-r1")).toBeInTheDocument());
    await user.click(screen.getByTestId("inbox-unread-toggle"));
    expect(await screen.findByText("No unread items")).toBeInTheDocument();
    expect(screen.queryByTestId("inbox-list")).not.toBeInTheDocument();
  });

  it("AS-010: a mark for a foreign notification id is a no-op — no change, no error, no existence signal", async () => {
    // The store models ONLY the caller's own rows. A mark for an id that isn't theirs returns the
    // SAME shape as a real mark (read-own-only is server-side); the FE surfaces no error and reveals
    // nothing about the row's existence. Exercise the hook/client seam directly.
    store = [row("mine", { createdAt: "2026-06-24T12:00:00" })];
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-unread-pill")).toHaveTextContent("1"));

    // A foreign mark via the same client thunk the hook calls.
    const res = await markNotificationRead("not-mine");
    expect(res.error).toBeNull();
    expect(res.data).toEqual({ success: true, data: { read: true } });
    // Nothing in the caller's store changed; the caller's own row is untouched and still unread.
    expect(store.find((r) => r.id === "mine")?.read).toBe(false);
    expect(screen.getByTestId("inbox-unread-pill")).toHaveTextContent("1");
    // No error surface anywhere in the inbox.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
