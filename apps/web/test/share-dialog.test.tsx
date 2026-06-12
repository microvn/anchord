import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// sharing-permissions-ui S-001 — Open the Share dialog (shell: open, gate, responsive, prefill
// read, two entry points). The sharing Eden client is MOCKED so the dialog's PREFILL read
// (getShareState → GET …/share) is deterministic; the real `canManageShare` gate is exercised both
// through the pure fn (C-002) and through the rendered dialog (AS-003/004). Pixel/responsive layout
// is [→MANUAL]; the ≤600 sheet vs ≥601 modal BRANCH is asserted via the breakpoint hook (AS-002).

// Prime the real module into the cache so the `...actual` spread below resolves every export
// (the C-002 `canManageShare` gate is the REAL pure fn — only the read thunk is mocked).
import * as sharingClient from "../src/features/sharing/client";

const getShareState = mock(async () => ({ data: RESTRICTED_OWNER_STATE, error: null }));

mock.module("../src/features/sharing/client", () => ({
  ...sharingClient,
  getShareState,
}));

// Stub the toast so a missing Toaster host doesn't error under happy-dom.
mock.module("sonner", () => ({ toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) }) }));

const RESTRICTED_OWNER_STATE = {
  level: "restricted" as const,
  role: "viewer" as const,
  guestCommenting: false,
  editorsCanShare: false,
  people: [
    { userId: "u-own", email: "owner@acme.com", name: "Owner Olu", role: "owner" as const, status: "active" as const },
  ],
  link: { hasPassword: false, url: "anchord.local/d/web-core" },
};

// AS-018 prefill data: anyone-with-link / commenter, guest on, 1 active + 1 pending, password link.
const LINK_STATE = {
  level: "anyone_with_link" as const,
  role: "commenter" as const,
  guestCommenting: true,
  editorsCanShare: false,
  people: [
    { userId: "u-own", email: "owner@acme.com", name: "Owner Olu", role: "owner" as const, status: "active" as const },
    { userId: "u-act", email: "dev@acme.com", name: "Dev Dana", role: "editor" as const, status: "active" as const },
    { email: "bob@x.com", role: "commenter" as const, status: "pending" as const },
  ],
  link: { hasPassword: true, expiresAt: "2026-07-01T00:00:00Z", viewLimit: 50, viewCount: 3, url: "anchord.local/d/web-core?k=9f2a" },
};

const { ShareDialog } = await import("../src/features/sharing/share-dialog");
const { canManageShare } = await import("../src/features/sharing/client");

beforeEach(() => {
  getShareState.mockClear();
  getShareState.mockImplementation(async () => ({ data: RESTRICTED_OWNER_STATE, error: null }));
  // default desktop width (modal branch)
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1440 });
});

function renderDialog(props: Partial<Parameters<typeof ShareDialog>[0]> = {}) {
  return render(
    <ShareDialog
      open
      onOpenChange={() => {}}
      workspaceId="ws-acme"
      slug="web-core"
      docTitle="Web-core spec"
      effectiveRole="owner"
      {...props}
    />,
  );
}

describe("sharing-permissions-ui S-001 — open the Share dialog", () => {
  it("AS-001: owner opens the share dialog showing the sections, prefilled from current state", async () => {
    renderDialog({ effectiveRole: "owner" });

    // The dialog opened and read the share state.
    await screen.findByTestId("share-dialog");
    await waitFor(() => expect(getShareState).toHaveBeenCalledWith("ws-acme", "web-core"));

    // The four sections render (General access · Guest commenting · Invite people / People).
    await screen.findByTestId("share-sec-access");
    expect(screen.getByTestId("share-sec-guest")).toBeInTheDocument();
    expect(screen.getByTestId("share-sec-people")).toBeInTheDocument();

    // Prefilled from the CURRENT state — restricted, not a blank form.
    expect(screen.getByTestId("share-access-level")).toHaveTextContent(/restricted/i);
    // Restricted → no Link section (C-007).
    expect(screen.queryByTestId("share-sec-link")).not.toBeInTheDocument();
    // The title is the doc-scoped "Share doc" header.
    expect(screen.getByTestId("share-dialog")).toHaveTextContent(/share doc/i);
  });

  it("AS-002: ≤600 renders a full-screen sheet; ≥601 renders a centered modal", async () => {
    // ≥601 → modal
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 768 });
    const { unmount } = renderDialog();
    expect((await screen.findByTestId("share-dialog")).getAttribute("data-variant")).toBe("modal");
    unmount();

    // ≤600 → full-screen sheet
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 360 });
    renderDialog();
    expect((await screen.findByTestId("share-dialog")).getAttribute("data-variant")).toBe("sheet");
  });

  it("AS-003: a commenter is NOT shown the editable dialog (read-only surface, no controls)", async () => {
    renderDialog({ effectiveRole: "commenter" });
    await screen.findByTestId("share-dialog");
    // No editable sections — the conservative read-only surface instead (C-002).
    await screen.findByTestId("share-readonly");
    expect(screen.queryByTestId("share-sections")).not.toBeInTheDocument();
  });

  it("AS-004: an editor sees the editable dialog only when editorsCanShare is on", async () => {
    // editorsCanShare ON → editable.
    getShareState.mockImplementation(async () => ({
      data: { ...RESTRICTED_OWNER_STATE, editorsCanShare: true },
      error: null,
    }));
    const { unmount } = renderDialog({ effectiveRole: "editor" });
    await screen.findByTestId("share-dialog");
    await screen.findByTestId("share-sections");
    expect(screen.queryByTestId("share-readonly")).not.toBeInTheDocument();
    unmount();

    // editorsCanShare OFF → no editable dialog, read-only surface.
    getShareState.mockImplementation(async () => ({
      data: { ...RESTRICTED_OWNER_STATE, editorsCanShare: false },
      error: null,
    }));
    renderDialog({ effectiveRole: "editor" });
    await screen.findByTestId("share-dialog");
    await screen.findByTestId("share-readonly");
    expect(screen.queryByTestId("share-sections")).not.toBeInTheDocument();
  });

  it("AS-018: the dialog reads …/share and shows the doc's CURRENT state, not a blank form", async () => {
    getShareState.mockImplementation(async () => ({ data: LINK_STATE, error: null }));
    renderDialog({ effectiveRole: "owner" });

    await screen.findByTestId("share-sections");
    // level + role from the read
    expect(screen.getByTestId("share-access-level")).toHaveTextContent(/anyone in workspace|anyone with link/i);
    expect(screen.getByTestId("share-access-role")).toHaveTextContent(/commenter/i);
    // guest on
    expect(screen.getByTestId("share-guest-state")).toHaveAttribute("data-on", "1");
    // editorsCanShare reflected
    expect(screen.getByTestId("share-editors-can-share-state")).toHaveAttribute("data-on", "0");
    // Link section present (anyone-with-link) with the URL + a password set
    expect(screen.getByTestId("share-link-url")).toHaveTextContent("anchord.local/d/web-core?k=9f2a");
    expect(screen.getByTestId("share-link-password")).toHaveAttribute("data-on", "1");
    // people: 1 active + 1 pending (+ owner) — the pending one carries a Pending tag
    expect(screen.getByTestId("share-person-dev@acme.com")).toBeInTheDocument();
    expect(screen.getByTestId("share-person-pending-bob@x.com")).toBeInTheDocument();
    expect(screen.queryByTestId("share-person-pending-dev@acme.com")).not.toBeInTheDocument();
  });

  // C-002: the pure manage-eligibility gate (mirror of backend C-007).
  it("C-002: canManageShare — owner always; editor only when editorsCanShare; others/absent never", () => {
    expect(canManageShare("owner", false)).toBe(true);
    expect(canManageShare("owner", true)).toBe(true);
    expect(canManageShare("editor", true)).toBe(true);
    expect(canManageShare("editor", false)).toBe(false);
    expect(canManageShare("commenter", true)).toBe(false);
    expect(canManageShare("viewer", true)).toBe(false);
    expect(canManageShare(undefined, true)).toBe(false); // absent → conservative
  });
});

describe("sharing-permissions-ui S-001 — docs-list ⋯ entry (AS-019)", () => {
  // The doc-card ⋯ now opens a menu (Share · Move · Copy) instead of MoveCopy directly; Share opens
  // the same ShareDialog for that doc. The docs client is mocked so the card renders standalone.
  const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });
  mock.module("../src/features/docs/client", () => ({
    moveDoc: mock(async () => env({})),
    copyDoc: mock(async () => env({})),
  }));

  it("AS-019: the doc-card ⋯ menu offers Share · Move · Copy; Share opens the dialog for that doc", async () => {
    const { DocMoreMenu } = await import("../src/features/docs/move-copy-dialog");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const doc = {
      id: "d1",
      slug: "auth-spec",
      title: "Auth Spec",
      kind: "markdown" as const,
      version: 1,
      commentCount: 0,
      authorName: "Me",
      status: "draft" as const,
      projectId: "p-bill",
      projectName: "Billing",
    };
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <DocMoreMenu
            doc={doc}
            workspaceId="ws-acme"
            projects={[{ id: "p-bill", name: "Billing", isDefault: true, archived: false }]}
            effectiveRole="owner"
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // The ⋯ opens a MENU (no longer the MoveCopy dialog directly).
    await userEvent.click(screen.getByTestId("doc-more-auth-spec"));
    await screen.findByTestId("doc-more-share-auth-spec");
    expect(screen.getByTestId("doc-more-move-auth-spec")).toBeInTheDocument();
    expect(screen.getByTestId("doc-more-copy-auth-spec")).toBeInTheDocument();
    expect(screen.queryByTestId("move-copy-dialog")).not.toBeInTheDocument();

    // Choosing Share opens the ShareDialog for THIS doc (reads its share state).
    await userEvent.click(screen.getByTestId("doc-more-share-auth-spec"));
    await screen.findByTestId("share-dialog");
    await waitFor(() => expect(getShareState).toHaveBeenCalledWith("ws-acme", "auth-spec"));
  });
});
