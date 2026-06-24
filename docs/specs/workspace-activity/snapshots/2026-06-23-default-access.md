# Snapshot: Workspace Activity feed
**Date:** 2026-06-23
**Ref:** doc-access shared-workspace model (workspace = shared group space)
**Reason:** M1 (new AS-029 member sees an anyone_in_workspace doc event) + GAP-002 deferred→resolved + S-002/C-003 framing

---

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
  - `actorName` — denormalized display name (required), so "System" and "Anonymous Heron" render without a user join.
  - `docId` / `projectId` / `versionId` — nullable targets. `docId` null = a workspace-level event.
  - `commentId` / `annotationId` — nullable deep-link refs; set-null when the referenced row is deleted so the event row survives (C-001).
  - `summary` / `target` — the sentence fragments a row renders.
  - `meta` — JSON for type-specific fields: `from/to/adds/dels` (publish), `restored/as` (restore), `count` (detached), `access/role` (share), `role/pending` (invite).
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

**Description:** As a workspace member without access to every doc, I see only events I'm allowed to see — workspace admins see everything — so the feed never leaks content from docs I can't open.
**Source:** docs/explore/workspace-activity.md#permissions--visibility (admins all / members filtered / workspace-level visible to all / 404 on inaccessible detail).
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
- **Given:** the same comment event on "Secret roadmap"
- **When:** Tom (member with no access to "Secret roadmap") opens the feed
- **Then:** the event is absent from his feed
- **Data:** Tom role = member; no per-doc grant on "Secret roadmap"

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

AS-018: An event with a deleted target still renders and degrades gracefully
- **Given:** a comment event whose comment and doc were later deleted
- **When:** the viewer opens its detail
- **Then:** the event still renders from its stored fields and "Open doc" degrades without error
- **Data:** activity row intact; referenced comment/doc removed

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

**Acceptance Scenarios:**

AS-019: Publishing a version logs a publish event
- **Given:** a doc at v3
- **When:** Devin publishes v4
- **Then:** a publish event appears with from v3 → to v4 and the add/remove counts
- **Data:** v3→v4, +11/−0

AS-020: Restoring a prior version logs a restore event, not a publish
- **Given:** a doc whose current version is v2
- **When:** Mara restores v1
- **Then:** a restore event appears (restored v1 as the new version), distinct from a plain publish
- **Data:** restore v1 → as v3

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

C-001: Activity is append-only and immutable. Deleting an underlying object (comment / doc / version) does NOT delete its activity row; the detail view degrades gracefully (stale "Open doc", diff falls back to counts). (AS-018)

C-002: Activity rows are written best-effort post-commit. A logging failure never blocks or rolls back the originating mutation; the only consequence is one missing feed entry. (AS-006)

C-003: Feed visibility is role- and access-gated (authorization invariant). Admins see all workspace events. Members see every workspace-level event (no doc target) plus only doc-scoped events on docs they can access. Filter counts, the detail surface, and stats aggregates are all computed over the SAME visible set; an inaccessible event's detail returns not-found (existence-hiding), never a forbidden error.
  - scope: S-002, S-003, S-004, S-007
  - surfaces: feed-list, filter-counts, detail-url, stats-rail
  - coverage: feed-list → AS-007, AS-008, AS-009; detail-url → AS-010; filter-counts → AS-012; stats-rail → AS-028

C-004: The feed logs forward from when it ships — no backfill of pre-existing history. A workspace with no recorded events shows the empty state. (AS-004)

C-005: Exactly twelve event types exist, each emitted by its originating action: `comment`, `reply`, `resolve`, `publish`, `restore`, `share`, `invite`, `member` (join), `member_removed`, `workspace_renamed`, `project` (created), `detached`. Each action logs exactly one event. (AS-001, AS-019, AS-020, AS-021, AS-022, AS-023, AS-024)

C-006: Stats-rail aggregates (counts, most-active contributors, busiest doc) cover a trailing 7-day window. (AS-026)

C-007: The feed is paginated recent-first, default 20 per page, cap 50. (AS-002, AS-003)

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

- **Access resolver** `apps/backend/src/sharing/resolve-access.ts` — reuse the single `resolveAccess` path for the member visibility join (feed, counts, detail, stats). The replicated access filter across four surfaces is the highest correctness risk (a leak exposes content from docs a member can't open). Do NOT re-derive access.
- **Best-effort notify pattern** `apps/backend/src/notify/notify.ts` + `repo.ts` — mirror this best-effort post-commit shape for activity emit (C-002).
- **Pagination + envelope** `apps/backend/src/http/pagination.ts`, `http/envelope.ts` — reuse for the feed endpoint (same contract as the notification bell read API).
- **Version restore hook** `apps/backend/src/routes/versions.ts` (`POST .../versions/:n/restore`, returns `{ version, previousVersion }`) — attach the restore event here (distinguish from plain publish).
- **Re-anchor detached summary** `apps/backend/src/routes/versions.ts` (`reanchorOnNewVersion`, fired not awaited, reports carried/detached) — attach the System detached event to this summary.
- **Version diff** existing versioning-diff (`@pierre/diffs`) — reuse for the publish diff-mini on the detail page.
- **Three new emit plumbings** (technical risk): share-change has no audit today (emit at the sharing mutation site), detached must hook the re-anchor summary, restore must emit a distinct event from the restore route. Each is a new instrumentation point.
- **Depends on the doc-access model (pending decision).** S-002 / C-003 (admins-all, members-filtered-by-doc-access) are written against the CURRENT model where a workspace doc defaults to `restricted` and membership grants no baseline access. A pending change (shared-workspace model — default workspace docs to `anyone_in_workspace`, see GAP-002) would make most workspace docs member-visible, shrinking the filter to mostly `restricted` docs. The visibility CODE (reuse `resolveAccess`) is unaffected — only which events get filtered changes — but S-002's AS data and C-003's framing need a Mode C pass once that lands.

## Not in Scope

- **Personal "Your activity" page** (`personal.jsx`) — separate spec; "For you" will be a full-page view of the existing notification bell, "Your actions" a cross-workspace personal feed.
- **Realtime / live updates** — manual refresh only in v0 (no polling, no websocket), consistent with the v0 no-realtime stance.
- **Backfill of historical events** — feed logs forward from deploy (C-004).
- **Per-event mark-read / unread** — Activity is a passive feed, not an inbox (that's the bell / For-you tab).
- **Activity email digests** — handled (if ever) by the notifications system, not here.
- **Retention / pruning of old activity rows** — unbounded growth is acceptable for v0; revisit when volume warrants.

## Gaps

GAP-002 (status: deferred): The feed's member visibility (S-002 / C-003) assumes the current `restricted`-by-default access model. If "shared-workspace model" lands (workspace docs default to `anyone_in_workspace`), S-002's AS data and C-003's framing need a Mode C revision — members would then see most workspace doc events, leaving the filter to gate only `restricted` docs. Owner: product (access-model decision audited 2026-06-23); the visibility code path (`resolveAccess`) does not change, only the spec's framing. Source: doc-access default audit (2026-06-23) — see the separate access-model change prompt.

GAP-001 (status: deferred): Per-viewer stats-rail aggregates (most-active, busiest doc) are computed over each member's filtered visible set on every load — cost on large/old workspaces is unspecified (cap or cache strategy). Owner: build-time; revisit if it measurably slows the rail. Source: docs/explore/workspace-activity.md#assumptions ("filtered aggregates… extra query cost on every page load. Could be cached/relaxed later if it bites.").

## Spec Sizing Notes

Stories=7 (at soft target). AS=28 (target 20, in G7 overage range ≤30).

G1 splits producing the excess AS (each AS = one stated atom, not a merged case):
- S-001 feed: 6 AS for 6 atoms (comment-appears, day-grouping+order, pagination, empty, error, best-effort-emit).
- S-002 visibility: 4 AS for 4 atoms (admin-all, member-hidden, workspace-level-visible, detail-404) — the C-003 cross-surface invariant forces per-surface coverage.
- S-004 detail: 5 AS for 5 atoms (metadata, diff-mini, anchor-deeplink, detached-fallback, stale-degrade).
- S-005 version events: 3 AS for 3 distinct triggers (publish, restore, detached).
- S-006 people/sharing events: 4 AS for 4 distinct triggers (share-change, member-join, project-created, guest-actor).

No bloat — each AS traces to one stated atom.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-23 | Initial creation (from docs/explore/workspace-activity.md) | -- |
