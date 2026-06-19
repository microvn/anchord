// mcp-roundtrip S-004 — the pull/read tools: `anchord_pull_annotations` and
// `anchord_list_comments`. Both plug into the S-001 pipeline as ToolDef entries
// (requiredScope: "annotations:read" — the scope gate in server.ts enforces C-009 before
// dispatch, so these handlers never run for a token lacking annotations:read).
//
// These are an API SURFACE over the EXISTING annotation-core model (db/schema.ts annotations
// + comments, src/annotation/*) — no new content model. pull reads the ACTUAL built shape:
//   • anchor jsonb (incl. `segments` for multi_range — NOT truncated to its first segment),
//   • the status fields (status unresolved|resolved, is_orphaned, dismissed_at, deleted_at),
//   • the suggestion payload ({kind: replace|delete, from, to?, againstVersion}) + suggestion_status.
//
// Authorization is the per-RESOURCE gate INSIDE the tool, AFTER the scope check (C-001/C-008):
// pull/list_comments authorize per-doc by the TOKEN-OWNER via resolveAccess, exactly like the
// web path (AS-010.T1) — a doc the owner can't see is rejected, no thread text leaks.
//
// Everything is behind injectable ports so the tools are unit-testable without a DB
// (the same fake-repo pattern publish-tools.test.ts uses); the route wires the concrete
// Drizzle-backed deps in pull-tools-wiring.ts.

import type { ToolContext, ToolDef } from "../server";
import { can, type Role } from "../../sharing/roles";
import { McpToolError } from "./publish-tools";
import type { Anchor } from "../../annotation/annotation";
import type { SuggestionPayload, SuggestionStatus } from "../../annotation/suggestion";

// ── the pull payload shape (C-004 / AS-007) ─────────────────────────────────

/** The full status of an annotation, as pull returns it (C-004 / AS-007.T1). */
export interface PulledStatus {
  /** unresolved | resolved — the resolve toggle (annotation-core S-004). */
  resolution: "unresolved" | "resolved";
  /** re-anchor lost the block/snippet on a new version (annotation-core S-005). */
  isOrphaned: boolean;
  /** a DETACHED annotation cleared from the detached list (annotation-core S-008). */
  dismissed: boolean;
  /** soft-deleted tombstone (annotation-actions S-004) — kept so an agent sees it was removed. */
  deleted: boolean;
}

/** One comment in a pulled thread (flat, one reply level — annotation-core C-004). */
export interface PulledComment {
  id: string;
  parentId: string | null;
  authorName?: string;
  guestName?: string;
  body: string;
  createdAt: string;
}

/** One annotation as pull returns it — enough for an agent to LOCATE and APPLY (C-004). */
export interface PulledAnnotation {
  id: string;
  type: "range" | "multi_range" | "block" | "doc" | "suggestion";
  /**
   * The full anchor (C-004): blockId + textSnippet + offset + length, plus `segments` for
   * a multi_range (the WHOLE multi-range anchor, never truncated to its first segment) and
   * `region` for an image-region anchor.
   */
  anchor: Anchor;
  status: PulledStatus;
  /** present ONLY on a suggestion-type annotation (null otherwise). */
  suggestion: SuggestionPayload | null;
  suggestionStatus: SuggestionStatus | null;
  comments: PulledComment[];
}

/** What `anchord_pull_annotations` returns to the agent. */
export interface PullAnnotationsResult {
  docId: string;
  annotations: PulledAnnotation[];
}

// ── ports (injectable seams over annotation-core + sharing) ─────────────────

/**
 * A pulled annotation row as the pull repo returns it — the FULL annotation-core row,
 * INCLUDING the soft-deleted / dismissed ones (unlike the active-list `listByDoc`, which
 * excludes them). pull must surface them so the agent sees a removed/dismissed annotation's
 * status, not silently drop it (AS-007: "including resolved, orphaned, dismissed").
 */
export interface PullAnnotationRow {
  id: string;
  type: PulledAnnotation["type"];
  anchor: Anchor;
  status: "unresolved" | "resolved";
  isOrphaned: boolean;
  dismissed: boolean;
  deleted: boolean;
  suggestion: SuggestionPayload | null;
  suggestionStatus: SuggestionStatus | null;
}

/** A pulled comment row, tagged with its annotation so the tool groups threads. */
export interface PullCommentRow {
  id: string;
  annotationId: string;
  parentId: string | null;
  authorName?: string;
  guestName?: string;
  body: string;
  createdAt: string;
}

export interface PullPorts {
  /** Resolve the token-owner's effective role on the doc (resolveAccess) — null when none grants one. */
  resolveRole(docId: string, userId: string): Promise<Role | null>;
  /**
   * Every annotation on the doc (INCLUDING soft-deleted + dismissed — AS-007), newest first.
   * NULL/missing doc → []; authorization is gated by resolveRole BEFORE this is called.
   */
  listAllByDoc(docId: string): Promise<PullAnnotationRow[]>;
  /** Every comment on the doc's annotations (incl. on deleted/dismissed ones), creation order. */
  listAllCommentsByDoc(docId: string): Promise<PullCommentRow[]>;
}

// ── anchord_pull_annotations (AS-007 / AS-010.T1, C-004 / C-008) ────────────

function requireDocId(params: Record<string, unknown>): string {
  const v = params.docId;
  if (typeof v !== "string" || v.length === 0) {
    throw new McpToolError("'docId' is required and must be a non-empty string");
  }
  return v;
}

/**
 * Authorize the token-owner per-doc (C-008/AS-010.T1) — a viewer+ role is enough to READ
 * annotations (mirrors the web annotation read: `can(role, "view")`). No role → reject; the
 * repo is never queried, so no thread text leaks for a doc the owner can't see.
 */
async function authorizeRead(ports: PullPorts, docId: string, userId: string): Promise<Role> {
  const role = await ports.resolveRole(docId, userId);
  if (role === null || !can(role, "view")) {
    throw new McpToolError(`not permitted to read annotations on document '${docId}'`);
  }
  return role;
}

/** Group flat comment rows into per-annotation threads, stripping the grouping key. */
function groupComments(rows: PullCommentRow[]): Map<string, PulledComment[]> {
  const threads = new Map<string, PulledComment[]>();
  for (const { annotationId, ...c } of rows) {
    const comment: PulledComment = {
      id: c.id,
      parentId: c.parentId,
      ...(c.authorName != null ? { authorName: c.authorName } : {}),
      ...(c.guestName != null ? { guestName: c.guestName } : {}),
      body: c.body,
      createdAt: c.createdAt,
    };
    const existing = threads.get(annotationId);
    if (existing) existing.push(comment);
    else threads.set(annotationId, [comment]);
  }
  return threads;
}

/**
 * Build the `anchord_pull_annotations` tool. Order (C-001/C-008): require docId → authorize
 * the token-owner per-doc → read the FULL annotation set (incl. resolved/orphaned/dismissed/
 * deleted) + threads → map into the agent-facing payload (status + suggestion + anchor with
 * segments for multi_range — C-004).
 */
export function pullAnnotationsHandler(
  ports: PullPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<PullAnnotationsResult> {
  return async function handler(params, ctx): Promise<PullAnnotationsResult> {
    const docId = requireDocId(params);
    await authorizeRead(ports, docId, ctx.userId); // AS-010.T1: reject a doc the owner can't see.

    const [rows, commentRows] = await Promise.all([
      ports.listAllByDoc(docId),
      ports.listAllCommentsByDoc(docId),
    ]);
    const threads = groupComments(commentRows);

    const annotations: PulledAnnotation[] = rows.map((r) => ({
      id: r.id,
      type: r.type,
      // C-004: the anchor verbatim — `segments` (multi_range) and `region` ride through
      // untouched, so a multi_range annotation is NOT truncated to its first segment (AS-007.T3).
      anchor: r.anchor,
      status: {
        resolution: r.status,
        isOrphaned: r.isOrphaned,
        dismissed: r.dismissed,
        deleted: r.deleted,
      },
      // C-004 / AS-007.T2: the suggestion payload ({kind, from, to?, againstVersion}) + its
      // own lifecycle status (pending/accepted/rejected/stale); null on a non-suggestion row.
      suggestion: r.suggestion,
      suggestionStatus: r.suggestionStatus,
      comments: threads.get(r.id) ?? [],
    }));

    return { docId, annotations };
  };
}

/** The `anchord_pull_annotations` ToolDef (scope-gated annotations:read — C-009). */
export function pullAnnotationsTool(ports: PullPorts): ToolDef {
  return { requiredScope: "annotations:read", handler: pullAnnotationsHandler(ports) };
}

// ── anchord_list_comments (AS-013, paginated — C-009) ───────────────────────

/** One comment thread (flat, one reply level — AS-013) as list_comments returns it. */
export interface CommentThread {
  annotationId: string;
  comments: PulledComment[];
}

export interface ListCommentsResult {
  docId: string;
  items: CommentThread[];
  pagination: { page: number; limit: number; total: number };
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampPage(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

function clampLimit(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

/**
 * Build `anchord_list_comments` — the doc's comment threads (flat, one reply level), paginated
 * by page + limit over the THREADS (one item per annotation that has comments). Authorized
 * per-doc by the token-owner, same as pull (C-008). Convenience read alongside pull (AS-013).
 */
export function listCommentsHandler(
  ports: PullPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<ListCommentsResult> {
  return async function handler(params, ctx): Promise<ListCommentsResult> {
    const docId = requireDocId(params);
    await authorizeRead(ports, docId, ctx.userId);

    const page = clampPage(params.page);
    const limit = clampLimit(params.limit);

    const commentRows = await ports.listAllCommentsByDoc(docId);
    const threads = groupComments(commentRows);
    // Stable order: the repo returns comments in creation order, so the FIRST-seen annotation
    // (oldest root comment) leads — preserve that insertion order for deterministic paging.
    const all: CommentThread[] = [...threads.entries()].map(([annotationId, comments]) => ({
      annotationId,
      comments,
    }));

    const total = all.length;
    const start = (page - 1) * limit;
    const items = all.slice(start, start + limit);
    return { docId, items, pagination: { page, limit, total } };
  };
}

/** The `anchord_list_comments` ToolDef (scope-gated annotations:read — C-009). */
export function listCommentsTool(ports: PullPorts): ToolDef {
  return { requiredScope: "annotations:read", handler: listCommentsHandler(ports) };
}

// ── registry fragment ───────────────────────────────────────────────────────

/**
 * The pull/read tools as a registry fragment, ready to spread into the server's tool map
 * (`{ ...baselineTools(), ...pullTools(ports) }`). Tool names are `anchord_*` (avoids
 * collisions when an agent mounts several MCP servers).
 */
export function pullTools(ports: PullPorts): Record<string, ToolDef> {
  return {
    anchord_pull_annotations: pullAnnotationsTool(ports),
    anchord_list_comments: listCommentsTool(ports),
  };
}
