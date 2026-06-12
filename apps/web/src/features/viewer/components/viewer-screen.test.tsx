import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core-ui S-001 — Open a doc in the viewer. The viewer client is MOCKED so the
// tests assert render BEHAVIOR (which surface renders for each kind, and the no-access state),
// not a real round-trip. Pixel/responsive (C-005) is [→MANUAL] + a Playwright runtime check.
//
// AS-001 markdown → renders inline in the app theme (NOT an iframe).
// AS-002 html → renders a sandboxed iframe with src = the contentUrl (NOT inline html).
// AS-003 image → renders the image + a zoom control that changes the zoom transform.
// AS-004 no-access/missing (404) → a not-found state, never the content (existence-hiding, C-002).

// Eden's `{ data, error }` envelope shapes. The real client returns treaty's result UNwrapped —
// `data` is the api-core envelope `{ success, data: <payload>, ... }`, and the screen peels that
// inner `.data` via unwrapEnvelope. Mirror that here so a regression that drops the unwrap (reading
// the raw envelope, `.doc` undefined → blank viewer) actually fails a test instead of passing.
const ok = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const httpError = (status: number, code?: string) => ({
  data: null,
  error: { status, value: code ? { success: false, error: { code, message: "nope" } } : null },
});

let response: unknown;
const fetchViewerDoc = mock(async () => response);
// S-003 added the annotations read to this client module; the viewer now mounts the rail, which
// calls listAnnotations. These S-001 tests only assert the doc surface, so the rail's read returns
// an empty list (the rail then shows its empty state, irrelevant to the S-001 assertions).
const listAnnotations = mock(async () => ({ data: { success: true, data: { items: [] } }, error: null }));

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
          {/* Bug #3: the top bar's Back button navigates here (workspace home, /w/:workspaceId). */}
          <Route path="/w/:workspaceId" element={<div data-testid="workspace-home">home</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  fetchViewerDoc.mockClear();
  response = undefined;
});

describe("ViewerScreen S-001", () => {
  it("AS-001: a Markdown doc renders in the app theme (not in an iframe)", async () => {
    response = ok({
      doc: { title: "My MD doc", kind: "markdown", version: 1, status: "published", generalAccess: "restricted" },
      content: "<h2>Intro</h2><ul><li>first</li><li>second</li></ul>",
    });

    render(<App />);

    const view = await screen.findByTestId("markdown-view");
    // Content is rendered inline in an app-origin container…
    expect(view).toHaveTextContent("Intro");
    expect(view).toHaveTextContent("first");
    expect(view.querySelector("h2")).not.toBeNull();
    expect(view.querySelector("li")).not.toBeNull();
    // …NOT inside an iframe.
    expect(screen.queryByTestId("html-sandbox-frame")).toBeNull();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("S-001 (DocModeToolbar): Wide↔Focus toggles the doc measure on the docpane", async () => {
    response = ok({
      doc: { title: "My MD doc", kind: "markdown", version: 1, status: "published", generalAccess: "restricted" },
      content: "<h1 id='block-h1-1'>Title</h1><p id='block-p-1'>body</p>",
    });

    render(<App />);

    await screen.findByTestId("markdown-view");
    const pane = screen.getByTestId("viewer-doc-pane");
    const toolbar = screen.getByTestId("doc-mode-toolbar");
    // Default measure is Wide.
    expect(pane).toHaveAttribute("data-doc-width", "wide");

    await userEvent.click(within(toolbar).getByText("Focus"));
    expect(pane).toHaveAttribute("data-doc-width", "focus");

    await userEvent.click(within(toolbar).getByText("Wide"));
    expect(pane).toHaveAttribute("data-doc-width", "wide");
  });

  it("AS-002: an HTML doc renders in a sandboxed iframe with the content URL (not inline html)", async () => {
    response = ok({
      doc: { title: "My HTML doc", kind: "html", version: 2, status: "published", generalAccess: "restricted" },
      content: { contentUrl: "/v/ver-42" },
    });

    render(<App />);

    const frame = await screen.findByTestId("html-sandbox-frame");
    expect(frame.tagName).toBe("IFRAME");
    // Isolated origin: sandbox without allow-same-origin, src points at the /v content route.
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("/v/ver-42");
    // The untrusted HTML is NOT rendered inline in the app origin.
    expect(screen.queryByTestId("markdown-view")).toBeNull();
  });

  it("AS-003: an image doc renders with a working zoom control", async () => {
    response = ok({
      doc: { title: "My image", kind: "image", version: 1, status: "published", generalAccess: "restricted" },
      content: { contentUrl: "/v/img-1" },
    });

    render(<App />);

    const img = (await screen.findByTestId("image-viewer-img")) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/v/img-1");
    const before = img.style.transform; // scale(1)

    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(img.style.transform).not.toBe(before);
    expect(img.style.transform).toContain("scale(1.2)");

    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(img.style.transform).toContain("scale(1)");
  });

  it("AS-012: the top bar shows doc identity and the comments toggle shows/hides the rail", async () => {
    response = ok({
      doc: { title: "My MD doc", kind: "markdown", version: 4, status: "live", generalAccess: "restricted" },
      content: "<h2>Intro</h2><p>body</p>",
    });

    render(<App />);

    // Top bar identity (title · Live · format · version).
    await screen.findByTestId("markdown-view");
    expect(screen.getByTestId("vt-title")).toHaveTextContent("My MD doc");
    expect(screen.getByTestId("vt-live-badge")).toHaveTextContent("Live");
    expect(screen.getByTestId("vt-format-badge")).toHaveTextContent("MD");
    expect(screen.getByTestId("vt-version")).toHaveTextContent("v4");

    // Rail visible by default; the comments toggle reads pressed.
    expect(screen.getByTestId("viewer-rail-slot")).toBeInTheDocument();
    const toggle = screen.getByTestId("vt-comments-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    // Click → rail unmounts (hidden), toggle reads not-pressed.
    await userEvent.click(toggle);
    expect(screen.queryByTestId("viewer-rail-slot")).toBeNull();
    expect(screen.getByTestId("vt-comments-toggle")).toHaveAttribute("aria-pressed", "false");

    // Click again → rail back.
    await userEvent.click(screen.getByTestId("vt-comments-toggle"));
    expect(screen.getByTestId("viewer-rail-slot")).toBeInTheDocument();
  });

  it("Bug #3: the top bar shows a Back button that navigates to the workspace home", async () => {
    response = ok({
      doc: { title: "My MD doc", kind: "markdown", version: 1, status: "live", generalAccess: "restricted" },
      content: "<h2>Intro</h2><p>body</p>",
    });

    render(<App />);

    await screen.findByTestId("markdown-view");
    const back = screen.getByRole("button", { name: "Back" });
    expect(back).toBeInTheDocument();

    await userEvent.click(back);
    expect(screen.getByTestId("workspace-home")).toBeInTheDocument();
  });

  it("AS-004: a doc I cannot access (404) shows a not-found state, never its content", async () => {
    response = httpError(404, "NOT_FOUND");

    render(<App />);

    await waitFor(() => expect(screen.getByTestId("viewer-not-found")).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText("Document not found")).toBeInTheDocument();
    // Existence-hiding: no doc surface, no empty "0 comments" rail leaking existence.
    expect(screen.queryByTestId("markdown-view")).toBeNull();
    expect(screen.queryByTestId("html-sandbox-frame")).toBeNull();
    expect(screen.queryByTestId("image-viewer")).toBeNull();
  });
});
