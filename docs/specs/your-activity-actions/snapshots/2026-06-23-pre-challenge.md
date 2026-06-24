# Snapshot: Your Activity — Your-actions feed
**Date:** 2026-06-23
**Ref:** /mf-challenge (3-lens adversarial review)
**Reason:** M1/M4/M5 (S-001 restructured to a thin consumer; AS reworked), M6 (+C-006/C-007/C-008, C-001/C-002/C-003 changed) — security + reuse + cross-spec hardening.

---

# Spec: Your Activity — Your-actions feed

**Created:** 2026-06-23
**Last updated:** 2026-06-23
**Status:** Draft
**Snapshot limit:** 5

## Overview

The second tab of the account-scoped **"Your activity"** page (`/me/activity`) — **Your actions** — a cross-workspace, read-only feed of the things the signed-in user themselves did (published, commented, resolved, shared, invited), newest-first and day-grouped. Built from the `Anchord-Design/personal.jsx` prototype (`MY_ACTIVITY`). This spec also introduces the two-tab page shell that wraps the sibling **For you** inbox (`your-activity-inbox`, 2a) as the first tab.

This is **spec 2b of the personal page**. Its data source is the `activity` table owned by `workspace-activity` (spec 1), filtered to `actorUserId = me` across every workspace the user belongs to, served by a NEW account-scoped endpoint `GET /api/me/activity`. **It HARD-DEPENDS on `workspace-activity` being built** (no activity table → no source). It is NOT an inbox — there is no unread/mark concept; it is the user's own history.

**Relationship to 2a (shell ownership, M7):** `your-activity-inbox` (2a) ships the For-you content as standalone components on `/me/activity` with no tab bar. THIS spec (2b) introduces the two-tab bar (**For you** | **Your actions**), composing 2a's For-you components as tab 1 and the new Your-actions feed as tab 2. The tab container is built exactly once — here.

## Data Model

No new tables. Reuses the `activity` table from `workspace-activity` (spec 1):

- **`GET /api/me/activity`** (new, account-scoped) — returns the caller's own activity rows: `WHERE actorUserId = <caller>`, across every workspace the caller is a member of, newest-first, paginated. Each row carries the fields `workspace-activity` already persists: `type`, `workspaceId`/`workspaceName`, `docId`/`docTitle`, `version`, `summary`/`target`, `meta` (publish `from/to/adds/dels`; share `access/role`; invite `role/pending`), `createdAt`. No write surface.
- The fields above are a **Linked Field** dependency on `workspace-activity` (see Linked Fields) — they must be produced by its emit and persisted in the `activity` table.

## Stories

### S-001: See my own activity across workspaces (P0)

**Description:** As a signed-in user, I open the **Your actions** tab and see a newest-first, day-grouped feed of what I've done — published, commented, resolved, shared, invited — across every workspace I'm in, each row showing the workspace, doc, and action-specific detail, so I have one personal record of my work.
**Source:** `Anchord-Design/personal.jsx` + `personal-data.jsx` (`MY_ACTIVITY`, cross-workspace own-actions); docs/explore/workspace-activity.md (Personal page split — "Your actions" = `activity WHERE actorUserId = me`).
**Applies Constraints:** C-001, C-002, C-003, C-005

**Execution:**
- `depends_on:` none *(in-spec; cross-spec: hard-depends on `workspace-activity` — the `activity` table + emit must exist, see Linked Fields)*
- `parallel_safe:` false
- `files:` apps/backend/src/routes/me.ts or a new account-scoped activity route (`GET /api/me/activity`), apps/backend/src/activity/ (a read filtered to `actorUserId`, reuse the workspace-activity repo), apps/web/src/features/your-activity/ (Your-actions list + row + detail; reuse day-group + chip rendering from the For-you / workspace-activity components)
- `autonomous:` true
- `verify:` as a user who published in workspace A and commented in workspace B, GET `/api/me/activity` → both events appear newest-first, each with its workspace; request the next page → older events.

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

AS-005: Opening an action shows its detail and links to the doc
- **Given:** a share action on a doc
- **When:** I open the row
- **Then:** the detail shows the workspace, doc, when, and the action-specific detail (e.g. access · role for a share), with an "Open in doc" link to the target
- **Data:** share "Anyone with link" · commenter on "Auth & invite flows"

AS-006: An action on a doc I no longer have access to still lists, but degrades
- **Given:** I commented on a doc that was later set restricted / I was removed from its workspace
- **When:** I view Your actions
- **Then:** the action still appears (it is my own history), but "Open in doc" and any stored quote degrade gracefully rather than exposing current content (read-time access)
- **Data:** my comment on a now-inaccessible doc

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

C-001: Your actions is the caller's OWN activity (`actorUserId = caller`), across every workspace they're a member of; read-only — there is no action on a row (it is history, not an inbox). (AS-001, AS-002)

C-002: A row is always visible to its actor (you see what you did), but the "Open in doc" deep-link and any stored quote/snippet are resolved against the caller's CURRENT access to the target doc — if access was lost, the action still lists but the link/quote degrade gracefully (read-time access, mirrors `workspace-activity`:C-001/C-003). (AS-006)

C-003: The feed is paginated recent-first; day grouping is client-side over the flat paged list; "Today/Yesterday" in the VIEWER's timezone (mirrors `workspace-activity`:C-007). (AS-003, AS-004)

C-004: No unread / mark-read / count concept on Your actions — that belongs only to the For-you inbox (2a). The tab shows no unread pill. (AS-009)

C-005: The Your-actions feed has NO data until `workspace-activity` (spec 1) is built and emitting — `/api/me/activity` reads the `activity` table it owns. This spec cannot function before spec 1 (Linked Field + GAP-001). (AS-001)

## Linked Fields

- **`activity` rows** (`actorUserId`, `workspaceId`/`workspaceName`, `type`, `docId`/`docTitle`, `version`, `summary`/`target`, `meta`, `createdAt`) — consumed by `your-activity-actions:S-001` (AS-001..006) on the `GET /api/me/activity` read (persisted in the `activity` table + served on every read). Produced by **`workspace-activity`** emit (its S-001 comment/version/people events; S-005 version events; S-006 sharing/people events), persisted in the `activity` table. ✔ surface (persisted table) + lifecycle (served on read) match — **BUT the table does not exist until spec 1 is built → GAP-001**. Seam test: with `workspace-activity` built + emitting, after I publish, `GET /api/me/activity` returns my publish row with `meta.from/to/adds/dels`. Real cross-spec integration — never mocked.
- **For-you components** — consumed by `your-activity-actions:S-002` (AS-011) by composing `your-activity-inbox` (2a)'s For-you component(s) into tab 1. Code-level composition (not a data field); 2a must export them. ✔ if 2a built first; if 2b ships first the For-you tab is empty until 2a lands (acceptable — the tab shell still works).

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

GAP-001 (status: open): The Your-actions feed depends on the `workspace-activity` `activity` table + emit, which is not built yet. `/api/me/activity` has no source until spec 1 ships. Build order: `workspace-activity` → this spec. Owner: build sequencing. Source: spec split (2b depends on spec 1) — see Linked Fields.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-23 | Initial creation (personal page split — spec 2b Your-actions feed + the two-tab shell; reads `workspace-activity` activity table filtered to actorUserId=me) | -- |
