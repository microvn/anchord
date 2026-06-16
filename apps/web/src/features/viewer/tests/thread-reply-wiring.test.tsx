import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core-ui-commenting S-003 (WIRING) — Reply in a thread, end-to-end through the LIVE
// rail. thread-reply.test.tsx proves the ThreadCard's onReply CALLBACK in isolation; this proves the
// real app wires that callback to addComment. We render the whole ViewerScreen (client MOCKED), open
// a thread in the rail, click Reply, type, send, and assert:
//   - addComment was called with { body, parentId } (parentId = the annotation's first/root comment),
//   - the reply appears FLAT under the thread (exactly one new reply, one reply-list level),
//   - PERF: the reply lands via a react-query CACHE APPEND (no post-write refetch) — listAnnotations
//     runs ONLY for the initial mount; a second call would be the old refetch regression.

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

const MD = `<p data-block-id="block-p-1">Payment expires after 24h unless renewed.</p>`;

const rootComment = {
  id: "cmt-root-1",
  parentId: null,
  authorName: "Mara",
  body: "Why 24h and not 48h?",
  createdAt: new Date().toISOString(),
};

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
  comments: [rootComment],
};

let docResponse: unknown;
const fetchViewerDoc = mock(async () => docResponse);
// PERF (no-refetch reconcile): the reply is appended FLAT into the react-query cache from the
// server-returned commentId — there is NO post-write refetch. listAnnotations therefore serves only
// the initial mount (the thread with its root comment); the real reply appears purely from the cache
// append. A second listAnnotations call would be the old refetch regression.
const addComment = mock(async () => okEnv({ commentId: "cmt-real-reply-1" }));
const listAnnotations = mock(async () => okRead({ items: [baseThread] }));

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
  createAnnotation: mock(async () => okEnv({ annotationId: "a" })),
  addComment,
  setResolution: mock(async () => okEnv({ status: "resolved" })),
  deleteAnnotation: mock(async () => okEnv({ deleted: true })),
  restoreAnnotation: mock(async () => okEnv({ restored: true })),
  canComment,
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
      <MemoryRouter initialEntries={["/w/ws-1/d/my-doc"]}>
        <Routes>
          <Route path="/w/:workspaceId/d/:slug" element={<ViewerScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** Count nesting depth of reply-list containers — flat means exactly one level. */
function maxReplyListDepth(): number {
  const lists = screen.queryAllByTestId("reply-list");
  let max = 0;
  for (const list of lists) {
    let depth = 1;
    let parent = list.parentElement;
    while (parent) {
      if (parent.getAttribute("data-testid") === "reply-list") depth += 1;
      parent = parent.parentElement;
    }
    max = Math.max(max, depth);
  }
  return max;
}

beforeEach(() => {
  fetchViewerDoc.mockClear();
  addComment.mockClear();
  listAnnotations.mockClear();
  toastError.mockClear();
  docResponse = okEnv({
    doc: {
      title: "Spec",
      kind: "markdown",
      version: 1,
      status: "live",
      generalAccess: "restricted",
      effectiveRole: "commenter",
    },
    content: MD,
  });
});

describe("ViewerScreen reply wiring (S-003)", () => {
  it("AS-006: replying in the live rail calls addComment({ body, parentId }) and shows the reply flat", async () => {
    render(<App />);
    await screen.findByTestId("markdown-view");

    // The thread renders in the rail with its root comment and no replies yet.
    const card = await screen.findByTestId("thread-card");
    expect(within(card).getByText("Why 24h and not 48h?")).toBeInTheDocument();
    expect(within(card).queryAllByTestId("reply")).toHaveLength(0);

    // Open the inline reply, type, send.
    await userEvent.click(within(card).getByTestId("reply-open"));
    await userEvent.type(within(card).getByTestId("reply-input"), "Because the trial window is 24h.");
    await userEvent.click(within(card).getByTestId("reply-send"));

    // LIVE WIRING: addComment is called against THIS annotation with the typed body + parentId =
    // the annotation's first/root comment (flat-reply parent), not the bare callback.
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
    // S-003: addComment is now (slug, annotationId, body) — no workspace segment (doc-addressed).
    const [slug, annotationId, body] = addComment.mock.calls[0]!;
    expect(slug).toBe("my-doc");
    expect(annotationId).toBe("anno-1");
    expect(body).toMatchObject({ body: "Because the trial window is 24h.", parentId: "cmt-root-1" });

    // The reply appears flat under the thread: exactly ONE reply row at one nesting level — appended
    // into the cache as a sibling of the root comment (no duplicate-on-success).
    await waitFor(() => {
      const live = screen.getByTestId("thread-card");
      expect(within(live).getAllByTestId("reply")).toHaveLength(1);
    });
    const live = screen.getByTestId("thread-card");
    expect(within(live).getByText("Because the trial window is 24h.")).toBeInTheDocument();
    expect(maxReplyListDepth()).toBe(1);
    // No error toast on the success path.
    expect(toastError).not.toHaveBeenCalled();
    // PERF: NO post-write refetch — listAnnotations ran ONLY for the initial mount; the reply landed
    // via the cache append. A second call would be the old refetch regression.
    expect(listAnnotations).toHaveBeenCalledTimes(1);
  });
});
