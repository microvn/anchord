// Drizzle-backed VersionRepo (story S-001). THIN glue between the version service
// and Postgres. No business logic lives here — the next-version computation and the
// immutability/title rules are in service.ts; this only persists.
//
// The append path reads the current max version and inserts the next row INSIDE one
// transaction so concurrent submitters can't both compute the same N+1 (Postgres
// MVCC + row lock — exactly the multi-writer correctness the project chose Postgres
// for). This transactional behaviour is integration-verified-later against a real
// Postgres, not in the fast unit suite.

import { asc, eq, max } from "drizzle-orm";
import { docs, docVersions } from "../db/schema";
import type { DB } from "../db/client";
import type { VersionRepo, NewVersionRow, VersionListRow } from "./version";

/** Construct a VersionRepo backed by a Drizzle DB handle. */
export function createVersionRepo(db: DB): VersionRepo {
  return {
    async currentMaxVersion(docId: string): Promise<number | null> {
      const [row] = await db
        .select({ max: max(docVersions.version) })
        .from(docVersions)
        .where(eq(docVersions.docId, docId));
      return row?.max ?? null;
    },

    async insertVersion(row: NewVersionRow): Promise<{ version: number }> {
      const [inserted] = await db
        .insert(docVersions)
        .values({
          docId: row.docId,
          version: row.version,
          content: row.content,
          contentHash: row.contentHash,
          publishedBy: row.publishedBy ?? null,
        })
        .returning({ version: docVersions.version });
      return { version: inserted.version };
    },

    async setTitle(docId: string, title: string): Promise<void> {
      // C-003: title/metadata only — never touches doc_versions.
      await db.update(docs).set({ title }).where(eq(docs.id, docId));
    },

    async listVersions(docId: string): Promise<VersionListRow[]> {
      // S-002 history read: all versions for the doc, ascending by version.
      // The service computes the current-marker; this only selects rows.
      // publishedBy is returned raw (null until the auth cluster resolves names).
      return db
        .select({
          version: docVersions.version,
          createdAt: docVersions.createdAt,
          publishedBy: docVersions.publishedBy,
        })
        .from(docVersions)
        .where(eq(docVersions.docId, docId))
        .orderBy(asc(docVersions.version));
    },
  };
}

/**
 * Append a new version transactionally: read max + insert N+1 in one tx so two
 * concurrent submitters cannot both land the same version number (C-002). The
 * service-layer appendVersion() does the same arithmetic against the unit-tested
 * port; this is the production path that holds the row lock. Returns the new
 * version + the previous max (re-anchor seam, annotation-core:S-005).
 */
export async function appendVersionTx(
  db: DB,
  docId: string,
  content: string,
  contentHash: string,
  publishedBy: string | null = null,
): Promise<{ docId: string; version: number; previousVersion: number | null }> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ max: max(docVersions.version) })
      .from(docVersions)
      .where(eq(docVersions.docId, docId));
    const previousVersion = row?.max ?? null;
    const version = (previousVersion ?? 0) + 1;

    await tx
      .insert(docVersions)
      .values({ docId, version, content, contentHash, publishedBy });

    return { docId, version, previousVersion };
  });
}
