# Spec: workspace-project

**Created:** 2026-06-07
**Last updated:** 2026-06-18
**Status:** Draft

## Overview

The Workspace → Project → Doc organization layer for v0 single-workspace (the
instance is one workspace). First-run creates the workspace + admin; members
create projects/docs; browse and search filter by doc access; notify on reply
via in-app + email.

## Data Model

- **workspaces**: `id`, `name`, `slug`, `settings` (auth providers, default access,
  branding). Exactly 1 row in v0.
- **workspace_members**: `workspace_id`, `user_id`, `role` (admin | member).
- **projects**: `workspace_id`, `name`, `archived_at`.
- **docs.project_id** (defined in `render-publish`).
- **doc_versions.extracted_text**: plain text extracted from the version's HTML/MD,
  written when each version is published (GAP-003 resolved → publish-time extraction).
  The search index reads the **current** version's `extracted_text`.
- **notifications**: `user_id`, `type`, `ref_id`, `read`, `created_at` (in-app).
- Full-text index on docs (title + text extracted from HTML/MD) + comment bodies.

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
**Source:** docs/explore/workspace-project.md#decisions (item 3 project).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true
- `verify:` create a project, publish a doc into it; another user without access to that doc does not see it in browse.

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

### S-006: Notify on reply (P1)

**Description:** As a thread participant (or doc owner), I am notified when there is a reply.
**Source:** docs/explore/workspace-project.md#decisions (item 5 notify).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (coordinate annotation-core + SMTP)
- `autonomous:` true

**Acceptance Scenarios:**

AS-011: A reply notifies participants + owner via in-app + email
- **Given:** a thread has participants A and B; the doc owner is C
- **When:** A replies in the thread
- **Then:** B and C are notified (in-app + email); the person who replied (A) does not notify themselves
- **Data:** thread {A,B}, owner C

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

## Constraints & Invariants

- C-001: v0 single workspace = instance; first user = admin; later users = member. (AS-001, AS-002)
- C-002: Members create projects/docs; only admins manage settings/members. (AS-003, AS-004, AS-005)
- C-003: Browse and search always filter down to docs the user has access to (no out-of-access
  doc leaked). Search joins with doc-access BEFORE returning: do not return title/content/**comment
  snippet** from out-of-access docs; "no access" and "does not exist" return indistinguishable
  results (avoid existence leak). [harden H2] (AS-006, AS-009)
- C-004: Notify on reply goes to thread participants + doc owner, via in-app + email; the replier does not notify themselves. (AS-011)
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
- C-010: The doc-browse, projects-list, and search reads are paginated at a default page size of 20;
  each response carries the items for the requested page plus a summary of the total count and whether
  further pages exist. Pagination is taken AFTER access filtering (C-003), so the total and page count
  reflect only items the caller can access. The existing item collection key is retained; the page
  summary is additive (the consumer keeps reading the same item key). (AS-016, AS-017, AS-018, AS-019, AS-020)

## Linked Fields

- **doc-access (general_access + invite)** — produced by `sharing-permissions`.
  Consumed by workspace-project:S-003/S-005 (AS-006, AS-009) to filter browse/search.
  ✔ enforcement defined in sharing; this cluster applies it when listing.
- **thread participants + doc owner** — produced by `annotation-core` (thread) +
  doc owner (sharing). Consumed by S-006 (AS-011) to pick notify recipients. ✔.
- **extracted text of a version** — produced by the publish pipeline (`render-publish`/
  `versioning-diff`). Consumed by S-005 (AS-009) to index FTS. ✘ the text-extraction
  pipeline is not yet pinned in the render-publish spec → GAP-003.
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
- `NotificationCenter` `[N]` → `NotificationItem` *(reply / comment / detached; in-app)*

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
- Notification preferences + email coalescing + daily digest → deferred post-v0 (see `TODO.md`);
  v0 sends always, one email per event (GAP-002 resolved to MVP).

## Gaps

- GAP-001 (status: resolved → AS-012, C-007): removing a member is not blocked; the doc belongs to
  the project/workspace so it stays, access continues per general_access; the share loses its owner, so the admin
  handles it. (Decided 2026-06-07.)
- GAP-002 (status: resolved → AS-011, C-004): email notify — resolved for v0 to the SIMPLE form:
  **always send, one email per event, immediately** (no opt-out preference, no digest). This is the
  behaviour S-006 already builds (AS-011 / C-004). The richer design (per-user notification
  preference table + per-recipient email coalescing + daily digest) is captured in `TODO.md` and
  deferred post-v0. (Decided 2026-06-08.) Source: "Email notify: allow the user to opt out … digest or one per event".
- GAP-003 (status: resolved → AS-015, C-006): the text-extraction pipeline for search — resolved to
  **extract at publish time**, storing plain text on `doc_versions.extracted_text` for every published
  version; search reads the current version's extracted text. (Decided 2026-06-08.) Source:
  "Extracted-text … extract at publish or compute at index time".

## Clarifications — 2026-06-07

- **Single workspace:** locked by the design doc; avoid tenancy/switcher in v0.
- **Browse by doc-access (not project membership):** project roles deferred to
  v0.5, so anchor on doc-sharing, keeping restricted meaningful.
- **Search includes content + comments:** AI docs are text-heavy, searching the title is not enough; Postgres FTS is cheap.
- **Notify on both channels:** people sent a link rarely open the app → email is needed to close the feedback
  loop. SMTP is already mandatory (auth cluster), so it can always send.

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
| 2026-06-18 | Linked Field re-pin (Minor): the page-summary consumer (workspace-project-ui:S-008, C-008) reads it in TWO modes — search per-page (server nav), doc-browse + projects-list via `hasNext` page-through (client-side union, no per-project/workspace doc endpoint). Producer contract unchanged. | -- |
