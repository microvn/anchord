// Drizzle-backed DocRepo (story S-001). THIN glue between the publish service and
// Postgres: insert the doc row + its version-1 row in one transaction (C-004 —
// creating a doc always yields version 1). No business logic lives here; all guards
// (sniff, size cap, title, slug) run in the service before this is called.
//
// Integration-verified-later: this is exercised against a real Postgres in an
// integration test, not in the fast unit suite (no DB needed for S-001 unit tests).

import { docs, docVersions } from "../db/schema";
import type { DB } from "../db/client";
import type { DocRepo, CreateDocInput } from "./service";

/** Construct a DocRepo backed by a Drizzle DB handle. */
export function createDocRepo(db: DB): DocRepo {
  return {
    async createDocWithV1(input: CreateDocInput): Promise<{ id: string }> {
      return db.transaction(async (tx) => {
        const [doc] = await tx
          .insert(docs)
          .values({ slug: input.slug, title: input.title, kind: input.kind })
          .returning({ id: docs.id });

        await tx.insert(docVersions).values({
          docId: doc.id,
          version: 1, // C-004: a freshly created doc is always version 1
          content: input.content,
          contentHash: input.contentHash,
        });

        return { id: doc.id };
      });
    },
  };
}
