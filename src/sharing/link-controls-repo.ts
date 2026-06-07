// Drizzle-backed atomic view-limit consume (sharing S-004, C-011 / AS-011 / AS-017).
// THIN glue: a single conditional UPDATE that increments view_count only while the
// link is under its limit, returning the new count. No row returned → the limit was
// already reached → deny. This is the one operation that MUST be a single atomic
// statement: under concurrent opens, N+M requests must serve at most N (AS-017). The
// `WHERE view_count < view_limit RETURNING` shape makes the DB the arbiter — no
// read-then-write race. Integration-verified in test/integration/share-link.itest.ts.

import { sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { decideConsumeView, type ConsumeViewResult } from "./link-controls";

/**
 * Atomically consume one view for a doc's share link (C-011).
 *
 * Runs `UPDATE share_links SET view_count = view_count + 1
 *       WHERE doc_id = $1 AND (view_limit IS NULL OR view_count < view_limit)
 *       RETURNING view_count`.
 *
 * - view_limit NULL → unlimited; always increments and allows.
 * - view_count < view_limit → increments and allows (returns new total — C-008 counts
 *   TOTAL opens).
 * - view_count == view_limit → predicate false, zero rows updated → deny (AS-011).
 *
 * Because the predicate and the increment are one statement, concurrent callers cannot
 * both pass the same final slot — Postgres serializes the row updates, so exactly
 * view_limit calls win and the surplus get no row back (AS-017).
 */
export async function tryConsumeView(db: DB, docId: string): Promise<ConsumeViewResult> {
  const rows = await db.execute<{ view_count: number }>(sql`
    UPDATE share_links
       SET view_count = view_count + 1
     WHERE doc_id = ${docId}
       AND (view_limit IS NULL OR view_count < view_limit)
    RETURNING view_count
  `);
  // postgres-js returns an array-like of rows; normalize the first row (if any).
  const first = (rows as unknown as Array<{ view_count: number }>)[0];
  return decideConsumeView(first ? { viewCount: first.view_count } : undefined);
}
