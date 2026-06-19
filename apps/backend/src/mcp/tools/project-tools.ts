// mcp-roundtrip S-006 — the project tools: `anchord_list_projects`, `anchord_read_project`,
// and `anchord_create_project`. All three plug into the S-001 pipeline as ToolDef entries —
// list/read declare `projects:read`, create declares `projects:write` (the scope gate in
// server.ts enforces C-009/AS-016 before dispatch, so create never runs for a read-only token).
//
// These are an API SURFACE over the EXISTING workspace-project service — no new content model:
//   • list   → the workspace's ACTIVE projects (repo.listActive — archived excluded), returned
//              to ANY member of the token's workspace (C-010: workspace-member visibility, no
//              per-owner ACL in v0, matching the web ProjectsScreen). Paginated by page + limit.
//   • read   → a project BY ID in the token's workspace (projects have no slug — AS-017); a
//              projectId from another workspace is rejected, not disclosed (same outcome as
//              "not found"), because the read is scoped by the token's workspace_id (C-013).
//   • create → createProject in the token's workspace owned by the token-owner; returns
//              { projectId, name } (usable as a projectId for create_document — AS-015).
//
// CROSS-TENANT INVARIANT (C-010 / C-013): every read is parameterized by the TOKEN's
// workspace_id (ctx.workspaceId), never a path/ambient one — a W1 token only ever sees W1
// projects, and a W2 projectId is invisible (rejected-not-disclosed). create writes into
// ctx.workspaceId as ctx.userId; the params never carry workspace or owner (C-001/C-010).
//
// Everything is behind injectable ports so the tools are unit-testable without a DB (the same
// fake-repo pattern read-tools.test.ts / publish-tools.test.ts use); the route wires the
// concrete Drizzle-backed deps (createProjectRepo) in project-tools-wiring.ts.

import type { ToolContext, ToolDef } from "../server";
import { McpToolError } from "./publish-tools";

// ── shared pagination (page + limit — mirrors read-tools.ts) ─────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface Pagination {
  page: number;
  limit: number;
  total: number;
}

function clampPage(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function clampLimit(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

// ── project summary (the list/read/create row shape) ─────────────────────────

/** A project as the tools return it — id + name (projects have no slug — AS-017). */
export interface ProjectSummary {
  projectId: string;
  name: string;
}

// ── ports (injectable seams over the workspace-project reads + create) ───────

export interface ProjectPorts {
  /**
   * The token's workspace's ACTIVE projects (C-010 — archived excluded), to ANY member of
   * that workspace (workspace-member visibility, no per-owner ACL). Scoped to THIS workspace
   * only (C-013). The handler paginates the returned list.
   */
  listActiveProjects(input: { workspaceId: string }): Promise<ProjectSummary[]>;
  /**
   * Resolve a project BY ID within `workspaceId` (C-013), or null when it does not exist in
   * THAT workspace (a foreign/archived id resolves to null → the handler rejects identically,
   * so existence in another workspace is never disclosed — AS-017).
   */
  findProjectById(input: { workspaceId: string; projectId: string }): Promise<ProjectSummary | null>;
  /**
   * Create a project in `workspaceId` owned by `ownerId` (both from the token — C-010). The
   * name is already trimmed/validated by the handler. Returns the new project's id + name.
   */
  createProject(input: {
    workspaceId: string;
    ownerId: string;
    name: string;
  }): Promise<ProjectSummary>;
}

// ── anchord_list_projects (AS-014 / C-010 / C-013) ──────────────────────────

export interface ListProjectsResult {
  items: ProjectSummary[];
  pagination: Pagination;
}

/**
 * Build `anchord_list_projects` — the active projects of the TOKEN's workspace (ctx.workspaceId,
 * C-013), to any member of that workspace (C-010 workspace-member visibility), paginated by
 * page + limit. Projects of another workspace never appear.
 */
export function listProjectsHandler(
  ports: ProjectPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<ListProjectsResult> {
  return async function handler(params, ctx): Promise<ListProjectsResult> {
    const page = clampPage(params.page);
    const limit = clampLimit(params.limit);

    // C-013: the workspace is the TOKEN's (ctx), never params — a W1 token only lists W1 projects.
    const all = await ports.listActiveProjects({ workspaceId: ctx.workspaceId });
    const total = all.length;
    const start = (page - 1) * limit;
    const items = all.slice(start, start + limit);
    return { items, pagination: { page, limit, total } };
  };
}

export function listProjectsTool(ports: ProjectPorts): ToolDef {
  return { requiredScope: "projects:read", handler: listProjectsHandler(ports) };
}

// ── anchord_read_project(projectId) (AS-017 / C-010 / C-013) ────────────────

function requireProjectId(params: Record<string, unknown>): string {
  const v = params.projectId;
  if (typeof v !== "string" || v.length === 0) {
    throw new McpToolError("'projectId' is required and must be a non-empty string");
  }
  return v;
}

/**
 * Build `anchord_read_project` — resolve a project BY ID in the TOKEN's workspace (C-013). A
 * missing project AND a project in another workspace reject IDENTICALLY (no disclosure — a W1
 * token can't probe for W2 projects). Projects have no slug — id only (AS-017).
 */
export function readProjectHandler(
  ports: ProjectPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<ProjectSummary> {
  return async function handler(params, ctx): Promise<ProjectSummary> {
    const projectId = requireProjectId(params);
    // C-013: scoped by the TOKEN's workspace — a foreign/archived id resolves to null below.
    const project = await ports.findProjectById({ workspaceId: ctx.workspaceId, projectId });
    if (!project) {
      // Existence-hiding: not found and cross-workspace reject identically (AS-017/C-010).
      throw new McpToolError(`project '${projectId}' not found or not accessible`);
    }
    return project;
  };
}

export function readProjectTool(ports: ProjectPorts): ToolDef {
  return { requiredScope: "projects:read", handler: readProjectHandler(ports) };
}

// ── anchord_create_project(name) (AS-015 / C-010, scope-gated AS-016) ───────

/**
 * Build `anchord_create_project` — create a project in the TOKEN's workspace owned by the
 * token-owner (both from ctx — C-010), never from params. Returns { projectId, name }. The
 * scope gate (projects:write — C-009/AS-016) runs in server.ts BEFORE this handler.
 */
export function createProjectHandler(
  ports: ProjectPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<ProjectSummary> {
  return async function handler(params, ctx): Promise<ProjectSummary> {
    const raw = params.name;
    const name = typeof raw === "string" ? raw.trim() : "";
    if (name.length === 0) {
      throw new McpToolError("'name' is required and must be a non-empty string");
    }
    // Identity + workspace come from the TOKEN (ctx), not the params (C-001/C-010).
    return ports.createProject({ workspaceId: ctx.workspaceId, ownerId: ctx.userId, name });
  };
}

export function createProjectTool(ports: ProjectPorts): ToolDef {
  return { requiredScope: "projects:write", handler: createProjectHandler(ports) };
}

// ── registry fragment ───────────────────────────────────────────────────────

/**
 * The project tools as a registry fragment, ready to spread into the server's tool map
 * (`{ ...baselineTools(), ...projectTools(ports) }`). Tool names are `anchord_*` (avoids
 * collisions when an agent mounts several MCP servers).
 */
export function projectTools(ports: ProjectPorts): Record<string, ToolDef> {
  return {
    anchord_list_projects: listProjectsTool(ports),
    anchord_read_project: readProjectTool(ports),
    anchord_create_project: createProjectTool(ports),
  };
}
