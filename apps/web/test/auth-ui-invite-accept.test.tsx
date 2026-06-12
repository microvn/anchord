import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

// auth-ui S-003 — accept a PER-DOC invite (distinct from the workspace invite in
// workspaces-ui). The auth client + the auth-ui Eden wrapper are MOCKED. The wrapper calls
// POST /api/invite/accept (backend src/routes/invite.ts). The real round-trip is [→E2E];
// the LOGIC asserted: matching email + confirm → role granted + taken to the doc (AS-009);
// wrong account → "this invite isn't for you", role NOT granted (AS-010).

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const acceptDocInvite = mock(async (_id: string, _t: string) =>
  env({ status: "active", docId: "doc-42", role: "commenter" }),
);

mock.module("@/features/auth/client", () => ({
  acceptDocInvite,
  fetchAuthProviders: mock(async () => env({ providers: [] })),
}));

let sessionEmail = "bob@acme.com";
mock.module("@/lib/auth-client", () => ({
  getSession: mock(async () => ({ data: { user: { email: sessionEmail } }, error: null })),
  useSession: () => ({ data: { user: { email: sessionEmail } }, isPending: false }),
  signOut: mock(async () => ({})),
  signIn: { email: mock(async () => ({})), social: mock(async () => ({})) },
  signUp: { email: mock(async () => ({})) },
  sendVerificationEmail: mock(async () => ({})),
  verifyEmail: mock(async () => ({})),
  authClient: {},
}));

const { InviteAcceptLanding } = await import("@/features/auth/invite-accept-landing");

function Landed() {
  const loc = useLocation();
  return <div data-testid="landed">{loc.pathname}</div>;
}

function App({ link }: { link: string }) {
  return (
    <MemoryRouter initialEntries={[link]}>
      <Routes>
        <Route path="/invite/doc/:inviteId" element={<InviteAcceptLanding />} />
        <Route path="/d/:docId" element={<Landed />} />
      </Routes>
    </MemoryRouter>
  );
}

const LINK = "/invite/doc/inv-doc-1?token=tok-abc&email=bob@acme.com";

beforeEach(() => {
  acceptDocInvite.mockClear();
  acceptDocInvite.mockResolvedValue(env({ status: "active", docId: "doc-42", role: "commenter" }));
  sessionEmail = "bob@acme.com";
});

describe("auth-ui S-003 — accept a per-doc invite", () => {
  it("AS-009: confirming with the matching signed-in email grants the role and takes me to the doc", async () => {
    const user = userEvent.setup();
    render(<App link={LINK} />);
    await user.click(await screen.findByTestId("doc-invite-accept"));

    expect(acceptDocInvite).toHaveBeenCalledWith("inv-doc-1", "tok-abc");
    // Granted → navigated to the doc viewer.
    await waitFor(() => expect(screen.getByTestId("landed")).toHaveTextContent("/d/doc-42"));
  });

  it("AS-010: signed in as the WRONG account shows 'this invite isn't for you' and does NOT grant the role", async () => {
    sessionEmail = "eve@acme.com"; // not the invited bob@acme.com
    render(<App link={LINK} />);

    expect(await screen.findByTestId("doc-invite-wrong-account")).toHaveTextContent(/isn't for you/i);
    // No accept affordance, and the accept call is never made → role never granted.
    expect(screen.queryByTestId("doc-invite-accept")).not.toBeInTheDocument();
    expect(acceptDocInvite).not.toHaveBeenCalled();
    expect(screen.queryByTestId("landed")).not.toBeInTheDocument();
  });

  it("AS-010: a uniform backend refusal (status not_accepted) shows a non-granting message, no navigation", async () => {
    // Even when the link's email matched (so the FE pre-check passed), the authoritative
    // backend can still refuse uniformly — surface it without granting / navigating.
    acceptDocInvite.mockResolvedValue(env({ status: "not_accepted" }));
    const user = userEvent.setup();
    render(<App link={LINK} />);
    await user.click(await screen.findByTestId("doc-invite-accept"));

    await waitFor(() => expect(screen.getByTestId("doc-invite-error")).toBeInTheDocument());
    expect(screen.queryByTestId("landed")).not.toBeInTheDocument();
  });
});
