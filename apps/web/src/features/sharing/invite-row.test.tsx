import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// sharing-permissions-ui S-003 — Invite by email with role + message. The sharing Eden client
// (`invitePerson` write + `getShareState` prefill read) is MOCKED so the optimistic-add /
// reconcile / rollback path is deterministic. Exercised through the full ShareDialog (owner →
// editable sections shown) so the people-list reconcile is end-to-end. AS-010 active row,
// AS-011 pending tag, AS-012 inline email block (no request), AS-013 refused → optimistic row
// removed + error toast.

import * as sharingClient from "@/features/sharing/client";

const invitePerson = mock(async () => ({ data: { status: "active" }, error: null as unknown }));
const getShareState = mock(async () => ({ data: OWNER_STATE, error: null as unknown }));
const setAccess = mock(async () => ({ data: OWNER_STATE, error: null as unknown }));

mock.module("@/features/sharing/client", () => ({
  ...sharingClient,
  invitePerson,
  getShareState,
  setAccess,
}));

const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }),
}));

// An owner on an anyone-with-link doc → the editable ShareDialog (incl. the invite row) renders.
const OWNER_STATE = {
  level: "anyone_with_link" as const,
  role: "commenter" as const,
  guestCommenting: false,
  editorsCanShare: false,
  people: [
    { userId: "u-own", email: "owner@acme.com", name: "Owner Olu", role: "owner" as const, status: "active" as const },
  ],
  link: { hasPassword: false, url: "anchord.local/d/web-core" },
};

const { ShareDialog } = await import("@/features/sharing/share-dialog");

beforeEach(() => {
  invitePerson.mockClear();
  getShareState.mockClear();
  setAccess.mockClear();
  toastError.mockClear();
  invitePerson.mockImplementation(async () => ({ data: { status: "active" }, error: null }));
  getShareState.mockImplementation(async () => ({ data: OWNER_STATE, error: null }));
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
  // wait for the prefill read → editable sections (the invite row mounts inside them).
  return screen.findByTestId("invite-row");
}

describe("Sharing S-003 — invite by email", () => {
  it("AS-010: inviting an existing account calls POST /invites and adds an active row (no Pending tag)", async () => {
    invitePerson.mockImplementation(async () => ({ data: { status: "active" }, error: null }));
    const user = userEvent.setup();
    await openedDialog();

    await user.type(screen.getByTestId("invite-email"), "dev@acme.com");
    await user.click(screen.getByTestId("invite-role-editor"));
    await user.type(screen.getByTestId("invite-message"), "please review");
    await user.click(screen.getByTestId("invite-submit"));

    await waitFor(() => expect(invitePerson).toHaveBeenCalledTimes(1));
    // POST body carries email + role:editor + the message.
    const [, , body] = invitePerson.mock.calls[0] as unknown as [string, string, { email: string; role: string; message?: string }];
    expect(body).toEqual({ email: "dev@acme.com", role: "editor", message: "please review" });

    // The row appears in the people list, with NO Pending tag.
    const row = await screen.findByTestId("share-person-dev@acme.com");
    expect(within(row).getByText("Editor")).toBeInTheDocument();
    expect(screen.queryByTestId("share-person-pending-dev@acme.com")).toBeNull();
  });

  it("AS-011: inviting a no-account email shows the row with a Pending tag", async () => {
    invitePerson.mockImplementation(async () => ({ data: { status: "pending" }, error: null }));
    const user = userEvent.setup();
    await openedDialog();

    await user.type(screen.getByTestId("invite-email"), "bob@x.com");
    await user.click(screen.getByTestId("invite-submit"));

    await waitFor(() => expect(invitePerson).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("share-person-pending-bob@x.com")).toBeInTheDocument();
  });

  it("AS-012 / C-006: a malformed email is blocked inline and never sends a request", async () => {
    const user = userEvent.setup();
    await openedDialog();

    await user.type(screen.getByTestId("invite-email"), "not-an-email");
    await user.click(screen.getByTestId("invite-submit"));

    // Inline validation error shows; the request is never made.
    expect(await screen.findByTestId("invite-email-error")).toHaveTextContent("Enter a valid email address");
    expect(invitePerson).not.toHaveBeenCalled();
  });

  it("AS-013 / C-005: a refused invite removes the optimistic row and shows an error", async () => {
    invitePerson.mockImplementation(async () => ({ data: null, error: { status: 403 } }));
    const user = userEvent.setup();
    await openedDialog();

    await user.type(screen.getByTestId("invite-email"), "dev@acme.com");
    await user.click(screen.getByTestId("invite-submit"));

    await waitFor(() => expect(invitePerson).toHaveBeenCalledTimes(1));
    // The optimistically-added row is removed; the error toast fired; the list is back to just the owner.
    await waitFor(() => expect(screen.queryByTestId("share-person-dev@acme.com")).toBeNull());
    expect(toastError).toHaveBeenCalled();
    expect(screen.getByTestId("share-person-owner@acme.com")).toBeInTheDocument();
  });
});
