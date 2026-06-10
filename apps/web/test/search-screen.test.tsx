import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";

// workspace-project S-005 — search results (SearchScreen). Client MOCKED. Asserts: results
// render as rows with the "in {matchSource}" tag, and a no-match query renders the
// NoResultsState (distinct from an empty data state — C-007).

const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });

mock.module("../src/features/workspaces/client", () => ({
  fetchBootstrap: mock(async () => env({})),
  fetchMembers: mock(async () => env({ members: [], invitations: [] })),
  setActiveWorkspace: mock(async () => env({})),
  createWorkspace: mock(async () => env({})),
  renameWorkspace: mock(async () => env({})),
  inviteMember: mock(async () => env({})),
  removeMember: mock(async () => env({})),
  changeMemberRole: mock(async () => env({})),
  acceptInvitation: mock(async () => env({})),
  rejectInvitation: mock(async () => env({})),
}));

let results: unknown;
const searchDocs = mock(async () => results);
mock.module("../src/features/docs/client", () => ({
  fetchProjects: mock(async () => env({ projects: [] })),
  fetchProjectDocs: mock(async () => env({ docs: [] })),
  createProject: mock(async () => env({})),
  searchDocs,
  publishDoc: mock(async () => env({})),
  moveDoc: mock(async () => env({})),
  copyDoc: mock(async () => env({})),
}));

const { SearchScreen } = await import("../src/features/docs/search-screen");

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function App({ q }: { q: string }) {
  return (
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[`/w/ws-acme/search?q=${encodeURIComponent(q)}`]}>
        <Routes>
          <Route path="/w/:workspaceId/search" element={<SearchScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  searchDocs.mockClear();
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
