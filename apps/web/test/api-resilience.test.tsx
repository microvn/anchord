import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";

// web-core S-002 — Resilient API and session handling.
//
// The shared client (Eden treaty) and the auth client are MOCKED — tests never hit a real
// backend; the true browser↔backend round-trip is [→E2E] (Playwright), deferred. We drive
// the three scenarios by controlling what the mocked `api.api.projects.get()` resolves to,
// then assert the SHARED layer's behavior (one error surface, one expiry bounce) — proving
// the behavior is centralized, not re-implemented per screen.

// ── Mock the Eden client. `capturedCall` records the last invocation so AS-006 can assert
//    the request carries no identity in its body (identity rides the cookie, C-001/AS-006).
type GetResult = { data: unknown; error: unknown };
let nextResult: () => Promise<GetResult> = async () => ({ data: { ok: true }, error: null });
const capturedCalls: unknown[][] = [];
const healthGet = mock((...args: unknown[]) => {
  capturedCalls.push(args);
  return nextResult();
});

mock.module("../src/lib/api", () => ({
  api: { health: { get: healthGet } },
}));

// ── Mock the auth client — AS-008 asserts signOut is called on expiry (session view cleared).
const signOutMock = mock(async () => ({ data: { success: true }, error: null }));
mock.module("../src/lib/auth-client", () => ({
  signOut: signOutMock,
  signIn: { email: mock(async () => ({ data: null, error: null })), social: mock(async () => ({})) },
  signUp: { email: mock(async () => ({ data: { user: {} }, error: null })) },
  sendVerificationEmail: mock(async () => ({ data: {}, error: null })),
  verifyEmail: mock(async () => ({ data: {}, error: null })),
  getSession: mock(async () => ({ data: { user: { email: "a@b.co" } }, error: null })),
  useSession: () => ({ data: { user: { email: "a@b.co" } }, isPending: false }),
  authClient: {},
}));

// Imported AFTER the mocks so they bind to the mocked modules.
const { BootstrapPanel } = await import("../src/app/bootstrap-panel");
const { createQueryClient } = await import("../src/app/query-client");
const { SessionExpiryListener } = await import("../src/app/session-expiry-listener");
const { ErrorState } = await import("../src/components/error-state");
const { GENERIC_MESSAGE } = await import("../src/lib/api-error");

// A minimal app: the representative consumer inside the shared QueryClient + the in-tree
// expiry listener, with a /signin route to land on after a bounce.
function ResilientApp() {
  const client = createQueryClient();
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <SessionExpiryListener />
        <Routes>
          <Route path="/" element={<BootstrapPanel />} />
          <Route path="/signin" element={<div>Sign in to your workspace</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const UNAUTH_ENVELOPE = {
  status: 401,
  value: { success: false, error: { code: "UNAUTHENTICATED", message: "Authentication required" } },
};

beforeEach(() => {
  capturedCalls.length = 0;
  healthGet.mockClear();
  signOutMock.mockClear();
  nextResult = async () => ({ data: { ok: true }, error: null });
});

describe("web-core S-002 — resilient API + session handling", () => {
  it("AS-006: an authenticated request acts as the signed-in user (session via the shared client, NO identity in the request body)", async () => {
    nextResult = async () => ({ data: { ok: true }, error: null });
    render(<ResilientApp />);

    await waitFor(() => expect(healthGet).toHaveBeenCalled());

    // The screen reached the backend through the ONE shared Eden client (credentials:
    // "include" is set on that client — api-config.test asserts that wiring). The client
    // sends NO userId/identity in the body: the get() call carries no identity argument.
    const firstCallArgs = capturedCalls[0] ?? [];
    const bodyish = JSON.stringify(firstCallArgs);
    expect(bodyish).not.toContain("userId");
    expect(bodyish).not.toContain("identity");
    // A bare read carries no body payload at all — identity rides the cookie.
    expect(firstCallArgs.length).toBe(0);

    await waitFor(() =>
      expect(screen.getByTestId("bootstrap-ready")).toBeInTheDocument(),
    );
  });

  it("AS-007: a failed request shows a retryable error (message + Retry), not a blank/crash; Retry re-runs the request", async () => {
    // First load fails (backend returns an error envelope), so the screen must show ErrorState.
    nextResult = async () => ({
      data: null,
      error: { status: 500, value: { success: false, error: { code: "INTERNAL", message: "Server is down" } } },
    });
    render(<ResilientApp />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/server is down/i);
    const retry = screen.getByRole("button", { name: /retry/i });
    expect(retry).toBeInTheDocument();
    // Not blank/crashed: the loading and ready surfaces are absent, the error surface is present.
    expect(screen.queryByTestId("bootstrap-ready")).not.toBeInTheDocument();

    // Retry succeeds the second time → the request is re-issued and the screen recovers.
    const callsBefore = healthGet.mock.calls.length;
    nextResult = async () => ({ data: { ok: true }, error: null });
    const user = userEvent.setup();
    await user.click(retry);

    await waitFor(() =>
      expect(screen.getByTestId("bootstrap-ready")).toBeInTheDocument(),
    );
    expect(healthGet.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("AS-008: an UNAUTHENTICATED response returns the user to sign-in and clears the session view", async () => {
    nextResult = async () => ({ data: null, error: UNAUTH_ENVELOPE });
    render(<ResilientApp />);

    // The shared layer detects the unauthenticated response and bounces to /signin (not left
    // on a broken page), and clears the client-side session view via signOut.
    await waitFor(() =>
      expect(screen.getByText(/sign in to your workspace/i)).toBeInTheDocument(),
    );
    expect(signOutMock).toHaveBeenCalled();
  });

  it("C-002: the shared layer is centralized — ANY failing query yields the same ErrorState surface, and ANY unauth response routes to sign-in", async () => {
    // Same surface for a failure that arrives as a thrown transport error (backend unreachable),
    // proving the consistent surface isn't tied to one error shape or one screen.
    nextResult = async () => {
      throw new Error("Failed to fetch");
    };
    const { unmount } = render(<ResilientApp />);
    const alert = await screen.findByRole("alert");
    // The SAME consistent surface appears (non-blank alert + Retry), regardless of the
    // error shape — a thrown transport failure flows through the one shared path too.
    expect(alert).toBeInTheDocument();
    expect(alert.textContent ?? "").not.toBe("");
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    unmount();

    // And an unauth response from the SAME shared path routes to sign-in (centralized).
    signOutMock.mockClear();
    nextResult = async () => ({ data: null, error: UNAUTH_ENVELOPE });
    render(<ResilientApp />);
    await waitFor(() =>
      expect(screen.getByText(/sign in to your workspace/i)).toBeInTheDocument(),
    );
    expect(signOutMock).toHaveBeenCalled();
  });

  it("AS-007 (edge): a failed Retry that still fails keeps the ErrorState (no crash/blank), and an error with no message falls back to a generic surface", async () => {
    // Error envelope with NO message → ErrorState shows the generic fallback, not blank.
    nextResult = async () => ({
      data: null,
      error: { status: 503, value: { success: false, error: { code: "INTERNAL" } } },
    });
    render(<ResilientApp />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(GENERIC_MESSAGE);

    // Retry, still failing → the ErrorState remains; the screen does not crash or blank out.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByTestId("bootstrap-ready")).not.toBeInTheDocument();
  });

  it("ErrorState renders a generic fallback when given an empty message (no blank surface)", () => {
    render(<ErrorState message="" onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent(GENERIC_MESSAGE);
  });
});
