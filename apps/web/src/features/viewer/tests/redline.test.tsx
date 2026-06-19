import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core-ui-types-modes S-002 — Redline: strike a selection as a deletion proposal.
//
// Two test surfaces, both deterministic:
//   1. ThreadCard (rendered directly): the DELETE badge + the owner-only Accept/Reject row that
//      auto-resolves (AS-004 card / AS-005 / AS-006), the STALE state that blocks accept (AS-007),
//      and the owner-vs-non-owner Reopen of a decided redline (AS-008).
//   2. ViewerScreen (the create flow): select → Redline → optimistic red strike + DELETE card + a
//      real workspace-scoped createRedline + root comment (AS-004 create); a refused write rolls the
//      optimistic strike + card back (AS-009 / C-007.T1).
//
// C-002: a redline NEVER edits the doc content; the OWNER decides; a drifted redline is STALE and
// cannot be accepted; reopening a DECIDED redline is owner-only → pending.

import { ThreadCard } from "@/features/viewer/components/thread-card";
import { AnnotationsRail } from "@/features/viewer/components/annotations-rail";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

function redline(overrides: Partial<ViewerAnnotation> = {}): ViewerAnnotation {
  return {
    id: "rl-1",
    type: "suggestion",
    status: "unresolved",
    isOrphaned: false,
    anchor: { blockId: "block-h1", textSnippet: "Implementation Plan: Real-time Collaboration", offset: 0, length: 44 },
    suggestion: { kind: "delete", from: "Implementation Plan: Real-time Collaboration", againstVersion: 4 },
    suggestionStatus: "pending",
    comments: [
      { id: "rl-1-c", parentId: null, authorName: "Mara", body: "Suggested deletion", createdAt: new Date().toISOString() },
    ],
    ...overrides,
  };
}

// AS-020 / C-003: the owner-decide row is withheld until the session resolves (currentUserId known).
// An owner is always signed in, so these owner-decide cases model a RESOLVED session by defaulting a
// currentUserId. The redline() fixture has no authorId, so isOwn stays false → still owner-decided.
function renderCard(annotation: ViewerAnnotation, props: Partial<Parameters<typeof ThreadCard>[0]> = {}) {
  return render(
    <ThreadCard
      annotation={annotation}
      focused={false}
      unplaceable={false}
      onFocus={() => {}}
      currentUserId="owner-user"
      {...props}
    />,
  );
}

describe("Redline ThreadCard (S-002)", () => {
  it("AS-004: a pending redline renders a DELETE type badge with the struck quote", () => {
    renderCard(redline(), { onDecide: mock(async () => true) });
    const card = screen.getByTestId("thread-card");
    // The DELETE type badge marks it a deletion proposal (not a plain comment).
    expect(within(card).getByTestId("type-badge-delete")).toHaveTextContent(/delete/i);
    // The quote (the span proposed for deletion) is shown.
    expect(card).toHaveTextContent("Implementation Plan: Real-time Collaboration");
    // No accepted/rejected/stale outcome yet.
    expect(within(card).queryByTestId("redline-accepted-badge")).toBeNull();
    expect(within(card).queryByTestId("redline-stale-badge")).toBeNull();
  });

  it("AS-005: the OWNER accepting a pending redline auto-resolves the thread (dimmed)", async () => {
    // S-002 (C-002): Accept/Reject is the OWNER's proposal close family — gated on isOwner now, not
    // on onDecide presence alone (the 2-family reversal: a proposal is owner-decided, not resolved).
    const onDecide = mock(async () => true);
    renderCard(redline(), { onDecide, isOwner: true });

    const card = screen.getByTestId("thread-card");
    expect(card.getAttribute("data-resolved")).toBeNull();
    // The owner sees Accept / Reject.
    await userEvent.click(within(card).getByTestId("redline-accept"));

    // onDecide("accept") was called.
    await waitFor(() => expect(onDecide).toHaveBeenLastCalledWith("accept"));
    // Deciding auto-resolves: the card dims (data-resolved) — the spec's "thread becomes resolved".
    // One-pill locked design: the close shows as the DIM (data-resolved), NOT a separate Resolved
    // pill — a decided proposal carries only its outcome status, never an extra Resolved chip.
    await waitFor(() => {
      expect(screen.getByTestId("thread-card").getAttribute("data-resolved")).toBe("true");
    });
    expect(within(screen.getByTestId("thread-card")).queryByTestId("resolved-badge")).toBeNull();
  });

  it("AS-006: the OWNER rejecting a pending redline auto-resolves the thread (dimmed)", async () => {
    const onDecide = mock(async () => true);
    renderCard(redline(), { onDecide, isOwner: true });

    await userEvent.click(within(screen.getByTestId("thread-card")).getByTestId("redline-reject"));

    await waitFor(() => expect(onDecide).toHaveBeenLastCalledWith("reject"));
    await waitFor(() => {
      expect(screen.getByTestId("thread-card").getAttribute("data-resolved")).toBe("true");
    });
    // One-pill locked design: the close shows as the DIM (data-resolved), NOT a separate Resolved
    // pill — a decided proposal carries only its outcome status, never an extra Resolved chip.
    expect(within(screen.getByTestId("thread-card")).queryByTestId("resolved-badge")).toBeNull();
  });

  it("AS-004 / C-002: a non-owner (no onDecide) gets NO Accept/Reject row", () => {
    renderCard(redline()); // no onDecide → not an owner
    const card = screen.getByTestId("thread-card");
    expect(within(card).queryByTestId("redline-decide")).toBeNull();
    expect(within(card).queryByTestId("redline-accept")).toBeNull();
    // It still reads as a DELETE proposal.
    expect(within(card).getByTestId("type-badge-delete")).toBeInTheDocument();
  });

  it("AS-007: a STALE redline shows the stale badge and offers NO Accept (cannot be accepted)", () => {
    // Even with an owner onDecide supplied, a drifted (stale) redline is not pending → no Accept/Reject.
    renderCard(redline({ suggestionStatus: "stale" }), { onDecide: mock(async () => true), isOwner: true });
    const card = screen.getByTestId("thread-card");
    expect(within(card).getByTestId("redline-stale-badge")).toHaveTextContent(/stale/i);
    expect(within(card).queryByTestId("redline-accept")).toBeNull();
    expect(within(card).queryByTestId("redline-decide")).toBeNull();
  });

  it("AS-008: the OWNER can Reopen a decided (accepted) redline; a non-owner cannot", async () => {
    // A decided (accepted) redline is resolved. The owner gets a Reopen control (onResolve supplied,
    // gated commenter+; the backend makes the decided-reopen owner-only + resets to pending). A
    // non-owner viewing the SAME decided redline with no onResolve gets no Reopen control.
    // S-002 (C-002): a decided proposal's Reopen is the OWNER's close family — gated on isOwner now.
    const onResolve = mock(async () => true);
    const { rerender } = renderCard(
      redline({ status: "resolved", suggestionStatus: "accepted" }),
      { onResolve, isOwner: true },
    );
    const card = screen.getByTestId("thread-card");
    const reopen = within(card).getByTestId("resolve-toggle");
    expect(reopen).toHaveTextContent("Reopen");
    await userEvent.click(reopen);
    await waitFor(() => expect(onResolve).toHaveBeenLastCalledWith(false));

    // A non-owner / read-only viewer (no onResolve) → no Reopen control at all.
    rerender(
      <ThreadCard
        annotation={redline({ status: "resolved", suggestionStatus: "accepted" })}
        focused={false}
        unplaceable={false}
        onFocus={() => {}}
      />,
    );
    expect(within(screen.getByTestId("thread-card")).queryByTestId("resolve-toggle")).toBeNull();
  });

  it("AS-005: a refused/stale decide rolls the optimistic resolve back (card stays unresolved)", async () => {
    // onDecide resolves false (refused or 409 stale). The card optimistically dimmed, then must revert.
    const onDecide = mock(async () => false);
    renderCard(redline(), { onDecide, isOwner: true });
    await userEvent.click(within(screen.getByTestId("thread-card")).getByTestId("redline-accept"));
    await waitFor(() => expect(onDecide).toHaveBeenCalled());
    // The optimistic resolve rolls back — the card is NOT left dimmed on a refused decide.
    await waitFor(() => {
      expect(screen.getByTestId("thread-card").getAttribute("data-resolved")).toBeNull();
    });
  });
});

describe("Redline rail wiring (S-002)", () => {
  it("AS-005: the live rail binds onDecide per-thread down to a real decide consumer", async () => {
    // Mirrors viewer-screen's useAnnotations onDecide shape: decide → auto-resolve in the served list.
    const decideSuggestion = mock(async (_ws: string, _id: string, _b: { decision: string }) => ({
      data: { success: true, data: { status: "accepted" } },
      error: null,
    }));
    const served = [redline()];
    const onDecide = async (annotation: ViewerAnnotation, decision: "accept" | "reject") => {
      const res = await decideSuggestion("ws-1", annotation.id, { decision });
      if (res.error) return false;
      const i = served.findIndex((a) => a.id === annotation.id);
      if (i >= 0) served[i] = { ...served[i]!, status: "resolved", suggestionStatus: "accepted" };
      return true;
    };

    render(
      <AnnotationsRail
        annotations={served}
        focusedId={null}
        unplaceableIds={new Set()}
        currentUserId="owner-user"
        isOwner
        onFocusThread={() => {}}
        onDecide={onDecide}
      />,
    );

    await userEvent.click(within(await screen.findByTestId("thread-card")).getByTestId("redline-accept"));
    await waitFor(() => expect(decideSuggestion).toHaveBeenCalledTimes(1));
    const [ws, id, body] = decideSuggestion.mock.calls[0]!;
    expect(ws).toBe("ws-1");
    expect(id).toBe("rl-1");
    expect(body).toEqual({ decision: "accept" });
  });
});

// ── The create flow through the whole ViewerScreen (AS-004 create + AS-009 rollback) ──

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

const MD = `<h1 data-block-id="block-h1">Implementation Plan: Real-time Collaboration</h1>`;

let docResponse: unknown;
let redlineResult: unknown;

const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => okRead({ items: [] }));
// C-018: a redline now rides the SAME doc-addressed unified create as a comment (the standalone
// workspace-scoped suggestion route is subsumed). `createAnnotation` is driven by `redlineResult`
// so the existing refused/ok cases still apply; `addComment` stays for replies and must NOT fire.
const createAnnotation = mock(async () => redlineResult);
const addComment = mock(async () => okEnv({ commentId: "rl-cmt-1" }));

function canComment(role: string | undefined) {
  return role !== "viewer";
}

mock.module("@/features/viewer/services/client", () => ({
  fetchViewerDoc,
  listAnnotations,
  createAnnotation,
  addComment,
  setResolution: mock(async () => okEnv({ status: "resolved" })),
  createRedline: mock(async () => okEnv({ suggestionId: "rl-x" })),
  decideSuggestion: mock(async () => okEnv({ status: "accepted" })),
  deleteAnnotation: mock(async () => okEnv({ deleted: true })),
  restoreAnnotation: mock(async () => okEnv({ restored: true })),
  dismissAnnotation: mock(async () => okEnv({ dismissed: true })),
  reattachAnnotation: mock(async () => okEnv({ isOrphaned: false })),
  canComment,
}));

const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }),
  Toaster: () => null,
}));

// The redline create + decide are member-only (workspace-scoped). A signed-in session makes the
// viewer source the workspaceId from the read response (memberWorkspaceId). bun's mock.module is
// process-global; we reset `session` to null after each test (runtime reset) so it doesn't leak a
// stray signed-in session into later files. See memory bun-mockmodule-leak.
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

describe("Redline create flow (S-002, through ViewerScreen)", () => {
  beforeEach(() => {
    fetchViewerDoc.mockClear();
    listAnnotations.mockClear();
    createAnnotation.mockClear();
    addComment.mockClear();
    toastError.mockClear();
    session = { user: { email: "owner@b.co" } }; // signed-in owner → effective owner role resolves
    // A signed-in OWNER. The redline now rides the doc-addressed unified create (C-018) — the
    // workspaceId is no longer required for it, but a member doc still carries one.
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
    // C-018: the unified create returns the annotation id + the atomic first-comment id.
    redlineResult = okEnv({ annotationId: "rl-real-1", commentId: "rl-cmt-1" });
  });

  // Reset the shared signed-in session so it doesn't leak into later files (bun mock.module is
  // process-global). See memory bun-mockmodule-leak.
  afterEach(() => {
    session = null;
  });

  it("AS-004: select → Redline creates a delete-kind proposal + root comment, a red strike, a DELETE card, content unchanged", async () => {
    await renderViewer();
    const view = screen.getByTestId("markdown-view");
    const originalText = view.querySelector("#block-h1, [data-block-id='block-h1']")!.textContent;

    selectPhrase("block-h1", "Implementation Plan: Real-time Collaboration");
    const popover = await screen.findByTestId("selection-popover");
    await userEvent.click(within(popover).getByTestId("popover-redline"));

    // AS-004.T1 (C-018): ONE doc-addressed unified create carries the delete-kind suggestion AND its
    // root comment — `to` omitted (→ delete), `from` = the struck quote, pinned againstVersion = the
    // doc version. There is no separate workspace-scoped suggestion call and no second addComment.
    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    const [slugArg, body] = createAnnotation.mock.calls[0]!;
    expect(slugArg).toBe("my-doc");
    // Regression: the FE sent `type:"suggestion"` in the create REQUEST, which the server
    // createAnnotationSchema rejects (enum range|multi_range|block|doc) → 400, so no redline could
    // be created. The request `type` is the ANCHOR shape; the server DERIVES type="suggestion" from
    // the `suggestion` payload. So the body must carry a server-valid type (or omit it), never "suggestion".
    expect(["range", "multi_range", "block", "doc", undefined]).toContain(body.type);
    expect(body.suggestion.from).toBe("Implementation Plan: Real-time Collaboration");
    expect((body.suggestion as { to?: unknown }).to).toBeUndefined(); // delete-kind → no `to`
    expect(body.suggestion.againstVersion).toBe(4);
    // AS-004.T2: its root comment rides the SAME create call (atomic); addComment is NOT used here.
    expect(body.comment.body).toBeString();
    expect(addComment).not.toHaveBeenCalled();

    // AS-004.T3: the text renders a RED STRIKE (a redline-kind mark), not a teal highlight.
    await waitFor(() => {
      const mark = view.querySelector('[data-anno="rl-real-1"]') as HTMLElement | null;
      expect(mark).not.toBeNull();
      expect(mark!.dataset.annoKind).toBe("redline");
    });

    // AS-004.T4: a rail card shows the DELETE badge with the quote.
    const card = (await screen.findAllByTestId("thread-card"))[0]!;
    expect(within(card).getByTestId("type-badge-delete")).toBeInTheDocument();
    expect(card).toHaveTextContent("Implementation Plan: Real-time Collaboration");

    // AS-004.T5 / C-002: the doc CONTENT does not change — the struck text is still present.
    expect(view.querySelector("#block-h1, [data-block-id='block-h1']")!.textContent).toBe(originalText);
  });

  it("an OWNER's created redline is born ACCEPTED, not pending (the owner has edit authority over their own doc)", async () => {
    // Owner/editor can make the change a proposal asks for, so their OWN proposal is born accepted —
    // the optimistic + reconciled rows must show the Accepted pill, never Pending (which would imply
    // it awaits a decision that isn't coming). Mirrors the backend createSuggestion auto-accept.
    await renderViewer();
    selectPhrase("block-h1", "Implementation Plan: Real-time Collaboration");
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-redline"));
    const card = (await screen.findAllByTestId("thread-card"))[0]!;
    await waitFor(() => expect(within(card).getByTestId("redline-accepted-badge")).toBeInTheDocument());
    expect(within(card).queryByTestId("redline-pending-badge")).toBeNull();
  });

  it("AS-009 / C-007.T1: a refused redline write rolls back the optimistic strike + card, shows an error, no ghost", async () => {
    redlineResult = { data: null, error: { status: 403, value: { success: false } } };
    await renderViewer();
    const view = screen.getByTestId("markdown-view");

    selectPhrase("block-h1", "Implementation Plan: Real-time Collaboration");
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-redline"));

    // The refused create rolls back: no thread card, no [data-anno] strike mark survives (no ghost).
    await waitFor(() => {
      expect(screen.queryAllByTestId("thread-card")).toHaveLength(0);
    });
    expect(view.querySelector("[data-anno]")).toBeNull();
    expect(screen.getByTestId("rail-empty")).toBeInTheDocument();
    // No comment write happened since the suggestion create was refused.
    expect(addComment).not.toHaveBeenCalled();
    // An error toast is shown.
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]![0]).toMatch(/couldn't create your redline/i);
  });
});
