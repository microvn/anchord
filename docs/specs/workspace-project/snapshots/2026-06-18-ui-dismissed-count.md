# Spec: workspace-project-ui

**Created:** 2026-06-10
**Last updated:** 2026-06-18
**Status:** Draft

## Overview

The frontend for the workspace-project cluster — the consumer side of `workspace-project`
(backend). The backend ships projects (create/rename/archive/unarchive/delete), doc move/copy,
project-scoped search, and reply notifications, but several have **no UI** yet: project
management controls, doc move/copy, a project picker on publish, search scoping, and the
in-app notification center. This spec covers exactly those missing surfaces. Browse, create-
project, whole-workspace search, and the doc grid/list already exist (see What Already Exists)
and are out of scope here.

Builds on `web-core` (shell, router, typed client) and the active-workspace context from
`workspaces-ui` (every call is path-scoped `/api/w/:workspaceId/…` and TanStack-Query-keyed by
`workspaceId`). Design source: the Anchord-Design prototype (canonical where it exists).

## Data Model

No persistent data — a client. Reads/writes the workspace-project backend over the Eden typed
client and re-reads workspace-keyed queries. Client state is per-dialog (move/copy target,
rename draft, notification open/unread).

## Stories

### S-001: Move or copy a doc between projects (P1)

**Description:** As someone with access to a doc, I open its "more" menu and move it to another
project, or copy it (a clean duplicate), choosing the destination from the projects in this
workspace.
**Source:** workspace-project:S-004 (AS-008 move, AS-013 copy); audit gap-list A.4/A.5 (endpoints exist, no UI). Prototype: `MoveCopyDialog` (P10), `DocCard` kebab `onMore`.

**Execution:**
- `depends_on:` none (builds on the existing doc grid/list + Eden client)
- `parallel_safe:` false (adds `moveDoc`/`copyDoc` to the shared `features/docs/client.ts` + a kebab on the shared `doc-card`/`doc-list`)
- `files:` `apps/web/src/features/docs/{client.ts,doc-card.tsx,doc-list.tsx}`, new `apps/web/src/features/docs/move-copy-dialog.tsx`
- `autonomous:` true
- `verify:` open a doc's ⋯ menu → Move → pick another project → the doc appears under the target project; Copy → a new doc is created in the target, the original stays.

**Acceptance Scenarios:**

AS-001: Move a doc to another project
- **Given:** doc "Auth Spec" is in project "Billing"; this workspace also has project "Payments"
- **When:** I open the doc's ⋯ menu, choose Move, pick "Payments", and confirm Move
- **Then:** the doc now shows under "Payments" (its project label updates) and is no longer under "Billing"
- **Data:** Billing → Payments

AS-002: Copy a doc to another project
- **Given:** doc "Auth Spec" is in project "Billing"
- **When:** I open the doc's ⋯ menu, choose Copy, pick "Payments", and confirm Copy
- **Then:** a new doc is created under "Payments" and the original "Auth Spec" stays in "Billing" unchanged
- **Data:** copy Billing → Payments

### S-002: Manage a project — rename, archive, delete (P1)

**Description:** As a member, I rename a project, archive/unarchive it, and delete an empty
project, from a per-project "more" menu; the default project is protected and destructive
actions ask for confirmation.
**Source:** workspace-project:S-003 (create/rename/archive/delete; AS-007 archive); audit gap-list A.1/A.2/A.3 (endpoints exist, no UI). No prototype for these controls — designed consistent with the system (see UI Notes, flagged in Clarifications).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false (adds project mutations to the shared `features/docs/client.ts` + controls on `projects-screen.tsx`)
- `files:` `apps/web/src/features/docs/{client.ts,projects-screen.tsx,use-docs.ts}`, new `apps/web/src/features/docs/rename-project-dialog.tsx`; reuses `components/confirm-dialog.tsx`, `components/ui/{dropdown-menu,select}.tsx`
- `autonomous:` true
- `verify:` a project's ⋯ menu offers Rename/Archive/Delete; rename updates the name; archive removes it from the default browse and a "Show archived" toggle brings it back to unarchive; deleting an empty project (after confirm) removes it; the default project offers no delete.

**Acceptance Scenarios:**

AS-003: Rename a project
- **Given:** a project named "Billing"
- **When:** I open its ⋯ menu, choose Rename, enter "Payments Ops", and save
- **Then:** the project shows as "Payments Ops" in the projects browse
- **Data:** "Billing" → "Payments Ops"

AS-004: Archive a project hides it from the default browse
- **Given:** an active project "Old Specs"
- **When:** I archive it from its ⋯ menu
- **Then:** "Old Specs" disappears from the default projects browse
- **Data:** archive "Old Specs"

AS-005: Unarchive a project from the archived view
- **Given:** "Old Specs" is archived
- **When:** I turn on "Show archived" and choose Unarchive on it
- **Then:** "Old Specs" appears again in the default browse
- **Data:** unarchive "Old Specs"

AS-006: Delete an empty project after confirming
- **Given:** an empty project "Scratch" (no docs)
- **When:** I choose Delete from its ⋯ menu and confirm in the dialog
- **Then:** "Scratch" is removed from the projects browse
- **Data:** empty project "Scratch"

AS-007: The default project offers no delete, and a non-empty delete is refused
- **Given:** the auto-created default project (and a non-empty project "Billing")
- **When:** I open the default project's ⋯ menu / try to delete "Billing"
- **Then:** the default project shows no Delete control; deleting "Billing" is refused with a reason (it still has docs) and the project stays
- **Data:** default project + non-empty "Billing"

### S-003: Publish a doc into a chosen project (P1)

**Description:** As someone publishing a doc, I pick which project it lands in (defaulting to my
default project) instead of always the default.
**Source:** workspace-project:AS-005 (publish into a project); render-publish publish accepts `projectId`; audit gap-list A.6 (route accepts `projectId`, FE never sets it). Prototype `NewDocDialog` currently hardcodes "the default project" — picker designed (flagged).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false (edits the shared `new-doc-dialog.tsx`)
- `files:` `apps/web/src/features/docs/new-doc-dialog.tsx`, `apps/web/src/features/docs/client.ts` (already accepts `projectId`); reuses `components/ui/select.tsx`
- `autonomous:` true
- `verify:` the New-doc dialog shows a project picker defaulting to the default project; publishing into a chosen non-default project lands the doc there.

**Acceptance Scenarios:**

AS-008: Publish into a chosen non-default project
- **Given:** the New-doc dialog with content ready and this workspace has projects "Default" and "Billing"
- **When:** I select "Billing" as the project and publish
- **Then:** the new doc is created in "Billing"
- **Data:** publish into "Billing"

AS-009: The default project is pre-selected
- **Given:** the New-doc dialog is opened
- **When:** I do not change the project and publish
- **Then:** the doc lands in my default project (the picker defaulted to it)
- **Data:** publish without changing the picker

### S-004: Scope search to the current project (P1)

**Description:** As a user inside a project, I can scope a search to that project instead of the
whole workspace, and switch back to whole-workspace.
**Source:** workspace-project:AS-010 (search scoped to a project); `searchDocs` already accepts `projectId`; audit gap-list A.7 (no scope UI). No prototype scope control — designed (flagged).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false (edits the shared `search-screen.tsx` + `use-docs.ts` search hook)
- `files:` `apps/web/src/features/docs/{search-screen.tsx,use-docs.ts,client.ts}`
- `autonomous:` true
- `verify:` searching while a project scope is selected returns only that project's accessible docs; clearing the scope broadens to the whole workspace.

**Acceptance Scenarios:**

AS-010: Search scoped to a single project
- **Given:** I am searching with the scope set to project "Billing"; "invoice" matches a doc in "Billing" and a doc in "Payments" I can access
- **When:** I search "invoice"
- **Then:** only the matching "Billing" doc is returned
- **Data:** scope = "Billing"

AS-011: Switching scope to the whole workspace broadens results
- **Given:** the same search "invoice" while scoped to "Billing"
- **When:** I switch the scope to the whole workspace
- **Then:** matching accessible docs from all projects are returned (including the "Payments" one)
- **Data:** scope = whole workspace

### S-005: In-app notification center (P0)

**Description:** As a user, I see a bell with an unread count, open a panel listing my
notifications (who did what, on which doc, when), click one to mark it read and open its target,
and clear all with "Mark all read".
**Source:** workspace-project:S-006 (AS-011 reply notifies in-app); audit gap-list B.8 (rows written, no read endpoint, bell/activity are placeholders). Prototype: `NotificationsMenu` (shell.jsx) — canonical. **Backend producer for reading notifications does not yet exist (GAP-001).**

**Execution:**
- `depends_on:` none
- `parallel_safe:` false (replaces the placeholder bell in the shared `app-header.tsx` + wires `activity-screen.tsx`)
- `files:` `apps/web/src/app/app-header.tsx`, `apps/web/src/features/docs/activity-screen.tsx`, new `apps/web/src/features/notifications/{notifications-menu.tsx,client.ts,use-notifications.ts}`
- `autonomous:` true
- `verify:` the bell shows the unread count; opening lists notifications newest-first; clicking one marks it read and navigates to its doc; "Mark all read" zeroes the count; with none, an empty state shows.
- **BLOCKED until GAP-001:** needs backend `GET /api/w/:workspaceId/notifications` (+ mark-read / mark-all-read). Add it to `workspace-project.md` (Mode C) before building.

**Acceptance Scenarios:**

AS-012: The bell shows the unread count
- **Given:** I have 2 unread notifications
- **When:** the app loads
- **Then:** the bell shows a "2" unread badge
- **Data:** 2 unread

AS-013: Opening the panel lists notifications newest-first
- **Given:** I have notifications from a reply and a publish
- **When:** I open the bell
- **Then:** I see each as "who · action · target · time", most recent first
- **Data:** 1 reply + 1 publish notification

AS-014: Clicking a notification marks it read and opens its target
- **Given:** an unread notification about a reply on "Auth Spec"
- **When:** I click it
- **Then:** it is marked read (unread count drops by one) and the app opens "Auth Spec"
- **Data:** reply notification → doc "Auth Spec"

AS-015: Mark all read clears the unread count
- **Given:** I have 2 unread notifications
- **When:** I choose "Mark all read"
- **Then:** the unread badge disappears and all items show as read
- **Data:** 2 unread → 0

AS-016: Empty state when there are no notifications
- **Given:** I have no notifications
- **When:** I open the bell
- **Then:** I see a "You're all caught up" empty state and no unread badge
- **Data:** 0 notifications

AS-017: A failed notifications load does not break the bell
- **Given:** the notifications request fails
- **When:** I open the bell
- **Then:** the panel shows an error/retry (or quiet empty), the bell is still usable, and no count is faked
- **Data:** load error

### S-006: Show a doc's access on its card (P2)

**Description:** As a user browsing docs, each doc card shows an access indicator (Restricted /
Workspace / Link) so I can tell at a glance who can see it.
**Source:** Prototype `AccessIndicator` (browser.jsx) + spec UI Notes (DocCard). audit gap-list C.9. **The browse/list payload does not yet carry the access level (GAP-002).**

**Execution:**
- `depends_on:` none
- `parallel_safe:` false (edits shared `doc-bits.tsx`/`doc-card.tsx` + the `DocRow` type)
- `files:` `apps/web/src/features/docs/{doc-bits.tsx,doc-card.tsx,types.ts}`
- `autonomous:` true
- **BLOCKED until GAP-002:** the doc-list payload must include `generalAccess`; produced by `sharing-permissions`/`workspace-project` browse.

**Acceptance Scenarios:**

AS-018: The card's access indicator reflects the doc's general access
- **Given:** a doc shared anyone-in-workspace, and another that is restricted
- **When:** I view them in the browse grid
- **Then:** the first shows a "Workspace" indicator and the second shows "Restricted" (matching `general_access`)
- **Data:** one anyone_in_workspace doc + one restricted doc

### S-007: Dashboard counts annotations, not comments (P1)

**Description:** As a user scanning the workspace, the per-doc count and the workspace overview tile
show how many ANNOTATIONS a doc/workspace has — the unit that matters for a review tool — not the raw
comment total. Today both show a comment count (every comment across the doc's annotation threads) with
an envelope icon, which over-counts (one annotation can hold many comments) and mislabels the activity.
**Source:** dogfood feedback (2026-06-17) — "số icon phong bì nên đổi icon dạng annotations, và count
total [annotations] mới đúng" + "tổng số comments là k đúng, tổng số annotations mới đúng" (workspace
overview tile). The count metric was built (repo `commentCount`, doc-bits, workspace-home tile) without
a behaviour AS — this story specs it.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/backend/src/workspace/repo.ts` (count active annotations, not comments) + `apps/backend/src/routes/projects.ts` (row field rename), `apps/web/src/features/docs/types/index.ts` + `apps/web/src/features/docs/components/doc-bits.tsx` (AnnotationCount + annotation icon), `apps/web/src/features/workspaces/components/workspace-home.tsx` (the overview tile: label "Annotations" + sum the per-doc annotation count)
- `autonomous:` true
- `verify:` open the workspace home → a doc with 3 annotations (one carrying several replies) shows "3" beside an annotation icon (not the higher comment total); the overview tile reads "Annotations" and equals the sum across docs.

**Acceptance Scenarios:**

AS-019: A doc row shows its active-annotation count with an annotation icon
- **Given:** a doc with 3 active annotations, one of which has 4 reply comments (7 comments total)
- **When:** I view the doc in the workspace browse grid
- **Then:** the row shows "3" (the active-annotation count) beside an annotation icon — NOT "7" and not an
  envelope/comment icon; a soft-deleted annotation on the doc is not counted
- **Data:** 3 active annotations (+1 soft-deleted), 7 comments total → row reads 3

AS-020: The workspace overview tile counts annotations across the workspace
- **Given:** a workspace whose docs hold 12 active annotations in total
- **When:** I open the workspace home
- **Then:** the overview tile is labelled "Annotations" and shows 12 — the sum of the docs' active-annotation
  counts — not a "Comments" total
- **Data:** docs summing to 12 active annotations

### S-008: Paginate the browse lists (P1)

**Description:** As a user browsing a large workspace, the three lists that grow without bound — the
docs inside a project, the projects list, and search results — show one page at a time with numbered
navigation (Prev/Next + page numbers) instead of one ever-growing scroll, so the page stays fast and
my position is predictable.
**Source:** docs/explore/browse-pagination.md#Feature ("Add numbered pagination … to the three
browse lists that currently return their full set unpaginated: docs within a project, the projects
list, and search results"); decision 2026-06-18 (numbered pages, page size 20, search included).
The backend already has the pagination helper but these list endpoints don't use it (consumer side
here; the producer change is pinned to `workspace-project` via GAP-004).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/web/src/features/docs/components/{docs-screen.tsx,projects-screen.tsx,search-screen.tsx}`, a shared `apps/web/src/components/pagination.tsx` (the numbered control), `apps/web/src/features/docs/hooks/use-docs.ts` + `apps/web/src/features/docs/services/client.ts` (pass page/limit, read the `pagination` block; aggregation hooks page through `hasNext`)
- `autonomous:` true
- `verify:` open a project with more than 20 accessible docs → it shows the first 20 with a numbered control; clicking a later page shows that page's docs; the projects screen and a search returning >20 matches paginate the same way; a list that fits one page shows no control.
- **Mechanism (C-008):** search paginates SERVER-side (consumes the producer's page summary per page); a project's docs and the projects list paginate CLIENT-side over the complete access-filtered set — there is no per-project / workspace-wide doc endpoint to server-page, so the FE pages through `pagination.hasNext` to assemble the complete set, then slices it client-side at page size 20.

**Acceptance Scenarios:**

AS-021: A project's doc list shows one page with numbered navigation
- **Given:** a project with 45 docs I can access, page size 20
- **When:** I open the project
- **Then:** the doc list shows the first 20 docs and a numbered pagination control (Previous/Next plus page numbers) reflecting 3 pages
- **Data:** 45 accessible docs, page size 20

AS-022: Navigating to the last page shows its docs and disables Next
- **Given:** the project doc list open on page 1 of 3 (45 docs)
- **When:** I go to page 3
- **Then:** the list shows docs 41–45 and the Next control is disabled (no page beyond the last)
- **Data:** click page 3 of 3

AS-023: A list that fits one page shows no pagination control
- **Given:** a project with 7 docs I can access, page size 20
- **When:** I open the project
- **Then:** all 7 docs show and no pagination control is rendered
- **Data:** 7 accessible docs (≤ one page)

AS-024: The projects list paginates the same way
- **Given:** a workspace with 30 projects, page size 20
- **When:** I open the projects screen
- **Then:** the screen shows the first 20 projects with a numbered pagination control; going to page 2 shows the remaining 10
- **Data:** 30 projects, page size 20

AS-025: Search results paginate the same way
- **Given:** a search whose accessible matches number 28, page size 20
- **When:** I run the search and go to page 2
- **Then:** the first page showed 20 results with a numbered control and page 2 shows the remaining 8
- **Data:** 28 accessible matches, page size 20

AS-026: Pagination counts only items the user can access
- **Given:** a project holding 40 docs of which I can access 22, page size 20
- **When:** I open the project
- **Then:** the pagination reflects 2 pages (based on the 22 accessible docs), never 40 — docs I cannot access are not counted into the page total
- **Data:** 40 docs, 22 accessible

## Constraints & Invariants

- C-001: Destructive actions in this cluster (delete a project) show a confirmation dialog and
  only mutate on explicit confirm; cancelling leaves state unchanged. (AS-006, AS-007)
- C-002: The auto-created default project cannot be deleted (no Delete control); a non-empty
  project cannot be deleted (refused with a reason). The backend also enforces both. (AS-007)
- C-003: Move/copy destinations and the publish project picker offer ONLY projects in the active
  workspace; nothing crosses a workspace boundary. (AS-001, AS-002, AS-008)
- C-004: The unread badge equals the number of unread notifications; opening a notification or
  "Mark all read" reduces it; no count is faked when the read endpoint is unavailable. (AS-012, AS-014, AS-015, AS-017)
- C-005: Every screen uses the DESIGN.md dark-operator system (teal-only accent) and is
  responsive (dialogs/menus reflow on tablet/mobile; tap targets ≥40px). (AS-001, AS-013; responsive/pixel visual is [→MANUAL], inheriting web-core's shell + tokens)
- C-006: The dashboard's count metric is the doc's ACTIVE annotation count (annotations whose delete
  tombstone is unset — soft-deleted ones excluded), NOT a comment count. The per-doc browse row and the
  workspace overview tile use this one number; both show annotation iconography/label ("Annotations"),
  never a comment/envelope. (AS-019, AS-020)
- C-007: The three browse lists — a project's docs, the projects list, and search results — are
  paginated at a fixed page size of 20 with numbered navigation (Previous/Next + page numbers). Access
  filtering is applied BEFORE pagination, so the page count and totals reflect ONLY items the caller can
  access (hidden items are never counted into pages). A list that fits within one page shows no
  pagination control. (AS-021, AS-022, AS-023, AS-024, AS-025, AS-026)
- C-008: Pagination is SERVER-side for search only; a project's docs and the projects list paginate
  CLIENT-side. anchord has no per-project doc endpoint and no workspace-wide doc endpoint, so the
  "project's doc list" browse is a workspace-wide union the FE assembles by paging through
  `pagination.hasNext` over the complete access-filtered set, then slicing at page size 20 in the
  client; the projects list does the same. Search uses the producer's server-side page summary
  directly. The page total still reflects only accessible items (the complete set is access-filtered
  upstream), so AS-026 holds regardless of where the slice is taken. The aggregation reads (sidebar /
  workspace-home counts, the workspace doc union) likewise page through `hasNext` to keep the COMPLETE
  set — the producer's default page size of 20 must never silently shrink a count or a full list. (AS-021, AS-026)

## Linked Fields

workspace-project-ui is the **consumer**; `workspace-project` (backend) is the producer.

- move / copy a doc — consumed by S-001; produced by `workspace-project:S-004` (AS-008 move, AS-013 copy) on the `/docs/:slug/move` + `/copy` endpoints. ✔.
- rename / archive / unarchive / delete project — consumed by S-002; produced by `workspace-project:S-003` projects routes (rename PATCH, archive/unarchive, delete-with-guards). ✔.
- publish `projectId` — consumed by S-003; produced by the publish endpoint (`render-publish`/`workspace-project`), which already accepts `projectId`. ✔.
- search `projectId` — consumed by S-004; produced by `workspace-project:AS-010` search endpoint (accepts `projectId`). ✔.
- notifications list + mark-read — consumed by S-005 on the bell (read on app load + open) and the activity feed. **Producer MISSING** — no `GET /notifications` or mark-read endpoint exists. ✘ → GAP-001.
- doc `generalAccess` on browse/list rows — consumed by S-006 (AccessIndicator on the browse grid). Produced by the browse/list payload (`workspace-project`/`sharing-permissions`), which does **not** currently include the field. ✘ → GAP-002.
- `pagination` envelope `{page, limit, total, totalPages, hasNext, hasPrevious}` on the three list reads — consumed by S-008 alongside the retained domain key (`docs` / `projects` / `results`). Two consumption modes (C-008): SEARCH reads the summary per page (server-side numbered nav); a project's DOCS and the PROJECTS list read `hasNext` to page through to the COMPLETE access-filtered set, then paginate client-side (no per-project / workspace-wide doc endpoint to server-page). Produced by `workspace-project`:S-007 (AS-016..020, C-010) on each list response. ✔ resolved — producer landed (commit 7b09362); the page summary is served on every list read, which satisfies both the per-page (search) and page-through-to-complete (docs/projects + aggregation hooks) consumers.

## UI Notes

Design source: the Anchord-Design prototype. Precedence: AS / Constraints > Prototype > this Tree.
Canonical prototype components are reused 1:1; the three surfaces with no prototype are designed
consistent with the system and flagged in Clarifications.

Build targets `[N]`:
- `MoveCopyDialog` `[N]` *(1:1 with prototype dialogs2.jsx P10)* — Move|Copy toggle (`fmt-toggle`) · `ProjectSelectList` (destination projects, Default badge + check on the selected) · helper line ("The doc leaves its current project." / "A duplicate is created; the original stays put.")
  - opened from `DocCardMoreMenu` `[N]` — a `⋯` button on `DocCard`/`DocList` rows → Move / Copy items
- `RenameProjectDialog` `[N]` *(mirrors the existing RenameField/RenameWorkspace dialog)* — name input + Save
- `ProjectCardMoreMenu` `[N]` — a `⋯` on each `proj-card` → Rename · Archive/Unarchive · Delete *(Delete hidden on the default project per C-002; Delete opens `ConfirmDialog`)*
- `ProjectsArchivedToggle` `[N]` — a "Show archived" control on the Projects screen surfacing archived projects with an Unarchive action
- `NewDocProjectPicker` `[N]` — a project `Select` inside `NewDocDialog`, defaulted to the default project *(replaces the hardcoded "into the default project")*
- `SearchScopeControl` `[N]` — a scope toggle on the search screen: "All workspace" | "In <project>"
- `NotificationsMenu` `[N]` *(1:1 with prototype shell.jsx)* — bell + unread count pill · panel (340px): header "Notifications" + "Mark all read" · `NotificationItem` (avatar · "who action target" · time · unread dot) · empty "You're all caught up." · footer "View all notifications" (→ activity feed)
- `ActivityFeed` `[N]` — the `/w/:id/activity` screen wired to the same notifications source (full list)
- `AccessIndicator` `[N]` *(1:1 with prototype browser.jsx)* — icon + label per `general_access` (Restricted / Workspace / Link) on `DocCard`

> Prototype URL/source: `Anchord-Design/{dialogs2.jsx,shell.jsx,browser.jsx}` (canonical on conflict for the components it defines).

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| `ProjectsScreen` (browse + create) | `apps/web/src/features/docs/projects-screen.tsx` | reuse; add `ProjectCardMoreMenu` + archived toggle (S-002) |
| `DocsScreen` / `DocGrid` / `DocList` | `apps/web/src/features/docs/{docs-screen,doc-list}.tsx` | reuse; add `⋯` more-menu to cards/rows (S-001) |
| `DocCard` + `doc-bits` (FormatBadge/VersionTag/AnnotationCount/StatusTag) | `apps/web/src/features/docs/{doc-card,doc-bits}.tsx` | reuse; add `AccessIndicator` (S-006); rename `CommentCount`→`AnnotationCount` + annotation icon (S-007) |
| `NewDocDialog` | `apps/web/src/features/docs/new-doc-dialog.tsx` | reuse; add `NewDocProjectPicker` (S-003) |
| `SearchScreen` (whole-workspace search) | `apps/web/src/features/docs/search-screen.tsx` | reuse; add `SearchScopeControl` (S-004) |
| `app-header` notifications bell (placeholder) | `apps/web/src/app/app-header.tsx` | replace placeholder with `NotificationsMenu` (S-005) |
| `activity-screen` (placeholder empty) | `apps/web/src/features/docs/activity-screen.tsx` | wire to notifications source (S-005) |
| `ConfirmDialog` | `apps/web/src/components/confirm-dialog.tsx` | reuse for delete-project confirm (S-002) |
| `Select`, `DropdownMenu`, `Dialog` | `apps/web/src/components/ui/{select,dropdown-menu,dialog}.tsx` | reuse for pickers / more-menus / dialogs |
| `client.ts` typed doc/project client | `apps/web/src/features/docs/client.ts` | extend with `renameProject`/`archiveProject`/`unarchiveProject`/`deleteProject`/`moveDoc`/`copyDoc` |

### System Impact & Technical Risks

- Backend for S-001..S-004 already exists and is integration-tested (projects routes, doc-move/copy, project-scoped search). These stories are pure FE wiring to existing endpoints — low risk.
- S-005 has NO backend read endpoint (rows are written by `notifyOnReply` but never readable) → GAP-001 blocks it.
- S-006 needs the browse/list payload to carry the access level, which it currently does not → GAP-002 blocks it.
- The new mutations add to the shared `features/docs/client.ts` and several shared screens, so `parallel_safe: false` across the cluster.

## Not in Scope

- Browse, create-project, whole-workspace search, doc grid/list, GridListToggle, filter chips — already built (see What Already Exists).
- The backend notifications read/mark-read endpoint itself — belongs in `workspace-project.md` (backend), tracked as GAP-001; this spec only consumes it.
- Adding the access field to the browse payload — belongs in `workspace-project`/`sharing-permissions`, tracked as GAP-002.
- Notification preferences / digest / coalescing — deferred post-v0 (workspace-project Not in Scope).
- Transfer doc ownership / admin takeover share UX — workspace-project C-007 (separate, deferred).

## Gaps

- GAP-001 (status: deferred — owner: product, decided 2026-06-10): S-005 needs a backend endpoint
  to LIST a user's notifications and to mark them read (and mark-all-read). The `notifications`
  table is written by `notifyOnReply` but no read endpoint exists. **Deferred:** S-005 is NOT in
  this build pass; add the endpoint to `workspace-project.md` (Mode C) first, then build S-005.
  Source: audit gap-list B.8 ("notifications written but never readable via API").
- GAP-002 (status: deferred — owner: product, decided 2026-06-10): S-006 (AccessIndicator) needs
  the doc browse/list payload to include the doc's `general_access`. `DocRow` does not currently
  carry it. **Deferred:** S-006 is NOT in this build pass; add `generalAccess` to the browse
  payload (`workspace-project`/`sharing-permissions`) first, then build S-006.
  Source: audit gap-list C.9 / FE audit ("DocRow has no access field").
- GAP-003 (status: resolved — decided 2026-06-10): project rename/archive/delete controls, the
  New-doc project picker, and the search-scope control have no prototype; the designed placements
  (more-menu + dialogs + Select, per UI Notes) are ACCEPTED as the build target. Source: Clarifications.
- GAP-004 (status: resolved — workspace-project:S-007, commit 7b09362, 2026-06-18): S-008 needs the three list endpoints (a
  project's docs `GET …/projects/:id/docs`, the projects list, and search `GET /api/search`) to accept
  `page`/`limit` and return a `pagination` envelope alongside their existing domain key, applying
  access filtering before pagination. **Resolved 2026-06-18** → `workspace-project`:S-007 (AS-016..020,
  C-010), commit 7b09362: all three endpoints now serve the page summary. The FE consumes it per-page
  for search and via `hasNext` page-through for docs/projects (C-008). Source: docs/explore/browse-pagination.md#Impact-on-existing-system.

## Clarifications — 2026-06-10

- **Prototype-canonical where it exists.** `MoveCopyDialog`, `NotificationsMenu`, and
  `AccessIndicator` are taken 1:1 from the prototype. The un-prototyped surfaces (project
  rename/archive/delete, New-doc project picker, search-scope) are designed to match the system
  (existing `DropdownMenu`/`ConfirmDialog`/`Select` + the prototype's `proj-select-list`); see GAP-003.
- **Doc ⋯ opens the dialog directly (corrected 2026-06-11).** Matching the prototype, the doc `⋯`
  kebab opens `MoveCopyDialog` directly — the Move|Copy toggle lives INSIDE the dialog; there is NO
  intermediate Move/Copy menu. (An earlier build added a `DropdownMenu` submenu nested in the doc-card
  `<Link>`; Radix portals the menu to `<body>` but React still bubbles its events up the React tree to
  the `<Link>`, so selecting an item navigated instead of opening the dialog. Removed.) The kebab + the
  dialog are wrapped so their clicks never reach the surrounding card `<Link>`.
- **Build sequencing (decided 2026-06-10).** This build pass ships S-001..S-004 (move/copy,
  project management, project picker, search scope) — all backed by existing endpoints. **S-005
  (notifications) and S-006 (access indicator) are DEFERRED** pending their backend producers
  (GAP-001, GAP-002); they remain specced so they're ready once the backend lands. GAP-003's
  designed controls are accepted.

## Clarifications — 2026-06-18

- **Browse pagination is split client/server (C-008), discovered at build time.** The explore + the
  original S-008 implied all three lists server-paginate per page. In code, only SEARCH can — it has a
  real `GET /api/search` endpoint. A project's docs and the projects list have NO per-project /
  workspace-wide doc endpoint that returns a single server-pageable list; the FE synthesises a
  workspace-wide union (paging through `pagination.hasNext` to assemble the complete access-filtered
  set) and paginates it CLIENT-side. The observable behaviour (AS-021..026) is identical either way —
  page 1 shows 20, the control reflects the total page count, the total counts only accessible items.
  The aggregation reads (sidebar/home counts, the workspace doc union) page through `hasNext` for the
  same reason: the producer's default page size of 20 must not silently shrink a count or a full list.
  This is why the producer's server-side pagination on the docs/projects endpoints (workspace-project:
  S-007) is a valid, tested contract that this consumer uses only as a page-through source, not for
  per-page numbered nav.

## Spec Sizing Notes

Stories=8 (target 7, in G7 overage range ≤10). AS=26 (target 20, in G7 overage range ≤30).

G1 splits producing the over-target AS (each AS = one stated atom, no AS gộp):
- S-008 pagination: 6 AS for 6 atoms — docs-list paginates (AS-021), last-page/Next-disabled edge
  (AS-022), single-page no-control edge (AS-023), projects-list surface (AS-024), search surface
  (AS-025), access-before-pagination (AS-026). The three surfaces are distinct producer endpoints
  (separate reads), not variants of one; the two edges and the access rule are distinct assertions.

No bloat — each AS traces to one stated atom.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-10 | Initial creation — FE for workspace-project missing surfaces (move/copy, project mgmt, project picker, search scope, notifications, access indicator) | -- |
| 2026-06-10 | Clarifications resolved: GAP-003 accepted (designed controls); GAP-001 + GAP-002 deferred (S-005/S-006 wait on backend producers); build pass = S-001..S-004 | -- |
| 2026-06-18 | Browse pagination (Major, M1+M6, snapshot 2026-06-18-ui-pagination): + S-008 (numbered pagination, page size 20, on a project's docs · projects list · search — AS-021..026); + C-007 (page size 20, access-filter before pagination, no control when single page); + GAP-004 (backend producer: the 3 list endpoints must accept page/limit + return a `pagination` envelope — plan in workspace-project.md); Linked Fields += `pagination` envelope (domain key kept, not renamed); + Spec Sizing Notes (8 stories / 26 AS, G7 overage). Source: docs/explore/browse-pagination.md. | -- |
| 2026-06-18 | Pagination client/server reconcile (Major, M6, snapshot 2026-06-18-ui-pagination-clientside): + C-008 (search = server-paginated; project docs + projects list = client-side over the complete set, FE pages through `hasNext`; no per-project/workspace doc endpoint; aggregation hooks page through too); S-008 Execution files += `use-docs.ts` + mechanism note, BLOCKED-until removed; GAP-004 → resolved (workspace-project:S-007, commit 7b09362); Linked Field `pagination` re-pinned to the two consumption modes; + Clarifications 2026-06-18. Behaviour (AS-021..026) unchanged. Source: /mf-build S-008 spec signal S3. | -- |
| 2026-06-17 | Mode C (Major, M1+M6, snapshot 2026-06-17-annotation-count): + S-007 (dashboard counts ACTIVE annotations, not comments — AS-019 per-doc row count+annotation icon, AS-020 workspace overview "Annotations" tile) + C-006. Renamed UI Inventory `CommentCount`→`AnnotationCount`. From dogfood feedback; the count metric (repo commentCount, doc-bits, workspace-home tile) was previously unspecced. | -- |
