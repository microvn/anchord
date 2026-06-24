import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// <ActivityDetailScreen/> — the workspace-scoped detail wrapper (workspace-activity S-004). The
// activity client + the versioning diff client are MOCKED. Asserts the page renders the event's
// metadata, the publish source diff (reusing the versioning-diff), and the "Open doc" deep-link, and
// that a deleted-doc event still renders while "Open doc" degrades.
//
// AS map:
//   AS-014  the detail shows actor / document / project / version / when
//   AS-015  a publish event's detail shows a real v3→v4 source diff (reused) with the add/remove counts
//   AS-016  "Open doc" deep-links to the exact annotation (#annotation-<id>)
//   AS-017  "Open doc" falls back to the doc top when the annotation detached (no fragment)
//   AS-018  a deleted-target event still renders from its stored fields + "Open doc" degrades

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });

// One publish event by Devin on the RFC doc, v3→v4 +5/−2, project web-core, annotationId present.
function publishEvent(over: Record<string, unknown> = {}) {
  return {
    id: "e-pub",
    type: "publish",
    actorUserId: "u-devin",
    actorName: "Devin",
    docId: "d-rfc",
    projectId: "p-web",
    versionId: "ver-4",
    commentId: null,
    annotationId: "anno-1",
    summary: "published",
    target: "Render + publish pipeline RFC",
    // Numbers — the real backend publish emit (S-005) writes from/to as version NUMBERS,
    // not "v3"/"v4" strings. (Regression guard: a string fixture hid a crash in versionNumber.)
    meta: { from: 3, to: 4, adds: 5, dels: 2 },
    createdAt: new Date(2026, 5, 23, 12, 0, 0).toISOString(),
    docSlug: "render-pipeline-rfc",
    projectName: "web-core",
    ...over,
  };
}

const RELATED = [
  {
    id: "e-c1",
    type: "comment",
    actorUserId: "u-mara",
    actorName: "Mara",
    docId: "d-rfc",
    projectId: null,
    versionId: null,
    commentId: "c1",
    annotationId: "a1",
    summary: "commented on",
    target: "Render + publish pipeline RFC",
    meta: null,
    createdAt: new Date(2026, 5, 23, 11, 0, 0).toISOString(),
  },
];

// The real v3→v4 source line-diff the versioning client returns (reused by PublishDiffMini, AS-015).
const SOURCE_DIFF = okEnv({
  mode: "text",
  identical: false,
  changeCount: 7,
  lines: [
    { type: "context", text: "# Render pipeline" },
    { type: "added", text: "new line a" },
    { type: "removed", text: "old line b" },
  ],
  renderPair: ["/v/idA", "/v/idB"],
});

let eventResponse: unknown;
let relatedResponse: unknown;

const fetchActivityEvent = mock(async () => eventResponse);
const fetchActivityRelated = mock(async () => relatedResponse);
const getDiff = mock(async () => SOURCE_DIFF);

// bun mock.module is global + persistent — mock the WHOLE surface (incl. the feed read) so this stub
// never shadows it with `undefined` for a sibling suite; afterAll(mock.restore) clears it.
mock.module("@/features/activity/services/client", () => ({
  fetchActivity: mock(async () => env({ items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNext: false, hasPrevious: false } })),
  fetchActivityEvent,
  fetchActivityRelated,
  fetchActivityStats: mock(async () =>
    env({ counts: { all: 0, comments: 0, versions: 0, sharing: 0, people: 0 }, contributors: [], busiestDoc: null }),
  ),
}));
// Mock the WHOLE versioning client surface (PublishDiffMini only needs getDiff) so this stub never
// shadows getVersionHistory/restoreVersion with `undefined` for the versioning suite (mock leak).
mock.module("@/features/versioning/services/client", () => ({
  getDiff,
  getVersionHistory: mock(async () => okEnv({ items: [] })),
  restoreVersion: mock(async () => okEnv({ version: 1, previousVersion: 1 })),
}));

const { ActivityDetailScreen } = await import("@/features/activity/components/activity-detail-screen");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function App({ eventId = "e-pub" }: { eventId?: string } = {}) {
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[`/w/ws-1/activity/${eventId}`]}>
        <Routes>
          <Route path="/w/:workspaceId/activity/:eventId" element={<ActivityDetailScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("ActivityDetailScreen (workspace-activity S-004)", () => {
  beforeEach(() => {
    fetchActivityEvent.mockClear();
    fetchActivityRelated.mockClear();
    getDiff.mockClear();
    eventResponse = env({ event: publishEvent() });
    relatedResponse = env({ items: RELATED });
  });

  it("AS-014: the detail shows actor, document, project, version, and when", async () => {
    render(<App />);
    const detail = await screen.findByTestId("activity-detail");
    const text = detail.textContent ?? "";
    expect(text).toContain("Devin"); // actor
    expect(text).toContain("Render + publish pipeline RFC"); // document
    expect(text).toContain("web-core"); // project
    expect(text).toContain("v4"); // version
    expect(text).toContain("2026"); // when (formatted date)
  });

  it("AS-015: a publish event's detail shows a real v3→v4 source diff with the add/remove counts", async () => {
    render(<App />);
    const mini = await screen.findByTestId("publish-diff-mini");
    // The +adds/−dels counts come from the event meta.
    expect(mini.textContent).toContain("+5");
    expect(mini.textContent).toContain("−2");
    expect(mini.textContent).toContain("v3");
    expect(mini.textContent).toContain("v4");
    // The REAL source line-diff is fetched (reusing the versioning diff) and rendered.
    await waitFor(() => expect(within(mini).getByTestId("source-line-diff")).toBeTruthy());
    expect(getDiff.mock.calls.length).toBeGreaterThan(0);
    expect(getDiff.mock.calls[0]).toEqual(["render-pipeline-rfc", 3, 4]); // v3→v4 by slug
  });

  it("AS-016: 'Open doc' deep-links to the exact annotation (#annotation-<id>)", async () => {
    render(<App />);
    const links = await screen.findAllByTestId("open-doc");
    // Both the hero and the document-card buttons point at the annotation fragment.
    for (const a of links) expect(a.getAttribute("href")).toBe("/d/render-pipeline-rfc#annotation-anno-1");
  });

  it("AS-017: 'Open doc' falls back to the doc top when the annotation detached (no fragment)", async () => {
    eventResponse = env({ event: publishEvent({ type: "comment", annotationId: null, meta: null }) });
    render(<App />);
    const links = await screen.findAllByTestId("open-doc");
    for (const a of links) expect(a.getAttribute("href")).toBe("/d/render-pipeline-rfc");
  });

  it("AS-018: a deleted-target event still renders from its stored fields and 'Open doc' degrades", async () => {
    // The doc was deleted → the detail read returns docSlug null but keeps the stored summary/target.
    eventResponse = env({
      event: publishEvent({ type: "comment", meta: null, docSlug: null, projectName: null, annotationId: null }),
    });
    relatedResponse = env({ items: [] });
    render(<App />);
    const detail = await screen.findByTestId("activity-detail");
    // Renders from stored fields, no crash.
    expect(detail.textContent).toContain("Devin");
    expect(detail.textContent).toContain("Render + publish pipeline RFC");
    // "Open doc" degraded — a disabled control with no href, not a broken link.
    const buttons = within(detail).getAllByTestId("open-doc");
    for (const b of buttons) {
      expect(b.getAttribute("href")).toBeNull();
      expect(b.getAttribute("data-degraded")).toBe("1");
    }
  });

  it("AS-010: a hidden/nonexistent event (404) renders a not-found state, never a forbidden", async () => {
    eventResponse = { data: null, error: { status: 404, value: { error: { code: "NOT_FOUND", message: "x" } } } };
    render(<App eventId="nope" />);
    await waitFor(() => expect(screen.getByText("Event not found")).toBeTruthy());
    expect(screen.queryByTestId("activity-detail")).toBeNull();
  });

  it("renders 'More on this doc' related events on the same doc", async () => {
    render(<App />);
    const related = await screen.findByTestId("detail-related");
    expect(within(related).getAllByTestId("activity-row")).toHaveLength(1);
    expect(related.textContent).toContain("Mara");
  });
});
