import { toast } from "sonner";
import { Icon } from "../../components/icon";

// The "via MCP" tab body of the New-doc dialog (render-publish S-001). Shows the workspace's
// MCP endpoint with a copy button. Extracted from new-doc-dialog.tsx to keep that file under the
// 350-line lint threshold. Note copy says docs published via MCP land in the default project.

export function NewDocMcpPane({ workspaceId }: { workspaceId: string }) {
  return (
    <div className="rounded-[11px] border border-line bg-sunken p-4" data-testid="mcp-pane">
      <div className="text-[14px] font-semibold text-ink">Publish from your agent</div>
      <p className="mt-1 text-[12.5px] leading-[1.5] text-muted">
        Point your MCP-enabled agent at this workspace. Docs published via MCP land in the default
        project automatically.
      </p>
      <div className="mt-3 flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-subtle">Endpoint</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
          /mcp/w/{workspaceId}
        </code>
        <button
          type="button"
          aria-label="Copy endpoint"
          onClick={() => {
            void navigator.clipboard?.writeText(`/mcp/w/${workspaceId}`);
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
