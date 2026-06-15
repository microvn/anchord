import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core-ui-types-modes S-006 (C-009) — the markup tool palette: the ACTIVE tool routes a
// text selection. This is the behavioural core (per-tool routing), proven end-to-end in the real
// viewer flow (select text → what happens depends on the active toolbar tool):
//
//   AS-020 Markup active  → the 5-type popover (Comment·Like·Label·Redline·Suggest) appears.
//   AS-021 Comment active → the comment composer opens directly; NO 5-type popover.
//   AS-022 Redline active → the selection is struck (a red-strike redline created) directly; no popover.
//   AS-023 Label active   → the label picker opens directly; NO 5-type popover.
//
// The create paths themselves (startComment / startRedline / startLabel) are S-002/003/004 — this
// story only RE-POINTS them by active tool. Mirrors markup-popover.test.tsx wiring.

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

const MD = `
<p data-block-id="block-p-1">Real-time Collaboration is the hard part of the plan.</p>
`;

let docResponse: unknown;

const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => okRead({ items: [] }));
const createAnnotation = mock(async () => okEnv({ annotationId: "a" }));
const createRedline = mock(async () => okEnv({ suggestionId: "rl-x" }));
const addComment = mock(async () => okEnv({ commentId: "c" }));

function canComment(role: string | undefined) {
  return role !== "viewer";
}

mock.module("@/features/viewer/services/client", () => ({
  fetchViewerDoc,
  listAnnotations,
  createAnnotation,
  createRedline,
  decideSuggestion: mock(async () => okEnv({ status: "accepted" })),
  addComment,
  setResolution: mock(async () => okEnv({ status: "resolved" })),
  canComment,
}));

// A signed-in member session so the workspace-scoped redline create (AS-022) is reachable.
mock.module("@/lib/api/auth-client", () => ({
  useSession: () => ({ data: { user: { email: "me@x.com" } }, isPending: false }),
  signOut: mock(async () => okEnv({ ok: true })),
  authClient: {},
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
          <Route path="/signin" element={<div data-testid="signin-screen" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// A member-readable markdown doc (owner role + workspaceId) so every tool's create path is reachable.
const memberDoc = okEnv({
  doc: {
    title: "Spec",
    kind: "markdown",
    version: 4,
    status: "live",
    generalAccess: "restricted",
    effectiveRole: "owner",
    workspaceId: "ws-1",
  },
  content: MD,
});

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

async function pickTool(tool: string) {
  await userEvent.click(screen.getByTestId(`markup-tool-${tool}`));
}

describe("Markup tool routing S-006 (C-009)", () => {
  beforeEach(() => {
    docResponse = memberDoc;
    fetchViewerDoc.mockClear();
    listAnnotations.mockClear();
    createAnnotation.mockClear();
    createRedline.mockClear();
    addComment.mockClear();
  });

  it("AS-020: Markup tool active → selecting a sentence shows the 5-type popover", async () => {
    await renderViewer();
    // Markup is the default active tool — no explicit pick needed.
    selectPhrase("block-p-1", "Real-time Collaboration");

    const popover = await screen.findByTestId("selection-popover");
    expect(popover).toBeTruthy();
    // The 5-type popover (the Markup tool's surface).
    expect(screen.getByTestId("popover-comment")).toBeTruthy();
    expect(screen.getByTestId("popover-redline")).toBeTruthy();
    // No composer / picker opened directly.
    expect(screen.queryByTestId("inline-composer-popover")).toBeNull();
    expect(screen.queryByTestId("label-picker")).toBeNull();
  });

  it("AS-021: Comment tool active → selecting opens the comment composer directly (no 5-type popover)", async () => {
    await renderViewer();
    await pickTool("comment");
    selectPhrase("block-p-1", "Real-time Collaboration");

    // The comment composer opens directly on the selection.
    await screen.findByTestId("inline-composer-popover");
    // The 5-type popover does NOT appear.
    expect(screen.queryByTestId("selection-popover")).toBeNull();
  });

  it("AS-022: Redline tool active → selecting strikes the selection directly (no popover)", async () => {
    await renderViewer();
    await pickTool("redline");
    selectPhrase("block-p-1", "Real-time Collaboration");

    // Redline fires the workspace-scoped create directly — no popover, no composer.
    await waitFor(() => expect(createRedline).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("selection-popover")).toBeNull();
    expect(screen.queryByTestId("inline-composer-popover")).toBeNull();
    // The optimistic red strike is placed on the selected text (kind=redline mark, AS-022/C-002).
    const view = screen.getByTestId("markdown-view");
    expect(view.querySelector('mark[data-anno][data-anno-kind="redline"]')).toBeTruthy();
  });

  it("AS-023: Label tool active → selecting opens the label picker directly (no 5-type popover)", async () => {
    await renderViewer();
    await pickTool("label");
    selectPhrase("block-p-1", "Real-time Collaboration");

    // The label picker opens directly on the selection.
    await screen.findByTestId("label-picker");
    // The 5-type popover does NOT appear.
    expect(screen.queryByTestId("selection-popover")).toBeNull();
  });
});
