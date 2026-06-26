// Drizzle-backed DocMoveRepo (workspace-project S-004). THIN glue between the
// move/copy service (doc-move.ts) and Postgres. No business logic lives here — the
// authz, same-workspace guard, and clean-copy rules are in the service; this only
// reads/writes rows.
//
//  - findDocBySlug      → the source doc (id/slug/title/kind/project_id).
//  - targetProjectViewableBy → the write-target guard (project-visibility S-002 / C-006): the
//                          project must EXIST in a workspace AND be one the ACTOR may VIEW
//                          (canViewProject — own OR public). A bogus id, a cross-workspace id,
//                          and another member's PRIVATE project all → false → 404 (existence-
//                          hiding), never a silent write into an unseeable project.
//  - currentVersion     → the source's CURRENT (max-version) content + hash. Mirrors the
//                          search repo's "order by version desc limit 1" current read.
//  - setProjectId       → MOVE: update ONLY docs.project_id. Nothing else is touched, so
//                          versions/annotations/sharing/owner/general_access all stay.
//  - createCopy         → COPY: insert a NEW doc (new slug; owner = the copier) + its
//                          version 1 + its share_links access config (the FIXED new-doc
//                          default workspace_role=commenter/link_role=null — doc-access-two-axis
//                          S-002/C-007) in one transaction. Does NOT copy annotations/
//                          comments/history or the source's sharing (clean copy).
//
// Integration-verified against real Postgres in test/integration/doc-move.itest.ts.

import { desc, eq } from "drizzle-orm";
import { docs, docVersions, projects, shareLinks, workspaces } from "../db/schema";
import type { DB } from "../db/client";
import { generateSlug } from "../publish/slug";
import { canViewProject, deriveNewDocAccess } from "./projects";
import type { DocMoveRepo, SourceDoc, CurrentVersion, TargetProjectAccess } from "./doc-move";

/** Construct a DocMoveRepo backed by a Drizzle DB handle. */
export function createDocMoveRepo(db: DB): DocMoveRepo {
  return {
    async findDocBySlug(slug: string): Promise<SourceDoc | null> {
      // project-visibility S-005 / C-009: also read the doc's CURRENT workspace axis
      // (share_links.workspace_role) on this same fetch — the move boundary-detection compares
      // it against the target project's visibility. LEFT join so a doc with no share_links row
      // (shouldn't happen post-publish) still resolves with workspaceRole = null (restricted).
      const [row] = await db
        .select({
          id: docs.id,
          slug: docs.slug,
          title: docs.title,
          kind: docs.kind,
          projectId: docs.projectId,
          workspaceRole: shareLinks.workspaceRole,
        })
        .from(docs)
        .leftJoin(shareLinks, eq(shareLinks.docId, docs.id))
        .where(eq(docs.slug, slug));
      if (!row) return null;
      return { ...row, workspaceRole: row.workspaceRole ?? null };
    },

    async targetProjectViewableBy(projectId: string, actorId: string): Promise<boolean> {
      // project-visibility S-002 / C-006: the target must EXIST in a workspace AND be a project
      // the ACTOR may VIEW (canViewProject — owner OR public, no admin exception, C-003). The
      // same-workspace existence guard is the inner join through workspaces (a bogus id → no
      // row → false). A foreign-member PRIVATE project IS a row but fails canViewProject →
      // false → the route refuses identically to not-found (existence-hiding — AS-009).
      const [row] = await db
        .select({ ownerId: projects.ownerId, visibility: projects.visibility })
        .from(projects)
        .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!row) return false;
      return canViewProject(actorId, { ownerId: row.ownerId, visibility: row.visibility });
    },

    async currentVersion(docId: string): Promise<CurrentVersion | null> {
      // Current = highest version row (mirrors search-repo's "order by version desc
      // limit 1" — that is what the viewer serves).
      const [row] = await db
        .select({ content: docVersions.content, contentHash: docVersions.contentHash })
        .from(docVersions)
        .where(eq(docVersions.docId, docId))
        .orderBy(desc(docVersions.version))
        .limit(1);
      return row ?? null;
    },

    async setProjectId(docId: string, projectId: string): Promise<void> {
      // MOVE: relocate the doc — ONLY project_id changes. updated_at bumps via $onUpdate;
      // versions/annotations/sharing/owner/general_access rows are untouched.
      await db.update(docs).set({ projectId }).where(eq(docs.id, docId));
    },

    async targetProjectAccess(projectId: string): Promise<TargetProjectAccess | null> {
      // project-visibility S-005 / C-009: the access-relevant facts of the move target so the
      // service can detect a visibility boundary (isDefault + visibility — same inputs as
      // deriveNewDocAccess, so the default-project carve-out matches the publish/copy paths).
      const [row] = await db
        .select({ isDefault: projects.isDefault, visibility: projects.visibility })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      return row ?? null;
    },

    async moveWithAccess(docId: string, projectId: string, restrict: boolean): Promise<void> {
      // project-visibility S-005 / C-009: a BOUNDARY-CROSSING move — relocate the doc AND, when
      // make-private was chosen, restrict its share_links ({null,null}) in ONE transaction, so
      // the move + access change are atomic (if the access write fails, the project_id move
      // rolls back — never a half-state: a relocated-but-still-shared doc, or vice versa).
      // keep-sharing (restrict=false) writes ONLY project_id — the doc stays workspace-shared
      // inside the private project (soft-private, AS-023).
      await db.transaction(async (tx) => {
        await tx.update(docs).set({ projectId }).where(eq(docs.id, docId));
        if (restrict) {
          await tx
            .update(shareLinks)
            .set({ workspaceRole: null, linkRole: null })
            .where(eq(shareLinks.docId, docId));
        }
      });
    },

    async createCopy(input): Promise<{ id: string; slug: string }> {
      // COPY: a NEW doc + its version 1 + its access config, in one transaction (mirrors
      // createDocRepo). A fresh, clean copy never inherits the SOURCE's sharing; instead
      // it gets the FIXED new-doc default like a publish (workspace_role=commenter,
      // link_role=null — doc-access-two-axis S-002/C-007). A NEW slug is generated (never
      // the source's — slug is unique + immutable).
      const slug = generateSlug(input.title);
      return db.transaction(async (tx) => {
        const [doc] = await tx
          .insert(docs)
          .values({
            slug,
            title: input.title,
            kind: input.kind,
            ownerId: input.ownerId, // owner = the copier (a fresh publish)
            projectId: input.projectId,
          })
          .returning({ id: docs.id, slug: docs.slug });

        // project-visibility S-004 (C-007): the COPY's access derives from the COPY TARGET
        // project (read in this same tx), exactly like a fresh publish — public/default →
        // {commenter,null}, non-default private → {null,null} (AS-020). The copy never inherits
        // the SOURCE's sharing (clean copy). The target is guaranteed to exist (the service's
        // requireTargetProject ran first); if it somehow vanished, fall back to the shared default.
        const [proj] = await tx
          .select({ isDefault: projects.isDefault, visibility: projects.visibility })
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .limit(1);
        const access = proj
          ? deriveNewDocAccess(proj)
          : deriveNewDocAccess({ isDefault: true, visibility: "public" });

        await tx.insert(docVersions).values({
          docId: doc!.id,
          version: 1, // the copy's content starts at version 1 (history NOT carried)
          content: input.content,
          contentHash: input.contentHash,
          extractedText: input.extractedText ?? null,
          publishedBy: input.ownerId, // v1 publisher = the copier
        });

        // C-007: the copy's access config — DERIVED from the copy target project, same as publish.
        await tx.insert(shareLinks).values({
          docId: doc!.id,
          workspaceRole: access.workspaceRole,
          linkRole: access.linkRole,
        });

        return { id: doc!.id, slug: doc!.slug };
      });
    },
  };
}
