# Spec: Your Activity — Your-actions feed

**Created:** 2026-06-23
**Last updated:** 2026-06-24
**Status:** Draft
**Snapshot limit:** 5

## Overview

The second tab of the account-scoped **"Your activity"** page (`/me/activity`) — **Your actions** — a cross-workspace, read-only feed of the things the signed-in user themselves did (published, commented, resolved, shared, invited), newest-first and day-grouped. Built from the `Anchord-Design/personal.jsx` prototype (`MY_ACTIVITY`). This spec also introduces the two-tab page shell that wraps the sibling **For you** inbox (`your-activity-inbox`, 2a) as the first tab.

This is **spec 2b of the personal page**. Its data source is the `activity` table owned by `workspace-activity` (spec 1), filtered to `actorUserId = me` across every workspace the user currently belongs to, served by a NEW account-scoped endpoint `GET /api/me/activity`. **It HARD-DEPENDS on `workspace-activity` being built** (no activity table → no source). It is NOT an inbox — there is no unread/mark concept; it is the user's own history.

**Build Order (blocking):** `workspace-activity` (spec 1) — table + emit + the new `(actorUserId, createdAt)` index + exported feed components (export contract now locked) — MUST ship first (GAP-001). Then 2b S-001 (P0). S-002 (tabs) mounts `your-activity-inbox` (2a)'s exported `ForYouContent` (contract now locked). So: spec 1 → 2a → 2b. (GAP-002/003 resolved — the component contracts are pinned in spec 1 + 2a.)

**Relationship to 2a (shell ownership, M7):** `your-activity-inbox` (2a) ships the For-you content as standalone components on `/me/activity` with no tab bar. THIS spec (2b) introduces the two-tab bar (**For you** | **Your actions**), composing 2a's For-you components as tab 1 and the new Your-actions feed as tab 2. The tab container is built exactly once — here.

## Data Model

No new tables. Reuses the `activity` table from `workspace-activity` (spec 1), with two additions:

- **`GET /api/me/activity`** (new, account-scoped) — returns the caller's own activity rows: `WHERE actorUserId = <session caller>` (C-001 — the actor is ALWAYS the session user, never a client-supplied id), across every workspace the caller is **currently** a member of (C-006 — read-time membership), newest-first, paginated. No write surface.
- **Stored vs enriched (C1 — important):** `workspace-activity` persists only IDs + denormalized text — `type`, `actorUserId`, `actorName`, `workspaceId`, `docId`/`projectId`/`versionId`, `summary`/`target`, `meta`, `createdAt`. It does **NOT** store `workspaceName` or `docTitle`. So `/api/me/activity` must **enrich at read time** — join `workspaceId → workspace name` and `docId → doc title` (the same read-time enrichment `your-activity-inbox` adds for notifications). `version` for publish rows comes from `meta` (the emit must store a renderable label, not just a `versionId` — H3 dependency on spec 1).
- **New index (C2):** the cross-workspace own-actions query filters by `actorUserId` with NO `workspaceId` predicate — `workspace-activity`'s `(workspaceId, createdAt)` index does NOT serve it. This spec adds an **`(actorUserId, createdAt)`** index to the `activity` table (an additive index on the shared table; keep portable). Owned by S-001.
- The activity rows + their emit are a **Linked Field** dependency on `workspace-activity` (see Linked Fields).

## Stories

### S-001: See my own activity across workspaces (P0)

**Description:** As a signed-in user, I open the **Your actions** tab and see a newest-first, day-grouped feed of what I've done — published, commented, resolved, shared, invited — across every workspace I'm currently in, each row showing the workspace, doc, and action-specific detail, so I have one personal record of my work. **2b adds the `/api/me/activity` endpoint (the read side) and renders the feed with the personal `.me-*` component family matching the `personal.jsx` prototype (C-007, reversed 2026-06-24 — NOT the workspace-activity components): per-day bordered cards, type-toned node icons, verb-first sentence with no actor avatar/name, and the prototype's chip row.**
**Source:** `Anchord-Design/personal.jsx` + `personal-data.jsx` (`MY_ACTIVITY`, cross-workspace own-actions); docs/explore/workspace-activity.md (Personal page split — "Your actions" = `activity WHERE actorUserId = me`).
**Applies Constraints:** C-001, C-002, C-003, C-006

**Execution:**
- `depends_on:` none *(in-spec; **cross-spec HARD dependency on `workspace-activity` (spec 1)** — the `activity` table, its emit, AND its exported feed/detail components must exist first; see Build Order + Linked Fields)*
- `parallel_safe:` false
- `files:` apps/backend/src/routes/me.ts or a new account-scoped activity route (`GET /api/me/activity` — session-scoped `actorUserId`, read-time current-member filter, enrichment join, new `(actorUserId, createdAt)` index in apps/backend/src/db/schema.ts), apps/backend/src/activity/ (a cross-workspace read filtered to `actorUserId` + access enrichment, reuse the workspace-activity repo), apps/web/src/features/your-activity/ (a thin Your-actions view that fetches `/api/me/activity` and renders it through `workspace-activity`'s exported feed/row/detail components — NOT a re-implementation)
- `autonomous:` true
- `verify:` as a user who published in workspace A and commented in workspace B, GET `/api/me/activity` → both events (and only the caller's) appear newest-first, each with its workspace; a request carrying a foreign `actorUserId` returns only the caller's own; next page → older events.

**Acceptance Scenarios:**

AS-001: My publish appears in Your actions
- **Given:** I published v4 of a doc in "Acme Platform"
- **When:** I open the Your actions tab
- **Then:** the newest row reads that I published v4 of that doc, under Today, with the from→to and add/remove counts
- **Data:** publish v3→v4, +5/−2, doc "Web-core behavior contract"
- **Setup:** I am the actor (`actorUserId = me`)

AS-002: Actions span every workspace I'm in, each labeled
- **Given:** I published in "Acme Platform" and commented in "Field IO"
- **When:** I open Your actions
- **Then:** both events appear in one feed, each row carrying its own workspace label
- **Data:** 1 action in Acme, 1 in Field IO

AS-003: Feed is grouped by day, newest first
- **Given:** my actions span today, yesterday, and earlier
- **When:** I view Your actions
- **Then:** rows are grouped under day labels (Today / Yesterday / dated) in the viewer's timezone, most-recent first
- **Data:** 5 actions across 3 days

AS-004: Feed pages older actions
- **Given:** I have 25 actions
- **When:** I load Your actions, then request more
- **Then:** the first page shows the most-recent 20 and the next loads the remaining 5 older ones
- **Data:** 25 actions; page 20

AS-005: Opening an action shows its detail and links to the doc (personal detail look)
- **Given:** a share action on a doc
- **When:** I open the row
- **Then:** the detail (the personal `.me-detail` look, shared with the For-you inbox — NOT the workspace activity detail) shows the workspace, doc, when, and the action-specific detail (e.g. access · role for a share), with an "Open in doc" link to the target
- **Data:** share "Anyone with link" · commenter on "Auth & invite flows"

AS-006: An action on a doc I lost access to still lists, but every current-content display is genericized
- **Given:** I commented on a doc that was later set restricted (or I was removed from its workspace)
- **When:** I view Your actions
- **Then:** the action still appears (it is my own history), but EVERY display derived from the now-inaccessible target — doc title, section/`target`, any quote, and the "Open in doc" link — is genericized to a non-revealing placeholder (e.g. "a document you no longer have access to"); the row never exposes current content or structure I can't see (C-002)
- **Data:** my comment on "Secret Roadmap §Pricing" after losing access → row shows the action + when, but not the title/section/quote/link

AS-007: Empty state
- **Given:** a user who has done nothing yet
- **When:** they open Your actions
- **Then:** an empty state reads "No activity yet" with the "things you publish, comment on and share will appear here" message
- **Data:** zero own-actions

AS-008: Error state
- **Given:** the Your-actions request fails
- **When:** the tab renders
- **Then:** an error state with Retry is shown (not a blank tab)
- **Data:** simulated fetch failure

AS-012: The feed is always the session caller's own actions only (no IDOR)
- **Given:** I am signed in as Mara
- **When:** I request `/api/me/activity` — including a crafted request carrying a `actorUserId` for another user (Devin)
- **Then:** only MY (Mara's) actions are returned; the actor filter is the session user, never a client-supplied id; rows with no account actor (`actorUserId` absent — System/guest) never match
- **Data:** request with `?actorUserId=devin` → still only Mara's rows

### S-002: The two-tab "Your activity" page (P1)

**Description:** As a user, I see "Your activity" as two tabs — **For you** (my inbox) and **Your actions** (my history) — switch between them, and deep-link directly to either, so both personal surfaces live on one page.
**Source:** `Anchord-Design/personal.jsx` (PersonalScreen tabs, `?mytab` deep-link) + the M7 shell-ownership decision (2b owns the tab bar).
**Applies Constraints:** C-004

**Execution:**
- `depends_on:` S-001 *(in-spec; cross-spec: composes `your-activity-inbox` (2a) For-you components — see Linked Fields)*
- `parallel_safe:` false
- `files:` apps/web/src/features/your-activity/components/ (tab shell wrapping 2a's For-you + this spec's Your-actions), apps/web/src/app (the `/me/activity` route already mounted by 2a — extend to a tabbed page)
- `autonomous:` true
- `verify:` open `/me/activity` → For you tab by default; switch to Your actions → my history; load `/me/activity?tab=actions` → opens directly on Your actions.

**Acceptance Scenarios:**

AS-009: Switching tabs shows the right surface
- **Given:** I'm on `/me/activity`
- **When:** I click the "Your actions" tab, then the "For you" tab
- **Then:** "Your actions" shows my own-action feed (S-001) and "For you" shows my inbox (the 2a components)
- **Data:** both tabs populated

AS-010: A tab is deep-linkable
- **Given:** a link to `/me/activity?tab=actions`
- **When:** I open it
- **Then:** the page opens directly on the Your actions tab (For you is the default when no tab is specified)
- **Data:** `?tab=actions` vs no query

AS-011: For-you content composes from the sibling spec
- **Given:** the 2a For-you components exist
- **When:** the For you tab renders
- **Then:** it shows the 2a inbox (this spec does not re-implement the inbox; it composes 2a's components into tab 1)
- **Data:** seam with `your-activity-inbox`

## Constraints & Invariants

C-001: Your actions is the caller's OWN activity, scoped by `actorUserId = <session user>` — the actor filter is ALWAYS derived from the session, NEVER a client-supplied query/path parameter (no IDOR); a request carrying a foreign `actorUserId` returns only the caller's own rows. Rows with no account actor (`actorUserId` absent — System / guest) never match. Read-only — there is no action on a row (it is history, not an inbox). (AS-001, AS-002, AS-012)

C-002: A row is always visible to its actor (you see what you did), but EVERY display derived from the target doc/workspace — doc title, `target`/section text, any quote, and the "Open in doc" deep-link — is resolved against the caller's CURRENT access at READ time. If access was lost (doc set restricted, or workspace left), the row still lists but all those fields genericize to non-revealing placeholders — the row never exposes current content/structure the caller can't see. (mirrors `workspace-activity`:C-001/C-003; read-time, never an emit-time snapshot). (AS-006)

C-003: The feed is paginated recent-first; day grouping is client-side over the flat paged list; "Today/Yesterday" in the VIEWER's timezone. Because it is offset-paged + manual-refresh (no realtime), a new action arriving mid-read can shift offsets — occasional duplicate/skipped rows across consecutive fetches are an accepted v0 limitation (mirrors `workspace-activity`:C-007). (AS-003, AS-004)

C-004: No unread / mark-read / count concept on Your actions — that belongs only to the For-you inbox (2a). The tab shows no unread pill. (AS-009)

C-005: The Your-actions feed has NO data until `workspace-activity` (spec 1) is built and emitting — `/api/me/activity` reads the `activity` table it owns. This spec cannot function before spec 1 (Linked Field + GAP-001). (AS-001)

C-006: `/api/me/activity` returns the caller's actions only in workspaces where the caller is a CURRENT member at read time (a `workspace_members` join, status active). A workspace the caller has LEFT drops out of the feed (or its rows genericize per C-002) — a removed member's feed never reveals a workspace they're no longer in. (mirrors `workspace-activity`:C-003 / F-14). (AS-006)

C-007: **REVERSED 2026-06-24 (prototype fidelity — product owner).** The Your-actions feed is built from the **personal `.me-*` component family** (the same `personal.css` look as the For-you inbox, 2a) so it matches the `personal.jsx` prototype's `MY_ACTIVITY` rows pixel-for-pixel — it does NOT reuse the `workspace-activity` feed/row/chips/detail components. Concretely: per-day **bordered `.me-list` cards** (not a flat list), a **type-toned `.me-node` icon** (publish→accent, resolve→green, comment→muted, share→accent, invite→amber, etc.), **NO actor avatar and NO actor-name prefix** (these are the caller's OWN actions — the sentence is verb-first, e.g. "published v4"), **NO "N events" count** on the day header, and the prototype's `.me-chip` row (workspace / doc / version / diff `+adds −dels` / access·role / pending). The READ side still reuses the `activity` data (the table + the `actorUserId` cross-workspace query) — only the RENDERING is the personal family, not the workspace components. The detail reuses the personal detail look (the `.me-detail` view, shared with the For-you inbox), not the workspace activity detail. (AS-001..006; Linked Fields). *(Earlier this constraint mandated reusing the workspace-activity components; that produced a visibly different feed — flat list, event counts, avatars/actor names — so it was reversed to match the prototype. The workspace Activity screen is unaffected; it keeps its own components.)*

## Linked Fields

- **`activity` rows** (`actorUserId`, `workspaceId`, `type`, `docId`, `versionId`, `summary`/`target`, `meta`, `createdAt`) — consumed by `your-activity-actions:S-001` (AS-001..006) on the `GET /api/me/activity` read (persisted in the `activity` table + served on every read). Produced by **`workspace-activity`** emit (S-001 comment/resolve events; S-005 version events; S-006 sharing/people events), persisted in the `activity` table. **The emit MUST set `actorUserId` = the acting user for all 5 own-action kinds (publish/comment/resolve/share/invite), and the publish `meta` MUST carry a renderable version label, not just a `versionId` (H3).** Note: `workspaceName`/`docTitle` are NOT stored — 2b enriches them at read time (C1, Data Model). ✔ persisted + served — **BUT the table/emit/index don't exist until spec 1 is built → GAP-001**. Seam test (real integration, never mocked): with `workspace-activity` built + emitting, after I publish, `GET /api/me/activity` returns my publish row with `meta` carrying the version label + add/remove counts.
- ~~**`workspace-activity` feed/row/chips/detail components**~~ — **DROPPED 2026-06-24 (C-007 reversed):** Your-actions no longer consumes the workspace-activity render components; it uses the personal `.me-*` family to match `personal.jsx`. The `workspace-activity` Export contract is unaffected (still used by its own screen); 2b simply does not depend on it for rendering anymore. (GAP-002 is now moot for this spec.)
- **`ForYouContent` component** — consumed by `your-activity-actions:S-002` (AS-011) by mounting `your-activity-inbox` (2a)'s standalone `ForYouContent` as tab 1. Produced by 2a (for-you-content.tsx, locked 2026-06-23). ✔ locked (GAP-003 resolved). If 2b ships first the For-you tab is empty until 2a lands (the tab shell still works).

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| For-you components | `apps/web/src/features/your-activity/` (from spec 2a) | compose into tab 1 of the shell (AS-011); do not re-implement |
| Day-group + chip rendering | `apps/web/src/features/your-activity/` / `features/activity/` (workspace-activity, spec 1) | reuse the row/day-group/meta-chip rendering for the Your-actions list |
| `Tabs` | `apps/web/src/components/ui/tabs.tsx` | reuse for the For you / Your actions tab bar |
| `EmptyState` / `ErrorState` / `Skeleton` | `apps/web/src/components/*` | reuse for empty / error / loading states |
| `Avatar` / `Badge` / `Icon` / `Card` | `apps/web/src/components/**` | reuse for rows, chips, detail |

### System Impact & Technical Risks

- **`activity` table + repo** `workspace-activity` (spec 1) — the source. `/api/me/activity` reuses the activity read repo with an `actorUserId = caller` filter (instead of the workspace-scoped filter). HARD dependency (C-005, GAP-001): spec 1 must be built first.
- **Account-scoped route pattern** `apps/backend/src/routes/me.ts` / `notifications.ts` (`/api/me/*`, user-scoped, no `/w/:id`) — mirror this for `/api/me/activity` (session-gated, scoped to `actor.userId`). Reuse `paginationQuery`/`paginate` + `apiEnvelope`.
- **2a For-you components** `your-activity-inbox` (spec 2a) — composed into tab 1. If 2b builds before 2a, the For-you tab is empty until 2a lands (the shell still works).
- **Risk — read-time access on own history (C-002):** an action on a doc the caller lost access to must not leak current content via the quote/open-doc; reuse `resolveAccess` for the deep-link/quote gating (the row itself stays — it's the caller's own history).

## Not in Scope

- **For-you inbox content** — owned by `your-activity-inbox` (2a); this spec only composes it into tab 1.
- **`@`-mentions** — separate spec 3.
- **Any write/action on a Your-actions row** — it is read-only history (C-001); no undo/redo/delete of past actions.
- **A separate `activity` data model** — none; reuses `workspace-activity`'s table.
- **Realtime** — manual refresh only, consistent with the rest of the activity surfaces.

## Gaps

GAP-001 (status: open): The Your-actions feed depends on the `workspace-activity` `activity` table + emit (+ the new `(actorUserId, createdAt)` index, + `actorUserId` set on all 5 own-action kinds, + a renderable version label in publish `meta`), none built yet. `/api/me/activity` has no source until spec 1 ships. Build order: `workspace-activity` → this spec. Owner: build sequencing. Source: spec split + /mf-challenge 2026-06-23 (assumption lens, H3).

GAP-002 (status: resolved): `workspace-activity` now declares its feed/row/chips/detail components + read repo as composable/rows-as-props (its Export contract + Linked Fields, 2026-06-23) — 2b reuses them (C-007). Locked cross-spec.

GAP-003 (status: resolved): `your-activity-inbox` (2a) now builds + exports a standalone `ForYouContent` (for-you-content.tsx) for 2b's tab 1 (its Linked Fields + S-001 files, 2026-06-23). Locked cross-spec.

GAP-004 (status: deferred): The read-time access genericize (C-002) runs a `resolveAccess` per row; across a user's many workspaces this is a per-row cost on every page load. Deferred — batch/cache later if it measurably slows the feed (mirrors `workspace-activity`:GAP-001). Owner: build-time. Source: /mf-challenge 2026-06-23 (security + scope lenses, M1).

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-23 | Initial creation (personal page split — spec 2b Your-actions feed + the two-tab shell; reads `workspace-activity` activity table filtered to actorUserId=me) | -- |
| 2026-06-23 | Minor — GAP-002 + GAP-003 resolved: `workspace-activity` locked its feed-component export contract; `your-activity-inbox` (2a) locked the `ForYouContent` export. Linked Fields + Build Order updated to ✔. No AS change. | cross-spec lock |
| 2026-06-24 | Major (snapshot 2026-06-24-pre-personal-fidelity.md) — **C-007 REVERSED (prototype fidelity, product owner):** Your-actions is built from the personal `.me-*` component family to match `personal.jsx` pixel-for-pixel (per-day bordered cards, type-toned node icons, NO actor avatar/name, NO event counts, prototype chip row; detail = personal `.me-detail` look), NOT the workspace-activity feed components. Read side still reuses the `activity` table + `actorUserId` query. Updated S-001 description, C-007, AS-005, Linked Fields (dropped the workspace-component reuse dependency; GAP-002 moot). The found-at-E2E driver: the reused workspace feed rendered a visibly different surface (flat list, event counts, avatars). | prototype pixel-diff 2026-06-24 |
| 2026-06-23 | Major (snapshot 2026-06-23-pre-challenge.md) — /mf-challenge 3-lens hardening: S-001 restructured to a THIN CONSUMER reusing spec 1's feed components (C4, C-007) — no feed rebuild; Data Model (workspaceName/docTitle are read-time ENRICHMENT not stored — C1; +`(actorUserId, createdAt)` index — C2); C-001 (IDOR: session-derived actorUserId, null-actor excluded); C-002 (genericize ALL doc/workspace-derived display on access loss, not just quote/link — H1); +C-006 (current-member read-time filter); C-003 (+offset-drift caveat); +AS-012 (IDOR); AS-005 (reused detail), AS-006 (genericize); Linked Fields (component reuse + `actorUserId`/version-label emit deps + ForYouContent export); +GAP-002 (spec-1 component export), GAP-003 (2a ForYouContent export), GAP-004 (per-row access cost, deferred); Build Order note. AS 11→12. | /mf-challenge 2026-06-23 |
