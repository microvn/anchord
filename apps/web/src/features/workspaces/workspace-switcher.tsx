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
import { SidebarMenu, SidebarMenuItem } from "../../components/ui/sidebar";

// S-001 WorkspaceSwitcher — the sidebar's single workspace anchor (C-005). Its TRIGGER is the
// shadcn sidebar team/workspace-switcher pattern: a SidebarMenuButton (glyph + name + role +
// chevron) that opens a DropdownMenu (the dropdown owns open/close, outside-click, keyboard +
// portal). The menu surface reads anchord tokens (no zinc).
// Lists every workspace I belong to (admin-qualified label so two "default"s are distinct —
// AS-001), marks the active one (the route param), and switches by NAVIGATING to `/w/:id/`
// (AS-002). Switching the path re-reads the active-workspace context and re-scopes every
// workspace-keyed query (GAP-001) — no manual cache clear. `+ New workspace` opens the create
// dialog (S-002). Tap targets ≥40px (C-003).
// The two-letter mono workspace glyph (accent-soft tile, accent-ink text).
const WS_GLYPH =
  "inline-flex size-6 flex-none items-center justify-center rounded-sm bg-accent-soft font-mono text-[10px] font-semibold text-accent-ink";
// A dropdown row, anchord style + a ≥40px tap target (C-003).
const MENU_ITEM =
  "flex min-h-[40px] cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-[7px] text-[12.5px] text-ink outline-none transition-colors hover:bg-surface focus:bg-surface data-[highlighted]:bg-surface [&>svg]:flex-none [&>svg]:text-subtle";

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
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="ws-switcher-trigger"
                aria-haspopup="menu"
                // The shadcn sidebar workspace-switcher row, styled with anchord tokens. It is a
                // plain button (NOT SidebarMenuButton) so the switcher renders standalone — many
                // workspaces-ui tests mount it without a SidebarProvider. ≥40px tap target (C-003);
                // collapse-to-icon hides the meta + chevron via the primitive's group-data attr.
                className="flex h-[38px] w-full items-center gap-[9px] overflow-hidden rounded-md border border-transparent pl-[7px] pr-2 text-left text-ink outline-none transition-colors hover:bg-elev focus-visible:ring-2 focus-visible:ring-accent data-[state=open]:border-line data-[state=open]:bg-elev group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
              >
                <span className={WS_GLYPH}>{glyph}</span>
                <span className="grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
                  <span className="truncate text-[12.5px] font-semibold text-ink">
                    {active ? workspaceLabel(active) : "Workspace"}
                  </span>
                  <span className="truncate text-[10.5px] text-subtle">{subLabel}</span>
                </span>
                <Icon name="updown" size={15} className="flex-none text-subtle group-data-[collapsible=icon]:hidden" />
              </button>
            </DropdownMenuTrigger>

            <DropdownMenuContent
              align="start"
              // Anchord menu surface (elev bg + line hairline + pop shadow) — no zinc default.
              className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[232px] rounded-[11px] border border-line bg-elev p-1.5 shadow-[var(--shadow-pop)]"
            >
              <div className="px-[9px] pt-1.5 pb-1 font-mono text-[11px] font-medium tracking-[0.12em] text-subtle uppercase">
                Workspaces
              </div>
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
                    className={MENU_ITEM}
                  >
                    <span className={`${WS_GLYPH} size-[22px]`}>{wsGlyph}</span>
                    <span className={`min-w-0 flex-1 truncate ${isActive ? "font-semibold" : "font-medium"}`}>
                      {workspaceLabel(ws)}
                    </span>
                    {isActive && (
                      // The teal ✓ on the active workspace; testid kept for the active-mark assertion.
                      <span data-testid={`ws-active-mark-${ws.id}`} className="ml-auto inline-flex text-accent">
                        <Icon name="check" size={15} />
                      </span>
                    )}
                  </DropdownMenuItem>
                );
              })}

              <DropdownMenuSeparator className="mx-0.5 my-1.5 h-px bg-line" />

              <DropdownMenuItem
                data-testid="ws-new-trigger"
                onSelect={() => {
                  setOpen(false);
                  setCreating(true);
                }}
                className={`${MENU_ITEM} text-accent-ink`}
              >
                <Icon name="plus" size={16} />
                New workspace
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>

      {creating && <CreateWorkspaceDialog onClose={() => setCreating(false)} />}
    </>
  );
}
