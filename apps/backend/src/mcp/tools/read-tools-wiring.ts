// mcp-roundtrip S-003 — concrete Drizzle/service wiring for the read tools.
//
// Maps the tools' injectable ports onto the EXISTING reads + the search service, adding the
// ONE thing that did not exist server-side: a workspace-wide accessible-docs query.
//
//   • listAccessibleDocs → a NEW SQL read (the web FE assembled the accessible set as a
//     per-project union, paginated client-side — there was no workspace-wide server query).
//     The access predicate MIRRORS search-repo's `accessible` CTE (= canBrowseDoc): a doc is
//     visible to the owner iff they own it, OR general_access = anyone_in_workspace AND they
//     are a member of THE TOKEN's workspace, OR they are individually invited (active
//     doc_members). Scoped by the TOKEN's workspace_id (C-013) — only docs whose project
//     belongs to that workspace are considered, and anyone_in_workspace resolves against
//     membership of THAT workspace, never "any" (the cross-tenant invariant).
//   • findReadableDoc → resolve by id OR slug, then the shared authoritative `resolveAccess`
//     (doc-access-routing S-001) for the per-doc role, plus the doc's OWN workspace (for the
//     handler's token-workspace gate — C-013). The current version's content is read for the
//     payload (highest `version` row, what the viewer serves).
//   • searchAccessibleDocs → the EXISTING search/search.ts service (access-filtered in SQL —
//     C-003), scoped to the token's workspace; it returns a bare array (NOT {items, pagination}),
//     which the read-tools handler paginates.
//
// This module is THIN glue; the testable logic is in read-tools.ts. Kept separate so the
// unit suite never needs a DB. The NEW SQL read is integration-verified.

import { and, desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { docs, docVersions } from "../../db/schema";
import type { DB } from "../../db/client";
import type { Viewer } from "../../sharing/access";
import type { AccessResult } from "../../sharing/resolve-access";
import { search, type SearchDeps } from "../../search/search";
import {
  readTools,
  type ReadPorts,
  type DocumentSummary,
  type ResolvedReadDoc,
} from "./read-tools";
import type { ToolDef } from "../server";

export interface ReadToolsWiringDeps {
  db: DB;
  /** The shared authoritative per-doc gate (doc-access-routing S-001) — the web read path. */
  resolveAccess: (docId: string, viewer: Viewer) => Promise<AccessResult>;
  /** The doc's OWN workspace (docs.project → projects.workspace_id), or null. */
  workspaceOfDoc: (docId: string) => Promise<string | null>;
  /** Search deps (the repo + optional defense-in-depth re-check) for search/search.ts. */
  search: SearchDeps;
}

const KIND_VALUES = new Set(["html", "markdown", "image"]);
function asKind(v: unknown): DocumentSummary["kind"] {
  return KIND_VALUES.has(v as string) ? (v as DocumentSummary["kind"]) : "html";
}

/**
 * Concrete read ports. listAccessibleDocs is the NEW workspace-wide query; findReadableDoc and
 * searchAccessibleDocs reuse resolveAccess + the search service. All three are scoped by the
 * TOKEN's workspace_id at the call site (the handler passes ctx.workspaceId) — C-013.
 */
export function createMcpReadPorts(deps: ReadToolsWiringDeps): ReadPorts {
  const { db, resolveAccess, workspaceOfDoc } = deps;
  return {
    async listAccessibleDocs(input): Promise<{ items: DocumentSummary[]; total: number }> {
      // The NEW workspace-wide accessible-docs read (AS-006 / C-003 / C-013). The predicate
      // mirrors canBrowseDoc and is scoped to input.workspaceId (the token's). Counted + paged
      // in SQL so the agent can page a large workspace without pulling every row.
      const accessible = sql`
        select d.id, d.slug, d.title, d.kind
        from docs d
        join projects p on p.id = d.project_id
        where p.workspace_id = ${input.workspaceId}
          and (
            d.owner_id = ${input.userId}
            or (
              d.general_access = 'anyone_in_workspace'
              and exists (
                select 1 from workspace_members wm
                where wm.user_id = ${input.userId}
                  and wm.workspace_id = ${input.workspaceId}
              )
            )
            or exists (
              select 1 from doc_members m
              where m.doc_id = d.id and m.user_id = ${input.userId} and m.status = 'active'
            )
          )
      `;
      const pageRows = await db.execute(sql`
        ${accessible}
        order by d.created_at desc
        limit ${input.limit} offset ${input.offset}
      `);
      const countRows = await db.execute(sql`
        select count(*)::int as total from (${accessible}) as a
      `);
      const items = rowsOf(pageRows).map((r) => ({
        docId: String(r.id),
        slug: String(r.slug),
        title: String(r.title),
        kind: asKind(r.kind),
      }));
      const total = Number(rowsOf(countRows)[0]?.total ?? 0);
      return { items, total };
    },

    async findReadableDoc(idOrSlug, userId): Promise<ResolvedReadDoc | null> {
      // Resolve by id OR slug (the project model has no slug; docs do — AS-006).
      const [doc] = await db
        .select({
          id: docs.id,
          slug: docs.slug,
          title: docs.title,
          kind: docs.kind,
        })
        .from(docs)
        .where(sql`${docs.id} = ${idOrSlug} or ${docs.slug} = ${idOrSlug}`)
        .limit(1);
      if (!doc) return null;

      // Per-doc authorization by the token-owner (resolveAccess) — the web read path.
      const viewer: Viewer = { kind: "user", userId };
      const { role } = await resolveAccess(doc.id, viewer);

      // The doc's OWN workspace (for the handler's token-workspace gate — C-013/AS-029).
      const docWorkspace = (await workspaceOfDoc(doc.id)) ?? "";

      // Current version = the highest version row (what the viewer serves).
      const [ver] = await db
        .select({ version: docVersions.version, content: docVersions.content })
        .from(docVersions)
        .where(eq(docVersions.docId, doc.id))
        .orderBy(desc(docVersions.version))
        .limit(1);

      return {
        docId: doc.id,
        slug: doc.slug,
        title: doc.title,
        kind: doc.kind,
        version: ver?.version ?? 0,
        content: ver?.content ?? "",
        workspaceId: docWorkspace,
        role,
      };
    },

    async searchAccessibleDocs(input): Promise<DocumentSummary[]> {
      // The EXISTING search service (access-filtered in SQL — C-003), scoped to the token's
      // workspace (C-013). It returns a bare array; the handler paginates it.
      const results = await search(
        { q: input.query, userId: input.userId, workspaceId: input.workspaceId },
        deps.search,
      );
      return results.map((r) => ({
        docId: r.docId,
        slug: r.slug,
        title: r.title,
        kind: r.kind,
      }));
    },
  };
}

/** Drizzle's `db.execute` returns either `{rows}` or a bare array depending on the driver. */
function rowsOf(res: unknown): Array<Record<string, unknown>> {
  const list = (res as { rows?: unknown[] }).rows ?? (res as unknown[]);
  return list as Array<Record<string, unknown>>;
}

/** Build the concrete read tool registry fragment for the MCP server. */
export function createReadToolsForDb(deps: ReadToolsWiringDeps): Record<string, ToolDef> {
  return readTools(createMcpReadPorts(deps));
}
