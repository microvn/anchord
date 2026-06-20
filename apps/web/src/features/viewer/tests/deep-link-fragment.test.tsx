import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// notifications-email S-007 (C-013 / AS-024): the email deep-link is
// `{APP_URL}/d/{slug}#annotation-{id}`. Opening the viewer with that fragment must scroll to +
// highlight the target annotation, reusing the in-app focus path (onFocusThread → setFocusedId +
// scrollToAnno → the `.anno-mark--focus` class on the matching `data-anno` mark). With NO
// fragment, the viewer opens normally and nothing is focused.
//
// This is the CONSUMER side of the deep-link seam (the producer — the link builder — is
// AS-019 in notify.ts). It hits the REAL viewer focus path (not a stub): a markdown doc renders
// a real `data-anno` mark, and the mount-time fragment reader drives the real focus.

import type { ViewerAnnotation } from "@/features/viewer/services/client";

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

const MD = [
  `<h1 data-block-id="block-h1">Implementation Plan</h1>`,
  `<p data-block-id="block-target">The exact paragraph the deep-link points at.</p>`,
].join("");

function targetAnno(): ViewerAnnotation {
  return {
    id: "abc123",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    anchor: { blockId: "block-target", textSnippet: "The exact paragraph the deep-link points at.", offset: 0, length: 44 },
    comments: [
      { id: "abc123-c", parentId: null, authorName: "Mara", body: "Look here", createdAt: new Date().toISOString() },
    ],
  };
}

let docResponse: unknown;
let annoResponse: unknown;

const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => annoResponse);

function canComment(role: string | undefined) {
  return role !== "viewer";
}

mock.module("@/features/viewer/services/client", () => ({
  fetchViewerDoc,
  listAnnotations,
  createAnnotation: mock(async () => okEnv({ annotationId: "a" })),
  addComment: mock(async () => okEnv({ commentId: "c" })),
  setResolution: mock(async () => okEnv({ status: "resolved" })),
  createRedline: mock(async () => okEnv({ suggestionId: "s" })),
  decideSuggestion: mock(async () => okEnv({ status: "accepted" })),
  deleteAnnotation: mock(async () => okEnv({ deleted: true })),
  restoreAnnotation: mock(async () => okEnv({ restored: true })),
  dismissAnnotation: mock(async () => okEnv({ dismissed: true })),
  reattachAnnotation: mock(async () => okEnv({ isOrphaned: false })),
  canComment,
}));

mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) }),
  Toaster: () => null,
}));

let session: { user: { email: string } } | null = null;
mock.module("@/lib/api/auth-client", () => ({
  useSession: () => ({ data: session, isPending: false }),
  signOut: mock(async () => ({ data: { success: true }, error: null })),
  authClient: {},
}));

const { ViewerScreen } = await import("@/features/viewer/components/viewer-screen");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function App() {
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/d/spec-v2"]}>
        <Routes>
          <Route path="/d/:slug" element={<ViewerScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("S-007 deep-link fragment reader (C-013 / AS-024)", () => {
  beforeEach(() => {
    fetchViewerDoc.mockClear();
    listAnnotations.mockClear();
    session = { user: { email: "owner@b.co" } };
    docResponse = okEnv({
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
    annoResponse = okRead({ items: [targetAnno()] });
    // Reset the fragment between tests — the reader is window.location-driven.
    window.location.hash = "";
  });

  afterEach(() => {
    session = null;
    window.location.hash = "";
  });

  it("AS-024.T1: opening at #annotation-abc123 scrolls to + highlights that annotation", async () => {
    // The deep-link lands the browser on the doc with the annotation fragment in the URL.
    window.location.hash = "#annotation-abc123";

    render(<App />);
    const view = await screen.findByTestId("markdown-view");

    // The mount-time reader honors the fragment via the REAL focus path → the matching mark
    // gets the focus emphasis class (.anno-mark--focus), exactly as a rail-card click would.
    await waitFor(() => {
      const mark = view.querySelector('[data-anno="abc123"]') as HTMLElement | null;
      expect(mark).not.toBeNull();
      expect(mark!.classList.contains("anno-mark--focus")).toBe(true);
    });
  });

  it("AS-024.T2: with NO fragment, the viewer opens normally and nothing is focused", async () => {
    window.location.hash = ""; // no annotation fragment

    render(<App />);
    const view = await screen.findByTestId("markdown-view");

    // The mark renders (the doc + annotation loaded) …
    await waitFor(() => {
      expect(view.querySelector('[data-anno="abc123"]')).not.toBeNull();
    });
    // … but nothing is focused — no mark carries the focus class.
    expect(view.querySelector(".anno-mark--focus")).toBeNull();
  });

  it("AS-024: an unrelated hash (not #annotation-…) focuses nothing", async () => {
    window.location.hash = "#section-intro";

    render(<App />);
    const view = await screen.findByTestId("markdown-view");

    await waitFor(() => {
      expect(view.querySelector('[data-anno="abc123"]')).not.toBeNull();
    });
    expect(view.querySelector(".anno-mark--focus")).toBeNull();
  });
});
