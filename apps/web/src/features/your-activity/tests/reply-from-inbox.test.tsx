import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// your-activity-inbox S-004 — reply to (and optionally resolve) a thread from the inbox detail.
// Same harness as the S-003 open-detail suite: mock the notifications SERVICE CLIENT (the Eden
// thunks) over an in-memory store, AND the viewer SERVICE CLIENT (addComment / setResolution) the
// detail's reply/resolve mutations call — C-003: the inbox goes through the EXISTING annotation
// routes, the backend authorizes. We also mock `sonner` (the resolve confirmation surface). bun's
// mock.module is process-wide + persistent — reset the store in beforeEach + clear every mock fn in
// afterEach so nothing leaks into sibling suites.

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
function errorEnvelope(status = 403) {
  return { data: null, error: { status, value: { error: { code: "FORBIDDEN" } } } };
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

// The viewer thunks the S-004 mutations wrap. addComment's IMPLEMENTATION is swapped per-test to
// vary success vs the backend's refusal (AS-015); setResolution succeeds. The mock fn identities are
// STABLE (so the consumer's `import { addComment }` binding stays valid) — only the impl changes.
const addComment = mock(
  async (_slug: string, _id: string, _body: { body: string }) => envelope({ commentId: "c-1" }),
);
const setResolution = mock(
  async (_slug: string, _id: string, _body: { resolved: boolean }) =>
    envelope({ status: "resolved" }),
);

mock.module("@/features/viewer/services/client", () => ({ addComment, setResolution }));

const toastFn = Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) });
mock.module("sonner", () => ({ toast: toastFn }));

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
    createdAt: "2026-06-24T10:00:00.000Z",
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
  addComment.mockImplementation(async () => envelope({ commentId: "c-1" }));
});
afterEach(() => {
  listNotifications.mockClear();
  fetchUnreadCount.mockClear();
  markNotificationRead.mockClear();
  markAllNotificationsRead.mockClear();
  addComment.mockClear();
  setResolution.mockClear();
  toastFn.mockClear();
  toastFn.error.mockClear();
});

async function openDetail(id: string, user: ReturnType<typeof userEvent.setup>) {
  renderContent();
  await waitFor(() => expect(screen.getByTestId(`inbox-row-${id}`)).toBeInTheDocument());
  await user.click(screen.getByTestId(`inbox-row-${id}`));
  await waitFor(() => expect(screen.getByTestId("inbox-detail")).toBeInTheDocument());
}

describe("For-you inbox — reply/resolve from the detail (your-activity-inbox S-004)", () => {
  it("AS-013: reply posts to the thread (via annotation id) and marks the item read", async () => {
    store = [row("a", { refId: "anno-7", slug: "the-doc" })];
    const user = userEvent.setup();
    await openDetail("a", user);
    markNotificationRead.mockClear(); // the detail already marks-read on open (C-008); isolate the reply's mark.

    await user.type(screen.getByTestId("inbox-reply-input"), "Looks good, merging.");
    await user.click(screen.getByTestId("inbox-reply-submit"));

    // Posted exactly once with (slug, annotationId, { body }).
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
    expect(addComment).toHaveBeenCalledWith("the-doc", "anno-7", { body: "Looks good, merging." });
    // On success the composer clears and the item is marked read (AS-013).
    await waitFor(() =>
      expect(screen.getByTestId("inbox-reply-input")).toHaveValue(""),
    );
    expect(markNotificationRead).toHaveBeenCalledWith("a");
  });

  it("AS-014: resolve from the inbox resolves the thread", async () => {
    store = [row("a", { refId: "anno-7", slug: "the-doc" })];
    const user = userEvent.setup();
    await openDetail("a", user);

    await user.click(screen.getByTestId("inbox-reply-resolve"));

    await waitFor(() => expect(setResolution).toHaveBeenCalledTimes(1));
    expect(setResolution).toHaveBeenCalledWith("the-doc", "anno-7", { resolved: true });
    // The resolve control reflects the resolved state (disabled, relabelled) on success.
    await waitFor(() =>
      expect(screen.getByTestId("inbox-reply-resolve")).toBeDisabled(),
    );
    expect(screen.getByTestId("inbox-reply-resolve")).toHaveTextContent("Resolved");
  });

  it("AS-015: reply refused when the user can't comment is surfaced and does NOT mark read", async () => {
    store = [row("a", { refId: "anno-7", slug: "the-doc" })];
    addComment.mockImplementation(async () => errorEnvelope(403)); // backend comment gate refuses (viewer role).
    const user = userEvent.setup();
    await openDetail("a", user);
    markNotificationRead.mockClear(); // ignore the open-mark; assert the FAILED reply doesn't re-mark.

    await user.type(screen.getByTestId("inbox-reply-input"), "trying to reply");
    await user.click(screen.getByTestId("inbox-reply-submit"));

    // The refusal is surfaced (a visible alert), not silently swallowed.
    await waitFor(() => expect(screen.getByTestId("inbox-reply-error")).toBeInTheDocument());
    expect(addComment).toHaveBeenCalledTimes(1);
    // A failed reply does NOT mark the item read.
    expect(markNotificationRead).not.toHaveBeenCalled();
  });

  it("a workspace_invited item's detail shows NO reply composer (C-003 eligibility)", async () => {
    store = [
      row("inv", {
        type: "workspace_invited",
        slug: null,
        refId: "invitation-1",
        docTitle: null,
        snippet: null,
        actorName: null,
        workspaceName: "Mercury Docs",
      }),
    ];
    const user = userEvent.setup();
    await openDetail("inv", user);
    expect(screen.queryByTestId("inbox-detail-reply")).not.toBeInTheDocument();
  });
});
