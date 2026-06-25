// Search repo (workspace-project S-005) — the PORTABILITY BOUNDARY.
//
// ⚠️ This is the ONE place Postgres full-text search lives. `to_tsvector` /
// `websearch_to_tsquery` / the GIN indexes (drizzle/0012) are Postgres-isms that
// CLAUDE.md flags as non-portable. They are deliberately isolated here, the same way
// computeLineDiff isolates @pierre/diffs and createProjectRepo isolates Drizzle: the
// rest of the app (route, service) speaks the portable SearchRepo interface below. A
// future SQLite build re-implements THIS interface with FTS5 — no schema change, no
// query string leaks into routes/services. Do NOT scatter to_tsquery elsewhere.
//
// ACCESS IS ENFORCED IN SQL (C-003 / H2): the query JOINs the access decision and
// returns ONLY rows the searcher can access. An out-of-access doc — even one whose
// COMMENT body matches — never leaves the database: no title, no snippet, no id. This
// is existence-hiding by construction, not a post-fetch JS filter over leaked rows.
//
// The access predicate is the ONE shared C-006 workspace-visibility rule (canBrowseDoc):
// a doc is visible to user X iff X owns it, OR X is individually invited (active doc_members),
// OR the doc's WORKSPACE axis is on (share_links.workspace_role IS NOT NULL) AND X is a
// workspace member. The LINK axis is irrelevant to search visibility (doc-access-two-axis
// S-004): a link-only doc is absent from search exactly as from the dashboard (AS-015).

import { sql } from "drizzle-orm";
import type { DB } from "../db/client";

/** A single search hit, already access-checked. `matchSource` is for ranking/UX. */
export interface SearchHit {
  docId: string;
  slug: string;
  title: string;
  kind: "html" | "markdown" | "image";
  /** Which source surfaced the doc: its title, its content, or a comment body. */
  matchSource: "title" | "content" | "comment";
}

export interface SearchQuery {
  /** The free-text query (already validated non-empty by the service). */
  text: string;
  /** The searching user's id (the SESSION actor — never body input). */
  userId: string;
  /** Optional project scope (AS-010). Omitted/undefined → whole workspace. */
  projectId?: string;
  /**
   * workspaces S-006/C-002: the workspace the search is scoped to (the /api/w/:workspaceId
   * path). Only docs whose project belongs to THIS workspace are considered, and
   * anyone_in_workspace resolves against membership of THIS workspace, never "any".
   */
  workspaceId: string;
  /** Hard cap on rows returned (the service supplies SEARCH_RESULT_CAP). */
  limit: number;
}

/** Persistence port for search. The Postgres impl is below; SQLite would swap it. */
export interface SearchRepo {
  search(q: SearchQuery): Promise<SearchHit[]>;
}

/**
 * Drizzle/Postgres SearchRepo.
 *
 * One query, three match sources OR'd together, all behind the SAME access gate:
 *   - title:   to_tsvector(doc.title)        @@ q
 *   - content: to_tsvector(current version's extracted_text) @@ q
 *   - comment: to_tsvector(a comment body on the doc)        @@ q
 *
 * `websearch_to_tsquery` parses free user text safely (tolerates `&`, `:`, quotes,
 * unicode; never throws on punctuation) and is bound as a PARAMETER — user input is
 * never string-concatenated into SQL (no injection). The whole thing is wrapped so a
 * doc appears at most once, tagged with the source that matched (title > content >
 * comment for the label).
 *
 * "Current version" = the highest `version` row for the doc (that is what the viewer
 * serves). We index that version's extracted_text. Backfill note: versions published
 * before migration 0012 have NULL extracted_text → coalesced to '' → simply don't
 * match on content (they remain findable by title/comment). New publishes populate it.
 */
export function createSearchRepo(db: DB): SearchRepo {
  return {
    async search(q: SearchQuery): Promise<SearchHit[]> {
      // The access predicate, inlined into SQL (mirrors canBrowseDoc). Bound params
      // only — :userId etc. are never concatenated.
      const tsq = sql`websearch_to_tsquery('english', ${q.text})`;
      const projectFilter = q.projectId
        ? sql`and d.project_id = ${q.projectId}`
        : sql``;

      // current version per doc (max version). LATERAL keeps it to one row per doc.
      const rows = await db.execute(sql`
        with accessible as (
          select d.id, d.slug, d.title, d.kind, d.project_id, d.owner_id
          from docs d
          join projects p on p.id = d.project_id
          -- doc-access-two-axis S-004 / C-006: the workspace axis lives on share_links, not on
          -- docs (docs.general_access is dropped). Left join so a doc with no share_links row is
          -- simply not workspace-shared (NULL → the predicate's IS NOT NULL is false).
          left join share_links sl on sl.doc_id = d.id
          where p.workspace_id = ${q.workspaceId}
            and (
              d.owner_id = ${q.userId}
              or (
                sl.workspace_role is not null
                and exists (
                  select 1 from workspace_members wm
                  where wm.user_id = ${q.userId}
                    and wm.workspace_id = ${q.workspaceId}
                )
              )
              or exists (
                select 1 from doc_members m
                where m.doc_id = d.id and m.user_id = ${q.userId} and m.status = 'active'
              )
            )
            ${projectFilter}
        ),
        cur as (
          select a.id as doc_id, dv.extracted_text
          from accessible a
          left join lateral (
            select extracted_text
            from doc_versions
            where doc_id = a.id
            order by version desc
            limit 1
          ) dv on true
        ),
        matched as (
          select a.id as doc_id, a.slug, a.title, a.kind,
            case
              when to_tsvector('english', a.title) @@ ${tsq} then 'title'
              when to_tsvector('english', coalesce(c.extracted_text, '')) @@ ${tsq} then 'content'
              else 'comment'
            end as match_source
          from accessible a
          left join cur c on c.doc_id = a.id
          where to_tsvector('english', a.title) @@ ${tsq}
             or to_tsvector('english', coalesce(c.extracted_text, '')) @@ ${tsq}
             or exists (
               select 1
               from annotations an
               join comments cm on cm.annotation_id = an.id
               where an.doc_id = a.id
                 -- annotation-actions S-005 / C-007 (AS-014): a soft-deleted annotation is
                 -- excluded from EVERY read surface, including the search comment-match. A
                 -- comment on a deleted annotation must NOT surface its doc as a hit.
                 and an.deleted_at is null
                 and to_tsvector('english', cm.body) @@ ${tsq}
             )
        )
        select doc_id, slug, title, kind, match_source
        from matched
        order by
          case match_source when 'title' then 0 when 'content' then 1 else 2 end,
          title asc
        limit ${q.limit}
      `);

      const list = (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown as unknown[]);
      return (list as Array<Record<string, unknown>>).map((r) => ({
        docId: String(r.doc_id),
        slug: String(r.slug),
        title: String(r.title),
        kind: r.kind as SearchHit["kind"],
        matchSource: r.match_source as SearchHit["matchSource"],
      }));
    },
  };
}
