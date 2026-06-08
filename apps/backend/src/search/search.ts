// Search service (workspace-project S-005) — query parse, access filtering, result
// shape. The Postgres FTS lives in search-repo.ts (the portability boundary); this
// file is the portable logic the route calls, unit-testable with a fake repo.
//
// AS-009: a search matches title + extracted content + comment bodies, and returns
//         ONLY docs the searcher can access — an out-of-access doc is fully absent,
//         no title/snippet/id leaked, even if its COMMENT matched (C-003 / H2).
// AS-010: an optional projectId scopes the search to one project (still access-filtered).
// C-006:  the index covers title + extracted text + comment bodies (the repo's query).
//
// DEFENSE IN DEPTH: the repo already access-filters in SQL (out-of-access rows never
// leave the DB). This service applies the SAME predicate (canBrowseDoc — S-003's one
// browse+search access rule, NOT a second filter) again over what the repo returned,
// so even a future repo bug can't surface an out-of-access doc. The predicate is
// imported from src/workspace/projects.ts — one access rule for browse AND search.

import { canBrowseDoc, type BrowseFilterDeps } from "../workspace/projects";
import type { GeneralAccessLevel } from "../sharing/access";
import type { SearchHit, SearchRepo } from "./search-repo";

/** Max rows a single search returns. Capped (never unbounded) — over-cap is logged. */
export const SEARCH_RESULT_CAP = 50;

/** Thrown when a search input is rejected (the route maps `code` → HTTP status). */
export class SearchRejected extends Error {
  constructor(message: string, readonly code: "empty_query") {
    super(message);
    this.name = "SearchRejected";
  }
}

/** A search result as the route returns it (no snippet of out-of-access docs ever). */
export interface SearchResult {
  docId: string;
  slug: string;
  title: string;
  kind: SearchHit["kind"];
  matchSource: SearchHit["matchSource"];
}

export interface SearchInput {
  /** Raw query string from the request (?q=). */
  q: string;
  /** The SESSION actor's id (never body/query input for identity). */
  userId: string;
  /** Optional project scope (AS-010). */
  projectId?: string;
}

/**
 * The access fields the defense-in-depth re-check needs per returned doc. The repo
 * supplies them alongside each hit so the service can re-run canBrowseDoc without a
 * second DB round-trip. (For a repo that already SQL-filters, this is belt-and-braces.)
 */
export interface SearchAccessDeps extends BrowseFilterDeps {
  /** owner_id + general_access for a doc id returned by the repo. */
  accessFieldsFor(
    docId: string,
  ): { ownerId: string | null; generalAccess: GeneralAccessLevel } | Promise<{ ownerId: string | null; generalAccess: GeneralAccessLevel }>;
}

export interface SearchDeps {
  repo: SearchRepo;
  /**
   * Optional defense-in-depth access re-check. When provided, every hit the repo
   * returned is re-validated with canBrowseDoc; a hit that fails is dropped (it
   * should never happen if the repo filtered correctly). Omit to trust the repo's
   * SQL filter alone (production wires the SQL filter; tests pass this to prove the
   * predicate drops an out-of-access comment-match).
   */
  access?: SearchAccessDeps;
  /** Result cap; defaults to SEARCH_RESULT_CAP. */
  cap?: number;
  /** Log sink for the cap-hit notice (defaults to console.warn). */
  log?: (msg: string) => void;
}

/** Normalize the query: trim; empty/whitespace-only → SearchRejected (we pick 400). */
export function parseQuery(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    throw new SearchRejected("search query must not be empty", "empty_query");
  }
  return trimmed;
}

/**
 * Run a search: parse the query, ask the repo (which access-filters in SQL), then
 * re-apply the browse access predicate as defense in depth, cap the results, and
 * shape them. Identity is the SESSION actor (input.userId), never query/body.
 */
export async function search(input: SearchInput, deps: SearchDeps): Promise<SearchResult[]> {
  const text = parseQuery(input.q);
  const cap = deps.cap ?? SEARCH_RESULT_CAP;
  const log = deps.log ?? ((m: string) => console.warn(m));

  // Ask for cap+1 so we can detect (and log) when the result set is truncated.
  const hits = await deps.repo.search({
    text,
    userId: input.userId,
    projectId: input.projectId,
    limit: cap + 1,
  });

  let visible = hits;
  if (deps.access) {
    const access = deps.access;
    const filtered: SearchHit[] = [];
    for (const hit of hits) {
      const fields = await access.accessFieldsFor(hit.docId);
      const ok = await canBrowseDoc(
        input.userId,
        { id: hit.docId, ownerId: fields.ownerId, generalAccess: fields.generalAccess },
        access,
      );
      if (ok) filtered.push(hit);
    }
    visible = filtered;
  }

  if (visible.length > cap) {
    log(`search: result set capped at ${cap} (query="${text}", had >${cap} matches)`);
    visible = visible.slice(0, cap);
  }

  return visible.map((h) => ({
    docId: h.docId,
    slug: h.slug,
    title: h.title,
    kind: h.kind,
    matchSource: h.matchSource,
  }));
}
