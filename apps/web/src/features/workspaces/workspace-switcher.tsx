import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useBootstrap } from "./use-bootstrap";
import { setActiveWorkspace } from "./client";
import { workspaceLabel } from "./types";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";
import { Icon } from "../../components/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";

// S-001 WorkspaceSwitcher — the sidebar's single workspace anchor (C-005), re-skinned to the
// Anchord-Design `.switcher`/`.menu` look on a shadcn DropdownMenu (which now owns the open/close,
// outside-click, keyboard + portal behavior the old hand-rolled menu did manually).
// Lists every workspace I belong to (admin-qualified label so two "default"s are distinct —
// AS-001), marks the active one (the route param), and switches by NAVIGATING to `/w/:id/`
// (AS-002). Switching the path re-reads the active-workspace context and re-scopes every
// workspace-keyed query (GAP-001) — no manual cache clear. `+ New workspace` opens the create
// dialog (S-002). Tap targets ≥40px (C-003).
export function WorkspaceSwitcher() {
  const { workspaceId } = useParams();
  const navigate = useNavigate();
  const query = useBootstrap();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const workspaces = query.data?.workspaces ?? [];
  const active = workspaces.find((w) => w.id === workspaceId);
  // The two-letter mono glyph in the trigger (Anchord-Design ws-glyph).
  const glyph = (active?.name ?? "W").trim().slice(0, 2).toUpperCase();
  const subLabel = active ? (active.role === "admin" ? "Admin" : "Member") : "—";

  async function switchTo(id: string) {
    setOpen(false);
    if (id === workspaceId) return;
    // Navigate first so the URL (= active scope) changes immediately; persist the
    // login-default landing server-side in the background (C-005). A failed persist does not
    // block the in-session switch — the route already re-scoped the app.
    navigate(`/w/${id}/`);
    try {
      await setActiveWorkspace(id);
    } catch {
      /* non-fatal: the active scope is the route; the persisted landing is best-effort */
    }
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="ws-switcher-trigger"
            aria-haspopup="menu"
            // The visual height is the `.switcher` 38px frame; the ≥40px tap-target class is kept
            // so the C-003 assertion still matches this control.
            className="switcher min-h-[40px]"
          >
            <span className="ws-glyph">{glyph}</span>
            <span className="ws-meta">
              <span className="ws-name block">{active ? workspaceLabel(active) : "Workspace"}</span>
              <span className="ws-sub block">{subLabel}</span>
            </span>
            <Icon name="updown" size={15} className="updown" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="start"
          // Skin the radix content with the Anchord-Design `.menu` surface (drops the zinc default).
          className="menu w-[var(--radix-dropdown-menu-trigger-width)] min-w-[232px] border-0 bg-transparent p-0 shadow-none"
        >
          <div className="menu-label mono-label">Workspaces</div>
          {workspaces.map((ws) => {
            const isActive = ws.id === workspaceId;
            const wsGlyph = ws.name.trim().slice(0, 2).toUpperCase();
            return (
              <DropdownMenuItem
                key={ws.id}
                data-testid={`ws-item-${ws.id}`}
                aria-current={isActive ? "true" : undefined}
                aria-checked={isActive}
                onSelect={() => void switchTo(ws.id)}
                className="menu-item min-h-[40px]"
              >
                <span className="ws-glyph" style={{ width: 22, height: 22 }}>
                  {wsGlyph}
                </span>
                <span className="min-w-0 flex-1 truncate" style={{ fontWeight: isActive ? 600 : 500 }}>
                  {workspaceLabel(ws)}
                </span>
                {isActive && (
                  // The teal ✓ on the active workspace; testid kept for the active-mark assertion.
                  <span data-testid={`ws-active-mark-${ws.id}`} className="check ml-auto inline-flex">
                    <Icon name="check" size={15} />
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}

          <DropdownMenuSeparator className="menu-sep" />

          <DropdownMenuItem
            data-testid="ws-new-trigger"
            onSelect={() => {
              setOpen(false);
              setCreating(true);
            }}
            className="menu-item min-h-[40px] text-accent-ink"
          >
            <Icon name="plus" size={16} className="ic" />
            New workspace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {creating && <CreateWorkspaceDialog onClose={() => setCreating(false)} />}
    </>
  );
}
