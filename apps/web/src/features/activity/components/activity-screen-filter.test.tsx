import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// <ActivityScreen/> category filtering (workspace-activity S-003). The activity client is MOCKED and
// CATEGORY-AWARE: selecting a segment re-fetches with that category (AS-011, server-side filter), the
// per-category counts render in the segment (AS-012), and a NON-"all" filter with zero visible rows
// shows the no-results state whose Clear control returns to All (AS-013).

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

function commentRow(id: string) {
  return {
    id, type: "comment", actorUserId: "u-devin", actorName: "Devin", docId: "d-1",
    projectId: null, versionId: null, commentId: "c-1", annotationId: "a-1",
    summary: "commented on", target: "Render + publish pipeline RFC", meta: null,
    createdAt: new Date(2026, 5, 23, 12, 0, 0).toISOString(),
  };
}

// Visible set: 2 comments, 0 sharing. counts are over the FULL visible set (AS-012).
const COUNTS = { all: 2, comments: 2, versions: 0, sharing: 0, people: 0 };

// Category-aware mock: "sharing" returns an empty page (zero visible share events, AS-013); anything
// else returns the 2 comment rows. Counts ride along on every response.
const fetchActivity = mock(async (_w: string, page = 1, _limit = 20, category = "all") => {
  const items = category === "sharing" ? [] : [commentRow("c-1"), commentRow("c-2")];
  return env({
    items,
    pagination: { page, limit: 20, total: items.length, totalPages: items.length ? 1 : 0, hasNext: false, hasPrevious: false },
    counts: COUNTS,
    category,
  });
});

// bun mock.module is global + persistent: mock the WHOLE client surface (incl. the S-004 detail
// reads) so this partial stub never shadows them with `undefined` for a later suite.
mock.module("@/features/activity/services/client", () => ({
  fetchActivity,
  fetchActivityEvent: mock(async () => env({ event: null })),
  fetchActivityRelated: mock(async () => env({ items: [] })),
}));

const { ActivityScreen } = await import("@/features/activity/components/activity-screen");

function App() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/w/ws-acme/activity"]}>
        <Routes>
          <Route path="/w/:workspaceId/activity" element={<ActivityScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ActivityScreen category filter (workspace-activity S-003)", () => {
  beforeEach(() => fetchActivity.mockClear());

  it("AS-012: the per-category counts render in the segment (over the visible set)", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("activity-filter-segment")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("activity-filter-count-comments").textContent).toBe("2"));
    expect(screen.getByTestId("activity-filter-count-sharing").textContent).toBe("0");
  });

  it("AS-011: selecting a category re-fetches the feed narrowed to it (server-side filter)", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("activity-feed")).toBeTruthy());
    await userEvent.click(screen.getByTestId("activity-filter-versions"));
    // The screen paged the fetch with category=versions (4th arg) — not a client-side slice.
    await waitFor(() => expect(fetchActivity.mock.calls.some((c) => c[3] === "versions")).toBe(true));
  });

  it("AS-013: a filter with no visible matches shows the no-results state; Clear returns to All", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("activity-feed")).toBeTruthy());

    // Select Sharing → zero visible share events → no-results state with a Clear control.
    await userEvent.click(screen.getByTestId("activity-filter-sharing"));
    await waitFor(() => expect(screen.getByText(/No matches/i)).toBeTruthy());
    expect(screen.queryByTestId("activity-feed")).toBeNull();
    const clear = screen.getByRole("button", { name: /clear/i });

    // Clear → back to All → the feed (with its rows) returns.
    await userEvent.click(clear);
    await waitFor(() => expect(screen.getByTestId("activity-feed")).toBeTruthy());
    expect(screen.getByTestId("activity-filter-all").getAttribute("aria-selected")).toBe("true");
  });
});
