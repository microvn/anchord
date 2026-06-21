import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// Regression (guest reply): a logged-out guest replying in a thread POSTed { body, parentId } with
// NO guestName → the server rejected the anon write with 400 "guestName is required". The session
// identity (header chip) must ride up on the REPLY surface too — not just the composer (send) and the
// redline (startRedline). Sibling of the AS-017 guest-redline regression in redline.test.tsx; the
// reply path was the one guest-write surface the session-stable-identity refactor missed.

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

const MD = `<p data-block-id="block-p-1">Payment expires after 24h unless renewed.</p>`;

const baseThread = {
  id: "anno-1",
  type: "range",
  status: "unresolved" as const,
  isOrphaned: false,
  anchor: {
    blockId: "block-p-1",
    textSnippet: "Payment expires after 24h",
    offset: 0,
    length: "Payment expires after 24h".length,
  },
  comments: [
    {
      id: "cmt-root-1",
      parentId: null,
      authorName: "Mara",
      body: "Why 24h and not 48h?",
      createdAt: new Date().toISOString(),
    },
  ],
};

let docResponse: unknown;
const fetchViewerDoc = mock(async () => docResponse);
const addComment = mock(async () => okEnv({ commentId: "cmt-real-reply-1" }));
const listAnnotations = mock(async () => okRead({ items: [baseThread] }));

function canComment(role: string | undefined) {
  return role !== "viewer";
}

mock.module("@/features/viewer/services/client", () => ({
  createRedline: mock(async () => okEnv({ suggestionId: "rl-x" })),
  decideSuggestion: mock(async () => okEnv({ status: "accepted" })),
  fetchViewerDoc,
  listAnnotations,
  createAnnotation: mock(async () => okEnv({ annotationId: "a" })),
  addComment,
  setResolution: mock(async () => okEnv({ status: "resolved" })),
  deleteAnnotation: mock(async () => okEnv({ deleted: true })),
  restoreAnnotation: mock(async () => okEnv({ restored: true })),
  dismissAnnotation: mock(async () => okEnv({ dismissed: true })),
  reattachAnnotation: mock(async () => okEnv({ isOrphaned: false })),
  canComment,
}));

// bun mock.module is process-global; keep `session` swappable and reset to null after each test so a
// stray session never leaks into a later file (see memory bun-mockmodule-leak).
let session: { user: { email: string } } | null = null;
mock.module("@/lib/api/auth-client", () => ({
  useSession: () => ({ data: session, isPending: false }),
  signOut: mock(async () => ({ data: { success: true }, error: null })),
  authClient: {},
}));

const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }),
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

describe("Guest reply carries the session name (regression)", () => {
  beforeEach(() => {
    fetchViewerDoc.mockClear();
    addComment.mockClear();
    listAnnotations.mockClear();
    toastError.mockClear();
    session = null; // logged-out guest
    try {
      window.sessionStorage.removeItem("anchord.guest-name");
    } catch {
      /* storage unavailable — the hook falls back to in-memory */
    }
    // anyone_with_link + commenter → the FE guest flag is set (a logged-out commenter is a guest).
    docResponse = okEnv({
      doc: {
        title: "Spec",
        kind: "markdown",
        version: 1,
        status: "live",
        generalAccess: "anyone_with_link",
        effectiveRole: "commenter",
        workspaceId: null,
      },
      content: MD,
    });
  });
  afterEach(() => {
    session = null;
  });

  it("a guest's reply POSTs addComment with guestName = the session chip name (not absent)", async () => {
    render(<App />);
    await screen.findByTestId("markdown-view");

    // The guest session identity is shown as the header chip; capture its name.
    const chipName = screen.getByTestId("guest-name").textContent?.trim() ?? "";
    expect(chipName.length).toBeGreaterThan(0);

    const card = await screen.findByTestId("thread-card");
    await userEvent.click(within(card).getByTestId("reply-open"));
    await userEvent.type(within(card).getByTestId("reply-input"), "Because the trial window is 24h.");
    await userEvent.click(within(card).getByTestId("reply-send"));

    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
    const [slug, annotationId, body] = addComment.mock.calls[0]! as [string, string, Record<string, unknown>];
    expect(slug).toBe("my-doc");
    expect(annotationId).toBe("anno-1");
    expect(body).toMatchObject({ body: "Because the trial window is 24h.", parentId: "cmt-root-1" });
    // The bug: the reply omitted the name → the server 400'd ("guestName is required"). The guest
    // reply MUST carry the session chip name, exactly like the composer + redline guest writes do.
    expect(body.guestName).toBe(chipName);
    expect(typeof body.guestName).toBe("string");
    expect((body.guestName as string).length).toBeGreaterThan(0);
  });
});
