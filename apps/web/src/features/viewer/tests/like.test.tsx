import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core-ui-types-modes S-003 — Like: mark a selection "looks good".
//
// Two test surfaces, both deterministic:
//   1. ThreadCard (rendered directly): the 👍 "Looks good" label line that pairs to a signal
//      annotation carrying label="looks-good" (AS-010 card), and the inert label-text render (C-006).
//   2. ViewerScreen (the create flow): select → Like → the composer opens pre-filled "Looks good"
//      (editable) → on send a createAnnotation carrying label="looks-good" + its root comment, with
//      the optimistic 👍 row + highlight (AS-010 create); a refused write rolls the optimistic
//      highlight + row back (AS-011 / C-007.T2).
//
// C-003: every annotation has a root comment; for Like the body is pre-filled from the type text
// ("Looks good"), editable before send; `label` is stored structured (not folded into the body).

import { ThreadCard } from "@/features/viewer/components/thread-card";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

function likeAnno(overrides: Partial<ViewerAnnotation> = {}): ViewerAnnotation {
  return {
    id: "lk-1",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    label: "looks-good",
    anchor: { blockId: "block-ctx", textSnippet: "Context", offset: 0, length: 7 },
    comments: [
      { id: "lk-1-c", parentId: null, authorName: "Mara", body: "Looks good", createdAt: new Date().toISOString() },
    ],
    ...overrides,
  };
}

function renderCard(annotation: ViewerAnnotation, props: Partial<Parameters<typeof ThreadCard>[0]> = {}) {
  return render(
    <ThreadCard annotation={annotation} focused={false} unplaceable={false} onFocus={() => {}} {...props} />,
  );
}

describe("Like ThreadCard (S-003)", () => {
  it("AS-010: a signal annotation with label=looks-good renders a 👍 \"Looks good\" row paired to its thread", () => {
    renderCard(likeAnno());
    const card = screen.getByTestId("thread-card");
    const line = within(card).getByTestId("label-line");
    // The label line reads as the Like preset (👍 + "Looks good").
    expect(line).toHaveTextContent("Looks good");
    expect(line).toHaveTextContent("👍");
    expect(line.getAttribute("data-label")).toBe("looks-good");
    // C-003: it still carries a root comment (its authored thread), pre-filled from the type text.
    expect(card).toHaveTextContent("Looks good");
  });

  it("C-003.T1: a plain comment (no label) renders NO label line", () => {
    renderCard(likeAnno({ label: undefined, comments: [
      { id: "c-1", parentId: null, authorName: "Mara", body: "A note", createdAt: new Date().toISOString() },
    ] }));
    expect(within(screen.getByTestId("thread-card")).queryByTestId("label-line")).toBeNull();
  });

  it("C-006: an unknown/foreign label id renders no label line (no raw id leaked)", () => {
    renderCard(likeAnno({ label: "<svg onload=alert(1)>" }));
    expect(within(screen.getByTestId("thread-card")).queryByTestId("label-line")).toBeNull();
  });
});

// ── The create flow through the whole ViewerScreen (AS-010 create + AS-011 rollback) ──

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

const MD = `<p data-block-id="block-ctx">Context is the hard part of the plan.</p>`;

let docResponse: unknown;
let annotationResult: unknown;

const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => okRead({ items: [] }));
const createAnnotation = mock(async () => annotationResult);
const addComment = mock(async () => okEnv({ commentId: "lk-cmt-1" }));

function canComment(role: string | undefined) {
  return role !== "viewer";
}

// S-003: a Like rides the SAME doc-scoped createAnnotation as a comment (no new export), so the
// partial client mock only needs the existing thunks. createRedline/decideSuggestion are stubbed so
// useCompose/viewer-screen's load-time imports resolve (bun mock.module binds exports at load).
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
  canComment,
}));

const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }),
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

describe("Like create flow (S-003, through ViewerScreen)", () => {
  beforeEach(() => {
    fetchViewerDoc.mockClear();
    listAnnotations.mockClear();
    createAnnotation.mockClear();
    addComment.mockClear();
    toastError.mockClear();
    session = { user: { email: "mara@b.co" } };
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
    annotationResult = okEnv({ annotationId: "lk-real-1" });
  });

  // Reset the shared signed-in session so it doesn't leak into later files (bun mock.module is
  // process-global). See memory bun-mockmodule-leak.
  afterEach(() => {
    session = null;
  });

  it("AS-010 / C-003.T1: select → Like opens the composer pre-filled \"Looks good\" (editable); send → looks-good label + root comment; 👍 row", async () => {
    await renderViewer();

    selectPhrase("block-ctx", "Context");
    const popover = await screen.findByTestId("selection-popover");
    await userEvent.click(within(popover).getByTestId("popover-like"));

    // C-003.T1: the composer opens pre-filled with the type text "Looks good", editable.
    const input = (await screen.findByTestId("composer-input")) as HTMLTextAreaElement;
    expect(input.value).toBe("Looks good");

    // Send as-is.
    await userEvent.click(screen.getByTestId("composer-send"));

    // AS-010.T1: a doc-scoped createAnnotation carrying label="looks-good" (the one labeled-create
    // path — slug-only, the same path a comment annotation rides).
    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    const [slugArg, body] = createAnnotation.mock.calls[0]!;
    expect(slugArg).toBe("my-doc");
    expect((body as { label?: string }).label).toBe("looks-good");

    // AS-010.T2 / C-003: a root comment by them is attached, body = the (pre-filled) "Looks good".
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
    expect(addComment.mock.calls[0]![1]).toBe("lk-real-1");
    expect((addComment.mock.calls[0]![2] as { body: string }).body).toBe("Looks good");

    // AS-010.T3: the rail card shows the 👍 "Looks good" row.
    const card = (await screen.findAllByTestId("thread-card"))[0]!;
    const line = within(card).getByTestId("label-line");
    expect(line).toHaveTextContent("Looks good");
    expect(line.getAttribute("data-label")).toBe("looks-good");

    // AS-010.T4: paired to an in-text highlight (the selection got a mark).
    const view = screen.getByTestId("markdown-view");
    await waitFor(() => expect(view.querySelector('[data-anno="lk-real-1"]')).not.toBeNull());
  });

  it("AS-010: an EDITED body still rides with the looks-good label", async () => {
    await renderViewer();
    selectPhrase("block-ctx", "Context");
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-like"));

    const input = (await screen.findByTestId("composer-input")) as HTMLTextAreaElement;
    await userEvent.clear(input);
    await userEvent.type(input, "Great section");
    await userEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    expect((createAnnotation.mock.calls[0]![1] as { label?: string }).label).toBe("looks-good");
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
    expect((addComment.mock.calls[0]![2] as { body: string }).body).toBe("Great section");
  });

  it("AS-011 / C-007.T2: a refused Like write rolls back the optimistic highlight + row, shows an error, no ghost", async () => {
    annotationResult = { data: null, error: { status: 403, value: { success: false } } };
    await renderViewer();
    const view = screen.getByTestId("markdown-view");

    selectPhrase("block-ctx", "Context");
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-like"));
    await userEvent.click(await screen.findByTestId("composer-send"));

    // The refused create rolls back: no thread card, no [data-anno] highlight survives (no ghost row,
    // no ghost mark), and the count stays 0.
    await waitFor(() => {
      expect(screen.queryAllByTestId("thread-card")).toHaveLength(0);
    });
    expect(view.querySelector("[data-anno]")).toBeNull();
    expect(screen.getByTestId("rail-count")).toHaveTextContent("0");
    // The comment write never fired since the annotation create was refused.
    expect(addComment).not.toHaveBeenCalled();
    // An error toast is shown.
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});
