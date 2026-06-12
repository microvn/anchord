import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// web-core S-001 AS-002 / auth-ui sign-in success → enters the app.
//
// Regression guard for the live race: SignInScreen navigated to "/" the INSTANT
// signIn.email resolved, but the better-auth session store hadn't committed the new
// session yet — so the AuthGuard read no session and bounced straight back to /signin
// (first login appeared to hang). The fix refetches the session (getSession) and drives
// the redirect off an effect watching the SAME reactive session the guard reads, so the
// redirect only lands once the session is present.
//
// This mock models the REAL timing: signIn.email succeeds but does NOT set the session
// synchronously — only getSession() (the post-success refetch) commits it into the
// reactive useSession store. Against the OLD code (navigate before commit) the guard sees
// no session and the test stays on /signin → RED. The new effect-driven redirect → GREEN.

// A reactive session store so useSession re-renders subscribers when the session commits.
let session: { user: { email: string } } | null = null;
const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
function setSession(v: { user: { email: string } } | null) {
  session = v;
  emit();
}
function useSessionMock() {
  const data = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => session,
    () => session,
  );
  return { data, isPending: false };
}

const signInEmail = mock(async (_args: { email: string; password: string }) => ({
  data: { user: { email: "a@b.co" } },
  error: null as null | { message: string },
}));
// getSession is the post-success refetch — THIS is what commits the session (mirrors
// better-auth refreshing its store from the freshly-set cookie).
const getSessionMock = mock(async () => {
  setSession({ user: { email: "a@b.co" } });
  return { data: { user: { email: "a@b.co" } }, error: null };
});

mock.module("@/lib/auth-client", () => ({
  signIn: { email: signInEmail, social: mock(async () => ({})) },
  signUp: { email: mock(async () => ({ data: { user: {} }, error: null })) },
  signOut: mock(async () => ({ data: { success: true }, error: null })),
  sendVerificationEmail: mock(async () => ({ data: {}, error: null })),
  verifyEmail: mock(async () => ({ data: {}, error: null })),
  getSession: getSessionMock,
  useSession: useSessionMock,
  authClient: {},
}));

mock.module("@/features/auth/client", () => ({
  fetchAuthProviders: mock(async () => ({
    data: { success: true, data: { providers: [] } },
    error: null,
  })),
  acceptDocInvite: mock(async () => ({
    data: { success: true, data: { status: "active" } },
    error: null,
  })),
}));

const { SignInScreen } = await import("@/features/auth/sign-in-screen");
const { AuthGuard } = await import("@/app/auth-guard");

function ProtectedApp() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInScreen />} />
      <Route element={<AuthGuard />}>
        <Route index element={<div>Welcome to your workspace</div>} />
      </Route>
    </Routes>
  );
}

beforeEach(() => {
  setSession(null);
  signInEmail.mockClear();
  getSessionMock.mockClear();
});

describe("auth-ui — sign-in success redirects off /signin once the session commits", () => {
  it("AS-002: a valid sign-in navigates into the app AFTER the session resolves (no guard bounce)", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/signin"]}>
        <ProtectedApp />
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText(/email/i), "a@b.co");
    await user.type(screen.getByLabelText(/password/i), "correct-horse");

    await act(async () => {
      await user.click(screen.getByRole("button", { name: /sign in/i }));
    });

    // The redirect must land on the authenticated app — not bounce back to /signin.
    await waitFor(() =>
      expect(screen.getByText(/welcome to your workspace/i)).toBeInTheDocument(),
    );
    // The fix refetches the session before redirecting.
    expect(getSessionMock).toHaveBeenCalled();
  });
});
