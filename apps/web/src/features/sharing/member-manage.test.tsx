import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// sharing-permissions-ui S-006 — Change or remove a person in the share list. The sharing Eden
// client (`changeMemberRole` / `removeMember` writes + `getShareState` prefill read) is MOCKED so
// the optimistic role-change / remove + reconcile/rollback paths are deterministic. Exercised
// through the full ShareDialog (a successful read → editable sections, so the people list mounts
// with its per-row controls). AS-020 role change → PATCH, AS-021 refused PATCH → revert + toast,
// AS-022 remove → DELETE + row gone, AS-023 refused DELETE → row restored + toast. The owner row
// has no role dropdown and no Remove control (C-004).

import * as sharingClient from "@/features/sharing/client";

const changeMemberRole = mock(async () => ({ data: { role: "editor" }, error: null as unknown }));
const removeMember = mock(async () => ({ data: { removed: true }, error: null as unknown }));
const getShareState = mock(async () => ({ data: STATE, error: null as unknown }));

mock.module("@/features/sharing/client", () => ({
  ...sharingClient,
  changeMemberRole,
  removeMember,
  getShareState,
}));

const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }),
}));

// An owner on an anyone-with-link doc: owner + an active commenter member (with a member id) + a
// pending invite (also with an id). The member id is what the PATCH/DELETE routes target.
const STATE = {
  level: "anyone_with_link" as const,
  role: "commenter" as const,
  guestCommenting: false,
  editorsCanShare: false,
  people: [
    { id: "m-own", userId: "u-own", email: "owner@acme.com", name: "Owner Olu", role: "owner" as const, status: "active" as const },
    { id: "m-dana", userId: "u-act", email: "dana@acme.com", name: "Dev Dana", role: "commenter" as const, status: "active" as const },
    { id: "m-bob", email: "bob@x.com", role: "viewer" as const, status: "pending" as const },
  ],
  link: { hasPassword: false, url: "anchord.local/d/web-core" },
};

const { ShareDialog } = await import("@/features/sharing/share-dialog");

beforeEach(() => {
  changeMemberRole.mockClear();
  removeMember.mockClear();
  getShareState.mockClear();
  toastError.mockClear();
  changeMemberRole.mockImplementation(async () => ({ data: { role: "editor" }, error: null }));
  removeMember.mockImplementation(async () => ({ data: { removed: true }, error: null }));
  getShareState.mockImplementation(async () => ({ data: STATE, error: null }));
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1440 });
});

function renderDialog() {
  return render(
    <ShareDialog
      open
      onOpenChange={() => {}}
      workspaceId="ws-1"
      slug="web-core"
      docTitle="Web Core"
      effectiveRole="owner"
    />,
  );
}

async function openedDialog() {
  renderDialog();
  return screen.findByTestId("share-sections");
}

describe("Sharing S-006 — change or remove a person", () => {
  it("AS-020: changing a member's role calls PATCH {role} and the row reflects it", async () => {
    const user = userEvent.setup();
    await openedDialog();

    const row = await screen.findByTestId("share-person-dana@acme.com");
    // open the role dropdown and pick editor.
    await user.click(within(row).getByTestId("share-person-role-trigger-dana@acme.com"));
    await user.click(await screen.findByTestId("share-person-role-opt-dana@acme.com-editor"));

    await waitFor(() => expect(changeMemberRole).toHaveBeenCalledTimes(1));
    const [ws, slug, memberId, role] = changeMemberRole.mock.calls[0] as unknown as [
      string,
      string,
      string,
      string,
    ];
    expect([ws, slug, memberId, role]).toEqual(["ws-1", "web-core", "m-dana", "editor"]);

    // the row reflects the new role optimistically.
    await waitFor(() =>
      expect(
        within(screen.getByTestId("share-person-dana@acme.com")).getByTestId(
          "share-person-role-trigger-dana@acme.com",
        ),
      ).toHaveTextContent("Editor"),
    );
  });

  it("AS-021 / C-005: a refused role change reverts the row and shows an error toast", async () => {
    changeMemberRole.mockImplementation(async () => ({ data: null, error: { status: 403 } }));
    const user = userEvent.setup();
    await openedDialog();

    const row = await screen.findByTestId("share-person-dana@acme.com");
    await user.click(within(row).getByTestId("share-person-role-trigger-dana@acme.com"));
    await user.click(await screen.findByTestId("share-person-role-opt-dana@acme.com-editor"));

    await waitFor(() => expect(changeMemberRole).toHaveBeenCalledTimes(1));
    // the role reverts to commenter; an error toast fired.
    await waitFor(() =>
      expect(
        within(screen.getByTestId("share-person-dana@acme.com")).getByTestId(
          "share-person-role-trigger-dana@acme.com",
        ),
      ).toHaveTextContent("Commenter"),
    );
    expect(toastError).toHaveBeenCalled();
  });

  it("AS-022: removing a person calls DELETE and the row disappears", async () => {
    const user = userEvent.setup();
    await openedDialog();

    const row = await screen.findByTestId("share-person-dana@acme.com");
    await user.click(within(row).getByTestId("share-person-remove-dana@acme.com"));

    await waitFor(() => expect(removeMember).toHaveBeenCalledTimes(1));
    const [ws, slug, memberId] = removeMember.mock.calls[0] as unknown as [string, string, string];
    expect([ws, slug, memberId]).toEqual(["ws-1", "web-core", "m-dana"]);

    await waitFor(() => expect(screen.queryByTestId("share-person-dana@acme.com")).toBeNull());
  });

  it("AS-023 / C-005: a refused removal restores the row and shows an error toast", async () => {
    removeMember.mockImplementation(async () => ({ data: null, error: { status: 403 } }));
    const user = userEvent.setup();
    await openedDialog();

    const row = await screen.findByTestId("share-person-dana@acme.com");
    await user.click(within(row).getByTestId("share-person-remove-dana@acme.com"));

    await waitFor(() => expect(removeMember).toHaveBeenCalledTimes(1));
    // the row is restored; an error toast fired.
    await waitFor(() => expect(screen.getByTestId("share-person-dana@acme.com")).toBeInTheDocument());
    expect(toastError).toHaveBeenCalled();
  });

  it("C-004: the owner row has no role dropdown and no Remove control", async () => {
    await openedDialog();
    const ownerRow = await screen.findByTestId("share-person-owner@acme.com");
    expect(within(ownerRow).queryByTestId("share-person-role-trigger-owner@acme.com")).toBeNull();
    expect(within(ownerRow).queryByTestId("share-person-remove-owner@acme.com")).toBeNull();
    // the owner still shows the static "Owner" label.
    expect(within(ownerRow).getByTestId("share-person-role-owner@acme.com")).toHaveTextContent("Owner");
  });
});
