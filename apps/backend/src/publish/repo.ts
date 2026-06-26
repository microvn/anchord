// Drizzle-backed DocRepo (story S-001). THIN glue between the publish service and
// Postgres: insert the doc row + its version-1 row in one transaction (C-004 —
// creating a doc always yields version 1). No business logic lives here; all guards
// (sniff, size cap, title, slug) run in the service before this is called.
//
// Integration-verified-later: this is exercised against a real Postgres in an
// integration test, not in the fast unit suite (no DB needed for S-001 unit tests).

import { eq } from "drizzle-orm";
import { docs, docVersions, projects, shareLinks } from "../db/schema";
import type { DB } from "../db/client";
import { deriveNewDocAccess } from "../workspace/projects";
import type { DocRepo, CreateDocInput } from "./service";

/** Construct a DocRepo backed by a Drizzle DB handle. */
export function createDocRepo(db: DB): DocRepo {
  return {
    async createDocWithV1(input) {
      return db.transaction(async (tx) => {
        const [doc] = await tx
          .insert(docs)
          .values({
            slug: input.slug,
            title: input.title,
            kind: input.kind,
            // auth-routes S-001 (C-001/C-007): record the publisher as owner.
            ownerId: input.ownerId ?? null,
            // workspace-project S-003 (AS-005 / C-009): the resolved project (explicit
            // or the publisher's default); null only for a session-less seed.
            projectId: input.projectId ?? null,
          })
          .returning({ id: docs.id });

        await tx.insert(docVersions).values({
          docId: doc.id,
          version: 1, // C-004: a freshly created doc is always version 1
          content: input.content,
          contentHash: input.contentHash,
          // workspace-project S-005 (GAP-003): the searchable plain text for this
          // version, written at publish so the search index never re-renders content.
          extractedText: input.extractedText ?? null,
          // C-007: version 1's publisher = the same authenticated user (text id).
          publishedBy: input.ownerId ?? null,
        });

        // project-visibility S-004 (C-007): the doc's access config (share_links row) is
        // created HERE, at publish, in the SAME transaction — but its axes are now DERIVED
        // from the TARGET project's { is_default, visibility } (read in this same tx, no
        // read-then-write race), amending doc-access-two-axis's FIXED {commenter,null} default:
        //   - default project (is_default) → {commenter,null} regardless of its private shell
        //     (the carve-out — quick-publish/agent-loop stays reviewable: AS-018/AS-019),
        //   - non-default PUBLIC project    → {commenter,null} (the shared default: AS-016),
        //   - non-default PRIVATE project   → {null,null}     (derived restricted: AS-017).
        // A session-less seed with no projectId keeps the shared {commenter,null} default (no
        // project to derive from → treat as the workspace-shared default). The derivation is
        // identical at every publish surface (web + MCP) because both route through this repo.
        let access = deriveNewDocAccess({ isDefault: true, visibility: "public" });
        let projectName: string | null = null;
        if (input.projectId != null) {
          const [proj] = await tx
            .select({
              name: projects.name,
              isDefault: projects.isDefault,
              visibility: projects.visibility,
            })
            .from(projects)
            .where(eq(projects.id, input.projectId))
            .limit(1);
          if (proj) {
            access = deriveNewDocAccess(proj);
            projectName = proj.name;
          }
        }
        await tx.insert(shareLinks).values({
          docId: doc.id,
          workspaceRole: access.workspaceRole,
          linkRole: access.linkRole,
        });

        // project-visibility S-004 (C-013): return the target project + the doc's resulting
        // access so the publish/create RESPONSE can report where the doc went + who can see it.
        return {
          id: doc.id,
          projectId: input.projectId ?? null,
          projectName,
          workspaceRole: access.workspaceRole,
          linkRole: access.linkRole,
        };
      });
    },
  };
}
