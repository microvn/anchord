// Workspace settings — the typed view over the `workspaces.settings` jsonb, and the
// per-workspace default doc access (shared-workspace model, workspaces:C-007).
//
// shared-workspace model (workspace = shared group space): a workspace's `settings.defaultAccess`
// seeds to `anyone_in_workspace` for EVERY workspace, and an absent/unknown value reads as
// `anyone_in_workspace` — so existing `{}`-settings rows need no migration. NOTE: since the
// two-axis access redesign, publish no longer reads this per-workspace default — it is an
// unread reserved seam kept for a future admin "default access" toggle (v0.5+).

import type { GeneralAccessLevel } from "../sharing/derive-level";

/** The three general-access levels (doc-access-two-axis S-001: now a derived literal type —
 *  the docs.general_access enum is dropped; the canonical type lives in derive-level.ts). */
export type { GeneralAccessLevel };

/** The uniform new-doc default (workspaces:C-007). */
export const DEFAULT_WORKSPACE_ACCESS: GeneralAccessLevel = "anyone_in_workspace";

/**
 * Typed shape of `workspaces.settings`. Loose on the fields other code owns
 * (`providers`, `branding`); only `defaultAccess` is read here.
 */
export interface WorkspaceSettings {
  defaultAccess?: GeneralAccessLevel;
  [key: string]: unknown;
}

/** The settings a freshly created workspace gets (auto-created or user-created). */
export function defaultWorkspaceSettings(): WorkspaceSettings {
  return { defaultAccess: DEFAULT_WORKSPACE_ACCESS };
}

const LEVELS = new Set<string>(["restricted", "anyone_in_workspace", "anyone_with_link"]);

/**
 * Read the default doc access out of a workspace's (untyped) settings jsonb. An
 * absent or unrecognized value reads as `anyone_in_workspace` (workspaces:C-007), so a
 * legacy `{}` row behaves as the shared-group-space default without a migration.
 */
export function parseDefaultAccess(settings: unknown): GeneralAccessLevel {
  const value = (settings as WorkspaceSettings | null | undefined)?.defaultAccess;
  return typeof value === "string" && LEVELS.has(value)
    ? (value as GeneralAccessLevel)
    : DEFAULT_WORKSPACE_ACCESS;
}
