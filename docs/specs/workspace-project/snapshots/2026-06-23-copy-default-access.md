# Snapshot: workspace-project
**Date:** 2026-06-23
**Ref:** doc-access shared-workspace model — copy path
**Reason:** M6 (C-008 amended: a copied doc inherits the workspace defaultAccess, not hard restricted) + AS-013 Then

---

# Spec: workspace-project

**Created:** 2026-06-07
**Last updated:** 2026-06-23
**Status:** Draft
**Snapshot limit:** 12

## Overview

The Workspace → Project → Doc organization layer for v0 single-workspace (the
instance is one workspace). First-run creates the workspace + admin; members
create projects/docs; browse and search filter by doc access. (Notify + email
was extracted to the `notifications-email` spec on 2026-06-20.)

## Data Model

- **workspaces**: `id`, `name`, `slug`, `settings` (auth providers, default access,
  branding). Exactly 1 row in v0.
- **workspace_members**: `workspace_id`, `user_id`, `role` (admin | member).
- **projects**: `workspace_id`, `name`, `archived_at`.
- **docs.project_id** (defined in `render-publish`). The browse doc row also serves
  **docs.general_access** (restricted | anyone_in_workspace | anyone_with_link) so the consumer
  can show a per-doc access indicator (S-003/AS-021), plus **docs.created_at + docs.updated_at** so
  the consumer can sort the browse by Created / Updated (S-003/AS-022). **Doc-access default
  (2026-06-23, shared-workspace model):** a newly published doc's `general_access` is NOT `restricted` by
  default — it inherits the workspace's `settings.defaultAccess`, which defaults to
  `anyone_in_workspace` (defined in `workspaces`:C-007; set at publish by `render-publish` /
  `mcp-roundtrip`). So in the common case a member browsing a project sees the workspace's docs;
  `restricted` is the per-doc opt-in for a private doc. The browse access filter (C-003, AS-006)
  is unchanged — it still hides docs the caller can't access.
- **doc_versions.extracted_text**: plain text extracted from the version's HTML/MD,
  written when each version is published (GAP-003 resolved → publish-time extraction).
  The search index reads the **current** version's `extracted_text`.
- Full-text index on docs (title + text extracted from HTML/MD) + comment bodies.
  (The **notifications** table moved to the `notifications-email` spec, which owns its
  schema + the notify/email behaviour.)

## Stories

### S-001: First-run setup creates workspace + admin (P0)

**Description:** As the person installing the instance, on the first open I create
the admin account and workspace; whoever signs up afterward is a regular member.
**Source:** docs/explore/workspace-project.md#decisions (item 1 single workspace).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (first-run wizard + workspace bootstrap)
- `autonomous:` true
- `verify:` new instance → first-run creates admin + workspace; the second user is a member.

**Acceptance Scenarios:**

AS-001: First user becomes instance admin + creates workspace
- **Given:** new instance, no workspace yet
- **When:** the first person completes first-run (sets workspace name, branding, enables providers)
- **Then:** the workspace is created + that account is admin
- **Data:** name "Acme", enable GitHub+Google

AS-002: Anyone who signs up later is a regular member
- **Given:** workspace already exists with 1 admin
- **When:** a second person signs up / is invited in
- **Then:** they are a member (not an admin)
- **Data:** second user

### S-002: Manage workspace members (P1)

**Description:** As an admin, I invite and remove members; members cannot manage membership.
**Source:** docs/explore/workspace-project.md#decisions (item 2 roles).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-003: Admin invites a member
- **Given:** admin opens the member directory
- **When:** invites `dev@acme.com` as a member
- **Then:** that person joins the workspace with role member
- **Data:** member email

AS-004: Member cannot manage membership
- **Given:** user with role member
- **When:** they try to open member management / workspace settings
- **Then:** not allowed (admin only)
- **Data:** member tries to invite someone

AS-012: Removing a member does not lose their docs
- **Given:** member M owns a doc in a project (general_access = anyone_in_workspace)
- **When:** admin removes M from the workspace
- **Then:** the doc stays in the project/workspace, other members still access it per
  general_access; the doc's share management loses its owner, so the admin takes over (fallback)
- **Data:** M owns 1 doc anyone_in_workspace

### S-003: Create & browse projects (P0)

**Description:** As a member, I create/rename/archive/delete projects and browse docs
within a project — seeing only docs I have access to.
**Source:** docs/explore/workspace-project.md#decisions (item 3 project); AS-028 added 2026-06-21 (the `/projects` Network storm — `useProjectsBrowse` fan-out: one per-project count read each).
**Applies Constraints:** C-003

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/routes/projects.ts` + `apps/backend/src/workspace/repo.ts` (projects-list read returns each project's accessible-doc count in ONE query — group-by after the C-003 access filter), `apps/web/src/features/docs/hooks/use-docs.ts` (`useProjectsBrowse` reads the served count, drops the per-project `projectWithCount` fan-out), `apps/web/src/features/docs/services/client.ts`
- `autonomous:` true
- `verify:` create a project, publish a doc into it; another user without access to that doc does not see it in browse. Open `/w/:id/projects` → ONE projects-list request carries each project's accessible-doc count (no per-project count request in the network panel).

**Acceptance Scenarios:**

AS-005: Member creates a project and publishes a doc into it
- **Given:** member is logged in
- **When:** creates project "Billing", publishes a doc into it
- **Then:** the project + doc appear; the member is the doc owner
- **Data:** project "Billing"

AS-006: Browse shows only docs the user has access to
- **Given:** project "Billing" has doc A (restricted, user X not invited) and doc B
  (anyone_in_workspace)
- **When:** member X opens project "Billing"
- **Then:** sees doc B, does NOT see doc A
- **Data:** X has no access to doc A

AS-014: Each account has an auto-created default project
- **Given:** a user becomes a member of the workspace
- **When:** the account is created/joins
- **Then:** a default project is auto-created for that user (where MCP places docs if
  projectId is missing — `mcp-roundtrip:AS-003`)
- **Data:** new user → default project "<user name>'s docs"

AS-007: Archiving a project hides it from browse
- **Given:** a project with docs
- **When:** member archives the project
- **Then:** the project is hidden from browse by default; docs remain accessible via
  direct link; unarchive to show it again
- **Data:** archived project

AS-021: The browse doc row carries the doc's general access level
- **Given:** project "Billing" browsable by member X holds doc B (general access "anyone in workspace") and doc C (general access "anyone with link")
- **When:** member X opens project "Billing"
- **Then:** each browse doc row carries the doc's general access level — one of restricted / anyone-in-workspace / anyone-with-link — so a consumer can show a per-doc access indicator without a second fetch
- **Data:** doc B = anyone_in_workspace, doc C = anyone_with_link → each row reports its level

AS-022: The browse doc row carries the doc's created and updated times
- **Given:** project "Billing" browsable by member X holds docs with distinct creation and last-updated times
- **When:** member X opens project "Billing"
- **Then:** each browse doc row carries the doc's created time and last-updated time, so a consumer can sort the browse by Created or by Updated without a second fetch
- **Data:** doc created 2026-06-01 / updated 2026-06-18, doc created 2026-06-10 / updated 2026-06-12 → each row reports both times

AS-028: The projects-list read carries each project's accessible-doc count
- **Given:** member X lists the workspace's projects — "Billing" holds 5 docs X can access, "Payments" holds 9 of which X can access 3, "Empty" holds 0
- **When:** X lists the projects (one request)
- **Then:** each project row in the SAME response carries its accessible-doc count — Billing 5, Payments 3, Empty 0 — counting ONLY docs X can access (C-003, the count never leaks out-of-access docs); the consumer renders the per-project count from this one read, with no follow-up per-project request
- **Data:** Billing 5 accessible, Payments 3 of 9 accessible, Empty 0 → counts 5 / 3 / 0

### S-004: Move or copy a doc between projects (P1)

**Description:** As someone with access, I move or duplicate a doc into another project
within the same workspace.
**Source:** docs/explore/workspace-project.md#decisions (item 3 move/copy).

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-008: Move a doc to another project
- **Given:** doc is currently in project "Billing"
- **When:** moves to project "Payments" (same workspace)
- **Then:** the doc belongs to "Payments"; its access/sharing/version/annotation are unchanged
- **Data:** Billing → Payments

AS-013: Duplicate (copy) a doc to another project
- **Given:** doc in project "Billing" is at version 3
- **When:** copy to project "Payments"
- **Then:** create a NEW doc in "Payments" with a new slug, content = the current
  version as version 1; do NOT copy annotations/comments (clean copy); the source doc is unchanged
- **Data:** copy a 3-version doc → new 1-version doc, no annotations

### S-005: Search across accessible docs (P0)

**Description:** As a user, I search by title, content, and comments; results show
only docs I have access to.
**Source:** docs/explore/workspace-project.md#decisions (item 4 search).

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` unknown (Postgres FTS + extract-text pipeline)
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: Search matches content + comments, filtered by access
- **Given:** doc "Payment Spec" (I have access) contains the word "refund" in its content;
  another doc contains "refund" but I have no access
- **When:** search "refund" (whole workspace)
- **Then:** returns "Payment Spec" (matches content/comments); does NOT return docs I have no
  access to, even when the keyword matches in a **comment** of a restricted doc (no snippet leaked)
- **Data:** "refund" in content + 1 out-of-access restricted doc with a comment containing "refund"

AS-010: Search scoped to a single project
- **Given:** currently in project "Billing"
- **When:** search "invoice" within the project
- **Then:** returns only matching docs in "Billing" that I have access to
- **Data:** scope = project

AS-015: An edited doc's latest content is searchable
- **Given:** a doc I can access was published with content "alpha", then a new version was published with content "bravo" (now the current version)
- **When:** I search "bravo"
- **Then:** the doc is returned (search reads the current version's extracted text — every published version has its searchable text extracted at publish, not only the first)
- **Data:** doc edited from v1 "alpha" → v2 "bravo"

### S-007: Paginate the browse + search reads (P1)

**Description:** As the producer of the workspace browse surfaces, the doc-browse (docs within a
project), the projects list, and search return one bounded page at a time with a summary of the
total and whether more pages exist — instead of the whole set in one response — so a large workspace
stays fast and the consumer can render numbered navigation.
**Source:** docs/explore/browse-pagination.md#Feature; workspace-project-ui:GAP-004 (consumer S-008
needs these reads paginated). Builds on the existing browse (S-003 AS-006) + search (S-005 AS-009)
reads, which currently return the full accessible set unpaginated.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/backend/src/routes/projects.ts` (project docs list + projects list), `apps/backend/src/routes/search.ts`, `apps/backend/src/workspace/repo.ts` / `apps/backend/src/search/{search.ts,search-repo.ts}` (page slice + total after access filter), reusing `apps/backend/src/http/pagination.ts`
- `autonomous:` true
- `verify:` request a project's docs with more than 20 accessible docs → the response carries 20 docs plus a page summary (page 1 of 3, total count, more pages available); request a later page → the matching slice; search and the projects list behave the same; a caller who can access only some docs sees a total reflecting only those.

**Acceptance Scenarios:**

AS-016: A project's doc browse returns one page with a total summary
- **Given:** a project with 45 docs the caller can access, page size 20
- **When:** the caller lists the project's docs (first page)
- **Then:** the response carries the first 20 docs plus a summary stating the current page, a total of 45, and that more pages exist
- **Data:** 45 accessible docs, page size 20

AS-017: Requesting a later page returns that slice
- **Given:** the same 45-doc project, page size 20
- **When:** the caller requests the third page
- **Then:** the response carries docs 41–45 and the summary states no further page exists
- **Data:** page 3 of 3

AS-018: Search returns one page with a total summary
- **Given:** a search whose accessible matches number 28, page size 20
- **When:** the caller searches (first page)
- **Then:** the response carries the first 20 matches plus a summary stating a total of 28 and that more pages exist
- **Data:** 28 accessible matches, page size 20

AS-019: The projects list returns one page with a total summary
- **Given:** a workspace with 30 projects, page size 20
- **When:** the caller lists projects (first page)
- **Then:** the response carries the first 20 projects plus a summary stating a total of 30 and that more pages exist
- **Data:** 30 projects, page size 20

AS-020: The page total counts only items the caller can access
- **Given:** a project holding 40 docs of which the caller can access 22, page size 20
- **When:** the caller lists the project's docs
- **Then:** the summary's total reflects 22 (two pages) and no out-of-access doc appears in any page — access filtering is applied before the page is taken
- **Data:** 40 docs, 22 accessible

### S-008: Workspace-wide docs read in one request (P1)

**Description:** As the producer of the all-docs surfaces, the consumer reads every doc it can access
across the WHOLE workspace from a SINGLE workspace-scoped read — each doc carrying its project name,
plus the active-project list (id + name, for the move/copy target picker + the project-count stat)
and the workspace doc total — instead of fetching the projects
list and then one read per project. This collapses the old fan-out (1 projects read + 1 read per
project) into one request. The read is paginated like the other browse reads (C-010); the consumer
requests a page sized to its grid so one server page fills one grid page exactly.
**Source:** session 2026-06-21 (the `/w/:id/docs` Network storm — N+1 fan-out in `useWorkspaceDocs`); option B "server does the union". Builds on S-007 pagination (C-010) + S-003 browse access (C-003).
**Applies Constraints:** C-003, C-010

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/backend/src/routes/` (new workspace-docs route under `/api/w/:workspaceId/docs`), `apps/backend/src/workspace/repo.ts` (union query joined to project name + the active-project list, after access filter, reusing `apps/backend/src/http/pagination.ts`), `apps/web/src/features/docs/services/client.ts` (new fetch thunk), `apps/web/src/features/docs/hooks/use-docs.ts` (`useWorkspaceDocs` → the single read), `apps/web/src/features/docs/components/docs-screen.tsx` (grid pages against the read)
- `autonomous:` true
- `verify:` open `/w/:id/docs` → ONE workspace-docs request returns the doc page + the active-project list (no per-project fan-out in the network panel); a workspace with more docs than the grid page → navigating to a later page issues one more workspace-docs request for that page; a doc the caller can't access never appears in the page or the total.

**Acceptance Scenarios:**

AS-023: The workspace-wide read returns one page of the accessible doc union, each with its project name
- **Given:** a workspace whose accessible docs span 3 projects (12 docs total), the consumer requesting a page of 18
- **When:** the consumer reads the workspace docs (first page)
- **Then:** the response carries all 12 docs in one page, each doc annotated with the name of the project it belongs to, plus a summary stating the total (12) and that no further page exists
- **Data:** 12 accessible docs across 3 projects; page size 18

AS-024: The same response carries the active-project list (id + name)
- **Given:** a workspace with three active projects A, B, C, read in one request
- **When:** the consumer reads the workspace docs
- **Then:** the SAME response also lists the workspace's active projects as id + name (the move/copy target picker + the project-count stat read this), computed from the same read — NO per-project doc count is returned (no consumer of this read renders one; the Projects browser shows per-project doc counts via its own read)
- **Data:** active projects A, B, C → a list of three {id, name}; no docCount field

AS-025: A later page returns its slice with the total summary
- **Given:** a workspace with 40 accessible docs, the consumer requesting pages of 18
- **When:** the consumer requests the third page
- **Then:** the response carries docs 37–40 and the summary states the total (40) and that no further page exists; the requested page size is honored up to the cap (100)
- **Data:** 40 accessible docs; page size 18; page 3 of 3

AS-026: Access filtering is applied before the page and the total
- **Given:** the workspace holds 50 docs of which the caller can access 22 (e.g. restricted docs in a project the caller isn't on)
- **When:** the caller reads the workspace docs
- **Then:** no out-of-access doc appears in any page; the total reflects 22 — access filtering happens before paging and before the total is computed (C-003)
- **Data:** 50 docs, 22 accessible

AS-027: The all-docs view loads from the single read, not one request per project
- **Given:** a workspace with several projects, opened at the all-docs view
- **When:** the view loads
- **Then:** it gets its doc grid AND its counts from the ONE workspace-docs read — it does NOT issue a separate read per project (the old fan-out is retired); changing to a later grid page issues exactly one more workspace-docs request for that page
- **Data:** a workspace with 4 projects → 1 workspace-docs request on load, not 1 + 4

## Constraints & Invariants

- C-001: v0 single workspace = instance; first user = admin; later users = member. (AS-001, AS-002)
- C-002: Members create projects/docs; only admins manage settings/members. (AS-003, AS-004, AS-005)
- C-003: Browse and search always filter down to docs the user has access to (no out-of-access
  doc leaked). Search joins with doc-access BEFORE returning: do not return title/content/**comment
  snippet** from out-of-access docs; "no access" and "does not exist" return indistinguishable
  results (avoid existence leak). [harden H2] (AS-006, AS-009, AS-026, AS-028)
- C-004: (retired 2026-06-20) Notify-on-reply moved to the `notifications-email` spec, where it
  broadened into thread-activity (`notifications-email:S-002`/C-004). ID kept as a tombstone; not reused.
- C-005: Archive hides a project from browse; docs are still reachable via direct link; unarchive to show. (AS-007)
- C-006: The search index includes title + text extracted from HTML/MD + comment bodies. The
  extracted text is produced at publish time for every version (stored on `doc_versions.extracted_text`);
  search reads the current version's extracted text, so an edited doc's latest content is searchable. (AS-009, AS-015)
- C-007: A doc belongs to the project/workspace, not to an individual — removing a member does not delete/hide
  the doc; access continues per general_access; the doc's share loses its owner, so the admin handles it. (AS-012)
- C-008: Copy creates a new doc (new slug, current version as v1), does NOT copy
  annotations/comments; move keeps the doc as-is (slug/version/annotation). (AS-008, AS-013)
- C-009: Each account has an auto-created default project on joining the workspace; it is where
  MCP places docs if projectId is missing (`mcp-roundtrip`). (AS-014)
- C-010: The doc-browse, projects-list, search, AND the workspace-wide docs reads are paginated at a
  default page size of 20 (the consumer may request a different page size up to a cap of 100 — e.g. the
  all-docs grid requests its grid page size so one server page fills one grid page); each response
  carries the items for the requested page plus a summary of the total count and whether further pages
  exist. Pagination is taken AFTER access filtering (C-003), so the total and page count reflect only
  items the caller can access. The existing item collection key is retained; the page summary is
  additive (the consumer keeps reading the same item key). (AS-016, AS-017, AS-018, AS-019, AS-020, AS-025, AS-026)

## Linked Fields

- **doc-access (general_access + invite)** — produced by `sharing-permissions`.
  Consumed by workspace-project:S-003/S-005 (AS-006, AS-009) to filter browse/search.
  ✔ enforcement defined in sharing; this cluster applies it when listing.
- **thread participants + doc owner** — produced by `annotation-core` (thread) + doc owner
  (sharing). Consumed by `notifications-email:S-002` (thread-activity recipients), no longer by this
  spec (notify moved out 2026-06-20).
- **extracted text of a version** — produced by the publish pipeline (`render-publish`/
  `versioning-diff`). Consumed by S-005 (AS-009) to index FTS. ✘ the text-extraction
  pipeline is not yet pinned in the render-publish spec → GAP-003.
- **generalAccess on browse rows** — produced HERE by S-003 (AS-021) on the project-docs browse
  row (persisted on the doc, served on every browse fetch). Consumed by `workspace-project-ui`:S-006
  (AS-018, the `AccessIndicator` on the doc card). ✔ surface + lifecycle match; resolves
  `workspace-project-ui`:GAP-002.
- **createdAt + updatedAt on browse rows** — produced HERE by S-003 (AS-022) on the project-docs
  browse row (persisted on the doc, served on every browse fetch). Consumed by
  `workspace-project-browse`:S-003 (the Created + Updated sort orders). ✔ surface + lifecycle match;
  resolves `workspace-project-browse`:GAP-002.
- **page summary (current page + total + has-more)** on the doc-browse, projects-list, and search
  reads — produced HERE by S-007 (AS-016..020, C-010) on each list response, alongside the existing
  item collection key. Consumed by `workspace-project-ui`:S-008 (AS-021..026, C-008) in two modes:
  SEARCH reads the summary per page (server-side numbered nav); the doc-browse and projects-list are
  consumed via `hasNext` page-through to assemble the complete access-filtered set (the FE has no
  per-project / workspace-wide doc endpoint to server-page, so it paginates that union client-side).
  ✔ served on every list read, which satisfies both modes; resolves `workspace-project-ui`:GAP-004.

## UI Notes

From `docs/explore/workspace-project.md` §UI sketches. Greenfield → `[N]`. Component
names only. Dark-operator (`DESIGN.md`). Precedence: AS > Tree.

- `ProjectBrowser` `[N]`
  - `BrowserTopBar`: workspaceName · `SearchField` *(title+content+comment)* · `NewDocButton` · `UserAvatar`
  - `ProjectSidebar`: `ProjectList` → `ProjectItem` *(default project pinned, C-009)* · `+ New project` · `FilterList` (All / Shared / Has detached)
  - `DocGrid` *(3→2→1 columns by width)* → `DocCard`: title · `FormatBadge` · versionLabel · `AccessIndicator` · annotationCount *(active annotations + annotation icon — workspace-project-ui S-007)* · `DetachedBadge`
  - `GridListToggle`
  - *Mobile: `ProjectSidebar` → drawer.*

*(The notification bell / panel UI moved to the `notifications-email` spec, S-006.)*

## What Already Exists

### System Impact & Technical Risks

- Greenfield repo. Heavy cross-spec: relies on `sharing-permissions` (access filtering),
  `annotation-core` (participants), `auth` (admin/member, SMTP), `render-publish`/
  `versioning-diff` (extract-text).
- Risk: FTS needs text extracted from HTML/MD — the extraction pipeline lives in publish, not yet pinned (GAP-003).

## Not in Scope

- Multi-workspace / 1 instance → v2.
- Project membership/roles overriding workspace → v0.5.
- Project default share settings → v0.5.
- Tags/labels, activity log/audit, trash+restore → v0.5.
- Favorites/pin, templates → v2.
- Transfer ownership → v0.5.
- Notifications + email → extracted to the `notifications-email` spec (2026-06-20); preferences +
  coalescing + daily digest are deferred to Phase 2 there.

## Gaps

- GAP-001 (status: resolved → AS-012, C-007): removing a member is not blocked; the doc belongs to
  the project/workspace so it stays, access continues per general_access; the share loses its owner, so the admin
  handles it. (Decided 2026-06-07.)
- GAP-002 (status: resolved → moved to `notifications-email`): email notify — resolved for v0 to
  the SIMPLE form (always send, one email per high-signal event, no opt-out, no digest). The
  behaviour, plus its broadening (per-event channel policy, access-filter, deep-links), now lives in
  the `notifications-email` spec (extracted 2026-06-20). Preferences + coalescing + digest stay
  Phase 2 there. (Decided 2026-06-08; relocated 2026-06-20.) Source: "Email notify: allow the user
  to opt out … digest or one per event".
- GAP-003 (status: resolved → AS-015, C-006): the text-extraction pipeline for search — resolved to
  **extract at publish time**, storing plain text on `doc_versions.extracted_text` for every published
  version; search reads the current version's extracted text. (Decided 2026-06-08.) Source:
  "Extracted-text … extract at publish or compute at index time".

## Clarifications — 2026-06-23

- **Doc-access default flipped to `anyone_in_workspace` (shared-workspace model — workspace = shared group
  space):** new docs inherit the workspace's `settings.defaultAccess` (default `anyone_in_workspace`,
  `workspaces`:C-007), not `restricted`. This makes browse the COMMON case "member sees the
  workspace's docs" rather than the rare one. AS-006/AS-009 and C-003 are UNCHANGED — the
  access filter still hides docs the caller genuinely can't access; what changed is that fewer docs
  are out-of-access because the default is now shared, not private. `restricted` remains the
  meaningful per-doc opt-in for a private doc (the "keeping restricted meaningful" intent below is
  reinforced, not retired). The default itself lives in `workspaces` + the publish specs; this
  spec only consumes access.

## Clarifications — 2026-06-07

- **Single workspace:** locked by the design doc; avoid tenancy/switcher in v0.
- **Browse by doc-access (not project membership):** project roles deferred to
  v0.5, so anchor on doc-sharing, keeping restricted meaningful.
- **Search includes content + comments:** AI docs are text-heavy, searching the title is not enough; Postgres FTS is cheap.
- **Notify on both channels:** people sent a link rarely open the app → email is needed to close the feedback
  loop. SMTP is already mandatory (auth cluster), so it can always send.

## Spec Sizing Notes

Stories=6 (under target, after S-006 notify moved to `notifications-email` 2026-06-20).
AS=21 (target 20, 1 over — in G7 overage range ≤30).

The over-target AS are both browse-row field producers on S-003, each one stated atom (a field served
on the browse row), not bloat:
- AS-021 — the row carries `general_access` (producer for workspace-project-ui:S-006 AccessIndicator).
- AS-022 — the row carries `created_at` + `updated_at` (producer for workspace-project-browse:S-003 sort).
Re-merging either into AS-006 would mix the access-filter behaviour with the field-serving promise.

No bloat — each AS traces to one stated atom.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/workspace-project.md) | -- |
| 2026-06-07 | GAP-001 resolved → AS-012 + C-007 (removing a member does not lose docs) | -- |
| 2026-06-07 | Copy doc brought back into v0 → AS-013 + C-008 (no trimmed copy) | -- |
| 2026-06-07 | AS-014 + C-009 (default project per account, for mcp-roundtrip) | -- |
| 2026-06-07 | /mf-challenge harden H2: C-003 + AS-009 (search does not leak comment snippet of out-of-access docs + existence) | -- |
| 2026-06-07 | + ## UI Notes (Component Tree from explore §UI sketches) — Minor | -- |
| 2026-06-08 | GAP-003 resolved → AS-015 + C-006 (publish-time extraction into doc_versions.extracted_text) — Minor | -- |
| 2026-06-08 | GAP-002 resolved → MVP always-send-per-event (AS-011/C-004); preference+coalescing+digest deferred to TODO.md — Minor | -- |
| 2026-06-18 | Browse/search pagination producer (Major, M1+M6, snapshot 2026-06-18-be-pagination): + S-007 (doc-browse · projects-list · search return one bounded page + a total/has-more summary, page size 20, pagination AFTER access filter — AS-016..020); + C-010; Linked Fields += page-summary producer ↔ workspace-project-ui:S-008 (resolves workspace-project-ui:GAP-004). Source: docs/explore/browse-pagination.md. | -- |
| 2026-06-19 | Browse row carries created/updated times (Major, M1-style producer contract, snapshot 2026-06-18-be-row-timestamps): + AS-022 under S-003 (the browse doc row serves `created_at` + `updated_at`); Data Model note; Linked Fields += timestamps producer ↔ workspace-project-browse:S-003 sort, resolving workspace-project-browse:GAP-002. Producer for the doc-browse Updated/Created sort. | -- |
| 2026-06-18 | Linked Field re-pin (Minor): the page-summary consumer (workspace-project-ui:S-008, C-008) reads it in TWO modes — search per-page (server nav), doc-browse + projects-list via `hasNext` page-through (client-side union, no per-project/workspace doc endpoint). Producer contract unchanged. | -- |
| 2026-06-18 | Browse row carries general_access (Major, M1-style producer contract, snapshot 2026-06-18-be-browse-access): + AS-021 under S-003 (the browse doc row serves the doc's general access level: restricted / anyone_in_workspace / anyone_with_link); Data Model note; Linked Fields += `generalAccess` producer ↔ workspace-project-ui:S-006 (AS-018), resolving workspace-project-ui:GAP-002. Producer for the deferred FE AccessIndicator (S-006). | -- |
| 2026-06-20 | Notify + email extracted to the new `notifications-email` spec (Major, M2+M6, snapshot 2026-06-20): − S-006 "Notify on reply" + AS-011; C-004 retired to a tombstone; notifications table + NotificationCenter UI + GAP-002 + Not-in-Scope line repointed to `notifications-email`; Linked Field "thread participants + doc owner" now consumed by notifications-email:S-002. Stories 7→6, AS 22→21. | -- |
| 2026-06-21 | Major (M1+M6, snapshot 2026-06-21-workspace-docs-endpoint): + S-008 (P1) — a single workspace-wide docs read `GET /api/w/:id/docs` returns the accessible-doc union (joined to project name) + per-project counts + workspace total in ONE request, paginated (consumer requests its grid page size, cap 100), access-filtered before paging/counting. Retires the FE N+1 fan-out in `useWorkspaceDocs` (was 1 projects read + 1 per project) — the all-docs grid pages against this read 1:1. AS-023..027. C-010 widened to cover the workspace-docs read + a consumer-requested page size (cap 100); binds C-003 + C-010. Snapshot limit set to 12 (prior runs retained 9). Source: the /w/:id/docs Network storm. | -- |
| 2026-06-21 | Minor: S-008 AS-024 corrected — the workspace-docs read carries the active-project list as {id, name} only (move/copy target picker + project-count stat), NOT a per-project doc count. The earlier "per-project docCount from the one read" was unused — no consumer of useWorkspaceDocs renders per-project doc counts (the Projects browser shows those via useProjectsBrowse, a separate read). S-008 desc/files/verify + AS-026 reworded to drop the per-project-count obligation. No AS added/removed; P1 Then change → Minor. | -- |
| 2026-06-21 | Major (M-new-AS, snapshot 2026-06-21-projects-list-count): + AS-028 on S-003 — the projects-list read (`GET …/projects`) carries each project's accessible-doc count in ONE query (group-by after the C-003 access filter), so the Projects browser renders the per-project "N docs" badge without a follow-up read. Retires the `useProjectsBrowse` per-project fan-out (was 1 projects read + 1 `docs?limit=1` per project). S-003 binds C-003 (count is access-filtered) + Execution.files made concrete; C-003 coverage += AS-028. Source: the /w/:id/projects Network storm. | -- |
| 2026-06-23 | Minor — doc-access shared-workspace model (workspace = shared group space): Data Model note + Clarifications-2026-06-23 record that a new doc's `general_access` defaults to the workspace's `settings.defaultAccess` (=`anyone_in_workspace`, `workspaces`:C-007), not `restricted`, so browse's common case is "member sees the workspace's docs". No AS/constraint behaviour change — C-003 + AS-006/009 filter is unchanged (fewer docs are out-of-access). Framing/reference only → Minor, no snapshot. | doc-access audit 2026-06-23 |
