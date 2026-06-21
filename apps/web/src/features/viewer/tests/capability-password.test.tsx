import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// capability-share-link S-006 / AS-017 / AS-018 — the password challenge END-TO-END in the SPA:
// the redeem screen shows the gate, a correct password renders the viewer WITHOUT re-prompting
// (the redeem succeeds → admission cookie → doc), a wrong password re-prompts, and the server's
// throttle (429) disables the gate. We mock the redeem client to model the server's per-password
// outcome (the cookie/session is the server's job — here we prove the FE branching + no re-prompt).

class RedeemError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "RedeemError";
    this.status = status;
    this.code = code;
  }
  get isPasswordChallenge(): boolean {
    return (
      this.code === "LINK_PASSWORD_REQUIRED" ||
      this.code === "LINK_PASSWORD_INCORRECT" ||
      this.code === "LINK_PASSWORD_RATE_LIMITED"
    );
  }
}

// The redeem mock: first call (no password) → password required; then per submitted password.
let attempts = 0;
const CORRECT = "letmein";
const redeemCapabilityLink = mock(async (_token: string, password?: string) => {
  attempts += 1;
  if (password == null) throw new RedeemError("pw required", 401, "LINK_PASSWORD_REQUIRED");
  if (password === CORRECT) return { slug: "secret-spec-9f3a1c", role: "commenter" };
  // After 5 wrong tries the server throttles (429); before that it's a plain incorrect (401).
  if (attempts > 5) throw new RedeemError("throttled", 429, "LINK_PASSWORD_RATE_LIMITED");
  throw new RedeemError("wrong", 401, "LINK_PASSWORD_INCORRECT");
});

const ok = (body: unknown) => ({ data: { success: true, data: body }, error: null });
let docResponse: unknown;

mock.module("@/features/viewer/services/client", () => ({
  redeemCapabilityLink,
  RedeemError,
  createRedline: mock(async () => ok({ suggestionId: "rl-x" })),
  decideSuggestion: mock(async () => ok({ status: "accepted" })),
  fetchViewerDoc: mock(async () => docResponse),
  listAnnotations: mock(async () => ok({ items: [], pagination: { page: 1, limit: 50, total: 0 } })),
  createAnnotation: mock(async () => ok({ annotationId: "a" })),
  addComment: mock(async () => ok({ commentId: "c" })),
  setResolution: mock(async () => ok({ status: "resolved" })),
  deleteAnnotation: mock(async () => ok({ deleted: true })),
  restoreAnnotation: mock(async () => ok({ restored: true })),
  dismissAnnotation: mock(async () => ok({ dismissed: true })),
  reattachAnnotation: mock(async () => ok({ isOrphaned: false })),
  canComment: (role: string | undefined) => role !== "viewer",
}));

mock.module("@/lib/api/auth-client", () => ({
  useSession: () => ({ data: null, isPending: false }),
  signOut: mock(async () => ok({})),
  authClient: {},
}));

const { CapabilityRedeemScreen } = await import(
  "@/features/viewer/components/capability-redeem-screen"
);

function renderAt(token: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/s/${token}`]}>
        <Routes>
          <Route path="/s/:token" element={<CapabilityRedeemScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("capability password challenge (S-006)", () => {
  beforeEach(() => {
    redeemCapabilityLink.mockClear();
    attempts = 0;
    docResponse = ok({
      doc: {
        title: "Secret Spec",
        kind: "markdown",
        version: 1,
        status: "published",
        generalAccess: "anyone_with_link",
        effectiveRole: "commenter",
        workspaceId: null,
      },
      content: "<p>hello</p>",
    });
  });

  it("AS-017: a password-protected link shows the gate; a correct password renders the doc and does not re-prompt", async () => {
    renderAt("tok-aaaaaaaaaaaaaaaaaa");
    // The gate appears (the link is password-protected), not the viewer.
    await waitFor(() => expect(screen.getByTestId("link-password-gate")).toBeTruthy());

    // Enter the correct password.
    fireEvent.change(screen.getByTestId("link-password-input"), { target: { value: CORRECT } });
    fireEvent.click(screen.getByTestId("link-password-submit"));

    // The doc renders (title surfaces) and the gate is GONE — not re-prompted in the session (AS-017).
    await waitFor(() => expect(screen.getByText("Secret Spec")).toBeTruthy());
    expect(screen.queryByTestId("link-password-gate")).toBeNull();
  });

  it("AS-018: a wrong password re-prompts with an error; after repeated wrong tries the gate is throttled", async () => {
    renderAt("tok-bbbbbbbbbbbbbbbbbb");
    await waitFor(() => expect(screen.getByTestId("link-password-gate")).toBeTruthy());

    // One wrong attempt → inline error, still on the gate (re-prompt).
    fireEvent.change(screen.getByTestId("link-password-input"), { target: { value: "nope" } });
    fireEvent.click(screen.getByTestId("link-password-submit"));
    await waitFor(() => expect(screen.getByTestId("link-password-error")).toBeTruthy());

    // Keep retrying until the server throttles (mock flips to 429 after 5 wrong attempts).
    for (let i = 0; i < 6; i++) {
      const input = screen.queryByTestId("link-password-input") as HTMLInputElement | null;
      if (!input || input.disabled) break;
      fireEvent.change(input, { target: { value: "nope" } });
      fireEvent.click(screen.getByTestId("link-password-submit"));
      // allow the rejected promise to resolve
      await waitFor(() => expect(redeemCapabilityLink).toHaveBeenCalled());
    }
    await waitFor(() => expect(screen.getByTestId("link-password-rate-limited")).toBeTruthy());
    // The doc was NEVER served on a wrong password (AS-022's FE mirror — no title leaked).
    expect(screen.queryByText("Secret Spec")).toBeNull();
  });
});
