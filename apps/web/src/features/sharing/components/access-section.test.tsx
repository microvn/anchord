import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// sharing-permissions-ui S-002 — Set general access + role + guest commenting. The sharing Eden
// client (`setAccess` write + `getShareState` prefill read) is MOCKED so the optimistic-then-revert
// path (C-005) is deterministic. AccessSection is exercised directly for the pure-derived behaviour
// (guest gating C-001, owner-only editors_can_share C-003, role options C-004) and the
// optimistic/rollback writes (AS-005/006/008/009); the Link-section reveal half of AS-005 is
// exercised through the full ShareDialog. Pixel/responsive layout is [→MANUAL].

import * as sharingClient from "@/features/sharing/client";

const setAccess = mock(async () => ({ data: OK_RESULT, error: null as unknown }));
const getShareState = mock(async () => ({ data: RESTRICTED_OWNER_STATE, error: null as unknown }));

mock.module("@/features/sharing/client", () => ({
  ...sharingClient,
  setAccess,
  getShareState,
}));

// Stub the toast so a missing Toaster host doesn't error + so we can assert the error toast (AS-006).
const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }),
}));

const OK_RESULT = {
  level: "anyone_with_link" as const,
  role: "commenter" as const,
  guestCommenting: false,
  editorsCanShare: false,
};

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

const { AccessSection } = await import("@/features/sharing/components/access-section");
const { ShareDialog } = await import("@/features/sharing/components/share-dialog");

beforeEach(() => {
  setAccess.mockClear();
  toastError.mockClear();
  getShareState.mockClear();
  setAccess.mockImplementation(async () => ({ data: OK_RESULT, error: null }));
  getShareState.mockImplementation(async () => ({ data: RESTRICTED_OWNER_STATE, error: null }));
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1440 });
});

function renderSection(
  overrides: Partial<Parameters<typeof AccessSection>[0]> = {},
  initialOverrides: Partial<typeof RESTRICTED_OWNER_STATE> = {},
) {
  return render(
    <AccessSection
      workspaceId="ws-acme"
      slug="web-core"
      initial={{ ...RESTRICTED_OWNER_STATE, ...initialOverrides }}
      effectiveRole="owner"
      {...overrides}
    />,
  );
}

describe("sharing-permissions-ui S-002 — set general access + role + guest commenting", () => {
  it("AS-005: selecting Anyone-with-link + role commenter calls PUT /access with the new state", async () => {
    renderSection();

    // select Anyone-with-link
    await userEvent.click(screen.getByTestId("share-access-opt-anyone_with_link"));
    await waitFor(() =>
      expect(setAccess).toHaveBeenCalledWith(
        "ws-acme",
        "web-core",
        expect.objectContaining({ level: "anyone_with_link" }),
      ),
    );

    // the segmented control + hint reflect the new state
    expect(screen.getByTestId("share-access-opt-anyone_with_link")).toHaveAttribute("data-active", "1");
    expect(screen.getByTestId("share-access-hint")).toHaveTextContent(/anyone with the link/i);

    // change role to commenter via the Select
    await userEvent.click(screen.getByTestId("share-access-role-trigger"));
    await userEvent.click(await screen.findByRole("option", { name: "Commenter" }));
    await waitFor(() =>
      expect(setAccess).toHaveBeenLastCalledWith(
        "ws-acme",
        "web-core",
        expect.objectContaining({ level: "anyone_with_link", role: "commenter" }),
      ),
    );
  });

  it("AS-005: on success the Link section becomes visible in the dialog", async () => {
    render(
      <ShareDialog
        open
        onOpenChange={() => {}}
        workspaceId="ws-acme"
        slug="web-core"
        docTitle="Web-core spec"
        effectiveRole="owner"
      />,
    );
    await screen.findByTestId("share-sections");
    // restricted → no Link section yet (C-007)
    expect(screen.queryByTestId("share-sec-link")).not.toBeInTheDocument();
    // pick Anyone-with-link → Link section appears
    await userEvent.click(screen.getByTestId("share-access-opt-anyone_with_link"));
    await screen.findByTestId("share-sec-link");
  });

  it("AS-006: a refused PUT /access reverts the segmented control + role and shows an error toast", async () => {
    setAccess.mockImplementation(async () => ({ data: null, error: { status: 403 } }));
    renderSection({}, { level: "restricted", role: "viewer" });

    // optimistic flip to anyone-with-link
    await userEvent.click(screen.getByTestId("share-access-opt-anyone_with_link"));

    // it reverts to the prior value (restricted active again) and an error toast fires; no partial state
    await waitFor(() =>
      expect(screen.getByTestId("share-access-opt-restricted")).toHaveAttribute("data-active", "1"),
    );
    expect(screen.getByTestId("share-access-opt-anyone_with_link")).toHaveAttribute("data-active", "0");
    expect(toastError).toHaveBeenCalledWith("Couldn't update access");
  });

  it("AS-007: the access role dropdown offers ONLY viewer | commenter | editor — never owner", async () => {
    renderSection();
    await userEvent.click(screen.getByTestId("share-access-role-trigger"));
    await screen.findByRole("option", { name: "Viewer" });
    expect(screen.getByRole("option", { name: "Commenter" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Editor" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Owner" })).not.toBeInTheDocument();
    // exactly three options
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("AS-008: guest toggle is disabled off anyone-with-link and enabled once it is selected; enabling sends guestCommenting", async () => {
    renderSection({}, { level: "restricted" });

    // restricted → disabled, with the gated hint
    const guest = screen.getByTestId("share-guest-toggle");
    expect(guest).toBeDisabled();
    expect(screen.getByTestId("share-sec-guest")).toHaveTextContent(/available only for anyone with link/i);

    // switch to anyone-with-link → guest becomes enabled
    await userEvent.click(screen.getByTestId("share-access-opt-anyone_with_link"));
    await waitFor(() => expect(screen.getByTestId("share-guest-toggle")).not.toBeDisabled());

    // enabling guest sends guestCommenting: true on PUT /access
    await userEvent.click(screen.getByTestId("share-guest-toggle"));
    await waitFor(() =>
      expect(setAccess).toHaveBeenLastCalledWith(
        "ws-acme",
        "web-core",
        expect.objectContaining({ guestCommenting: true }),
      ),
    );
  });

  it("AS-009: editors_can_share is owner-editable (sends editorsCanShare) and read-only for an editor", async () => {
    // owner → editable toggle that sends editorsCanShare on PUT
    const { unmount } = renderSection({ effectiveRole: "owner" });
    const toggle = screen.getByTestId("share-editors-can-share-toggle");
    expect(toggle).toBeInTheDocument();
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(setAccess).toHaveBeenLastCalledWith(
        "ws-acme",
        "web-core",
        expect.objectContaining({ editorsCanShare: true }),
      ),
    );
    unmount();

    // editor (managing via editors_can_share) → read-only, no editable toggle, never sends editorsCanShare
    setAccess.mockClear();
    renderSection({ effectiveRole: "editor" }, { editorsCanShare: true });
    expect(screen.queryByTestId("share-editors-can-share-toggle")).not.toBeInTheDocument();
    expect(screen.getByTestId("share-editors-can-share-readonly")).toBeInTheDocument();
    // changing another control as an editor must NOT carry editorsCanShare
    await userEvent.click(screen.getByTestId("share-access-opt-anyone_with_link"));
    await waitFor(() => expect(setAccess).toHaveBeenCalled());
    expect(setAccess.mock.calls[0]?.[2]).not.toHaveProperty("editorsCanShare");
  });
});
