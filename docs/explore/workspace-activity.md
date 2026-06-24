## Explore: Workspace Activity feed
_2026-06-23_

**Feature:** A workspace-scoped, append-only event feed — every comment, reply, resolve, publish, restore, share change, invite, member-join, project-created, and annotation-detach across the workspace — rendered as a day-grouped, filterable stream with a per-event detail page and a stats rail. Built from the `Anchord-Design/activity.jsx` prototype.
**Trigger:** User clicks "Activity" in the workspace sidebar (`/w/:id/activity`, nav item already exists). Events are written best-effort post-commit at each mutation site.
**UI expectation:** Reference prototype `Anchord-Design/activity.jsx` + `activity.css` + `activity-data.jsx` (authoritative for layout, density, copy). Day-grouped feed with a segmented category filter, a per-event detail route, and a right-hand stats rail.

> **Scope note — this is spec 1 of 2.** The prototype bundles two independent surfaces. This explore covers **only the Workspace Activity feed**. The **Personal "Your activity" page** (`personal.jsx` — For-you inbox + Your-actions tab, cross-workspace) is a SEPARATE feature/spec, explored later. Decision: "For you" will be a full-page view of the EXISTING notification bell (`GET /api/me/notifications`), not a new data source — recorded here so the second exploration starts from that premise.

---

### Happy path
1. Mara (workspace **admin**) clicks **Activity** in the sidebar → `/w/acme/activity`.
2. Page 1 loads: 20 most-recent events (recent-first), grouped by day (Today / Yesterday / `Mon, Jun 19`). The filter segment defaults to **All** with per-category counts (All / Comments / Versions / Sharing / People).
3. She clicks the **Versions** filter → server returns only `publish` + `restore` events (page 1 of that filtered set).
4. She clicks the **"Devin published v4"** row → **detail page**: KV metadata (actor, doc, project, version, when, thread/access as applicable), a **diff-mini** (real source line-diff via the existing versioning-diff / `@pierre/diffs`, +5 / −2), a **"More on this doc"** rail of related events, and an **Open doc** button.
5. The **stats rail** shows Today's event count, **Most-active contributors** (ranked bars), and **Busiest doc** — all global, because Mara is an admin.

### Permissions / visibility
- **Allowed:** all workspace members can open the Activity page.
- **Admins** see ALL workspace events (and global stats-rail aggregates).
- **Members** see: every **workspace-level event** (no doc target — invite, member-joined, member-removed, workspace-renamed, project-created) PLUS **doc-scoped events only for docs they can access** (joined through the existing access resolver, `resolveAccess` / doc-access-routing). Their filter counts and stats-rail aggregates (Most-active, Busiest doc) are computed over the SAME visible set — a member never sees a count or a "busiest doc" they couldn't open.
- **Direct detail-URL access** to an event a member can't see → **404** (not 403 — never leak the event/doc's existence; mirrors the notifications C-008 read-own / existence-hiding posture).

### Business rules
- **Append-only audit log.** Events are immutable once written. Deleting the underlying object (comment/doc/version) does NOT delete the activity row — the row stays; the detail view degrades gracefully (`Open doc` 404s, diff-mini falls back to +/− counts or "version no longer available").
- **Write timing: best-effort post-commit** (same pattern as `notifications-email`). A logging failure never blocks/rolls back the real mutation; the cost is one silently-missing feed entry.
- **Logs from deploy forward.** No backfill of pre-existing history — a workspace's feed starts empty when the table ships (see empty state).
- **Event categories (for the filter):** Comments = `comment`,`reply`,`resolve`; Versions = `publish`,`restore`; Sharing = `share`; People = `invite`,`member`,`member_removed`,`workspace_renamed`; Other/All = everything incl. `project`,`detached`.
- **Stats-rail window:** "Today" count is today; **Most-active contributors and the mini-grid counts cover a trailing 7-day window** (bounded, stays meaningful as history grows), computed over the viewer's visible set. "Busiest doc" is the most-eventful doc in that 7-day window the viewer can access.
- **"Open doc" deep-link:** for `comment`/`reply`/`resolve` events, jump to the **exact annotation anchor** in the viewer (reuse the existing anchor deep-link); **fall back to doc-top** if the anchor has since detached. For `publish`/`restore`, open at the version.
- **Filtering + counts are server-side** (the feed is paginated, so client-side filtering over one page would be wrong). Category counts are a separate count query, scoped to the viewer's visible set.
- **Pagination:** paged, recent-first, default 20 / cap 50 — reuse the existing `paginationQuery`/`paginate` helper (same contract as the bell). Endpoint scoped `/api/w/:workspaceId/activity`.
- **Freshness:** manual refresh only — refetch on the Refresh button + on page mount. No polling, no websocket (consistent with v0 no-realtime stance).

### Event types (12 in v0)
`comment`, `reply`, `resolve`, `publish`, `restore`, `share`, `invite`, `member` (join), `project` (created), `detached`, **`member_removed`**, **`workspace_renamed`**.
(The prototype shows 10; `member_removed` + `workspace_renamed` are added — same table, cheap, and they align with the draft `workspace-notifications` taxonomy. Both render under the **People** category.)
- **Cheap (clear mutation site + timestamp):** comment, reply, resolve (annotations/comments routes), publish (docVersions), member-join (workspaceMembers.joinedAt), invite (workspaceInvitations), project-created (projects).
- **Needs new plumbing:**
  - `share` — share changes have NO audit today (only current state in shareLinks/docMembers); must emit an event at the share-mutation site.
  - `detached` — must hook the re-anchor-failure path (anchorResolution) to emit a System-actor event with a count.
  - `restore` — must mark/emit when a version publish is a restore-of-prior (from→as metadata).

### Data impact
- **New table `activity`** (append-only). Sketch (keep portable — no Postgres-only features, per CLAUDE.md):
  - `id` (snowflake text, per id-strategy memory)
  - `workspaceId` → workspaces (cascade)
  - `type` (enum mirroring the 10 event types — or text + check)
  - `actorUserId` → user, **NULLABLE** (guest/anonymous actors and the System actor have no user row)
  - `actorName` (text — denormalized display name; required, so guest "Anonymous Heron" and "System" render without a user join)
  - `docId` → docs (nullable; null = workspace-level event), `projectId` (nullable), `versionId` (nullable)
  - `commentId` / `annotationId` refs (nullable; for deep-linking; set-null on delete so the row survives)
  - `summary` / `target` (text — the sentence fragments the row renders)
  - `meta` (jsonb — type-specific: from/to/adds/dels for publish, access/role for share, count for detached, role/pending for invite, restored/as for restore)
  - `createdAt`
  - Indexes: `(workspaceId, createdAt)` for the feed; consider `(workspaceId, docId)` for the access-filtered member query + "More on this doc".
- **Migration:** one new table + the type enum. No change to existing tables (refs are nullable FKs with set-null).

### Impact on existing system
- **FE:** replaces the placeholder `apps/web/src/features/docs/components/activity-screen.tsx` (currently an honest empty state) with the real feed + detail. The nav item + route already exist (`app-sidebar.tsx:60`, `/w/:id/activity`).
- **BE:** new `activity` table + repo + route (`/api/w/:workspaceId/activity`, `/activity/:id` for detail). New emit calls inserted at each mutation site (annotations, versions/publish, sharing, workspaces invite/member, projects, anchor-resolution detach). Reuse `apiEnvelope`, `paginationQuery`, `requireSession`, workspace path-scoping, and `resolveAccess` for the member visibility join.
- **Reuse versioning-diff** for the detail-page diff-mini on publish events.

### Out of scope
- **Personal "Your activity" page** (`personal.jsx`) — separate spec (For-you inbox = full-page bell view; Your-actions tab = my cross-workspace events).
- **Realtime / live updates** — manual refresh only in v0.
- **Backfill of historical events** — feed logs forward from deploy.
- **Per-event mark-read / unread** — Activity is a passive feed, not an inbox (that's the bell / For-you tab).
- **Email digests of activity** — covered (if ever) by the notifications system, not here.

### UI sketch (E/N/X)
```
┌─ Activity page  [E] features/docs/components/activity-screen.tsx (placeholder → replace) ─┐
│  Sidebar nav "Activity"  [E] app-sidebar.tsx:60  →  route /w/:id/activity  [E]            │
│  Page head: "Workspace" mono-label + "Activity" title + [Refresh] btn  [N]               │
│  ╔ Feed (act-main)  [N] ═══════════════════════════════╗   ╔ Stats rail (act-rail) [N] ╗ │
│  ║  Filter segment: All/Comments/Versions/Sharing/People ║   ║  "Today" count card  [N] ║ │
│  ║    + per-category counts  [N]                         ║   ║  Most-active contribs[N] ║ │
│  ║  Day group label + event count  [N]                   ║   ║  Busiest doc  [N]        ║ │
│  ║  act-row: node-icon + avatar + sentence + time  [N]   ║   ╚══════════════════════════╝ │
│  ║    + quote / preview / type chips (ActChips)  [N]     ║                                │
│  ║    → click row → detail page  [N]                     ║   Avatar [E] ui/avatar.tsx     │
│  ║  Pagination (paged 20/50)  [E] components/pagination   ║   Icon [E] components/icon.tsx │
│  ║  Empty [E] / Error [E] / NoResults [E] states         ║   Badge [E] ui/badge.tsx       │
│  ╚═══════════════════════════════════════════════════════╝                                │
│                                                                                            │
│  ┌─ Detail page  [N]  route /w/:id/activity/:eventId ──────────────────────────────────┐  │
│  │  Back link [N] · hero (icon + sentence + type badge + time) [N]                      │  │
│  │  Body card: quote + body + diff-mini [N] (reuse versioning-diff [E]) + KV table [N]  │  │
│  │  Rail: "More on this doc" related events [N] + Document card + Open doc btn [N]       │  │
│  └──────────────────────────────────────────────────────────────────────────────────────┘
└────────────────────────────────────────────────────────────────────────────────────────┘

Legend: [E] existing · [N] NEW · [X] MISSING / clarify
```

### Decision rationale
- **Two specs, Workspace Activity first** — the two prototype surfaces have different data sources and don't depend on each other; splitting lets each ship independently.
- **"For you" = full-page view of the existing bell** (not a new feed) — the bell already provides mentions/replies/resolved/invites with a read API; a second parallel inbox would be redundant. (Applies to the deferred Personal spec.)
- **Append-only `activity` table** over deriving-from-existing-tables — the prototype shows share-change and detached events that leave NO trace in current state and are unreconstructable by UNION. A dedicated log is the only source that delivers the full feed. Cost accepted: instrument each mutation site; no history backfill.
- **Admins-all / members-filtered visibility** — workspace membership is orthogonal to per-doc access (most-permissive wins); showing every member every event would leak quotes/section titles from docs they can't open. Admins get the full operational view.
- **Best-effort post-commit writes** — consistent with notifications-email; a logging bug must never roll back a real publish/comment. Trade-off: a failed write = one missing feed row (acceptable for an activity log).
- **404 (not 403) on inaccessible detail URLs** — existence-hiding, mirrors notifications C-008.

### Assumptions (need confirmation in spec/build)
- The System actor (`detached`) and guests (`feedback`/`comment` via public link) are stored as `actorUserId: null` + a denormalized `actorName` ("System" / "Anonymous Heron").
- Stats-rail aggregates ("Most active", "Busiest doc") are computed per-viewer over the visible set — for a member this means filtered aggregates, which is extra query cost on every page load. (Could be cached/relaxed later if it bites.)
- "Restore" detection: a publish that restores a prior version emits a `restore` event (with `restored`/`as` meta) INSTEAD of a plain `publish`. Needs the versioning-diff/restore flow to pass that signal.
- The activity enum reuses/aligns with the notification taxonomy naming where they overlap (e.g. `detached`, `invited`) but is a SEPARATE enum (activity ≠ notifications — activity is the complete workspace log, notifications are per-recipient).

### Open questions
_All resolved (2026-06-23):_
- ~~`member_removed` / `workspace_renamed` in v0?~~ → **Yes**, log them (People category). 12 event types total.
- ~~Stats window?~~ → **Trailing 7 days** for Most-active + mini-grid counts; "Today" count is today.
- ~~Deep-link precision?~~ → **Jump to the annotation anchor**, fall back to doc-top if detached.

### Complexity signal: **high**
Based on: new table + enum + repo + 2 routes (feed + detail), emit calls inserted at ~7 distinct mutation sites (3 needing new plumbing: share-audit, detach-hook, restore-marker), an access-filtered visibility join replicated across feed + counts + stats aggregates + detail-URL guard, plus a full new FE feed + detail + stats-rail UI. Touches sensitive layers (sharing, workspace membership, access resolution).

### Non-functional requirements
- **Scale:** event volume grows unbounded (one row per workspace mutation). The `(workspaceId, createdAt)` index + paged 20/50 keeps the feed query bounded; long-term retention/pruning is out of scope for v0 but worth a note.
- **Security/compliance:** the feed quotes user content — the visibility filter IS the access-control boundary; getting the member-filter join right is the primary correctness risk. Existence-hiding (404) on detail URLs.
- **Availability:** if activity logging is down, real mutations still succeed (best-effort); only the feed degrades.

### Technical risks
- **Member visibility join** — the access-filtered query (and its replication across feed / counts / stats aggregates / detail guard) is the highest-risk surface; a leak here exposes content from docs a member can't open. Reuse the single `resolveAccess` path (doc-access-routing) rather than re-deriving access.
- **Three new emit plumbings** — share-change has no existing audit, detach must hook anchor-resolution, restore must thread a signal through publish; each is a new instrumentation point, not a one-liner.
- **Per-viewer stats aggregates** — computing Most-active/Busiest-doc over a filtered set on every member's page load may need a cap or cache if workspaces get large.
