import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// doc-access-routing S-003 / AS-030 — a signed-in member uses the doc's workspace context for the
// member-only panels on the doc-scoped public viewer.
//
// The doc-scoped viewer (/d/:slug) has NO :workspaceId URL param, so the member-only,
// workspace-addressed Share dialog + Version history (kept workspace-addressed per C-007) MUST
// source their workspaceId from the doc-read response. This test asserts:
//   - a signed-in member on a doc whose response carries a non-null workspaceId sees Share +
//     Version wired to THAT workspaceId (replaces the S-003 interim stub workspaceId="");
//   - an anonymous viewer does NOT see those panels (complements AS-029);
//   - a doc whose response workspaceId is null (project-less, C-011) does NOT see them either.

const ok = (body: unknown) => ({ data: { success: true, data: body }, error: null });

let docResponse: unknown;
let annoResponse: unknown;
const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => annoResponse);

mock.module("@/features/viewer/services/client", () => ({
  fetchViewerDoc,
  listAnnotations,
  createAnnotation: mock(async () => ({ data: { success: true, data: { annotationId: "a" } }, error: null })),
  addComment: mock(async () => ({ data: { success: true, data: { commentId: "c" } }, error: null })),
  setResolution: mock(async () => ({ data: { success: true, data: { status: "resolved" } }, error: null })),
  // S-002: stub the redline create/decide so this partial client mock satisfies useCompose/viewer-screen.
  createRedline: mock(async () => ({ data: { success: true, data: { suggestionId: "rl-x" } }, error: null })),
  decideSuggestion: mock(async () => ({ data: { success: true, data: { status: "accepted" } }, error: null })),
  deleteAnnotation: mock(async () => ({ data: { success: true, data: { deleted: true } }, error: null })),
  restoreAnnotation: mock(async () => ({ data: { success: true, data: { restored: true } }, error: null })),
  dismissAnnotation: mock(async () => ({ data: { success: true, data: { dismissed: true } }, error: null })),
  reattachAnnotation: mock(async () => ({ data: { success: true, data: { isOrphaned: false } }, error: null })),
  canComment: (role: string | undefined) => role !== "viewer",
}));

// The session decides the anon vs signed-in variant + member-only chrome. Swapped per test.
let session: { user: { email: string } } | null = null;
mock.module("@/lib/api/auth-client", () => ({
  useSession: () => ({ data: session, isPending: false }),
  signOut: mock(async () => ({ data: { success: true }, error: null })),
  authClient: {},
}));

// NOTE: we deliberately do NOT mock.module the heavy panels (ShareDialog / VersionHistoryPanel).
// bun's mock.module is PROCESS-GLOBAL with load-time binding, so stubbing those COMPONENT modules
// here leaked into versioning-diff-ui's own tests (which mount the real panel) and broke them in the
// full suite (afterAll-restore can't undo a load-time import). Instead we assert the workspace
// wiring through the Share button's GATING — `showShare = canShare && Boolean(memberWorkspaceId)`
// (viewer-screen.tsx) — which proves memberWorkspaceId is the truthy response value for a member and
// null for anon / project-less. The old interim-stub bug (workspaceId="") is falsy → Share hidden,
// so this gating still catches that regression. The real panels mount closed + inert (the
// viewer-screen.test.tsx pattern). See memory bun-mockmodule-leak.

const { ViewerScreen } = await import("@/features/viewer/components/viewer-screen");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
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

/** A member-readable markdown doc whose response carries an owner role + the given workspaceId. */
const memberDoc = (workspaceId: string | null) =>
  ok({
    doc: {
      title: "Member spec",
      kind: "markdown",
      version: 2,
      status: "published",
      generalAccess: "restricted",
      effectiveRole: "owner",
      workspaceId,
    },
    content: "<h2>Hello</h2><p>world</p>",
  });

beforeEach(() => {
  fetchViewerDoc.mockClear();
  listAnnotations.mockClear();
  docResponse = undefined;
  annoResponse = ok({ items: [] });
  session = null;
});

// auth-client is mocked via a shared mutable `session`. bun's mock.module is process-global, so the
// LAST value this file leaves leaks into later files that read useSession (e.g. guest-commenting,
// which expects a signed-out guest). Reset to the benign signed-out default after each test so the
// leaked state is null, not a stray signed-in session (runtime state reset — works, unlike a module
// restore). See memory bun-mockmodule-leak.
afterEach(() => {
  session = null;
});

describe("doc-access-routing S-003 — AS-030 member workspace context", () => {
  it("AS-030: a signed-in member on a doc with a response workspaceId sees the workspace-addressed Share affordance", async () => {
    session = { user: { email: "owner@b.co" } }; // signed-in member, owner role
    docResponse = memberDoc("ws_from_response");

    render(<App />);

    await screen.findByTestId("markdown-view");
    // showShare = canShare && Boolean(memberWorkspaceId): the Share button appears ONLY because the
    // member-only chrome resolved a truthy workspaceId FROM THE READ RESPONSE. The old interim bug
    // (workspaceId="") is falsy → this would be absent, so its presence proves the real value flowed.
    expect(await screen.findByTestId("vt-share")).toBeInTheDocument();
  });

  it("AS-030: an anonymous viewer does not see the member-only Share affordance", async () => {
    session = null; // anonymous
    // Anon on an anyone_with_link doc still reads; the member-only chrome must be absent regardless of workspaceId.
    docResponse = ok({
      doc: {
        title: "Public spec",
        kind: "markdown",
        version: 1,
        status: "published",
        generalAccess: "anyone_with_link",
        workspaceId: "ws_from_response",
      },
      content: "<h2>Hello</h2><p>world</p>",
    });

    render(<App />);

    await screen.findByTestId("markdown-view"); // the doc rendered…
    expect(screen.queryByTestId("vt-share")).toBeNull(); // …but no member-only Share chrome (AS-029)
  });

  it("AS-030: a signed-in member on a project-less doc (null workspaceId) does not see the Share affordance", async () => {
    session = { user: { email: "owner@b.co" } }; // signed-in member, owner role…
    docResponse = memberDoc(null); // …but the doc has no project → null workspaceId (C-011)

    render(<App />);

    await screen.findByTestId("markdown-view");
    // memberWorkspaceId is null (no workspace to address) → showShare is false → the Share button is hidden.
    expect(screen.queryByTestId("vt-share")).toBeNull();
  });
});
