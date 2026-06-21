// Drizzle-backed atomic view-limit consume (sharing S-004, C-011 / AS-011 / AS-017).
// THIN glue: a single conditional UPDATE that increments view_count only while the
// link is under its limit, returning the new count. No row returned → the limit was
// already reached → deny. This is the one operation that MUST be a single atomic
// statement: under concurrent opens, N+M requests must serve at most N (AS-017). The
// `WHERE view_count < view_limit RETURNING` shape makes the DB the arbiter — no
// read-then-write race. Integration-verified in test/integration/share-link.itest.ts.

import { eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { shareLinks } from "../db/schema";
import { decideConsumeView, type ConsumeViewResult } from "./link-controls";

/**
 * A PARTIAL update of a doc's link controls (sharing S-004, C-001): the hashed password,
 * the expiry instant, and the total-opens limit each attach to the link INDEPENDENTLY.
 * Each field is three-state:
 *   - key ABSENT (`undefined`) → that control is left UNCHANGED (the column is not written),
 *   - key `null` → that control is CLEARED,
 *   - key a value → that control is SET.
 * `passwordHash` is already argon2id-hashed by the caller (setPassword) — this glue never
 * sees the plaintext. Setting a non-null `viewLimit` also resets the open count (AS-033).
 */
export interface LinkControlsUpdate {
  passwordHash?: string | null;
  expiresAt?: Date | null;
  viewLimit?: number | null;
}

/** What the row stores back after the update (echoed to the API response). */
export interface PersistedLinkControls {
  passwordSet: boolean;
  expiresAt: Date | null;
  viewLimit: number | null;
  viewCount: number;
}

/**
 * Persist a doc's share-link controls onto its single share_links row (C-001). The
 * row is upserted on the unique docId so setting controls before any general-access
 * config exists still works (a bare link row, role defaulting to viewer). The
 * general-access role + guest toggle (S-001) are NOT touched here — these columns are
 * independent of that setting (C-001). Returns the persisted controls (password as a
 * boolean — the hash never leaves the server).
 */
export async function setLinkControls(
  db: DB,
  docId: string,
  update: LinkControlsUpdate,
): Promise<PersistedLinkControls> {
  // Build the SET clause from ONLY the controls PRESENT in the update (C-001): an absent
  // key leaves its column untouched; an explicit null clears it; a value sets it. On the
  // INSERT branch (first-ever controls on a fresh link) absent keys fall to the column
  // defaults (null / view_count 0).
  const set: Record<string, unknown> = {};
  const insertValues: Record<string, unknown> = { docId };
  if ("passwordHash" in update) {
    set.passwordHash = update.passwordHash ?? null;
    insertValues.passwordHash = update.passwordHash ?? null;
  }
  if ("expiresAt" in update) {
    set.expiresAt = update.expiresAt ?? null;
    insertValues.expiresAt = update.expiresAt ?? null;
  }
  if ("viewLimit" in update) {
    set.viewLimit = update.viewLimit ?? null;
    insertValues.viewLimit = update.viewLimit ?? null;
    // AS-033: SETTING a limit (non-null) starts a fresh viewing budget — reset the open
    // count to 0. Clearing the limit (null) is NOT "setting a limit" → leave the count.
    if (update.viewLimit != null) {
      set.viewCount = 0;
    }
  }

  // No controls present → nothing to write; just read the current row back (or defaults).
  if (Object.keys(set).length === 0) {
    const [existing] = await db
      .select({
        passwordHash: shareLinks.passwordHash,
        expiresAt: shareLinks.expiresAt,
        viewLimit: shareLinks.viewLimit,
        viewCount: shareLinks.viewCount,
      })
      .from(shareLinks)
      .where(eq(shareLinks.docId, docId));
    return {
      passwordSet: existing?.passwordHash != null,
      expiresAt: existing?.expiresAt ?? null,
      viewLimit: existing?.viewLimit ?? null,
      viewCount: existing?.viewCount ?? 0,
    };
  }

  const [row] = await db
    .insert(shareLinks)
    .values(insertValues as typeof shareLinks.$inferInsert)
    .onConflictDoUpdate({
      target: shareLinks.docId,
      set,
    })
    .returning({
      passwordHash: shareLinks.passwordHash,
      expiresAt: shareLinks.expiresAt,
      viewLimit: shareLinks.viewLimit,
      viewCount: shareLinks.viewCount,
    });
  return {
    passwordSet: row?.passwordHash != null,
    expiresAt: row?.expiresAt ?? null,
    viewLimit: row?.viewLimit ?? null,
    viewCount: row?.viewCount ?? 0,
  };
}

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
