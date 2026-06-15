import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// READ-PATH render fidelity (S-006): a doc loaded with EXISTING annotations (served by the
// annotations query — NOT the optimistic create path) must render its marks + rail cards IDENTICALLY
// to a freshly-created (optimistic) annotation. This guards the "reload / first-load renders wrong"
// regression where a redline degraded into an ordinary teal highlight and a typed rail card lost its
// type badge / label line.
//
// All four annotation kinds are SEEDED via listAnnotations (the read), then we assert:
//   • marks   — the redline mark carries data-anno-kind="redline" (and the stale one data-anno-stale);
//               the like/label render an ordinary highlight (no redline kind). (AS-004 / AS-007)
//   • rail    — the redline card shows the DELETE badge; the like card shows 👍 "Looks good"; the
//               label card shows the preset icon + "Out of scope". (AS-010 / AS-012)

import type { ViewerAnnotation } from "@/features/viewer/services/client";

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

// One block per seeded annotation so each snippet locates unambiguously.
const MD = [
  `<h1 data-block-id="block-h1">Implementation Plan: Real-time Collaboration</h1>`,
  `<p data-block-id="block-stale">A stale clause that drifted away from the live version.</p>`,
  `<p data-block-id="block-like">Context is the hard part of the plan.</p>`,
  `<p data-block-id="block-label">An out of scope tangent we should drop.</p>`,
].join("");

function redline(): ViewerAnnotation {
  return {
    id: "rl-read",
    type: "suggestion",
    status: "unresolved",
    isOrphaned: false,
    anchor: { blockId: "block-h1", textSnippet: "Implementation Plan: Real-time Collaboration", offset: 0, length: 44 },
    suggestion: { kind: "delete", from: "Implementation Plan: Real-time Collaboration", againstVersion: 4 },
    suggestionStatus: "pending",
    comments: [
      { id: "rl-read-c", parentId: null, authorName: "Mara", body: "Suggested deletion", createdAt: new Date().toISOString() },
    ],
  };
}

function staleRedline(): ViewerAnnotation {
  return {
    id: "rl-stale",
    type: "suggestion",
    status: "unresolved",
    isOrphaned: false,
    anchor: { blockId: "block-stale", textSnippet: "A stale clause that drifted away from the live version.", offset: 0, length: 55 },
    suggestion: { kind: "delete", from: "A stale clause that drifted away from the live version.", againstVersion: 3 },
    suggestionStatus: "stale",
    comments: [
      { id: "rl-stale-c", parentId: null, authorName: "Mara", body: "Old deletion", createdAt: new Date().toISOString() },
    ],
  };
}

function like(): ViewerAnnotation {
  return {
    id: "lk-read",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    label: "looks-good",
    anchor: { blockId: "block-like", textSnippet: "Context is the hard part of the plan.", offset: 0, length: 37 },
    comments: [
      { id: "lk-read-c", parentId: null, authorName: "Mara", body: "Looks good", createdAt: new Date().toISOString() },
    ],
  };
}

function label(): ViewerAnnotation {
  return {
    id: "lb-read",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    label: "out-of-scope",
    anchor: { blockId: "block-label", textSnippet: "An out of scope tangent we should drop.", offset: 0, length: 39 },
    comments: [
      { id: "lb-read-c", parentId: null, authorName: "Mara", body: "Out of scope", createdAt: new Date().toISOString() },
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

describe("Read-path render fidelity (S-006) — marks + rail from the annotations query, not optimistic", () => {
  beforeEach(() => {
    fetchViewerDoc.mockClear();
    listAnnotations.mockClear();
    session = { user: { email: "owner@b.co" } }; // signed-in owner → memberWorkspaceId resolves
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
    annoResponse = okRead({ items: [redline(), staleRedline(), like(), label()] });
  });

  afterEach(() => {
    session = null;
  });

  it("AS-004 (read): a SERVED pending redline places a redline-kind mark, not an ordinary highlight", async () => {
    await renderViewer();
    const view = screen.getByTestId("markdown-view");
    await waitFor(() => {
      const mark = view.querySelector('[data-anno="rl-read"]') as HTMLElement | null;
      expect(mark).not.toBeNull();
      expect(mark!.dataset.annoKind).toBe("redline");
    });
  });

  it("AS-007 (read): a SERVED stale redline places a redline-kind mark flagged stale", async () => {
    await renderViewer();
    const view = screen.getByTestId("markdown-view");
    await waitFor(() => {
      const mark = view.querySelector('[data-anno="rl-stale"]') as HTMLElement | null;
      expect(mark).not.toBeNull();
      expect(mark!.dataset.annoKind).toBe("redline");
      expect(mark!.dataset.annoStale).toBe("true");
    });
  });

  it("AS-010 (read): a SERVED like/label places an ORDINARY highlight (no redline kind)", async () => {
    await renderViewer();
    const view = screen.getByTestId("markdown-view");
    await waitFor(() => {
      expect(view.querySelector('[data-anno="lk-read"]')).not.toBeNull();
      expect(view.querySelector('[data-anno="lb-read"]')).not.toBeNull();
    });
    expect((view.querySelector('[data-anno="lk-read"]') as HTMLElement).dataset.annoKind).toBeUndefined();
    expect((view.querySelector('[data-anno="lb-read"]') as HTMLElement).dataset.annoKind).toBeUndefined();
  });

  it("AS-004 (read): the SERVED redline's rail card shows the DELETE badge", async () => {
    await renderViewer();
    const card = await waitFor(() => {
      const el = screen.getByTestId("annotations-rail").querySelector('[data-anno-thread="rl-read"]') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    expect(within(card).getByTestId("type-badge-delete")).toHaveTextContent(/delete/i);
  });

  it("AS-010 (read): the SERVED like's rail card shows the 👍 \"Looks good\" label line", async () => {
    await renderViewer();
    const card = await waitFor(() => {
      const el = screen.getByTestId("annotations-rail").querySelector('[data-anno-thread="lk-read"]') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    const line = within(card).getByTestId("label-line");
    expect(line).toHaveTextContent("Looks good");
    expect(line).toHaveTextContent("👍");
    expect(line.getAttribute("data-label")).toBe("looks-good");
  });

  it("AS-012 (read): the SERVED label's rail card shows the \"Out of scope\" preset label line", async () => {
    await renderViewer();
    const card = await waitFor(() => {
      const el = screen.getByTestId("annotations-rail").querySelector('[data-anno-thread="lb-read"]') as HTMLElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    const line = within(card).getByTestId("label-line");
    expect(line).toHaveTextContent("Out of scope");
    expect(line.getAttribute("data-label")).toBe("out-of-scope");
  });
});
