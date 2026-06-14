// Drizzle-backed VersionRepo (story S-001). THIN glue between the version service
// and Postgres. No business logic lives here — the next-version computation and the
// immutability/title rules are in service.ts; this only persists.
//
// The append path reads the current max version and inserts the next row INSIDE one
// transaction so concurrent submitters can't both compute the same N+1 (Postgres
// MVCC + row lock — exactly the multi-writer correctness the project chose Postgres
// for). This transactional behaviour is integration-verified-later against a real
// Postgres, not in the fast unit suite.

import { and, asc, eq, max, sql } from "drizzle-orm";
import { docs, docVersions, user } from "../db/schema";
import type { DB } from "../db/client";
import type { VersionRepo, NewVersionRow, VersionListRow, VersionKind } from "./version";
import { extractText } from "../render/extract-text";

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
          // S-005 / C-006: persist the searchable text for this version so an appended/
          // restored version (not just publish's v1) is covered by the search index.
          extractedText: row.extractedText ?? null,
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
      // C-006: LEFT JOIN user on publishedBy = user.id so each row carries the
      // author's resolved display name (publishedByName). The join is LEFT so a
      // version with a null author — or one whose author no longer resolves — still
      // returns its row, with publishedByName null; the service maps that null to a
      // fallback label (AS-011 resolved name / AS-012 fallback).
      return db
        .select({
          version: docVersions.version,
          createdAt: docVersions.createdAt,
          publishedBy: docVersions.publishedBy,
          publishedByName: user.name,
        })
        .from(docVersions)
        .leftJoin(user, eq(docVersions.publishedBy, user.id))
        .where(eq(docVersions.docId, docId))
        .orderBy(asc(docVersions.version));
    },

    async getVersion(docId: string, version: number) {
      // S-003 restore read: a single version's content + hash, or null if absent.
      // Read-only — the service re-appends this content as a NEW version (append-copy).
      const [row] = await db
        .select({ content: docVersions.content, contentHash: docVersions.contentHash })
        .from(docVersions)
        .where(and(eq(docVersions.docId, docId), eq(docVersions.version, version)));
      return row ?? null;
    },
  };
}

/**
 * Append a new version transactionally: read max + insert N+1 in one tx so two
 * concurrent submitters cannot both land the same version number (C-002). The
 * service-layer appendVersion() does the same arithmetic against the unit-tested
 * port; this is the production path. Returns the new version + the previous max
 * (re-anchor seam, annotation-core:S-005).
 *
 * SERIALIZATION: read max()+1 is a read-then-write race — under Postgres' default
 * READ COMMITTED, concurrent txs all read the same max() (a row lock can't help: the
 * row being computed does not exist yet, and for a doc's FIRST extra version there is
 * nothing to lock). We take a per-doc transaction-scoped ADVISORY lock first, so the
 * max→insert is serialized PER DOC (different docs never block each other). The lock
 * releases automatically at commit/rollback. The unique(doc_id, version) index is the
 * backstop, but the advisory lock prevents the collision rather than rejecting a loser.
 */
export async function appendVersionTx(
  db: DB,
  docId: string,
  content: string,
  contentHash: string,
  publishedBy: string | null = null,
  kind?: VersionKind,
): Promise<{ docId: string; version: number; previousVersion: number | null }> {
  // S-005 / C-006: mirror the service-layer appendVersion — the appended content is the
  // new current version, so it must carry extracted_text or content search breaks past
  // v1. No kind context → null (matches publish's null handling for content-less rows).
  const extractedText = kind ? extractText(content, kind) : null;
  return db.transaction(async (tx) => {
    // Per-doc advisory lock keyed on the doc id (hashed to the bigint the lock takes).
    // Held until this tx commits/rolls back; serializes concurrent appends for THIS doc.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${docId}, 0))`);

    const [row] = await tx
      .select({ max: max(docVersions.version) })
      .from(docVersions)
      .where(eq(docVersions.docId, docId));
    const previousVersion = row?.max ?? null;
    const version = (previousVersion ?? 0) + 1;

    await tx
      .insert(docVersions)
      .values({ docId, version, content, contentHash, publishedBy, extractedText });

    return { docId, version, previousVersion };
  });
}
