import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// auth-ui S-002 — OAuth sign-in. The better-auth client + the auth-ui Eden wrapper are
// MOCKED. The enabled-provider list comes from the GAP-002 read (mocked here per-test). The
// real OAuth browser round-trip is [→E2E]; the LOGIC asserted: which buttons render
// (AS-007), clicking an enabled provider starts the social flow (AS-006), and a denied/failed
// callback (?error=…) renders the banner with no session (AS-008).

const socialSignIn = mock(async (_a: { provider: string; callbackURL?: string; errorCallbackURL?: string }) => ({
  data: { url: "https://provider/oauth" },
  error: null,
}));

mock.module("../src/lib/auth-client", () => ({
  signIn: { email: mock(async () => ({ data: null, error: null })), social: socialSignIn },
  signUp: { email: mock(async () => ({ data: { user: {} }, error: null })) },
  signOut: mock(async () => ({})),
  sendVerificationEmail: mock(async () => ({ data: {}, error: null })),
  verifyEmail: mock(async () => ({ data: {}, error: null })),
  useSession: () => ({ data: null, isPending: false }),
  authClient: {},
}));

// The GAP-002 providers read — overridden per-test to control which buttons render.
const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });
let providersResult: ReturnType<typeof env> = env({ providers: ["github"] });
const fetchAuthProviders = mock(async () => providersResult);

mock.module("../src/features/auth/client", () => ({
  fetchAuthProviders,
  acceptDocInvite: mock(async () => env({ status: "active" })),
}));

const { SignInScreen } = await import("../src/features/auth/sign-in-screen");
const { OAuthButtons } = await import("../src/features/auth/oauth-buttons");

beforeEach(() => {
  socialSignIn.mockClear();
  fetchAuthProviders.mockClear();
  providersResult = env({ providers: ["github"] });
});

function renderAt(node: React.ReactNode, path: string) {
  return render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>);
}

describe("auth-ui S-002 — OAuth sign-in", () => {
  it("AS-006: clicking an enabled provider button starts the better-auth social sign-in", async () => {
    const user = userEvent.setup();
    providersResult = env({ providers: ["github"] });
    renderAt(<OAuthButtons />, "/");
    const btn = await screen.findByTestId("oauth-github");
    await user.click(btn);
    expect(socialSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "github" }),
    );
    // It passes an errorCallbackURL so a failed callback returns to sign-in with ?error=… (AS-008).
    expect(socialSignIn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCallbackURL: expect.stringContaining("error=") }),
    );
  });

  it("AS-007: only enabled providers render — GitHub configured, Google absent shows no Google button", async () => {
    providersResult = env({ providers: ["github"] });
    renderAt(<OAuthButtons />, "/");
    expect(await screen.findByTestId("oauth-github")).toBeInTheDocument();
    expect(screen.queryByTestId("oauth-google")).not.toBeInTheDocument();
  });

  it("AS-007: no enabled providers → no OAuth buttons render at all", async () => {
    providersResult = env({ providers: [] });
    const { container } = renderAt(<OAuthButtons />, "/");
    // Give the effect a tick; nothing OAuth should appear.
    await waitFor(() => expect(fetchAuthProviders).toHaveBeenCalled());
    expect(screen.queryByTestId("oauth-github")).not.toBeInTheDocument();
    expect(screen.queryByTestId("oauth-google")).not.toBeInTheDocument();
    expect(container.textContent ?? "").not.toMatch(/continue with/i);
  });

  it("AS-007: both providers enabled → both buttons render", async () => {
    providersResult = env({ providers: ["github", "google"] });
    renderAt(<OAuthButtons />, "/");
    expect(await screen.findByTestId("oauth-github")).toBeInTheDocument();
    expect(await screen.findByTestId("oauth-google")).toBeInTheDocument();
  });

  it("AS-008 / C-002: a denied/failed callback (?error=…) renders the OAuth error banner and creates no session", async () => {
    // better-auth redirected back to /signin?error=access_denied after a denied grant.
    renderAt(
      <Routes>
        <Route path="/signin" element={<SignInScreen />} />
      </Routes>,
      "/signin?error=access_denied",
    );
    expect(await screen.findByTestId("oauth-error")).toBeInTheDocument();
    // No social sign-in was kicked off by merely landing on the error URL (no session created).
    expect(socialSignIn).not.toHaveBeenCalled();
  });

  it("AS-008: with no ?error param the banner is absent (clean sign-in screen)", async () => {
    providersResult = env({ providers: [] });
    renderAt(
      <Routes>
        <Route path="/signin" element={<SignInScreen />} />
      </Routes>,
      "/signin",
    );
    await waitFor(() => expect(screen.getByRole("button", { name: /^sign in$/i })).toBeInTheDocument());
    expect(screen.queryByTestId("oauth-error")).not.toBeInTheDocument();
  });
});
