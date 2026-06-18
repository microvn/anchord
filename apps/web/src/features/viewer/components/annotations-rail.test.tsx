import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core-ui S-003 — Read existing annotations. The viewer client is MOCKED so the tests
// assert render + pairing BEHAVIOR (rail threads, in-text highlights, focus pairing, resolved
// dimming, empty state, detached display), not a real round-trip. The doc is markdown so the
// DocPane renders block-id'd content inline at the app origin (highlights anchor against it).
//
// AS-007 3 annotations → 3 rail threads + count 3 + 3 in-text highlights.
// AS-008 click a highlight → its thread focused.
// AS-009 click a thread → scrollIntoView on its highlight.
// AS-010 a resolved annotation → dimmed thread + Resolved badge + resolved-styled highlight.
// AS-015 0 annotations → empty rail ("no comments yet"), no highlights, count 0, doc still renders.
// AS-011 1 isOrphaned → shown in the amber detached section, NOT as an anchored thread/highlight.

const ok = (body: unknown) => ({ data: body, error: null });

const MD = `
<p id="block-p-1">Payment expires after 24h unless the subscription is renewed.</p>
<p id="block-p-2">Query keys embed the workspace id so a stale cache can never bleed across.</p>
<p id="block-p-3">The last-admin invariant blocks demoting the final admin of a workspace.</p>
<p id="block-p-4">This v3 onboarding copy block was rewritten later.</p>
`;

const comment = (id: string, body: string, author = "Devin Osei") => ({
  id,
  parentId: null,
  authorName: author,
  body,
  createdAt: "2h",
});

function makeAnnotation(over: Record<string, unknown>) {
  return {
    id: "a1",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    comments: [comment("c1", "A comment")],
    anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17, segments: [] },
    ...over,
  };
}

let docResponse: unknown;
let annoResponse: unknown;

const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => annoResponse);

mock.module("@/features/viewer/services/client", () => ({
  // S-002: stub the redline create/decide so this file's partial client mock still satisfies the
  // imports useCompose/viewer-screen now make (bun mock.module binds exports at load).
  createRedline: mock(async () => ({ data: { success: true, data: { suggestionId: "rl-x" } }, error: null })),
  decideSuggestion: mock(async () => ({ data: { success: true, data: { status: "accepted" } }, error: null })),
  fetchViewerDoc,
  listAnnotations,
  // S-001 grew the client surface; use-compose imports these at module eval, so the whole-module
  // mock must provide them. These tests don't exercise the write path — safe no-op stubs + the
  // real canComment default (non-viewer → may comment).
  createAnnotation: mock(async () => ({ data: { success: true, data: { annotationId: "a" } }, error: null })),
  addComment: mock(async () => ({ data: { success: true, data: { commentId: "c" } }, error: null })),
  setResolution: mock(async () => ({ data: { success: true, data: { status: "resolved" } }, error: null })),
  deleteAnnotation: mock(async () => ({ data: { success: true, data: { deleted: true } }, error: null })),
  restoreAnnotation: mock(async () => ({ data: { success: true, data: { restored: true } }, error: null })),
  canComment: (role: string | undefined) => role !== "viewer",
}));

const { ViewerScreen } = await import("@/features/viewer/components/viewer-screen");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function App() {
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/w/ws-1/d/my-doc"]}>
        <Routes>
          <Route path="/w/:workspaceId/d/:slug" element={<ViewerScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  fetchViewerDoc.mockClear();
  listAnnotations.mockClear();
  docResponse = ok({
    doc: { title: "Spec", kind: "markdown", version: 4, status: "live", generalAccess: "restricted" },
    content: MD,
  });
  annoResponse = ok({ items: [] });
});

async function renderViewer() {
  render(<App />);
  await screen.findByTestId("markdown-view");
  await screen.findByTestId("annotations-rail");
}

describe("AnnotationsRail S-003", () => {
  it("AS-007: 3 annotations render as 3 rail threads with count 3 and 3 in-text highlights", async () => {
    annoResponse = ok({
      items: [
        makeAnnotation({
          id: "a1",
          anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 },
          comments: [comment("c1", "Should we clear the cache too?"), comment("c2", "Yes — wipe it.", "Mara")],
        }),
        makeAnnotation({
          id: "a2",
          anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 },
          comments: [comment("c3", "Tighten this wording.")],
        }),
        makeAnnotation({
          id: "a3",
          anchor: { blockId: "block-p-3", textSnippet: "last-admin invariant", offset: 4, length: 20 },
          comments: [comment("c4", "Confirmed in the guard.")],
        }),
      ],
    });

    await renderViewer();

    expect(screen.getAllByTestId("thread-card")).toHaveLength(3);
    // S-007: the single total count was replaced by status chips; 3 open annotations → Open chip 3.
    expect(screen.getByTestId("chip-open")).toHaveTextContent("3");

    // Each quoted range is highlighted in the doc, paired by data-anno (C-003).
    const view = screen.getByTestId("markdown-view");
    expect(view.querySelectorAll("[data-anno]")).toHaveLength(3);
    expect(view.querySelector('[data-anno="a1"]')!.textContent).toBe("expires after 24h");
    expect(view.querySelector('[data-anno="a2"]')!.textContent).toBe("bleed across");

    // The thread carries the quote + body + a reply (flat).
    const first = screen.getAllByTestId("thread-card")[0]!;
    expect(first).toHaveTextContent("expires after 24h");
    expect(first).toHaveTextContent("Should we clear the cache too?");
    expect(within(first).getAllByTestId("reply")).toHaveLength(1);
  });

  it("AS-008: clicking a highlight focuses its thread", async () => {
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "a1", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({ id: "a2", anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 } }),
      ],
    });

    await renderViewer();

    const mark = screen.getByTestId("markdown-view").querySelector('[data-anno="a2"]') as HTMLElement;
    await userEvent.click(mark);

    await waitFor(() => {
      const focused = screen.getByTestId("annotations-rail").querySelector('[data-anno-thread="a2"]')!;
      expect(focused.getAttribute("aria-current")).toBe("true");
    });
    // The other thread is not focused.
    expect(
      screen.getByTestId("annotations-rail").querySelector('[data-anno-thread="a1"]')!.getAttribute("aria-current"),
    ).toBeNull();
  });

  it("AS-009: clicking a thread scrolls to its highlight", async () => {
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "a1", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({ id: "a3", anchor: { blockId: "block-p-3", textSnippet: "last-admin invariant", offset: 4, length: 20 } }),
      ],
    });

    await renderViewer();

    const mark = screen.getByTestId("markdown-view").querySelector('[data-anno="a3"]') as HTMLElement;
    let scrolled = 0;
    mark.scrollIntoView = () => {
      scrolled += 1;
    };

    const thread = screen.getByTestId("annotations-rail").querySelector('[data-anno-thread="a3"]') as HTMLElement;
    await userEvent.click(thread);

    expect(scrolled).toBe(1);
    expect(thread.getAttribute("aria-current")).toBe("true");
  });

  it("AS-010: a resolved annotation shows a Resolved badge + dimmed, and its highlight is resolved-styled", async () => {
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "a1", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({
          id: "a3",
          status: "resolved",
          anchor: { blockId: "block-p-3", textSnippet: "last-admin invariant", offset: 4, length: 20 },
        }),
      ],
    });

    await renderViewer();

    const resolved = screen.getByTestId("annotations-rail").querySelector('[data-anno-thread="a3"]') as HTMLElement;
    expect(resolved.getAttribute("data-resolved")).toBe("true");
    expect(within(resolved).getByTestId("resolved-badge")).toBeInTheDocument();
    expect(resolved.className).toContain("opacity-[0.72]"); // .thread.resolved opacity .72 (Anchord-Design)

    // The highlight in text carries the resolved (not active) style hook.
    const mark = screen.getByTestId("markdown-view").querySelector('[data-anno="a3"]') as HTMLElement;
    expect(mark.dataset.resolved).toBe("true");
    // The unresolved one does not.
    const live = screen.getByTestId("markdown-view").querySelector('[data-anno="a1"]') as HTMLElement;
    expect(live.dataset.resolved).toBeUndefined();
  });

  it("AS-015: a doc with no annotations shows an empty rail, no highlights, count 0, doc still renders", async () => {
    annoResponse = ok({ items: [] });

    await renderViewer();

    expect(screen.getByTestId("rail-empty")).toBeInTheDocument();
    // #3 (2026-06-12): the rail hosts ALL annotation types — empty copy renamed to "annotations".
    expect(screen.getByTestId("rail-empty")).toHaveTextContent("No annotations yet");
    // S-007: an empty doc shows no status chips at all (nothing to summarize).
    expect(screen.queryByTestId("chip-open")).toBeNull();
    expect(screen.queryAllByTestId("thread-card")).toHaveLength(0);
    expect(screen.getByTestId("markdown-view").querySelectorAll("[data-anno]")).toHaveLength(0);
    // The doc still renders.
    expect(screen.getByTestId("markdown-view")).toHaveTextContent("Payment expires after 24h");
  });

  it("Regression: an annotation with no comments[] renders the rail (empty thread), never white-screens", async () => {
    // Regression: BE↔FE linked-field gap — the list-annotations endpoint omitted comments[], so
    // thread-card.tsx destructured `undefined` ("not iterable") and blanked the whole viewer.
    // Confirmed live via Playwright before the guard. The rail must survive a thread-less annotation.
    annoResponse = ok({
      items: [
        makeAnnotation({
          id: "a1",
          comments: undefined,
          anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 },
        }),
      ],
    });

    await renderViewer();

    // No crash: the rail + doc still render, the thread shows quote-only.
    expect(screen.getAllByTestId("thread-card")).toHaveLength(1);
    expect(screen.getByTestId("markdown-view")).toHaveTextContent("Payment expires after 24h");
    expect(screen.getAllByTestId("thread-card")[0]!).toHaveTextContent("expires after 24h");
  });

  it("Regression: a comment whose createdAt is a Date (eden revives ISO) renders, never '[object Date]'", async () => {
    // Regression: the eden treaty client revives ISO timestamps into Date objects; thread-card's
    // timeLabel rendered the raw Date as a React child → "Objects are not valid as a React child
    // ([object Date])" → blank viewer. Confirmed live via Playwright. timeLabel must coerce.
    annoResponse = ok({
      items: [
        makeAnnotation({
          id: "a1",
          anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 },
          comments: [
            { id: "c1", parentId: null, authorName: "Demo User", body: "a real thread", createdAt: new Date("2026-06-11T02:11:36.384Z") },
          ],
        }),
      ],
    });

    await renderViewer();

    const card = screen.getAllByTestId("thread-card")[0]!;
    expect(card).toHaveTextContent("a real thread");
    expect(card).not.toHaveTextContent("[object Date]");
  });

  it("Regression: a Date createdAt renders a short relative label (now/Nm/Nh/Nd), never raw ISO", async () => {
    // The eden treaty client revives ISO timestamps into Date objects. timeLabel must format them
    // as a short relative label like the prototype ("now", "4h", "2d") — never leak raw ISO
    // ("2026-06-11T03:00:08.926Z") into the UI.
    annoResponse = ok({
      items: [
        makeAnnotation({
          id: "a1",
          anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 },
          comments: [
            { id: "c1", parentId: null, authorName: "Demo User", body: "fresh comment", createdAt: new Date() },
          ],
        }),
      ],
    });

    await renderViewer();

    const card = screen.getAllByTestId("thread-card")[0]!;
    // No ISO leaking: no "<digit>T<digit>" and no ISO date.
    expect(card.textContent).not.toMatch(/\dT\d/);
    expect(card.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    // The timestamp node reads as a short relative label — a Date close to now is "now".
    const timeNode = within(card).getByText(/^(now|\d+[mhd])$/);
    expect(timeNode).toHaveTextContent("now");
  });

  // ---- S-007: status chips (summarize + filter the rail) ------------------------------------
  // The header replaces the single count with three status chips (Open · Resolved · Suggestion);
  // toggling a chip filters the rail AND dims non-matching highlights in the doc. The chips
  // PARTITION the active set (C-009): Suggestion (type=suggestion, any lifecycle), then Open
  // (not a suggestion, unresolved), then Resolved (not a suggestion, resolved). Detached items are
  // counted into their chip AND still render in the separate detached section (C-004).

  // A doc with 20 open + 1 resolved + 2 suggestion = 23 active. Each anchors to a distinct block so
  // every active one gets an in-text highlight (the test MD has 4 blocks; reuse them round-robin —
  // dimming is asserted by data-anno-filtered on the marks, not by per-block uniqueness).
  function mixedSet() {
    const items: Record<string, unknown>[] = [];
    const blocks = ["block-p-1", "block-p-2", "block-p-3", "block-p-4"];
    const snippets = ["expires after 24h", "bleed across", "last-admin invariant", "onboarding copy"];
    // 20 open
    for (let i = 0; i < 20; i++) {
      const b = i % 4;
      items.push(
        makeAnnotation({
          id: `open-${i}`,
          status: "unresolved",
          anchor: { blockId: blocks[b], textSnippet: snippets[b], offset: i === 0 ? 8 : 0, length: 5 },
        }),
      );
    }
    // 1 resolved
    items.push(
      makeAnnotation({
        id: "res-0",
        status: "resolved",
        anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 },
      }),
    );
    // 2 suggestion (a redline = type suggestion, delete-kind). ANY lifecycle counts as Suggestion.
    items.push(
      makeAnnotation({
        id: "sug-0",
        type: "suggestion",
        suggestion: { kind: "delete" },
        suggestionStatus: "pending",
        anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 },
      }),
    );
    items.push(
      makeAnnotation({
        id: "sug-1",
        type: "suggestion",
        suggestion: { kind: "delete" },
        suggestionStatus: "accepted",
        status: "resolved", // a decided suggestion is resolved — still partitions as Suggestion (C-009)
        anchor: { blockId: "block-p-3", textSnippet: "last-admin invariant", offset: 4, length: 20 },
      }),
    );
    return items;
  }

  it("AS-022: the rail header shows three status chips whose counts sum to the active total", async () => {
    annoResponse = ok({ items: mixedSet() });
    await renderViewer();

    const open = screen.getByTestId("chip-open");
    const resolved = screen.getByTestId("chip-resolved");
    const suggestion = screen.getByTestId("chip-suggestion");

    // Each chip is an icon + its count. Suggestion partitions BEFORE status (C-009): the
    // decided/resolved suggestion counts as Suggestion, not Resolved.
    expect(open).toHaveTextContent("20");
    expect(resolved).toHaveTextContent("1");
    expect(suggestion).toHaveTextContent("2");

    // All active by default.
    expect(open.getAttribute("aria-pressed")).toBe("true");
    expect(resolved.getAttribute("aria-pressed")).toBe("true");
    expect(suggestion.getAttribute("aria-pressed")).toBe("true");

    // The three counts sum to the active total (23).
    const sum = [open, resolved, suggestion]
      .map((c) => Number(c.getAttribute("data-count")))
      .reduce((a, b) => a + b, 0);
    expect(sum).toBe(23);
    // The single legacy total count is gone — chips replace it.
    expect(screen.queryByTestId("rail-count")).toBeNull();
  });

  it("AS-023: toggling a chip off hides its group from the rail and dims its marks; others unaffected", async () => {
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "open-0", status: "unresolved", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({ id: "res-0", status: "resolved", anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 } }),
        makeAnnotation({ id: "sug-0", type: "suggestion", suggestion: { kind: "delete" }, suggestionStatus: "pending", anchor: { blockId: "block-p-3", textSnippet: "last-admin invariant", offset: 4, length: 20 } }),
        makeAnnotation({ id: "det-0", isOrphaned: true, anchor: { blockId: "block-p-4", textSnippet: "onboarding copy", offset: 8, length: 15 } }),
      ],
    });
    await renderViewer();

    const rail = screen.getByTestId("annotations-rail");
    const view = screen.getByTestId("markdown-view");
    // All three anchored threads present to start.
    expect(rail.querySelector('[data-anno-thread="open-0"]')).not.toBeNull();
    expect(rail.querySelector('[data-anno-thread="res-0"]')).not.toBeNull();

    await userEvent.click(screen.getByTestId("chip-resolved"));

    // The resolved thread leaves the rail; the open + suggestion threads stay.
    expect(rail.querySelector('[data-anno-thread="res-0"]')).toBeNull();
    expect(rail.querySelector('[data-anno-thread="open-0"]')).not.toBeNull();
    expect(rail.querySelector('[data-anno-thread="sug-0"]')).not.toBeNull();

    // The resolved highlight dims (filtered flag); the others do not.
    expect(view.querySelector('[data-anno="res-0"]')!.getAttribute("data-anno-filtered")).toBe("true");
    expect(view.querySelector('[data-anno="open-0"]')!.getAttribute("data-anno-filtered")).toBeNull();
    expect(view.querySelector('[data-anno="sug-0"]')!.getAttribute("data-anno-filtered")).toBeNull();

    // The detached section is unaffected by chip state (C-004).
    const section = screen.getByTestId("detached-section");
    expect(within(section).getByTestId("detached-count")).toHaveTextContent("1 detached");
  });

  it("AS-024: toggling the chip back on restores its threads and its marks return to resolved (not filtered)", async () => {
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "open-0", status: "unresolved", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({ id: "res-0", status: "resolved", anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 } }),
      ],
    });
    await renderViewer();

    const rail = screen.getByTestId("annotations-rail");
    const view = screen.getByTestId("markdown-view");

    await userEvent.click(screen.getByTestId("chip-resolved")); // off
    expect(rail.querySelector('[data-anno-thread="res-0"]')).toBeNull();
    expect(view.querySelector('[data-anno="res-0"]')!.getAttribute("data-anno-filtered")).toBe("true");

    await userEvent.click(screen.getByTestId("chip-resolved")); // back on
    // Thread returns to the rail.
    expect(rail.querySelector('[data-anno-thread="res-0"]')).not.toBeNull();
    // Highlight is no longer filtered-dimmed; it reads as resolved again (its own resolved style).
    const mark = view.querySelector('[data-anno="res-0"]') as HTMLElement;
    expect(mark.getAttribute("data-anno-filtered")).toBeNull();
    expect(mark.dataset.resolved).toBe("true");
  });

  it("AS-025: with no chip selected the rail shows a distinct no-match state (not the empty-doc state)", async () => {
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "open-0", status: "unresolved", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({ id: "res-0", status: "resolved", anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 } }),
        makeAnnotation({ id: "sug-0", type: "suggestion", suggestion: { kind: "delete" }, suggestionStatus: "pending", anchor: { blockId: "block-p-3", textSnippet: "last-admin invariant", offset: 4, length: 20 } }),
      ],
    });
    await renderViewer();

    await userEvent.click(screen.getByTestId("chip-open"));
    await userEvent.click(screen.getByTestId("chip-resolved"));
    await userEvent.click(screen.getByTestId("chip-suggestion"));

    // The no-match state is shown and is DISTINCT from the empty-doc "no annotations yet" state.
    const noMatch = screen.getByTestId("rail-no-match");
    expect(noMatch).toBeInTheDocument();
    expect(screen.queryByTestId("rail-empty")).toBeNull();
    expect(noMatch).not.toHaveTextContent("No annotations yet");
    // No thread cards rendered; no mark is emphasized (focus) — all dimmed.
    expect(screen.queryAllByTestId("thread-card")).toHaveLength(0);
    const view = screen.getByTestId("markdown-view");
    expect(view.querySelector(".anno-mark--focus")).toBeNull();
    expect(view.querySelector('[data-anno="open-0"]')!.getAttribute("data-anno-filtered")).toBe("true");
  });

  it("AS-026: clicking a filtered-out highlight re-activates its chip and focuses the thread", async () => {
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "open-0", status: "unresolved", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({ id: "res-0", status: "resolved", anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 } }),
      ],
    });
    await renderViewer();

    const rail = screen.getByTestId("annotations-rail");
    const view = screen.getByTestId("markdown-view");

    // Toggle Open off → its highlight dims + its thread leaves the rail.
    await userEvent.click(screen.getByTestId("chip-open"));
    expect(rail.querySelector('[data-anno-thread="open-0"]')).toBeNull();
    const mark = view.querySelector('[data-anno="open-0"]') as HTMLElement;
    expect(mark.getAttribute("data-anno-filtered")).toBe("true");

    // Click the dimmed highlight → the Open chip re-activates, the thread reappears + focuses.
    await userEvent.click(mark);

    await waitFor(() => {
      expect(screen.getByTestId("chip-open").getAttribute("aria-pressed")).toBe("true");
    });
    const thread = rail.querySelector('[data-anno-thread="open-0"]')!;
    expect(thread).not.toBeNull();
    expect(thread.getAttribute("aria-current")).toBe("true");
    // The highlight is no longer filtered (re-activation restored its group).
    expect(view.querySelector('[data-anno="open-0"]')!.getAttribute("data-anno-filtered")).toBeNull();
  });

  it("AS-011 / C-004: a detached (isOrphaned) annotation shows in the amber detached section, never as anchored", async () => {
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "a1", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({
          id: "d1",
          isOrphaned: true,
          anchor: { blockId: "block-p-4", textSnippet: "onboarding copy", offset: 8, length: 15 },
          comments: [comment("c9", "Does this still apply after v4?", "Tom Becker")],
        }),
      ],
    });

    await renderViewer();

    const section = screen.getByTestId("detached-section");
    expect(within(section).getByTestId("detached-count")).toHaveTextContent("1 detached");
    expect(within(section).getByTestId("detached-card")).toHaveTextContent("Does this still apply after v4?");

    // The detached one is NOT an anchored thread and has NO highlight.
    expect(screen.getByTestId("annotations-rail").querySelector('[data-anno-thread="d1"]')).toBeNull();
    expect(screen.getByTestId("markdown-view").querySelector('[data-anno="d1"]')).toBeNull();

    // Count reflects the active set; the one anchored open annotation still highlights.
    // S-007: the detached item is counted into its status chip too (C-009) — both open → Open chip 2.
    expect(screen.getByTestId("chip-open")).toHaveTextContent("2");
    expect(screen.getByTestId("markdown-view").querySelector('[data-anno="a1"]')).not.toBeNull();
  });
});
