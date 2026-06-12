import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSyncExternalStore } from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// web-core S-001 — sign in, sign out, guard. The better-auth client (auth-client.ts) is
// MOCKED — tests NEVER hit a real backend. A real browser↔backend round-trip is [→E2E]
// (Playwright), deferred. Here signIn/signOut/useSession are controllable stand-ins.
//
// Phase-1 note: the authenticated shell (account menu) lands a later phase, so the
// "enters the app" / "sign out" cases route through a stub protected element + a tiny
// sign-out harness — the AS intent (session gates the app, sign-out clears it) is preserved.

// A reactive session store so useSession re-renders subscribers (the guard) when the
// session changes — mirrors better-auth's reactive store. Sign-out flips it to null and
// the guard re-renders to the sign-in screen, no real shell needed.
let sessionValue: { user: { email: string } } | null = null;
let sessionPending = false;
const listeners = new Set<() => void>();
function setSession(v: { user: { email: string } } | null) {
  sessionValue = v;
  for (const l of listeners) l();
}
function useSessionMock() {
  const data = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => sessionValue,
    () => sessionValue,
  );
  return { data, isPending: sessionPending };
}

const signInEmail = mock(async (_args: { email: string; password: string }) => ({
  data: { user: { email: "a@b.co" } },
  error: null as null | { code?: string; message: string },
}));
const signOutMock = mock(async () => {
  setSession(null);
  return { data: { success: true }, error: null };
});

mock.module("@/lib/api/auth-client", () => ({
  signIn: { email: signInEmail, social: mock(async () => ({})) },
  signUp: { email: mock(async () => ({ data: { user: {} }, error: null })) },
  signOut: signOutMock,
  sendVerificationEmail: mock(async () => ({ data: {}, error: null })),
  verifyEmail: mock(async () => ({ data: {}, error: null })),
  // The post-sign-in session refetch the screen awaits before redirecting. The AS-002 test
  // already commits sessionValue inside the signIn mock, so this just resolves.
  getSession: mock(async () => ({ data: sessionValue, error: null })),
  useSession: useSessionMock,
  authClient: {},
}));

// SignInScreen renders OAuthButtons, which reads the enabled-provider list via the auth-ui
// Eden wrapper. Mock it so the web-core sign-in tests never reach a real backend (no OAuth
// buttons here — web-core's flow is email+password).
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

// Imported AFTER the mock is registered so they bind to the mocked auth-client.
const { SignInScreen } = await import("@/features/auth/sign-in-screen");
const { AuthGuard } = await import("@/app/auth-guard");
const { signOut } = await import("@/lib/api/auth-client");

// Phase-1 stub for the (not-yet-built) authenticated shell: a protected element plus a
// sign-out control, so the guard + sign-out behavior can be asserted without the real shell.
function ProtectedHome() {
  return (
    <div>
      <span>Welcome to your workspace</span>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}

function ProtectedApp() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInScreen />} />
      <Route element={<AuthGuard />}>
        <Route index element={<ProtectedHome />} />
      </Route>
    </Routes>
  );
}

beforeEach(() => {
  sessionValue = null;
  sessionPending = false;
  signInEmail.mockClear();
  signOutMock.mockClear();
  signInEmail.mockResolvedValue({ data: { user: { email: "a@b.co" } }, error: null });
});

describe("web-core S-001 — sign in, sign out, guard", () => {
  it("AS-001: an unauthenticated visit shows the sign-in screen (email + password), not the app", () => {
    render(
      <MemoryRouter initialEntries={["/signin"]}>
        <ProtectedApp />
      </MemoryRouter>,
    );
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.queryByText(/welcome to your workspace/i)).not.toBeInTheDocument();
  });

  it("AS-002: a valid sign-in establishes the session and opens the authenticated app", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/signin"]}>
        <ProtectedApp />
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText(/email/i), "a@b.co");
    await user.type(screen.getByLabelText(/password/i), "correct-horse");
    // After a successful sign-in the session is present, so the guard renders the app.
    signInEmail.mockImplementationOnce(async () => {
      setSession({ user: { email: "a@b.co" } });
      return { data: { user: { email: "a@b.co" } }, error: null };
    });
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(screen.getByText(/welcome to your workspace/i)).toBeInTheDocument(),
    );
    expect(signInEmail).toHaveBeenCalledWith({ email: "a@b.co", password: "correct-horse" });
  });

  it("AS-003: an invalid sign-in shows an error and stays on the sign-in screen with no session", async () => {
    const user = userEvent.setup();
    signInEmail.mockResolvedValue({
      data: null as never,
      error: { message: "Invalid email or password" },
    });
    render(
      <MemoryRouter initialEntries={["/signin"]}>
        <ProtectedApp />
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText(/email/i), "a@b.co");
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(screen.getByText(/invalid email or password/i)).toBeInTheDocument(),
    );
    // Still on sign-in, no session established, app not shown.
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.queryByText(/welcome to your workspace/i)).not.toBeInTheDocument();
    expect(sessionValue).toBeNull();
  });

  it("AS-004: a protected route while unauthenticated redirects to the sign-in screen", () => {
    setSession(null);
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ProtectedApp />
      </MemoryRouter>,
    );
    // The deep-link to "/" redirects to /signin: sign-in fields show, protected content does not.
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.queryByText(/welcome to your workspace/i)).not.toBeInTheDocument();
  });

  it("AS-005: signing out clears the session and returns to the sign-in screen", async () => {
    const user = userEvent.setup();
    setSession({ user: { email: "a@b.co" } });
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ProtectedApp />
      </MemoryRouter>,
    );
    // Signed in: the protected home renders.
    await user.click(screen.getByRole("button", { name: /sign out/i }));
    expect(signOutMock).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText(/password/i)).toBeInTheDocument());
    expect(screen.queryByText(/welcome to your workspace/i)).not.toBeInTheDocument();
    expect(sessionValue).toBeNull();
  });

  it("C-001: a successful sign-in writes NO auth token to localStorage or sessionStorage (identity rides the cookie)", async () => {
    const user = userEvent.setup();
    localStorage.clear();
    sessionStorage.clear();
    render(
      <MemoryRouter initialEntries={["/signin"]}>
        <ProtectedApp />
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText(/email/i), "a@b.co");
    await user.type(screen.getByLabelText(/password/i), "correct-horse");
    signInEmail.mockImplementationOnce(async () => {
      setSession({ user: { email: "a@b.co" } });
      return { data: { user: { email: "a@b.co" } }, error: null };
    });
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(screen.getByText(/welcome to your workspace/i)).toBeInTheDocument(),
    );
    // No token persisted client-side — the app code stored nothing in web storage.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
