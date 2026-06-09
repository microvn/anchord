import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// auth-ui S-001 — sign up + email verification. The better-auth client (auth-client.ts) and
// the auth-ui Eden wrapper (features/auth/client.ts) are MOCKED — no real backend. The live
// browser↔backend round-trip + the real mail link are [→E2E]/[→MANUAL]; the LOGIC asserted
// here is: the "check your inbox" state, resend, the verify-first state (vs a credential
// error), the verify-link success/expired states, and the already-registered refusal.

let sessionValue: { user: { email: string } } | null = null;
const signInEmail = mock(
  async (_a: { email: string; password: string }) =>
    ({ data: null, error: null }) as { data: unknown; error: null | { code?: string; message?: string } },
);
const signUpEmail = mock(
  async (_a: { email: string; password: string; name?: string }) =>
    ({ data: { user: {} }, error: null }) as {
      data: unknown;
      error: null | { code?: string; message?: string };
    },
);
const sendVerificationEmail = mock(async (_a: { email: string; callbackURL?: string }) => ({
  data: { status: true },
  error: null as null | { message?: string },
}));
const verifyEmail = mock(async (_a: { query: { token: string } }) => ({
  data: { status: true },
  error: null as null | { message?: string },
}));

mock.module("../src/lib/auth-client", () => ({
  signIn: { email: signInEmail, social: mock(async () => ({})) },
  signUp: { email: signUpEmail },
  signOut: mock(async () => ({})),
  sendVerificationEmail,
  verifyEmail,
  getSession: mock(async () => ({ data: sessionValue, error: null })),
  useSession: () => ({ data: sessionValue, isPending: false }),
  authClient: {},
}));

// auth-ui client wrapper — providers read returns no OAuth (so SignUpScreen/SignInScreen
// render the form alone; OAuth is the S-002 suite's concern).
mock.module("../src/features/auth/client", () => ({
  fetchAuthProviders: mock(async () => ({ data: { success: true, data: { providers: [] } }, error: null })),
  acceptDocInvite: mock(async () => ({ data: { success: true, data: { status: "active" } }, error: null })),
}));

const { SignUpScreen } = await import("../src/features/auth/sign-up-screen");
const { SignInScreen } = await import("../src/features/auth/sign-in-screen");
const { VerifyEmailLanding } = await import("../src/features/auth/verify-email-landing");

beforeEach(() => {
  sessionValue = null;
  signInEmail.mockReset();
  signUpEmail.mockReset();
  sendVerificationEmail.mockReset();
  verifyEmail.mockReset();
  signInEmail.mockResolvedValue({ data: null, error: null });
  signUpEmail.mockResolvedValue({ data: { user: {} }, error: null });
  sendVerificationEmail.mockResolvedValue({ data: { status: true }, error: null });
  verifyEmail.mockResolvedValue({ data: { status: true }, error: null });
});

function renderAt(node: React.ReactNode, path: string) {
  return render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
}

describe("auth-ui S-001 — sign up and verify email", () => {
  it("AS-001: signing up with a valid email + 8-char password shows the check-your-inbox state with a resend", async () => {
    const user = userEvent.setup();
    renderAt(
      <Routes>
        <Route path="/signup" element={<SignUpScreen />} />
      </Routes>,
      "/signup",
    );
    await user.type(screen.getByLabelText(/email/i), "new@acme.com");
    await user.type(screen.getByLabelText(/password/i), "longenough");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(screen.getByTestId("verify-sent")).toBeInTheDocument());
    expect(signUpEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "new@acme.com", password: "longenough" }),
    );
    // Resend is offered and triggers another verification mail.
    await user.click(screen.getByTestId("verify-resend"));
    await waitFor(() => expect(sendVerificationEmail).toHaveBeenCalled());
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "new@acme.com" }),
    );
  });

  it("AS-003: sign-up passes a callbackURL to the SPA's own /verify-email landing (not the backend API)", async () => {
    const user = userEvent.setup();
    renderAt(
      <Routes>
        <Route path="/signup" element={<SignUpScreen />} />
      </Routes>,
      "/signup",
    );
    await user.type(screen.getByLabelText(/email/i), "new@acme.com");
    await user.type(screen.getByLabelText(/password/i), "longenough");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(signUpEmail).toHaveBeenCalled());
    const arg = signUpEmail.mock.calls[0]![0] as { callbackURL?: string };
    // Bug 3: better-auth resolves callbackURL against the LINK origin (the backend), so
    // without an absolute SPA URL the post-verify redirect dead-ends on the backend's raw
    // API response. The callbackURL must point at the app's own /verify-email landing.
    expect(typeof arg.callbackURL).toBe("string");
    expect(arg.callbackURL).toBe(`${window.location.origin}/verify-email`);
  });

  it("AS-001: a password under 8 characters is rejected client-side and sign-up is not called", async () => {
    const user = userEvent.setup();
    renderAt(
      <Routes>
        <Route path="/signup" element={<SignUpScreen />} />
      </Routes>,
      "/signup",
    );
    await user.type(screen.getByLabelText(/email/i), "new@acme.com");
    await user.type(screen.getByLabelText(/password/i), "short");
    await user.click(screen.getByRole("button", { name: /create account/i }));
    await waitFor(() => expect(screen.getByText(/at least 8 characters/i)).toBeInTheDocument());
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it("AS-002 / C-001: signing in before verifying shows a DISTINCT verify-first message, not a credential error", async () => {
    const user = userEvent.setup();
    // better-auth refuses an unverified sign-in with the EMAIL_NOT_VERIFIED code.
    signInEmail.mockResolvedValue({
      data: null,
      error: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
    });
    renderAt(
      <Routes>
        <Route path="/signin" element={<SignInScreen />} />
      </Routes>,
      "/signin",
    );
    await user.type(screen.getByLabelText(/email/i), "unverified@acme.com");
    await user.type(screen.getByLabelText(/password/i), "correct-horse");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    // The distinct verify-first state appears...
    await waitFor(() => expect(screen.getByTestId("verify-first")).toBeInTheDocument());
    expect(screen.getByText(/verify your email first/i)).toBeInTheDocument();
    // ...and it is NOT a generic credential error.
    expect(screen.queryByTestId("signin-error")).not.toBeInTheDocument();
    expect(screen.queryByText(/check your credentials/i)).not.toBeInTheDocument();
    expect(sessionValue).toBeNull();
    // Resend from the verify-first state re-sends the verification mail.
    await user.click(screen.getByTestId("verify-first-resend"));
    await waitFor(() =>
      expect(sendVerificationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ email: "unverified@acme.com" }),
      ),
    );
  });

  it("AS-002: a wrong-password sign-in shows a credential error, NOT the verify-first state", async () => {
    const user = userEvent.setup();
    signInEmail.mockResolvedValue({
      data: null,
      error: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
    });
    renderAt(
      <Routes>
        <Route path="/signin" element={<SignInScreen />} />
      </Routes>,
      "/signin",
    );
    await user.type(screen.getByLabelText(/email/i), "a@b.co");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));
    await waitFor(() => expect(screen.getByTestId("signin-error")).toBeInTheDocument());
    expect(screen.queryByTestId("verify-first")).not.toBeInTheDocument();
  });

  it("AS-003: opening a valid verification link verifies the account and offers to proceed", async () => {
    verifyEmail.mockResolvedValue({ data: { status: true }, error: null });
    renderAt(
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailLanding />} />
      </Routes>,
      "/verify-email?token=valid-token",
    );
    await waitFor(() => expect(screen.getByTestId("verify-success")).toBeInTheDocument());
    expect(verifyEmail).toHaveBeenCalledWith({ query: { token: "valid-token" } });
    // A way to proceed into the app / sign in is offered.
    expect(screen.getByTestId("verify-proceed")).toBeInTheDocument();
  });

  it("AS-004: an expired/invalid verification link shows a recoverable error with resend, no crash", async () => {
    const user = userEvent.setup();
    verifyEmail.mockResolvedValue({ data: null, error: { message: "token expired" } });
    renderAt(
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailLanding />} />
      </Routes>,
      "/verify-email?token=expired",
    );
    await waitFor(() => expect(screen.getByTestId("verify-invalid")).toBeInTheDocument());
    expect(screen.getByText(/expired or invalid/i)).toBeInTheDocument();
    // Recovery: enter email + resend.
    await user.type(screen.getByLabelText(/email/i), "me@acme.com");
    await user.click(screen.getByTestId("verify-resend"));
    await waitFor(() =>
      expect(sendVerificationEmail).toHaveBeenCalledWith(
        expect.objectContaining({ email: "me@acme.com" }),
      ),
    );
  });

  it("AS-004: a failed verification (better-auth redirects with ?error=) shows the recoverable invalid state, no crash", async () => {
    renderAt(
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailLanding />} />
      </Routes>,
      "/verify-email?error=INVALID_TOKEN",
    );
    await waitFor(() => expect(screen.getByTestId("verify-invalid")).toBeInTheDocument());
    // The token was consumed server-side; the FE makes no verifyEmail call on the redirect.
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it("AS-003: the success redirect (token-less, no error param) shows verified, not an error", async () => {
    // better-auth verifies the link SERVER-SIDE then 302s here clean (no token, no error).
    // Reaching the landing this way is a SUCCESS, not a missing-token failure.
    renderAt(
      <Routes>
        <Route path="/verify-email" element={<VerifyEmailLanding />} />
      </Routes>,
      "/verify-email",
    );
    await waitFor(() => expect(screen.getByTestId("verify-success")).toBeInTheDocument());
    expect(screen.getByTestId("verify-proceed")).toBeInTheDocument();
    expect(verifyEmail).not.toHaveBeenCalled();
  });

  it("C-003: a successful sign-up writes NO auth token to localStorage/sessionStorage (identity rides the server session)", async () => {
    const user = userEvent.setup();
    localStorage.clear();
    sessionStorage.clear();
    renderAt(
      <Routes>
        <Route path="/signup" element={<SignUpScreen />} />
      </Routes>,
      "/signup",
    );
    await user.type(screen.getByLabelText(/email/i), "new@acme.com");
    await user.type(screen.getByLabelText(/password/i), "longenough");
    await user.click(screen.getByRole("button", { name: /create account/i }));
    await waitFor(() => expect(screen.getByTestId("verify-sent")).toBeInTheDocument());
    // The sign-up path stored nothing client-side: with requireEmailVerification there is no
    // session yet, and even when there is, identity is the httpOnly cookie better-auth manages.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("AS-005: signing up with an already-registered email shows 'email already in use' and stays on sign-up", async () => {
    const user = userEvent.setup();
    signUpEmail.mockResolvedValue({
      data: null,
      error: { code: "USER_ALREADY_EXISTS", message: "User already exists" },
    });
    renderAt(
      <Routes>
        <Route path="/signup" element={<SignUpScreen />} />
      </Routes>,
      "/signup",
    );
    await user.type(screen.getByLabelText(/email/i), "taken@acme.com");
    await user.type(screen.getByLabelText(/password/i), "longenough");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => expect(screen.getByText(/already in use/i)).toBeInTheDocument());
    // Stayed on the sign-up screen (the check-your-inbox state never appeared).
    expect(screen.queryByTestId("verify-sent")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create account/i })).toBeInTheDocument();
  });
});
