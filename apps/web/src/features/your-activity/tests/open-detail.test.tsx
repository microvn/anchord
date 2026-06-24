import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// your-activity-inbox S-003 — open-an-item-to-its-detail flow. Same mock setup as the S-002
// manage-unread suite: mock the notifications SERVICE CLIENT (the Eden thunks) over an in-memory
// store modelling the caller's own rows; the REAL hooks + ForYouContent + InboxList + InboxRow +
// InboxDetail run over a real QueryClient. bun's mock.module is process-wide + persistent — reset the
// store in beforeEach and clear the mock fns in afterEach so nothing leaks into sibling suites.

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
  refLabel?: string | null;
  workspaceName?: string | null;
};

let store: Row[] = [];

function envelope<T>(data: T) {
  return { data: { success: true, data }, error: null };
}

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
    refId: `anno-${id}`,
    read: false,
    createdAt: opts.createdAt ?? "2026-06-24T10:00:00.000Z",
    slug: `doc-${id}`,
    actorName: "Priya",
    docTitle: "Web-core behavior contract",
    snippet: "Agreed — shipping in v3",
    workspaceName: "Acme Platform",
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

describe("For-you inbox — open item detail (your-activity-inbox S-003)", () => {
  it("AS-011: clicking a row opens its detail with the item metadata", async () => {
    store = [row("a", { createdAt: "2026-06-24T12:00:00.000Z" })];
    const user = userEvent.setup();
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-row-a")).toBeInTheDocument());

    await user.click(screen.getByTestId("inbox-row-a"));

    await waitFor(() => expect(screen.getByTestId("inbox-detail")).toBeInTheDocument());
    expect(screen.getByText("Acme Platform")).toBeInTheDocument();
    expect(screen.getAllByText("Web-core behavior contract").length).toBeGreaterThan(0);
    expect(screen.getByTestId("inbox-detail-snippet")).toHaveTextContent("Agreed — shipping in v3");
    // Back returns to the list.
    await user.click(screen.getByTestId("inbox-detail-back"));
    await waitFor(() => expect(screen.getByTestId("inbox-row-a")).toBeInTheDocument());
  });

  it("AS-006: opening an unread item's DETAIL marks it read and the unread count decrements by one (C-008)", async () => {
    store = [
      row("a", { createdAt: "2026-06-24T12:00:00.000Z" }),
      row("b", { createdAt: "2026-06-24T11:00:00.000Z" }),
      row("c", { createdAt: "2026-06-24T10:00:00.000Z" }),
    ];
    const user = userEvent.setup();
    renderContent();
    // The toolbar pill moved to the For-you TAB (your-activity-tabs); here ForYouContent is mounted
    // standalone, so unread is observed via the rows' `data-unread` flag. Start: 3 unread.
    await waitFor(() =>
      expect(screen.getAllByTestId(/^inbox-row-/).filter((r) => r.hasAttribute("data-unread"))).toHaveLength(3),
    );

    await user.click(screen.getByTestId("inbox-row-a"));

    await waitFor(() => expect(screen.getByTestId("inbox-detail")).toBeInTheDocument());
    // Opening the DETAIL is the deliberate engagement gesture → mark read exactly once.
    expect(markNotificationRead).toHaveBeenCalledWith("a");
    expect(markNotificationRead).toHaveBeenCalledTimes(1);
    expect(store.find((r) => r.id === "a")?.read).toBe(true);

    // Back to the list: the unread set has dropped 3 → 2.
    await user.click(screen.getByTestId("inbox-detail-back"));
    await waitFor(() =>
      expect(screen.getAllByTestId(/^inbox-row-/).filter((r) => r.hasAttribute("data-unread"))).toHaveLength(2),
    );
  });

  it("AS-012: the detail's 'Open in doc' links to the deep-link for a slug-backed item", async () => {
    store = [row("a", { slug: "the-doc", refId: "anno-99" })];
    const user = userEvent.setup();
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-row-a")).toBeInTheDocument());

    await user.click(screen.getByTestId("inbox-row-a"));

    await waitFor(() => expect(screen.getByTestId("inbox-detail")).toBeInTheDocument());
    expect(screen.getByTestId("inbox-detail-open-doc")).toHaveAttribute(
      "href",
      "/d/the-doc#annotation-anno-99",
    );
  });

  it("AS-012: a workspace_invited item's detail shows NO 'Open in doc' (no slug)", async () => {
    store = [
      row("inv", {
        type: "workspace_invited",
        slug: null,
        refId: "invitation-1",
        refLabel: "Mercury Docs",
        docTitle: null,
        snippet: null,
        actorName: null,
        workspaceName: "Mercury Docs",
      }),
    ];
    const user = userEvent.setup();
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-row-inv")).toBeInTheDocument());

    await user.click(screen.getByTestId("inbox-row-inv"));

    await waitFor(() => expect(screen.getByTestId("inbox-detail")).toBeInTheDocument());
    expect(screen.queryByTestId("inbox-detail-open-doc")).not.toBeInTheDocument();
  });
});
