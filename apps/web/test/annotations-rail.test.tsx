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

mock.module("../src/features/viewer/client", () => ({ fetchViewerDoc, listAnnotations }));

const { ViewerScreen } = await import("../src/features/viewer/viewer-screen");

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
    expect(screen.getByTestId("rail-count")).toHaveTextContent("3");

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
    expect(resolved.className).toContain("opacity-60");

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
    expect(screen.getByTestId("rail-empty")).toHaveTextContent("No comments yet");
    expect(screen.getByTestId("rail-count")).toHaveTextContent("0");
    expect(screen.queryAllByTestId("thread-card")).toHaveLength(0);
    expect(screen.getByTestId("markdown-view").querySelectorAll("[data-anno]")).toHaveLength(0);
    // The doc still renders.
    expect(screen.getByTestId("markdown-view")).toHaveTextContent("Payment expires after 24h");
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

    // Count reflects only anchored threads; the one anchored annotation still highlights.
    expect(screen.getByTestId("rail-count")).toHaveTextContent("1");
    expect(screen.getByTestId("markdown-view").querySelector('[data-anno="a1"]')).not.toBeNull();
  });
});
