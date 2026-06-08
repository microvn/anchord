import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

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
  signIn: { email: signInEmail },
  signOut: signOutMock,
  useSession: () => ({ data: sessionValue, isPending: sessionPending }),
  authClient: {},
}));

// Imported AFTER the mock is registered so they bind to the mocked auth-client.
const { SignInScreen } = await import("../src/features/auth/sign-in-screen");
const { AuthGuard } = await import("../src/app/auth-guard");
const { AppShell } = await import("../src/app/app-shell");

function ProtectedApp() {
  return (
    <Routes>
      <Route path="/signin" element={<SignInScreen />} />
      <Route element={<AuthGuard />}>
        <Route element={<AppShell />}>
          <Route index element={<div>Welcome to your workspace</div>} />
        </Route>
      </Route>
    </Routes>
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
