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
  dismissAnnotation: mock(async () => ({ data: { success: true, data: { dismissed: true } }, error: null })),
  reattachAnnotation: mock(async () => ({ data: { success: true, data: { isOrphaned: false } }, error: null })),
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
    // S-007 (rework): the header shows the doc total ("showing X of N" only while narrowed). With the
    // filter at its default (all facets selected) it reads the full total — 3 anchored.
    expect(screen.getByTestId("rail-showing")).toHaveTextContent("3");

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
    // C-009 (2026-06-21): Resolved is hidden by DEFAULT — enable it so the resolved styling is assertable.
    await openFilter();
    await userEvent.click(screen.getByTestId("facet-status-resolved"));

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
    // S-007: an empty doc shows no Filter control + no "showing" signal (nothing to filter).
    expect(screen.queryByTestId("filter-control")).toBeNull();
    expect(screen.queryByTestId("rail-showing")).toBeNull();
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

  // ---- S-007 (REWORK): two-axis Filter popover (Status × Type) -------------------------------
  // The header carries the doc total + a "showing X of N" signal + a Filter control that opens a
  // popover with TWO axes — Status {Open, Resolved} × Type {Markup, Comment, Redline, Label}. A
  // thread shows iff its status facet AND its type facet are both selected (OR within an axis, AND
  // across — C-009); both default all-selected. Counts are DYNAMIC (each axis scoped to the OTHER
  // axis's selection — C-010). Toggling a facet hides + dims; Reset re-selects all; act-on-filtered
  // re-activates BOTH facets (AS-028). The detached section always renders (C-004).

  // A 23-annotation set matching the AS-022 numbers exactly: Open 20 / Resolved 3; by TYPE
  // Comment 18 / Markup 2 / Redline 2 / Label 1. Type derivation: redline = suggestion+delete;
  // label = a label id; markup = a replace suggestion (the catch-all); comment = plain. Statuses
  // distributed so the totals land: comments 18 (17 open + 1 res), markup 2 (open), redline 2
  // (1 open + 1 res), label 1 (res). → Open 20, Resolved 3. Anchors round-robin over the 4 blocks
  // (dimming is asserted by data-anno-filtered, not per-block uniqueness).
  function set23() {
    const items: Record<string, unknown>[] = [];
    const blocks = ["block-p-1", "block-p-2", "block-p-3", "block-p-4"];
    const snippets = ["expires after 24h", "bleed across", "last-admin invariant", "onboarding copy"];
    const anchorFor = (i: number) => ({ blockId: blocks[i % 4], textSnippet: snippets[i % 4], offset: i === 0 ? 8 : 0, length: 5 });
    for (let i = 0; i < 17; i++) items.push(makeAnnotation({ id: `comment-${i}`, status: "unresolved", anchor: anchorFor(i) }));
    items.push(makeAnnotation({ id: "comment-res", status: "resolved", anchor: anchorFor(1) })); // 18th comment, resolved
    items.push(makeAnnotation({ id: "markup-0", type: "suggestion", suggestion: { kind: "replace" }, suggestionStatus: "pending", status: "unresolved", anchor: anchorFor(0) }));
    // markup-1 is BORN-ACCEPTED (an editor's own replace-suggestion): accepted decision but still OPEN —
    // demonstrates decision ⟂ status (accepted ≠ resolved). Keeps the open count at 20.
    items.push(makeAnnotation({ id: "markup-1", type: "suggestion", suggestion: { kind: "replace" }, suggestionStatus: "accepted", status: "unresolved", anchor: anchorFor(1) }));
    items.push(makeAnnotation({ id: "redline-open", type: "suggestion", suggestion: { kind: "delete" }, suggestionStatus: "pending", status: "unresolved", anchor: anchorFor(2) }));
    // redline-res was REJECTED (reject auto-resolves) → rejected decision + resolved status.
    items.push(makeAnnotation({ id: "redline-res", type: "suggestion", suggestion: { kind: "delete" }, suggestionStatus: "rejected", status: "resolved", anchor: anchorFor(3) }));
    items.push(makeAnnotation({ id: "label-0", label: "out-of-scope", status: "resolved", anchor: anchorFor(0) }));
    return items;
  }

  async function openFilter() {
    await userEvent.click(screen.getByTestId("filter-control"));
    await screen.findByTestId("filter-popover");
  }

  it("AS-022: the Filter popover lists both axes; Type all-selected, Status defaults to Open only (Resolved hidden)", async () => {
    annoResponse = ok({ items: set23() });
    await renderViewer();

    // By DEFAULT Resolved is OFF → the rail shows only the 20 open threads (3 resolved hidden).
    expect(screen.getAllByTestId("thread-card")).toHaveLength(20);
    // Default is the baseline (not a narrowing): header shows the visible (open) count, control inactive.
    expect(screen.getByTestId("rail-showing")).toHaveTextContent("20");
    expect(screen.getByTestId("filter-control").getAttribute("data-active")).toBeNull();

    await openFilter();

    // Status axis counts are scoped to the active Type (all) → whole-doc Open 20 · Resolved 3
    // (the Resolved facet still LISTS its count even though it's deselected).
    expect(screen.getByTestId("facet-status-open")).toHaveTextContent("20");
    expect(screen.getByTestId("facet-status-resolved")).toHaveTextContent("3");
    // Type axis counts are scoped to the active Status ({open}) → open-only: Markup 2 · Comment 17 ·
    // Redline 1 · Label 0 (C-010 dynamic counts: the resolved comment/redline/label drop out).
    expect(screen.getByTestId("facet-type-markup")).toHaveTextContent("2");
    expect(screen.getByTestId("facet-type-comment")).toHaveTextContent("17");
    expect(screen.getByTestId("facet-type-redline")).toHaveTextContent("1");
    expect(screen.getByTestId("facet-type-label")).toHaveTextContent("0");

    // Decision axis counts are scoped to the active Status ({open}) + Type (all) → open suggestions
    // only: markup-0 (pending) + markup-1 (accepted, born-accepted) + redline-open (pending). The
    // rejected redline is resolved → excluded by the Open-only default. So Pending 2 · Accepted 1 ·
    // Rejected 0 · Stale 0 (C-010 dynamic counts over suggestions).
    expect(screen.getByTestId("facet-decision-pending")).toHaveTextContent("2");
    expect(screen.getByTestId("facet-decision-accepted")).toHaveTextContent("1");
    expect(screen.getByTestId("facet-decision-rejected")).toHaveTextContent("0");
    expect(screen.getByTestId("facet-decision-stale")).toHaveTextContent("0");

    // Default selection: Open + every Type + every Decision selected; Resolved DEselected.
    expect(screen.getByTestId("facet-status-open").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("facet-status-resolved").getAttribute("aria-pressed")).toBe("false");
    for (const id of ["facet-type-markup", "facet-type-comment", "facet-type-redline", "facet-type-label"]) {
      expect(screen.getByTestId(id).getAttribute("aria-pressed")).toBe("true");
    }
    for (const id of ["facet-decision-pending", "facet-decision-accepted", "facet-decision-rejected", "facet-decision-stale"]) {
      expect(screen.getByTestId(id).getAttribute("aria-pressed")).toBe("true");
    }
    // The old single-axis chips are gone.
    expect(screen.queryByTestId("chip-open")).toBeNull();
    expect(screen.queryByTestId("chip-suggestion")).toBeNull();
  });

  it("AS-023: deselecting a Type facet filters the rail and dims those marks; others + detached unaffected", async () => {
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "comment-0", status: "unresolved", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({ id: "redline-0", type: "suggestion", suggestion: { kind: "delete" }, suggestionStatus: "pending", anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 } }),
        makeAnnotation({ id: "label-0", label: "out-of-scope", anchor: { blockId: "block-p-3", textSnippet: "last-admin invariant", offset: 4, length: 20 } }),
        makeAnnotation({ id: "det-0", isOrphaned: true, anchor: { blockId: "block-p-4", textSnippet: "onboarding copy", offset: 8, length: 15 } }),
      ],
    });
    await renderViewer();
    const rail = screen.getByTestId("annotations-rail");
    const view = screen.getByTestId("markdown-view");

    await openFilter();
    await userEvent.click(screen.getByTestId("facet-type-redline")); // deselect Redline

    // The redline thread leaves the rail; comment + label stay.
    expect(rail.querySelector('[data-anno-thread="redline-0"]')).toBeNull();
    expect(rail.querySelector('[data-anno-thread="comment-0"]')).not.toBeNull();
    expect(rail.querySelector('[data-anno-thread="label-0"]')).not.toBeNull();

    // The redline highlight dims; the others do not.
    expect(view.querySelector('[data-anno="redline-0"]')!.getAttribute("data-anno-filtered")).toBe("true");
    expect(view.querySelector('[data-anno="comment-0"]')!.getAttribute("data-anno-filtered")).toBeNull();
    expect(view.querySelector('[data-anno="label-0"]')!.getAttribute("data-anno-filtered")).toBeNull();

    // The detached section is unaffected by the filter (C-004).
    const section = screen.getByTestId("detached-section");
    expect(within(section).getByTestId("detached-count")).toHaveTextContent("1 detached");
  });

  it("AS-024: the two axes combine — shown iff status AND type both selected", async () => {
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "redline-open", type: "suggestion", suggestion: { kind: "delete" }, suggestionStatus: "pending", status: "unresolved", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({ id: "redline-res", type: "suggestion", suggestion: { kind: "delete" }, suggestionStatus: "accepted", status: "resolved", anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 } }),
        makeAnnotation({ id: "comment-open", status: "unresolved", anchor: { blockId: "block-p-3", textSnippet: "last-admin invariant", offset: 4, length: 20 } }),
      ],
    });
    await renderViewer();
    const rail = screen.getByTestId("annotations-rail");
    const view = screen.getByTestId("markdown-view");

    await openFilter();
    // Status is already Open-only by default (Resolved off, C-009) — no click needed there.
    // Narrow Type to only Redline: deselect Markup, Comment, Label.
    await userEvent.click(screen.getByTestId("facet-type-markup"));
    await userEvent.click(screen.getByTestId("facet-type-comment"));
    await userEvent.click(screen.getByTestId("facet-type-label"));

    // Only the OPEN REDLINE matches. The resolved redline (wrong status) and the open comment (wrong
    // type) are both hidden.
    expect(rail.querySelector('[data-anno-thread="redline-open"]')).not.toBeNull();
    expect(rail.querySelector('[data-anno-thread="redline-res"]')).toBeNull();
    expect(rail.querySelector('[data-anno-thread="comment-open"]')).toBeNull();
    expect(screen.getAllByTestId("thread-card")).toHaveLength(1);

    // Every non-matching highlight is dimmed.
    expect(view.querySelector('[data-anno="redline-open"]')!.getAttribute("data-anno-filtered")).toBeNull();
    expect(view.querySelector('[data-anno="redline-res"]')!.getAttribute("data-anno-filtered")).toBe("true");
    expect(view.querySelector('[data-anno="comment-open"]')!.getAttribute("data-anno-filtered")).toBe("true");
  });

  it("AS-025: facet counts are dynamic — recompute against the other axis's selection", async () => {
    // 2 redlines (one open, one resolved) + some open comments. Narrowing Type to Redline scopes the
    // Status counts to redlines: Open 1 · Resolved 1 (not the whole-doc totals).
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "redline-open", type: "suggestion", suggestion: { kind: "delete" }, suggestionStatus: "pending", status: "unresolved", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({ id: "redline-res", type: "suggestion", suggestion: { kind: "delete" }, suggestionStatus: "accepted", status: "resolved", anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 } }),
        makeAnnotation({ id: "comment-0", status: "unresolved", anchor: { blockId: "block-p-3", textSnippet: "last-admin invariant", offset: 4, length: 20 } }),
        makeAnnotation({ id: "comment-1", status: "unresolved", anchor: { blockId: "block-p-4", textSnippet: "onboarding copy", offset: 8, length: 15 } }),
      ],
    });
    await renderViewer();

    await openFilter();
    // Whole-doc Status counts (both axes full): Open 3 · Resolved 1.
    expect(screen.getByTestId("facet-status-open")).toHaveTextContent("3");
    expect(screen.getByTestId("facet-status-resolved")).toHaveTextContent("1");

    // Narrow Type to only Redline.
    await userEvent.click(screen.getByTestId("facet-type-markup"));
    await userEvent.click(screen.getByTestId("facet-type-comment"));
    await userEvent.click(screen.getByTestId("facet-type-label"));

    // Status facets now scoped to redlines only: Open 1 · Resolved 1 (NOT the whole-doc 3 · 1).
    expect(screen.getByTestId("facet-status-open")).toHaveTextContent("1");
    expect(screen.getByTestId("facet-status-resolved")).toHaveTextContent("1");
  });

  it("AS-026: with an axis fully deselected the rail shows a distinct no-match state", async () => {
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "comment-0", status: "unresolved", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({ id: "redline-0", type: "suggestion", suggestion: { kind: "delete" }, suggestionStatus: "pending", anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 } }),
        makeAnnotation({ id: "label-0", label: "out-of-scope", anchor: { blockId: "block-p-3", textSnippet: "last-admin invariant", offset: 4, length: 20 } }),
      ],
    });
    await renderViewer();

    await openFilter();
    // Deselect EVERY facet in the Type axis → no annotation can match.
    await userEvent.click(screen.getByTestId("facet-type-markup"));
    await userEvent.click(screen.getByTestId("facet-type-comment"));
    await userEvent.click(screen.getByTestId("facet-type-redline"));
    await userEvent.click(screen.getByTestId("facet-type-label"));

    // A no-match state DISTINCT from the empty-doc "no annotations yet" state.
    const noMatch = screen.getByTestId("rail-no-match");
    expect(noMatch).toBeInTheDocument();
    expect(screen.queryByTestId("rail-empty")).toBeNull();
    expect(noMatch).not.toHaveTextContent("No annotations yet");
    expect(screen.queryAllByTestId("thread-card")).toHaveLength(0);
    // No highlight is emphasized (focus); all dimmed.
    const view = screen.getByTestId("markdown-view");
    expect(view.querySelector(".anno-mark--focus")).toBeNull();
    expect(view.querySelector('[data-anno="comment-0"]')!.getAttribute("data-anno-filtered")).toBe("true");
  });

  it("AS-027: the header shows how much is showing and Reset returns to the default view", async () => {
    annoResponse = ok({ items: set23() });
    await renderViewer();

    await openFilter();
    // From the default (Status Open-only), narrow Type to Markup + Redline by deselecting Comment +
    // Label. Open-scoped matches: Markup 2 (open) + Redline 1 (open; the resolved redline is excluded
    // by the default Open-only status) = 3 anchored threads.
    await userEvent.click(screen.getByTestId("facet-type-comment")); // off
    await userEvent.click(screen.getByTestId("facet-type-label")); // off → open Markup(2)+Redline(1)=3

    // While deviated from the default: header reads "showing 3 of 23" and the Filter control reads active.
    expect(screen.getByTestId("rail-showing")).toHaveTextContent("showing 3 of 23");
    expect(screen.getByTestId("filter-control").getAttribute("data-active")).toBe("true");

    // Reset → back to the DEFAULT baseline (Open-only, all Types) — NOT all-selected. Resolved stays OFF.
    await userEvent.click(screen.getByTestId("filter-reset"));
    for (const id of ["facet-type-comment", "facet-type-label", "facet-status-open"]) {
      expect(screen.getByTestId(id).getAttribute("aria-pressed")).toBe("true");
    }
    expect(screen.getByTestId("facet-status-resolved").getAttribute("aria-pressed")).toBe("false");
    // Header shows the visible open count (20), Filter reads inactive (this is the baseline).
    expect(screen.getByTestId("rail-showing")).toHaveTextContent("20");
    expect(screen.getByTestId("filter-control").getAttribute("data-active")).toBeNull();
  });

  it("AS-028: acting on a filtered-out highlight re-activates BOTH its facets, then focuses it", async () => {
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "redline-open", type: "suggestion", suggestion: { kind: "delete" }, suggestionStatus: "pending", status: "unresolved", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({ id: "comment-0", status: "unresolved", anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 } }),
      ],
    });
    await renderViewer();
    const rail = screen.getByTestId("annotations-rail");
    const view = screen.getByTestId("markdown-view");

    await openFilter();
    // Hide the open PENDING redline by deselecting ALL THREE of its facets: Status Open OFF, Type
    // Redline OFF, Decision Pending OFF — so the re-activation must restore across all three axes.
    await userEvent.click(screen.getByTestId("facet-status-open"));
    await userEvent.click(screen.getByTestId("facet-type-redline"));
    await userEvent.click(screen.getByTestId("facet-decision-pending"));
    expect(rail.querySelector('[data-anno-thread="redline-open"]')).toBeNull();
    const mark = view.querySelector('[data-anno="redline-open"]') as HTMLElement;
    expect(mark.getAttribute("data-anno-filtered")).toBe("true");

    // Click the dimmed highlight → its Open status, Redline type AND Pending decision facets re-activate.
    await userEvent.click(mark);

    await waitFor(() => {
      expect(rail.querySelector('[data-anno-thread="redline-open"]')).not.toBeNull();
    });
    // Its thread reappears + focuses; its highlight is no longer dimmed.
    const thread = rail.querySelector('[data-anno-thread="redline-open"]')!;
    expect(thread.getAttribute("aria-current")).toBe("true");
    expect(view.querySelector('[data-anno="redline-open"]')!.getAttribute("data-anno-filtered")).toBeNull();

    // All three facets read active again (open the popover to check).
    await openFilter();
    expect(screen.getByTestId("facet-status-open").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("facet-type-redline").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("facet-decision-pending").getAttribute("aria-pressed")).toBe("true");
  });

  it("AS-029: narrowing the Decision axis shows only matching suggestions and excludes non-suggestions", async () => {
    // A pending markup suggestion + a plain comment + a label. Narrowing Decision to only Pending shows
    // the pending suggestion; the comment and label (no decision) are EXCLUDED — once the axis is
    // narrowed the reviewer is filtering by decision, so a thing with no decision no longer qualifies.
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "markup-pending", type: "suggestion", suggestion: { kind: "replace" }, suggestionStatus: "pending", status: "unresolved", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({ id: "comment-0", status: "unresolved", anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 } }),
        makeAnnotation({ id: "label-0", label: "out-of-scope", status: "unresolved", anchor: { blockId: "block-p-3", textSnippet: "last-admin invariant", offset: 4, length: 20 } }),
      ],
    });
    await renderViewer();
    const rail = screen.getByTestId("annotations-rail");
    const view = screen.getByTestId("markdown-view");

    await openFilter();
    // Narrow Decision to ONLY Pending (deselect the other three).
    await userEvent.click(screen.getByTestId("facet-decision-accepted"));
    await userEvent.click(screen.getByTestId("facet-decision-rejected"));
    await userEvent.click(screen.getByTestId("facet-decision-stale"));

    // Only the pending suggestion shows; the comment + label are excluded (no decision, axis narrowed).
    expect(rail.querySelector('[data-anno-thread="markup-pending"]')).not.toBeNull();
    expect(rail.querySelector('[data-anno-thread="comment-0"]')).toBeNull();
    expect(rail.querySelector('[data-anno-thread="label-0"]')).toBeNull();

    // The pending suggestion's mark is NOT dimmed; the comment + label marks ARE dimmed.
    expect(view.querySelector('[data-anno="markup-pending"]')!.getAttribute("data-anno-filtered")).toBeNull();
    expect(view.querySelector('[data-anno="comment-0"]')!.getAttribute("data-anno-filtered")).toBe("true");
    expect(view.querySelector('[data-anno="label-0"]')!.getAttribute("data-anno-filtered")).toBe("true");
  });

  it("AS-030: deselecting every Decision facet is a no-match state", async () => {
    // Suggestions (markup + redline) + comments/labels. Emptying the Decision axis matches no suggestion
    // AND excludes the non-suggestions (axis narrowed) → nothing shows → no-match (uniform with AS-026).
    annoResponse = ok({
      items: [
        makeAnnotation({ id: "markup-0", type: "suggestion", suggestion: { kind: "replace" }, suggestionStatus: "pending", status: "unresolved", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
        makeAnnotation({ id: "redline-0", type: "suggestion", suggestion: { kind: "delete" }, suggestionStatus: "pending", status: "unresolved", anchor: { blockId: "block-p-2", textSnippet: "bleed across", offset: 60, length: 12 } }),
        makeAnnotation({ id: "comment-0", status: "unresolved", anchor: { blockId: "block-p-3", textSnippet: "last-admin invariant", offset: 4, length: 20 } }),
        makeAnnotation({ id: "label-0", label: "out-of-scope", status: "unresolved", anchor: { blockId: "block-p-4", textSnippet: "onboarding copy", offset: 8, length: 15 } }),
      ],
    });
    await renderViewer();
    const rail = screen.getByTestId("annotations-rail");
    const view = screen.getByTestId("markdown-view");

    await openFilter();
    // Deselect EVERY facet in the Decision axis.
    await userEvent.click(screen.getByTestId("facet-decision-pending"));
    await userEvent.click(screen.getByTestId("facet-decision-accepted"));
    await userEvent.click(screen.getByTestId("facet-decision-rejected"));
    await userEvent.click(screen.getByTestId("facet-decision-stale"));

    // The no-match state (same as emptying Status/Type, AS-026) — nothing listed, no thread cards.
    expect(screen.getByTestId("rail-no-match")).toBeInTheDocument();
    expect(screen.queryAllByTestId("thread-card")).toHaveLength(0);
    expect(rail.querySelector('[data-anno-thread="comment-0"]')).toBeNull();
    expect(rail.querySelector('[data-anno-thread="markup-0"]')).toBeNull();
    // All marks dimmed.
    expect(view.querySelector('[data-anno="markup-0"]')!.getAttribute("data-anno-filtered")).toBe("true");
    expect(view.querySelector('[data-anno="comment-0"]')!.getAttribute("data-anno-filtered")).toBe("true");
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

    // S-007: the header "showing X of N" counts the ANCHORED set (detached lives in its own
    // always-rendered section) — 1 anchored, all facets selected → reads the total 1.
    expect(screen.getByTestId("rail-showing")).toHaveTextContent("1");
    expect(screen.getByTestId("markdown-view").querySelector('[data-anno="a1"]')).not.toBeNull();
  });
});
