import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// your-activity-inbox S-005 — accept / decline a workspace invite from the inbox detail.
// Same harness style as the S-004 reply suite: mock the notifications SERVICE CLIENT (the Eden
// thunks) over an in-memory store, AND the workspaces SERVICE CLIENT (acceptInvitation /
// rejectInvitation) the invite actions call — C-003: the inbox goes through the EXISTING invitation
// routes, the backend authorizes (the session-email match). The action is TOKENLESS: the inbox
// passes ONLY item.invitationId, never a token (C-007). We also mock `sonner` (the success/degrade
// surface). bun's mock.module is process-wide + persistent — reset the store in beforeEach + clear
// every mock fn in afterEach so nothing leaks into sibling suites.

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
  invitationId?: string | null;
  workspaceName?: string | null;
};

let store: Row[] = [];

function envelope<T>(data: T) {
  return { data: { success: true, data }, error: null };
}
function errorEnvelope(status = 404) {
  return { data: null, error: { status, value: { error: { code: "NOT_FOUND" } } } };
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

// The workspaces thunks the S-005 invite actions wrap. Identities are STABLE (so the consumer's
// `import { acceptInvitation }` binding stays valid) — only the impl changes per-test (success vs the
// route's refusal for AS-019). Other thunks are mocked as no-ops so the module is complete.
const acceptInvitation = mock(async (_id: string, _token?: string) => envelope({ workspaceId: "ws-1", role: "member" }));
const rejectInvitation = mock(async (_id: string, _token?: string) => envelope({ rejected: true }));

mock.module("@/features/workspaces/services/client", () => ({
  acceptInvitation,
  rejectInvitation,
  // unused-by-this-suite thunks, present so the module shape is complete:
  fetchBootstrap: mock(async () => envelope({})),
  setActiveWorkspace: mock(async () => envelope({})),
  createWorkspace: mock(async () => envelope({})),
  renameWorkspace: mock(async () => envelope({})),
  fetchMembers: mock(async () => envelope({})),
  inviteMember: mock(async () => envelope({})),
  removeMember: mock(async () => envelope({})),
  changeMemberRole: mock(async () => envelope({})),
  revokeInvitation: mock(async () => envelope({})),
}));

// The viewer thunks the S-004 mutations import (the hooks module imports them at module scope, so
// mock them too even though this suite doesn't exercise reply/resolve).
const addComment = mock(async () => envelope({ commentId: "c-1" }));
const setResolution = mock(async () => envelope({ status: "resolved" }));
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

function inviteRow(id: string, opts: Partial<Row> = {}): Row {
  return {
    id,
    type: "workspace_invited",
    refId: "ws-mercury", // refId STAYS the workspace id (C-007)
    read: false,
    createdAt: "2026-06-24T10:00:00.000Z",
    slug: null,
    docTitle: null,
    actorName: null,
    snippet: null,
    refLabel: "Mercury Docs",
    invitationId: `inv-${id}`,
    workspaceName: "Mercury Docs",
    ...opts,
  };
}

function replyRow(id: string, opts: Partial<Row> = {}): Row {
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
  acceptInvitation.mockImplementation(async () => envelope({ workspaceId: "ws-1", role: "member" }));
  rejectInvitation.mockImplementation(async () => envelope({ rejected: true }));
});
afterEach(() => {
  listNotifications.mockClear();
  fetchUnreadCount.mockClear();
  markNotificationRead.mockClear();
  markAllNotificationsRead.mockClear();
  acceptInvitation.mockClear();
  rejectInvitation.mockClear();
  toastFn.mockClear();
  toastFn.error.mockClear();
});

async function openDetail(id: string, user: ReturnType<typeof userEvent.setup>) {
  renderContent();
  await waitFor(() => expect(screen.getByTestId(`inbox-row-${id}`)).toBeInTheDocument());
  await user.click(screen.getByTestId(`inbox-row-${id}`));
  await waitFor(() => expect(screen.getByTestId("inbox-detail")).toBeInTheDocument());
}

describe("For-you inbox — accept/decline a workspace invite (your-activity-inbox S-005)", () => {
  it("AS-016: Accept calls the accept thunk with item.invitationId and NO token", async () => {
    store = [inviteRow("inv", { invitationId: "inv-42" })];
    const user = userEvent.setup();
    await openDetail("inv", user);

    await user.click(screen.getByTestId("inbox-invite-accept"));

    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledTimes(1));
    // Tokenless: targets the dedicated invitation id, with NO token argument (C-007).
    expect(acceptInvitation).toHaveBeenCalledWith("inv-42");
  });

  it("AS-017: Decline calls the reject thunk with item.invitationId and NO token", async () => {
    store = [inviteRow("inv", { invitationId: "inv-99" })];
    const user = userEvent.setup();
    await openDetail("inv", user);

    await user.click(screen.getByTestId("inbox-invite-decline"));

    await waitFor(() => expect(rejectInvitation).toHaveBeenCalledTimes(1));
    expect(rejectInvitation).toHaveBeenCalledWith("inv-99");
  });

  it("AS-018: a non-invite (reply) item's detail shows NO accept/decline row", async () => {
    store = [replyRow("r")];
    const user = userEvent.setup();
    await openDetail("r", user);

    expect(screen.queryByTestId("inbox-detail-invite-actions")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inbox-invite-accept")).not.toBeInTheDocument();
    expect(screen.queryByTestId("inbox-invite-decline")).not.toBeInTheDocument();
  });

  it("AS-019: a revoked/already-settled invite degrades gracefully — 'no longer available', no dead error", async () => {
    store = [inviteRow("inv", { invitationId: "inv-gone" })];
    // The route refuses (the invite was revoked/accepted since it landed) → error EdenResult.
    acceptInvitation.mockImplementation(async () => errorEnvelope(404));
    const user = userEvent.setup();
    await openDetail("inv", user);

    await user.click(screen.getByTestId("inbox-invite-accept"));

    // The "no longer available" message surfaces (AS-019), the action buttons clear, and the
    // toast.error degrade fires — never a dead, still-actionable row.
    await waitFor(() => expect(screen.getByTestId("inbox-invite-gone")).toBeInTheDocument());
    expect(screen.queryByTestId("inbox-invite-accept")).not.toBeInTheDocument();
    expect(toastFn.error).toHaveBeenCalled();
  });
});
