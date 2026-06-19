import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import type { TokenListItem, CreatedToken, CreateTokenInput } from "@/features/settings/types/tokens";

// mcp-roundtrip S-001 — the Developer settings UI (the FE half of AS-020/AS-021). The token data
// layer (use-tokens hooks) and the workspace bootstrap are MOCKED so the surface is deterministic:
//   AS-020 (list)        — the list renders name/workspace/scopes/last-used/expiry + the
//                          `anch_pat_` prefix ONLY; the full token + stored hash are never in the
//                          DOM (the list endpoint returns metadata + prefix only — C-008).
//   AS-020 (reveal-once) — after a successful create the plaintext token shows ONCE in the reveal
//                          card; "Done" removes it and it can't be retrieved again.
//   AS-021               — Revoke calls the revoke mutation and the row disappears.
// Plus: presets set the right 6-scope subsets; create is disabled with no name / zero scopes; the
// MCP-connect block shows the bare /mcp endpoint with NO workspace picker; the 409 cap path
// surfaces a clear error.

// ── token list state (mutable so revoke can drop a row) ──────────────────────────────────────
const TOKEN_A: TokenListItem = {
  id: "tok-a",
  name: "Mara · MacBook Pro",
  workspaceId: "ws-acme",
  workspaceName: "Acme",
  scopes: ["docs:read", "docs:write", "annotations:read"],
  prefix: "anch_pat_",
  lastUsedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  expiresAt: null,
};
const TOKEN_B: TokenListItem = {
  id: "tok-b",
  name: "CI publisher",
  workspaceId: "ws-acme",
  workspaceName: "Acme",
  scopes: ["docs:read", "docs:write"],
  prefix: "anch_pat_",
  lastUsedAt: null,
  expiresAt: "2027-03-12T00:00:00.000Z",
};

// The secret values that must NEVER reach the list render (the list endpoint omits them — C-008).
const FULL_TOKEN_SECRET = "anch_pat_live_deadbeefdeadbeefdeadbeefdeadbeef";
const STORED_HASH = "a3f9c1e8b7d6f5a4c3b2e1d0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0";

let tokenList: TokenListItem[] = [];
let tokensIsError = false;

const createMutate = mock(
  (_input: CreateTokenInput, _opts?: { onSuccess?: (t: CreatedToken) => void; onError?: () => void }) => {},
);
const revokeMutate = mock(
  (_id: string, _opts?: { onSuccess?: () => void; onError?: () => void }) => {},
);
const createReset = mock(() => {});
let createState = { isPending: false, isError: false, error: null as Error | null };

mock.module("@/features/settings/hooks/use-tokens", () => ({
  useTokens: () => ({ data: { tokens: tokenList }, isError: tokensIsError }),
  useCreateToken: () => ({
    mutate: createMutate,
    reset: createReset,
    isPending: createState.isPending,
    isError: createState.isError,
    error: createState.error,
  }),
  useRevokeToken: () => ({ mutate: revokeMutate, isPending: false }),
}));

mock.module("@/features/workspaces/hooks/use-bootstrap", () => ({
  useBootstrap: () => ({
    data: {
      userId: "u-1",
      activeWorkspaceId: "ws-acme",
      workspaces: [
        { id: "ws-acme", name: "acme", slug: "acme", role: "admin", adminName: null },
        { id: "ws-field", name: "field io", slug: "field-io", role: "member", adminName: "Sam" },
      ],
    },
  }),
}));

const toastSuccess = mock(() => {});
const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: toastSuccess, error: toastError }),
}));

const { DeveloperSection } = await import("@/features/settings/components/developer-section");

beforeEach(() => {
  tokenList = [structuredClone(TOKEN_A), structuredClone(TOKEN_B)];
  tokensIsError = false;
  createState = { isPending: false, isError: false, error: null };
  createMutate.mockClear();
  revokeMutate.mockClear();
  createReset.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DeveloperSection />
    </QueryClientProvider>,
  );
}

describe("mcp-roundtrip S-001 — Developer settings UI", () => {
  it("AS-020: the token list renders name, workspace, scopes, last-used, expiry, and the anch_pat_ prefix", () => {
    renderSection();

    const rowA = screen.getByTestId("token-row-tok-a");
    expect(rowA).toHaveTextContent("Mara · MacBook Pro");
    expect(within(rowA).getByTestId("token-prefix-tok-a")).toHaveTextContent("anch_pat_");
    expect(within(rowA).getByTestId("token-workspace-tok-a")).toHaveTextContent("Acme");
    // scopes shown as chips
    expect(within(rowA).getByTestId("token-scope-chip-tok-a-docs:read")).toBeInTheDocument();
    expect(within(rowA).getByTestId("token-scope-chip-tok-a-docs:write")).toBeInTheDocument();
    expect(within(rowA).getByTestId("token-scope-chip-tok-a-annotations:read")).toBeInTheDocument();
    // last-used (relative) + expiry (Never, since expiresAt is null)
    expect(within(rowA).getByTestId("token-last-used-tok-a")).toHaveTextContent("2h ago");
    expect(within(rowA).getByTestId("token-expiry-tok-a")).toHaveTextContent("Never");

    // The second token's "never used" + dated expiry also render.
    const rowB = screen.getByTestId("token-row-tok-b");
    expect(within(rowB).getByTestId("token-last-used-tok-b")).toHaveTextContent("never");
    expect(within(rowB).getByTestId("token-expiry-tok-b")).toHaveTextContent("2027");
  });

  it("AS-020.T2: the full token and the stored hash are NEVER in the list render", () => {
    // These would only exist if the UI wrongly held secrets — TokenListItem carries neither.
    renderSection();
    expect(document.body.textContent).not.toContain(FULL_TOKEN_SECRET);
    expect(document.body.textContent).not.toContain(STORED_HASH);
    // The only token string anywhere is the safe prefix.
    expect(screen.getAllByText("anch_pat_…").length).toBeGreaterThan(0);
  });

  it("AS-020 (reveal-once): a successful create shows the plaintext token once; Done removes it", async () => {
    const user = userEvent.setup();
    const created: CreatedToken = { ...TOKEN_A, id: "tok-new", name: "New token", token: FULL_TOKEN_SECRET };
    // The create mutation invokes onSuccess synchronously with the 201 payload.
    createMutate.mockImplementation((_input, opts) => opts?.onSuccess?.(created));

    renderSection();
    await user.click(screen.getByTestId("generate-token"));
    // Fill the dialog: a name is required (default scopes are the READ-ONLY preset).
    await user.type(screen.getByTestId("token-name"), "New token");
    await user.click(screen.getByTestId("create-token-submit"));

    // The reveal card shows the FULL plaintext token exactly once.
    const reveal = await screen.findByTestId("token-reveal");
    expect(within(reveal).getByTestId("token-reveal-value")).toHaveTextContent(FULL_TOKEN_SECRET);

    // Dismiss → the card (and the plaintext) are gone; it cannot be retrieved again.
    await user.click(within(reveal).getByTestId("token-reveal-done"));
    await waitFor(() => expect(screen.queryByTestId("token-reveal")).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain(FULL_TOKEN_SECRET);
  });

  it("AS-021: clicking Revoke calls the revoke mutation; the row disappears from the active list", async () => {
    const user = userEvent.setup();
    // Revoke success → the backend drops the token; mirror that by removing it from the list source.
    revokeMutate.mockImplementation((id, opts) => {
      tokenList = tokenList.filter((t) => t.id !== id);
      opts?.onSuccess?.();
    });

    const { rerender } = renderSection();
    await user.click(screen.getByTestId("token-revoke-tok-a"));
    expect(revokeMutate).toHaveBeenCalledWith("tok-a", expect.anything());

    // Re-render reads the now-shrunken list (React Query invalidation does this in the app).
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <DeveloperSection />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.queryByTestId("token-row-tok-a")).not.toBeInTheDocument());
    expect(screen.getByTestId("token-row-tok-b")).toBeInTheDocument();
  });

  it("scope presets set the right 6-scope subsets", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByTestId("generate-token"));

    // FULL MCP → all six scopes checked.
    await user.click(screen.getByTestId("token-preset-FULL MCP"));
    for (const s of [
      "docs:read",
      "docs:write",
      "annotations:read",
      "annotations:write",
      "projects:read",
      "projects:write",
    ]) {
      expect(screen.getByTestId(`token-scope-${s}`)).toHaveAttribute("aria-checked", "true");
    }

    // PUBLISH → docs:read/write + projects:read/write only (annotations:* off).
    await user.click(screen.getByTestId("token-preset-PUBLISH"));
    expect(screen.getByTestId("token-scope-docs:write")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("token-scope-projects:write")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("token-scope-annotations:read")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("token-scope-annotations:write")).toHaveAttribute("aria-checked", "false");

    // READ-ONLY → the three read scopes only.
    await user.click(screen.getByTestId("token-preset-READ-ONLY"));
    expect(screen.getByTestId("token-scope-docs:read")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("token-scope-annotations:read")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("token-scope-projects:read")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("token-scope-docs:write")).toHaveAttribute("aria-checked", "false");
  });

  it("create is disabled with no name, and disabled with zero scopes", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByTestId("generate-token"));

    // No name yet (default scopes present) → disabled.
    expect(screen.getByTestId("create-token-submit")).toBeDisabled();

    // Add a name → enabled.
    await user.type(screen.getByTestId("token-name"), "My token");
    expect(screen.getByTestId("create-token-submit")).not.toBeDisabled();

    // Clear all scopes (READ-ONLY default = 3 on) → disabled again + error shown.
    await user.click(screen.getByTestId("token-scope-docs:read"));
    await user.click(screen.getByTestId("token-scope-annotations:read"));
    await user.click(screen.getByTestId("token-scope-projects:read"));
    expect(screen.getByTestId("create-token-submit")).toBeDisabled();
    expect(screen.getByTestId("token-scope-error")).toBeInTheDocument();
  });

  it("the MCP-connect block shows the bare /mcp endpoint and has NO workspace picker", () => {
    renderSection();
    const block = screen.getByTestId("mcp-connect");
    // Bare /mcp — no /mcp/w/<id> path segment.
    expect(screen.getByTestId("mcp-endpoint")).toHaveTextContent("http://localhost:3000/mcp");
    expect(screen.getByTestId("mcp-endpoint").textContent).not.toContain("/mcp/w/");
    // No workspace <select> inside the connect block (the token carries its workspace).
    expect(block.querySelector("select")).toBeNull();
    // The setup snippet uses streamable HTTP + bearer, no npx, no workspace in the path.
    const snippet = screen.getByTestId("mcp-snippet").textContent ?? "";
    expect(snippet).toContain("claude mcp add --transport http anchord http://localhost:3000/mcp");
    expect(snippet).not.toContain("npx");
    // Real tool names are listed.
    expect(screen.getByTestId("mcp-tool-anchord_pull_annotations")).toBeInTheDocument();
    expect(screen.getByTestId("mcp-tool-anchord_create_project")).toBeInTheDocument();
  });

  it("the cap-reached (409) create path surfaces a clear error in the dialog", async () => {
    const user = userEvent.setup();
    // Simulate the hook's 409 mapping: an error state with the cap message.
    createState = {
      isPending: false,
      isError: true,
      error: new Error("You've reached the limit of 10 active tokens. Revoke one to create another."),
    };
    renderSection();
    await user.click(screen.getByTestId("generate-token"));

    expect(screen.getByTestId("create-token-error")).toHaveTextContent(
      "You've reached the limit of 10 active tokens.",
    );
  });
});
