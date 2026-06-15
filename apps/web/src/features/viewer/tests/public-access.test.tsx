import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useSearchParams } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { QueryClient, QueryCache } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/api-error";
import { notifySessionExpired } from "@/lib/session-expiry";

// doc-access-routing S-003 — the app's viewer works for signed-out visitors.
//
// A signed-out recipient of an anyone_with_link doc lands in the in-app viewer (NOT bounced to
// sign-in); a no-access read renders NoAccessView in place and NEVER fires the global sign-out;
// the variant (sign-in prompt vs "you don't have access") is chosen by the session; signing in
// from the prompt returns the visitor to /d/:slug.
//
// AS-013 anon + anyone_with_link → viewer renders, no redirect to sign-in.
// AS-014 anon + no-access (incl. the annotation read) → "sign in to view" in place, no bounce.
// AS-015 signed-in + no-access → "you don't have access" (no sign-in prompt).
// AS-016 sign in from the prompt → navigates back to /d/:slug.

const ok = (body: unknown) => ({ data: { success: true, data: body }, error: null });
// A no-access reply: the doc-scoped backend returns 404 NOT_FOUND (existence-hiding, never 401).
const notFound = () => ({
  data: null,
  error: { status: 404, value: { success: false, error: { code: "NOT_FOUND", message: "nope" } } },
});

let docResponse: unknown;
let annoResponse: unknown;
const fetchViewerDoc = mock(async () => docResponse);
const listAnnotations = mock(async () => annoResponse);

mock.module("@/features/viewer/services/client", () => ({
  // S-002: stub the redline create/decide so this file's partial client mock still satisfies the
  // imports useCompose/viewer-screen now make (bun mock.module binds exports at load).
  createRedline: mock(async () => ({ data: { success: true, data: { suggestionId: "rl-x" } }, error: null })),
  decideSuggestion: mock(async () => ({ data: { success: true, data: { status: "accepted" } }, error: null })),
  fetchViewerDoc,
  listAnnotations,
  createAnnotation: mock(async () => ({ data: { success: true, data: { annotationId: "a" } }, error: null })),
  addComment: mock(async () => ({ data: { success: true, data: { commentId: "c" } }, error: null })),
  setResolution: mock(async () => ({ data: { success: true, data: { status: "resolved" } }, error: null })),
  canComment: (role: string | undefined) => role !== "viewer",
}));

// The session the viewer reads to pick the anon/signed-in variant. Swapped per test.
let session: { user: { email: string } } | null = null;
mock.module("@/lib/api/auth-client", () => ({
  useSession: () => ({ data: session, isPending: false }),
  signOut: mock(async () => ({ data: { success: true }, error: null })),
  authClient: {},
}));

const { ViewerScreen } = await import("@/features/viewer/components/viewer-screen");

// Build a QueryClient whose cache onError mirrors the real app's (query-client.ts): it exempts
// `meta.viewerRead` reads from the session-expiry bounce. We spy on whether the bounce fired.
let bounced = false;
function client() {
  return new QueryClient({
    // useApiQuery sets its own retry FUNCTION (one retry on non-auth errors), which overrides a
    // plain retry:false here — so make that retry instant instead of the default ~1s backoff.
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (query.meta?.viewerRead) return; // S-003/C-004: viewer reads never bounce.
        if (error instanceof ApiError && error.isUnauthenticated) {
          bounced = true;
          notifySessionExpired();
        }
      },
    }),
  });
}

function App() {
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={["/d/my-doc"]}>
        <Routes>
          <Route path="/d/:slug" element={<ViewerScreen />} />
          {/* AS-016: sign-in landing — the prompt's CTA routes here carrying ?redirect=/d/:slug. */}
          <Route path="/signin" element={<SignInProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

// A stand-in /signin screen that surfaces the ?redirect target so the test can assert the
// return-to-doc wiring (AS-016) without pulling in the real auth flow.
function SignInProbe() {
  // Read the redirect target off the router's search params (MemoryRouter owns the location).
  const [params] = useSearchParams();
  return <div data-testid="signin-screen" data-redirect={params.get("redirect") ?? ""}>sign in</div>;
}

const publicDoc = ok({
  doc: { title: "Public spec", kind: "markdown", version: 1, status: "published", generalAccess: "anyone_with_link" },
  content: "<h2>Hello</h2><p>world</p>",
});

beforeEach(() => {
  fetchViewerDoc.mockClear();
  listAnnotations.mockClear();
  docResponse = undefined;
  annoResponse = ok({ items: [] });
  session = null;
  bounced = false;
});

describe("doc-access-routing S-003 — public viewer for signed-out visitors", () => {
  it("AS-013: a signed-out visitor on an anyone_with_link doc sees the viewer, not a sign-in redirect", async () => {
    session = null; // signed out
    docResponse = publicDoc;

    render(<App />);

    // The in-app viewer renders the doc inline…
    const view = await screen.findByTestId("markdown-view");
    expect(view).toHaveTextContent("Hello");
    // …and the visitor is NOT redirected to sign-in.
    expect(screen.queryByTestId("signin-screen")).toBeNull();
    expect(screen.queryByTestId("no-access-view")).toBeNull();
  });

  it("AS-014: a no-access read on the public viewer shows a sign-in prompt in place and never bounces", async () => {
    session = null; // signed out
    docResponse = notFound(); // the doc read denies (404, existence-hiding)
    annoResponse = notFound(); // the annotation read ALSO denies — must not bounce either

    render(<App />);

    // The no-access surface renders in place, in the sign-in-prompt variant…
    const view = await screen.findByTestId("no-access-view");
    expect(view).toHaveAttribute("data-variant", "signin");
    expect(screen.getByTestId("no-access-signin")).toBeInTheDocument();
    // …and NO doc-scoped read fired the global sign-out / redirect (C-004).
    expect(bounced).toBe(false);
    expect(screen.queryByTestId("signin-screen")).toBeNull();
  });

  it("AS-015: a signed-in visitor without access is told they lack access — no sign-in prompt", async () => {
    session = { user: { email: "a@b.co" } }; // signed in
    docResponse = notFound(); // still no access

    render(<App />);

    const view = await screen.findByTestId("no-access-view");
    // The signed-in variant — a plain "you don't have access" message, NOT a sign-in prompt.
    expect(view).toHaveAttribute("data-variant", "no-access");
    expect(screen.getByTestId("no-access-title")).toHaveTextContent(/don.t have access/i);
    expect(screen.queryByTestId("no-access-signin")).toBeNull();
    expect(bounced).toBe(false);
  });

  it("AS-014 / C-004: the REAL shared QueryClient exempts a viewerRead read from the session bounce", async () => {
    // Lock the guarantee at the infra layer (query-client.ts), not just the test mirror: a
    // viewerRead query that errors UNAUTHENTICATED must NOT publish the session-expired signal,
    // while a non-viewer query with the same error MUST.
    const { createQueryClient } = await import("@/app/query-client");
    const { onSessionExpired } = await import("@/lib/session-expiry");

    let fired = 0;
    const unsub = onSessionExpired(() => {
      fired += 1;
    });
    const qc = createQueryClient();
    const cache = qc.getQueryCache();
    const unauth = new ApiError({ message: "x", code: "UNAUTHENTICATED", status: 401, isUnauthenticated: true });

    // A viewer read → exempt (no bounce).
    cache.config.onError?.(unauth, { meta: { viewerRead: true } } as never);
    expect(fired).toBe(0);
    // A normal read → bounces as before.
    cache.config.onError?.(unauth, { meta: undefined } as never);
    expect(fired).toBe(1);

    unsub();
  });

  it("AS-016: signing in from the prompt navigates back to the same doc (/d/:slug)", async () => {
    session = null; // signed out
    docResponse = notFound();

    render(<App />);

    const cta = await screen.findByTestId("no-access-signin");
    await userEvent.click(cta);

    // The CTA routes to /signin carrying a return target of /d/my-doc (re-resolved on sign-in).
    const signin = await screen.findByTestId("signin-screen");
    expect(signin).toHaveAttribute("data-redirect", "/d/my-doc");
  });
});
