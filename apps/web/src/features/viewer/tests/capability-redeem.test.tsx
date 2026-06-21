import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// capability-share-link S-002 — opening a doc through its capability link in the SPA.
//
// AS-004: an anon opens /s/<token> → the redeem resolves the slug, the viewer renders the doc,
//   and the address bar STAYS /s/<token> — the readable slug never appears in the URL (C-009).
// AS-005: an unknown token → redeem 404 → a not-found state, NEVER the viewer or a title.
//
// We mock the viewer client so redeem + the doc read are deterministic, and a location-probe
// component asserts the URL is unchanged by the redeem (the viewer renders by slug WITHOUT a
// navigation). RedeemError carries the 404 status the screen branches on.

class RedeemError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "RedeemError";
    this.status = status;
  }
}

let redeemResult: { slug: string; role: string } | RedeemError;
const redeemCapabilityLink = mock(async () => {
  if (redeemResult instanceof RedeemError) throw redeemResult;
  return redeemResult;
});

let docResponse: unknown;
const ok = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const notFound = () => ({
  data: null,
  error: { status: 404, value: { success: false, error: { code: "NOT_FOUND", message: "nope" } } },
});

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
  useSession: () => ({ data: null, isPending: false }), // anon visitor
  signOut: mock(async () => ok({})),
  authClient: {},
}));

const { CapabilityRedeemScreen } = await import(
  "@/features/viewer/components/capability-redeem-screen"
);

// A probe that records the current URL path so a test can assert it stays the token (C-009).
let lastPath = "";
function LocationProbe() {
  const loc = useLocation();
  lastPath = loc.pathname;
  return null;
}

function renderAt(token: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/s/${token}`]}>
        <LocationProbe />
        <Routes>
          <Route path="/s/:token" element={<CapabilityRedeemScreen />} />
          <Route path="/d/:slug" element={<div data-testid="readable-viewer-leaked" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("capability-link redeem screen", () => {
  beforeEach(() => {
    redeemCapabilityLink.mockClear();
    lastPath = "";
  });

  it("AS-004: anon opens the capability link → doc renders at the link role; URL stays the token, slug never shown", async () => {
    redeemResult = { slug: "secret-refund-spec-9f3a1c", role: "viewer" };
    docResponse = ok({
      doc: {
        title: "Secret Refund Spec",
        kind: "markdown",
        version: 1,
        status: "published",
        generalAccess: "anyone_with_link",
        effectiveRole: "viewer",
        workspaceId: null,
      },
      content: "<p>hello</p>",
    });

    renderAt("tok-aaaaaaaaaaaaaaaaaa");

    // The doc renders (the title surfaces in the viewer top bar).
    await waitFor(() => expect(screen.getByText("Secret Refund Spec")).toBeTruthy());
    // C-009/AS-004: the address bar stays the TOKEN — the readable /d/:slug was never navigated to,
    // and the slug never appears in the URL.
    expect(lastPath).toBe("/s/tok-aaaaaaaaaaaaaaaaaa");
    expect(lastPath).not.toContain("secret-refund-spec");
    expect(screen.queryByTestId("readable-viewer-leaked")).toBeNull();
    expect(redeemCapabilityLink).toHaveBeenCalledTimes(1);
  });

  it("AS-005: an unknown token → not-found, no viewer and no title served", async () => {
    redeemResult = new RedeemError("This link is no longer valid", 404);
    docResponse = notFound();

    renderAt("deadbeefdeadbeefdeadbe");

    await waitFor(() => expect(screen.getByTestId("capability-not-found")).toBeTruthy());
    // No doc title leaked, and the URL still the token (never bounced to /d/:slug).
    expect(screen.queryByText("Secret Refund Spec")).toBeNull();
    expect(lastPath).toBe("/s/deadbeefdeadbeefdeadbe");
  });
});
