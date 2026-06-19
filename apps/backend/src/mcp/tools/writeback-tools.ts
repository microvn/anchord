// mcp-roundtrip S-005 — the write-back tools: `anchord_reply_comment` and
// `anchord_resolve_comment`. Both plug into the S-001 pipeline as ToolDef entries
// (requiredScope: "annotations:write" — the scope gate in server.ts enforces C-009 before
// dispatch, so these handlers never run for a token lacking annotations:write — AS-009 edge).
//
// These are an API SURFACE over the EXISTING annotation-core services (no new behaviour):
//   • reply   → annotation/reply.ts `addReply` (flat thread, one reply level — C-004) over
//               the comment that the agent replies to.
//   • resolve → annotation/resolve.ts `setResolution(resolved: true)` (idempotent status
//               toggle) over the annotation.
//
// Authorization is the per-RESOURCE gate INSIDE the tool, AFTER the scope check (C-001/C-008):
// reply/resolve authorize per-doc by the TOKEN-OWNER via resolveAccess, exactly like the web
// path. The underlying services then re-authorize on the SAME role (reply → can(role,"comment"),
// resolve → can(role,"resolve") — both commenter+). The tool passes the resolved role straight
// through as the service's `sessionRole`, so the MCP path is NEVER looser than the web path.
//
// Everything is behind injectable ports so the tools are unit-testable without a DB (the same
// fake-repo pattern publish-tools.test.ts / pull-tools.test.ts use); the route wires the
// concrete Drizzle-backed deps in writeback-tools-wiring.ts.

import type { ToolContext, ToolDef } from "../server";
import { can, type Role } from "../../sharing/roles";
import { McpToolError } from "./publish-tools";

// ── shared param helpers ─────────────────────────────────────────────────────

function requireString(params: Record<string, unknown>, field: string): string {
  const v = params[field];
  if (typeof v !== "string" || v.length === 0) {
    throw new McpToolError(`'${field}' is required and must be a non-empty string`);
  }
  return v;
}

// ── ports (injectable seams over annotation-core + sharing) ─────────────────

export interface WritebackPorts {
  /** Resolve the docId + annotationId a comment belongs to, or null if no such comment. */
  findCommentTarget(commentId: string): Promise<{ docId: string; annotationId: string } | null>;
  /** Resolve the docId an annotation belongs to, or null if no such annotation. */
  findAnnotationDoc(annotationId: string): Promise<{ docId: string } | null>;
  /** The token-owner's effective role on the doc (resolveAccess), or null when none grants one. */
  resolveRole(docId: string, userId: string): Promise<Role | null>;
  /**
   * Add a reply to a comment under an annotation, reusing annotation-core `addReply`
   * (flat thread — C-004). `sessionRole` is the role this tool already resolved, so the
   * service re-authorizes on the SAME role (can(role,"comment")). Returns the new reply id.
   */
  addReply(input: {
    annotationId: string;
    parentCommentId: string;
    body: string;
    userId: string;
    sessionRole: Role;
  }): Promise<
    { created: true; id: string; parentId: string } | { created: false; reason: string }
  >;
  /**
   * Resolve an annotation, reusing annotation-core `setResolution(resolved: true)`. Passes
   * the resolved `sessionRole` through so the service re-authorizes on the SAME role
   * (can(role,"resolve")) and applies its own proposal/deleted guards. Idempotent.
   */
  resolveAnnotation(input: {
    annotationId: string;
    userId: string;
    sessionRole: Role;
  }): Promise<{ ok: true; status: "unresolved" | "resolved" } | { ok: false; reason: string }>;
}

// ── anchord_reply_comment (AS-009, C-009 annotations:write) ─────────────────

export interface ReplyCommentResult {
  commentId: string;
  replyId: string;
  /** The thread root the reply attached under (flat — always the root, never a reply). */
  parentId: string;
}

/**
 * Authorize the token-owner per-doc for a WRITE — a commenter+ role is required to reply or
 * resolve (mirrors the web path: `can(role,"comment")` / `can(role,"resolve")`, both
 * commenter+). No role → reject; the service is never reached, so no write happens.
 */
async function authorizeWrite(
  ports: WritebackPorts,
  docId: string,
  userId: string,
  action: "comment" | "resolve",
  what: string,
): Promise<Role> {
  const role = await ports.resolveRole(docId, userId);
  if (role === null || !can(role, action)) {
    throw new McpToolError(`not permitted to ${what}`);
  }
  return role;
}

/**
 * Build `anchord_reply_comment`. Order (C-001/C-008): require params → resolve the comment's
 * doc/annotation (reject a nonexistent commentId) → authorize the token-owner per-doc
 * (commenter+) → reuse addReply (flat thread — C-004).
 */
export function replyCommentHandler(
  ports: WritebackPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<ReplyCommentResult> {
  return async function handler(params, ctx): Promise<ReplyCommentResult> {
    const commentId = requireString(params, "commentId");
    const body = requireString(params, "body");

    // AS-009 edge: a nonexistent commentId is rejected — there is no thread to reply to.
    const target = await ports.findCommentTarget(commentId);
    if (!target) {
      throw new McpToolError(`comment '${commentId}' not found`);
    }

    // AS-009 edge: per-doc authz — the token-owner needs comment rights on the doc (commenter+).
    const role = await authorizeWrite(
      ports,
      target.docId,
      ctx.userId,
      "comment",
      `reply on document '${target.docId}'`,
    );

    const res = await ports.addReply({
      annotationId: target.annotationId,
      parentCommentId: commentId,
      body,
      userId: ctx.userId,
      sessionRole: role,
    });
    if (!res.created) {
      // The service rejected (e.g. empty_body / parent_not_found / forbidden) — surface its
      // reason as a caller-facing tool error (the scope/per-doc gate already passed above).
      throw new McpToolError(`could not add reply: ${res.reason}`);
    }
    return { commentId, replyId: res.id, parentId: res.parentId };
  };
}

/** The `anchord_reply_comment` ToolDef (scope-gated annotations:write — C-009). */
export function replyCommentTool(ports: WritebackPorts): ToolDef {
  return { requiredScope: "annotations:write", handler: replyCommentHandler(ports) };
}

// ── anchord_resolve_comment (AS-009, C-009 annotations:write) ───────────────

export interface ResolveCommentResult {
  annotationId: string;
  status: "unresolved" | "resolved";
}

/**
 * Build `anchord_resolve_comment`. Order (C-001/C-008): require annotationId → resolve the
 * annotation's doc (reject a nonexistent annotationId) → authorize the token-owner per-doc
 * (commenter+) → reuse setResolution(resolved: true) (idempotent — re-resolving is a no-op
 * toggle). The tool always RESOLVES (never reopens) — the agent marks feedback handled.
 */
export function resolveCommentHandler(
  ports: WritebackPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<ResolveCommentResult> {
  return async function handler(params, ctx): Promise<ResolveCommentResult> {
    const annotationId = requireString(params, "annotationId");

    // AS-009 edge: a nonexistent annotationId is rejected — nothing to resolve.
    const target = await ports.findAnnotationDoc(annotationId);
    if (!target) {
      throw new McpToolError(`annotation '${annotationId}' not found`);
    }

    // AS-009 edge: per-doc authz — the token-owner needs resolve rights on the doc (commenter+).
    const role = await authorizeWrite(
      ports,
      target.docId,
      ctx.userId,
      "resolve",
      `resolve annotations on document '${target.docId}'`,
    );

    const res = await ports.resolveAnnotation({ annotationId, userId: ctx.userId, sessionRole: role });
    if (!res.ok) {
      // The service refused (e.g. forbidden / not_found — a soft-deleted annotation, or an
      // owner-only proposal the commenter can't close). Surface its reason; no silent success.
      throw new McpToolError(`could not resolve annotation '${annotationId}': ${res.reason}`);
    }
    return { annotationId, status: res.status };
  };
}

/** The `anchord_resolve_comment` ToolDef (scope-gated annotations:write — C-009). */
export function resolveCommentTool(ports: WritebackPorts): ToolDef {
  return { requiredScope: "annotations:write", handler: resolveCommentHandler(ports) };
}

// ── registry fragment ───────────────────────────────────────────────────────

/**
 * The write-back tools as a registry fragment, ready to spread into the server's tool map
 * (`{ ...baselineTools(), ...writebackTools(ports) }`). Tool names are `anchord_*` (avoids
 * collisions when an agent mounts several MCP servers).
 */
export function writebackTools(ports: WritebackPorts): Record<string, ToolDef> {
  return {
    anchord_reply_comment: replyCommentTool(ports),
    anchord_resolve_comment: resolveCommentTool(ports),
  };
}
