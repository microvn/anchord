import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// annotation-core S-007 — Guest commenting. A logged-out viewer (anyone-with-link, commenter+ link
// role) gets ONE session-stable random name shown as a top-bar GuestIdentityChip (AS-016, session
// name + Rename next to Sign in), and the composer shows NO name/email field — the session name rides
// up on send (AS-017). Every untrusted string (body + guest name) renders inert (AS-019). A guest
// comment is visibly attributed as a guest (C-010). Reversal 2026-06-20: the FE derives guest mode
// from `!signedIn && canComment(role)` (the commenter+ link role IS the grant — no toggle, no
// `doc.guest` flag); these tests drive it via the session (anon for guests, signed-in for the member
// case). The session name lives in sessionStorage (cleared by the global afterEach).

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

mock.module("@/features/viewer/services/client", () => ({
  createRedline: mock(async () => ({ data: { success: true, data: { suggestionId: "rl-x" } }, error: null })),
  decideSuggestion: mock(async () => ({ data: { success: true, data: { status: "accepted" } }, error: null })),
  fetchViewerDoc,
  listAnnotations,
  createAnnotation,
  addComment,
  setResolution: mock(async () => ({ data: { success: true, data: { status: "resolved" } }, error: null })),
  // bun mock.module binds ALL exports at load — viewer-screen now imports these, so the partial
  // client mock must carry them or the module link fails (the file errored in isolation otherwise).
  deleteAnnotation: mock(async () => ({ data: { success: true, data: { deleted: true } }, error: null })),
  restoreAnnotation: mock(async () => ({ data: { success: true, data: { restored: true } }, error: null })),
  dismissAnnotation: mock(async () => ({ data: { success: true, data: { dismissed: true } }, error: null })),
  reattachAnnotation: mock(async () => ({ data: { success: true, data: { isOrphaned: false } }, error: null })),
  canComment,
}));

// Reversal 2026-06-20: "guest" is now derived from `!signedIn && canComment(role)`, NOT a doc flag.
// So a guest case needs an ANON session and the member case (C-007) needs a SIGNED-IN one. A mutable
// `session` lets each test set its identity; default is anon (the guest cases).
let session: { user: { id: string; name: string } } | null = null;
mock.module("@/lib/api/auth-client", () => ({
  useSession: () => ({ data: session, isPending: false }),
}));

const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }),
  Toaster: () => null,
}));

const { ViewerScreen } = await import("@/features/viewer/components/viewer-screen");
// Pure helpers (exported by composer.tsx) for the random-name + sanitize unit tests.
const { randomGuestName, sanitizeGuestName, GUEST_NAME_MAX } = await import(
  "@/features/viewer/components/composer"
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
  // Default: an ANON (logged-out) session. Reversal 2026-06-20 — the composer's guest mode is
  // derived from `!signedIn && canComment(effectiveRole)` (commenter+ link role IS the grant), NOT
  // a never-emitted `doc.guest` flag. So a guest case = no session + a commenter effective role.
  session = null;
  docResponse = okEnv({
    doc: {
      title: "Spec",
      kind: "markdown",
      version: 4,
      status: "live",
      generalAccess: "anyone-with-link",
      effectiveRole: "commenter",
    },
    content: MD,
  });
  annoResponse = okRead({ items: [] });
  // C-018: the create returns both ids (annotation + atomic first comment).
  createResult = okEnv({ annotationId: "anno-real-1", commentId: "cmt-real-1" });
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

describe("Guest commenting S-007", () => {
  it("AS-016: a guest gets a session-stable identity chip in the top bar (session name + Rename next to Sign in)", async () => {
    await renderViewer();
    const topBar = screen.getByTestId("viewer-top-bar");
    // The chip lives in the top bar (NOT the composer) — a `?` disc + the session name + Rename.
    const chip = within(topBar).getByTestId("guest-id");
    const nameEl = within(chip).getByTestId("guest-name");
    expect(nameEl.textContent ?? "").toMatch(/^Anonymous \w+$/);
    // The chip sits next to the Sign in CTA (both render in the top bar for a guest).
    expect(within(topBar).getByTestId("vt-signin")).toBeTruthy();
    // Rename cycles the session name in place.
    const before = nameEl.textContent;
    await userEvent.click(within(chip).getByTestId("guest-rename"));
    expect(within(topBar).getByTestId("guest-name").textContent).not.toBe(before);
  });

  it("AS-016: the session name persists across a remount (NOT re-rolled) and shows in the composer's send payload", async () => {
    // First mount: read the assigned session name from the chip.
    const { unmount } = render(<App />);
    await screen.findByTestId("markdown-view");
    const firstName = within(screen.getByTestId("viewer-top-bar")).getByTestId("guest-name").textContent!;
    unmount();
    // Remount (same session / sessionStorage intact) → SAME name (survives reload / in-tab nav).
    await renderViewer();
    expect(within(screen.getByTestId("viewer-top-bar")).getByTestId("guest-name").textContent).toBe(firstName);
  });

  it("AS-017: the composer shows NO name field and NO email field; the session name rides up on send", async () => {
    const realAnnotation = {
      id: "anno-real-1",
      type: "range",
      status: "unresolved" as const,
      isOrphaned: false,
      anchor: { blockId: "block-p-1", textSnippet: "Payment expires after 24h", offset: 0, length: 25 },
      comments: [
        { id: "cmt-real-1", parentId: null, guestName: "Anonymous Otter", body: "Why 24h?", createdAt: new Date().toISOString() },
      ],
    };
    listAnnotations.mockImplementation(async () =>
      createAnnotation.mock.calls.length > 0 ? okRead({ items: [realAnnotation] }) : okRead({ items: [] }),
    );

    await renderViewer();
    // The session name as shown in the header chip — this is what must ride up on send.
    const headerName = within(screen.getByTestId("viewer-top-bar")).getByTestId("guest-name").textContent!;

    openComposer();
    await userEvent.click(within(await screen.findByTestId("selection-popover")).getByTestId("popover-comment"));
    const composer = await screen.findByTestId("composer");

    // AS-017: the composer has NEITHER a name field NOR an email field.
    expect(within(composer).queryByTestId("guest-name")).toBeNull();
    expect(within(composer).queryByLabelText(/email/i)).toBeNull();
    // Send is enabled on a body alone (the session name is always present).
    await userEvent.type(within(composer).getByTestId("composer-input"), "Why 24h?");
    expect(within(composer).getByTestId("composer-send")).not.toBeDisabled();
    await userEvent.click(within(composer).getByTestId("composer-send"));

    // C-018: the guest comment rides the atomic createAnnotation `comment` payload, carrying the
    // SESSION name (from the header chip) — NO email (AS-017), no userId.
    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    const comment = (createAnnotation.mock.calls[0]![1] as { comment: { body: string; guestName?: string } }).comment;
    expect(comment.body).toBe("Why 24h?");
    expect(comment.guestName).toBe(headerName);
    expect("guestEmail" in comment).toBe(false);
    expect(addComment).not.toHaveBeenCalled();
  });

  it("AS-019: a guest comment body with HTML renders inert (the script does not run)", async () => {
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
    await userEvent.type(within(composer).getByTestId("composer-input"), xss);
    await userEvent.click(within(composer).getByTestId("composer-send"));

    const card = (await screen.findAllByTestId("thread-card"))[0]!;
    expect(card).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(card.querySelector("img")).toBeNull();
  });

  it("AS-019: a guest name with HTML renders inert in the thread (the script does not run)", async () => {
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
    await userEvent.type(within(composer).getByTestId("composer-input"), "hi");
    await userEvent.click(within(composer).getByTestId("composer-send"));

    const card = (await screen.findAllByTestId("thread-card"))[0]!;
    expect(card.querySelector("img")).toBeNull();
  });

  it("C-007: a logged-in (non-guest) session shows NO guest name field and Send only needs a body", async () => {
    // A SIGNED-IN member → `!signedIn` is false → guest mode off (no GuestNameField), even though
    // the effective role is commenter (the role authorizes commenting, the session identifies them).
    session = { user: { id: "u-mara", name: "Mara" } };
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
