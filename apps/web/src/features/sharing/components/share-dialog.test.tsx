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
import * as sharingClient from "@/features/sharing/services/client";

const getShareState = mock(async () => ({ data: RESTRICTED_OWNER_STATE, error: null }));
// capability-share-link AS-027/AS-028: the in-session access write echoes the fresh capabilityUrl.
// The mock returns the RAW api-core ENVELOPE ({success,data,…}) exactly as Eden delivers it — the
// hook must `unwrapEnvelope` to reach capabilityUrl. A flat mock here hid the real bug (res.data was
// the envelope, so res.data.capabilityUrl was undefined and the link never surfaced in-session).
const setAccess = mock(async () => ({
  data: {
    success: true,
    data: { workspaceRole: "commenter", linkRole: "commenter", level: "anyone_with_link", editorsCanShare: false, capabilityUrl: "/s/Hk3vQ2pLm8rT5wXyZ0aBcD" },
  },
  error: null,
}));

mock.module("@/features/sharing/services/client", () => ({
  ...sharingClient,
  getShareState,
  setAccess,
}));

// Stub the toast so a missing Toaster host doesn't error under happy-dom.
mock.module("sonner", () => ({ toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) }) }));

const RESTRICTED_OWNER_STATE = {
  workspaceRole: null,
  linkRole: null,
  level: "restricted" as const,
  role: "viewer" as const,
  editorsCanShare: false,
  people: [
    { userId: "u-own", email: "owner@acme.com", name: "Owner Olu", role: "owner" as const, status: "active" as const },
  ],
  link: { hasPassword: false, url: "anchord.local/d/web-core" },
};

// A doc shared with the workspace at the comment level, no public link — the new-doc default.
const WORKSPACE_COMMENTER_STATE = {
  workspaceRole: "commenter" as const,
  linkRole: null,
  level: "anyone_in_workspace" as const,
  role: "viewer" as const,
  editorsCanShare: false,
  people: [
    { userId: "u-own", email: "owner@acme.com", name: "Owner Olu", role: "owner" as const, status: "active" as const },
  ],
  link: { hasPassword: false, url: "/d/web-core" },
  capabilityUrl: null,
};

// AS-018 prefill data: anyone-with-link / commenter, guest on, 1 active + 1 pending, password link.
const LINK_STATE = {
  workspaceRole: "commenter" as const,
  linkRole: "commenter" as const,
  level: "anyone_with_link" as const,
  role: "commenter" as const,
  editorsCanShare: false,
  people: [
    { userId: "u-own", email: "owner@acme.com", name: "Owner Olu", role: "owner" as const, status: "active" as const },
    { userId: "u-act", email: "dev@acme.com", name: "Dev Dana", role: "editor" as const, status: "active" as const },
    { email: "bob@x.com", role: "commenter" as const, status: "pending" as const },
  ],
  link: { hasPassword: true, expiresAt: "2026-07-01T00:00:00Z", viewLimit: 50, viewCount: 3, url: "/d/web-core?k=9f2a" },
  // capability-share-link S-005: an anyone_with_link doc carries the external /s/<token> link.
  capabilityUrl: "/s/Hk3vQ2pLm8rT5wXyZ0aBcD",
};

// AS-013 fixture: anyone_in_workspace — link section never shows, and crucially NO capability link
// even if the level were link-shaped. (capabilityUrl absent — the backend sends null for non-link.)
const WORKSPACE_STATE = {
  workspaceRole: "viewer" as const,
  linkRole: null,
  level: "anyone_in_workspace" as const,
  role: "viewer" as const,
  editorsCanShare: false,
  people: [
    { userId: "u-own", email: "owner@acme.com", name: "Owner Olu", role: "owner" as const, status: "active" as const },
  ],
  link: { hasPassword: false, url: "/d/web-core" },
  capabilityUrl: null,
};

const { ShareDialog } = await import("@/features/sharing/components/share-dialog");
const { canManageShare } = await import("@/features/sharing/services/client");

beforeEach(() => {
  getShareState.mockClear();
  getShareState.mockImplementation(async () => ({ data: RESTRICTED_OWNER_STATE, error: null }));
  setAccess.mockClear();
  // default desktop width (modal branch)
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1440 });
});

function renderDialog(props: Partial<Parameters<typeof ShareDialog>[0]> = {}) {
  // The dialog's prefill read goes through useApiQuery → needs a QueryClient host. retry:false so a
  // 403/500 mock is read exactly once (the gate/error assertions key off a single call).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <ShareDialog
        open
        onOpenChange={() => {}}
        workspaceId="ws-acme"
        slug="web-core"
        docTitle="Web-core spec"
        effectiveRole="owner"
        {...props}
      />
    </QueryClientProvider>,
  );
}

// Open an axis Select (workspace | link) and pick an option by its visible label (Off | Viewer |
// Commenter | Editor). The axis controls are Radix Selects (role=option in the listbox).
async function chooseAxisRole(axis: "workspace" | "link", label: string) {
  await userEvent.click(screen.getByTestId(`share-axis-${axis}-trigger`));
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

describe("sharing-permissions-ui S-001 — open the Share dialog", () => {
  it("AS-001: owner opens the share dialog showing the sections, prefilled from current state", async () => {
    renderDialog({ effectiveRole: "owner" });

    // The dialog opened and read the share state.
    await screen.findByTestId("share-dialog");
    await waitFor(() => expect(getShareState).toHaveBeenCalledWith("ws-acme", "web-core"));

    // Two tabs (Sharing default · Options); the Sharing tab shows access + people.
    expect(screen.getByTestId("share-tab-sharing")).toHaveAttribute("data-active", "1");
    expect(screen.getByTestId("share-tab-options")).toBeInTheDocument();
    await screen.findByTestId("share-sec-access");
    expect(screen.getByTestId("share-sec-people")).toBeInTheDocument();
    // guest commenting lives on the Options tab now, not the Sharing tab.
    expect(screen.queryByTestId("share-sec-guest")).not.toBeInTheDocument();

    // Prefilled from the CURRENT state — restricted = both axes Off, not a blank form.
    expect(screen.getByTestId("share-axis-workspace")).toHaveAttribute("data-on", "0");
    expect(screen.getByTestId("share-axis-link")).toHaveAttribute("data-on", "0");
    // The title is the doc-scoped "Share doc" header.
    expect(screen.getByTestId("share-dialog")).toHaveTextContent(/share doc/i);
  });

  it("AS-018: reopening the dialog REFETCHES current state (staleTime:0, not a 30s-cached snapshot)", async () => {
    // Regression: a member role-change / remove updates local state + the server but NOT this query's
    // cache. With the global 30s staleTime, closing + reopening within 30s re-served the STALE role
    // (the "still Editor after switching to Viewer" bug). staleTime:0 forces a refetch on every reopen.
    // A shared QueryClient with the GLOBAL 30s staleTime — only the dialog's per-query staleTime:0 can
    // make the reopen refetch; if the override regresses, the second open serves cache → 1 call → fail.
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    const wrap = (open: boolean) => (
      <QueryClientProvider client={qc}>
        <ShareDialog open={open} onOpenChange={() => {}} workspaceId="ws-acme" slug="web-core" docTitle="Web-core spec" effectiveRole="owner" />
      </QueryClientProvider>
    );
    const { rerender } = render(wrap(true));
    await screen.findByTestId("share-sections");
    await waitFor(() => expect(getShareState).toHaveBeenCalledTimes(1));
    rerender(wrap(false)); // Done → close
    rerender(wrap(true)); // reopen → must refetch despite the 30s global staleTime
    await waitFor(() => expect(getShareState).toHaveBeenCalledTimes(2));
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

  it("AS-003: a REFUSED (403) share read renders the read-only surface (lazy gate), not share-error", async () => {
    // The gated GET …/share is refused server-side → the dialog shows the "can't manage" surface,
    // distinct from a generic load error (C-002, reworked 2026-06-13). effectiveRole is irrelevant
    // to the gate now — the READ result decides.
    getShareState.mockImplementation(async () => ({ data: null, error: { status: 403 } }));
    renderDialog({ effectiveRole: "commenter" });
    await screen.findByTestId("share-dialog");
    // The forbidden read → read-only surface, never the editable sections, never the generic error.
    await screen.findByTestId("share-readonly");
    expect(screen.queryByTestId("share-sections")).not.toBeInTheDocument();
    expect(screen.queryByTestId("share-error")).not.toBeInTheDocument();
  });

  it("AS-004: a SUCCESSFUL share read renders the editable sections regardless of effectiveRole", async () => {
    // A successful gated read PROVES manage-eligibility (the backend gated it identically to the
    // writes). The dialog no longer pre-decides from effectiveRole — even a missing/viewer role
    // shows the editable controls when the read succeeded.
    getShareState.mockImplementation(async () => ({ data: RESTRICTED_OWNER_STATE, error: null }));
    const { unmount } = renderDialog({ effectiveRole: "editor" });
    await screen.findByTestId("share-dialog");
    await screen.findByTestId("share-sections");
    expect(screen.queryByTestId("share-readonly")).not.toBeInTheDocument();
    unmount();

    // Even an absent effectiveRole → a successful read still yields editable controls.
    renderDialog({ effectiveRole: undefined });
    await screen.findByTestId("share-dialog");
    await screen.findByTestId("share-sections");
    expect(screen.queryByTestId("share-readonly")).not.toBeInTheDocument();
  });

  it("a non-403 read failure (network/500) keeps the generic retryable error surface", async () => {
    getShareState.mockImplementation(async () => ({ data: null, error: { status: 500 } }));
    renderDialog({ effectiveRole: "owner" });
    await screen.findByTestId("share-dialog");
    await screen.findByTestId("share-error");
    expect(screen.queryByTestId("share-readonly")).not.toBeInTheDocument();
    expect(screen.queryByTestId("share-sections")).not.toBeInTheDocument();
  });

  it("AS-018: the dialog reads …/share and shows the doc's CURRENT state, not a blank form", async () => {
    getShareState.mockImplementation(async () => ({ data: LINK_STATE, error: null }));
    renderDialog({ effectiveRole: "owner" });

    await screen.findByTestId("share-sections");
    // SHARING tab: both axes from the read — workspace=commenter, link=commenter (both On).
    expect(screen.getByTestId("share-axis-workspace")).toHaveAttribute("data-on", "1");
    expect(screen.getByTestId("share-axis-workspace-trigger")).toHaveTextContent(/commenter/i);
    expect(screen.getByTestId("share-axis-link")).toHaveAttribute("data-on", "1");
    expect(screen.getByTestId("share-axis-link-trigger")).toHaveTextContent(/commenter/i);
    // people: 1 active + 1 pending (+ owner) — the pending one carries a Pending tag
    expect(screen.getByTestId("share-person-dev@acme.com")).toBeInTheDocument();
    expect(screen.getByTestId("share-person-pending-bob@x.com")).toBeInTheDocument();
    expect(screen.queryByTestId("share-person-pending-dev@acme.com")).not.toBeInTheDocument();
    // SHARING tab: the link section appears inline (AS-005) once shared by link — the protection
    // chips reflect the read (password set). The readable /d/<slug> is NOT shown as a copyable link.
    expect(screen.getByTestId("share-sec-link-protection")).toBeInTheDocument();
    expect(screen.queryByTestId("share-link-url")).not.toBeInTheDocument();
    expect(screen.getByTestId("share-link-password")).toHaveAttribute("data-on", "1");

    // OPTIONS tab: no guest-commenting toggle (removed 2026-06-20 — link role is the grant);
    // editors-can-share reflected.
    await userEvent.click(screen.getByTestId("share-tab-options"));
    expect(await screen.findByTestId("share-editors-can-share-toggle")).toHaveAttribute("data-on", "0");
    expect(screen.queryByTestId("share-guest-toggle")).not.toBeInTheDocument();
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

describe("capability-share-link S-005 — the Share box surfaces the capability link", () => {
  it("AS-012: an anyone-with-link doc shows the capability /s/<token> link with a copy control, distinct from /d/<slug>", async () => {
    getShareState.mockImplementation(async () => ({ data: LINK_STATE, error: null }));
    renderDialog({ effectiveRole: "owner" });

    await screen.findByTestId("share-sections");
    // The EXTERNAL capability link is shown — the /s/<token> form, resolved absolute against origin.
    const cap = await screen.findByTestId("share-capability-url");
    expect(cap).toHaveTextContent("/s/Hk3vQ2pLm8rT5wXyZ0aBcD");
    // It is presented as the external share link, DISTINCT from the in-app readable /d/<slug> address.
    expect(cap).not.toHaveTextContent("/d/web-core");
    // The readable /d/<slug> is no longer surfaced as a second copyable link (C-009 — don't leak the slug).
    expect(screen.queryByTestId("share-link-url")).not.toBeInTheDocument();

    // A copy control sits with it and writes the absolute capability URL to the clipboard.
    const writeText = mock(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await userEvent.click(screen.getByTestId("share-capability-copy"));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain("/s/Hk3vQ2pLm8rT5wXyZ0aBcD");
  });

  it("AS-013: a restricted doc shows NO capability link", async () => {
    getShareState.mockImplementation(async () => ({ data: RESTRICTED_OWNER_STATE, error: null }));
    renderDialog({ effectiveRole: "owner" });

    await screen.findByTestId("share-sections");
    // Restricted → not link-shared → no capability link section at all.
    expect(screen.queryByTestId("share-sec-capability-link")).not.toBeInTheDocument();
    expect(screen.queryByTestId("share-capability-url")).not.toBeInTheDocument();
  });

  it("AS-013: an anyone-in-workspace doc shows NO capability link", async () => {
    getShareState.mockImplementation(async () => ({ data: WORKSPACE_STATE, error: null }));
    renderDialog({ effectiveRole: "owner" });

    await screen.findByTestId("share-sections");
    expect(screen.queryByTestId("share-sec-capability-link")).not.toBeInTheDocument();
    expect(screen.queryByTestId("share-capability-url")).not.toBeInTheDocument();
  });

  it("AS-027: turning the link axis on in-session surfaces the /s/<token> link from the write response", async () => {
    // Opened on a RESTRICTED doc — the share-state read carries no capabilityUrl → no link yet.
    getShareState.mockImplementation(async () => ({ data: RESTRICTED_OWNER_STATE, error: null }));
    setAccess.mockImplementation(async () => ({
      data: { workspaceRole: null, linkRole: "viewer", level: "anyone_with_link", editorsCanShare: false, capabilityUrl: "/s/Hk3vQ2pLm8rT5wXyZ0aBcD" },
      error: null,
    }));
    renderDialog({ effectiveRole: "owner" });

    await screen.findByTestId("share-sections");
    expect(screen.queryByTestId("share-capability-url")).not.toBeInTheDocument();

    // Turn the LINK axis on (set it to Viewer) from WITHIN the open dialog.
    await chooseAxisRole("link", "Viewer");

    // The capability link now appears, sourced from the write's fresh token (not a re-open).
    const cap = await screen.findByTestId("share-capability-url");
    expect(cap).toHaveTextContent("/s/Hk3vQ2pLm8rT5wXyZ0aBcD");
  });

  it("AS-028: turning the link axis off in-session removes the capability link", async () => {
    // Opened on an anyone-with-link doc — the link is shown.
    getShareState.mockImplementation(async () => ({ data: LINK_STATE, error: null }));
    setAccess.mockImplementation(async () => ({
      data: { workspaceRole: "commenter", linkRole: null, level: "anyone_in_workspace", editorsCanShare: false, capabilityUrl: null },
      error: null,
    }));
    renderDialog({ effectiveRole: "owner" });

    await screen.findByTestId("share-sections");
    await screen.findByTestId("share-capability-url");

    // Turn the LINK axis Off from WITHIN the open dialog.
    await chooseAxisRole("link", "Off");

    // The capability link disappears (the write returned capabilityUrl null).
    await waitFor(() => expect(screen.queryByTestId("share-capability-url")).not.toBeInTheDocument());
  });
});

describe("sharing-permissions-ui S-001 — docs-list ⋯ entry (AS-019)", () => {
  // The doc-card ⋯ now opens a menu (Share · Move · Copy) instead of MoveCopy directly; Share opens
  // the same ShareDialog for that doc. The docs client is mocked so the card renders standalone.
  const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });
  mock.module("@/features/docs/services/client", () => ({
    moveDoc: mock(async () => env({})),
    copyDoc: mock(async () => env({})),
    fetchWorkspaceDocs: mock(async () => env({ docs: [], projects: [] })),
  }));

  it("AS-019: the ⋯ Share item shows UNCONDITIONALLY (no manager effectiveRole); Share opens the dialog for that doc", async () => {
    const { DocMoreMenu } = await import("@/features/docs/components/move-copy-dialog");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
    const doc = {
      id: "d1",
      slug: "auth-spec",
      title: "Auth Spec",
      kind: "markdown" as const,
      version: 1,
      annotationCount: 0,
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

describe("doc-access-two-axis S-007 — the share dialog shows two independent controls", () => {
  it("AS-023: the dialog presents Workspace access and Link access as two separate controls, each with a role choice + an off option, prefilled from the two-axis state", async () => {
    // The doc is shared with the workspace at the comment level, no public link (the new-doc
    // default): workspace=commenter, link=off.
    getShareState.mockImplementation(async () => ({ data: WORKSPACE_COMMENTER_STATE, error: null }));
    renderDialog({ effectiveRole: "owner" });

    await screen.findByTestId("share-sections");

    // TWO separate controls exist — a Workspace access control AND a Link access control.
    const workspace = screen.getByTestId("share-axis-workspace");
    const link = screen.getByTestId("share-axis-link");
    expect(workspace).toBeInTheDocument();
    expect(link).toBeInTheDocument();

    // Each prefills from the doc's current two-axis state: workspace ON at Commenter, link OFF.
    expect(workspace).toHaveAttribute("data-on", "1");
    expect(screen.getByTestId("share-axis-workspace-trigger")).toHaveTextContent(/commenter/i);
    expect(link).toHaveAttribute("data-on", "0");
    expect(screen.getByTestId("share-axis-link-trigger")).toHaveTextContent(/off/i);

    // Each control offers its own role choice (viewer/commenter/editor) AND an off option — open the
    // link Select and assert all four, owner NEVER among them (C-004/C-009).
    await userEvent.click(screen.getByTestId("share-axis-link-trigger"));
    await screen.findByRole("option", { name: "Off" });
    expect(screen.getByRole("option", { name: "Viewer" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Commenter" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Editor" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Owner" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(4);
  });

  it("AS-024: setting link access lower than workspace access persists both independently — the PUT sends ONLY the link axis and the workspace axis is unchanged (C-001 FE-side)", async () => {
    // Workspace access = commenter, link off. The write echoes both axes back: workspace STILL
    // commenter, link now viewer (the backend persisted both independently).
    getShareState.mockImplementation(async () => ({ data: WORKSPACE_COMMENTER_STATE, error: null }));
    setAccess.mockImplementation(async () => ({
      data: { workspaceRole: "commenter", linkRole: "viewer", level: "anyone_with_link", editorsCanShare: false, capabilityUrl: "/s/Hk3vQ2pLm8rT5wXyZ0aBcD" },
      error: null,
    }));
    renderDialog({ effectiveRole: "owner" });

    await screen.findByTestId("share-sections");

    // Set LINK access = viewer (lower than the workspace commenter).
    await chooseAxisRole("link", "Viewer");

    // The PUT carries ONLY the link axis — the workspace axis is NOT in the request (C-001/C-011):
    // changing one control never sends (or reverts) the other.
    await waitFor(() => expect(setAccess).toHaveBeenCalled());
    const body = setAccess.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(body).toHaveProperty("linkRole", "viewer");
    expect(body).not.toHaveProperty("workspaceRole");

    // The dialog reflects BOTH after the save: workspace STILL commenter, link now viewer — neither
    // control overrode the other.
    await waitFor(() =>
      expect(screen.getByTestId("share-axis-link-trigger")).toHaveTextContent(/viewer/i),
    );
    expect(screen.getByTestId("share-axis-workspace")).toHaveAttribute("data-on", "1");
    expect(screen.getByTestId("share-axis-workspace-trigger")).toHaveTextContent(/commenter/i);
    expect(screen.getByTestId("share-axis-link")).toHaveAttribute("data-on", "1");
  });
});
