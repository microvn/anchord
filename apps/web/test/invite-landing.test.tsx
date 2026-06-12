import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// workspaces-ui S-004 — Accept or reject a workspace invite (landing). Client + auth MOCKED.
// AS-013 accept → join + switch into the workspace; AS-014 reject → no membership, stay put;
// AS-015 invite for a different account → "this invite isn't for you", does not join.
// Real round-trip [→E2E]; pixel [→MANUAL].

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

const acceptInvitation = mock(async (_id: string, _t: string) =>
  env({ workspaceId: "ws-acme", role: "member" }),
);
const rejectInvitation = mock(async (_id: string, _t: string) => env({ rejected: true }));
const setActiveWorkspace = mock(async (id: string) => env({ activeWorkspaceId: id }));

mock.module("@/features/workspaces/client", () => ({
  acceptInvitation,
  rejectInvitation,
  setActiveWorkspace,
  fetchBootstrap: mock(async () => env({ userId: "me", workspaces: [], activeWorkspaceId: null })),
  fetchMembers: mock(async () => env({ members: [], invitations: [] })),
  createWorkspace: mock(async () => env({})),
  renameWorkspace: mock(async () => env({})),
  inviteMember: mock(async () => env({})),
  removeMember: mock(async () => env({})),
  changeMemberRole: mock(async () => env({})),
}));

// Auth session — the signed-in email drives the AS-015 wrong-account check.
let sessionEmail = "bob@acme.com";
mock.module("@/lib/api/auth-client", () => ({
  useSession: () => ({ data: { user: { email: sessionEmail } }, isPending: false }),
  signOut: mock(async () => ({})),
  signIn: { email: mock(async () => ({})) },
  authClient: {},
}));

const { WorkspaceInviteLanding } = await import("@/features/workspaces/invite-landing");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// invite link: /invite/workspace/:invitationId?token=…&email=… (the target email is in the link
// so the landing can show the AS-015 wrong-account message before calling the backend).
function App({ link }: { link: string }) {
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[link]}>
        <Routes>
          <Route path="/invite/workspace/:invitationId" element={<WorkspaceInviteLanding />} />
          <Route path="/w/:workspaceId/*" element={<Landed />} />
          <Route path="/" element={<div data-testid="home">home</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function Landed() {
  const loc = useLocation();
  return <div data-testid="landed">{loc.pathname}</div>;
}

beforeEach(() => {
  acceptInvitation.mockClear();
  rejectInvitation.mockClear();
  setActiveWorkspace.mockClear();
  sessionEmail = "bob@acme.com";
});

const LINK = "/invite/workspace/inv-1?token=tok123&email=bob@acme.com";

describe("workspaces-ui S-004 — invite accept/reject landing", () => {
  it("AS-013: accepting an invite joins and switches to the workspace", async () => {
    render(<App link={LINK} />);
    await userEvent.click(await screen.findByTestId("invite-accept"));

    expect(acceptInvitation).toHaveBeenCalledWith("inv-1", "tok123");
    // Joined → the app switches INTO the workspace (its /w/:id/ path).
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("/w/ws-acme"));
    expect(setActiveWorkspace).toHaveBeenCalledWith("ws-acme");
  });

  it("AS-014: rejecting an invite leaves no membership and stays put", async () => {
    render(<App link={LINK} />);
    await userEvent.click(await screen.findByTestId("invite-reject"));

    expect(rejectInvitation).toHaveBeenCalledWith("inv-1", "tok123");
    // No join: we never switch into a workspace; a rejected confirmation is shown instead.
    await waitFor(() => expect(screen.getByTestId("invite-rejected")).toBeInTheDocument());
    expect(setActiveWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByTestId("landed")).not.toBeInTheDocument();
  });

  it("AS-015: an invite for a different account is refused (\"this invite isn't for you\")", async () => {
    sessionEmail = "eve@acme.com"; // signed in as someone OTHER than the invited bob@acme.com
    render(<App link={LINK} />);

    // The wrong-account message is shown and there is NO accept affordance — cannot join.
    expect(await screen.findByTestId("invite-wrong-account")).toHaveTextContent(/isn't for you/i);
    expect(screen.queryByTestId("invite-accept")).not.toBeInTheDocument();
    expect(acceptInvitation).not.toHaveBeenCalled();
  });
});
