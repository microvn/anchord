import { toast } from "sonner";
import { Icon } from "@/components/icon";

// The "via MCP" tab body of the New-doc dialog (render-publish S-001). Shows the BARE MCP
// transport endpoint with a copy button. Extracted from new-doc-dialog.tsx to keep that file
// under the 350-line lint threshold.
//
// The transport is mounted at a BARE `/mcp` (mcp-roundtrip S-001 / routes/mcp.ts) — the route
// is NOT workspace-scoped: the bearer token carries its workspace, so there is no `/mcp/w/<id>`.
// The displayed value is an ABSOLUTE URL (origin + /mcp) so it pastes straight into an MCP client
// config. Mirrors the canonical "Connect over MCP" block in settings' DeveloperSection.

function mcpEndpoint(): string {
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "http://localhost:3000";
  return `${origin}/mcp`;
}

export function NewDocMcpPane() {
  const endpoint = mcpEndpoint();
  return (
    <div className="rounded-[11px] border border-line bg-sunken p-4" data-testid="mcp-pane">
      <div className="text-[14px] font-semibold text-ink">Publish from your agent</div>
      <p className="mt-1 text-[12.5px] leading-[1.5] text-muted">
        Point your MCP-enabled agent at this endpoint with a personal access token (create one in
        Settings → Developer). Docs land in the default project of the workspace the token belongs
        to.
      </p>
      <div className="mt-3 flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-subtle">Endpoint</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink" data-testid="mcp-pane-endpoint">
          {endpoint}
        </code>
        <button
          type="button"
          aria-label="Copy endpoint"
          onClick={() => {
            void navigator.clipboard?.writeText(endpoint);
            toast.success("Endpoint copied");
          }}
          className="text-subtle hover:text-ink"
        >
          <Icon name="copy" size={15} />
        </button>
      </div>
    </div>
  );
}
