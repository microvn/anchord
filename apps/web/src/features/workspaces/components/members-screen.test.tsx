import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// workspaces-ui S-003 — Manage workspace members (admin). Client wrapper MOCKED.
// AS-007 list members+pending; AS-008 invite by email; AS-009 remove; AS-010 change role;
// AS-011 non-admin sees NO manage controls; AS-012 invalid email rejected inline (RHF+Zod).
// Pixel/responsive [→MANUAL]; real round-trip [→E2E].

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

let members: unknown;
const fetchMembers = mock(async () => members);
const inviteMember = mock(async (_w: string, email: string, role: string) =>
  env({ id: "inv-new", status: "pending", email, role }),
);
const removeMember = mock(async (_w: string, userId: string) => env({ userId, removed: true }));
const revokeInvitation = mock(async (_w: string, _id: string) => env({ revoked: true }));
const changeMemberRole = mock(async (_w: string, userId: string, role: string) =>
  env({ userId, role }),
);

let bootstrap: unknown;
const fetchBootstrap = mock(async () => bootstrap);

mock.module("@/features/workspaces/services/client", () => ({
  fetchBootstrap,
  fetchMembers,
  inviteMember,
  removeMember,
  revokeInvitation,
  changeMemberRole,
  setActiveWorkspace: mock(async () => env({})),
  createWorkspace: mock(async () => env({})),
  renameWorkspace: mock(async () => env({})),
  acceptInvitation: mock(async () => env({})),
  rejectInvitation: mock(async () => env({})),
}));

const { MembersScreen } = await import("@/features/workspaces/components/members-screen");
const { WorkspaceRouteGuard } = await import("@/features/workspaces/components/active-workspace");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function App({ role }: { role: "admin" | "member" }) {
  bootstrap = env({
    userId: "me",
    activeWorkspaceId: "ws-acme",
    workspaces: [{ id: "ws-acme", name: "Acme", slug: "acme", role, adminName: "Me" }],
  });
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/w/ws-acme/members"]}>
        <Routes>
          <Route path="/w/:workspaceId" element={<WorkspaceRouteGuard />}>
            <Route path="members" element={<MembersScreen />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const directory = env({
  members: [
    { userId: "u-me", email: "me@acme.com", name: "Me", role: "admin" },
    { userId: "u-bob", email: "bob@acme.com", name: "Bob", role: "member" },
  ],
  invitations: [{ id: "inv-eve", email: "eve@acme.com", role: "member", status: "pending" }],
});

beforeEach(() => {
  fetchMembers.mockReset();
  fetchMembers.mockImplementation(async () => members);
  members = directory;
  inviteMember.mockClear();
  removeMember.mockClear();
  revokeInvitation.mockClear();
  changeMemberRole.mockClear();
});

describe("workspaces-ui S-003 — members screen", () => {
  it("AS-007: the admin sees members and pending invites", async () => {
    render(<App role="admin" />);
    expect(await screen.findByTestId("member-row-u-bob")).toHaveTextContent("bob@acme.com");
    // The pending invite for eve appears in the pending section WITH its status badge.
    const invite = screen.getByTestId("invite-row-inv-eve");
    expect(invite).toHaveTextContent("eve@acme.com");
    expect(screen.getByTestId("invite-status-inv-eve")).toHaveTextContent(/invited/i);
  });

  it("AS-008: the admin invites a member by email", async () => {
    // After inviting, the directory refetch includes the new pending invite for dev.
    render(<App role="admin" />);
    await screen.findByTestId("member-row-u-bob");

    fetchMembers.mockImplementation(async () =>
      env({
        members: [{ userId: "u-bob", email: "bob@acme.com", name: "Bob", role: "member" }],
        invitations: [
          { id: "inv-eve", email: "eve@acme.com", role: "member", status: "pending" },
          { id: "inv-dev", email: "dev@acme.com", role: "member", status: "pending" },
        ],
      }),
    );

    await userEvent.type(screen.getByTestId("invite-email"), "dev@acme.com");
    await userEvent.click(screen.getByTestId("invite-submit"));

    expect(inviteMember).toHaveBeenCalledWith("ws-acme", "dev@acme.com", "member");
    // The new pending invite appears in the list.
    await waitFor(() => expect(screen.getByTestId("invite-row-inv-dev")).toBeInTheDocument());
  });

  it("AS-009: the admin removes a member (after confirming in the AlertDialog)", async () => {
    render(<App role="admin" />);
    await screen.findByTestId("member-row-u-bob");

    fetchMembers.mockImplementation(async () =>
      env({
        members: [{ userId: "u-me", email: "me@acme.com", name: "Me", role: "admin" }],
        invitations: [],
      }),
    );

    // The trash icon opens a confirm dialog — it does NOT delete on its own.
    await userEvent.click(within(screen.getByTestId("member-row-u-bob")).getByTestId("remove-u-bob"));
    expect(removeMember).not.toHaveBeenCalled();

    // Only the destructive "Remove" action in the dialog runs the mutation.
    await userEvent.click(await screen.findByTestId("remove-confirm-u-bob"));
    expect(removeMember).toHaveBeenCalledWith("ws-acme", "u-bob");
    // Bob disappears from the list.
    await waitFor(() => expect(screen.queryByTestId("member-row-u-bob")).not.toBeInTheDocument());
  });

  it("AS-016: cancelling the remove confirm keeps the member", async () => {
    render(<App role="admin" />);
    await screen.findByTestId("member-row-u-bob");

    await userEvent.click(within(screen.getByTestId("member-row-u-bob")).getByTestId("remove-u-bob"));
    // Dismiss with the safe-default Cancel; the mutation must never fire.
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(removeMember).not.toHaveBeenCalled();
    expect(screen.getByTestId("member-row-u-bob")).toBeInTheDocument();
  });

  it("AS-017: revoking a pending invite requires confirmation", async () => {
    render(<App role="admin" />);
    await screen.findByTestId("invite-row-inv-eve");

    // After confirming, the directory refetch drops the revoked invite.
    fetchMembers.mockImplementation(async () =>
      env({
        members: [
          { userId: "u-me", email: "me@acme.com", name: "Me", role: "admin" },
          { userId: "u-bob", email: "bob@acme.com", name: "Bob", role: "member" },
        ],
        invitations: [],
      }),
    );

    // The ✕ opens a confirm dialog — it does NOT revoke on its own.
    await userEvent.click(screen.getByTestId("revoke-inv-eve"));
    expect(revokeInvitation).not.toHaveBeenCalled();

    // Only the "Revoke" action in the dialog runs the mutation. Revoke hits the invitations
    // endpoint with the INVITE id — not removeMember (an invite id is not a membership id).
    await userEvent.click(await screen.findByTestId("revoke-confirm-inv-eve"));
    expect(revokeInvitation).toHaveBeenCalledWith("ws-acme", "inv-eve");
    expect(removeMember).not.toHaveBeenCalled();
    // The pending invite disappears from the list.
    await waitFor(() => expect(screen.queryByTestId("invite-row-inv-eve")).not.toBeInTheDocument());
  });

  it("AS-010: the admin changes a member's role", async () => {
    render(<App role="admin" />);
    await screen.findByTestId("member-row-u-bob");

    fetchMembers.mockImplementation(async () =>
      env({
        members: [
          { userId: "u-me", email: "me@acme.com", name: "Me", role: "admin" },
          { userId: "u-bob", email: "bob@acme.com", name: "Bob", role: "admin" },
        ],
        invitations: [],
      }),
    );

    // Open the shadcn (Radix) Select for Bob and pick Admin.
    await userEvent.click(within(screen.getByTestId("member-row-u-bob")).getByTestId("role-u-bob"));
    await userEvent.click(await screen.findByRole("option", { name: "Admin" }));
    expect(changeMemberRole).toHaveBeenCalledWith("ws-acme", "u-bob", "admin");
    // Bob's role trigger now displays Admin.
    await waitFor(() =>
      expect(
        within(screen.getByTestId("member-row-u-bob")).getByTestId("role-u-bob"),
      ).toHaveTextContent("Admin"),
    );
  });

  it("AS-011: a non-admin cannot manage members (no invite/remove/change-role controls)", async () => {
    render(<App role="member" />);
    // A member sees a read-only / no-manage view: none of the management controls render.
    await waitFor(() => expect(screen.getByTestId("members-readonly")).toBeInTheDocument());
    expect(screen.queryByTestId("invite-email")).not.toBeInTheDocument();
    expect(screen.queryByTestId("invite-submit")).not.toBeInTheDocument();
    expect(screen.queryByTestId("remove-u-bob")).not.toBeInTheDocument();
    expect(screen.queryByTestId("role-u-bob")).not.toBeInTheDocument();
  });

  it("AS-012: an invalid invite email is rejected before sending (inline error, no invite created)", async () => {
    render(<App role="admin" />);
    await screen.findByTestId("member-row-u-bob");

    await userEvent.type(screen.getByTestId("invite-email"), "not-an-email");
    await userEvent.click(screen.getByTestId("invite-submit"));

    // Inline validation error shown; the invite endpoint is NEVER called.
    expect(await screen.findByTestId("invite-email-error")).toBeInTheDocument();
    expect(inviteMember).not.toHaveBeenCalled();
  });
});
