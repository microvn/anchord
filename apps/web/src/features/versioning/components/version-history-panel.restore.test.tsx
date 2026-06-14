import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// versioning-diff-ui S-002 — restore a previous version (append-copy → new current). The history
// read (`getVersionHistory`) AND the restore write (`restoreVersion`) live in the feature client,
// which we MOCK here; `sonner` is mocked so the confirm/error toast is assertable. The panel owns
// the restore mutation (keeps the diff inside features/versioning/**): on 201 it shows a confirming
// toast and invalidates the history query, so the panel refetches — the new current appears and the
// older versions stay (nothing deleted). A refused restore shows an error toast and adds no version.
//
// AS-005 (happy): click Restore on v1 at v4 → POST .../versions/1/restore is called with (ws,slug,1)
//   → "Restored v1 as a new version" toast → history refetches → new current v5 at top, v1–v4 remain.
// AS-006 (error): the restore POST is refused/fails → "couldn't restore this version" error toast,
//   NO new version is added (the list returns to its prior state — restore is a server mutation, the
//   only state change is the post-success refetch, so a failure leaves the list untouched).
// C-001: restore is append-copy ONLY — the panel offers a Restore affordance and NO overwrite/delete
//   control; the current (highest) row offers no Restore (restoring current is a no-op).

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });

// Newest-first, as the backend returns. v4 is current.
const HISTORY_AT_V4 = {
  items: [
    { version: 4, createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), publishedBy: { id: "u1", name: "Ada Lovelace" }, isCurrent: true },
    { version: 3, createdAt: new Date(Date.now() - 1 * 86400_000).toISOString(), publishedBy: { id: "u2", name: "Grace Hopper" }, isCurrent: false },
    { version: 2, createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(), publishedBy: { id: "u1", name: "Ada Lovelace" }, isCurrent: false },
    { version: 1, createdAt: new Date(Date.now() - 9 * 86400_000).toISOString(), publishedBy: { id: "u3", name: "Alan Turing" }, isCurrent: false },
  ],
  pagination: { page: 1, pageSize: 50, total: 4 },
};

// After restoring v1 the backend append-copies it as a NEW current v5; v1–v4 all remain.
const HISTORY_AT_V5 = {
  items: [
    { version: 5, createdAt: new Date().toISOString(), publishedBy: { id: "u1", name: "Ada Lovelace" }, isCurrent: true },
    { version: 4, createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), publishedBy: { id: "u1", name: "Ada Lovelace" }, isCurrent: false },
    { version: 3, createdAt: new Date(Date.now() - 1 * 86400_000).toISOString(), publishedBy: { id: "u2", name: "Grace Hopper" }, isCurrent: false },
    { version: 2, createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(), publishedBy: { id: "u1", name: "Ada Lovelace" }, isCurrent: false },
    { version: 1, createdAt: new Date(Date.now() - 9 * 86400_000).toISOString(), publishedBy: { id: "u3", name: "Alan Turing" }, isCurrent: false },
  ],
  pagination: { page: 1, pageSize: 50, total: 5 },
};

const getVersionHistory = mock(async () => okEnv(HISTORY_AT_V4) as unknown);
const restoreVersion = mock(async () => okEnv({ version: 5, previousVersion: 4 }) as unknown);
mock.module("@/features/versioning/services/client", () => ({ getVersionHistory, restoreVersion }));

const toastFn = mock(() => {});
const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(toastFn, { success: mock(() => {}), error: toastError }),
}));

const { VersionHistoryPanel } = await import(
  "@/features/versioning/components/version-history-panel"
);

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
function renderPanel() {
  const onCompare = mock(() => {});
  const onClose = mock(() => {});
  render(
    <QueryClientProvider client={client()}>
      <VersionHistoryPanel
        open
        workspaceId="ws-1"
        slug="my-doc"
        onClose={onClose}
        onCompare={onCompare}
      />
    </QueryClientProvider>,
  );
  return { onCompare, onClose };
}

beforeEach(() => {
  getVersionHistory.mockClear();
  getVersionHistory.mockImplementation(async () => okEnv(HISTORY_AT_V4) as unknown);
  restoreVersion.mockClear();
  restoreVersion.mockImplementation(async () => okEnv({ version: 5, previousVersion: 4 }) as unknown);
  toastFn.mockClear();
  toastError.mockClear();
});

describe("versioning-diff-ui S-002 — restore a previous version", () => {
  it("AS-005: clicking Restore on v1 at v4 calls restoreVersion(ws,slug,1), shows a confirming toast, and refetches → new current v5 with v1–v4 still listed", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByTestId("vh-list");

    // First read returned the v4 history; the next read returns the post-restore v5 history so the
    // refetch shows the new current + the older versions still present (nothing deleted).
    getVersionHistory.mockImplementation(async () => okEnv(HISTORY_AT_V5) as unknown);

    await user.click(screen.getByTestId("vh-restore-1"));

    // The restore POST fired against the older version with (ws, slug, 1).
    await waitFor(() => expect(restoreVersion).toHaveBeenCalledTimes(1));
    expect(restoreVersion).toHaveBeenCalledWith("ws-1", "my-doc", 1);

    // A confirming toast naming the restored version shows.
    await waitFor(() => expect(toastFn).toHaveBeenCalled());
    expect(toastFn.mock.calls.flat().join(" ")).toMatch(/Restored v1 as a new version/i);

    // The panel refetched: a new current v5 is at the top and v1–v4 remain (nothing deleted).
    await waitFor(() => expect(screen.getByTestId("vh-item-5")).toBeInTheDocument());
    const list = screen.getByTestId("vh-list");
    const rows = within(list).getAllByTestId(/^vh-item-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "vh-item-5",
      "vh-item-4",
      "vh-item-3",
      "vh-item-2",
      "vh-item-1",
    ]);
    // v5 is the new current; v1 (the restored source) is still in the list, not deleted.
    expect(within(list).getByTestId("vh-current-5")).toHaveTextContent("Current");
    expect(within(list).getByTestId("vh-item-1")).toBeInTheDocument();
  });

  it("AS-006: a refused restore shows an error toast and adds NO new version (the list is unchanged)", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByTestId("vh-list");

    // The restore POST is refused (e.g. 403 not-an-editor) — returns the Eden error shape.
    restoreVersion.mockImplementation(async () => ({ data: null, error: { status: 403, message: "forbidden" } }));

    await user.click(screen.getByTestId("vh-restore-1"));

    // The error toast fires...
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls.flat().join(" ")).toMatch(/couldn't restore this version/i);
    // ...and the success toast NEVER fired.
    expect(toastFn).not.toHaveBeenCalled();

    // No new version was added — the list still shows exactly v4..v1 (no v5, nothing optimistic).
    const list = screen.getByTestId("vh-list");
    const rows = within(list).getAllByTestId(/^vh-item-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "vh-item-4",
      "vh-item-3",
      "vh-item-2",
      "vh-item-1",
    ]);
    expect(within(list).queryByTestId("vh-item-5")).toBeNull();
  });

  it("C-001: restore is append-copy only — a Restore affordance exists with NO overwrite/delete control, and the current row offers no Restore", async () => {
    renderPanel();
    await screen.findByTestId("vh-list");

    // A non-destructive Restore affordance is offered on the older versions...
    expect(screen.getByTestId("vh-restore-1")).toBeInTheDocument();
    expect(screen.getByTestId("vh-restore-2")).toBeInTheDocument();
    // ...the current (highest) row offers no Restore (restoring current is a no-op).
    expect(screen.queryByTestId("vh-restore-4")).toBeNull();

    // There is NO overwrite/delete affordance anywhere in the panel — only Restore + Compare.
    const panel = screen.getByTestId("version-history-panel");
    expect(within(panel).queryByText(/overwrite/i)).toBeNull();
    expect(within(panel).queryByText(/^delete$/i)).toBeNull();
    expect(within(panel).queryByRole("button", { name: /delete/i })).toBeNull();
  });
});
