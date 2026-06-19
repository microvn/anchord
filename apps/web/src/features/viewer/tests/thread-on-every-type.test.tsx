import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core-ui-types-modes S-005 — Threads + server-authorized writes on EVERY type.
//
// This is a REUSE/wiring story, not a new mechanism. Reply (commenting S-003) and resolve/reopen
// (S-004) are already built + wired in thread-card.tsx. Because every annotation now carries a root
// comment (C-003), the SAME onReply/onResolve apply to the new types (redline / label) unchanged.
// These tests PROVE that reuse + the FE side of the two server-authz guarantees:
//
//   1. ThreadCard (rendered directly):
//      - AS-016: a REDLINE thread takes a flat reply (one level, never nested deeper).
//      - AS-017: a LABEL thread resolves then reopens (dimmed ↔ unresolved), label line intact.
//      - C-005:  both types carry a flat-reply + resolve/reopen thread; a resolved thread is dimmed.
//   2. ViewerScreen / use-compose (the create boundary):
//      - AS-018: a viewer-only role has NO markup affordance (no popover → no create path); and a
//        create that is nonetheless refused server-side rolls back → no persisted annotation (the
//        affordance is a HINT, the server re-authorizes). FE-boundary per the spec's Backend note.
//      - AS-019: the FE never CO-EMITS label + suggestion. The labeled-create body carries `label`
//        and NO `suggestion`; the redline create carries the suggestion (`from`) and NO `label`. The
//        server-side BOTH-refusal is backend AS-029 — not rebuilt here.

import { ThreadCard } from "@/features/viewer/components/thread-card";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

// ── Surface 1: ThreadCard reuse on redline + label (AS-016 / AS-017 / C-005) ──

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

function labelAnno(overrides: Partial<ViewerAnnotation> = {}): ViewerAnnotation {
  return {
    id: "lb-1",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    label: "out-of-scope",
    anchor: { blockId: "block-scope", textSnippet: "wss://collab.plannotator.ai", offset: 0, length: 27 },
    comments: [
      { id: "lb-1-c", parentId: null, authorName: "Mara", body: "Out of scope", createdAt: new Date().toISOString() },
    ],
    ...overrides,
  };
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

describe("ThreadCard — threads on every type (S-005)", () => {
  it("AS-016: a reply on a redline thread shows flat under it (one level, never nested deeper)", async () => {
    // Given a redline thread (with its creator's root comment) and an onReply (the SAME callback the
    // commenting path supplies — reused unchanged because the redline has a root comment, C-003).
    const onReply = mock(async () => true);
    render(
      <ThreadCard
        annotation={redline()}
        focused={false}
        unplaceable={false}
        onFocus={() => {}}
        onReply={onReply}
      />,
    );

    // It still reads as a DELETE proposal — the reply affordance rides ON the redline card.
    const card = screen.getByTestId("thread-card");
    expect(within(card).getByTestId("type-badge-delete")).toBeInTheDocument();

    // Reply → type → send. Data: "Agree, the title is redundant".
    await userEvent.click(within(card).getByTestId("reply-open"));
    await userEvent.type(await screen.findByTestId("reply-input"), "Agree, the title is redundant");
    await userEvent.click(screen.getByTestId("reply-send"));

    // The redline's onReply got the typed body (consumer wires addComment({ body, parentId })).
    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));
    expect(onReply.mock.calls[0]![0]).toBe("Agree, the title is redundant");

    // The reply shows FLAT under the redline: exactly one reply row, one nesting level.
    await waitFor(() => expect(screen.getAllByTestId("reply")).toHaveLength(1));
    expect(screen.getByText("Agree, the title is redundant")).toBeInTheDocument();
    expect(maxReplyListDepth()).toBe(1);
  });

  it("AS-017: resolving then reopening a label thread toggles dimmed ↔ unresolved (label line intact)", async () => {
    // Given an UNRESOLVED label annotation with an onResolve (reused unchanged — the label carries a
    // root comment, so the existing resolve/reopen applies). Data: toggle twice.
    const onResolve = mock(async () => true);
    render(
      <ThreadCard
        annotation={labelAnno()}
        focused={false}
        unplaceable={false}
        onFocus={() => {}}
        onResolve={onResolve}
      />,
    );

    const card = screen.getByTestId("thread-card");
    // The label line is present and the thread starts unresolved.
    expect(within(card).getByTestId("label-line")).toHaveTextContent("Out of scope");
    expect(card.getAttribute("data-resolved")).toBeNull();
    const toggle = within(card).getByTestId("resolve-toggle");
    expect(toggle).toHaveTextContent("Resolve");

    // Resolve → the thread shows resolved (dimmed via data-resolved + Resolved badge, C-005).
    await userEvent.click(toggle);
    await waitFor(() => expect(onResolve).toHaveBeenLastCalledWith(true));
    await waitFor(() => {
      expect(screen.getByTestId("thread-card").getAttribute("data-resolved")).toBe("true");
    });
    expect(within(screen.getByTestId("thread-card")).getByTestId("resolved-badge")).toBeInTheDocument();
    // The label line survives the resolve (the type still reads as a label).
    expect(within(screen.getByTestId("thread-card")).getByTestId("label-line")).toHaveTextContent("Out of scope");

    // Reopen → back to unresolved: badge gone, flag cleared, action back to "Resolve".
    await userEvent.click(within(screen.getByTestId("thread-card")).getByTestId("resolve-toggle"));
    await waitFor(() => expect(onResolve).toHaveBeenLastCalledWith(false));
    await waitFor(() => {
      expect(screen.getByTestId("thread-card").getAttribute("data-resolved")).toBeNull();
    });
    expect(screen.queryByTestId("resolved-badge")).toBeNull();
    expect(onResolve).toHaveBeenCalledTimes(2); // toggled twice
  });

  it("C-005: both a redline and a label card carry a flat-reply thread; the close family is gated (S-002 2-family)", () => {
    // REVERSED by annotation-actions-ui S-002 (C-002): the original claim was "BOTH types expose the
    // SAME Reply + Resolve controls". S-002 collapses to the 2-family bar — Reply stays on every
    // family (a non-owner on a proposal gets reply only), but the CLOSE control is now family+
    // permission gated: a Remark (label) still offers Resolve to commenter+, while a Proposal
    // (redline) viewed by a non-owner offers NO Resolve (the owner gets Accept/Reject instead). So
    // the structural reuse claim holds for Reply, NOT for the close action.
    const onReply = mock(async () => true);
    const onResolve = mock(async () => true);

    // A redline (Proposal) for a NON-owner: Reply present, but NO resolve-toggle (reply only, C-002).
    const { rerender } = render(
      <ThreadCard annotation={redline()} focused={false} unplaceable={false} onFocus={() => {}} onReply={onReply} onResolve={onResolve} />,
    );
    let card = screen.getByTestId("thread-card");
    expect(within(card).getByTestId("reply-open")).toBeInTheDocument();
    expect(within(card).queryByTestId("resolve-toggle")).toBeNull();

    // A label (Remark): Reply present AND the Resolve toggle (Remark → Resolve/Reopen, commenter+).
    rerender(
      <ThreadCard annotation={labelAnno()} focused={false} unplaceable={false} onFocus={() => {}} onReply={onReply} onResolve={onResolve} />,
    );
    card = screen.getByTestId("thread-card");
    expect(within(card).getByTestId("reply-open")).toBeInTheDocument();
    expect(within(card).getByTestId("resolve-toggle")).toBeInTheDocument();
  });

  it("C-005: a resolved thread renders dimmed for a label type up-front (carried from the server)", () => {
    // An already-resolved label thread renders dimmed + Reopen on mount — the resolved-dimmed
    // invariant holds for the new types just as it does for comments.
    render(
      <ThreadCard
        annotation={labelAnno({ status: "resolved" })}
        focused={false}
        unplaceable={false}
        onFocus={() => {}}
        onResolve={mock(async () => true)}
      />,
    );
    const card = screen.getByTestId("thread-card");
    expect(card.getAttribute("data-resolved")).toBe("true");
    expect(within(card).getByTestId("resolved-badge")).toBeInTheDocument();
    expect(within(card).getByTestId("resolve-toggle")).toHaveTextContent("Reopen");
  });
});

// ── Surface 2: the create boundary through ViewerScreen (AS-018 / AS-019) ──

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

const MD = `<h1 data-block-id="block-h1">Implementation Plan: Real-time Collaboration</h1><p data-block-id="block-scope">Drop the wss://collab.plannotator.ai endpoint.</p>`;

let docResponse: unknown;
let annotationResult: unknown;
let redlineResult: unknown;

const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => okRead({ items: [] }));
// C-018: every create type (comment/like/label/redline) now rides the SAME doc-addressed
// createAnnotation. A redline carries a `suggestion` payload; the mock routes to `redlineResult`
// when it does, else `annotationResult`. createRedline stays a stub (its route is subsumed).
const createAnnotation = mock(async (_slug: string, body: { suggestion?: unknown }) =>
  body?.suggestion != null ? redlineResult : annotationResult,
);
const createRedline = mock(async () => redlineResult);
const addComment = mock(async () => okEnv({ commentId: "cmt-1" }));

function canComment(role: string | undefined) {
  return role !== "viewer";
}

mock.module("@/features/viewer/services/client", () => ({
  fetchViewerDoc,
  listAnnotations,
  createAnnotation,
  addComment,
  setResolution: mock(async () => okEnv({ status: "resolved" })),
  createRedline,
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

// bun mock.module is process-global; reset `session` to null after each test so a signed-in session
// doesn't leak into later files (memory bun-mockmodule-leak).
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

describe("Create boundary — server-authorized writes on every type (S-005)", () => {
  beforeEach(() => {
    fetchViewerDoc.mockClear();
    listAnnotations.mockClear();
    createAnnotation.mockClear();
    createRedline.mockClear();
    addComment.mockClear();
    toastError.mockClear();
    annotationResult = okEnv({ annotationId: "a-real-1", commentId: "a-cmt-1" });
    // C-018: a redline now returns the annotation id + atomic first-comment id (unified create).
    redlineResult = okEnv({ annotationId: "rl-real-1", commentId: "rl-cmt-1" });
  });

  afterEach(() => {
    session = null;
  });

  it("AS-018: a viewer-only role gets no markup affordance, so no create path is reachable (server re-authz is the boundary)", async () => {
    // A viewer-only effective role: canCompose=false → the selection listener is never attached, so a
    // selection raises NO popover and NO type-create can be issued from the client. The affordance is
    // a hint; the server re-authorizes regardless.
    session = { user: { email: "viewer@b.co" } };
    docResponse = okEnv({
      doc: { title: "Spec", kind: "markdown", version: 4, status: "live", generalAccess: "restricted", effectiveRole: "viewer", workspaceId: "ws-1" },
      content: MD,
    });
    await renderViewer();

    selectPhrase("block-h1", "Implementation Plan: Real-time Collaboration");
    await Promise.resolve();

    // No popover → no Like/Label/Redline create path; nothing was sent.
    expect(screen.queryByTestId("selection-popover")).toBeNull();
    expect(createAnnotation).not.toHaveBeenCalled();
    expect(createRedline).not.toHaveBeenCalled();
    expect(screen.getByTestId("rail-empty")).toBeInTheDocument();
  });

  it("AS-018: a create that is nonetheless refused server-side rolls back — no persisted annotation, no ghost", async () => {
    // The other half of the FE boundary: even if a create IS issued (an over-permissive hint), a
    // server refusal (the real re-authz) rolls the optimistic mark + row back — no persisted
    // annotation survives client-side. Modelled as a commenter whose redline create is refused 403.
    session = { user: { email: "owner@b.co" } };
    docResponse = okEnv({
      doc: { title: "Spec", kind: "markdown", version: 4, status: "live", generalAccess: "restricted", effectiveRole: "owner", workspaceId: "ws-1" },
      content: MD,
    });
    redlineResult = { data: null, error: { status: 403, value: { success: false } } };
    await renderViewer();
    const view = screen.getByTestId("markdown-view");

    selectPhrase("block-h1", "Implementation Plan: Real-time Collaboration");
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-redline"));

    // The refused create rolls back: no thread card, no [data-anno] strike mark survives (no ghost).
    await waitFor(() => expect(screen.queryAllByTestId("thread-card")).toHaveLength(0));
    expect(view.querySelector("[data-anno]")).toBeNull();
    expect(screen.getByTestId("rail-empty")).toBeInTheDocument();
    expect(addComment).not.toHaveBeenCalled();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });

  it("AS-019: the labeled-create flow emits `label` and NO `suggestion` (label + suggestion never co-emit)", async () => {
    // A Label create rides the doc-scoped createAnnotation carrying the preset id; it carries NO
    // suggestion payload. The two are separate flows — the FE can never co-emit both in one create.
    session = { user: { email: "mara@b.co" } };
    docResponse = okEnv({
      doc: { title: "Spec", kind: "markdown", version: 4, status: "live", generalAccess: "restricted", effectiveRole: "commenter", workspaceId: "ws-1" },
      content: MD,
    });
    await renderViewer();

    selectPhrase("block-scope", "wss://collab.plannotator.ai");
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-label"));
    const picker = await screen.findByTestId("label-picker");
    await userEvent.click(within(picker).getByTestId("label-option-out-of-scope"));
    await userEvent.click(await screen.findByTestId("composer-send"));

    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    const [, body] = createAnnotation.mock.calls[0]!;
    const sent = body as { label?: unknown; suggestion?: unknown };
    // Carries the label …
    expect(sent.label).toBe("out-of-scope");
    // … and NO suggestion payload (mutually exclusive at the create boundary — C-003).
    expect(sent.suggestion).toBeUndefined();
    // The labeled-create did NOT route through the redline/suggestion create path.
    expect(createRedline).not.toHaveBeenCalled();
  });

  it("AS-019: the redline create flow emits the suggestion (`from`) and NO `label`", async () => {
    // C-018: a Redline now rides the SAME doc-addressed createAnnotation, carrying a `suggestion`
    // payload (`from`, delete-kind via omitted `to`) and NO label. The complementary half of the
    // never-co-emit guarantee — the redline path is label-free. (createRedline is subsumed.)
    session = { user: { email: "owner@b.co" } };
    docResponse = okEnv({
      doc: { title: "Spec", kind: "markdown", version: 4, status: "live", generalAccess: "restricted", effectiveRole: "owner", workspaceId: "ws-1" },
      content: MD,
    });
    await renderViewer();

    selectPhrase("block-h1", "Implementation Plan: Real-time Collaboration");
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-redline"));

    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    const [, body] = createAnnotation.mock.calls[0]!;
    const sent = body as { type?: string; suggestion?: { from?: unknown; to?: unknown }; label?: unknown };
    // Carries the suggestion span …
    expect(sent.type).toBe("suggestion");
    expect(sent.suggestion?.from).toBe("Implementation Plan: Real-time Collaboration");
    expect(sent.suggestion?.to).toBeUndefined(); // delete-kind → no `to`
    // … and NO label (mutually exclusive — the redline path is label-free).
    expect(sent.label).toBeUndefined();
    // The redline create did NOT route through the subsumed workspace-scoped suggestion path.
    expect(createRedline).not.toHaveBeenCalled();
  });
});
