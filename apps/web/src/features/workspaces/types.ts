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

/**
 * The label a switcher shows for a workspace: admin-qualified so two "default"s are distinct
 * (AS-001 — "My default" / "Lan's default"). When the caller is the admin we say "My <name>";
 * otherwise "<adminName>'s <name>". Falls back to the bare name when no admin name is known.
 */
export function workspaceLabel(ws: WorkspaceListItem): string {
  if (ws.role === "admin") return `My ${ws.name}`;
  if (ws.adminName) return `${ws.adminName}'s ${ws.name}`;
  return ws.name;
}
