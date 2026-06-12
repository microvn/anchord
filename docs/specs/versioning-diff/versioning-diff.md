# Spec: versioning-diff

**Created:** 2026-06-07
**Last updated:** 2026-06-07
**Status:** Draft

## Overview

Each new content submission creates an immutable version; view history, restore an old
version (append-copy), and compare two versions (two-level: source diff + rendered
side-by-side). This is the foundation for "anchors durable across versions" — when a new
version is created, the previous version's annotations are re-anchored.

_Ships alongside `annotation-core` (sibling): this cluster defines the re-anchor
**trigger**; `annotation-core` defines the matching **algorithm** + annotation model. See
`## Linked Fields`._

## Data Model

- **doc_versions** (defined in `render-publish`): `version` int starting at 1, `content`,
  `content_hash`, `published_by`, `created_at`, unique (doc_id, version).
- Title lives on `docs` (mutable), NOT versioned.
- Annotations anchor to the **doc** + an anchor descriptor (defined in `annotation-core`),
  re-resolved on every version.

## Stories

### S-001: Append a new version on content update (P0)

**Description:** As an author, when I submit new content for a doc, the system creates a
new immutable version instead of overwriting, and the newest version becomes the current
one.
**Source:** docs/explore/versioning-diff.md#decisions (item 1, content creates a version).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (expected `src/services/version.*`, `src/db/schema`)
- `autonomous:` true
- `verify:` submit new content for a doc at v2 → v3 appears, current=v3, v2 still exists.

**Acceptance Scenarios:**

AS-001: Submitting new content creates a new immutable version
- **Given:** doc "Payment Spec" at version 2
- **When:** the author submits edited content
- **Then:** version 3 is created (v2 not overwritten); current = v3
- **Data:** v3 content differs from v2

AS-002: Editing the title does not create a version
- **Given:** doc at version 2
- **When:** the author changes the title from "Payment Spec" to "Payment Spec v2"
- **Then:** the title changes on the doc; NO new version is created (still at v2)
- **Data:** title changed only, content unchanged

### S-002: View version history (P1)

**Description:** As someone with permission to view the doc, I open the history and see a
list of versions with the timestamp and publisher.
**Source:** docs/explore/versioning-diff.md#ui-expectation.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-003: List version history
- **Given:** doc has versions 1, 2, 3
- **When:** the user opens "Version history"
- **Then:** v1, v2, v3 are shown with their creation time and publisher, current clearly marked

### S-003: Restore a previous version (P0)

**Description:** As an author, I restore an old version; the system creates a new version
that copies that version's content, keeping the entire history intact.
**Source:** docs/explore/versioning-diff.md#decisions (item 2, restore append-copy).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true
- `verify:` at v3, restore v1 → v4 appears with content = v1; v2, v3 still exist.

**Acceptance Scenarios:**

AS-004: Restore creates a new version copying the old content
- **Given:** doc at version 3
- **When:** the author clicks "Restore version 1"
- **Then:** version 4 is created with content equal to version 1; current = v4; v2 and v3
  remain in the history
- **Data:** restore v1 while at v3

AS-005: Restore triggers re-anchor like any new version
- **Given:** doc at version 3 with annotations anchored on v3
- **When:** the author restores v1 (creating v4)
- **Then:** annotations are re-anchored to v4 using the same new-version mechanism (see
  `annotation-core:S-005`)
- **Data:** v4 = v1 content, differs from v3

### S-004: Compare two versions (P0)

**Description:** As someone with permission to view the doc, I pick any two versions to
compare and see both the source differences and the two renders placed side-by-side.
**Source:** docs/explore/versioning-diff.md#decisions (item 4, two-level diff).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (expected diff uses `@pierre/diffs` + rendered side-by-side reuses viewer)
- `autonomous:` true

**Acceptance Scenarios:**

AS-006: Two-level diff for HTML/Markdown
- **Given:** doc has version 2 and version 3 with different content
- **When:** the user selects "Compare v2 ↔ v3"
- **Then:** the source differences are shown (added/removed lines highlighted) + the two
  renders placed side-by-side (v2 | v3)
- **Data:** v2 and v3 differ in a few text passages

AS-007: Comparing two identical versions
- **Given:** two versions with identical content (e.g. after a restore)
- **When:** the user compares those two versions
- **Then:** "No differences" is reported; the rendered side-by-side is still shown
- **Data:** the two versions have equal content_hash

AS-008: Comparing two versions of an image doc
- **Given:** an image doc has two versions
- **When:** the user compares the two versions
- **Then:** the two images are shown side-by-side, no text diff
- **Data:** the two images differ

### S-005: Trigger re-anchor on new version (P0)

**Description:** As someone who left a comment, when the author publishes a new version,
my comment automatically follows to the new content if it can still be anchored; if not,
it goes into the "detached" list instead of disappearing.
**Source:** docs/explore/versioning-diff.md#decisions (item 3, re-anchor + detached).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (coordinated with annotation-core)
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: Annotations that match carry forward to the new version
- **Given:** doc at v2 has 6 annotations; the author creates v3 with light edits to a few passages
- **When:** version 3 is created
- **Then:** the annotations that can be re-resolved (see `annotation-core:S-005`) are
  displayed on v3
- **Data:** 5/6 anchored passages still match

AS-010: Annotations that cannot be anchored go into the detached list
- **Given:** the same situation, 1 passage is removed entirely from the content
- **When:** version 3 is created
- **Then:** that annotation is marked `is_orphaned` and put into the "detached" list to
  relocate/resolve; it is not lost
- **Data:** 1/6 passages disappears in v3

## Constraints & Invariants

- C-001: Versions are immutable — after creation, content/hash/author/timestamp are not edited. (AS-001, AS-004)
- C-002: Versions are numbered with a continuously incrementing counter from 1, no reuse; current = highest number. (AS-001, AS-003)
- C-003: Only a content change creates a version; title/metadata changes do not. (AS-002)
- C-004: Restore deletes no version — it always appends. (AS-004)
- C-005: Every time a new version is created (including restore) → trigger re-anchor for the
  previous version's annotations; no match → detached, not lost. (AS-005, AS-009, AS-010)

## Linked Fields

- **"new version created" (event/trigger)** — produced by versioning-diff:S-001
  (AS-001) and S-003 (AS-004, restore also creates a version). Consumed by
  `annotation-core:S-005` to run re-resolve. ✔ producer has AS creating a version on both
  paths (update + restore).
- **anchor descriptor + matching result (carry | orphaned)** — produced by
  `annotation-core` (Data Model + S-005 matching). Consumed by versioning-diff:S-005
  (AS-009/AS-010) to display carry-forward + detached list. ✔ annotation-core
  defines the model + algorithm; this cluster only consumes the result.

## UI Notes

From `docs/explore/versioning-diff.md` §UI sketches. Greenfield → `[N]`. Component names
only. Dark-operator (`DESIGN.md`). Precedence: AS > Tree.

- `VersionHistoryPanel` `[N]`
  - `VersionList` → `VersionItem` *(versionLabel · time · author · currentMarker)*
  - `RestoreButton` *(append-copy → new version)*
- `DiffView` `[N]`
  - `DiffHeader` *(Compare vX ↔ vY · changeCount)*
  - `VersionPicker` *(pick any 2 versions)*
  - `SourceLineDiff` *(line-diff: addedLine teal / removedLine red strike; Geist Mono)*
  - `RenderedSideBySide` *(2-pane render vX | vY; **stacked** ≤760)*
  - `ImageDiffSideBySide` *(image doc: 2 images side-by-side)*
  - `NoDiffState` *(2 identical versions → "No differences")*

## API

HTTP contract for this cluster. Follows `api-core` (envelope C-001, error→status C-003,
auth gate C-005, validation C-007, existence-hiding C-006). `→` = serves which AS.

| Method · Path | Serves | Auth | Request | Success | Errors |
|---|---|---|---|---|---|
| `POST /api/docs/:slug/versions` | S-001 (AS-001) | session (editor) | `{ content, contentHash? }` (Zod) | 201 `{ version, previousVersion }` | 404 NOT_FOUND (no-access/missing, C-006), 403 FORBIDDEN (not editor) |
| `PATCH /api/docs/:slug` | S-001 (AS-002 title-only, no version) | session (editor) | `{ title }` (Zod) | 200 `{ slug, title }` | 404, 403 |
| `GET /api/docs/:slug/versions` | S-002 (AS-003 history) | session (viewer+) | pagination query (api-core C-008) | 200 `{ items, pagination }` | 404 |
| `POST /api/docs/:slug/versions/:n/restore` | S-003 (AS-004) | session (editor) | — | 201 `{ version, previousVersion }` | 404 (doc or version n missing), 403 |
| `GET /api/docs/:slug/diff?from=&to=` | S-004 (AS-006/007/008) | session (viewer+) | query `from`,`to` (Zod) | 200 `{ mode, identical?, changeCount?, lines?, renderPair }` | 404, 400 VALIDATION_ERROR (bad version refs) |

Re-anchor (S-005 AS-009/010) is **not a route** — it is triggered server-side inside the
version-creating endpoints (POST versions / restore) via `annotation-core` re-anchor; the
detached list surfaces through annotation-core's annotation reads.

## What Already Exists

### System Impact & Technical Risks

- Greenfield repo. `doc_versions` is defined in `render-publish`; this cluster adds
  history/restore/diff/re-anchor-trigger on top of it.
- Reuse: the rendered side-by-side in the diff reuses `render-publish`'s viewer iframe.
- Risk (medium-high): S-005 has a two-way dependency with `annotation-core` over the data
  model — they must be built in coordination, not separately.

## Not in Scope

- The matching algorithm (block_id → snippet exact → fuzzy) + annotation model —
  `annotation-core`.
- Labels/names/commit-message for versions — assumption: auto-number only in v0.
- Link pinned to a specific version (`/d/:slug@v2`) — v0 link = latest. Defer.
- Overlay/swipe for image diff; DOM-aware structural diff; inline merged rich-diff — defer.
- Prune/retention of old versions — keep all in v0 (see GAP-001).
- Real-time / live editor — v2.

## Gaps

- GAP-001 (status: open): storage growth — keeping all versions × up to 5MB HTML/25MB
  images could bloat the DB; do we compress / dedup by content_hash / prune? Couples
  `self-host`. Source: "Storage growth (self-host)".
- GAP-002 (status: resolved): if `multi_range` loses any segment → the whole annotation
  detaches. Settled 2026-06-07; behavior in `annotation-core:AS-018`.
- GAP-003 (status: deferred): does re-anchor run synchronously at version creation or as a
  background job if slow — measure at build time. Source: "Re-anchor runs synchronously … if slow → background job".
- GAP-004 (status: deferred): how well does `@pierre/diffs` handle raw HTML, do we need to
  pre-normalize before diffing. Source: "How well @pierre/diffs handles raw HTML".

## Clarifications — 2026-06-07

- **Restore = append-copy instead of pointer-move:** an append-only history is easy to
  reason about, no ambiguity over "where is current", safe for self-host (never loses an old copy).
- **Only content creates a version:** avoids junk versions from title edits, lighter on storage.
- **Two-level diff instead of inline rich-diff:** inline requires rendering merged HTML in the
  app origin → breaks the sandbox; two side-by-side iframes keep isolation while still showing changes.
- **Re-anchor + detached:** meets the "anchors durable across versions" requirement (§4.2); the
  detached list ensures feedback is never silently lost.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/versioning-diff.md) | -- |
| 2026-06-07 | GAP-002 resolved (multi_range all-or-nothing; see annotation-core:AS-018) | -- |
| 2026-06-07 | + ## UI Notes (Component Tree from explore §UI sketches) — Minor | -- |
| 2026-06-08 | + ## API (HTTP contract: version create/history/restore/diff; per api-core) — Minor | -- |
