// Workspace settings — the typed view over the `workspaces.settings` jsonb, and the
// per-workspace default doc access (shared-workspace model, workspaces:C-007).
//
// shared-workspace model (workspace = shared group space): a workspace's `settings.defaultAccess`
// is the source of truth a publish reads to set a new doc's general_access. It defaults
// to `anyone_in_workspace` for EVERY workspace, and an absent/unknown value reads as
// `anyone_in_workspace` — so existing `{}`-settings rows need no migration.

import { eq } from "drizzle-orm";
import { generalAccess, projects, workspaces } from "../db/schema";
import type { DB } from "../db/client";

/** The three general-access levels (derived from the schema enum — single source). */
export type GeneralAccessLevel = (typeof generalAccess.enumValues)[number];

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

const LEVELS = new Set<string>(generalAccess.enumValues);

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

/**
 * Query a workspace's default doc access — the publish-time source of truth
 * (render-publish:C-011, mcp-roundtrip:C-006). Falls back to `anyone_in_workspace`
 * when the workspace is missing or carries no setting.
 */
export async function readWorkspaceDefaultAccess(
  db: DB,
  workspaceId: string,
): Promise<GeneralAccessLevel> {
  const [row] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return parseDefaultAccess(row?.settings);
}

/**
 * The default doc access of the workspace that owns `projectId` (project → workspace).
 * Used by the copy path (workspace-project:C-008): a copied doc inherits the target
 * workspace's defaultAccess. Falls back to `anyone_in_workspace` when the project or its
 * workspace is missing/setting-less.
 */
export async function readProjectDefaultAccess(
  db: DB,
  projectId: string,
): Promise<GeneralAccessLevel> {
  const [row] = await db
    .select({ settings: workspaces.settings })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(eq(projects.id, projectId))
    .limit(1);
  return parseDefaultAccess(row?.settings);
}
