// mcp-roundtrip S-006 — concrete Drizzle/service wiring for the project tools.
//
// Maps the tools' injectable ports onto the EXISTING workspace-project service (no new
// behaviour):
//   • listActiveProjects → ProjectRepo.listActive(workspaceId) (workspace-project S-003) —
//     non-archived projects in the workspace, to any member (C-010 workspace-member visibility,
//     no per-owner ACL). Scoped to the token's workspace_id (C-013).
//   • findProjectById    → ProjectRepo.findById(workspaceId, projectId) — already filters by
//     workspaceId, so a project in another workspace resolves to null (rejected-not-disclosed,
//     C-013/AS-017). Projects have no slug — id only.
//   • createProject      → the createProject service (workspace-project, C-002 any member) over
//     the same repo: a non-default project owned by the token-owner in the token's workspace.
//
// This module is THIN glue; the testable logic is in project-tools.ts. Kept separate so the
// unit suite never needs a DB. The repo reads are integration-verified in workspace-project.

import type { DB } from "../../db/client";
import { createProjectRepo } from "../../workspace/repo";
import { createProject } from "../../workspace/projects";
import { projectTools, type ProjectPorts, type ProjectSummary } from "./project-tools";
import type { ToolDef } from "../server";

/**
 * Concrete project ports over the workspace-project ProjectRepo + createProject service. All
 * three are scoped by the TOKEN's workspace_id at the call site (the handler passes
 * ctx.workspaceId) — C-013. createProject makes a non-default project owned by the token-owner.
 */
export function createMcpProjectPorts(db: DB): ProjectPorts {
  const repo = createProjectRepo(db);
  const toSummary = (p: { id: string; name: string }): ProjectSummary => ({
    projectId: p.id,
    name: p.name,
  });
  return {
    async listActiveProjects(input): Promise<ProjectSummary[]> {
      // C-010/C-013: the workspace's ACTIVE (non-archived) projects, workspace-scoped.
      const rows = await repo.listActive(input.workspaceId);
      return rows.map(toSummary);
    },
    async findProjectById(input): Promise<ProjectSummary | null> {
      // findById is scoped to (workspaceId, projectId): a foreign id → null → rejected (C-013).
      const row = await repo.findById(input.workspaceId, input.projectId);
      return row ? toSummary(row) : null;
    },
    async createProject(input): Promise<ProjectSummary> {
      // Reuse the workspace-project createProject service (C-002 any member) — a non-default
      // project owned by the token-owner in the token's workspace (C-010).
      const row = await createProject(
        { workspaceId: input.workspaceId, ownerId: input.ownerId, name: input.name },
        { repo },
      );
      return toSummary(row);
    },
  };
}

/** Build the concrete project tool registry fragment for the MCP server. */
export function createProjectToolsForDb(db: DB): Record<string, ToolDef> {
  return projectTools(createMcpProjectPorts(db));
}
