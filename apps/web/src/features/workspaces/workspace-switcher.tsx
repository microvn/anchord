import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useBootstrap } from "./use-bootstrap";
import { setActiveWorkspace } from "./client";
import { workspaceLabel } from "./types";
import { CreateWorkspaceDialog } from "./create-workspace-dialog";

// S-001 WorkspaceSwitcher (mounts in the AppTopBar workspace-name slot — DESIGN.md chrome that
// recedes). Lists every workspace I belong to (admin-qualified label so two "default"s are
// distinct — AS-001), marks the active one (the route param), and switches by NAVIGATING to
// `/w/:id/` (AS-002). Switching the path re-reads the active-workspace context and re-scopes
// every workspace-keyed query (GAP-001) — no manual cache clear. `+ New workspace` opens the
// create dialog (S-002). Tap targets ≥40px (C-003).
export function WorkspaceSwitcher() {
  const { workspaceId } = useParams();
  const navigate = useNavigate();
  const query = useBootstrap();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const workspaces = query.data?.workspaces ?? [];
  const active = workspaces.find((w) => w.id === workspaceId);

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
    <div className="relative">
      <button
        type="button"
        data-testid="ws-switcher-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex min-h-[40px] items-center gap-1 rounded-md border border-line bg-surface px-3 text-sm text-ink hover:border-accent"
      >
        <span className="max-w-[180px] truncate">{active ? workspaceLabel(active) : "Workspace"}</span>
        <span aria-hidden="true" className="text-muted">▾</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 z-20 mt-1 w-64 rounded-md border border-line bg-elev p-1 shadow-lg"
        >
          {workspaces.map((ws) => {
            const isActive = ws.id === workspaceId;
            return (
              <button
                key={ws.id}
                type="button"
                role="menuitemradio"
                data-testid={`ws-item-${ws.id}`}
                aria-current={isActive ? "true" : undefined}
                aria-checked={isActive}
                onClick={() => void switchTo(ws.id)}
                className="flex min-h-[40px] w-full items-center justify-between rounded-sm px-3 text-left text-sm text-ink hover:bg-accent-soft"
              >
                <span className="truncate">{workspaceLabel(ws)}</span>
                {isActive && (
                  <span aria-hidden="true" className="text-accent" data-testid={`ws-active-mark-${ws.id}`}>
                    ✓
                  </span>
                )}
              </button>
            );
          })}

          <div className="my-1 border-t border-line" />

          <button
            type="button"
            data-testid="ws-new-trigger"
            onClick={() => {
              setOpen(false);
              setCreating(true);
            }}
            className="flex min-h-[40px] w-full items-center rounded-sm px-3 text-left text-sm text-accent hover:bg-accent-soft"
          >
            + New workspace
          </button>
        </div>
      )}

      {creating && <CreateWorkspaceDialog onClose={() => setCreating(false)} />}
    </div>
  );
}
