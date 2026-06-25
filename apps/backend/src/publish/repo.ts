// Drizzle-backed DocRepo (story S-001). THIN glue between the publish service and
// Postgres: insert the doc row + its version-1 row in one transaction (C-004 —
// creating a doc always yields version 1). No business logic lives here; all guards
// (sniff, size cap, title, slug) run in the service before this is called.
//
// Integration-verified-later: this is exercised against a real Postgres in an
// integration test, not in the fast unit suite (no DB needed for S-001 unit tests).

import { docs, docVersions, shareLinks } from "../db/schema";
import type { DB } from "../db/client";
import type { DocRepo, CreateDocInput } from "./service";

/** Construct a DocRepo backed by a Drizzle DB handle. */
export function createDocRepo(db: DB): DocRepo {
  return {
    async createDocWithV1(input: CreateDocInput): Promise<{ id: string }> {
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

        // doc-access-two-axis S-002 (C-007): the doc's access config (share_links row)
        // is created HERE, at publish, in the SAME transaction — with the fixed new-doc
        // defaults: workspace_role = commenter (shared with the doc's workspace at the
        // comment level), link_role = null (no public link, no capability token). This
        // is what makes a freshly published doc immediately viewable + commentable by
        // every workspace member with no sharing edit, and closes the latent no-access
        // gap (the row used to be created lazily on the first sharing edit). The default
        // is identical at every publish surface (web + MCP) because both route through
        // this repo. (editors_can_share / guest_commenting / view_count keep their
        // column defaults.)
        await tx.insert(shareLinks).values({
          docId: doc.id,
          workspaceRole: "commenter",
          linkRole: null,
        });

        return { id: doc.id };
      });
    },
  };
}
