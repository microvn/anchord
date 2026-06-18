import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core-ui S-004 — Manage detached annotations: view, dismiss, re-attach.
//
// The detached SECTION + count already exist (S-003 / AS-011). This file's DELTA is the actions:
//   AS-011: each detached card now carries Re-attach + Dismiss actions (commenter+).
//   AS-016: clicking Dismiss calls the workspace-scoped dismiss route + the annotation leaves the
//           detached section optimistically (the rail count / "showing X of N" total drops); the
//           dismissed row is excluded from the active read, so it does not reappear on reload.
//   AS-017: choosing Re-attach arms the next text selection; the selection's anchor is sent to the
//           reattach route + on success the annotation flips isOrphaned=false with the new anchor —
//           it moves out of the detached section into the anchored thread list with a highlight.
//
// The flow spans the rail card → viewer-screen handlers → useCompose selection intercept → the
// react-query cache, so it's driven through the whole ViewerScreen (like redline.test.tsx). The
// in-doc highlight redraw after re-attach is the existing placer's job — we assert the cache/state
// transition at the component boundary (isOrphaned false + moved out of detached + an anchored card).

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

// block-p-4 carries the sentence the AS-017 re-attach selects ("onboarding copy block").
const MD = `
<p data-block-id="block-p-1">Payment expires after 24h unless the subscription is renewed.</p>
<p data-block-id="block-p-4">This v3 onboarding copy block was rewritten later.</p>
`;

const comment = (id: string, body: string, author = "Tom Becker") => ({
  id,
  parentId: null,
  authorName: author,
  body,
  createdAt: new Date().toISOString(),
});

function makeAnnotation(over: Record<string, unknown>) {
  return {
    id: "a1",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    comments: [comment("c1", "A comment")],
    anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17, segments: [] },
    ...over,
  };
}

let docResponse: unknown;
let annoResponse: unknown;
let dismissResult: unknown;
let reattachResult: unknown;

const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => annoResponse);
const dismissAnnotation = mock(async () => dismissResult);
const reattachAnnotation = mock(async () => reattachResult);

mock.module("@/features/viewer/services/client", () => ({
  fetchViewerDoc,
  listAnnotations,
  createAnnotation: mock(async () => okEnv({ annotationId: "a" })),
  addComment: mock(async () => okEnv({ commentId: "c" })),
  setResolution: mock(async () => okEnv({ status: "resolved" })),
  createRedline: mock(async () => okEnv({ suggestionId: "rl-x" })),
  decideSuggestion: mock(async () => okEnv({ status: "accepted" })),
  deleteAnnotation: mock(async () => okEnv({ deleted: true })),
  restoreAnnotation: mock(async () => okEnv({ restored: true })),
  dismissAnnotation,
  reattachAnnotation,
  canComment: (role: string | undefined) => role !== "viewer",
}));

const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }),
  Toaster: () => null,
}));

// The dismiss/reattach routes are member-only (workspace-scoped) — a signed-in session makes the
// viewer source the workspaceId from the read response (memberWorkspaceId). bun's mock.module is
// process-global; reset `session` to null after each test so it doesn't leak. See bun-mockmodule-leak.
let session: { user: { email: string; id: string; name: string } } | null = null;
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

beforeEach(() => {
  fetchViewerDoc.mockClear();
  listAnnotations.mockClear();
  dismissAnnotation.mockClear();
  reattachAnnotation.mockClear();
  toastError.mockClear();
  session = { user: { email: "me@b.co", id: "me-user", name: "Me" } }; // signed-in member → memberWorkspaceId
  docResponse = okEnv({
    doc: {
      title: "Spec",
      kind: "markdown",
      version: 4,
      status: "live",
      generalAccess: "restricted",
      effectiveRole: "commenter",
      workspaceId: "ws-1",
    },
    content: MD,
  });
  // 1 detached of 2 (AS-016/017 use a single detached; AS-011 data note is 1-of-4 — the ratio is not
  // load-bearing, the section + count + actions are).
  annoResponse = okRead({
    items: [
      makeAnnotation({ id: "a1", anchor: { blockId: "block-p-1", textSnippet: "expires after 24h", offset: 8, length: 17 } }),
      makeAnnotation({
        id: "d1",
        isOrphaned: true,
        anchor: { blockId: "block-p-4", textSnippet: "onboarding copy", offset: 8, length: 15 },
        comments: [comment("c9", "Does this still apply after v4?")],
      }),
    ],
  });
  dismissResult = okEnv({ dismissed: true });
  reattachResult = okEnv({ isOrphaned: false });
});

afterEach(() => {
  session = null;
});

describe("Detached management (S-004, through ViewerScreen)", () => {
  it("AS-011: a detached card carries Re-attach + Dismiss actions (commenter+), with its quote + body", async () => {
    await renderViewer();

    const section = screen.getByTestId("detached-section");
    expect(within(section).getByTestId("detached-count")).toHaveTextContent("1 detached");
    const card = within(section).getByTestId("detached-card");
    // The detached card shows its quote + body...
    expect(card).toHaveTextContent("onboarding copy");
    expect(card).toHaveTextContent("Does this still apply after v4?");
    // ...AND the two actions (the S-004 delta over S-003's display-only card).
    expect(within(card).getByTestId("detached-reattach")).toBeInTheDocument();
    expect(within(card).getByTestId("detached-dismiss")).toBeInTheDocument();
    // It is NOT an anchored thread and has NO in-text highlight (C-004).
    expect(screen.getByTestId("annotations-rail").querySelector('[data-anno-thread="d1"]')).toBeNull();
    expect(screen.getByTestId("markdown-view").querySelector('[data-anno="d1"]')).toBeNull();
  });

  it("AS-011 / C-004: a viewer-only role gets a display-only detached card (no actions)", async () => {
    docResponse = okEnv({
      doc: { title: "Spec", kind: "markdown", version: 4, status: "live", generalAccess: "restricted", effectiveRole: "viewer", workspaceId: "ws-1" },
      content: MD,
    });
    await renderViewer();
    const card = within(screen.getByTestId("detached-section")).getByTestId("detached-card");
    expect(card).toHaveTextContent("onboarding copy"); // still shown
    expect(within(card).queryByTestId("detached-reattach")).toBeNull();
    expect(within(card).queryByTestId("detached-dismiss")).toBeNull();
  });

  it("AS-016: clicking Dismiss calls the dismiss route and the annotation leaves the detached section + the total drops", async () => {
    await renderViewer();

    // Two annotations total: 1 anchored ("showing"/total reads 1 for the anchored set) + 1 detached.
    expect(screen.getByTestId("detached-count")).toHaveTextContent("1 detached");
    const card = within(screen.getByTestId("detached-section")).getByTestId("detached-card");

    await userEvent.click(within(card).getByTestId("detached-dismiss"));

    // The workspace-scoped dismiss route was called for THIS annotation.
    await waitFor(() => expect(dismissAnnotation).toHaveBeenCalledTimes(1));
    const [ws, id] = dismissAnnotation.mock.calls[0]!;
    expect(ws).toBe("ws-1");
    expect(id).toBe("d1");

    // Optimistically it leaves the detached section — the section disappears (no detached left).
    await waitFor(() => expect(screen.queryByTestId("detached-section")).toBeNull());
    expect(screen.getByTestId("annotations-rail").querySelector('[data-anno-detached="d1"]')).toBeNull();
    // The anchored thread is untouched.
    expect(screen.getByTestId("annotations-rail").querySelector('[data-anno-thread="a1"]')).not.toBeNull();
    // No error toast on a successful dismiss.
    expect(toastError).not.toHaveBeenCalled();
  });

  it("AS-016: a refused dismiss rolls back — the detached card re-appears + an error is shown", async () => {
    dismissResult = { data: null, error: { status: 403, value: { success: false } } };
    await renderViewer();

    await userEvent.click(within(screen.getByTestId("detached-section")).getByTestId("detached-dismiss"));

    await waitFor(() => expect(dismissAnnotation).toHaveBeenCalledTimes(1));
    // Rolled back: the detached card is back (no silent loss).
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]![0]).toMatch(/couldn't dismiss/i);
    expect(screen.getByTestId("detached-section")).toBeInTheDocument();
    expect(screen.getByTestId("detached-count")).toHaveTextContent("1 detached");
  });

  it("AS-017: Re-attach onto a selected range moves the annotation out of detached into an anchored thread + highlight", async () => {
    await renderViewer();

    // Arm re-attach for the detached annotation.
    const card = within(screen.getByTestId("detached-section")).getByTestId("detached-card");
    await userEvent.click(within(card).getByTestId("detached-reattach"));
    // The card reads as armed (awaiting a selection).
    await waitFor(() =>
      expect(
        screen.getByTestId("annotations-rail").querySelector('[data-anno-detached="d1"]')!.getAttribute("data-reattach-pending"),
      ).toBe("true"),
    );

    // Select a sentence in block 4 (the current version) → the captured anchor is sent to reattach.
    selectPhrase("block-p-4", "onboarding copy block");

    await waitFor(() => expect(reattachAnnotation).toHaveBeenCalledTimes(1));
    const [ws, id, anchor] = reattachAnnotation.mock.calls[0]!;
    expect(ws).toBe("ws-1");
    expect(id).toBe("d1");
    expect(anchor.blockId).toBe("block-p-4");
    expect(anchor.textSnippet).toBe("onboarding copy block");

    // It leaves the detached section (isOrphaned → false in the cache)...
    await waitFor(() => expect(screen.queryByTestId("detached-section")).toBeNull());
    // ...and becomes an anchored thread with a highlight on the NEW range.
    await waitFor(() =>
      expect(screen.getByTestId("annotations-rail").querySelector('[data-anno-thread="d1"]')).not.toBeNull(),
    );
    const mark = screen.getByTestId("markdown-view").querySelector('[data-anno="d1"]') as HTMLElement | null;
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe("onboarding copy block");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("AS-017: a refused (400 anchor-mismatch) re-attach keeps it detached + shows an error", async () => {
    reattachResult = { data: null, error: { status: 400, value: { success: false } } };
    await renderViewer();

    await userEvent.click(within(screen.getByTestId("detached-section")).getByTestId("detached-reattach"));
    selectPhrase("block-p-4", "onboarding copy block");

    await waitFor(() => expect(reattachAnnotation).toHaveBeenCalledTimes(1));
    // Stays detached (no silent move), error surfaced, no anchored thread/highlight created.
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]![0]).toMatch(/couldn't re-attach/i);
    expect(screen.getByTestId("detached-section")).toBeInTheDocument();
    expect(screen.getByTestId("annotations-rail").querySelector('[data-anno-thread="d1"]')).toBeNull();
    expect(screen.getByTestId("markdown-view").querySelector('[data-anno="d1"]')).toBeNull();
  });
});
