# Spec: workspace-project-browse

**Created:** 2026-06-18
**Last updated:** 2026-06-19
**Status:** Draft

## Overview

The doc-browse surface for the workspace: browsing the docs **inside a single project**, and a
**faceted filter** that narrows any doc browse (the workspace-wide "All docs" union AND the
per-project view) by status, format, access, and recency. Split out of `workspace-project-ui` (which
held the doc grid, pagination, and access indicator) because adding the per-project view + the full
faceted filter would push that spec past its size cap. This spec builds on those existing pieces and
**supersedes** the dead 3-tab filter (`workspace-project-ui`:S-008's `All / Shared / Has-detached`
chips, where Shared/Has-detached were hardcoded to 0).

## Data Model

No persistent data — a client. Reads the workspace-project backend over the Eden client:
- per-project docs via the existing project-docs read (`workspace-project`:S-003/AS-021), each row
  `{ id, slug, title, kind, version, annotationCount, authorName, status, generalAccess }`.
Client state: the active project id (from the route), the filter facet selections (which Status /
Format / Access values are selected — all selected by default; the Updated window — a single choice;
the Has-detached toggle), the filter-popover open/closed, the sort key, and the grid/list view.

## Stories

### S-001: Browse a single project's docs (P1)

**Description:** As a member, I click a project on the Projects screen and land on a view that lists
ONLY that project's docs — its own grid with pagination and per-doc access indicator — with the
project name shown and a way back to all Projects. Today clicking a project wrongly opens the
workspace-wide All-docs union (`projects-screen.tsx` navigates to `/docs`), so there is no way to see
one project's docs.
**Source:** user dogfood 2026-06-18 ("click project item rất khó để vào list doc thuộc project"); `projects-screen.tsx:129` navigates to `/docs` with a "deferred to a per-project route" comment. Producer `GET /api/w/:workspaceId/projects/:id/docs` already exists (`workspace-project`:S-007).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/web/src/app/` (add the `/w/:workspaceId/projects/:id` route), new `apps/web/src/features/docs/components/project-docs-screen.tsx`, `apps/web/src/features/docs/components/projects-screen.tsx` (card navigates to the project route), `apps/web/src/features/docs/hooks/use-docs.ts` (a per-project docs hook), reuse `doc-card.tsx`/`doc-list.tsx`/`pagination.tsx`
- `autonomous:` true
- `verify:` open the Projects screen, click a project with docs → a view shows only that project's docs, the project name in the header, and a back-to-Projects control; clicking a different project shows that other project's docs.

**Acceptance Scenarios:**

AS-001: Opening a project shows only that project's docs
- **Given:** the Projects screen, with project "Billing" (3 docs) and project "Payments" (5 docs) I can access
- **When:** I click the "Billing" card
- **Then:** I land on a view listing ONLY Billing's 3 docs (not the workspace-wide union), with "Billing" shown as the view title
- **Data:** Billing 3 docs, Payments 5 docs

AS-002: The per-project view offers a way back to all projects
- **Given:** I am on the per-project view for "Billing"
- **When:** I use the back-to-Projects control
- **Then:** I return to the Projects screen
- **Data:** back from Billing

AS-003: A project's doc list paginates like the All-docs grid
- **Given:** a project with more than one page of accessible docs
- **When:** I open it
- **Then:** the view shows the first page in the doc grid with the numbered pagination control, and navigating pages works as on All-docs
- **Data:** a project with 25 accessible docs

AS-004: A project with no accessible docs shows an empty state
- **Given:** a project I can open that has no docs I can access
- **When:** I open it
- **Then:** the view shows an empty state (not a blank grid), still naming the project, with the back-to-Projects control
- **Data:** 0 accessible docs

### S-002: Filter the doc browse by status, format, access, and recency (P1)

**Description:** As someone browsing docs, I open a single Filter control on the browse bar and narrow
the list on independent facets — Status (Live/Draft), Format (HTML/Markdown/Image), Access
(Restricted/Workspace/Link), and Updated (Any time / Last 7 days / Last 30 days) — with a Sort control
and a grid/list toggle beside it. The same filter works on the All-docs browse and the per-project
view. It replaces the old 3-tab filter (whose Shared/Has-detached tabs never worked). There is no
search box on the bar — a global search already exists.
**Source:** user-approved design "option B" 2026-06-18 (single Filter popover, no search block, applies to All-docs + per-project); supersedes `workspace-project-ui`:S-008's 3-tab filter (All/Shared/Has-detached hardcoded 0). Reuses the annotation-rail two-axis filter engine (`annotation-core-ui`:S-007). Prototype reference: docs/explore browse-pagination + the filter mockup `~/.gstack/projects/anchord/designs/filter-bar-20260618/option-b-full.html`.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/docs/components/{docs-screen.tsx,project-docs-screen.tsx}` (mount the filter bar; remove the 3-tab filter from docs-screen), new `apps/web/src/features/docs/components/doc-filter-bar.tsx` + `doc-filter-popover.tsx`, a shared `apps/web/src/features/docs/lib/doc-filter.ts` (facet derivation + predicate + dynamic counts, mirroring `viewer/lib/annotation-filter.ts`), `apps/web/src/features/docs/hooks/use-docs.ts`
- `autonomous:` true
- `verify:` open All-docs → a Filter button opens a popover with Status/Format/Access/Updated groups (all selected, counts shown) and a Sort + grid/list control beside it, no search box; deselect a Format value → docs of that format leave the grid and the header reads "showing X of N"; the same Filter works on a per-project view; Reset re-selects everything.

**Acceptance Scenarios:**

AS-005: The Filter popover lists the facet groups with counts, all selected by default
- **Given:** the All-docs browse with a mix of statuses, formats, and access levels
- **When:** I open the Filter control
- **Then:** a single popover shows four facet groups — Status (Live/Draft), Format (HTML/Markdown/Image), Access (Restricted/Workspace/Link), and Updated (Any time / Last 7 days / Last 30 days) — each value with a count; every value is selected by default and the grid shows all docs; the bar has a Sort control and a grid/list toggle but NO search box
- **Data:** 48 docs across the three multi-select axes

AS-006: Deselecting a facet value narrows the grid
- **Given:** the Filter popover open with everything selected
- **When:** I deselect the Markdown format value
- **Then:** Markdown docs leave the grid and the remaining formats stay; the result count updates
- **Data:** deselect Markdown (42 of 48)

AS-007: Facets combine — a doc shows only when it matches every axis
- **Given:** the Filter popover open
- **When:** I narrow Status to only Draft and Access to only Restricted
- **Then:** the grid shows only docs that are BOTH draft AND restricted; a live-or-shared doc is hidden
- **Data:** Status={Draft}, Access={Restricted}

AS-008: The Updated window narrows by recency (single choice)
- **Given:** the Filter popover open with Updated = Any time
- **When:** I choose Updated = Last 7 days
- **Then:** only docs updated within the last 7 days remain, and the other Updated options are not also active (single-select)
- **Data:** 9 of 48 updated in the last 7 days

AS-009: Facet counts are dynamic against the other axes' selection
- **Given:** the Filter popover open
- **When:** I narrow Access to only Link
- **Then:** the Status and Format counts recompute to reflect only Link docs (not the whole-browse totals)
- **Data:** Access={Link}; Link docs split across statuses/formats

AS-010: The header shows how much is showing and Reset clears the filter
- **Given:** a filter narrowing the browse to 12 of 48 docs
- **When:** I read the bar, then choose Reset
- **Then:** while narrowed the header reads "showing 12 of 48" and the Filter control reads active; after Reset every facet is selected, the header shows the full count, and the Filter control reads inactive
- **Data:** narrowed 12/48, then Reset

AS-011: The same filter narrows a per-project view
- **Given:** the per-project view for "Billing" (a mix of formats)
- **When:** I open the Filter and deselect a format value
- **Then:** that format's docs leave Billing's grid exactly as on All-docs, and the per-project count updates
- **Data:** Billing with HTML + Markdown docs, deselect HTML

### S-003: Sort the doc browse (P1)

**Description:** As someone browsing docs, I pick a sort order from the bar — Updated (the default,
most-recently-updated first), Created (newest first), or Title (A→Z) — and the grid reorders. The
same Sort control works on the All-docs browse and the per-project view, beside the Filter.
**Source:** user-approved design "option B" 2026-06-18 — the bar carries a Sort control (Updated / Created / Title); decision 2026-06-18 (build Sort now). Mockup: `~/.gstack/projects/anchord/designs/filter-bar-20260618/option-b-full.html`.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/docs/components/doc-filter-bar.tsx` (the Sort control), `apps/web/src/features/docs/lib/doc-filter.ts` (comparator), `apps/web/src/features/docs/hooks/use-docs.ts`
- `autonomous:` true
- **needs** the browse row to carry `updatedAt` + `createdAt` for the Updated/Created orders (GAP-002); Title sorts on the row's existing title. Until the producer serves the timestamps, only Title is wired (Updated/Created blocked).
- `verify:` on All-docs the default order is most-recently-updated first; choosing Title reorders A→Z; choosing Created orders by creation time; the same Sort works on a per-project view.

**Acceptance Scenarios:**

AS-012: The default order is most-recently-updated first
- **Given:** the All-docs browse with docs updated at different times
- **When:** I open it without changing the sort
- **Then:** the docs are ordered most-recently-updated first
- **Data:** docs with distinct updated times → newest at top

AS-013: Sorting by Title orders alphabetically
- **Given:** the browse with the Sort control
- **When:** I choose Sort = Title
- **Then:** the docs reorder alphabetically by title (A→Z)
- **Data:** titles "Auth", "Webhook", "Calendar" → Auth, Calendar, Webhook

AS-014: Sorting by Created orders by creation time
- **Given:** the browse with the Sort control
- **When:** I choose Sort = Created
- **Then:** the docs reorder by creation time, newest first
- **Data:** docs created on distinct dates → newest at top

AS-015: The chosen sort applies to a per-project view too
- **Given:** a per-project view with the Sort control
- **When:** I choose Sort = Title
- **Then:** that project's docs reorder A→Z exactly as on All-docs
- **Data:** Billing docs sorted by Title

## Constraints & Invariants

- C-001: Clicking a project on the Projects screen opens that project's own doc view (its docs only,
  by the project id in the route), never the workspace-wide union. The view always names the project
  and offers a path back to all Projects. (AS-001, AS-002)
- C-002: The per-project view reuses the All-docs doc grid + numbered pagination + per-doc access
  indicator; access filtering is applied by the backend (only docs the caller can access are listed).
  (AS-003, AS-004)
- C-003: The doc browse is filtered by four facets — Status {Live, Draft}, Format {HTML, Markdown,
  Image}, Access {Restricted, Workspace, Link} (multi-select), and Updated {Any time, Last 7 days,
  Last 30 days} (single-select). A doc is shown iff it matches a selected value in EVERY axis (OR
  within an axis, AND across axes); all values are selected by default. The filter lives in one
  popover opened from a Filter control; Sort and the grid/list toggle sit outside it; there is NO
  search box on the bar (global search is a separate surface). (AS-005, AS-006, AS-007, AS-008, AS-011)
- C-004: Facet counts are dynamic — each value's count reflects the docs it would match combined with
  the OTHER axes' current selection, ignoring its own axis. While the selection is narrowed the bar
  reads "showing X of N" and the Filter control reads active; Reset re-selects every facet and the
  header returns to the full count. (AS-009, AS-010)
- C-005: The SAME filter component drives both the All-docs browse and the per-project view; it
  replaces the former 3-tab filter (`workspace-project-ui`:S-008 All/Shared/Has-detached), which is
  removed. (AS-011)
- C-006: Every screen uses the DESIGN.md dark-operator system (teal-only accent) and is responsive
  (the filter popover becomes a bottom-sheet on tablet/mobile; tap targets ≥40px). (AS-005; responsive/pixel visual is [→MANUAL] + a Playwright runtime check)
- C-007: The browse offers a Sort control beside the Filter with keys Updated / Created / Title;
  default is Updated, most-recent first; Updated and Created order descending (newest first), Title
  orders ascending (A→Z). The same Sort applies to the All-docs browse and the per-project view. Sort
  is orthogonal to the filter (it reorders, the filter subsets). Updated/Created require row
  timestamps (GAP-002); Title sorts on the row title. (AS-012, AS-013, AS-014, AS-015)

## Linked Fields

workspace-project-browse is a **consumer**; `workspace-project` (backend) is the producer.

- `generalAccess` on browse rows — consumed by S-002 (the Access facet) on the project-docs read,
  per fetch. Produced by `workspace-project`:S-003 (AS-021) on the browse row. ✔ surface + lifecycle
  match (already served).
- per-doc **detached count** — consumed by the "Has detached" filter (the old 3rd tab's intent). The
  browse row does NOT carry a detached/orphaned count today. ✘ no producer → GAP-001 (the Has-detached
  facet is deferred until the row carries it).
- `updatedAt` + `createdAt` on browse rows — consumed by S-003 (the Updated + Created sort orders) per
  fetch. Produced by `workspace-project`:S-003 (AS-022) on the browse row. ✔ surface + lifecycle match
  (producer specced 2026-06-19; GAP-002 resolved — the serving code is the AS-022 build).

## UI Notes

Design source: the user-approved "option B" mockup (`~/.gstack/projects/anchord/designs/filter-bar-20260618/option-b-full.html`) — canonical on conflict. Precedence: AS / Constraints > mockup > this Tree. Dark-operator (DESIGN.md).

- `ProjectDocsScreen` `[N]` *(route `/w/:workspaceId/projects/:id`)*
  - `ProjectDocsHeader`: back-to-Projects · project name · doc count
  - `DocFilterBar` *(shared, see below)*
  - `DocGrid`/`DocList` *(reuse — the project's docs)* · `Pagination` *(reuse)* · empty state
- `DocFilterBar` `[N]` *(mounted on BOTH the All-docs `DocsScreen` and `ProjectDocsScreen`)*
  - `FilterControl` *(button + active badge; "showing X of N" beside it)* · `SortControl` · grid/list toggle — NO search box
  - `DocFilterPopover` *(bottom-sheet on mobile)*: header *(title + `Reset all`)* · `FacetGroup` Status · `FacetGroup` Format · `FacetGroup` Access *(multi-select CHECKBOX rows, icon + dynamic count, each group with an `All` shortcut)* · `FacetGroup` Updated *(single-select radio)* · `Has detached only` *(toggle — rendered DISABLED/greyed until GAP-001's backend producer ships)* · footer *(`Reset` + `Done`)*. The bar's Filter button shows a badge = number of narrowed facet groups.
- *DocsScreen loses its `All / Shared / Has detached` tab strip (replaced by `DocFilterBar`).*

> Mockup: `option-b-full.html` (canonical on conflict for the popover/bar shape).

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| `DocsScreen` (All-docs browse + grid/list toggle) | `apps/web/src/features/docs/components/docs-screen.tsx` | reuse; REMOVE the 3-tab filter, mount `DocFilterBar` |
| `DocCard` / `DocList` / `doc-bits` (FormatBadge/VersionTag/AnnotationCount/StatusTag/AccessIndicator) | `apps/web/src/features/docs/components/{doc-card,doc-list,doc-bits}.tsx` | reuse as-is for the per-project grid |
| `Pagination` numbered control | `apps/web/src/components/pagination.tsx` | reuse for the per-project list |
| `ProjectsScreen` (project cards) | `apps/web/src/features/docs/components/projects-screen.tsx` | reuse; card navigates to the project route instead of `/docs` |
| `useWorkspaceDocs` / `fetchProjectDocs` | `apps/web/src/features/docs/hooks/use-docs.ts`, `services/client.ts` | reuse; add a per-project docs hook (scoped to one project id) |
| App shell + router | `apps/web/src/app/` | add the `/w/:workspaceId/projects/:id` route |

### System Impact & Technical Risks

- The two-axis filter engine already exists for the annotation rail (`apps/web/src/features/viewer/lib/annotation-filter.ts`: facet derivation, AND-across predicate, dynamic counts). The doc filter mirrors it for doc facets — reuse the SHAPE (a `doc-filter.ts`), don't rebuild a new mechanism.
- All-docs is a CLIENT-side union (`useWorkspaceDocs` pages through `hasNext` to the complete set, then slices) — the filter applies to that complete set client-side, like the rail. The per-project view reads one project's complete set the same way.
- The "Has detached" facet (the old 3rd tab) needs a per-doc detached/orphaned count the browse row does not serve (GAP-001) — deferred.

## Not in Scope

- A search box on the browse bar — a global search surface already exists (`search-screen`); merging search into the bar is out.
- The backend `detachedCount` on the browse row (needed by the Has-detached facet) — `workspace-project` (backend); tracked as GAP-001.
- Saving/sharing a filter via the URL or persisting it across sessions — not asked; the filter is per-view client state.
- Sort fields beyond Updated/Created/Title (e.g. "Views") — anchord does not track a view count; out.
- Per-project membership/roles or a project-scoped share — `workspace-project` C-007 (deferred).

## Gaps

- GAP-001 (status: open — owner: backend): the "Has detached" facet (the old 3rd tab's intent) needs
  the browse doc row to carry a per-doc detached/orphaned annotation count, which it does not today.
  CHOICE TAKEN (2026-06-19): the "Has detached only" toggle is RENDERED DISABLED/greyed in the popover
  (matching the option-B mockup) with a "coming soon" hint — not omitted — so the surface is complete;
  it becomes interactive once a producer serves the per-doc detached count. Source: user "'Has detached'
  needs a per-doc detached count the browse row does not yet serve — gap it if unavailable."
- GAP-002 (status: resolved — producer specced 2026-06-19): S-003's Updated + Created sort orders need
  the browse doc row to carry `updatedAt` + `createdAt`. Resolved → producer is `workspace-project`:S-003
  (AS-022): the browse row serves both times. Build order: build that producer AS (BE serving the
  timestamps), then the Updated/Created sort in S-003. Title sort needs no producer. Source: user
  "build Sort now" (option B) + the row's current field set.

## Spec Sizing Notes

Stories=3, AS=15 — both under the soft target. Split out of `workspace-project-ui` (which was at 8
stories / 27 AS in the G7 overage range): adding this feature there would have exceeded the 30-AS hard
cap, so the per-project browse + faceted filter + sort live here as a self-contained sibling sub-spec.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-19 | Minor — UI Notes: the DocFilterPopover now matches the option-B mockup chrome (header + Reset all; per-group All; checkbox rows; Has-detached-only toggle rendered DISABLED per GAP-001; footer Reset/Done; Filter-button narrowed-count badge). No AS/behavior change. | -- |
| 2026-06-19 | GAP-002 resolved (Minor): the Updated/Created sort producer is now specced (`workspace-project`:S-003/AS-022 — browse row serves created_at+updated_at); Linked Field timestamps ✘→✔; GAP-002 → resolved. Sort Updated/Created now unblocked. | -- |
| 2026-06-18 | Initial creation — per-project doc browse (S-001) + faceted filter "option B" (S-002) + sort (S-003), split from workspace-project-ui (size cap); supersedes its 3-tab filter; reuses the annotation-rail filter engine + DocGrid/pagination/AccessIndicator. GAP-001 (detachedCount) + GAP-002 (row timestamps for Updated/Created sort) await backend producers. Source: user dogfood (project→docs nav gap) + user-approved option-B filter design + "build Sort now". | -- |
