import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// <ActivityScreen/> — the workspace-scoped wrapper (workspace-activity S-001). The activity client
// is MOCKED. Asserts the wrapper fetches the workspace feed and pages SERVER-SIDE (one server page
// per feed page, AS-003) — feeding rows down to the presentational <ActivityFeed/>.

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

function activityRow(id: string, createdAt: string, summary = "commented on") {
  return {
    id,
    type: "comment",
    actorUserId: "u-devin",
    actorName: "Devin",
    docId: "d-1",
    projectId: null,
    versionId: null,
    commentId: "c-1",
    annotationId: "a-1",
    summary,
    target: "Render + publish pipeline RFC",
    meta: null,
    createdAt,
  };
}

// AS-003: 25 events, page size 20 → page 1 = 20, page 2 = 5. The mock is page-aware.
const PAGE1 = Array.from({ length: 20 }, (_, i) =>
  activityRow(`p1-${String(i).padStart(2, "0")}`, new Date(2026, 5, 23, 12, 0, 20 - i).toISOString()),
);
const PAGE2 = Array.from({ length: 5 }, (_, i) =>
  activityRow(`p2-${i}`, new Date(2026, 5, 22, 12, 0, 5 - i).toISOString()),
);

const fetchActivity = mock(async (_w: string, page = 1, _limit = 20) =>
  page === 2
    ? env({
        items: PAGE2,
        pagination: { page: 2, limit: 20, total: 25, totalPages: 2, hasNext: false, hasPrevious: true },
      })
    : env({
        items: PAGE1,
        pagination: { page: 1, limit: 20, total: 25, totalPages: 2, hasNext: true, hasPrevious: false },
      }),
);

// bun mock.module is global + persistent: mock the WHOLE client surface (incl. the S-004 detail
// reads + the S-007 stats read) so this partial stub never shadows them with `undefined` for a
// later suite.
mock.module("@/features/activity/services/client", () => ({
  fetchActivity,
  fetchActivityEvent: mock(async () => env({ event: null })),
  fetchActivityRelated: mock(async () => env({ items: [] })),
  fetchActivityStats: mock(async () =>
    env({ counts: { all: 0, comments: 0, versions: 0, sharing: 0, people: 0 }, contributors: [], busiestDoc: null }),
  ),
}));

const { ActivityScreen } = await import("@/features/activity/components/activity-screen");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function App() {
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/w/ws-acme/activity"]}>
        <Routes>
          <Route path="/w/:workspaceId/activity" element={<ActivityScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ActivityScreen (workspace-activity S-001)", () => {
  beforeEach(() => fetchActivity.mockClear());

  it("AS-001: renders the workspace feed — the newest comment row leads under Today", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("activity-feed")).toBeTruthy());
    const rows = screen.getAllByTestId("activity-row");
    expect(rows).toHaveLength(20); // page 1 = 20 rows (C-007)
    expect(rows[0].textContent).toContain("Devin");
    expect(rows[0].textContent).toContain("commented on");
  });

  it("AS-003: page 1 shows the 20 most-recent; the next page shows the remaining 5 older", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByTestId("activity-row")).toHaveLength(20));
    // Go to page 2 via the shared Pagination control.
    const next = screen.getByTestId("pagination-next");
    await userEvent.click(next);
    await waitFor(() => expect(screen.getAllByTestId("activity-row")).toHaveLength(5));
    // The wrapper paged SERVER-SIDE: it fetched page 2 (not a client slice).
    expect(fetchActivity.mock.calls.some((c) => c[1] === 2)).toBe(true);
  });
});
