import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// ── Mock the better-auth client (auth-client.ts) — tests NEVER hit a real backend.
// A real browser↔backend round-trip is [→E2E] (Playwright), deferred. Here signIn/
// signOut/useSession are controllable stand-ins.
let sessionValue: { user: { email: string } } | null = null;
let sessionPending = false;
const signInEmail = mock(async (_args: { email: string; password: string }) => ({
  data: { user: { email: "a@b.co" } },
  error: null as null | { message: string },
}));
const signOutMock = mock(async () => {
  sessionValue = null;
  return { data: { success: true }, error: null };
});

mock.module("../src/lib/auth-client", () => ({
  signIn: { email: signInEmail, social: mock(async () => ({})) },
  signUp: { email: mock(async () => ({ data: { user: {} }, error: null })) },
  signOut: signOutMock,
  sendVerificationEmail: mock(async () => ({ data: {}, error: null })),
  verifyEmail: mock(async () => ({ data: {}, error: null })),
  // The post-sign-in session refetch the screen awaits before redirecting. The AS-002 test
  // already commits sessionValue inside the signIn mock, so this just resolves.
  getSession: mock(async () => ({ data: sessionValue, error: null })),
  useSession: () => ({ data: sessionValue, isPending: sessionPending }),
  authClient: {},
}));

// SignInScreen now renders OAuthButtons, which reads the enabled-provider list via the
// auth-ui Eden wrapper. Mock it so the web-core sign-in tests never reach a real backend
// (no OAuth buttons here — web-core's flow is email+password).
mock.module("../src/features/auth/client", () => ({
  fetchAuthProviders: mock(async () => ({ data: { success: true, data: { providers: [] } }, error: null })),
  acceptDocInvite: mock(async () => ({ data: { success: true, data: { status: "active" } }, error: null })),
}));

// web-core S-005: the AppShell now hosts AppHeader, which reads the /api/me bootstrap through the
// shared client. Mock the workspaces client so the authenticated-shell renders (AS-002/AS-005)
// resolve the bootstrap to an empty workspace set without a backend.
const wsEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
mock.module("../src/features/workspaces/client", () => ({
  fetchBootstrap: mock(async () => wsEnv({ userId: "me", workspaces: [], activeWorkspaceId: null })),
  setActiveWorkspace: mock(async () => wsEnv({})),
  fetchMembers: mock(async () => wsEnv({ members: [], invitations: [] })),
  createWorkspace: mock(async () => wsEnv({})),
  renameWorkspace: mock(async () => wsEnv({})),
  inviteMember: mock(async () => wsEnv({})),
  removeMember: mock(async () => wsEnv({})),
  changeMemberRole: mock(async () => wsEnv({})),
  acceptInvitation: mock(async () => wsEnv({})),
  rejectInvitation: mock(async () => wsEnv({})),
}));

// Imported AFTER the mock is registered so they bind to the mocked auth-client.
const { SignInScreen } = await import("../src/features/auth/sign-in-screen");
const { AuthGuard } = await import("../src/app/auth-guard");
const { AppShell } = await import("../src/app/app-shell");

function ProtectedApp() {
  // The shell's AppHeader reads the bootstrap via the shared client → needs a QueryClient.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <Routes>
        <Route path="/signin" element={<SignInScreen />} />
        <Route element={<AuthGuard />}>
          <Route element={<AppShell />}>
            <Route index element={<div>Welcome to your workspace</div>} />
          </Route>
        </Route>
      </Routes>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  sessionValue = null;
  sessionPending = false;
  signInEmail.mockClear();
  signOutMock.mockClear();
  signInEmail.mockResolvedValue({
    data: { user: { email: "a@b.co" } },
    error: null,
  });
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

  it("AS-002: a valid sign-in establishes the session and opens the authenticated shell", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/signin"]}>
        <ProtectedApp />
      </MemoryRouter>,
    );
    await user.type(screen.getByLabelText(/email/i), "a@b.co");
    await user.type(screen.getByLabelText(/password/i), "correct-horse");
    // After a successful sign-in the session is present, so the guard renders the shell.
    signInEmail.mockImplementationOnce(async () => {
      sessionValue = { user: { email: "a@b.co" } };
      return { data: { user: { email: "a@b.co" } }, error: null };
    });
    await user.click(screen.getByRole("button", { name: /sign in/i }));
    await waitFor(() =>
      expect(screen.getByText(/welcome to your workspace/i)).toBeInTheDocument(),
    );
    expect(signInEmail).toHaveBeenCalledWith({
      email: "a@b.co",
      password: "correct-horse",
    });
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
    sessionValue = null;
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
    sessionValue = { user: { email: "a@b.co" } };
    render(
      <MemoryRouter initialEntries={["/"]}>
        <ProtectedApp />
      </MemoryRouter>,
    );
    // Signed in: the shell (with the account menu) renders.
    await user.click(screen.getByRole("button", { name: /account menu/i }));
    await user.click(screen.getByRole("button", { name: /sign out/i }));
    expect(signOutMock).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByLabelText(/password/i)).toBeInTheDocument(),
    );
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
      sessionValue = { user: { email: "a@b.co" } };
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
