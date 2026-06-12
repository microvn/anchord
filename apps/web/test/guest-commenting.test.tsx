import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core-ui-commenting S-005 — Guest commenting. A logged-out viewer (guest commenting
// enabled) gets a random session display name + a Rename control (AS-009), must enter a name to
// send (email optional, AS-010/AS-011), and every untrusted string (body + guest name) renders
// inert + the name is length-limited (AS-012). A guest comment is visibly attributed as a guest
// (C-010). The FE CONSUMES a `guest` flag from the read side; it does NOT own the sharing toggle.

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

function canComment(role: string | undefined) {
  return role !== "viewer";
}

mock.module("@/features/viewer/client", () => ({
  fetchViewerDoc,
  listAnnotations,
  createAnnotation,
  addComment,
  setResolution: mock(async () => ({ data: { success: true, data: { status: "resolved" } }, error: null })),
  canComment,
}));

const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }),
  Toaster: () => null,
}));

const { ViewerScreen } = await import("@/features/viewer/viewer-screen");
// Pure helpers (exported by composer.tsx) for the random-name + sanitize unit tests.
const { randomGuestName, sanitizeGuestName, GUEST_NAME_MAX } = await import(
  "@/features/viewer/composer"
);

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
  listAnnotations.mockImplementation(async () => annoResponse);
  createAnnotation.mockClear();
  addComment.mockClear();
  toastError.mockClear();
  // A guest session: anyone-with-link + guest commenting enabled, no account. The read side
  // surfaces `guest: true` on the doc payload; the FE consumes it (does NOT own the toggle).
  docResponse = okEnv({
    doc: {
      title: "Spec",
      kind: "markdown",
      version: 4,
      status: "live",
      generalAccess: "anyone-with-link",
      effectiveRole: "commenter",
      guest: true,
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

function openComposer() {
  const view = screen.getByTestId("markdown-view");
  const block = view.querySelector(`[data-block-id="block-p-1"]`) as HTMLElement;
  const textNode = block.firstChild as Text;
  const phrase = "Payment expires after 24h";
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

describe("Guest commenting S-005", () => {
  it("AS-009: a guest is shown a random display name on open, with a Rename control", async () => {
    await renderViewer();
    openComposer();
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-comment"));
    const composer = await screen.findByTestId("composer");

    // A random session name is shown (matches the "Anonymous <Animal>" generator).
    const nameField = within(composer).getByTestId("guest-name");
    expect((nameField as HTMLInputElement).value).toMatch(/^Anonymous \w+$/);
    // A Rename control exists and cycles the name.
    const before = (nameField as HTMLInputElement).value;
    await userEvent.click(within(composer).getByTestId("guest-rename"));
    expect((within(composer).getByTestId("guest-name") as HTMLInputElement).value).not.toBe(before);
  });

  it("AS-010: a guest comments with a name (email optional) — addComment is called with guestName and no account author", async () => {
    const realAnnotation = {
      id: "anno-real-1",
      type: "range",
      status: "unresolved" as const,
      isOrphaned: false,
      anchor: { blockId: "block-p-1", textSnippet: "Payment expires after 24h", offset: 0, length: 25 },
      comments: [
        {
          id: "cmt-real-1",
          parentId: null,
          guestName: "Lan",
          body: "Why 24h?",
          createdAt: new Date().toISOString(),
        },
      ],
    };
    listAnnotations.mockImplementation(async () =>
      createAnnotation.mock.calls.length > 0 ? okRead({ items: [realAnnotation] }) : okRead({ items: [] }),
    );

    await renderViewer();
    openComposer();
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-comment"));
    const composer = await screen.findByTestId("composer");

    const nameField = within(composer).getByTestId("guest-name") as HTMLInputElement;
    await userEvent.clear(nameField);
    await userEvent.type(nameField, "Lan");
    await userEvent.type(within(composer).getByTestId("composer-input"), "Why 24h?");
    await userEvent.click(within(composer).getByTestId("composer-send"));

    // The comment write carries the guest name (email optional → undefined/empty), no userId.
    await waitFor(() => expect(addComment).toHaveBeenCalledTimes(1));
    const body = addComment.mock.calls[0]![3];
    expect(body.body).toBe("Why 24h?");
    expect(body.guestName).toBe("Lan");
    expect(body.guestEmail ?? "").toBe(""); // optional — not provided

    // It appears in the thread under the guest name.
    const card = (await screen.findAllByTestId("thread-card"))[0]!;
    expect(card).toHaveTextContent("Lan");
    expect(card).toHaveTextContent("Why 24h?");
  });

  it("AS-011: send is blocked until a guest provides a name, with a 'name required' hint — nothing is submitted", async () => {
    await renderViewer();
    openComposer();
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-comment"));
    const composer = await screen.findByTestId("composer");

    // Clear the name, type a body → Send stays disabled, hint reads "name required".
    await userEvent.clear(within(composer).getByTestId("guest-name"));
    await userEvent.type(within(composer).getByTestId("composer-input"), "anonymous body");
    const send = within(composer).getByTestId("composer-send");
    expect(send).toBeDisabled();
    expect(within(composer).getByTestId("composer-hint").textContent ?? "").toMatch(/name required/i);

    // Clicking the disabled send submits nothing.
    await userEvent.click(send);
    await Promise.resolve();
    expect(createAnnotation).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
  });

  it("AS-012.T1: a guest comment body with HTML renders inert (the script does not run)", async () => {
    const xss = "<img src=x onerror=alert(1)>";
    listAnnotations.mockImplementation(async () =>
      createAnnotation.mock.calls.length > 0
        ? okRead({
            items: [
              {
                id: "anno-real-1",
                type: "range",
                status: "unresolved",
                isOrphaned: false,
                anchor: { blockId: "block-p-1", textSnippet: "Payment expires after 24h", offset: 0, length: 25 },
                comments: [{ id: "cmt-real-1", parentId: null, guestName: "Lan", body: xss, createdAt: new Date().toISOString() }],
              },
            ],
          })
        : okRead({ items: [] }),
    );

    await renderViewer();
    openComposer();
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-comment"));
    const composer = await screen.findByTestId("composer");
    await userEvent.clear(within(composer).getByTestId("guest-name"));
    await userEvent.type(within(composer).getByTestId("guest-name"), "Lan");
    await userEvent.type(within(composer).getByTestId("composer-input"), xss);
    await userEvent.click(within(composer).getByTestId("composer-send"));

    const card = (await screen.findAllByTestId("thread-card"))[0]!;
    expect(card).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(card.querySelector("img")).toBeNull();
  });

  it("AS-012.T1: a guest name with HTML renders inert in the thread (the script does not run)", async () => {
    const evil = `<img src=x onerror=alert(1)>`;
    listAnnotations.mockImplementation(async () =>
      createAnnotation.mock.calls.length > 0
        ? okRead({
            items: [
              {
                id: "anno-real-1",
                type: "range",
                status: "unresolved",
                isOrphaned: false,
                anchor: { blockId: "block-p-1", textSnippet: "Payment expires after 24h", offset: 0, length: 25 },
                // The stored guest name is sanitized at write — assert the thread renders it inert
                // regardless: no real <img> element from a guest name.
                comments: [{ id: "cmt-real-1", parentId: null, guestName: sanitizeGuestName(evil) || "Guest", body: "hi", createdAt: new Date().toISOString() }],
              },
            ],
          })
        : okRead({ items: [] }),
    );

    await renderViewer();
    openComposer();
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-comment"));
    const composer = await screen.findByTestId("composer");
    await userEvent.clear(within(composer).getByTestId("guest-name"));
    await userEvent.type(within(composer).getByTestId("guest-name"), "Lan");
    await userEvent.type(within(composer).getByTestId("composer-input"), "hi");
    await userEvent.click(within(composer).getByTestId("composer-send"));

    const card = (await screen.findAllByTestId("thread-card"))[0]!;
    expect(card.querySelector("img")).toBeNull();
  });

  it("AS-012.T2: an over-long guest name is truncated (on input and at sanitize)", async () => {
    await renderViewer();
    openComposer();
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-comment"));
    const composer = await screen.findByTestId("composer");

    const nameField = within(composer).getByTestId("guest-name") as HTMLInputElement;
    await userEvent.clear(nameField);
    await userEvent.type(nameField, "x".repeat(GUEST_NAME_MAX + 50));
    // The input value is clamped to the limit (truncate on input).
    expect(nameField.value.length).toBeLessThanOrEqual(GUEST_NAME_MAX);
  });

  it("C-007: a logged-in (non-guest) session shows NO guest name field and Send only needs a body", async () => {
    docResponse = okEnv({
      doc: {
        title: "Spec",
        kind: "markdown",
        version: 4,
        status: "live",
        generalAccess: "restricted",
        effectiveRole: "commenter",
        guest: false,
      },
      content: MD,
    });

    await renderViewer();
    openComposer();
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-comment"));
    const composer = await screen.findByTestId("composer");
    expect(within(composer).queryByTestId("guest-name")).toBeNull();
    // Send enables on a body alone (no name gate for a member).
    await userEvent.type(within(composer).getByTestId("composer-input"), "member comment");
    expect(within(composer).getByTestId("composer-send")).not.toBeDisabled();
  });

  it("C-010: a guest comment is visibly attributed as a guest (a Guest badge), distinct from a member", async () => {
    annoResponse = okRead({
      items: [
        {
          id: "anno-1",
          type: "range",
          status: "unresolved",
          isOrphaned: false,
          anchor: { blockId: "block-p-1", textSnippet: "Payment expires after 24h", offset: 0, length: 25 },
          comments: [{ id: "c-1", parentId: null, guestName: "Lan", body: "guest here", createdAt: new Date().toISOString() }],
        },
        {
          id: "anno-2",
          type: "range",
          status: "unresolved",
          isOrphaned: false,
          anchor: { blockId: "block-p-2", textSnippet: "Query keys", offset: 0, length: 10 },
          comments: [{ id: "c-2", parentId: null, authorName: "Mara", body: "member here", createdAt: new Date().toISOString() }],
        },
      ],
    });

    await renderViewer();
    const cards = await screen.findAllByTestId("thread-card");
    const guestCard = cards.find((c) => c.textContent?.includes("guest here"))!;
    const memberCard = cards.find((c) => c.textContent?.includes("member here"))!;
    // The guest comment carries a visible Guest badge; the member comment does not.
    expect(within(guestCard).getByTestId("guest-badge")).toBeTruthy();
    expect(within(memberCard).queryByTestId("guest-badge")).toBeNull();
  });
});

describe("guest name helpers (S-005 — pure)", () => {
  it("AS-009: randomGuestName returns an 'Anonymous <Animal>' label", () => {
    for (let i = 0; i < 10; i++) {
      expect(randomGuestName()).toMatch(/^Anonymous \w+$/);
    }
  });

  it("AS-012.T2: sanitizeGuestName truncates an over-long name to the limit", () => {
    const out = sanitizeGuestName("a".repeat(GUEST_NAME_MAX + 100));
    expect(out.length).toBeLessThanOrEqual(GUEST_NAME_MAX);
  });

  it("C-008.T3: sanitizeGuestName strips angle brackets / control chars (charset-limited, inert)", () => {
    expect(sanitizeGuestName("<img src=x onerror=alert(1)>")).not.toMatch(/[<>]/);
    expect(sanitizeGuestName("Lan\x00\x07")).toBe("Lan");
    // Plain names pass through, trimmed.
    expect(sanitizeGuestName("  Lan  ")).toBe("Lan");
  });
});
