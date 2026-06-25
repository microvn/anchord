import { useState } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/icon";
import { useBootstrap } from "@/features/workspaces/hooks/use-bootstrap";
import { useTokens, useCreateToken, useRevokeToken } from "@/features/settings/hooks/use-tokens";
import { MCP_TOOLS, type CreatedToken, type CreateTokenInput } from "@/features/settings/types/tokens";
import { TokenRow } from "./token-row";
import { CreateTokenDialog } from "./create-token-dialog";

// mcp-roundtrip S-001 (AS-020/AS-021) — the Developer settings surface, mounted as the
// `developer` section in the account-settings shell. Three blocks:
//   1. the one-time reveal card (shown ONCE right after create — C-008 / AS-020 reveal-once),
//   2. the token list (TokenRow rows; metadata + `anch_pat_` prefix only),
//   3. the MCP-connect block (the BARE /mcp endpoint — the token carries its workspace, so there
//      is NO workspace picker here — plus the real tool list + a copy-paste setup snippet).
//
// Spec deltas applied (AS/Constraints win over the stale prototype): 6 scopes (annotations:* +
// projects:*, not comments:*); 3 presets from the backend; bare /mcp (no /mcp/w/<id>); real tool
// names; the setup snippet uses streamable HTTP + bearer, no npx.

function mcpBaseUrl(): string {
  if (typeof window !== "undefined" && window.location?.origin) return window.location.origin;
  return "http://localhost:3000";
}

// The MCP server name used in the setup snippet. A PAT is bound to ONE workspace, so suffix the
// name with a sanitized workspace slug (`anchord-<workspace>`) — distinct per workspace so a user
// who adds tokens for several workspaces doesn't collide on a single `anchord` server name. Falls
// back to the bare `anchord` before a token is generated (no workspace known yet). Diacritics and
// `đ` are folded so a Vietnamese workspace name yields a clean ASCII identifier.
export function mcpServerName(workspaceName?: string | null): string {
  const base = "anchord";
  const slug = (workspaceName ?? "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining accents (â, é, ơ)
    .replace(/[^a-z0-9]+/g, "-") // any other run → single dash
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, ""); // re-trim if the length cap landed mid-dash
  return slug ? `${base}-${slug}` : base;
}

type SnippetId = "claude" | "cursor" | "codex";

export function DeveloperSection() {
  const bootstrap = useBootstrap();
  const tokensQuery = useTokens();
  const createToken = useCreateToken();
  const revokeToken = useRevokeToken();

  const [creating, setCreating] = useState(false);
  const [generated, setGenerated] = useState<CreatedToken | null>(null);
  const [snippet, setSnippet] = useState<SnippetId>("claude");

  const workspaces = bootstrap.data?.workspaces ?? [];
  const tokens = tokensQuery.data?.tokens ?? [];
  const endpoint = `${mcpBaseUrl()}/mcp`;
  // While a freshly-generated token is still on screen (the once-only reveal), inject the real
  // bearer so the setup snippet is copy-paste-ready. Once the reveal is dismissed the token is
  // gone from state, so the snippet reverts to the `anch_pat_…` placeholder — the secret is never
  // recoverable after Done (C-008 / AS-020.T2).
  const bearer = generated?.token ?? "anch_pat_…";
  // mcp-roundtrip: name the server per the token's workspace (anchord-<workspace>) so adding
  // tokens for multiple workspaces gives each its own server. Bare `anchord` until a token is
  // generated (the workspace is only known from the created token — there is no picker here).
  const serverName = mcpServerName(generated?.workspaceName);

  const snippets: Record<SnippetId, string> = {
    claude: `claude mcp add --transport http ${serverName} \\\n  ${endpoint} \\\n  --header "Authorization: Bearer ${bearer}"`,
    cursor: `// ~/.cursor/mcp.json\n{\n  "mcpServers": {\n    "${serverName}": {\n      "url": "${endpoint}",\n      "headers": { "Authorization": "Bearer ${bearer}" }\n    }\n  }\n}`,
    codex: `# ~/.codex/config.toml\n[mcp_servers.${serverName}]\ntransport = "http"\nurl = "${endpoint}"\nheaders = { Authorization = "Bearer ${bearer}" }`,
  };

  function handleCreate(input: CreateTokenInput) {
    createToken.mutate(input, {
      onSuccess: (created) => {
        setCreating(false);
        // C-008 / AS-020 reveal-once: keep the plaintext token in EPHEMERAL component state only,
        // shown a single time. Dismissing the card drops it; it can never be retrieved again.
        setGenerated(created);
        toast.success("Token generated");
      },
    });
  }

  function handleRevoke(id: string) {
    revokeToken.mutate(id, {
      onSuccess: () => toast.success("Token revoked"),
      onError: () => toast.error("We couldn't revoke that token. Try again."),
    });
  }

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard?.writeText(text);
      toast.success(`${label} copied`);
    } catch {
      toast.error("Couldn't copy to the clipboard.");
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* 1. Reveal card — shown ONCE after a successful create (AS-020 reveal-once). */}
      {generated && (
        <div
          data-testid="token-reveal"
          className="rounded-[12px] border border-accent bg-accent-soft p-4"
        >
          <div className="flex items-center gap-2 text-[12.5px] font-semibold text-accent-ink">
            <Icon name="shield" size={15} />
            Copy your token now
          </div>
          <div className="mb-3 mt-1 text-[11.5px] leading-relaxed text-accent-ink opacity-90">
            “{generated.name}” — this is the only time the full token is shown. Store it somewhere
            safe; you can’t retrieve it again.
          </div>
          <div className="flex items-center gap-2 rounded-[8px] border border-line bg-surface px-3 py-2">
            <code
              data-testid="token-reveal-value"
              className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-ink"
            >
              {generated.token}
            </code>
            <button
              type="button"
              data-testid="token-reveal-copy"
              onClick={() => copy(generated.token, "Token")}
              className="inline-flex h-8 items-center gap-1.5 rounded-[6px] bg-accent px-2.5 text-[12px] font-semibold text-on-accent hover:bg-accent-strong"
            >
              <Icon name="copy" size={14} />
              Copy
            </button>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              data-testid="token-reveal-done"
              onClick={() => setGenerated(null)}
              className="inline-flex h-8 items-center rounded-[6px] border border-line bg-surface px-3 text-[12px] font-medium text-ink hover:bg-elev"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* 2. Token list */}
      <div className="rounded-[12px] border border-line bg-elev">
        <div className="flex items-start gap-3 px-5 pt-4">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-ink">Personal access tokens</div>
            <div className="mt-0.5 text-[11.5px] leading-relaxed text-subtle">
              Tokens authenticate the API and MCP. Each is bound to one workspace and a set of scopes.
            </div>
          </div>
          <button
            type="button"
            data-testid="generate-token"
            onClick={() => setCreating(true)}
            className="inline-flex h-9 flex-none items-center gap-2 rounded-[7px] bg-accent px-3.5 text-[12.5px] font-semibold text-on-accent hover:bg-accent-strong"
          >
            <Icon name="plus" size={16} />
            Generate token
          </button>
        </div>

        {tokensQuery.isError ? (
          <div data-testid="tokens-error" className="px-5 py-8 text-[12.5px] text-subtle">
            We couldn’t load your tokens. Reload to try again.
          </div>
        ) : tokens.length === 0 ? (
          <div data-testid="tokens-empty" className="px-5 py-10 text-center">
            <span className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-sunken text-subtle">
              <Icon name="terminal" size={20} />
            </span>
            <div className="text-[13px] font-semibold text-ink">No tokens yet</div>
            <div className="mx-auto mt-1 max-w-sm text-[11.5px] text-subtle">
              Generate a personal access token to connect an agent or script over the API / MCP.
            </div>
          </div>
        ) : (
          <div data-testid="token-list" className="mt-3.5 border-t border-line">
            {tokens.map((t) => (
              <TokenRow
                key={t.id}
                token={t}
                revoking={revokeToken.isPending}
                onRevoke={handleRevoke}
              />
            ))}
          </div>
        )}
      </div>

      {/* 3. MCP-connect block — the BARE /mcp endpoint (no workspace picker; the token carries it). */}
      <div className="rounded-[12px] border border-line bg-elev" data-testid="mcp-connect">
        <div className="px-5 pt-4">
          <div className="text-[14px] font-semibold text-ink">Connect over MCP</div>
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-subtle">
            Point your agent at the endpoint over streamable HTTP with a bearer token — no npm
            package required. The token carries its workspace.
          </div>
        </div>

        <div className="flex flex-col gap-4 px-5 pb-5 pt-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">Endpoint</span>
            <div className="flex items-center gap-2 rounded-[8px] border border-line bg-sunken px-3 py-2">
              <code
                data-testid="mcp-endpoint"
                className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-ink"
              >
                {endpoint}
              </code>
              <button
                type="button"
                data-testid="mcp-endpoint-copy"
                aria-label="Copy endpoint"
                onClick={() => copy(endpoint, "Endpoint")}
                className="inline-grid size-7 flex-none place-items-center rounded-[6px] text-subtle hover:bg-elev hover:text-ink"
              >
                <Icon name="copy" size={15} />
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">Available tools</span>
            <div className="flex flex-wrap gap-1.5">
              {MCP_TOOLS.map((t) => (
                <span
                  key={t}
                  data-testid={`mcp-tool-${t}`}
                  className="rounded-[4px] border border-line bg-elev px-2 py-1 font-mono text-[10.5px] text-muted"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>

          <div>
            <div className="flex gap-1 border-b border-line">
              {(
                [
                  ["claude", "Claude Code"],
                  ["cursor", "Cursor"],
                  ["codex", "Codex"],
                ] as [SnippetId, string][]
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  data-testid={`snippet-tab-${id}`}
                  onClick={() => setSnippet(id)}
                  className={`-mb-px border-b-2 px-3 py-1.5 text-[12px] ${
                    snippet === id
                      ? "border-accent font-semibold text-ink"
                      : "border-transparent font-medium text-muted hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="relative mt-2.5 overflow-x-auto rounded-[8px] border border-line bg-sunken p-3.5 pr-11">
              <code
                data-testid="mcp-snippet"
                className="block whitespace-pre font-mono text-[12px] leading-relaxed text-ink"
              >
                {snippets[snippet]}
              </code>
              <button
                type="button"
                data-testid="mcp-snippet-copy"
                aria-label="Copy snippet"
                onClick={() => copy(snippets[snippet], "Snippet")}
                className="absolute right-2 top-2 inline-grid size-7 place-items-center rounded-[6px] text-subtle hover:bg-elev hover:text-ink"
              >
                <Icon name="copy" size={15} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {creating && (
        <CreateTokenDialog
          workspaces={workspaces}
          submitting={createToken.isPending}
          error={createToken.isError ? createToken.error?.message ?? "Couldn't create the token." : null}
          onCancel={() => {
            setCreating(false);
            createToken.reset();
          }}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}
