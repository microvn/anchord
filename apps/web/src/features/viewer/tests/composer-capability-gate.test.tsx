import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// doc-access-routing S-004 — AS-020: no composer for a read-only OR a guest-disabled session.
//
// The compose affordance is driven by an EXPLICIT can-comment capability (canComment(role) +
// the guest flag), NOT by the mere presence/absence of a role. Two cases must offer NO composer:
//   (a) a viewer-role session (resolved role = viewer → canComment false)
//   (b) an anonymous session on an anyone_with_link doc with guest commenting OFF (the server
//       resolves the link role to `viewer` and never sets guest=true → canComment false)
// In both, selecting text must raise NO selection-popover and open NO composer.

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const okRead = (body: unknown) => ({ data: body, error: null });

const MD = `
<p data-block-id="block-p-1">Payment expires after 24h unless the subscription is renewed.</p>
`;

let docResponse: unknown;

const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => okRead({ items: [] }));

// canComment is the REAL capability logic (not mocked): only an explicit "viewer" role is read-only.
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
  addComment: mock(async () => okEnv({ commentId: "c" })),
  setResolution: mock(async () => okEnv({ status: "resolved" })),
  deleteAnnotation: mock(async () => okEnv({ deleted: true })),
  restoreAnnotation: mock(async () => okEnv({ restored: true })),
  dismissAnnotation: mock(async () => okEnv({ dismissed: true })),
  reattachAnnotation: mock(async () => okEnv({ isOrphaned: false })),
  canComment,
}));

mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) }),
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

describe("AS-020: composer gating by the can-comment capability", () => {
  beforeEach(() => {
    fetchViewerDoc.mockClear();
    listAnnotations.mockClear();
  });

  it("AS-020 (a): a viewer-role session offers NO composer (read-only rail)", async () => {
    docResponse = okEnv({
      doc: { title: "Spec", kind: "markdown", version: 1, status: "live", generalAccess: "restricted", effectiveRole: "viewer" },
      content: MD,
    });

    await renderViewer();

    selectPhrase("block-p-1", "Payment expires after 24h");
    await Promise.resolve();
    expect(screen.queryByTestId("selection-popover")).toBeNull();
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(screen.queryByTestId("inline-composer-popover")).toBeNull();
  });

  it("AS-020 (b): an anon session on anyone_with_link with guest commenting OFF offers NO composer", async () => {
    // The server resolves the anon link role to `viewer` (least privilege) and never marks the
    // session guest when guest commenting is off → canComment(viewer)=false → no composer. This is
    // the CAPABILITY gate, not a role presence check (a role IS present — it's just `viewer`).
    docResponse = okEnv({
      doc: { title: "Public spec", kind: "markdown", version: 1, status: "live", generalAccess: "anyone_with_link", effectiveRole: "viewer", guest: false },
      content: MD,
    });

    await renderViewer();

    selectPhrase("block-p-1", "Payment expires after 24h");
    await Promise.resolve();
    expect(screen.queryByTestId("selection-popover")).toBeNull();
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(screen.queryByTestId("inline-composer-popover")).toBeNull();
  });

  it("AS-020 (control): a guest-ON anon session (commenter capability) DOES offer the composer", async () => {
    // Negation guard (falsifiability): with the same anyone_with_link doc but guest commenting ON,
    // the server resolves the link role to commenter + guest=true → canComment is true → a selection
    // raises the popover. Proves AS-020 (a)/(b) gate on the capability, not on being anon.
    docResponse = okEnv({
      doc: { title: "Public spec", kind: "markdown", version: 1, status: "live", generalAccess: "anyone_with_link", effectiveRole: "commenter", guest: true },
      content: MD,
    });

    await renderViewer();

    selectPhrase("block-p-1", "Payment expires after 24h");
    expect(await screen.findByTestId("selection-popover")).toBeTruthy();
  });
});
