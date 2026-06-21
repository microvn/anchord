import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// workspace-project S-005 — search results (SearchScreen). Client MOCKED. Asserts: results
// render as rows with the "in {matchSource}" tag, and a no-match query renders the
// NoResultsState (distinct from an empty data state — C-007).

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

mock.module("@/features/workspaces/services/client", () => ({
  fetchBootstrap: mock(async () => env({})),
  fetchMembers: mock(async () => env({ members: [], invitations: [] })),
  setActiveWorkspace: mock(async () => env({})),
  createWorkspace: mock(async () => env({})),
  renameWorkspace: mock(async () => env({})),
  inviteMember: mock(async () => env({})),
  removeMember: mock(async () => env({})),
  revokeInvitation: mock(async () => env({})),
  changeMemberRole: mock(async () => env({})),
  acceptInvitation: mock(async () => env({})),
  rejectInvitation: mock(async () => env({})),
}));

let results: unknown;
// S-004: the search response depends on the project scope. `scopedResults` lets a test return
// a different (narrower) set when a projectId is passed vs the whole-workspace set otherwise.
let scopedResults: Record<string, unknown> | null = null;
const defaultSearchDocs = async (_ws: string, _q: string, projectId?: string) => {
  if (scopedResults) return projectId ? scopedResults[projectId] : scopedResults.all;
  return results;
};
const searchDocs = mock(defaultSearchDocs);
const PROJECTS = [
  { id: "p-billing", name: "Billing", isDefault: false, archived: false },
  { id: "p-payments", name: "Payments", isDefault: true, archived: false },
];
mock.module("@/features/docs/services/client", () => ({
  fetchProjects: mock(async () => env({ projects: PROJECTS })),
  fetchProjectDocs: mock(async () => env({ docs: [] })),
  fetchWorkspaceDocs: mock(async () => env({ docs: [], projects: [] })),
  createProject: mock(async () => env({})),
  renameProject: mock(async () => env({})),
  archiveProject: mock(async () => env({})),
  unarchiveProject: mock(async () => env({})),
  deleteProject: mock(async () => env({})),
  searchDocs,
  publishDoc: mock(async () => env({})),
  moveDoc: mock(async () => env({})),
  copyDoc: mock(async () => env({})),
}));

const { SearchScreen } = await import("@/features/docs/components/search-screen");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function App({ q, projectId }: { q: string; projectId?: string }) {
  const qs = `q=${encodeURIComponent(q)}${projectId ? `&projectId=${projectId}` : ""}`;
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[`/w/ws-acme/search?${qs}`]}>
        <Routes>
          <Route path="/w/:workspaceId/search" element={<SearchScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  searchDocs.mockImplementation(defaultSearchDocs);
  searchDocs.mockClear();
  scopedResults = null;
});

describe("workspace-project S-005 — search results", () => {
  it("renders result rows with the match-source tag", async () => {
    results = env({
      results: [
        { docId: "d1", slug: "spec", title: "Web-core spec", kind: "markdown", matchSource: "title" },
        { docId: "d2", slug: "rfc", title: "Publish RFC", kind: "html", matchSource: "comment" },
      ],
    });
    render(<App q="web" />);
    const row = await screen.findByTestId("result-row-spec");
    expect(row).toHaveTextContent("Web-core spec");
    expect(row).toHaveTextContent(/in title/i);
    expect(screen.getByTestId("result-row-rfc")).toHaveTextContent(/in comment/i);
    expect(screen.getByTestId("search-count")).toHaveTextContent("2 results");
  });

  it("a no-match query shows NoResultsState (distinct from empty)", async () => {
    results = env({ results: [] });
    render(<App q="zzzz" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /clear search/i })).toBeInTheDocument(),
    );
    // names the query, no create CTA.
    expect(
      screen.getByText((_, el) => el?.textContent === "No matches for “zzzz”"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /new doc|publish/i })).not.toBeInTheDocument();
  });
});

describe("workspace-project-ui S-004 — search scoped to a project", () => {
  // "invoice" matches a Billing doc and a Payments doc I can access. Scoped to Billing the
  // backend returns only the Billing doc; whole-workspace returns both.
  const billingDoc = { docId: "d-bill", slug: "billing-invoice", title: "Billing Invoice", kind: "markdown", matchSource: "title" };
  const paymentsDoc = { docId: "d-pay", slug: "payments-invoice", title: "Payments Invoice", kind: "html", matchSource: "title" };

  function setScopedResults() {
    scopedResults = {
      "p-billing": env({ results: [billingDoc] }),
      all: env({ results: [billingDoc, paymentsDoc] }),
    };
  }

  it("AS-010: search scoped to a project returns only its accessible docs", async () => {
    setScopedResults();
    // Arrive with the scope already set to Billing (a project context in the URL).
    render(<App q="invoice" projectId="p-billing" />);

    const row = await screen.findByTestId("result-row-billing-invoice");
    expect(row).toHaveTextContent("Billing Invoice");
    // The Payments doc is NOT returned under the Billing scope.
    expect(screen.queryByTestId("result-row-payments-invoice")).not.toBeInTheDocument();
    expect(screen.getByTestId("search-count")).toHaveTextContent("1 result");
    // searchDocs was called with the Billing project id.
    expect(searchDocs.mock.calls.some((c) => c[2] === "p-billing")).toBe(true);
  });

  it("AS-011: switching scope to whole workspace broadens results", async () => {
    setScopedResults();
    const user = userEvent.setup();
    render(<App q="invoice" projectId="p-billing" />);
    // Starts scoped to Billing — only the Billing doc.
    await screen.findByTestId("result-row-billing-invoice");
    expect(screen.queryByTestId("result-row-payments-invoice")).not.toBeInTheDocument();

    // Switch the scope to the whole workspace.
    await user.click(screen.getByTestId("search-scope-trigger"));
    await user.click(await screen.findByTestId("scope-option-all"));

    // Now both docs (across projects) are returned, including the Payments one.
    await waitFor(() =>
      expect(screen.getByTestId("result-row-payments-invoice")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("result-row-billing-invoice")).toBeInTheDocument();
    expect(screen.getByTestId("search-count")).toHaveTextContent("2 results");
    // searchDocs was re-run with projectId undefined (whole-workspace).
    expect(searchDocs.mock.calls.some((c) => c[2] === undefined)).toBe(true);
  });
});

describe("workspace-project-ui S-008 — search results pagination", () => {
  it("AS-025: 28 matches → page 1 shows 20 with a numbered control; page 2 shows the remaining 8", async () => {
    const TOTAL = 28;
    const LIMIT = 20;
    // Page-aware search: the backend access-filters then paginates (28 accessible).
    searchDocs.mockImplementation(
      async (_ws: string, _q: string, _projectId?: string, page = 1, limit = LIMIT) => {
        const start = (page - 1) * limit;
        const results = Array.from(
          { length: Math.max(0, Math.min(limit, TOTAL - start)) },
          (_, i) => {
            const n = start + i + 1;
            return { docId: `d${n}`, slug: `hit-${n}`, title: `Hit ${n}`, kind: "markdown", matchSource: "title" };
          },
        );
        return env({
          results,
          pagination: {
            page,
            limit,
            total: TOTAL,
            totalPages: Math.ceil(TOTAL / limit),
            hasNext: page * limit < TOTAL,
            hasPrevious: page > 1,
          },
        });
      },
    );
    const user = userEvent.setup();

    render(<App q="hit" />);
    // Page 1: results 1..20, not 21; a 2-page numbered control.
    expect(await screen.findByTestId("result-row-hit-1")).toBeInTheDocument();
    expect(screen.getByTestId("result-row-hit-20")).toBeInTheDocument();
    expect(screen.queryByTestId("result-row-hit-21")).not.toBeInTheDocument();
    expect(screen.getByTestId("pagination")).toBeInTheDocument();
    expect(screen.getByTestId("pagination-page-2")).toBeInTheDocument();
    expect(screen.queryByTestId("pagination-page-3")).not.toBeInTheDocument();

    // Page 2: the remaining 8 (21..28); Next disabled.
    await user.click(screen.getByTestId("pagination-page-2"));
    expect(await screen.findByTestId("result-row-hit-28")).toBeInTheDocument();
    expect(screen.getByTestId("result-row-hit-21")).toBeInTheDocument();
    expect(screen.queryByTestId("result-row-hit-20")).not.toBeInTheDocument();
    expect(screen.getByTestId("pagination-next")).toBeDisabled();
  });
});
