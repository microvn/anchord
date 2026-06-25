// doc-delete-trash S-005 — the MCP delete/restore tools: `anchord_delete_document` and
// `anchord_restore_document`. Both plug into the mcp-roundtrip S-001 pipeline as ToolDef
// entries (requiredScope: "docs:write" — the scope gate in server.ts enforces it before
// dispatch, so these handlers never run for a read-only token).
//
// These are an API SURFACE over the EXISTING soft-delete/restore services
// (workspace/doc-delete.ts `deleteDoc` / `restoreDoc`) — NO new tombstone/restore logic.
// The handler resolves the doc within the TOKEN's workspace, binds the resolved doc's
// workspace to ctx.workspaceId (C-007), and calls the existing service. The service owns the
// composed gate, the conditional (idempotent) tombstone write, the emit-on-change decision,
// and (for restore) the private-on-restore reset (AS-023/AS-031).
//
// MCP GATE (surface-specific, C-003 / S-005 § MCP gate): the MCP layer resolves only a per-doc
// role via resolveAccess — it has NO path that reads workspace_members.role === "admin". So
// delete/restore over MCP are OWNER-OR-EDITOR only (isWorkspaceAdmin is NOT passed to the
// service). A workspace-admin-without-a-per-doc-role can delete/restore on the WEB surface but
// NOT over MCP. This surface difference is intentional and is recorded in C-003.
//
// CROSS-TENANT BINDING (mandatory, C-007 / AS-029): a slug is globally unique and ids are
// guessable, and a token-owner may belong to more than one workspace. Both tools MUST verify
// the resolved doc's workspace equals the token's ctx.workspaceId and reject identically to
// not-found, mirroring read-tools.ts C-013. Resolve-by-slug-or-id is always scoped to the
// token's workspace:
//   • delete  → resolveInWorkspace returns the doc ONLY when it lives in the token's workspace;
//               a doc in another workspace resolves to null → not-found (AS-029).
//   • restore → the restore service resolves via findDeletedById(workspaceId, docId), already
//               scoped to the workspace; the handler resolves the id/slug→docId within the
//               workspace first, so a foreign tombstone is unreachable too.
//
// Everything is behind injectable ports so the tools are unit-testable without a DB (the same
// fake-repo pattern publish-tools.test.ts / read-tools.test.ts use); the route wires the
// concrete service-backed deps in delete-tools-wiring.ts.

import type { ToolContext, ToolDef } from "../server";
import { McpToolError } from "./publish-tools";

/** A doc resolved within the token's workspace — id + slug + its OWN workspace (for the C-007 bind). */
export interface ResolvedDeletableDoc {
  id: string;
  slug: string;
  /** The doc's OWN workspace (docs.project → projects.workspace_id). Gated against the token's. */
  workspaceId: string;
}

export interface DeleteToolResult {
  docId: string;
  slug: string;
  deleted: true;
}

export interface RestoreToolResult {
  docId: string;
  slug: string;
  projectId: string;
  restored: true;
}

export interface DeleteToolsPorts {
  /**
   * Resolve a doc by id OR slug, scoped to the TOKEN's workspace (C-007). Returns the doc + its
   * OWN workspace, or null when no such doc exists in this workspace. The handler re-binds the
   * resolved workspace to ctx.workspaceId (defence-in-depth: even if a resolver ever broadened,
   * the handler still rejects a cross-workspace hit identically to not-found — AS-029).
   */
  resolveInWorkspace(idOrSlug: string, workspaceId: string): Promise<ResolvedDeletableDoc | null>;
  /**
   * Call the EXISTING soft-delete service (workspace/doc-delete.ts `deleteDoc`) — owner-or-editor
   * gate (NO admin arm over MCP, C-003), conditional idempotent tombstone, emit-on-change. Throws
   * the service's DocDeleteRejected (mapped to a tool error by the handler) on a too-low role.
   */
  softDelete(input: {
    workspaceId: string;
    slug: string;
    actorId: string;
  }): Promise<{ docId: string; slug: string }>;
  /**
   * Call the EXISTING restore service (workspace/doc-delete.ts `restoreDoc`) — owner-or-editor
   * gate (NO admin arm), workspace-scoped resolve, restorer-default-project fallback,
   * private-on-restore reset (axes off + token rotated, AS-031), conditional idempotent
   * un-tombstone. Throws DocDeleteRejected on a too-low role / unreachable doc.
   */
  restore(input: {
    workspaceId: string;
    docId: string;
    actorId: string;
  }): Promise<{ docId: string; slug: string; projectId: string }>;
}

function requireIdOrSlug(params: Record<string, unknown>): string {
  // Accept `idOrSlug` (the canonical name); tolerate `docId`/`slug` aliases (GAP-001: slug OR id).
  const v = params.idOrSlug ?? params.docId ?? params.slug;
  if (typeof v !== "string" || v.length === 0) {
    throw new McpToolError("'idOrSlug' is required and must be a non-empty string (the doc's slug or id)");
  }
  return v;
}

/**
 * Map the existing service's DocDeleteRejected onto the MCP error surface. A `not_found` (or any
 * existence-hiding refusal) and a `forbidden` both become a McpToolError; the message is the
 * service's (caller-facing). Recognized structurally so this module doesn't widen its imports.
 */
function isDocDeleteRejected(e: unknown): e is Error & { code: "not_found" | "forbidden" } {
  return e instanceof Error && e.name === "DocDeleteRejected";
}

// ── anchord_delete_document (AS-016 / AS-029 / AS-030, C-002/C-003/C-006/C-007) ──

/**
 * Build `anchord_delete_document`. Order (C-007/C-003): require idOrSlug → resolve WITHIN the
 * token's workspace → bind the resolved doc's workspace to ctx.workspaceId (reject cross-workspace
 * identically to not-found, AS-029) → delegate to the existing soft-delete service (owner-or-editor
 * gate, idempotent tombstone, AS-016/AS-030). The service owns the tombstone; this tool only
 * resolves + binds + delegates.
 */
export function deleteDocumentHandler(
  ports: DeleteToolsPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<DeleteToolResult> {
  return async function handler(params, ctx): Promise<DeleteToolResult> {
    const idOrSlug = requireIdOrSlug(params);

    // C-007: a doc not in THIS workspace (or absent) is unreachable → existence-hiding not-found.
    const doc = await ports.resolveInWorkspace(idOrSlug, ctx.workspaceId);
    const notFound = (): never => {
      throw new McpToolError(`document '${idOrSlug}' not found or not accessible`);
    };
    if (!doc) return notFound();
    // AS-029: a token bound to W-X NEVER reaches a W-Y doc, even if the owner is a W-Y member.
    if (doc.workspaceId !== ctx.workspaceId) return notFound();

    try {
      // AS-016/AS-030: the existing soft-delete service. owner-or-editor only over MCP (no admin
      // arm — isWorkspaceAdmin is never wired here, C-003). Idempotent (C-006).
      const res = await ports.softDelete({
        workspaceId: ctx.workspaceId,
        slug: doc.slug,
        actorId: ctx.userId,
      });
      return { docId: res.docId, slug: res.slug, deleted: true };
    } catch (e) {
      // AS-030: a commenter/viewer (forbidden) or an existence-hiding refusal (not_found) both
      // surface as a caller-facing tool error; the doc stays active.
      if (isDocDeleteRejected(e)) throw new McpToolError(e.message);
      throw e;
    }
  };
}

/** The `anchord_delete_document` ToolDef (scope-gated docs:write — mcp-roundtrip C-009). */
export function deleteDocumentTool(ports: DeleteToolsPorts): ToolDef {
  return { requiredScope: "docs:write", handler: deleteDocumentHandler(ports) };
}

// ── anchord_restore_document (AS-031, C-003/C-006/C-007/C-008) ──────────────────

/**
 * Build `anchord_restore_document`. Order (C-007/C-003): require idOrSlug → resolve the id/slug
 * to a doc id WITHIN the token's workspace → bind the resolved workspace to ctx.workspaceId →
 * delegate to the existing restore service (owner-or-editor gate, restorer-default fallback,
 * private-on-restore reset, idempotent un-tombstone — AS-031). The restore service is itself
 * workspace-scoped (findDeletedById), so the binding is enforced twice (defence-in-depth).
 */
export function restoreDocumentHandler(
  ports: DeleteToolsPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<RestoreToolResult> {
  return async function handler(params, ctx): Promise<RestoreToolResult> {
    const idOrSlug = requireIdOrSlug(params);

    // C-007: resolve the id/slug to a doc id WITHIN the token's workspace. A foreign / absent doc
    // resolves to null → existence-hiding not-found (a deleted doc still resolves — the resolver
    // is not active-only; see delete-tools-wiring.ts).
    const doc = await ports.resolveInWorkspace(idOrSlug, ctx.workspaceId);
    const notFound = (): never => {
      throw new McpToolError(`document '${idOrSlug}' not found or not accessible`);
    };
    if (!doc) return notFound();
    if (doc.workspaceId !== ctx.workspaceId) return notFound();

    try {
      // AS-031: the existing restore service. owner-or-editor only (no admin arm, C-003). Restores
      // into the restorer's default project (or original if present), both axes off + token rotated
      // (AS-023/C-008), idempotent (C-006). The service re-checks the workspace via findDeletedById.
      const res = await ports.restore({ workspaceId: ctx.workspaceId, docId: doc.id, actorId: ctx.userId });
      return { docId: res.docId, slug: res.slug, projectId: res.projectId, restored: true };
    } catch (e) {
      if (isDocDeleteRejected(e)) throw new McpToolError(e.message);
      throw e;
    }
  };
}

/** The `anchord_restore_document` ToolDef (scope-gated docs:write — mcp-roundtrip C-009). */
export function restoreDocumentTool(ports: DeleteToolsPorts): ToolDef {
  return { requiredScope: "docs:write", handler: restoreDocumentHandler(ports) };
}

// ── registry fragment ───────────────────────────────────────────────────────

/**
 * The delete/restore tools as a registry fragment, ready to spread into the server's tool map
 * (`{ ...baselineTools(), ...deleteTools(ports) }`). Tool names are `anchord_*` (avoids
 * collisions when an agent mounts several MCP servers).
 */
export function deleteTools(ports: DeleteToolsPorts): Record<string, ToolDef> {
  return {
    anchord_delete_document: deleteDocumentTool(ports),
    anchord_restore_document: restoreDocumentTool(ports),
  };
}
