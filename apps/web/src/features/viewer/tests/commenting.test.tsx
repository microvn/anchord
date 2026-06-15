import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core-ui-commenting S-001 — Comment on a selected text range (Markdown). The viewer
// client is MOCKED so the tests assert the WRITE behavior (select → popover → composer → optimistic
// thread + highlight, role gate, rollback), not a real round-trip. The MD doc carries data-block-id
// blocks so selectionToAnchor can walk to a block and placeAnnotations can re-place the highlight.
//
// AS-001 select a sentence → Comment → type → send → block-anchored annotation + highlight + a
//        thread at the TOP of the rail + count increments.
// AS-002 empty / whitespace-only selection → no popover, nothing created.
// AS-003 viewer-only role → no popover/composer; the rail is read-only.
// AS-013 refused / failed write → optimistic highlight + thread roll back; error shown.

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

const MD = `
<p data-block-id="block-p-1">Payment expires after 24h unless the subscription is renewed.</p>
<p data-block-id="block-p-2">Query keys embed the workspace id so a stale cache can never bleed.</p>
`;

let docResponse: unknown;
let annoResponse: unknown;
let createResult: unknown;
let commentResult: unknown;

const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => annoResponse);
const createAnnotation = mock(async () => createResult);
const addComment = mock(async () => commentResult);

// canComment is real logic (not mocked): only an explicit "viewer" role is read-only.
function canComment(role: string | undefined) {
  return role !== "viewer";
}

mock.module("@/features/viewer/services/client", () => ({
  fetchViewerDoc,
  listAnnotations,
  createAnnotation,
  addComment,
  setResolution: mock(async () => ({ data: { success: true, data: { status: "resolved" } }, error: null })),
  canComment,
}));

// Mock sonner so the error toast (AS-013.T2) is observable without a real toast surface.
const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }),
  // bun's mock.module is process-global; export a no-op Toaster too so a later file that imports
  // the app's <Toaster /> (e.g. auth-signin-redirect) still resolves the named export.
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

beforeEach(() => {
  fetchViewerDoc.mockClear();
  // Reset to the default `annoResponse`-driven impl: AS-001 overrides this with mockImplementation,
  // so a plain mockClear() would leak that impl into sibling tests. Restore the base behaviour here.
  listAnnotations.mockImplementation(async () => annoResponse);
  createAnnotation.mockClear();
  addComment.mockClear();
  toastError.mockClear();
  docResponse = okEnv({
    doc: {
      title: "Spec",
      kind: "markdown",
      version: 4,
      status: "live",
      generalAccess: "restricted",
      effectiveRole: "commenter",
    },
    content: MD,
  });
  annoResponse = okRead({ items: [] });
  createResult = okEnv({ annotationId: "anno-real-1" });
  commentResult = okEnv({ commentId: "cmt-real-1" });
});

async function renderViewer() {
  render(<App />);
  await screen.findByTestId("markdown-view");
  await screen.findByTestId("annotations-rail");
}

/** Select `phrase` inside the block with `blockId` and fire mouseup on the doc pane. */
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
  // mouseup bubbles from the block up to the doc pane <main>, where useCompose listens. Wrapped in
  // act() because the listener's setState happens outside React's event batching.
  act(() => {
    block.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  });
}

/** Like selectPhrase but walks all text nodes (the block may contain <mark> children). */
function selectPhraseDeep(blockId: string, phrase: string) {
  const view = screen.getByTestId("markdown-view");
  const block = view.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
  const walker = document.createTreeWalker(block, 0x4 /* SHOW_TEXT */);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const idx = node.data.indexOf(phrase);
    if (idx !== -1) {
      const range = document.createRange();
      range.setStart(node, idx);
      range.setEnd(node, idx + phrase.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      act(() => {
        block.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
      });
      return;
    }
    node = walker.nextNode() as Text | null;
  }
  throw new Error(`phrase not found: ${phrase}`);
}

/** Collapse the selection to simulate a 0-character / whitespace-only release. */
function selectNothing(blockId: string) {
  const view = screen.getByTestId("markdown-view");
  const block = view.querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
  const textNode = block.firstChild as Text;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, 0); // collapsed → 0 characters
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  act(() => {
    block.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  });
}

describe("Commenting S-001", () => {
  it("AS-001: selecting a sentence, commenting, and sending creates a block-anchored annotation with a highlight and a top thread", async () => {
    // PERF (no-refetch reconcile): the success path now PREPENDS the real created row (built from the
    // server-returned annotationId/commentId) into the react-query cache and clears the optimistic
    // temp — NO post-write refetch. listAnnotations runs ONCE (the initial mount, returning empty);
    // the real row appears purely from the cache update. If the optimistic temp lingered the comment
    // would render TWICE / the count would double-count (the bug this guards). The mock stays on its
    // default empty `annoResponse` impl — a second listAnnotations call would be a regression.
    await renderViewer();
    expect(screen.getByTestId("rail-count")).toHaveTextContent("0");

    // Select "Payment expires after 24h" → popover appears.
    selectPhrase("block-p-1", "Payment expires after 24h");
    const popover = await screen.findByTestId("selection-popover");

    // Comment → composer prefilled with the quote (AS-001).
    await userEvent.click(within(popover).getByTestId("popover-comment"));
    const composer = await screen.findByTestId("composer");
    expect(within(composer).getByTestId("pending-quote")).toHaveTextContent("Payment expires after 24h");

    // Type + send.
    await userEvent.type(within(composer).getByTestId("composer-input"), "Why 24h and not 48h?");
    await userEvent.click(within(composer).getByTestId("composer-send"));

    // AS-001.T1: a block-anchored annotation create with {blockId, textSnippet, offset, length}.
    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    // S-003: createAnnotation is now slug-only (slug, body) → the body is the 2nd arg.
    const [, createBody] = createAnnotation.mock.calls[0]!;
    expect(createBody.type).toBe("range");
    expect(createBody.anchor.blockId).toBe("block-p-1");
    expect(createBody.anchor.textSnippet).toBe("Payment expires after 24h");
    expect(createBody.anchor.offset).toBe(0);
    expect(createBody.anchor.length).toBe("Payment expires after 24h".length);

    // The comment body posts after the annotation is created (AS-001).
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
    // S-003: addComment is now (slug, annotationId, body) → annotationId is the 2nd arg.
    const commentArgs = addComment.mock.calls[0]!;
    expect(commentArgs[1]).toBe("anno-real-1"); // the created annotation id
    expect(commentArgs[2].body).toBe("Why 24h and not 48h?");

    // AS-001.T2: EXACTLY ONE highlight marks the selected sentence — the real refetched row's mark,
    // with no leftover optimistic `data-anno=<tempId>` mark double-wrapping the same range.
    await waitFor(() => {
      const marks = screen.getByTestId("markdown-view").querySelectorAll("[data-anno]");
      expect(marks).toHaveLength(1);
      expect(marks[0]!.textContent).toBe("Payment expires after 24h");
      expect(marks[0]!.getAttribute("data-anno")).toBe("anno-real-1");
    });
    // No stale optimistic mark survives the success reconcile.
    expect(
      screen.getByTestId("markdown-view").querySelector('[data-anno^="optimistic-"]'),
    ).toBeNull();

    // AS-001.T3: EXACTLY ONE thread (the reconciled real row) tops the rail — the optimistic temp
    // must be cleared on success so the comment doesn't render twice.
    await waitFor(() => {
      expect(screen.getAllByTestId("thread-card")).toHaveLength(1);
    });
    const threads = screen.getAllByTestId("thread-card");
    expect(threads[0]).toHaveTextContent("Payment expires after 24h");
    expect(threads[0]).toHaveTextContent("Why 24h and not 48h?");

    // AS-001.T4: the count is EXACTLY 1 — no double-count from a lingering optimistic thread.
    expect(screen.getByTestId("rail-count")).toHaveTextContent("1");

    // NO post-write refetch: listAnnotations ran ONLY for the initial mount. The reconcile happened
    // entirely via the react-query cache update — a second call would be the old refetch regression.
    expect(listAnnotations).toHaveBeenCalledTimes(1);
  });

  it("BUG #1: selecting text must NOT make existing annotation highlights disappear", async () => {
    // Repro: a doc with ≥2 existing annotations renders their highlights. Selecting some text (which
    // raises the selection popover via a re-render) must NOT unwrap/wipe the existing marks. The old
    // code placed marks BOTH in a render-time useMemo (a DOM side-effect during render) AND in the
    // post-commit effect; a re-render during a live Selection could unwrap-then-not-rewrap, dropping
    // every [data-anno] mark. The marks must survive the selection.
    annoResponse = okRead({
      items: [
        {
          id: "anno-x1",
          type: "range",
          status: "unresolved",
          isOrphaned: false,
          anchor: { blockId: "block-p-1", textSnippet: "Payment expires after 24h", offset: 0, length: 25 },
          comments: [{ id: "cx1", parentId: null, authorName: "A", body: "first", createdAt: new Date().toISOString() }],
        },
        {
          id: "anno-x2",
          type: "range",
          status: "unresolved",
          isOrphaned: false,
          anchor: { blockId: "block-p-2", textSnippet: "Query keys", offset: 0, length: 10 },
          comments: [{ id: "cx2", parentId: null, authorName: "B", body: "second", createdAt: new Date().toISOString() }],
        },
      ],
    });

    await renderViewer();

    // Both highlights placed initially.
    const view = screen.getByTestId("markdown-view");
    await waitFor(() => {
      expect(view.querySelectorAll("[data-anno]")).toHaveLength(2);
    });

    // Now select some OTHER text → the popover opens (a re-render happens). Walk to a text node that
    // contains the phrase (block-p-2's leading "Query keys" is already wrapped in a mark, so the
    // remaining plain text sits in a later sibling text node).
    selectPhraseDeep("block-p-2", "embed the workspace id");
    await screen.findByTestId("selection-popover");

    // The pre-existing highlights must STILL be present (the bug wiped them).
    expect(view.querySelectorAll("[data-anno]")).toHaveLength(2);
    expect(view.querySelector('[data-anno="anno-x1"]')!.textContent).toBe("Payment expires after 24h");
    expect(view.querySelector('[data-anno="anno-x2"]')!.textContent).toBe("Query keys");
  });

  it("AS-002 / C-003: an empty / whitespace-only selection shows no popover and creates nothing", async () => {
    await renderViewer();

    selectNothing("block-p-1");

    // No popover appears.
    expect(screen.queryByTestId("selection-popover")).toBeNull();
    // Give any async path a tick — still no write.
    await Promise.resolve();
    expect(createAnnotation).not.toHaveBeenCalled();
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(screen.getByTestId("rail-count")).toHaveTextContent("0");
  });

  it("AS-003 / C-004: a viewer-only role gets no popover/composer and a read-only rail", async () => {
    docResponse = okEnv({
      doc: {
        title: "Spec",
        kind: "markdown",
        version: 4,
        status: "live",
        generalAccess: "restricted",
        effectiveRole: "viewer",
      },
      content: MD,
    });

    await renderViewer();

    // Selecting text offers no popover for a viewer-only role.
    selectPhrase("block-p-1", "Payment expires after 24h");
    await Promise.resolve();
    expect(screen.queryByTestId("selection-popover")).toBeNull();
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(createAnnotation).not.toHaveBeenCalled();
  });

  it("AS-013 / C-011: a refused create rolls back the optimistic thread + highlight and shows an error", async () => {
    createResult = { data: null, error: { status: 403, value: { success: false } } };

    await renderViewer();

    selectPhrase("block-p-1", "Payment expires after 24h");
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-comment"));
    const composer = await screen.findByTestId("composer");
    await userEvent.type(within(composer).getByTestId("composer-input"), "ghost?");

    // Send. The thread + highlight mount optimistically, then the refused create rolls them back.
    await userEvent.click(within(composer).getByTestId("composer-send"));

    // AS-013.T1: the refused write removes the optimistic thread + highlight (no ghost).
    await waitFor(() => {
      expect(screen.queryAllByTestId("thread-card")).toHaveLength(0);
    });
    expect(screen.getByTestId("markdown-view").querySelector("[data-anno]")).toBeNull();
    expect(screen.getByTestId("rail-count")).toHaveTextContent("0");
    // No comment write happened since the annotation create was refused.
    expect(addComment).not.toHaveBeenCalled();

    // AS-013.T2: an error toast is shown.
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]![0]).toMatch(/couldn't save your comment/i);
  });

  it("C-008.T1: the comment body renders inert (escaped plaintext, no HTML injected)", async () => {
    // PERF (no-refetch): the reconciled real row is built in-memory from the typed body and prepended
    // into the cache — no refetch. Inertness is asserted on that reconciled (single source of truth)
    // thread; the untrusted body must render as escaped plaintext, never injected HTML.
    const xss = "<img src=x onerror=alert(1)>";

    await renderViewer();

    selectPhrase("block-p-1", "Payment expires after 24h");
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-comment"));
    const composer = await screen.findByTestId("composer");
    await userEvent.type(within(composer).getByTestId("composer-input"), xss);
    await userEvent.click(within(composer).getByTestId("composer-send"));

    const card = (await screen.findAllByTestId("thread-card"))[0]!;
    // The body shows as text; no injected <img> element exists inside the thread.
    expect(card).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(card.querySelector("img")).toBeNull();
  });

  it("C-008.T2: the pending quoted snippet renders inert (escaped plaintext, no HTML injected)", async () => {
    // The server-sanitized doc carries escaped entities (&lt;b&gt;) in the rendered text. The
    // browser decodes them to the literal characters "<b>bold</b>" in the text node; when the
    // composer quotes that selection it must show it as TEXT (React children), never inject a real
    // <b>/<script> element into the quote.
    docResponse = okEnv({
      doc: { title: "Spec", kind: "markdown", version: 1, status: "live", generalAccess: "restricted", effectiveRole: "commenter" },
      content: '<p data-block-id="block-x">tag &lt;b&gt;bold&lt;/b&gt; here</p>',
    });

    await renderViewer();

    selectPhrase("block-x", "<b>bold</b>");
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-comment"));
    const quote = within(await screen.findByTestId("composer")).getByTestId("pending-quote");
    // The snippet shows as literal text; no real <b> element is created inside the quote.
    expect(quote).toHaveTextContent("<b>bold</b>");
    expect(quote.querySelector("b")).toBeNull();
  });

  it("C-008.T4: the composer hint is neutral, NOT 'Markdown supported'", async () => {
    await renderViewer();

    selectPhrase("block-p-1", "Payment expires after 24h");
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-comment"));
    const composer = await screen.findByTestId("composer");
    const hint = within(composer).getByTestId("composer-hint");
    expect(hint.textContent ?? "").not.toMatch(/markdown/i);
  });
});

// Unit tests for the pure selection→anchor half of the G3 anchor contract (JSDOM-testable per the
// spec Clarifications). These give AS-001 / AS-002 depth at the function boundary, independent of
// the React wiring above.
const { selectionToAnchor } = await import("@/features/viewer/lib/selection-anchor");

function selectionOf(html: string, blockId: string, phrase: string): Selection {
  document.body.innerHTML = html;
  // Resolve by id OR data-block-id — injectBlockIds stamps markdown blocks as id="block-…" and
  // only uses data-block-id when the element already had an author id.
  const block = (document.getElementById(blockId) ??
    document.querySelector(`[data-block-id="${blockId}"]`)) as HTMLElement;
  // Find the text node + index for `phrase` anywhere in the block (walk text nodes).
  const walker = document.createTreeWalker(block, 0x4 /* SHOW_TEXT */);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const i = node.data.indexOf(phrase);
    if (i !== -1) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + phrase.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      return sel;
    }
    node = walker.nextNode() as Text | null;
  }
  throw new Error(`phrase not found: ${phrase}`);
}

describe("selectionToAnchor (S-001 anchor contract)", () => {
  it("AS-001: derives {blockId, textSnippet, offset, length} from a selection inside a data-block-id block", () => {
    const sel = selectionOf(
      '<p data-block-id="block-p-1">Payment expires after 24h unless renewed.</p>',
      "block-p-1",
      "expires after 24h",
    );
    const anchor = selectionToAnchor(sel)!;
    expect(anchor).not.toBeNull();
    expect(anchor.blockId).toBe("block-p-1");
    expect(anchor.textSnippet).toBe("expires after 24h");
    expect(anchor.offset).toBe("Payment ".length); // 8
    expect(anchor.length).toBe("expires after 24h".length);
    expect(anchor.segments).toEqual([
      { blockId: "block-p-1", offset: 8, length: 17, textSnippet: "expires after 24h" },
    ]);
  });

  it('AS-001: resolves a block addressed by id="block-…" (the real injectBlockIds markdown form, not data-block-id)', () => {
    // REGRESSION: injectBlockIds stamps a plain markdown block as id="block-p-1" (data-block-id
    // only when the element already has an author id). selectionToAnchor formerly matched
    // data-block-id ONLY, so EVERY real markdown selection returned null → no popover → commenting
    // silently dead. The old mock used data-block-id, hiding it. This asserts the id form resolves.
    const sel = selectionOf(
      '<p id="block-p-1">Payment expires after 24h unless renewed.</p>',
      "block-p-1",
      "expires after 24h",
    );
    const anchor = selectionToAnchor(sel)!;
    expect(anchor).not.toBeNull();
    expect(anchor.blockId).toBe("block-p-1");
    expect(anchor.textSnippet).toBe("expires after 24h");
    expect(anchor.offset).toBe("Payment ".length);
  });

  it("AS-001: offset is measured from the start of the block text (mid-block selection)", () => {
    const sel = selectionOf(
      '<p data-block-id="b2">read the spec carefully before shipping</p>',
      "b2",
      "spec",
    );
    const anchor = selectionToAnchor(sel)!;
    expect(anchor.blockId).toBe("b2");
    expect(anchor.textSnippet).toBe("spec");
    // "read the " precedes "spec" → offset 9.
    expect(anchor.offset).toBe("read the ".length);
  });

  it("AS-002 / C-003: a collapsed (0-character) selection yields no anchor", () => {
    document.body.innerHTML = '<p data-block-id="b1">hello</p>';
    const node = document.querySelector("p")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(node, 2);
    range.setEnd(node, 2);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(selectionToAnchor(sel)).toBeNull();
  });

  it("AS-002 / C-003: a whitespace-only selection yields no anchor", () => {
    const sel = selectionOf('<p data-block-id="b1">a    b</p>', "b1", "    ");
    expect(selectionToAnchor(sel)).toBeNull();
  });

  it("AS-002: a selection not inside any data-block-id element yields no anchor", () => {
    document.body.innerHTML = "<div>loose text with no block marker here</div>";
    const node = document.querySelector("div")!.firstChild as Text;
    const i = node.data.indexOf("text");
    const range = document.createRange();
    range.setStart(node, i);
    range.setEnd(node, i + 4);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    expect(selectionToAnchor(sel)).toBeNull();
  });
});
