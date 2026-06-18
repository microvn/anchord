// Shapes the workspaces-ui consumes from the `workspaces` backend (Linked Fields).
// Mirrors apps/backend/src/workspace/tenancy.ts (WorkspaceListItem / MemberDirectoryRow /
// InvitationRow) + the /api/me bootstrap envelope's `data`. Kept as a thin local mirror so
// the UI doesn't import server internals; the typed Eden client still enforces the wire shape.

export type WorkspaceRole = "admin" | "member";
export type InvitationStatus = "pending" | "accepted" | "rejected" | "revoked";

/** One workspace as the switcher lists it (GET /api/me → data.workspaces[]). */
export interface WorkspaceListItem {
  id: string;
  name: string;
  slug: string;
  /** The caller's role in THIS workspace — drives admin-only affordances (C-002). */
  role: WorkspaceRole;
  /** The creating admin's display name, so two "default"s disambiguate (AS-001). */
  adminName: string | null;
}

/** The bootstrap payload (GET /api/me → envelope.data). */
export interface Bootstrap {
  userId: string;
  workspaces: WorkspaceListItem[];
  activeWorkspaceId: string | null;
}

/** A member row on the members screen (GET /api/w/:id/members → data.members[]). */
export interface MemberRow {
  userId: string;
  email: string;
  name: string;
  role: WorkspaceRole;
}

/** A pending invitation row (GET /api/w/:id/members → data.invitations[]). */
export interface InvitationRow {
  id: string;
  email: string;
  role: WorkspaceRole;
  status: InvitationStatus;
}

export interface MembersDirectory {
  members: MemberRow[];
  invitations: InvitationRow[];
}

/** Title-case a workspace name for display ("default" → "Default", "hoang nguyen" → "Hoang Nguyen"). */
export function titleCaseName(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * The label a switcher (and the breadcrumb) shows for a workspace (AS-001). Every workspace shows
 * its title-cased name — "default" → "Default", "hoang nguyen" → "Hoang Nguyen". The ONLY exception:
 * the auto-created `default` workspace, seen by its owner (admin), reads "My Default" to mark it as
 * the user's own home workspace. No other workspace is admin-qualified.
 */
export function workspaceLabel(ws: WorkspaceListItem): string {
  if (ws.role === "admin" && ws.name.toLowerCase() === "default") return "My Default";
  return titleCaseName(ws.name);
}
