// Version service (story S-001): append an immutable version when a doc's content
// changes, and the newest version becomes the current one.
//
// AS-001: submitting new content appends version N+1 (v2 is NOT overwritten);
//         current = the new highest version.
// AS-002 / C-003: editing the title touches docs.title ONLY — never doc_versions.
// C-001: versions are immutable. This module exposes append + read + title-update
//        only; there is deliberately NO "update/overwrite an existing version" path.
// C-002: versions are numbered from 1 by a continuously incrementing counter
//        (next = currentMax + 1, or 1 for a doc with no versions); no reuse;
//        current = highest number.
//
// Persistence is behind an injectable VersionRepo port (mirrors publish's DocRepo)
// so the numbering / no-overwrite logic is unit-testable without a DB. The real
// Drizzle glue computes max()+1 inside a transaction (Postgres row lock / MVCC) —
// that transactional, multi-writer correctness is integration-verified-later.

import { extractText, type ExtractKind } from "../render/extract-text";

/** The doc kind that decides the extract-text render path (mirrors DocKind). */
export type VersionKind = ExtractKind;

export interface NewVersionRow {
  docId: string;
  version: number;
  content: string;
  contentHash: string;
  /** Author who published this version; nullable until the auth cluster lands. */
  publishedBy?: string | null;
  /**
   * workspace-project S-005 (GAP-003 → publish-time extraction / C-006): the plain
   * searchable text for THIS version's content, written to doc_versions.extracted_text
   * so the search index covers every version that can become current — not just v1
   * from the publish path. Derived via extractText(content, kind). NULL/undefined when
   * the caller has no kind context (a seed/legacy append) → the column stays null,
   * mirroring publish's null handling for content-less rows.
   */
  extractedText?: string | null;
}

/**
 * Persistence port. The real implementation (version-repo.ts) is thin Drizzle glue.
 * Note the surface: read current max + append a row + set the doc title. There is
 * intentionally NO method that mutates an existing version row (C-001 immutability).
 */
/** A version row as read back for history display (S-002). Read-only projection. */
export interface VersionListRow {
  version: number;
  createdAt: Date;
  /** Author id; null when the version has no recorded author (set null on delete). */
  publishedBy: string | null;
  /**
   * S-002 / C-006: the author's resolved display name (user.name), via a LEFT JOIN
   * on user.id. Null when publishedBy is null OR the author no longer resolves to a
   * user row — the service maps that null to a fallback label.
   */
  publishedByName: string | null;
}

export interface VersionRepo {
  /** Highest version number for the doc, or null if it has none yet. */
  currentMaxVersion(docId: string): Promise<number | null>;
  /** Insert a NEW version row. Never updates an existing one. */
  insertVersion(row: NewVersionRow): Promise<{ version: number }>;
  /** Update docs.title only. Must not touch doc_versions. */
  setTitle(docId: string, title: string): Promise<void>;
  /** Read all versions for a doc (S-002 history), ascending by version. */
  listVersions(docId: string): Promise<VersionListRow[]>;
  /**
   * Read a single version's content + hash (S-003 restore), or null if the
   * (docId, version) pair does not exist. Read-only — never mutates a row.
   */
  getVersion(
    docId: string,
    version: number,
  ): Promise<{ content: string; contentHash: string } | null>;
}

export interface AppendResult {
  docId: string;
  /** The freshly created version number. */
  version: number;
  /** The previous current version (max before this append), or null for a first version. */
  previousVersion: number | null;
}

/**
 * Append a new immutable version carrying `content`. Computes the next version as
 * currentMax + 1 (C-002), inserts a NEW row (never overwrites — C-001/AS-001), and
 * reports both the previous and the new version number.
 *
 * RE-ANCHOR SEAM: returning `previousVersion` + `version` is the hook a future
 * re-anchor step (annotation-core:S-005) attaches to — carry-forward of the
 * previous version's annotations is NOT implemented here (deferred to that cluster).
 */
export async function appendVersion(
  docId: string,
  content: string,
  contentHash: string,
  repo: VersionRepo,
  publishedBy: string | null = null,
  kind?: VersionKind,
): Promise<AppendResult> {
  const previousVersion = await repo.currentMaxVersion(docId);
  const version = (previousVersion ?? 0) + 1; // C-002: counter starts at 1, increments, no reuse

  // S-005 / C-006: the appended content becomes the doc's CURRENT version, so it must
  // carry extracted_text or content search silently breaks for any doc past v1. Derive
  // it the SAME way publish does (extractText(content, kind)). No kind context (seed
  // append) → leave it null, mirroring publish's null handling for content-less rows.
  const extractedText = kind ? extractText(content, kind) : null;

  await repo.insertVersion({ docId, version, content, contentHash, publishedBy, extractedText });

  return { docId, version, previousVersion };
}

/**
 * Change a doc's title without creating a version (AS-002 / C-003). Only metadata
 * on `docs` changes; doc_versions is never touched, so the current version is
 * unaffected.
 */
export async function updateTitle(docId: string, title: string, repo: VersionRepo): Promise<void> {
  await repo.setTitle(docId, title);
}

/**
 * Restore a previous version (S-003 / AS-004). APPEND-COPY: read the target
 * version's content+hash and append a NEW version copying it. The entire history
 * stays intact — no existing version is mutated, moved, or deleted (C-001 / C-004).
 * Restoring the current (highest) version still appends a copy; an unknown target
 * version throws (no silent no-op).
 *
 * RE-ANCHOR SEAM: restore goes through `appendVersion`, so it returns the same
 * `{ previousVersion, version }` shape — the hook a future re-anchor step
 * (annotation-core:S-005) attaches to. Re-anchor on restore is wired via that same
 * new-version seam and is deferred to the annotation-core cluster (AS-005 / C-005).
 */
export async function restoreVersion(
  docId: string,
  targetVersion: number,
  repo: VersionRepo,
  publishedBy: string | null = null,
  kind?: VersionKind,
): Promise<AppendResult> {
  const target = await repo.getVersion(docId, targetVersion);
  if (!target) {
    throw new Error(`Cannot restore: version ${targetVersion} not found for doc ${docId}`);
  }
  // Reuse appendVersion so numbering (C-002) + the re-anchor seam are shared, and
  // the restored content is re-inserted verbatim (same content + contentHash).
  // S-005 / C-006: a restore makes the restored content CURRENT again, so extract from
  // THAT content (via appendVersion's kind path) so the now-current doc stays searchable.
  return appendVersion(docId, target.content, target.contentHash, repo, publishedBy, kind);
}

/**
 * The publisher of a version, as exposed by history (S-002 / C-006). `id` is the
 * raw author id (null when the version has no recorded author). `name` is the
 * RESOLVED display name (from user.name), or a fallback label when the author is
 * unknown/unresolved — never blank, never the raw id alone.
 */
export interface VersionPublisher {
  id: string | null;
  name: string;
}

/** Fallback publisher label when the author id is null or no longer resolves. */
export const UNKNOWN_PUBLISHER_LABEL = "Unknown";

/** A history entry: a version row plus a current-version marker (S-002 / AS-003). */
export interface VersionHistoryRow {
  version: number;
  createdAt: Date;
  /**
   * C-006 / AS-011 / AS-012: the resolved publisher — `{ id, name }`. `name` is the
   * author's display name, or `UNKNOWN_PUBLISHER_LABEL` when the author is
   * unknown/unresolved. The opaque author id is never surfaced on its own.
   */
  publishedBy: VersionPublisher;
  /** True for exactly one row — the highest version number (the current version). */
  isCurrent: boolean;
}

/**
 * List a doc's version history for display (S-002 / AS-003). Pure read-only
 * mapping over the repo rows plus a current-marker computation: the current
 * version is the highest version number. Rows are returned ASCENDING by version
 * (oldest first, current last) — that order is the contract the tests assert.
 *
 * PUBLISHER RESOLUTION (C-006 / AS-011 / AS-012): the repo LEFT JOINs the author id
 * onto user.name, so each row carries `publishedByName`. Here we shape `publishedBy`
 * as `{ id, name }`: `id` is the truthful author id (null when none recorded);
 * `name` is the resolved display name, OR `UNKNOWN_PUBLISHER_LABEL` when the id is
 * null OR no user row matched — never a blank field and never the raw id alone.
 */
export async function listVersionHistory(
  docId: string,
  repo: VersionRepo,
): Promise<VersionHistoryRow[]> {
  const rows = await repo.listVersions(docId);
  if (rows.length === 0) return []; // empty history → nothing to mark current

  const maxVersion = Math.max(...rows.map((r) => r.version));
  return rows.map((r) => ({
    version: r.version,
    createdAt: r.createdAt,
    publishedBy: {
      id: r.publishedBy,
      // AS-011: resolved name when present; AS-012: fallback when unknown/unresolved.
      name: r.publishedByName ?? UNKNOWN_PUBLISHER_LABEL,
    },
    isCurrent: r.version === maxVersion,
  }));
}
