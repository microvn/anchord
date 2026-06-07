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

export interface NewVersionRow {
  docId: string;
  version: number;
  content: string;
  contentHash: string;
  /** Author who published this version; nullable until the auth cluster lands. */
  publishedBy?: string | null;
}

/**
 * Persistence port. The real implementation (version-repo.ts) is thin Drizzle glue.
 * Note the surface: read current max + append a row + set the doc title. There is
 * intentionally NO method that mutates an existing version row (C-001 immutability).
 */
export interface VersionRepo {
  /** Highest version number for the doc, or null if it has none yet. */
  currentMaxVersion(docId: string): Promise<number | null>;
  /** Insert a NEW version row. Never updates an existing one. */
  insertVersion(row: NewVersionRow): Promise<{ version: number }>;
  /** Update docs.title only. Must not touch doc_versions. */
  setTitle(docId: string, title: string): Promise<void>;
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
): Promise<AppendResult> {
  const previousVersion = await repo.currentMaxVersion(docId);
  const version = (previousVersion ?? 0) + 1; // C-002: counter starts at 1, increments, no reuse

  await repo.insertVersion({ docId, version, content, contentHash, publishedBy });

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
