import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core-ui-types-modes S-004 — Label: tag a selection from the preset set.
//
// Two test surfaces, both deterministic:
//   1. ThreadCard (rendered directly): the preset label line for a tagged annotation (AS-012 card),
//      and the inert body render when the (edited) body carries HTML/script (AS-015 / C-006).
//   2. ViewerScreen (the create flow): select → Label → the picker lists the preset set (AS-013) →
//      choose "Out of scope" → the composer opens pre-filled "Out of scope" (editable) → on send a
//      createAnnotation carrying label="out-of-scope" (the one labeled-create path, #9) + its root
//      comment; the anchor is block-scoped (C-008.T2); a refused create rolls back the optimistic
//      mark (AS-014 FE-boundary / C-007).
//
// C-003: every annotation has a root comment; for Label the body is pre-filled from the preset text
// (editable). `label` is stored STRUCTURED on the annotation (not folded into the body) — C-003.T2.

import { ThreadCard } from "@/features/viewer/components/thread-card";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

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

function renderCard(annotation: ViewerAnnotation, props: Partial<Parameters<typeof ThreadCard>[0]> = {}) {
  return render(
    <ThreadCard annotation={annotation} focused={false} unplaceable={false} onFocus={() => {}} {...props} />,
  );
}

describe("Label ThreadCard (S-004)", () => {
  it("AS-012: a tagged annotation renders the preset icon + \"Out of scope\" label line", () => {
    renderCard(labelAnno());
    const card = screen.getByTestId("thread-card");
    const line = within(card).getByTestId("label-line");
    expect(line).toHaveTextContent("Out of scope");
    expect(line.getAttribute("data-label")).toBe("out-of-scope");
    // A preset icon (swatch glyph) rides alongside the text (UI Notes: icon + colour + text).
    expect(line.querySelector("svg")).not.toBeNull();
  });

  it("AS-015 / C-006: a label body containing HTML/script renders as escaped plaintext (markup does not run)", () => {
    renderCard(labelAnno({
      comments: [
        { id: "lb-1-c", parentId: null, authorName: "Mara", body: "<img src=x onerror=alert(1)>", createdAt: new Date().toISOString() },
      ],
    }));
    const card = screen.getByTestId("thread-card");
    // The raw markup shows as TEXT — no <img> element was injected (inert via React children).
    expect(card).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(card.querySelector("img")).toBeNull();
  });

  it("AS-014: an unknown/forged label id renders NO label line (no raw id leaked at the rail)", () => {
    // The picker only emits real ids; defence-in-depth — a stale/forged id never leaks a raw string.
    renderCard(labelAnno({ label: "<svg onload=alert(1)>" }));
    expect(within(screen.getByTestId("thread-card")).queryByTestId("label-line")).toBeNull();
  });
});

// ── The create flow through the whole ViewerScreen (AS-012/AS-013/AS-014 + C-003.T2/C-008.T2) ──

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

const MD = `<p data-block-id="block-scope">Drop the wss://collab.plannotator.ai endpoint.</p>`;

let docResponse: unknown;
let annotationResult: unknown;

const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => okRead({ items: [] }));
const createAnnotation = mock(async () => annotationResult);
const addComment = mock(async () => okEnv({ commentId: "lb-cmt-1" }));

function canComment(role: string | undefined) {
  return role !== "viewer";
}

// S-004: Label rides the SAME doc-scoped createAnnotation as a comment/Like (no new export), so the
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
  dismissAnnotation: mock(async () => okEnv({ dismissed: true })),
  reattachAnnotation: mock(async () => okEnv({ isOrphaned: false })),
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

async function openLabelPicker(phrase = "wss://collab.plannotator.ai") {
  selectPhrase("block-scope", phrase);
  const popover = await screen.findByTestId("selection-popover");
  await userEvent.click(within(popover).getByTestId("popover-label"));
  return screen.findByTestId("label-picker");
}

describe("Label create flow (S-004, through ViewerScreen)", () => {
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
    annotationResult = okEnv({ annotationId: "lb-real-1" });
  });

  // Reset the shared signed-in session so it doesn't leak into later files (bun mock.module is
  // process-global). See memory bun-mockmodule-leak.
  afterEach(() => {
    session = null;
  });

  it("AS-013: opening Label shows the picker listing the default preset set", async () => {
    await renderViewer();
    const picker = await openLabelPicker();
    for (const text of ["Clarify this", "Verify this", "Out of scope", "Needs tests"]) {
      expect(within(picker).getByText(text)).toBeTruthy();
    }
    // The selection popover is replaced by the picker (one floating surface at a time).
    expect(screen.queryByTestId("selection-popover")).toBeNull();
  });

  it("AS-012 / C-003.T2 / C-008.T2: choose \"Out of scope\" → composer pre-filled (editable); send → out-of-scope label + root comment; block-scoped anchor; rail row", async () => {
    await renderViewer();
    const picker = await openLabelPicker();
    await userEvent.click(within(picker).getByTestId("label-option-out-of-scope"));

    // C-003: the composer opens pre-filled with the preset text "Out of scope", editable.
    const input = (await screen.findByTestId("composer-input")) as HTMLTextAreaElement;
    expect(input.value).toBe("Out of scope");

    await userEvent.click(screen.getByTestId("composer-send"));

    // AS-012.T1 / C-003.T2: a doc-scoped createAnnotation carrying label="out-of-scope" stored
    // STRUCTURED (a top-level field, not folded into the comment body — the body rides addComment).
    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    const [slugArg, body] = createAnnotation.mock.calls[0]!;
    expect(slugArg).toBe("my-doc");
    expect((body as { label?: string }).label).toBe("out-of-scope");

    // C-008.T2: the anchor is block-scoped (range type + blockId/textSnippet/offset/length) — not a
    // nodePath/web-highlighter anchor.
    const sent = body as { type: string; anchor: { blockId: string; textSnippet: string; offset: number; length: number } };
    expect(sent.type).toBe("range");
    expect(sent.anchor.blockId).toBe("block-scope");
    expect(sent.anchor.textSnippet).toBe("wss://collab.plannotator.ai");
    expect(typeof sent.anchor.offset).toBe("number");
    expect(typeof sent.anchor.length).toBe("number");

    // AS-012.T2 / C-003: a root comment by them is attached, body = the (pre-filled) preset text.
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
    expect(addComment.mock.calls[0]![1]).toBe("lb-real-1");
    expect((addComment.mock.calls[0]![2] as { body: string }).body).toBe("Out of scope");

    // AS-012.T3: the rail card shows the preset label line (icon + "Out of scope").
    const card = (await screen.findAllByTestId("thread-card"))[0]!;
    const line = within(card).getByTestId("label-line");
    expect(line).toHaveTextContent("Out of scope");
    expect(line.getAttribute("data-label")).toBe("out-of-scope");

    // Paired to an in-text highlight (the selection got a mark).
    const view = screen.getByTestId("markdown-view");
    await waitFor(() => expect(view.querySelector('[data-anno="lb-real-1"]')).not.toBeNull());
  });

  it("AS-012: an EDITED body still rides with the out-of-scope label", async () => {
    await renderViewer();
    const picker = await openLabelPicker();
    await userEvent.click(within(picker).getByTestId("label-option-out-of-scope"));

    const input = (await screen.findByTestId("composer-input")) as HTMLTextAreaElement;
    await userEvent.clear(input);
    await userEvent.type(input, "Belongs in v1, not v0");
    await userEvent.click(screen.getByTestId("composer-send"));

    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    expect((createAnnotation.mock.calls[0]![1] as { label?: string }).label).toBe("out-of-scope");
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
    expect((addComment.mock.calls[0]![2] as { body: string }).body).toBe("Belongs in v1, not v0");
  });

  it("AS-014 / C-007: a refused label create (server rejects) rolls back the optimistic mark + row, shows an error, no ghost persisted", async () => {
    // The picker emits only a real id; the FE-boundary assertion is: when the SERVER refuses the
    // create (the backend label validation rejects), the optimistic highlight + row roll back.
    annotationResult = { data: null, error: { status: 400, value: { success: false } } };
    await renderViewer();
    const view = screen.getByTestId("markdown-view");

    const picker = await openLabelPicker();
    await userEvent.click(within(picker).getByTestId("label-option-out-of-scope"));
    await userEvent.click(await screen.findByTestId("composer-send"));

    // The refused create rolls back: no thread card, no [data-anno] highlight survives (no ghost row,
    // no ghost mark), the count stays 0, and the comment write never fired.
    await waitFor(() => {
      expect(screen.queryAllByTestId("thread-card")).toHaveLength(0);
    });
    expect(view.querySelector("[data-anno]")).toBeNull();
    expect(screen.getByTestId("rail-empty")).toBeInTheDocument();
    expect(addComment).not.toHaveBeenCalled();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
  });
});
