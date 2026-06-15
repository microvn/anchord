# Spec: versioning-diff-ui

**Created:** 2026-06-14
**Last updated:** 2026-06-14 (rev 2)
**Status:** Draft

## Overview

The frontend **version history panel + diff view** — the consumer side of the built
`versioning-diff` backend (producer). From the viewer top bar's version button, a reader opens a
right-hand **VersionHistoryPanel** that lists every immutable version newest-first as a timeline
(version label, time, publisher, the current one marked), and from each non-current row can
**Compare** (opens a full-screen **DiffOverlay**) or **Restore** (append-copy → a new version). The
DiffOverlay picks any two versions and shows a two-level diff: a **Source** line-diff
(added/removed lines) and a **Rendered** side-by-side of the two renders; identical versions show a
"No differences" state and an image doc shows the two images side-by-side (no source tab).

This spec owns only the **history panel + diff overlay + their wiring** from the viewer. It does
NOT own creating versions (that happens server-side when content is published), the re-anchor
matcher, the doc viewer itself, or the per-version content render route. It consumes three backend
reads/writes (`GET …/versions`, `POST …/versions/:n/restore`, `GET …/diff`) and the `version`
field on the viewer doc read.

_Sibling of `annotation-core-ui` (the viewer shell whose `VersionButton` opens this panel) and
`sharing-permissions-ui` (the other top-bar panel). Backend contract: `versioning-diff.md`._

## Data Model

No persistent data — a client. The backend is the source of truth; every read is gated server-side
(viewer+ for history/diff, editor for restore). Reads (TanStack Query, keyed by `docSlug`):

- **version history** — `GET /api/w/:ws/docs/:slug/versions` → `{ items: [{ version, createdAt,
  publishedBy: { id, name }, isCurrent }], pagination }` (paginated, newest-first; backend
  `versioning-diff:S-002`). The `publishedBy` name is resolved server-side (fallback "Unknown");
  shipped — see GAP-001.
- **diff** — `GET /api/w/:ws/docs/:slug/diff?from=&to=` → `{ mode: "text" | "image", identical?,
  changeCount?, lines?: [{ type: "added" | "removed" | "context", text }], renderPair: [urlA, urlB] }`
  (backend `versioning-diff:S-004`).

Mutations:
- **restore** — `POST /api/w/:ws/docs/:slug/versions/:n/restore` → 201 `{ version, previousVersion }`
  (backend `versioning-diff:S-003`). On success the history + the viewer doc read are invalidated so
  the new current version shows.

Client state held while open: panel-open / overlay-open, the selected `from`/`to` version numbers,
the active diff tab (`source | rendered`). The default Compare picks `from = the row clicked`,
`to = the current version` (`doc.version` from the viewer read).

## Producer status (backend prerequisites — MET 2026-06-14)

Both backend prerequisites this FE depended on have SHIPPED (`versioning-diff` Mode C + build,
2026-06-14) — no FE blockers remain:
- **per-version render** (GAP-002 resolved): the diff `renderPair` now returns one `/v/:versionId`
  reference per compared version, served by the existing `/v/:id` content route → the Rendered tab
  (AS-008), identical-but-rendered (AS-012), and image pair (AS-013) iframes load that exact version.
- **publisher name** (GAP-001 resolved): the history read returns `publishedBy: { id, name }`
  (resolved server-side, fallback "Unknown") → the timeline shows the publisher name, no id stopgap.

## Stories

### S-001: Open and browse version history (P0)

**Description:** As someone with at least view access to an open doc, I click the version button in
the viewer top bar and a right-hand panel opens listing every version newest-first as a timeline —
each with its version label, relative time, and publisher; the current version is marked "Current".
Each non-current row offers Compare and Restore; the current row offers Compare only. On a narrow
screen the panel is full-width.
**Source:** Backend `versioning-diff:S-002` (AS-003 history) + C-002 (current = highest). Replaces the
viewer top-bar placeholder `onVersion` (`apps/web/src/features/viewer/components/viewer-screen.tsx:291`
toast "Version history isn't available yet"). Prototype: `Anchord-Design/viewer-dialogs.jsx`
`VersionHistory` (P17), styled `viewer-dialogs.css` `.vh-panel`/`.vh-item`/`.vh-rail`.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` new `apps/web/src/features/versioning/version-history-panel.tsx`,
  `features/versioning/version-item.tsx`, `features/versioning/client.ts`; wire
  `features/viewer/components/viewer-screen.tsx` (`onVersion` → open the panel, replacing the toast);
  reuse `components/ui/sheet.tsx` (≤599 full-width) + the relative-time + initials helpers
- `autonomous:` true
- `verify:` open a doc with versions 1–4 → click the version button → the panel lists v4 (Current) ·
  v3 · v2 · v1 with time + publisher, newest-first; the current row has no Restore; resize ≤599 → the
  panel is full-width.

**Acceptance Scenarios:**

AS-001: Opening the panel lists versions newest-first with the current one marked
- **Given:** an open doc with versions 1, 2, 3, 4 (4 is current)
- **When:** I click the version button in the top bar
- **Then:** a right-hand panel opens listing v4, v3, v2, v1 newest-first, each showing its version
  label, relative time, and publisher; v4 shows a "Current" marker
- **Data:** 4 versions, current = v4

AS-002: The current version offers Compare but not Restore
- **Given:** the panel is open
- **When:** I look at the current (v4) row vs an older (v1) row
- **Then:** v1 offers both Compare and Restore; v4 offers Compare only (restoring the current version
  is a no-op, so Restore is not shown on it)
- **Data:** current row vs older row

AS-003: Responsive — the panel is full-width on a narrow screen
- **Given:** the version panel is reachable
- **When:** the viewport width is ≤599px and the panel opens
- **Then:** it renders full-width (not a fixed 340px side drawer); ≥600px it is the side panel
- **Data:** 360px and 768px widths

AS-004: A history that fails to load shows an error, not an empty list (error path)
- **Given:** I open the version panel
- **When:** `GET …/versions` fails or is refused
- **Then:** the panel shows an error state ("couldn't load version history"), never a misleading empty
  "no versions" list (the doc is already open, so it has at least one version)
- **Data:** versions read fails

### S-002: Restore a previous version (P0)

**Description:** As an editor, I click Restore on an older version in the panel; the system
append-copies that version's content as a new current version (the old versions stay), shows a
confirming toast, and the panel + viewer refresh to the new current. I never overwrite or delete a
version. A refused restore shows an error and adds no version.
**Source:** Backend `versioning-diff:S-003` (AS-004 restore append-copy) + C-004 (restore deletes no
version). Prototype: `VersionHistory` `.vh-actions` Restore (`onToast('Restored '+label+' as a new
version')`).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/versioning/version-item.tsx` (Restore action),
  `features/versioning/client.ts` (`restoreVersion`); invalidate the versions + viewer doc queries on
  success; `sonner` toast
- `autonomous:` true
- `verify:` at v4, click Restore on v1 → `POST …/versions/1/restore` fires → a "Restored v1 as a new
  version" toast → the panel refetches and shows a new current (v5) with v1–v4 still listed; force the
  POST to fail → an error toast, no new version added.

**Acceptance Scenarios:**

AS-005: Restoring an old version creates a new current version (happy path)
- **Given:** the panel is open on a doc at version 4
- **When:** the editor clicks Restore on version 1
- **Then:** `POST /api/w/:ws/docs/:slug/versions/1/restore` is called; on 201 a "Restored v1 as a new
  version" toast shows and the panel refetches — a new current (v5) appears at the top and v1, v2, v3,
  v4 remain in the list (nothing deleted)
- **Data:** restore v1 while at v4 → v5 current

AS-006: A refused restore shows an error and adds no version (error path)
- **Given:** the editor clicks Restore optimistically
- **When:** `POST …/restore` returns 403/404 or fails (e.g. not an editor, network)
- **Then:** an error toast shows ("couldn't restore this version") and no new version is added; the
  list returns to its prior state
- **Data:** restore refused

### S-003: Compare two versions — source + rendered (P0)

**Description:** As someone with at least view access, I click Compare on a version (or open the diff
view) and a full-screen overlay shows a two-level diff between two versions I pick: a **Source** tab
with a line-diff (added lines highlighted teal, removed lines red + struck through, monospace) and a
change count (+adds / −removed), and a **Rendered** tab with the two renders placed side-by-side
(before | after). Changing either version picker re-fetches the diff. On a narrow screen the rendered
pair stacks vertically.
**Source:** Backend `versioning-diff:S-004` (AS-006 two-level diff) + the two-level decision
(Clarifications). Prototype: `viewer-dialogs.jsx` `DiffView` (P18), styled `viewer-dialogs.css`
`.diff-overlay`/`.line-diff`/`.dline`/`.rendered-pair`.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` new `apps/web/src/features/versioning/diff-overlay.tsx`,
  `features/versioning/source-line-diff.tsx`, `features/versioning/rendered-pair.tsx`;
  `features/versioning/client.ts` (`getDiff`); reuse the viewer's HTML-sandbox iframe component
  (`features/viewer/components/html-sandbox-frame.tsx`) for the rendered panes + `components/ui/select.tsx`
  for the version pickers
- `autonomous:` true
- `verify:` open the panel, click Compare on v3 → the overlay opens comparing v3 → v4 with a Source
  line-diff (added/removed lines + a +N/−M count); switch to Rendered → the two renders show
  side-by-side; change the `from` picker to v2 → the diff re-fetches; resize ≤760 → the rendered pair
  stacks.

**Acceptance Scenarios:**

AS-007: Source tab shows a line-diff with a change count (happy path)
- **Given:** a doc with versions 3 and 4 that differ in a few passages
- **When:** I open Compare for v3 → v4 on the Source tab
- **Then:** the source line-diff shows added lines highlighted (teal) and removed lines highlighted
  (red, struck through) in monospace, with a change count of +adds / −removed in the header
- **Data:** v3→v4, 3 added / 1 removed line

AS-008: Rendered tab shows the two renders side-by-side
- **Given:** the diff overlay is open for v3 → v4
- **When:** I switch to the Rendered tab
- **Then:** the two rendered versions are shown side-by-side (before = v3 | after = v4), each in its
  own pane with a version label
- **Data:** v3 | v4 rendered

AS-009: Changing a version picker re-fetches the diff
- **Given:** the overlay is comparing v3 → v4
- **When:** I change the `from` picker to v2
- **Then:** `GET /api/w/:ws/docs/:slug/diff?from=2&to=4` is called and the diff updates to v2 → v4
- **Data:** from v3→v4 to v2→v4

AS-010: Responsive — the rendered pair stacks on a narrow screen
- **Given:** the overlay is open on the Rendered tab
- **When:** the viewport width is ≤760px
- **Then:** the two render panes stack vertically (before above after), not side-by-side
- **Data:** 360px width

AS-011: A diff with bad version refs surfaces an error (error path)
- **Given:** the overlay requests a diff for a version that does not exist
- **When:** `GET …/diff` is refused (bad version refs / not found)
- **Then:** the overlay shows an error state ("couldn't load this comparison"), never a blank or
  half-rendered diff
- **Data:** diff refused

### S-004: No-diff and image-diff states (P1)

**Description:** As a reader comparing versions, when the two versions are identical the Source tab
shows a "No differences" state (instead of an empty line-diff) BUT I can still switch to the Rendered
tab to see the two renders side-by-side; when the doc is an image doc I see the two images
side-by-side with no Source tab (images have no line-diff).
**Source:** Backend `versioning-diff:S-004` (AS-007 identical — rendered STILL shown, AS-008 image).
Decision 2026-06-14: AS-007 (rendered still shown) overrides the prototype's tab-hiding on identical
(AS / Constraints > prototype). Prototype: `DiffView` `.no-diff` state.

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` `apps/web/src/features/versioning/diff-overlay.tsx` (mode/identical branches),
  `features/versioning/rendered-pair.tsx`, new `features/versioning/image-diff-pair.tsx`
- `autonomous:` true
- `verify:` compare two identical versions → the Source tab shows "No differences" (change count
  shows 0) and the Rendered tab still renders both side-by-side; open Compare on an image doc → the
  two images show side-by-side with no Source tab.

**Acceptance Scenarios:**

AS-012: Comparing two identical versions — "No differences" on Source, render still available
- **Given:** two versions with identical content (e.g. after a restore)
- **When:** I compare them and the diff returns `identical: true`
- **Then:** the Source tab shows a "No differences" state (with the two version labels, change count 0),
  but the Rendered tab is still available and renders the two versions side-by-side (backend AS-007 —
  rendered still shown)
- **Data:** equal content_hash, changeCount 0

AS-013: Comparing two versions of an image doc shows images side-by-side
- **Given:** an image doc with two versions
- **When:** I compare them and the diff returns `mode: "image"`
- **Then:** the two images are shown side-by-side (no Source tab, no line-diff) using the `renderPair`
  URLs
- **Data:** two differing images

## Constraints & Invariants

FE-side mirrors of the backend constraints (the backend enforces; these govern what the panel/overlay
SHOW and SEND).

- C-001 (mirror of backend C-004): Restore is always append-copy — the FE offers only a non-destructive
  "Restore" that creates a NEW version; it never offers overwrite/delete, and after a restore it
  refetches so the new current shows while every older version stays in the list. (AS-005)
- C-002 (mirror of backend C-002): The current version (highest number) is marked "Current" and offers
  Compare but NOT Restore (restoring the current version is a no-op). (AS-001, AS-002)
- C-003: Compare is two-level — a Source line-diff tab and a Rendered side-by-side tab — for text docs;
  changing either version picker re-fetches. (AS-007, AS-008, AS-009)
- C-004: Source line-diff styling — added lines highlighted teal, removed lines highlighted red and
  struck through, monospace; the header shows +adds / −removed. (AS-007)
- C-005: An image-doc diff (`mode: "image"`) shows the two images side-by-side with NO Source tab
  (images have no line-diff); identical text versions (`identical: true`) show a "No differences" state
  on the Source tab (change count 0) BUT keep the Rendered tab available (backend AS-007 — rendered
  still shown; overrides the prototype's tab-hiding). (AS-012, AS-013)
- C-006: Responsive — the version panel is full-width ≤599px (a 340px side panel ≥600px); the rendered
  pair stacks vertically ≤760px. Uses the DESIGN.md system (teal accent, chrome recedes). (AS-003, AS-010)
- C-007: A history or diff read that fails/refuses shows an explicit error state, never a misleading
  empty list or blank diff; a refused restore rolls back (no version added) with an error toast. (AS-004,
  AS-006, AS-011)

## Linked Fields

`versioning-diff-ui` is the **consumer**; `versioning-diff` (backend) is the producer. Surface = the
typed Eden client `features/versioning/client.ts` calling the version/diff routes; lifecycle = on panel
open (history), on Compare/picker change (diff), and on Restore click (mutation, then refetch).

- `GET /api/w/:ws/docs/:slug/versions` → `{ items: [{ version, createdAt, publishedBy: { id, name },
  isCurrent }], pagination }` — consumed by S-001 (AS-001/002) on panel open. Produced by backend
  `versioning-diff:S-002`. ✔ surface (history read) match; ✔ the CODE now returns `publishedBy`
  as `{ id, name }` (resolved server-side, fallback "Unknown") — GAP-001 resolved.
  There is NO `note`/commit-message field → GAP-004 (note dropped, Not in Scope).
- `POST /api/w/:ws/docs/:slug/versions/:n/restore` → 201 `{ version, previousVersion }` — consumed by
  S-002 (AS-005/006). Produced by backend `versioning-diff:S-003`. ✔ match.
- `GET /api/w/:ws/docs/:slug/diff?from=&to=` → `{ mode, identical?, changeCount?, lines?, renderPair }`
  — consumed by S-003/S-004 (AS-007..013). Produced by backend `versioning-diff:S-004`. ✔ data shape
  match; ✔ `renderPair` now carries one `/v/:versionId` reference per compared version, served by the
  existing `/v/:id` content route → the Rendered tab + image pair iframes load the right version — GAP-002 resolved.
- `doc.version` (current version number) — consumed by S-001 (default Compare `to`) + S-003. Produced
  by the viewer doc read (`render-publish` / `annotation-core-ui` `ViewerDocResponse.doc.version`,
  `apps/web/src/features/viewer/client.ts`). ✔ field exists on the viewer read payload.

All routes are WORKSPACE-SCOPED in the backend CODE (`apps/backend/src/routes/versions.ts:247/287/301/331`);
the backend spec's `## API` table showing un-scoped `/api/docs/:slug/…` is STALE (GAP-003, same class
as `annotation-core-ui:GAP-001` / `sharing-permissions-ui:GAP-001`). FE pins the workspace-scoped path.

## UI Notes

Design: prototype `Anchord-Design/viewer-dialogs.jsx` `VersionHistory` (P17) + `DiffView` (P18) are
CANONICAL, styled by `viewer-dialogs.css` (`.vh-panel`, `.vh-item`, `.vh-rail`/`.vh-dot`/`.vh-line`,
`.vh-main`/`.vh-top`/`.vh-ver`/`.vh-time`/`.vh-author`/`.vh-actions`; `.diff-overlay`, `.diff-head`,
`.diff-title`, `.diff-picker`, `.diff-count`, `.diff-tabs`/`.diff-tab`, `.diff-body`, `.line-diff`,
`.dline` (`.add`/`.del`/gutter), `.rendered-pair`/`.rp-col`/`.rp-head`/`.rp-body`, `.no-diff`); tokens
from `tokens.css` + `viewer.css`. Precedence: AS / Constraints > prototype > Tree. All `[N]`.

- `VersionHistoryPanel` `[N]` *(`.vh-panel` right side drawer ≥600; **full-width sheet** ≤599 — C-006;
  scrim; header: clock icon · "Version history" · close)*
  - `VersionList` `[N]` → `VersionItem` `[N]` *(`.vh-item`, `.current` on the current row)*: `.vh-rail`
    timeline (`.vh-dot` + `.vh-line`) · `.vh-ver` version label · `CurrentBadge` *(`.badge.accent`,
    current only)* · `.vh-time` relative time · `.vh-author` publisher · `.vh-actions`: `CompareButton`
    *(`.tlink.accent`)* + `RestoreButton` *(`.tlink`; hidden on the current row — C-002)*
    - *Note: prototype `.vh-note` (commit message) is DROPPED — no backend data (GAP-004).*
- `DiffOverlay` `[N]` *(`.diff-overlay` full-screen; `grid-template-rows: auto 1fr`)*
  - `DiffHeader` `[N]` *(`.diff-head`: back chevron · "Compare versions" · `VersionPicker` from →
    to (`.mini-select` ×2) · `ChangeCount` `.diff-count` (+adds / −removed) · `DiffTabs`
    Source | Rendered — shown for text docs INCLUDING identical (Rendered stays available, C-005);
    only `mode:image` drops the Source tab)*
  - `SourceLineDiff` `[N]` *(`.line-diff`; `.dline` with `.add` teal / `.del` red+strike / context; mono
    `.gutter` +/−)* — C-004
  - `NoDiffState` `[N]` *(`.no-diff`: check icon · "No differences" · "vX and vY are identical" —
    rendered in the Source tab body when `identical`, NOT replacing the whole overlay; overrides the
    prototype which hid the tabs)*
  - `RenderedPair` `[N]` *(`.rendered-pair`: two `.rp-col` panes before | after, each a sandbox iframe
    `src` = the version's `renderPair` reference; stacks ≤760 — C-006)*
  - `ImageDiffPair` `[N]` *(image doc: two images side-by-side, no Source tab — C-005; not in the
    prototype DiffView, new)*

Entry point: the viewer top bar's version button (`features/viewer/components/viewer-top-bar.tsx`
`vt-version` / `onVersion`, currently wired to a placeholder toast in `viewer-screen.tsx:291`) opens
`VersionHistoryPanel`; a row's Compare opens `DiffOverlay`. Both replace the placeholder.

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| Version button (placeholder `onVersion`) | `apps/web/src/features/viewer/components/viewer-top-bar.tsx` (`vt-version`) | wire it to open the VersionHistoryPanel (S-001) |
| Viewer screen (passes the `onVersion` placeholder toast) | `apps/web/src/features/viewer/components/viewer-screen.tsx:291` | host the panel + overlay open-state; pass `doc.version` as the Compare `to` default |
| Viewer doc read (`doc.version`) | `apps/web/src/features/viewer/client.ts` (`ViewerDocResponse`) | consume `version` for the default Compare target + the "Current" check |
| HTML sandbox iframe | `apps/web/src/features/viewer/components/html-sandbox-frame.tsx` | reuse for the rendered-pair / image-diff panes (per-version `src` from `renderPair`) |
| Sheet primitive (full-screen ≤599) | `apps/web/src/components/ui/sheet.tsx` | the VersionHistoryPanel shell ≤599 (responsive) |
| Select primitive | `apps/web/src/components/ui/select.tsx` | the diff version pickers (`.mini-select`) |
| Avatar / initials helpers | `apps/web/src/lib/initials.ts` (`initials`, `avatarColor`) | publisher avatar from `publishedBy.name` |
| Typed-client pattern (Eden treaty) | `apps/web/src/features/viewer/client.ts`, `features/sharing/client.ts` | new `features/versioning/client.ts` follows the same `treaty` + `EdenResult<T>` convention |
| toast | `sonner` (`import { toast }`) | restore success/error toasts |

### System Impact & Technical Risks

- The backend producer (`versioning-diff`) is built and serves WORKSPACE-SCOPED routes
  (`apps/backend/src/routes/versions.ts`): `GET …/versions`, `POST …/versions/:n/restore`,
  `GET …/diff`. This is the FE consumer; both prerequisites have shipped (GAP-001/002 resolved).
- **Rendered side-by-side (GAP-002 resolved):** the diff `renderPair` carries one `/v/:versionId`
  reference per compared version, served by the existing `/v/:id` route — the Rendered tab (S-003
  AS-008) + image pair (S-004 AS-013) load that exact version.
- **Publisher display (GAP-001 resolved):** the history read returns `publishedBy: { id, name }`
  (resolved server-side, fallback "Unknown") — the timeline renders the name.

## Not in Scope

- Creating a version (append-on-publish), the re-anchor matcher + the detached list — `versioning-diff`
  (backend) + `annotation-core` / `annotation-core-ui`. This FE only reads history + diff and triggers
  restore; re-anchor fires server-side inside the restore/publish endpoints.
- Version labels / names / commit-messages — backend has none in v0 (`versioning-diff` Not in Scope);
  the prototype's `.vh-note` is dropped (GAP-004).
- A link pinned to a specific version (`/d/:slug@v2`) — deferred (backend Not in Scope); v0 always
  shows the latest.
- Overlay/swipe for image diff, DOM-aware structural diff, inline merged rich-diff — deferred (backend
  Not in Scope); v0 is two-level side-by-side only.
- Pagination UI for very long histories — v0 reads the paginated endpoint but shows a single scrolling
  list (`.vh-list thin-scroll`); a "load more" affordance is deferred (GAP-005).

## Gaps

- GAP-001 (status: resolved — 2026-06-14): the backend history read now enriches `publishedBy` to
  `{ id, name }` (resolved server-side from the author id, fallback "Unknown") — `versioning-diff:S-002`
  AS-011/012, C-006. The timeline renders the publisher name directly (no id stopgap). Built in
  `features/versioning` S-001.
- GAP-002 (status: resolved — 2026-06-14): the diff `renderPair` now carries one per-version content
  reference (`/v/:versionId`) per compared version, served by the EXISTING `/v/:id` route (it already
  resolves any version by its row id) — `versioning-diff:S-004` AS-013, C-007. No new route was needed;
  the original `/v/:docId/:n` shape was the bug. The Rendered tab (AS-008), identical-but-rendered
  (AS-012), and image pair (AS-013) load the right version. Built in `features/versioning` S-003/S-004.
- GAP-003 (status: resolved — 2026-06-14, code-verified): the backend CODE serves the workspace-scoped
  paths `/api/w/:workspaceId/docs/:slug/{versions,versions/:n/restore,diff}`
  (`apps/backend/src/routes/versions.ts:247/287/301/331`). The backend spec's `## API` table showing
  un-scoped `/api/docs/:slug/…` is STALE (same class as `annotation-core-ui:GAP-001`). FE pins the
  workspace-scoped path. Follow-up: `/mf-plan` the backend `versioning-diff.md` API table.
- GAP-004 (status: deferred — owner: backend): version note/commit-message — backend has none in v0
  (`versioning-diff` Not in Scope). v0 FE behaviour is DEFINED: the timeline shows NO note (the
  prototype `.vh-note` is dropped). When the backend adds version messages, the FE can show them.
- GAP-005 (status: deferred): history "load more" / pagination UI — v0 shows a single scrolling list
  even though the endpoint is paginated; a load-more affordance lands when histories grow large enough
  to need it.

## Consistency Checks

- CC1 (every AS traces to a story): AS-001..004 → S-001; AS-005/006 → S-002; AS-007..011 → S-003;
  AS-012/013 → S-004. ✔
- CC2 (every P0 has a happy + an error path): S-001 (AS-001 happy / AS-004 read-fail); S-002 (AS-005
  happy / AS-006 refused); S-003 (AS-007/008 happy / AS-011 refused). ✔
- CC3 (every consumed backend field is in Linked Fields): `GET …/versions`, `POST …/restore`,
  `GET …/diff`, `doc.version` all listed; path-scoping pinned (GAP-003). ✔
- CC4 (constraints trace to AS): C-001→AS-005, C-002→AS-001/002, C-003→AS-007/008/009, C-004→AS-007,
  C-005→AS-012/013, C-006→AS-003/010, C-007→AS-004/006/011. ✔
- CC5 (no backend relitigation): version model, restore-append-copy, two-level diff, identical/image
  modes are CONSUMED as built; no backend decision is changed. ✔
- CC6 (unspecified/blocking outcomes recorded as GAPs): publisher name (GAP-001 resolved), per-version
  render (GAP-002 resolved), stale API table (GAP-003 resolved), note dropped (GAP-004 deferred),
  pagination UI (GAP-005 deferred). ✔
- CC7 (prototype cited as canonical): UI Notes pin `viewer-dialogs.jsx` P17/P18 + `.css` classes. ✔
- CC8 (responsive mandate): AS-003 (panel full-width ≤599) + AS-010 (rendered pair stacks ≤760) +
  C-006. ✔
- CC9 (reuse over rebuild): UI Inventory reuses the viewer sandbox iframe, `ui/sheet` + `ui/select`,
  `lib/initials`, the Eden client convention, the existing version button. ✔

## Clarifications — 2026-06-14

Decisions taken before finalizing the draft:
- **Identical versions keep the Rendered tab:** backend AS-007 ("rendered side-by-side still shown")
  overrides the prototype's tab-hiding on identical. The Source tab shows "No differences"; Rendered
  stays available. (AS-012, C-005)
- **Publisher name:** the backend enriches the history read's `publishedBy` to `{ id, name }` (rather
  than the FE doing a members lookup) — one round-trip, matches the prototype. Owed backend change,
  recorded as a Prerequisite + GAP-001.
- **Per-version render route is a hard prerequisite:** the Rendered tab + image pair are build-blocked
  until the backend serves per-version content (GAP-002), like `annotation-core-ui`'s block-id
  prerequisite. History + restore + the Source-tab diff ship independently.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-14 | Initial creation — FE version-history panel + diff overlay, consumer of the built `versioning-diff` backend (open/browse history, restore append-copy, two-level diff source+rendered, no-diff/image states); GAP-001 publisher-name + GAP-002 per-version render URL owed; GAP-003 stale API table resolved | -- |
| 2026-06-14 | Clarifications resolved: identical keeps Rendered tab (backend AS-007 > prototype; AS-012/C-005 updated); publishedBy→{id,name} enrichment + per-version render route promoted to Prerequisites (build-blockers); S-003/S-004 marked BLOCKED-until | -- |
| 2026-06-14 | Minor: backend prerequisites SHIPPED → GAP-001 (publishedBy {id,name}) + GAP-002 (renderPair per-version /v/:versionId) flipped to resolved; removed the Prerequisites section + S-003/S-004 BLOCKED-until notes; Linked Fields ✘→✔; UI Notes/Inventory/System-Impact caveats cleared. No AS/constraint/flow change. Built in `features/versioning` (S-001..004) | -- |
