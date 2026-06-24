# Spec: Workspace Activity feed

**Created:** 2026-06-23
**Last updated:** 2026-06-23
**Status:** Draft
**Snapshot limit:** 5

## Overview

A workspace-scoped, append-only event feed: every comment, reply, resolve, publish, restore, share change, invite, member join/removal, workspace rename, project creation, and annotation detach across the workspace, rendered as a day-grouped, filterable stream with a per-event detail page and a stats rail. Built from the `Anchord-Design/activity.jsx` prototype. Lives at `/w/:id/activity` (nav item + placeholder screen already exist). Spec 1 of 2 — the Personal "Your activity" page (`personal.jsx`) is a separate later spec.

Events are recorded best-effort at each mutation site and read back through a workspace-scoped endpoint; what each viewer sees is gated by their workspace role and per-doc access.

## Data Model

- **New entity `activity`** (append-only event log; keep portable — no Postgres-only features, per CLAUDE.md):
  - `id` — snowflake text id (per project id-strategy).
  - `workspaceId` — owning workspace (cascade on workspace delete).
  - `type` — one of the 12 event types (see C-005). A separate enum from `notification_type` (activity is the complete workspace log; notifications are per-recipient).
  - `actorUserId` — the acting account; **nullable** (the System actor and no-account guests have none).
  - `actorName` — denormalized display name (required). **Resolved/passed by each emit site** (the session carries only `userId`, not the name — a cheap per-emit lookup is acceptable under best-effort, C-002); System/guest are hard-coded ("System") or carry the guest name. **Stored and treated as PLAIN TEXT — never rendered as HTML** (F-12 / guest-supplied value defense-in-depth; the FE renders it as escaped text, never `dangerouslySetInnerHTML`).
  - `docId` / `projectId` / `versionId` — nullable targets. **`docId IS NULL` means a genuinely workspace-level event (invite / member / member_removed / workspace_renamed / project) — NOT a deleted doc.** A doc-scoped event KEEPS its `docId` value even after the doc row is deleted (the value is retained, not set-null), so the read-time visibility filter still gates it (F-1); see C-001.
  - `commentId` / `annotationId` — nullable deep-link refs; set-null when the referenced row is deleted so the event row survives (C-001). **`docId` is NOT set-null on doc delete** (that would reclassify the row as workspace-level and leak a `restricted` doc's event to everyone — F-1).
  - `summary` / `target` — the sentence fragments a row renders (plain text, like `actorName`).
  - `meta` — JSON for type-specific fields: `from/to/adds/dels` (publish — note `adds`/`dels` are COMPUTED at emit by splitting the diff; the existing diff service yields only a total `changeCount`, so the emit site counts added vs removed lines itself, F-4), `restored/as` (restore), `count` (detached), `access/role` (share — the NEW access+role only; no before/after needed in v0, F-10), `role/pending` (invite).
  - `createdAt`.
  - Indexes: `(workspaceId, createdAt)` for the feed; `(workspaceId, docId)` for the access-filtered member query and the detail page's "more on this doc".
- **Migration:** one new table + the type enum. No change to existing tables (refs are nullable FKs with set-null). Owned by S-001.

## Stories

### S-001: View the workspace activity feed (P0)

**Description:** As a workspace member, I open `/w/:id/activity` and see the workspace's recent events as a day-grouped, newest-first feed, so I can catch up on what happened without opening each doc.
**Source:** docs/explore/workspace-activity.md#happy-path + #data-impact (append-only `activity` table, paged 20/50, day-grouped).
**Applies Constraints:** C-002, C-004, C-005, C-007

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` apps/backend/src/db/schema.ts (activity table + type enum + migration), apps/backend/src/activity/ (repo + emit helper), apps/backend/src/routes/activity.ts, apps/backend/src/app.ts (mount), apps/backend/src/routes/annotations.ts (emit comment/reply/resolve), apps/web/src/features/activity/ (new feature: services/client.ts, hooks/use-activity.ts, components/activity-screen.tsx + feed + row), apps/web/src/features/docs/components/activity-screen.tsx (retire placeholder; route to new feature)
- `autonomous:` checkpoint
- `verify:` post a comment in a workspace, GET the activity feed for that workspace → the comment event is the newest row; request page 2 → older events, ≤20 per page.

**Acceptance Scenarios:**

AS-001: A comment appears in the feed
- **Given:** a workspace with a doc and no prior activity
- **When:** Devin comments on the doc and Mara opens `/w/:id/activity`
- **Then:** the newest feed row reads that Devin commented on that doc, under Today
- **Data:** doc "Render + publish pipeline RFC"; comment on "§ Sanitization"
- **Setup:** Mara is a workspace admin with access to the doc

AS-002: Feed is grouped by day, newest first
- **Given:** events spanning today, yesterday, and three days ago
- **When:** Mara opens the feed
- **Then:** rows are grouped under day labels (Today / Yesterday / dated), most-recent day first, and newest-first within each day
- **Data:** 6 events across 3 days

AS-003: Feed pages older events
- **Given:** 25 events in the workspace, page size 20
- **When:** Mara loads the feed, then requests the next page
- **Then:** the first page shows the 20 most-recent events and the next page shows the remaining 5 older events
- **Data:** 25 events; default page 20, cap 50

AS-004: Empty state on a fresh workspace
- **Given:** a workspace where no activity has been recorded since the feed shipped
- **When:** Mara opens the feed
- **Then:** an empty state reads "No activity yet" with the message about comments/publishes/version changes
- **Data:** zero activity rows

AS-005: Error state when the feed can't load
- **Given:** the feed request fails
- **When:** Mara opens the feed
- **Then:** an error state with a Retry control is shown (not a blank page)
- **Data:** simulated fetch failure

AS-006: A failed activity write never blocks the real action
- **Given:** activity logging is unavailable
- **When:** Devin posts a comment
- **Then:** the comment is saved successfully; only its activity row is missing from the feed
- **Data:** emit forced to fail post-commit

### S-002: Feed visibility by role and doc access (P0)

**Description:** As a workspace member, I see every workspace-level event plus doc-scoped events on docs I can access — workspace admins see everything — so the feed never leaks content from docs I can't open. Under the shared-group-space model (shared-workspace model), workspace docs default to `anyone_in_workspace`, so a member sees MOST doc events by default; the visibility filter now gates only the minority of docs explicitly set `restricted`.
**Source:** docs/explore/workspace-activity.md#permissions--visibility (admins all / members filtered / workspace-level visible to all / 404 on inaccessible detail); doc-access shared-workspace model (2026-06-23, GAP-002 resolved).
**Applies Constraints:** C-003

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/activity/ (access-filtered query), apps/backend/src/routes/activity.ts, apps/backend/src/sharing/resolve-access.ts (reuse), apps/web/src/features/activity/
- `autonomous:` checkpoint
- `verify:` as a member with no access to doc X, GET the feed → no events on X; GET the detail URL of an event on X → not-found; as an admin → events on X are present.

**Acceptance Scenarios:**

AS-007: Admin sees an event on a doc they don't directly share
- **Given:** a comment event on "Secret roadmap", which admin Mara does not directly share
- **When:** Mara (workspace admin) opens the feed
- **Then:** the comment event on "Secret roadmap" is visible
- **Data:** Mara role = admin; doc "Secret roadmap" restricted

AS-008: Member does not see an event on a doc they can't access
- **Given:** the same comment event on "Secret roadmap", which is explicitly set `restricted` (the opt-in private exception under shared-workspace model — not the `anyone_in_workspace` default)
- **When:** Tom (member with no access to "Secret roadmap") opens the feed
- **Then:** the event is absent from his feed
- **Data:** Tom role = member; "Secret roadmap" general_access = restricted; no per-doc grant for Tom

AS-029: Member sees an event on an anyone_in_workspace doc
- **Given:** a comment event on "Render pipeline RFC", a doc at the workspace-default `anyone_in_workspace` access, and Tom a member of the workspace not separately invited
- **When:** Tom (member) opens the feed
- **Then:** the comment event on "Render pipeline RFC" is visible to him — workspace membership grants the doc's `anyone_in_workspace` access, so its events are in his feed (the common case under shared-workspace model)
- **Data:** Tom role = member; "Render pipeline RFC" general_access = anyone_in_workspace; Tom ∈ workspace

AS-009: Member sees a workspace-level event regardless of doc access
- **Given:** a member-joined event (no doc target)
- **When:** Tom opens the feed
- **Then:** the member-joined event is visible to him
- **Data:** event type member, docId null

AS-010: Member opening a hidden event's detail gets not-found
- **Given:** the comment event on "Secret roadmap" that Tom cannot see
- **When:** Tom navigates directly to that event's detail URL
- **Then:** he gets a not-found result, not a forbidden error (the event's existence is not revealed)
- **Data:** Tom requests the hidden event id directly

AS-030: Access tightened after an event was logged hides it at read time
- **Given:** a comment event on "Roadmap" logged while the doc was `anyone_in_workspace` (Tom, a member, could see it); the doc is then set `restricted` and Tom is not invited
- **When:** Tom reloads the feed (and requests that event's detail URL)
- **Then:** the event is now absent from his feed and its detail returns not-found — visibility is resolved against the doc's CURRENT access at READ time, not frozen at emit time (F-2)
- **Data:** "Roadmap" general_access flips anyone_in_workspace → restricted after the event; Tom ∉ invitees

### S-003: Filter the feed by category (P1)

**Description:** As a viewer, I filter the feed by All / Comments / Versions / Sharing / People with per-category counts, so I can narrow to the kind of activity I care about.
**Source:** docs/explore/workspace-activity.md#business-rules (server-side filtering + counts respect visibility) + #event-categories.
**Applies Constraints:** C-003

**Execution:**
- `depends_on:` S-001, S-002
- `parallel_safe:` false
- `files:` apps/backend/src/activity/ (category filter + counts), apps/backend/src/routes/activity.ts, apps/web/src/features/activity/components/ (filter segment)
- `autonomous:` true
- `verify:` apply the Versions filter → only publish/restore events return; the category counts match the viewer's visible set.

**Acceptance Scenarios:**

AS-011: Filtering to Versions returns only version events
- **Given:** a feed containing comments, publishes, restores, and shares
- **When:** the viewer selects the Versions filter
- **Then:** only publish and restore events are returned
- **Data:** Comments=comment/reply/resolve; Versions=publish/restore

AS-012: Category counts reflect only the viewer's visible set
- **Given:** a member who cannot see events on one restricted doc
- **When:** the member views the filter counts
- **Then:** each category count excludes events on docs the member can't access
- **Data:** Tom (member); one restricted doc with 3 comment events

AS-013: A filter with no visible matches shows the no-results state
- **Given:** a feed with no Sharing events visible to the viewer
- **When:** the viewer selects the Sharing filter
- **Then:** a no-results state with a Clear control is shown, returning to All on clear
- **Data:** zero visible share events

### S-004: Open an event's detail page (P1)

**Description:** As a viewer, I click a feed row to open its detail — metadata, a publish diff, related events on the same doc, and an "Open doc" link — so I can act on a single event without leaving Activity.
**Source:** docs/explore/workspace-activity.md#happy-path (detail page, diff-mini reuses versioning-diff) + #business-rules ("Open doc" deep-link, append-only degrade).
**Applies Constraints:** C-001

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/routes/activity.ts (single-event read + related), apps/backend/src/activity/, apps/web/src/features/activity/components/ (detail page), reuse versioning-diff for the diff render, reuse the viewer anchor deep-link
- `autonomous:` true
- `verify:` open a publish event's detail → a real source diff renders; open a comment event's "Open doc" → the viewer scrolls to that annotation.

**Acceptance Scenarios:**

AS-014: Detail shows the event's metadata
- **Given:** a publish event by Devin on a doc
- **When:** the viewer clicks the row
- **Then:** the detail page shows actor, document, project, version, and when
- **Data:** event = publish v4 by Devin, project web-core

AS-015: A publish event's detail shows a real source diff
- **Given:** a publish event from v3 to v4
- **When:** the viewer opens its detail
- **Then:** a source line-diff for v3→v4 is shown (reusing the existing version diff), with the add/remove counts
- **Data:** v3→v4, +5/−2

AS-016: "Open doc" jumps to the exact annotation
- **Given:** a comment event on "§ Sanitization" whose anchor still resolves
- **When:** the viewer clicks "Open doc"
- **Then:** the doc opens scrolled to that annotation
- **Data:** annotation on "§ Sanitization"

AS-017: "Open doc" falls back to the top when the anchor detached
- **Given:** a comment event whose annotation has since detached
- **When:** the viewer clicks "Open doc"
- **Then:** the doc opens at the top rather than failing
- **Data:** detached annotation

AS-018: An event with a deleted target still renders, degrades gracefully, and does not leak
- **Given:** a comment event whose comment and doc were later deleted
- **When:** an admin opens its detail, and a member who could not access that doc views the feed
- **Then:** for the admin the event still renders from its stored fields and "Open doc" degrades without error; the deleted doc's `docId` is retained (not nulled), so the event is NOT reclassified as workspace-level and stays hidden from the member who lacked access (F-1)
- **Data:** activity row intact with its original `docId`; referenced comment/doc removed

### S-005: Version publish, restore, and detachment events (P1)

**Description:** As a viewer, I see version-lifecycle activity — a publish, a restore (distinct from a plain publish), and a detachment when re-anchoring fails — so the feed reflects what happened to a doc's versions.
**Source:** docs/explore/workspace-activity.md#event-types (publish/restore/detached; restore + re-anchor hooks confirmed in versions.ts).
**Applies Constraints:** C-005

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/routes/versions.ts (emit on publish, restore, and the re-anchor detached summary), apps/backend/src/activity/ (emit helper)
- `autonomous:` true
- `verify:` publish a version → publish event; restore an older version → restore event (not publish); publish a version that detaches annotations → a System detached event with the count.

> **Emit-site notes (from challenge):**
> - **Restore ≠ publish (F-3 / C-005).** `restoreVersion` reuses the version-append path and returns the same `{version, previousVersion}` shape with no restore flag. The restore route MUST emit a `restore` event INSTEAD of (not in addition to) the `publish` event — suppress the publish emit on the restore path (pass a flag, or emit only from the route, never from the shared append). One restore = exactly one event.
> - **Detached emit location (F-5).** `reanchorOnNewVersion` is fired-not-awaited and its summary (carried/detached count) is only available in its summary callback. The `detached` emit MUST live in that callback (where the count exists), not in the publish route (which has already returned). A lost emit is acceptable per C-002 (best-effort); the publish event still appears.
> - **adds/dels (F-4).** The publish emit computes `meta.adds`/`meta.dels` by splitting the diff lines itself; the existing diff yields only a total `changeCount`.

**Acceptance Scenarios:**

AS-019: Publishing a version logs a publish event
- **Given:** a doc at v3
- **When:** Devin publishes v4
- **Then:** a publish event appears with from v3 → to v4 and the add/remove counts
- **Data:** v3→v4, +11/−0

AS-020: Restoring a prior version logs a restore event, not a publish
- **Given:** a doc whose current version is v2
- **When:** Mara restores v1
- **Then:** exactly ONE event appears — a `restore` event (restored v1 as the new version) — and NO `publish` event is also created for the same restore (C-005, F-3)
- **Data:** restore v1 → as v3; feed gains 1 row, type=restore

AS-021: A publish that detaches annotations logs one System detachment event
- **Given:** a publish whose re-anchor cannot place 2 annotations
- **When:** the re-anchor completes
- **Then:** one detachment event is logged with actor System and a count of 2
- **Data:** 2 detached annotations

### S-006: Sharing, membership, and project events (P1)

**Description:** As a viewer, I see workspace-shaping activity — a doc's sharing changing, a member joining, a project being created, and guest feedback via a public link — so people and access changes show up alongside doc activity.
**Source:** docs/explore/workspace-activity.md#event-types (share-change new audit; people events) + #unhappy-3 (guest actor with no account).
**Applies Constraints:** C-005

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/routes/sharing.ts (emit on share change), apps/backend/src/routes/workspaces.ts + invite.ts + members.ts (emit invite / join / removed / renamed), apps/backend/src/routes/projects.ts (emit project created), apps/backend/src/routes/annotations.ts (guest actorName on guest feedback), apps/backend/src/activity/
- `autonomous:` true
- `verify:` change a doc's general access → a Sharing event with the new access+role; accept an invite → a People member-joined event; create a project → a project event; leave guest feedback via a public link → an event whose actor is the guest name with no account.

> **Emit-site notes (from challenge):**
> - **One member-join site (F-11).** A workspace member row is created on invite-accept (the only join path — the account's OWN default workspace is created at sign-up as owner, which is not a "member joined" event). Emit `member` from that single invite-accept site so a join logs exactly once (never zero, never twice).
> - **Share event = new state only (F-10).** The share emit records the NEW access+role; no pre-read of the old state is needed in v0 (no from/to).
> - **Guest actorName is plain text (F-12).** The guest-supplied name is stored verbatim and rendered as escaped text — never as HTML.

**Acceptance Scenarios:**

AS-022: Changing a doc's sharing logs a share event
- **Given:** a doc shared as restricted
- **When:** Devin sets general access to "Anyone with link" as commenter
- **Then:** a Sharing event is logged with that access and role
- **Data:** access "Anyone with link", role commenter

AS-023: A member joining logs a People event
- **Given:** a pending workspace invite to Priya
- **When:** Priya accepts and joins
- **Then:** a member-joined event appears under People naming Priya
- **Data:** Priya joins as member

AS-024: Creating a project logs a project event
- **Given:** a workspace
- **When:** Mara creates the project "annotation-core"
- **Then:** a project-created event appears naming the project
- **Data:** project "annotation-core"

AS-025: Guest feedback via a public link records a guest actor
- **Given:** a doc shared by public link allowing comments
- **When:** a no-account guest leaves feedback
- **Then:** the event records the guest's display name with no associated account and renders as an anonymous actor
- **Data:** actorName "Anonymous Heron", no account

### S-007: Activity stats rail (P2)

**Description:** As a viewer, I see a stats rail — recent event count, most-active contributors, and the busiest doc — summarizing activity over the last 7 days, scoped to what I'm allowed to see.
**Source:** docs/explore/workspace-activity.md#happy-path (stats rail) + #business-rules (trailing-7-day window, counts respect visibility).
**Applies Constraints:** C-003, C-006

**Execution:**
- `depends_on:` S-001, S-002
- `parallel_safe:` false
- `files:` apps/backend/src/routes/activity.ts (stats endpoint), apps/backend/src/activity/ (7-day aggregates over the visible set), apps/web/src/features/activity/components/ (rail)
- `autonomous:` true
- `verify:` the rail counts cover the last 7 days; a member's contributors/busiest-doc exclude docs they can't access.

**Acceptance Scenarios:**

AS-026: Stats cover a trailing 7-day window
- **Given:** events spread across the last 10 days
- **When:** the viewer loads the rail
- **Then:** the counts and contributors reflect only events from the last 7 days
- **Data:** events on days 1–10; window = 7 days

AS-027: Contributors are ranked by event count
- **Given:** several contributors with differing event counts in the window
- **When:** the viewer loads the rail
- **Then:** "Most active" lists contributors ranked highest-first by their event count
- **Data:** Mara 5, Devin 3, Priya 2

AS-028: A member's rail excludes inaccessible docs
- **Given:** a member who can't access the workspace's busiest doc
- **When:** the member loads the rail
- **Then:** that doc is not shown as busiest and its events are excluded from the counts
- **Data:** Tom (member); busiest doc is one he can't access

## Constraints & Invariants

C-001: Activity is append-only and immutable. Deleting an underlying object (comment / doc / version) does NOT delete its activity row; the detail view degrades gracefully (stale "Open doc", diff falls back to counts). **`commentId`/`annotationId` set-null on delete, but `docId` is RETAINED (never set-null) on doc delete** — nulling it would reclassify the row as a workspace-level event and leak a `restricted` doc's event to all members (F-1). A deleted doc's event keeps its `docId` so the read-time filter still gates it. (AS-018)

C-002: Activity rows are written best-effort post-commit. A logging failure never blocks or rolls back the originating mutation; the only consequence is one missing feed entry. (AS-006)

C-003: Feed visibility is role- and access-gated (authorization invariant), **resolved at READ time against each doc's CURRENT access** — never frozen at emit time (F-2): a doc shared then later set `restricted` immediately drops out of a member's feed/detail/counts/stats. Admins see all workspace events. Members see workspace-level events (no doc target) **only while they are a CURRENT member at read time** (F-14 — a removed member does not read the feed) plus only doc-scoped events on docs they can access — where "can access" is resolved by the same `resolveAccess` path the doc viewer uses. Under shared-workspace model the workspace default is `anyone_in_workspace`, so a member can access (and therefore sees events on) most workspace docs; the filter excludes only docs explicitly set `restricted` that the member wasn't invited to. The rule is unchanged — only which docs fall on each side of it. **All four surfaces (feed-list, filter-counts, detail-url, stats-rail) MUST apply ONE shared visibility query-builder/view — not four independently-written filters (F-7)** — so counts, the busiest-doc name, and the feed can never disagree (e.g. a count of 15 with only 12 visible rows, or a "busiest doc" naming a doc the member can't open — F-STATS). An inaccessible event's detail returns not-found (existence-hiding), never a forbidden error.
  - scope: S-002, S-003, S-004, S-007
  - surfaces: feed-list, filter-counts, detail-url, stats-rail
  - coverage: feed-list → AS-007 (admin-all), AS-008 (member-hidden restricted), AS-009 (workspace-level), AS-029 (member-visible anyone_in_workspace), AS-030 (read-time re-check after access tightened); detail-url → AS-010, AS-030; filter-counts → AS-012; stats-rail → AS-028

C-004: The feed logs forward from when it ships — no backfill of pre-existing history. A workspace with no recorded events shows the empty state. (AS-004)

C-005: Exactly twelve event types exist, each emitted by its originating action: `comment`, `reply`, `resolve`, `publish`, `restore`, `share`, `invite`, `member` (join), `member_removed`, `workspace_renamed`, `project` (created), `detached`. **Each action logs exactly one event — in particular a restore logs ONE `restore` event and NO `publish` event (F-3).** (AS-001, AS-019, AS-020, AS-021, AS-022, AS-023, AS-024)

C-006: Stats-rail aggregates (counts, most-active contributors, busiest doc) cover a trailing 7-day window. (AS-026)

C-007: The feed is paginated recent-first, default 20 per page, cap 50. **Day-grouping is rendered client-side over the flat paged list (a day may straddle a page boundary — the client merges same-day headers across pages); "Today/Yesterday" are computed in the VIEWER's timezone (F-8).** Because the feed is manual-refresh (no realtime) and offset-paged, a new event arriving mid-read can shift offsets — occasional duplicate/skipped rows across consecutive page fetches are an accepted v0 limitation, not a bug. (AS-002, AS-003)

C-008: Cross-workspace isolation (F-6) — an emit always sets `activity.workspaceId` to the workspace that OWNS the target doc (via `project → workspace`), and the feed read both filters by the path `:workspaceId` AND gates each doc-scoped row through `resolveAccess`, which itself resolves membership against the doc's OWN workspace. A row whose `workspaceId` and doc-workspace disagree can never surface: the access check is anchored to the doc's real workspace, so a member of workspace A never sees a workspace-B doc's event in A's feed. (AS-008)

## UI Notes

- `ActivityScreen` *(replaces the existing placeholder at docs/components/activity-screen.tsx — see UI Inventory)*
  - `ActivityPageHead`: "Workspace" label + "Activity" title + `RefreshButton`
  - `ActivityFeed`
    - `ActivityFilterSegment`: All / Comments / Versions / Sharing / People, each with a count
    - `ActivityDayGroup`: day label + event count
      - `ActivityRow`: type node-icon + actor avatar + sentence + time; optional quote / preview; `ActivityChips` (doc, project, type-specific meta) — opens detail on click
    - *(empty / error / no-results states reuse existing primitives — see UI Inventory)*
  - `ActivityStatsRail` *(S-007)*
    - `RailStatCard` (Today + mini-grid), `ContributorRow` list (most active), busiest-doc card
- `ActivityDetailPage` *(route `/w/:id/activity/:eventId`)*
  - back link, hero (type icon + sentence + type badge + time)
  - body card: quote + body + `PublishDiffMini` *(reuse versioning-diff)* + metadata key-value list
  - rail: "More on this doc" related events + document card + "Open doc" button

> Source-of-truth: prototype `Anchord-Design/activity.jsx` + `activity.css` (canonical on conflict; naming/shape only). Tree above is the build-time summary.

**Export contract (for `your-activity-actions`, 2b):** the feed-rendering pieces — `ActivityFeed` (the day-grouped list), `ActivityRow`, `ActivityChips`, `ActivityDetailPage` — are built as **composable, rows-as-props** components (presentational: they take rows/loading/error, NOT bound to the workspace-scoped fetch). The activity read repo likewise takes a filter (workspaceId here; `actorUserId` for 2b) rather than hard-coding the workspace scope. This lets 2b render `/api/me/activity` through the SAME components without re-implementing the feed (resolves `your-activity-actions`:GAP-002). See Linked Fields.

## Linked Fields

- **feed components** (`ActivityFeed` / `ActivityRow` / `ActivityChips` / `ActivityDetailPage`) + **the activity read repo** — produced here as composable/rows-as-props (export contract above, S-001/S-004). Consumed by `your-activity-actions:S-001` (its AS-005, C-007) to render the personal feed. ✔ exported + composable.
- **`activity` rows for the personal feed** — produced by THIS spec's emit. For 2b they must additionally: set `actorUserId` = the acting user on all five own-action kinds (comment/resolve/publish/share/invite); carry a renderable version label in the publish `meta` (not just `versionId`); and the table needs an `(actorUserId, createdAt)` index (2b adds it). Consumed by `your-activity-actions:S-001` on `GET /api/me/activity`. ✔ emit sets actor (S-001/S-005/S-006); the index + version-label are 2b's additive obligations on this shared table.

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| `ActivityScreen` (placeholder) | `apps/web/src/features/docs/components/activity-screen.tsx` | retire — current honest empty state is replaced by the new `features/activity/` screen; route `/w/:id/activity` already mounts here |
| Activity nav item | `apps/web/src/app/app-sidebar.tsx:60` | reuse as-is (label "Activity", route `/w/:id/activity` already wired) |
| `EmptyState` | `apps/web/src/components/empty-state.tsx` | reuse for the feed empty state |
| `ErrorState` | `apps/web/src/components/error-state.tsx` | reuse for the feed error state |
| `NoResultsState` | `apps/web/src/components/no-results-state.tsx` | reuse for the empty-filter state |
| `Skeleton` | `apps/web/src/components/skeleton.tsx` | reuse for the loading state |
| `Icon` | `apps/web/src/components/icon.tsx` | reuse for type node-icons + chips |
| `Avatar` | `apps/web/src/components/ui/avatar.tsx` | reuse for actor avatars (incl. guest "?") |
| `Badge` | `apps/web/src/components/ui/badge.tsx` | reuse for the detail-page type badge |
| `Pagination` | `apps/web/src/components/pagination.tsx` | reuse for feed paging (20/50) |
| `Card` | `apps/web/src/components/ui/card.tsx` | reuse for rail + detail cards |

### System Impact & Technical Risks

- **Access resolver** `apps/backend/src/sharing/resolve-access.ts` — reuse the single `resolveAccess` path for the member visibility join (feed, counts, detail, stats). The replicated access filter across four surfaces is the highest correctness risk (a leak exposes content from docs a member can't open). **Build ONE shared visibility query-builder (or a DB view) that all four surfaces call — not four hand-written filters (F-7).** Do NOT re-derive access; resolve at READ time (F-2), never store an emit-time access snapshot.
- **Best-effort notify pattern** `apps/backend/src/notify/notify.ts` + `repo.ts` — mirror this best-effort post-commit shape for activity emit (C-002).
- **Pagination + envelope** `apps/backend/src/http/pagination.ts`, `http/envelope.ts` — reuse for the feed endpoint (same contract as the notification bell read API).
- **Version restore hook** `apps/backend/src/routes/versions.ts` (`POST .../versions/:n/restore`, returns `{ version, previousVersion }`) — attach the restore event here (distinguish from plain publish).
- **Re-anchor detached summary** `apps/backend/src/routes/versions.ts` (`reanchorOnNewVersion`, fired not awaited, reports carried/detached) — attach the System detached event to this summary.
- **Version diff** existing versioning-diff (`@pierre/diffs`) — reuse for the publish diff-mini on the detail page.
- **Three new emit plumbings** (technical risk): share-change has no audit today (emit at the sharing mutation site), detached must hook the re-anchor summary, restore must emit a distinct event from the restore route. Each is a new instrumentation point.
- **Doc-access model = shared-workspace model (landed 2026-06-23).** S-002 / C-003 (admins-all, members-filtered-by-doc-access) now assume the shared-group-space model: a workspace doc defaults to `anyone_in_workspace` (`workspaces`:C-007), so membership grants baseline access to most docs and a member sees most doc events; the filter gates only the `restricted` minority. The visibility CODE (reuse `resolveAccess`) is unchanged — only which events fall inside the filter. S-002's AS data + C-003's framing were updated in the 2026-06-23 Mode C pass (GAP-002 resolved); do NOT re-derive access in the activity query.

## Not in Scope

- **Personal "Your activity" page** (`personal.jsx`) — separate spec; "For you" will be a full-page view of the existing notification bell, "Your actions" a cross-workspace personal feed.
- **Realtime / live updates** — manual refresh only in v0 (no polling, no websocket), consistent with the v0 no-realtime stance.
- **Backfill of historical events** — feed logs forward from deploy (C-004).
- **Per-event mark-read / unread** — Activity is a passive feed, not an inbox (that's the bell / For-you tab).
- **Activity email digests** — handled (if ever) by the notifications system, not here.
- **Retention / pruning of old activity rows** — unbounded growth is acceptable for v0; revisit when volume warrants.
- **Emit idempotency / dedup (F-13)** — no idempotency key in v0; a retried mutation (double-submit, network retry) can write a duplicate activity row. Append-only best-effort accepts rare duplicates in v0; a dedup key (e.g. on `commentId`/`versionId` + type) is deferred.

## Gaps

GAP-002 (status: resolved → S-002 reframed + AS-029 + C-003 framing, 2026-06-23): shared-workspace model landed (workspace docs default to `anyone_in_workspace`, `workspaces`:C-007). S-002's Description + AS data and C-003's framing were updated in the 2026-06-23 Mode C pass: members now see most workspace doc events, the filter gates only the `restricted` minority, and AS-029 captures the new common case (member sees an `anyone_in_workspace` doc event). The visibility code path (`resolveAccess`) did not change — only the spec's framing and AS data. Source: doc-access default audit (2026-06-23).

GAP-001 (status: deferred): Per-viewer stats-rail aggregates (most-active, busiest doc) are computed over each member's filtered visible set on every load — cost on large/old workspaces is unspecified (cap or cache strategy). Owner: build-time; revisit if it measurably slows the rail. Source: docs/explore/workspace-activity.md#assumptions ("filtered aggregates… extra query cost on every page load. Could be cached/relaxed later if it bites.").

## Spec Sizing Notes

Stories=7 (at soft target). AS=30 (target 20, at the G7 overage hard cap ≤30).

G1 splits producing the excess AS (each AS = one stated atom, not a merged case):
- S-001 feed: 6 AS for 6 atoms (comment-appears, day-grouping+order, pagination, empty, error, best-effort-emit).
- S-002 visibility: 6 AS for 6 atoms (admin-all, member-hidden-restricted, workspace-level-visible, detail-404, member-visible-anyone_in_workspace AS-029, read-time-recheck AS-030) — the C-003 cross-surface authorization invariant forces per-surface + per-lifecycle coverage; AS-029 (shared-workspace common case) and AS-030 (read-time re-check after access tightened, from the 2026-06-23 challenge) are distinct atoms, not merges.
- S-004 detail: 5 AS for 5 atoms (metadata, diff-mini, anchor-deeplink, detached-fallback, stale-degrade).
- S-005 version events: 3 AS for 3 distinct triggers (publish, restore, detached).
- S-006 people/sharing events: 4 AS for 4 distinct triggers (share-change, member-join, project-created, guest-actor).

No bloat — each AS traces to one stated atom. **At the 30-AS hard cap** — any further growth (e.g. resolving F-13 idempotency into an AS) requires phasing or scope-by-layer, not another AS here.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-23 | Initial creation (from docs/explore/workspace-activity.md) | -- |
| 2026-06-23 | Major (M1, snapshot 2026-06-23-default-access.md) — doc-access shared-workspace model: GAP-002 resolved (deferred→resolved); +AS-029 (member sees an `anyone_in_workspace` doc event — the new common case); S-002 Description + AS-008 data + C-003 framing reworded for the shared-group-space model (members see most doc events; filter gates only `restricted`); System Impact note updated to "landed". `resolveAccess` code path unchanged — only framing + AS data. AS 28→29. | doc-access audit 2026-06-23 |
| 2026-06-23 | Minor — +Export contract + ## Linked Fields: feed components (`ActivityFeed`/`ActivityRow`/`ActivityChips`/`ActivityDetailPage`) + read repo built composable/rows-as-props for `your-activity-actions` (2b) reuse (resolves 2b:GAP-002); noted the actorUserId/version-label emit obligations for the personal feed. Additive contract, no AS change. | 2b cross-spec lock |
| 2026-06-23 | Major (snapshot 2026-06-23-pre-challenge.md) — /mf-challenge 4-lens hardening, 14 findings applied: **+AS-030** (read-time access re-check, F-2); **+C-008** (cross-workspace isolation, F-6); C-001 (docId NOT set-null on doc delete — F-1 leak fix); C-003 (read-time resolution + current-member + ONE shared visibility filter across 4 surfaces — F-2/F-7/F-14); C-005 (restore emits one restore, no publish — F-3); C-007 (client-side day-group, viewer-TZ, offset-drift accepted — F-8); Data Model (docId retained; adds/dels computed; actorName resolved-at-emit + plain-text; share meta new-state-only — F-1/F-4/F-9/F-10/F-12); S-005/S-006 emit-site notes (restore-vs-publish, detached-in-callback, single join site — F-3/F-5/F-11); AS-018/AS-020 Then strengthened; Not-in-Scope += emit idempotency (F-13). Rejected 3 scope-cuts (derive-from-notifications, defer-stats, defer-3-types) — product-owner decisions. AS 29→30. | /mf-challenge 2026-06-23 |
