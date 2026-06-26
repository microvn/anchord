// Drizzle-backed project + browse glue (workspace-project S-003, workspaces S-006). The
// single-workspace bootstrap repo (createWorkspaceRepo) and the old member-management repo
// (createWorkspaceMembersRepo) are GONE — multi-workspace tenancy lives in tenancy-repo.ts.
// What stays here: the ProjectRepo (per-workspace projects), the publish project resolver
// (now workspace-scoped), and the browse-context repo (isInvited + docsInProject).

import { and, eq, isNull, sql } from "drizzle-orm";
import { annotations, docs, docVersions, projects, user, shareLinks } from "../db/schema";
import type { DB } from "../db/client";
import {
  ensureDefaultProject,
  ProjectRejected,
  type ProjectRepo,
  type ProjectRow,
  type ProjectVisibility,
} from "./projects";
import { activeRolesFor } from "../sharing/doc-member-repo";

/** Map a raw Drizzle projects row to the service's ProjectRow shape. */
function rowToProject(row: typeof projects.$inferSelect): ProjectRow {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    ownerId: row.ownerId,
    isDefault: row.isDefault,
    visibility: row.visibility,
    archivedAt: row.archivedAt,
  };
}

/**
 * Drizzle-backed ProjectRepo (workspace-project S-003). THIN glue; all rules
 * (name validation, owner/admin gate, block-non-empty-delete, default-protected,
 * default-project idempotency) live in the projects.ts service.
 */
export function createProjectRepo(db: DB): ProjectRepo {
  return {
    async insert(input): Promise<ProjectRow> {
      // onConflictDoNothing covers the ONE unique index on projects — the partial
      // `projects_default_uq` (C-011). A non-default insert never conflicts; a concurrent
      // first-create of a default project does, and the loser gets an empty `returning()`.
      const [row] = await db
        .insert(projects)
        .values({
          workspaceId: input.workspaceId,
          name: input.name,
          ownerId: input.ownerId,
          isDefault: input.isDefault,
          visibility: input.visibility,
        })
        .onConflictDoNothing()
        .returning();
      if (row) return rowToProject(row);
      // Lost the default-project race (AS-027): the winner already inserted the one default
      // for this (workspace, owner). Read it back so both callers converge on the same project.
      const [winner] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, input.workspaceId),
            eq(projects.ownerId, input.ownerId!),
            eq(projects.isDefault, true),
          ),
        )
        .limit(1);
      if (winner) return rowToProject(winner);
      throw new Error("project insert conflicted but no default project found to read back");
    },

    async findById(workspaceId, projectId): Promise<ProjectRow | null> {
      const [row] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));
      return row ? rowToProject(row) : null;
    },

    async findDefaultFor(workspaceId, ownerId): Promise<ProjectRow | null> {
      const [row] = await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.workspaceId, workspaceId),
            eq(projects.ownerId, ownerId),
            eq(projects.isDefault, true),
          ),
        )
        .limit(1);
      return row ? rowToProject(row) : null;
    },

    async listActive(workspaceId): Promise<ProjectRow[]> {
      const rows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.archivedAt)));
      return rows.map(rowToProject);
    },

    async listAll(workspaceId): Promise<ProjectRow[]> {
      const rows = await db
        .select()
        .from(projects)
        .where(eq(projects.workspaceId, workspaceId));
      return rows.map(rowToProject);
    },

    async setName(projectId, name): Promise<void> {
      await db.update(projects).set({ name }).where(eq(projects.id, projectId));
    },

    async setArchivedAt(projectId, archivedAt): Promise<void> {
      await db.update(projects).set({ archivedAt }).where(eq(projects.id, projectId));
    },

    async setVisibility(projectId, visibility): Promise<void> {
      // project-visibility S-003 / C-008: flips ONLY projects.visibility — no share_links touched,
      // so existing docs' access is unchanged (the new value feeds only future-doc derivation).
      await db.update(projects).set({ visibility }).where(eq(projects.id, projectId));
    },

    async setVisibilityPrivateCascade(projectId): Promise<void> {
      // project-visibility-cascade S-001 / C-001: the make-private cascade — atomic in ONE
      // transaction: (1) flip the project to private, (2) bulk-null BOTH share_links axes for
      // every doc in THIS project. It is a single set-based UPDATE scoped via `doc_id IN (select
      // id from docs where project_id = ?)` — strictly the one project's docs, never another
      // project's. It NEVER writes `doc_members`, so per-user specific invites survive (AS-002),
      // and stores no prior-role history → IRREVERSIBLE. A doc with no share_links row is simply
      // not matched (nothing to null); a doc already restricted is a no-op.
      await db.transaction(async (tx) => {
        await tx.update(projects).set({ visibility: "private" }).where(eq(projects.id, projectId));
        await tx
          .update(shareLinks)
          .set({ workspaceRole: null, linkRole: null })
          .where(
            sql`${shareLinks.docId} in (select ${docs.id} from ${docs} where ${docs.projectId} = ${projectId})`,
          );
      });
    },

    async countDocs(projectId): Promise<number> {
      // doc-delete-trash S-002 / C-002: a soft-deleted doc lives in Trash, not the project, so
      // it is NOT counted here — a project holding only deleted docs counts as empty (deletable).
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(docs)
        .where(and(eq(docs.projectId, projectId), isNull(docs.deletedAt)));
      return row?.n ?? 0;
    },

    async delete(projectId): Promise<void> {
      await db.delete(projects).where(eq(projects.id, projectId));
    },
  };
}

/** A doc row as the browse route needs it (id + the visibility fields + browse columns). */
export interface ProjectDocRow {
  id: string;
  slug: string;
  title: string;
  kind: "html" | "markdown" | "image";
  ownerId: string | null;
  // doc-access-two-axis S-004 / C-006: the raw WORKSPACE axis (share_links.workspace_role IS
  // NOT NULL) — the ONE field canBrowseDoc keys workspace visibility on (the link axis is
  // irrelevant). Kept distinct from the derived `generalAccess` display level, which the link
  // axis dominates (and so cannot be used for the workspace-visibility decision — AS-013).
  workspaceShared: boolean;
  // The derived legacy level — for DISPLAY only (status badge + access summary, AS-026), never
  // the browse decision. C-008: derived on read, never stored.
  generalAccess: "restricted" | "anyone_in_workspace" | "anyone_with_link";
  // doc-access-two-axis S-006 / C-008: the RAW two-axis state (share_links.workspace_role /
  // link_role, null = axis off) carried ALONGSIDE the lossy `generalAccess` summary, so a richer
  // browse consumer (the Share dialog reached from a list row) can tell workspace-shared from
  // link-only — the distinction the 3-value summary drops once the link axis is on (AS-027).
  workspaceRole: "viewer" | "commenter" | "editor" | null;
  linkRole: "viewer" | "commenter" | "editor" | null;
  // Browse columns (workspace-project dashboard rows, Anchord-Design columnar layout).
  // Derived in one query via correlated subqueries — no N+1. Honest values: latestVersion is
  // the doc's highest published version number (0 if none yet); annotationCount counts the
  // doc's ACTIVE annotations (deleted_at IS NULL — soft-deleted tombstones excluded, per
  // workspace-project-ui S-007 / C-006); ownerName is the first-publisher's display name.
  latestVersion: number;
  annotationCount: number;
  ownerName: string | null;
  // S-003/AS-022: the doc's own created + last-updated times, so a browse consumer can sort
  // by Created or Updated without a second fetch (workspace-project-browse:S-003). Serialized
  // to ISO strings on the wire.
  createdAt: Date;
  updatedAt: Date;
}

/** A browse doc row annotated with the active project it belongs to (S-008 workspace-wide read). */
export interface WorkspaceDocRow extends ProjectDocRow {
  projectId: string;
  projectName: string;
  /**
   * project-visibility S-006 / C-004: the project's visibility + owner, so the route can SUPPRESS
   * `projectName` for a non-owner of a PRIVATE project (the doc stays visible via per-doc access, but
   * the private project's NAME must not leak on the card). The suppression is applied at the route
   * (where the caller's id is known), not here — the row carries the raw facts.
   */
  projectVisibility: ProjectVisibility;
  projectOwnerId: string | null;
}

/**
 * Workspace-context reads the projects route group still needs after the multi-workspace
 * conversion (workspaces S-006): the per-doc individual invite (active doc_members) and
 * the docs in a project. The workspace id + the caller's admin flag now come from the
 * path-scoped requireWorkspaceMember gate (ctx.ws), so currentWorkspaceId() (LIMIT-1) and
 * the one-arg isWorkspaceMember (a cross-tenant leak) are GONE.
 */
export interface ProjectsRouteRepo {
  isInvited(docId: string, userId: string): Promise<boolean>;
  docsInProject(projectId: string): Promise<ProjectDocRow[]>;
  /**
   * S-008: every browse doc across the workspace's ACTIVE (non-archived) projects, in ONE
   * pass — each row joined to its project name, ordered most-recently-updated first (the
   * browse order). No per-project loop: a single query joins docs → active projects (+ the
   * browse correlated subqueries) so the route does access-filter + page + count over the
   * union. Out-of-access filtering (C-003) is applied by the route, NOT here.
   */
  workspaceDocs(workspaceId: string): Promise<WorkspaceDocRow[]>;
  /**
   * S-003/AS-028: each project's ACCESSIBLE-doc count for `userId`, in ONE query — a GROUP BY
   * over docs with the SAME access predicate the browse uses (mirrors canBrowseDoc / C-003:
   * owner OR anyone_in_workspace+member OR individually-invited; anyone_with_link is NOT a
   * browse grant). No per-project loop. The count NEVER includes a doc the caller can't access
   * — access filtering happens IN SQL before the count, so it can't leak an out-of-access doc.
   * Returns a Map keyed by projectId; a project with zero accessible docs is simply absent (the
   * route defaults it to 0). Includes archived projects' docs too — the route decides which
   * projects it renders, so the count is keyed by id and only read for the projects it lists.
   */
  countDocsByProject(workspaceId: string, userId: string): Promise<Map<string, number>>;
}

export function createProjectsRouteRepo(db: DB): ProjectsRouteRepo {
  return {
    async isInvited(docId, userId): Promise<boolean> {
      const roles = await activeRolesFor(db, docId, userId);
      return roles.length > 0;
    },
    async docsInProject(projectId): Promise<ProjectDocRow[]> {
      // Correlated subqueries keep this a single round-trip (no per-doc fan-out): the latest
      // published version, the count of ACTIVE annotations on the doc, and the first-
      // publisher's display name. COALESCE keeps version/count numeric (0) when absent.
      // workspace-project-ui S-007 / C-006: count the doc's ACTIVE annotations — deleted_at
      // IS NULL (soft-deleted excluded) AND dismissed_at IS NULL (dismissed detached excluded,
      // annotation-core S-008/C-013) — so this matches the viewer rail's active read exactly
      // (annotation/repo.ts listByDoc), NOT the comment total across its threads.
      const latestVersion = sql<number>`coalesce((
        select max(${docVersions.version}) from ${docVersions}
        where ${docVersions.docId} = ${docs.id}
      ), 0)`;
      const annotationCount = sql<number>`coalesce((
        select count(*) from ${annotations}
        where ${annotations.docId} = ${docs.id}
          and ${annotations.deletedAt} is null
          and ${annotations.dismissedAt} is null
      ), 0)`;
      const rows = await db
        .select({
          id: docs.id,
          slug: docs.slug,
          title: docs.title,
          kind: docs.kind,
          ownerId: docs.ownerId,
          workspaceShared: workspaceSharedSql(),
          generalAccess: derivedLevelSql(),
          // S-006 / C-008: the raw axes alongside the derived summary (AS-027).
          workspaceRole: shareLinks.workspaceRole,
          linkRole: shareLinks.linkRole,
          latestVersion,
          annotationCount,
          ownerName: user.name,
          createdAt: docs.createdAt,
          updatedAt: docs.updatedAt,
        })
        .from(docs)
        .leftJoin(user, eq(user.id, docs.ownerId))
        .leftJoin(shareLinks, eq(shareLinks.docId, docs.id))
        // doc-delete-trash S-002 / C-002: exclude soft-deleted docs (deleted_at IS NOT NULL) —
        // a deleted doc is absent from the project grid (AS-007), visible only in Trash. The
        // docs_active_idx partial index (WHERE deleted_at IS NULL) backs this filter.
        .where(and(eq(docs.projectId, projectId), isNull(docs.deletedAt)));
      // Drizzle returns the count/max as strings from postgres.js — coerce to number.
      return rows.map((r) => ({
        ...r,
        latestVersion: Number(r.latestVersion),
        annotationCount: Number(r.annotationCount),
      }));
    },
    async workspaceDocs(workspaceId): Promise<WorkspaceDocRow[]> {
      // ONE pass over the union: join docs → their ACTIVE project (in this workspace), with
      // the SAME browse correlated subqueries as docsInProject. No per-project query — the
      // inner join to projects (archived_at IS NULL, workspace_id =) restricts to the
      // workspace's active projects and supplies the project name in the same row. Ordered
      // updated-desc, id-desc (stable) so the union page mirrors the browse order.
      const latestVersion = sql<number>`coalesce((
        select max(${docVersions.version}) from ${docVersions}
        where ${docVersions.docId} = ${docs.id}
      ), 0)`;
      const annotationCount = sql<number>`coalesce((
        select count(*) from ${annotations}
        where ${annotations.docId} = ${docs.id}
          and ${annotations.deletedAt} is null
          and ${annotations.dismissedAt} is null
      ), 0)`;
      const rows = await db
        .select({
          id: docs.id,
          slug: docs.slug,
          title: docs.title,
          kind: docs.kind,
          ownerId: docs.ownerId,
          workspaceShared: workspaceSharedSql(),
          generalAccess: derivedLevelSql(),
          // S-006 / C-008: the raw axes alongside the derived summary (AS-027).
          workspaceRole: shareLinks.workspaceRole,
          linkRole: shareLinks.linkRole,
          latestVersion,
          annotationCount,
          ownerName: user.name,
          createdAt: docs.createdAt,
          updatedAt: docs.updatedAt,
          projectId: projects.id,
          projectName: projects.name,
          // project-visibility S-006 / C-004: carry the project's visibility + owner so the route can
          // suppress the name for a non-owner of a private project (the doc still lists — C-005).
          projectVisibility: projects.visibility,
          projectOwnerId: projects.ownerId,
        })
        .from(docs)
        .innerJoin(
          projects,
          and(eq(projects.id, docs.projectId), isNull(projects.archivedAt)),
        )
        .leftJoin(user, eq(user.id, docs.ownerId))
        .leftJoin(shareLinks, eq(shareLinks.docId, docs.id))
        // doc-delete-trash S-002 / C-002: a soft-deleted doc is absent from the workspace
        // browse union (AS-006) — only Trash shows it. (Filtered alongside the active-project
        // join; the docs_active_idx partial index backs the deleted_at IS NULL scan.)
        .where(and(eq(projects.workspaceId, workspaceId), isNull(docs.deletedAt)))
        .orderBy(sql`${docs.updatedAt} desc`, sql`${docs.id} desc`);
      return rows.map((r) => ({
        ...r,
        latestVersion: Number(r.latestVersion),
        annotationCount: Number(r.annotationCount),
      }));
    },
    async countDocsByProject(workspaceId, userId): Promise<Map<string, number>> {
      // ONE GROUP BY (no per-project loop): count each project's docs that pass the ONE shared
      // C-006 workspace-visibility predicate (canBrowseDoc) — owner OR active doc_members invite
      // OR (the WORKSPACE axis is on AND the caller is a member of THIS workspace). The LINK axis
      // is irrelevant: a link-only doc is NOT counted unless the caller is the owner/invited (AS-016).
      // doc-access-two-axis S-004: the workspace grant is `share_links.workspace_role IS NOT NULL`
      // (left-join the doc's share_links row and key on that). The predicate is inlined in SQL with
      // BOUND params (mirrors search-repo's accessible CTE), so an out-of-access doc is never
      // counted — the count and the listed rows come from the SAME filtered set (existence-hiding).
      const rows = await db.execute(sql`
        select d.project_id as project_id, count(*)::int as n
        from docs d
        join projects p on p.id = d.project_id
        left join share_links sl on sl.doc_id = d.id
        where p.workspace_id = ${workspaceId}
          -- doc-delete-trash S-002 / C-002: a soft-deleted doc is not counted (AS-008) — it
          -- lives in Trash, not the project. Backed by the docs_active_idx partial index.
          and d.deleted_at is null
          and (
            d.owner_id = ${userId}
            or (
              sl.workspace_role is not null
              and exists (
                select 1 from workspace_members wm
                where wm.user_id = ${userId}
                  and wm.workspace_id = ${workspaceId}
              )
            )
            or exists (
              select 1 from doc_members m
              where m.doc_id = d.id and m.user_id = ${userId} and m.status = 'active'
            )
          )
        group by d.project_id
      `);
      // postgres.js returns a bare array; some drivers wrap as { rows }. Handle both (as search-repo).
      const list = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
      const counts = new Map<string, number>();
      for (const r of list as Array<Record<string, unknown>>) {
        counts.set(String(r.project_id), Number(r.n));
      }
      return counts;
    },
  };
}

/**
 * Concrete ProjectResolver for the publish path (workspace-project S-003, AS-005 / C-009 /
 * the MCP-missing-projectId fallback), now WORKSPACE-SCOPED (workspaces S-006). The
 * publish route lives under /api/w/:workspaceId/docs, so the workspace comes from the
 * PATH (the requireWorkspaceMember gate proved membership), never a LIMIT-1 lookup.
 *
 *  - requested projectId present → it must exist IN THAT WORKSPACE; a bogus or foreign id
 *    throws ProjectRejected("not_found") (the route → 404). NEVER silently defaults.
 *  - requested projectId omitted → the publisher's default project in that workspace,
 *    creating it on the fly if absent (ensureDefaultProject is idempotent).
 */
export function createPublishProjectResolver(db: DB) {
  const projectRepo = createProjectRepo(db);
  return async (args: {
    workspaceId: string;
    ownerId: string;
    requestedProjectId?: string | null;
  }): Promise<string> => {
    if (args.requestedProjectId != null) {
      const project = await projectRepo.findById(args.workspaceId, args.requestedProjectId);
      if (!project) {
        // Supplied-but-invalid: reject, do NOT default (distinguishes from "omitted").
        throw new ProjectRejected("project not found in this workspace", "not_found");
      }
      return project.id;
    }
    const [u] = await db.select({ name: user.name }).from(user).where(eq(user.id, args.ownerId));
    const def = await ensureDefaultProject(
      { workspaceId: args.workspaceId, ownerId: args.ownerId, userName: u?.name ?? "My" },
      { repo: projectRepo },
    );
    return def.id;
  };
}

// doc-access-two-axis S-004 / C-006: the raw WORKSPACE axis — the doc is shared with its own
// workspace iff share_links.workspace_role IS NOT NULL. This is the field canBrowseDoc keys
// workspace visibility on; the route applies the membership/owner/invite parts of the rule. A
// doc with no share_links row (left join → NULL) is NOT workspace-shared. The link axis is
// deliberately NOT consulted here.
function workspaceSharedSql() {
  return sql<boolean>`(${shareLinks.workspaceRole} is not null)`;
}

// doc-access-two-axis S-001 / C-008: the dropped docs.general_access level is DERIVED in SQL
// from the two share_links axes (deriveLevel's logic, expressed as a CASE) for DISPLAY only —
// the status badge + access summary (AS-026). It is NEVER the browse decision (use
// workspaceSharedSql for that): the link axis dominates this 3-value summary, so a
// workspace+link doc reads as anyone_with_link here even though it IS workspace-shared.
function derivedLevelSql() {
  return sql<"restricted" | "anyone_in_workspace" | "anyone_with_link">`(case
    when ${shareLinks.linkRole} is not null then 'anyone_with_link'
    when ${shareLinks.workspaceRole} is not null then 'anyone_in_workspace'
    else 'restricted' end)`;
}
