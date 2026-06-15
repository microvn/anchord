import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { viewerLayoutModeForWidth } from "@/hooks/use-breakpoint";

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
mock.module("@/hooks/use-breakpoint", () => ({
  // keep the real pure fns importable, override only the hook
  ...require("@/hooks/use-breakpoint"),
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
// `response` is mutable so the kind-conditional layout tests below (C-006) can swap in an
// html / image doc; it defaults to the markdown docResponse the existing AS-014 tests rely on.
let response: unknown = docResponse;
const fetchViewerDoc = mock(async () => response);
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
  setMode({ drawerMode: false, tocDrawer: false });
  response = docResponse; // default: the markdown doc the AS-014 tests use
  fetchViewerDoc.mockClear();
  listAnnotations.mockClear();
});

// bun's mock.module is GLOBAL + persists across files, and this file's use-breakpoint mock reads a
// shared `mode` let. Files loaded AFTER this one that DON'T mock the hook (viewer-screen,
// annotations-rail, sandbox-bridge, reply-wiring) inherit whatever `mode` the LAST test here left.
// The pre-existing suite passed because the last test left DESKTOP (inline panes) — the benign
// state those files render against. Our added AS-014 tests can leave drawer mode last, which hides
// the inline rail/toc in the inheriting files (findBy timeouts). Pin `mode` back to desktop after
// this file so the leaked value stays the benign one the downstream files expect.
afterAll(() => {
  setMode({ drawerMode: false, tocDrawer: false });
});

// Kind-conditional doc payloads for the C-006 layout tests (html / image). Same envelope shape.
const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const htmlDoc = okEnv({
  doc: { title: "My HTML doc", kind: "html", version: 2, status: "live", generalAccess: "restricted" },
  content: { contentUrl: "/v/ver-42" },
});
const imageDoc = okEnv({
  doc: { title: "My image", kind: "image", version: 1, status: "live", generalAccess: "restricted" },
  content: { contentUrl: "/v/img-1" },
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

// annotation-core-ui — kind-conditional viewer layout (C-006, 2026-06-14).
//   Markdown → 3-pane: collapsible outline · content (prose width) · annotations rail.
//   HTML / image → 2-pane: full-width content · annotations rail; NO outline pane,
//     NO outline-toggle in the top bar (outline is derived from headings, which only the
//     app-origin Markdown render exposes — GAP-004).
//
// AS-001 markdown desktop → the outline (toc slot) IS present alongside content + rail.
// AS-002 html → 2-pane: no toc slot, no Outline toggle; the iframe content is NOT width-clamped.
// AS-003 image → 2-pane: no toc slot, no Outline toggle; the image content is NOT width-clamped.
// AS-018 markdown → collapsing the outline removes the toc slot (content reflows wider); toggling restores it.
// AS-014 html in drawer mode → still no Outline toggle and no toc drawer (html has no outline at any width).
// Pixel widths are [→MANUAL] + Playwright; the testable proxy for "full-width" is the absence of the
// prototype's max-w-[760px] reading clamp.

describe("kind-conditional layout (C-006)", () => {
  it("AS-001: a Markdown doc on desktop renders 3-pane — outline + content + annotations", async () => {
    response = docResponse;
    render(<App />);

    await screen.findByTestId("markdown-view");
    expect(screen.getByTestId("viewer-toc-slot")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-doc-pane")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-rail-slot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outline" })).toBeInTheDocument();
  });

  it("AS-002 / C-006: an HTML doc renders 2-pane — no outline pane, no outline-toggle, full-width content", async () => {
    response = htmlDoc;
    render(<App />);

    const frame = await screen.findByTestId("html-sandbox-frame");
    expect(screen.queryByTestId("viewer-toc-slot")).toBeNull();
    expect(screen.getByTestId("viewer-rail-slot")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Outline" })).toBeNull();
    expect(frame.parentElement?.className ?? "").not.toContain("max-w-[760px]");
  });

  it("AS-003 / C-006: an image doc renders 2-pane — no outline pane, no outline-toggle, full-width content", async () => {
    response = imageDoc;
    render(<App />);

    const viewer = await screen.findByTestId("image-viewer");
    expect(screen.queryByTestId("viewer-toc-slot")).toBeNull();
    expect(screen.getByTestId("viewer-rail-slot")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Outline" })).toBeNull();
    expect(viewer.className).not.toContain("max-w-[760px]");
  });
});

describe("collapse the outline on Markdown (AS-018)", () => {
  it("AS-018: collapsing the outline removes the outline pane; toggling again restores it", async () => {
    response = docResponse;
    render(<App />);

    await screen.findByTestId("markdown-view");
    expect(screen.getByTestId("viewer-toc-slot")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(screen.queryByTestId("viewer-toc-slot")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(screen.getByTestId("viewer-toc-slot")).toBeInTheDocument();
  });

  it("AS-018: an in-pane collapse control (next to the outline search) also collapses the outline; the top-bar toggle re-expands", async () => {
    response = docResponse;
    render(<App />);

    await screen.findByTestId("markdown-view");
    expect(screen.getByTestId("viewer-toc-slot")).toBeInTheDocument();

    // Collapse from INSIDE the pane (the chevron beside the "Filter outline…" search).
    await userEvent.click(screen.getByRole("button", { name: "Collapse outline" }));
    expect(screen.queryByTestId("viewer-toc-slot")).toBeNull();

    // The persistent top-bar outline-toggle brings it back (the in-pane control is gone with the pane).
    await userEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(screen.getByTestId("viewer-toc-slot")).toBeInTheDocument();
  });
});

describe("responsive per kind (AS-014)", () => {
  it("AS-014: an HTML doc in drawer mode has no outline-toggle and no TOC drawer (html has no outline)", async () => {
    setMode({ drawerMode: true, tocDrawer: true });
    response = htmlDoc;
    render(<App />);

    await screen.findByTestId("html-sandbox-frame");
    expect(screen.queryByRole("button", { name: "Outline" })).toBeNull();
    expect(screen.queryByTestId("viewer-toc-drawer")).toBeNull();
    expect(screen.getByTestId("comment-fab")).toBeInTheDocument();
  });

  it("AS-014: a Markdown doc in drawer mode still offers the outline as a drawer", async () => {
    setMode({ drawerMode: true, tocDrawer: true });
    response = docResponse;
    render(<App />);

    await screen.findByTestId("markdown-view");
    await userEvent.click(screen.getByRole("button", { name: "Outline" }));
    expect(await screen.findByTestId("viewer-toc-drawer")).toBeInTheDocument();
  });
});
