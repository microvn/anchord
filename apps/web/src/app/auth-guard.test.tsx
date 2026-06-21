import { describe, it, expect, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

// Bug A regression: an unauthenticated visitor hitting a guarded deep link (e.g. a workspace
// invite /invite/workspace/:id?token=…&email=…) must bounce to /signin carrying the FULL target
// as ?redirect=… so that after signing in they RETURN to the invite instead of losing it.
// Regression: invite dead-end (not signed in) — auth-guard.tsx dropped the location on bounce.

let session: unknown = null;
// NOTE: bun mock.module is process-global, so this shape leaks to any other test file that
// imports auth-client in the same run — export the full surface those modules use, not just
// useSession, or their imports crash with "Export named '…' not found". See [[bun-mockmodule-leak]].
mock.module("@/lib/api/auth-client", () => ({
  useSession: () => ({ data: session, isPending: false }),
  signOut: mock(async () => ({})),
  signIn: { email: mock(async () => ({})) },
  authClient: {},
}));

const { AuthGuard } = await import("@/app/auth-guard");

function Echo() {
  const loc = useLocation();
  return <div data-testid="signin">{loc.pathname + loc.search}</div>;
}

function App({ at }: { at: string }) {
  return (
    <MemoryRouter initialEntries={[at]}>
      <Routes>
        <Route element={<AuthGuard />}>
          <Route path="/invite/workspace/:id" element={<div data-testid="protected">protected</div>} />
        </Route>
        <Route path="/signin" element={<Echo />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("AuthGuard — returnTo preservation (Bug A)", () => {
  it("unauthenticated deep link bounces to /signin carrying ?redirect=<full target>", () => {
    session = null;
    render(<App at="/invite/workspace/inv-1?token=tok123&email=bob@acme.com" />);
    const echo = screen.getByTestId("signin");
    const text = echo.textContent ?? "";
    expect(text).toContain("/signin");
    const redirect = new URLSearchParams(text.slice(text.indexOf("?"))).get("redirect");
    // Post-login the invite must be reachable again, query params intact.
    expect(redirect).toBe("/invite/workspace/inv-1?token=tok123&email=bob@acme.com");
  });

  it("an authenticated visitor renders the protected outlet (unchanged)", () => {
    session = { user: { email: "bob@acme.com" } };
    render(<App at="/invite/workspace/inv-1?token=tok123&email=bob@acme.com" />);
    expect(screen.getByTestId("protected")).toBeInTheDocument();
  });
});
