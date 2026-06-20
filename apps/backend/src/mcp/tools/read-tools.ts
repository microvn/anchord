// mcp-roundtrip S-003 — the read tools: `anchord_list_documents`,
// `anchord_read_document`, and `anchord_search_documents`. All three plug into the S-001
// pipeline as ToolDef entries (requiredScope: "docs:read" — the scope gate in server.ts
// enforces C-009 before dispatch, so these handlers never run for a token lacking docs:read).
//
// These are an API SURFACE over the EXISTING domain reads — no new content model:
//   • list   → a NEW workspace-wide accessible-docs read (the web FE assembles the
//              accessible set as a per-project union, paginated client-side; there is no
//              server-side workspace-wide query, so the wiring adds one). Returns ONLY docs
//              the token-owner may browse in the TOKEN's workspace (C-003).
//   • read   → resolve by id OR slug, authorize per-doc via resolveAccess by the token-owner.
//   • search → wraps search/search.ts (which returns a BARE ARRAY, not {items, pagination} —
//              the spec's risk note confirmed; this tool paginates over that array and shapes
//              the {items, pagination} envelope AS-006 asks for).
//
// CROSS-TENANT INVARIANT (C-013 / AS-029 — the hard one): every membership/browse check is
// parameterized by the TOKEN's workspace_id (ctx.workspaceId), never a path/ambient one:
//   • list/search take ctx.workspaceId straight into their workspace-scoped reads.
//   • read additionally re-checks the resolved doc's OWN workspace against ctx.workspaceId —
//     resolveAccess resolves a logged-in role against the doc's workspace, so a W1 token whose
//     owner is ALSO a W2 member would otherwise surface a W2 anyone_in_workspace doc; the
//     token-workspace gate rejects it (a W1 token never returns W2 content).
//
// Authorization is the per-RESOURCE gate INSIDE the tool, AFTER the scope check (C-001/C-003):
// list/search source from access-filtered reads; read authorizes per-doc by the token-owner.
//
// Everything is behind injectable ports so the tools are unit-testable without a DB
// (the same fake-repo pattern publish-tools.test.ts / pull-tools.test.ts use); the route
// wires the concrete Drizzle-backed deps in read-tools-wiring.ts.

import type { ToolContext, ToolDef } from "../server";
import { can, type Role } from "../../sharing/roles";
import { McpToolError } from "./publish-tools";
import { addressableBlocks, type AddressableBlock } from "../../render/markdown";

// ── shared pagination (page + limit — AS-006.T2) ────────────────────────────

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

// ── document summary (the list/search row shape) ────────────────────────────

/** A doc as the list/search tools return it — enough to identify + then read it. */
export interface DocumentSummary {
  docId: string;
  slug: string;
  title: string;
  kind: "html" | "markdown" | "image";
}

/** A single doc as read_document returns it (id + slug + the current version's content). */
export interface ReadDocumentResult {
  docId: string;
  slug: string;
  title: string;
  kind: "html" | "markdown" | "image";
  version: number;
  content: string;
  /**
   * The doc's addressable blocks (mcp-patch-document S-001), each `{ blockId, sourceText? }` in
   * document order — the agent's edit-addressing surface for `anchord_patch_document`. `sourceText`
   * is the block's SOURCE-LEVEL string (markdown source for md, innerHTML for html); it is OMITTED
   * for a non-patchable block (no resolvable source range — a table cell, raw-html block, or a
   * token-walk↔rendered-HTML mismatch — GAP-005 fail-closed, AS-023). `content` stays unchanged.
   */
  blocks: AddressableBlock[];
}

// ── ports (injectable seams over the workspace-wide reads + search) ──────────

/** A doc resolved by read_document, BEFORE the token-workspace gate (C-013). */
export interface ResolvedReadDoc {
  docId: string;
  slug: string;
  title: string;
  kind: "html" | "markdown" | "image";
  version: number;
  content: string;
  /** The doc's OWN workspace (docs.project → projects.workspace_id) — gated against the token's. */
  workspaceId: string;
  /** The token-owner's effective role on the doc (resolveAccess), or null when none grants one. */
  role: Role | null;
}

export interface ReadPorts {
  /**
   * The NEW workspace-wide accessible-docs read (AS-006 / C-003): docs the token-owner may
   * BROWSE in `workspaceId` (owner OR anyone_in_workspace+member OR individually invited),
   * scoped to THIS workspace only (C-013). Paginated by offset/limit; returns the page + the
   * total count. Identity + workspace come from the token (the caller passes ctx values).
   */
  listAccessibleDocs(input: {
    workspaceId: string;
    userId: string;
    offset: number;
    limit: number;
  }): Promise<{ items: DocumentSummary[]; total: number }>;
  /**
   * Resolve a doc by id OR slug and authorize the token-owner per-doc (resolveAccess). Returns
   * the doc + its OWN workspace + the owner's role, or null when no such doc exists / no access.
   * The token-workspace gate (C-013) and the role gate are applied by the handler, not here.
   */
  findReadableDoc(idOrSlug: string, userId: string): Promise<ResolvedReadDoc | null>;
  /**
   * Search docs in `workspaceId` (C-013) the token-owner can access (the search service
   * access-filters in SQL — C-003). Returns the FULL access-filtered match list; the handler
   * paginates it (search/search.ts returns a bare array, not {items, pagination}).
   */
  searchAccessibleDocs(input: {
    query: string;
    workspaceId: string;
    userId: string;
  }): Promise<DocumentSummary[]>;
}

// ── anchord_list_documents (AS-006 / C-003 / C-013) ─────────────────────────

export interface ListDocumentsResult {
  items: DocumentSummary[];
  pagination: Pagination;
}

/**
 * Build `anchord_list_documents` — the token-owner's accessible docs in the TOKEN's workspace
 * (ctx.workspaceId, C-013), paginated by page + limit (AS-006.T2). Only docs the owner has
 * browse rights to are returned (C-003); docs outside the scope never appear.
 */
export function listDocumentsHandler(
  ports: ReadPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<ListDocumentsResult> {
  return async function handler(params, ctx): Promise<ListDocumentsResult> {
    const page = clampPage(params.page);
    const limit = clampLimit(params.limit);
    const offset = (page - 1) * limit;

    // C-013: the workspace is the TOKEN's (ctx), never params — a W1 token only lists W1 docs.
    const { items, total } = await ports.listAccessibleDocs({
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      offset,
      limit,
    });
    return { items, pagination: { page, limit, total } };
  };
}

export function listDocumentsTool(ports: ReadPorts): ToolDef {
  return { requiredScope: "docs:read", handler: listDocumentsHandler(ports) };
}

// ── anchord_read_document(idOrSlug) (AS-006 / C-003 / C-013) ────────────────

function requireIdOrSlug(params: Record<string, unknown>): string {
  // Accept `idOrSlug` (the spec's name); tolerate `docId`/`slug` aliases for convenience.
  const v = params.idOrSlug ?? params.docId ?? params.slug;
  if (typeof v !== "string" || v.length === 0) {
    throw new McpToolError("'idOrSlug' is required and must be a non-empty string");
  }
  return v;
}

/**
 * Build `anchord_read_document` — resolve by id OR slug, authorize the token-owner per-doc,
 * and enforce the cross-tenant binding (C-013): the doc's OWN workspace must equal the token's
 * (ctx.workspaceId), else a W1 token could surface a W2 doc the owner sees via W2 membership.
 * A missing doc, a doc in another workspace, or no access → the SAME rejection (no disclosure).
 */
export function readDocumentHandler(
  ports: ReadPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<ReadDocumentResult> {
  return async function handler(params, ctx): Promise<ReadDocumentResult> {
    const idOrSlug = requireIdOrSlug(params);
    const doc = await ports.findReadableDoc(idOrSlug, ctx.userId);

    // Existence-hiding: not found, cross-workspace, and no-access all reject identically so a
    // W1 token can't probe for W2 docs or restricted docs the owner can't see (C-003/C-013/AS-029).
    const denied = (): never => {
      throw new McpToolError(`document '${idOrSlug}' not found or not accessible`);
    };
    if (!doc) return denied();
    // C-013/AS-029: a W1 token NEVER surfaces a W2 doc, even if the owner is a W2 member.
    if (doc.workspaceId !== ctx.workspaceId) return denied();
    // C-003: viewer+ role required to read (mirrors the web doc read: can(role, "view")).
    if (doc.role === null || !can(doc.role, "view")) return denied();

    return {
      docId: doc.docId,
      slug: doc.slug,
      title: doc.title,
      kind: doc.kind,
      version: doc.version,
      content: doc.content,
      // Additive (S-001): the addressable blocks for patch-addressing. Derived purely from the
      // current version's content + kind; a non-patchable block omits sourceText (AS-023). Computed
      // ONLY after the auth gate above, so an unreadable doc leaks no block data (AS-004).
      blocks: addressableBlocks(doc.content, doc.kind),
    };
  };
}

export function readDocumentTool(ports: ReadPorts): ToolDef {
  return { requiredScope: "docs:read", handler: readDocumentHandler(ports) };
}

// ── anchord_search_documents(query) (AS-006 / C-003 / C-013) ────────────────

export interface SearchDocumentsResult {
  items: DocumentSummary[];
  pagination: Pagination;
}

/**
 * Build `anchord_search_documents` — full-text search over docs the token-owner can access in
 * the TOKEN's workspace (C-013), paginated by page + limit (AS-006.T2). The search service
 * access-filters in SQL (C-003); this handler scopes by ctx.workspaceId and slices the bare
 * result array into the {items, pagination} envelope (search/search.ts returns an array).
 */
export function searchDocumentsHandler(
  ports: ReadPorts,
): (params: Record<string, unknown>, ctx: ToolContext) => Promise<SearchDocumentsResult> {
  return async function handler(params, ctx): Promise<SearchDocumentsResult> {
    const query = params.query;
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new McpToolError("'query' is required and must be a non-empty string");
    }
    const page = clampPage(params.page);
    const limit = clampLimit(params.limit);

    // C-013: the workspace is the TOKEN's (ctx) — search never crosses to another workspace.
    const all = await ports.searchAccessibleDocs({
      query: query.trim(),
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
    });
    const total = all.length;
    const start = (page - 1) * limit;
    const items = all.slice(start, start + limit);
    return { items, pagination: { page, limit, total } };
  };
}

export function searchDocumentsTool(ports: ReadPorts): ToolDef {
  return { requiredScope: "docs:read", handler: searchDocumentsHandler(ports) };
}

// ── registry fragment ───────────────────────────────────────────────────────

/**
 * The read tools as a registry fragment, ready to spread into the server's tool map
 * (`{ ...baselineTools(), ...readTools(ports) }`). Tool names are `anchord_*` (avoids
 * collisions when an agent mounts several MCP servers).
 */
export function readTools(ports: ReadPorts): Record<string, ToolDef> {
  return {
    anchord_list_documents: listDocumentsTool(ports),
    anchord_read_document: readDocumentTool(ports),
    anchord_search_documents: searchDocumentsTool(ports),
  };
}
