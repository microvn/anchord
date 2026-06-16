import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  canComment: (role: string | undefined) => role !== "viewer",
}));

// The session decides the anon vs signed-in variant + member-only chrome. Swapped per test.
let session: { user: { email: string } } | null = null;
mock.module("@/lib/api/auth-client", () => ({
  useSession: () => ({ data: session, isPending: false }),
  signOut: mock(async () => ({ data: { success: true }, error: null })),
  authClient: {},
}));

// Stub the heavy member-only panels: each surfaces the workspaceId it was handed, so the test
// proves the value was SOURCED FROM THE READ RESPONSE (not the old "" stub) and the panel mounted.
mock.module("@/features/sharing/components/share-dialog", () => ({
  ShareDialog: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="share-dialog-stub" data-workspace-id={workspaceId} />
  ),
}));
mock.module("@/features/versioning/components/version-history-panel", () => ({
  VersionHistoryPanel: ({ workspaceId }: { workspaceId: string }) => (
    <div data-testid="version-panel-stub" data-workspace-id={workspaceId} />
  ),
}));

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

describe("doc-access-routing S-003 — AS-030 member workspace context", () => {
  it("AS-030: a signed-in member sees Share + Version wired to the read-response workspaceId", async () => {
    session = { user: { email: "owner@b.co" } }; // signed-in member
    docResponse = memberDoc("ws_from_response");

    render(<App />);

    // The Share button shows (owner role) and opens the dialog wired to the response workspaceId.
    const share = await screen.findByTestId("vt-share");
    await userEvent.click(share);
    const shareDialog = await screen.findByTestId("share-dialog-stub");
    expect(shareDialog).toHaveAttribute("data-workspace-id", "ws_from_response");

    // The Version button opens the history panel, also wired to the response workspaceId — NOT the
    // old interim stub (workspaceId="").
    await userEvent.click(screen.getByTestId("vt-version"));
    const versionPanel = await screen.findByTestId("version-panel-stub");
    expect(versionPanel).toHaveAttribute("data-workspace-id", "ws_from_response");
    expect(versionPanel).not.toHaveAttribute("data-workspace-id", "");
  });

  it("AS-030: an anonymous viewer does not see the member-only Share/Version panels", async () => {
    session = null; // anonymous
    // Anon on an anyone_with_link doc still reads; the panels must be absent regardless of workspaceId.
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
    // …but no member-only chrome: no Share button (AS-029) and the panels never mount.
    expect(screen.queryByTestId("vt-share")).toBeNull();
    expect(screen.queryByTestId("share-dialog-stub")).toBeNull();
    expect(screen.queryByTestId("version-panel-stub")).toBeNull();
  });

  it("AS-030: a signed-in member on a project-less doc (null workspaceId) does not see the panels", async () => {
    session = { user: { email: "owner@b.co" } }; // signed-in member, owner role…
    docResponse = memberDoc(null); // …but the doc has no project → null workspaceId (C-011)

    render(<App />);

    await screen.findByTestId("markdown-view");
    // No workspace to address → the Share button is hidden and neither panel mounts.
    expect(screen.queryByTestId("vt-share")).toBeNull();
    expect(screen.queryByTestId("share-dialog-stub")).toBeNull();
    // Opening version history isn't possible without a workspace either — the panel stays absent.
    await userEvent.click(screen.getByTestId("vt-version"));
    await waitFor(() => {
      expect(screen.queryByTestId("version-panel-stub")).toBeNull();
    });
  });
});
