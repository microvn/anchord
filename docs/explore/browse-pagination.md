## Explore: Browse-List Pagination (docs / projects / search)
_2026-06-17_

**Feature:** Add numbered pagination (Prev/Next + page N) to the three browse lists that
currently return their full result set unpaginated: docs within a project, the projects list,
and search results.

**Trigger:** User opens a workspace/project browse surface, or runs a search. Pagination
controls appear when there is more than one page; user clicks Prev/Next or a page number.

**Problem being solved:** These browse lists return everything in one response, so they grow
unbounded as a workspace accumulates docs/projects/search hits — slow payloads and an
ever-longer scroll. The backend already has a shared pagination helper
(`apps/backend/src/http/pagination.ts`: `paginate()` + `paginationQuery()`, default limit 20,
emitting `{ page, limit, total, totalPages, hasNext, hasPrevious }`) used by the annotation
list — but these browse endpoints don't use it, and no FE list consumes pagination yet.

**UI expectation:** Numbered pagination — Prev/Next plus page numbers — under each list.
Reuse the backend's existing `total`/`totalPages`. Responsive (DESIGN.md mandatory).

**UI sketches:**

```
┌─ Project docs / Projects / Search results [E] ──────────────────────┐
│  DocCard / row [E]  DocCard [E]  DocCard [E]  …                       │
│  ────────────────────────────────────────────────────────────────   │
│      [‹ Prev]  1  2  [3]  4  5  [Next ›]      [N pagination control]  │
└───────────────────────────────────────────────────────────────────────┘

Legend: [E] existing · [N] NEW · [X] MISSING / clarify
```

- Project docs list surface — `[E]` `apps/web/src/features/docs/components/doc-list.tsx`,
  `docs-screen.tsx`, `doc-card.tsx`.
- Projects list surface — `[E]` `apps/web/src/features/docs/components/projects-screen.tsx`
  (+ workspace-home project tiles, `apps/web/src/features/workspaces/components/workspace-home.tsx`).
- Search results surface — `[E]` `apps/web/src/features/docs/components/search-screen.tsx`.
- Numbered pagination control (Prev/Next + page numbers) — `[N]` (shared component, reused by
  all three).
- Backend project-docs endpoint — `[E]` `apps/backend/src/routes/projects.ts:194`
  `GET /api/w/:workspaceId/projects/:id/docs` (returns `{ docs: [...] }`, NO pagination).
- Backend projects endpoint — `[E]` (the workspace projects list route).
- Backend search endpoint — `[E]` `apps/backend/src/routes/search.ts`
  `GET /api/search?q=&projectId=` (returns `{ results: [...] }`, NO pagination).
- Shared pagination primitives — `[E]` `apps/backend/src/http/pagination.ts`
  (`paginate`, `paginationQuery`).

**Happy path:**
1. User opens a project with 45 docs.
2. The list shows the first page (20 docs) with a pagination control: `‹ Prev  1 [2] 3  Next ›`.
3. User clicks page 3 → the list refetches `?page=3&limit=20` and renders docs 41–45; the
   control reflects page 3, Next disabled (last page).

**Business rules:**
- Pagination style = **numbered pages** (Prev/Next + page numbers), driven by `total`/
  `totalPages` from the existing helper. (Decision: A.)
- Default page size = **20** (the existing `paginationQuery()` default). [Assumption — confirm]
- Applies to all THREE surfaces consistently: project docs, projects list, search. (Decision:
  search included — A.)
- Server-side access filtering stays the source of truth: pagination wraps the ALREADY
  access-filtered result (search/browse share C-003's one access rule) — do not paginate
  before filtering, or page counts/totals would leak hidden items.

**Input validation:**
- `page` ≥ 1 integer, `limit` within the helper's bounds — reuse `paginationQuery()` (already
  validates). Out-of-range page → empty page with honest `totalPages` (no error).

**Edge cases:**
- Empty list / no search hits: `total: 0`, `totalPages: 0`, no pagination control shown
  (existing empty states stay).
- Single page (`total ≤ limit`): hide or disable the control.
- Page beyond `totalPages` (stale link, deletions shrank the set): return an empty page with
  correct totals; FE clamps to the last valid page.
- A doc/project deleted between page loads shifts items — acceptable for v0 (no live sync).
- Search with `projectId` scope: pagination must respect the scope (paginate within the scoped
  result, not the whole workspace).

**Permissions:** unchanged. Same workspace-membership gate + per-doc access filtering. Counts
(`total`) reflect only what the caller may see.

**Data impact:** none (no schema change). Reads only; adds `page`/`limit` query params and a
`pagination` block to responses.

**Impact on existing system — CONTRACT CHANGE (the main risk):**
- `GET …/projects/:id/docs` response shape changes from `{ docs: [...] }` to a paginated
  envelope (`{ items, pagination }` or `{ docs, pagination }` — pick one, match the annotation
  list's `{ items, pagination }` for consistency). EVERY FE consumer of `projectDocs(...)` must
  update (`apps/web/src/features/docs/services/client.ts:36`).
- Projects list endpoint: same shape change + its FE consumers.
- `GET /api/search` response shape changes from `{ results: [...] }` to paginated. Search FE
  (`search-screen.tsx`) + its client thunk must update.
- These are LINKED FIELDS across BE→FE: the spec must pin, for each surface, that `pagination`
  is produced on the list response and consumed by the matching FE list. (mf-plan CC11.)

**Out of scope:**
- The annotation rail — it goes the OPPOSITE way (load-all, no paging); see
  `docs/explore/annotation-rail-completeness.md`.
- Infinite scroll / "load more" (rejected in favor of numbered pages).
- Sort/filter controls on the browse lists (only pagination is in scope here).
- Cursor/keyset pagination (offset/page is fine at this scale).

**Decision rationale:**
- Numbered pages over load-more/infinite (chose A): the backend already returns
  `total`/`totalPages`, so numbered pages are nearly free and give the user a predictable
  position. Load-more would waste the totals already computed.
- Include search (chose A): same browse pattern + same helper; doing it separately would
  duplicate the FE pagination wiring.
- Reuse `apps/backend/src/http/pagination.ts` rather than a new mechanism — it already backs
  the annotation list and emits exactly the fields the numbered control needs.

**Assumptions (need confirmation):**
- Page size 20 across all three surfaces.
- Response envelope standardizes on `{ items, pagination }` (matching the annotation list) for
  all three — including renaming `docs`/`results` to `items`. (If renaming is undesirable, keep
  the domain key and ADD `pagination` alongside.)

**Open questions:**
- Page size: 20 everywhere, or per-surface (e.g. search 10, docs 20)?
- Keep the domain key (`docs`/`results`) or unify to `items`? (Affects how many consumers change.)
- Workspace-home: does it paginate its project tiles + any "recent docs" strip, or only the
  dedicated projects/docs screens?

**Complexity signal:** medium.
Based on: 3 endpoints change response shape (contract change with FE fan-out), 1 new shared FE
pagination control reused 3×, 0 schema change, helper already exists.

**Non-functional requirements:**
- Scale: bounds payload growth as workspaces accumulate docs/projects/search hits.
- Performance: paginated reads are cheaper than today's full-set reads; ensure the count query
  doesn't dominate (the helper computes `total` — verify it's a `count(*)`, not materializing all).
- Security/compliance: none new; access filter precedes pagination.
- Availability: browse surfaces; no availability impact.

**Technical risks:**
- Response-shape contract change across 3 endpoints with multiple FE consumers each — the
  highest-risk part. Every importer AND any `mock.module(...)` target must update in the same
  change (per CLAUDE.md FE rules). Tests asserting `{ docs }`/`{ results }` shape will break and
  must move to the paginated envelope.
- Search may currently compute results in a way that doesn't cheaply yield a total — verify the
  FTS repo can return `total` without materializing every row.
