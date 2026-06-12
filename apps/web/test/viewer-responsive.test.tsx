import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { viewerLayoutModeForWidth } from "@/lib/use-breakpoint";

// annotation-core-ui S-006 — Responsive viewer (AS-014). Two halves:
//   1. The PURE width→mode mapping (viewerLayoutModeForWidth) — deterministic, no layout, asserts
//      the prototype boundaries (drawerMode <900, tocDrawer <1200).
//   2. The wired shell at a narrow width: the viewport-mode hook is MOCKED to drawer mode so the
//      tests assert BEHAVIOR (CommentFab renders with the annotation count, the inline rail column
//      is absent, clicking the FAB opens the rail drawer, tapping a highlight opens the rail
//      drawer) without driving real layout. Pixel/slide-in is [→MANUAL] + a Playwright check (C-005).

// --- mode hook mock: default desktop; tests flip it per case via setMode() ---
let mode = { drawerMode: false, tocDrawer: false };
const setMode = (m: { drawerMode: boolean; tocDrawer: boolean }) => {
  mode = m;
};
mock.module("@/lib/use-breakpoint", () => ({
  // keep the real pure fns importable, override only the hook
  ...require("@/lib/use-breakpoint"),
  useViewerLayoutMode: () => mode,
}));

// --- viewer client mock: a markdown doc + 3 annotations (one resolved), like AS-014's data ---
// The real client returns the api-core envelope unwrapped by the screen (unwrapEnvelope) — so the
// mock wraps its payload in `{ success, data: ... }`, matching what treaty actually delivers.
const docResponse = {
  data: {
    success: true,
    data: {
      doc: { title: "Doc", kind: "markdown", version: 1, status: "live", generalAccess: "restricted" },
      content:
        '<p data-block-id="block-p-0">alpha beta gamma</p>' +
        '<p data-block-id="block-p-1">delta epsilon zeta</p>' +
        '<p data-block-id="block-p-2">eta theta iota</p>',
    },
  },
  error: null,
};
const annoResponse = {
  data: {
    success: true,
    data: {
      items: [
        { id: "a1", type: "comment", anchor: { blockId: "block-p-0", textSnippet: "beta", offset: 6, length: 4 }, status: "unresolved", isOrphaned: false, comments: [] },
        { id: "a2", type: "comment", anchor: { blockId: "block-p-1", textSnippet: "epsilon", offset: 6, length: 7 }, status: "unresolved", isOrphaned: false, comments: [] },
        { id: "a3", type: "comment", anchor: { blockId: "block-p-2", textSnippet: "theta", offset: 4, length: 5 }, status: "unresolved", isOrphaned: false, comments: [] },
      ],
    },
  },
  error: null,
};
const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => annoResponse);
mock.module("@/features/viewer/client", () => ({
  fetchViewerDoc,
  listAnnotations,
  // S-001 grew the client surface; use-compose imports these at module eval, so the whole-module
  // mock must provide them. These tests don't exercise the write path — safe no-op stubs + the
  // real canComment default (non-viewer → may comment).
  createAnnotation: mock(async () => ({ data: { success: true, data: { annotationId: "a" } }, error: null })),
  addComment: mock(async () => ({ data: { success: true, data: { commentId: "c" } }, error: null })),
  setResolution: mock(async () => ({ data: { success: true, data: { status: "resolved" } }, error: null })),
  canComment: (role: string | undefined) => role !== "viewer",
}));

const { ViewerScreen } = await import("@/features/viewer/viewer-screen");

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
  setMode({ drawerMode: false, tocDrawer: false });
  fetchViewerDoc.mockClear();
  listAnnotations.mockClear();
});

describe("S-006 — viewer responsive mode mapping (AS-014, pure)", () => {
  it("AS-014: a phone width (360) is drawer mode (rail + FAB drawer) and TOC-drawer", () => {
    expect(viewerLayoutModeForWidth(360)).toEqual({ drawerMode: true, tocDrawer: true });
  });

  it("AS-014: a desktop width (1440) is neither drawer mode nor TOC-drawer (inline panes)", () => {
    expect(viewerLayoutModeForWidth(1440)).toEqual({ drawerMode: false, tocDrawer: false });
  });

  it("AS-014: the rail drawerMode flips at <900 (prototype drawerMode: w < 900)", () => {
    expect(viewerLayoutModeForWidth(900).drawerMode).toBe(false);
    expect(viewerLayoutModeForWidth(899).drawerMode).toBe(true);
  });

  it("AS-014: the TOC tocDrawer flips at <1200 (prototype tocDrawer: w < 1200)", () => {
    expect(viewerLayoutModeForWidth(1200).tocDrawer).toBe(false);
    expect(viewerLayoutModeForWidth(1199).tocDrawer).toBe(true);
    // a tablet width is BOTH (rail + TOC are drawers)
    expect(viewerLayoutModeForWidth(768)).toEqual({ drawerMode: true, tocDrawer: true });
  });
});

describe("S-006 — narrow-screen shell (AS-014, drawer mode)", () => {
  it("AS-014: in drawer mode the inline rail column is absent and a CommentFab shows the annotation count", async () => {
    setMode({ drawerMode: true, tocDrawer: true });
    render(<App />);

    await screen.findByTestId("markdown-view");

    // The persistent inline rail column is NOT mounted at phone width.
    expect(screen.queryByTestId("viewer-rail-slot")).toBeNull();

    // The CommentFab is present and shows the annotation count (3 — all annotations).
    const fab = await screen.findByTestId("comment-fab");
    expect(fab).toHaveTextContent("3");
    // Rail drawer starts closed.
    expect(screen.queryByTestId("viewer-rail-drawer")).toBeNull();
  });

  it("AS-014: clicking the CommentFab opens the rail as a drawer", async () => {
    setMode({ drawerMode: true, tocDrawer: true });
    render(<App />);

    const fab = await screen.findByTestId("comment-fab");
    await userEvent.click(fab);

    const drawer = await screen.findByTestId("viewer-rail-drawer");
    expect(drawer).toBeInTheDocument();
    // the rail itself (with its threads) is inside the drawer
    expect(screen.getByTestId("annotations-rail")).toBeInTheDocument();
  });

  it("AS-014: tapping a highlight opens the rail drawer in drawer mode", async () => {
    setMode({ drawerMode: true, tocDrawer: true });
    render(<App />);

    await screen.findByTestId("markdown-view");
    // The marks are placed against the doc content (S-003); tapping one focuses its thread AND,
    // in drawer mode, opens the rail drawer so the reader can see it.
    await waitFor(() => expect(document.querySelector('[data-anno="a1"]')).not.toBeNull());
    const mark = document.querySelector('[data-anno="a1"]') as HTMLElement;

    await userEvent.click(mark);

    const drawer = await screen.findByTestId("viewer-rail-drawer");
    expect(drawer).toBeInTheDocument();
  });

  it("AS-014: on desktop there is no CommentFab and the inline rail column is present", async () => {
    setMode({ drawerMode: false, tocDrawer: false });
    render(<App />);

    await screen.findByTestId("markdown-view");
    expect(screen.getByTestId("viewer-rail-slot")).toBeInTheDocument();
    expect(screen.queryByTestId("comment-fab")).toBeNull();
  });
});
