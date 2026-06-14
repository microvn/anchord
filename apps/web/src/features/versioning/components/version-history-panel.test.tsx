import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// versioning-diff-ui S-001 — the version history panel (open + browse). The history read goes
// through the feature client (`getVersionHistory`), which we MOCK here; the panel reaches it via
// the `useVersionHistory` hook → `useApiQuery`, which peels the api-core success envelope. So the
// mock returns the RAW Eden `{ data: <envelope>, error }` shape, matching what treaty delivers.
//
// AS-001: opening lists v4,v3,v2,v1 newest-first, each with label + relative time + publisher; v4
//   marked "Current".
// AS-002 / C-002: the current (v4) row offers Compare but NOT Restore; v1 offers both.
// AS-004 / C-007: a failed read shows an explicit error state, NOT a misleading empty list.
// AS-003 / C-006: the responsive full-width vs side-panel decision is the pure helper (below).

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });

// Newest-first, as the backend returns. publishedBy is server-enriched { id, name } (GAP-001 shipped).
const HISTORY = okEnv({
  items: [
    { version: 4, createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(), publishedBy: { id: "u1", name: "Ada Lovelace" }, isCurrent: true },
    { version: 3, createdAt: new Date(Date.now() - 1 * 86400_000).toISOString(), publishedBy: { id: "u2", name: "Grace Hopper" }, isCurrent: false },
    { version: 2, createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(), publishedBy: { id: "u1", name: "Ada Lovelace" }, isCurrent: false },
    { version: 1, createdAt: new Date(Date.now() - 9 * 86400_000).toISOString(), publishedBy: { id: "u3", name: "Alan Turing" }, isCurrent: false },
  ],
  pagination: { page: 1, pageSize: 50, total: 4 },
});

const getVersionHistory = mock(async () => HISTORY as unknown);
// The panel imports `restoreVersion` too (S-002 — the panel owns restore internally). mock.module
// replaces the WHOLE module, so it must export every named import the panel uses, not just the read.
const restoreVersion = mock(async () => ({ data: { success: true, data: { version: 5, previousVersion: 4 } }, error: null }) as unknown);
mock.module("@/features/versioning/services/client", () => ({ getVersionHistory, restoreVersion }));

const { VersionHistoryPanel, versionPanelIsFullWidth } = await import(
  "@/features/versioning/components/version-history-panel"
);

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
function renderPanel(props: Partial<Parameters<typeof VersionHistoryPanel>[0]> = {}) {
  const onCompare = mock(() => {});
  const onRestore = mock(() => {});
  const onClose = mock(() => {});
  render(
    <QueryClientProvider client={client()}>
      <VersionHistoryPanel
        open
        workspaceId="ws-1"
        slug="my-doc"
        onClose={onClose}
        onCompare={onCompare}
        onRestore={onRestore}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onCompare, onRestore, onClose };
}

beforeEach(() => {
  getVersionHistory.mockClear();
  getVersionHistory.mockImplementation(async () => HISTORY as unknown);
});

describe("versioning-diff-ui S-001 — version history panel", () => {
  it("AS-001: opening lists v4,v3,v2,v1 newest-first, each with label + time + publisher; v4 marked Current", async () => {
    renderPanel();

    // The panel opens and the list renders.
    const list = await screen.findByTestId("vh-list");

    // Rows appear newest-first: the order of the rendered vh-item testids is 4,3,2,1.
    const rows = within(list).getAllByTestId(/^vh-item-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "vh-item-4",
      "vh-item-3",
      "vh-item-2",
      "vh-item-1",
    ]);

    // Each row carries its label + a relative time + the publisher name.
    const v4 = within(list).getByTestId("vh-item-4");
    expect(v4).toHaveTextContent("v4");
    expect(v4).toHaveTextContent(/ago|just now/);
    expect(v4).toHaveTextContent("Ada Lovelace");
    expect(within(list).getByTestId("vh-item-1")).toHaveTextContent("Alan Turing");

    // v4 (the current/highest version) is marked "Current".
    expect(within(list).getByTestId("vh-current-4")).toHaveTextContent("Current");
    expect(within(list).queryByTestId("vh-current-1")).toBeNull();
  });

  it("AS-002 / C-002: the current (v4) row offers Compare but NOT Restore; an older (v1) row offers both", async () => {
    renderPanel();
    await screen.findByTestId("vh-list");

    // v4 = current: Compare present, Restore absent (restoring current is a no-op).
    expect(screen.getByTestId("vh-compare-4")).toBeInTheDocument();
    expect(screen.queryByTestId("vh-restore-4")).toBeNull();

    // v1 = older: both Compare and Restore.
    expect(screen.getByTestId("vh-compare-1")).toBeInTheDocument();
    expect(screen.getByTestId("vh-restore-1")).toBeInTheDocument();
  });

  it("AS-004 / C-007: a failed history read shows an error state, NOT a misleading empty 'no versions' list", async () => {
    getVersionHistory.mockImplementation(async () => ({ data: null, error: { status: 500, message: "boom" } }));
    renderPanel();

    // The explicit error surface appears...
    await screen.findByTestId("vh-error", {}, { timeout: 4000 });
    expect(screen.getByRole("alert")).toHaveTextContent(/couldn't load version history/i);

    // ...and the misleading empty "no versions" list is NEVER shown.
    expect(screen.queryByTestId("vh-empty")).toBeNull();
    expect(screen.queryByTestId("vh-list")).toBeNull();
  });

  it("does not fetch or render while closed", () => {
    renderPanel({ open: false });
    expect(screen.queryByTestId("version-history-panel")).toBeNull();
    expect(getVersionHistory).not.toHaveBeenCalled();
  });
});

describe("AS-003 / C-006 — responsive width decision (pure)", () => {
  it("AS-003: ≤599px is full-width, ≥600px is the side panel", () => {
    // C-006: full-width on the mobile tier (<600), the 340px side panel from 600 up.
    expect(versionPanelIsFullWidth(360)).toBe(true);
    expect(versionPanelIsFullWidth(599)).toBe(true);
    expect(versionPanelIsFullWidth(600)).toBe(false);
    expect(versionPanelIsFullWidth(768)).toBe(false);
    expect(versionPanelIsFullWidth(1440)).toBe(false);
  });
});
