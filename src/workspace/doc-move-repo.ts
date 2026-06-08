// Drizzle-backed DocMoveRepo (workspace-project S-004). THIN glue between the
// move/copy service (doc-move.ts) and Postgres. No business logic lives here — the
// authz, same-workspace guard, and clean-copy rules are in the service; this only
// reads/writes rows.
//
//  - findDocBySlug      → the source doc (id/slug/title/kind/project_id).
//  - projectInWorkspace → the same-workspace guard: the project must exist in THE single
//                          v0 workspace. (v0 single-workspace, but we still validate
//                          existence so a bogus target → 404, not a silent write.)
//  - currentVersion     → the source's CURRENT (max-version) content + hash. Mirrors the
//                          search repo's "order by version desc limit 1" current read.
//  - setProjectId       → MOVE: update ONLY docs.project_id. Nothing else is touched, so
//                          versions/annotations/sharing/owner/general_access all stay.
//  - createCopy         → COPY: insert a NEW doc (new slug, restricted default access,
//                          owner = the copier) + its version 1 in one transaction. Does
//                          NOT copy annotations/comments/history (clean copy, C-008).
//
// Integration-verified against real Postgres in test/integration/doc-move.itest.ts.

import { and, desc, eq } from "drizzle-orm";
import { docs, docVersions, projects, workspaces } from "../db/schema";
import type { DB } from "../db/client";
import { generateSlug } from "../publish/slug";
import type { DocMoveRepo, SourceDoc, CurrentVersion } from "./doc-move";

/** Construct a DocMoveRepo backed by a Drizzle DB handle. */
export function createDocMoveRepo(db: DB): DocMoveRepo {
  return {
    async findDocBySlug(slug: string): Promise<SourceDoc | null> {
      const [row] = await db
        .select({
          id: docs.id,
          slug: docs.slug,
          title: docs.title,
          kind: docs.kind,
          projectId: docs.projectId,
        })
        .from(docs)
        .where(eq(docs.slug, slug));
      return row ?? null;
    },

    async projectInWorkspace(projectId: string): Promise<boolean> {
      // The same-workspace guard: the project must exist in THE single v0 workspace.
      // Join through workspaces so a project from another workspace (should one ever
      // exist) is rejected — future-proofing the "same workspace" contract.
      const [row] = await db
        .select({ id: projects.id })
        .from(projects)
        .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
        .where(eq(projects.id, projectId))
        .limit(1);
      return !!row;
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

    async createCopy(input): Promise<{ id: string; slug: string }> {
      // COPY: a NEW doc + its version 1, in one transaction (mirrors createDocRepo).
      // general_access is left to the column default (`restricted`) — a fresh, clean
      // copy never inherits the source's sharing. A NEW slug is generated (never the
      // source's — slug is unique + immutable).
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
            // generalAccess omitted → DB default `restricted` (clean-copy safe default).
          })
          .returning({ id: docs.id, slug: docs.slug });

        await tx.insert(docVersions).values({
          docId: doc!.id,
          version: 1, // the copy's content starts at version 1 (history NOT carried)
          content: input.content,
          contentHash: input.contentHash,
          extractedText: input.extractedText ?? null,
          publishedBy: input.ownerId, // v1 publisher = the copier
        });

        return { id: doc!.id, slug: doc!.slug };
      });
    },
  };
}
