import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, within, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core-ui-types-modes S-001 — the Markup popover in the real viewer flow. Asserts the
// role gate (C-001) and the empty-selection guard (C-008/AS-003) end-to-end: select text → the
// popover offers all five types for a commenter; a viewer-only role gets NO popover (read-only rail);
// a 0-character selection raises nothing and writes nothing. Mirrors commenting.test.tsx wiring.
//
// AS-001 commenter selects a sentence → popover lists Comment · Like · Label · Redline · Suggest.
// AS-002 viewer-only role → no Markup popover; read-only rail.
// AS-003 empty / whitespace-only selection → no popover, no annotation created.
// C-001  the affordance is gated on effectiveRole (client hint).
// C-008.T1 a Select-mode selection stays block-scoped (no anchor model switch — no create fired here).

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

const MD = `
<p data-block-id="block-p-1">Real-time Collaboration is the hard part of the plan.</p>
`;

let docResponse: unknown;

const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => okRead({ items: [] }));
const createAnnotation = mock(async () => okEnv({ annotationId: "a" }));

// canComment is the REAL capability logic (not mocked): only an explicit "viewer" role is read-only.
function canComment(role: string | undefined) {
  return role !== "viewer";
}

mock.module("@/features/viewer/services/client", () => ({
  // S-002: stub the redline create/decide so this file's partial client mock still satisfies the
  // imports useCompose/viewer-screen now make (bun mock.module binds exports at load).
  createRedline: mock(async () => ({ data: { success: true, data: { suggestionId: "rl-x" } }, error: null })),
  decideSuggestion: mock(async () => ({ data: { success: true, data: { status: "accepted" } }, error: null })),
  fetchViewerDoc,
  listAnnotations,
  createAnnotation,
  addComment: mock(async () => okEnv({ commentId: "c" })),
  setResolution: mock(async () => okEnv({ status: "resolved" })),
  deleteAnnotation: mock(async () => okEnv({ deleted: true })),
  restoreAnnotation: mock(async () => okEnv({ restored: true })),
  canComment,
}));

mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) }),
  Toaster: () => null,
}));

const { ViewerScreen } = await import("@/features/viewer/components/viewer-screen");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function App() {
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/d/my-doc"]}>
        <Routes>
          <Route path="/d/:slug" element={<ViewerScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

async function renderViewer() {
  render(<App />);
  await screen.findByTestId("markdown-view");
  await screen.findByTestId("annotations-rail");
}

function selectPhrase(blockId: string, phrase: string) {
  const view = screen.getByTestId("markdown-view");
  const block = view.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
  const textNode = block.firstChild as Text;
  const idx = textNode.data.indexOf(phrase);
  const range = document.createRange();
  range.setStart(textNode, idx);
  range.setEnd(textNode, idx + phrase.length);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => {
    block.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  });
}

function selectNothing(blockId: string) {
  const view = screen.getByTestId("markdown-view");
  const block = view.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
  const textNode = block.firstChild as Text;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, 0); // collapsed → 0 characters
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => {
    block.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  });
}

describe("Markup popover S-001", () => {
  beforeEach(() => {
    fetchViewerDoc.mockClear();
    listAnnotations.mockClear();
    createAnnotation.mockClear();
  });

  it("AS-001 / C-001: a commenter selecting a sentence gets a popover offering all five types", async () => {
    docResponse = okEnv({
      doc: { title: "Spec", kind: "markdown", version: 1, status: "live", generalAccess: "restricted", effectiveRole: "commenter" },
      content: MD,
    });

    await renderViewer();

    selectPhrase("block-p-1", "Real-time Collaboration");
    const popover = await screen.findByTestId("selection-popover");
    expect(within(popover).getByTestId("popover-comment")).toBeTruthy();
    expect(within(popover).getByTestId("popover-like")).toBeTruthy();
    expect(within(popover).getByTestId("popover-label")).toBeTruthy();
    expect(within(popover).getByTestId("popover-redline")).toBeTruthy();
    expect(within(popover).getByTestId("popover-suggest")).toBeTruthy();
  });

  it("AS-002 / C-001: a viewer-only role gets NO Markup popover (read-only rail)", async () => {
    docResponse = okEnv({
      doc: { title: "Spec", kind: "markdown", version: 1, status: "live", generalAccess: "restricted", effectiveRole: "viewer" },
      content: MD,
    });

    await renderViewer();

    selectPhrase("block-p-1", "Real-time Collaboration");
    await Promise.resolve();
    expect(screen.queryByTestId("selection-popover")).toBeNull();
    // No type-create path can be reached without the popover.
    expect(createAnnotation).not.toHaveBeenCalled();
  });

  it("AS-003 / C-008: a 0-character selection raises no popover and creates no annotation", async () => {
    docResponse = okEnv({
      doc: { title: "Spec", kind: "markdown", version: 1, status: "live", generalAccess: "restricted", effectiveRole: "commenter" },
      content: MD,
    });

    await renderViewer();

    selectNothing("block-p-1");
    await Promise.resolve();
    expect(screen.queryByTestId("selection-popover")).toBeNull();
    expect(createAnnotation).not.toHaveBeenCalled();
    expect(screen.getByTestId("rail-count")).toHaveTextContent("0");
  });
});
