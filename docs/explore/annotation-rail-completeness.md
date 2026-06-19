## Explore: Annotation Rail Completeness + Status Chips
_2026-06-17_

**Feature:** The viewer's annotation rail loads the COMPLETE set of a doc's annotations
(not a 20-item page), and its header shows a status breakdown as toggleable filter chips
(icon + count) that filter the rail AND dim non-matching highlights in the doc.

**Trigger:** User opens a doc in the viewer (`/d/:slug`). The rail renders on load; the
chips are user-toggled.

**Problem being solved:** The dashboard list counts ALL active annotations for a doc
(`repo.ts` `annotationCount = count(*) where deleted_at is null`), but the viewer rail
fetches only page 1 (`limit: 20`) of the annotation list and reads `.items` — silently
dropping every annotation past the 20th. On `calendar-integration-foundations-661bpv` the
dashboard shows 23 while the rail shows 20 (the 3 oldest are on page 2, never fetched).
Worse than a wrong number: annotations on page 2 also get NO highlight mark drawn in the
doc, because marks are placed only from the loaded set. Confirmed live (2026-06-17): API
`pagination: { page:1, limit:20, total:23, hasNext:true }`, rail badge = 20, 20 cards, 0
detached. The "20" coincidentally equalled the range-unresolved count — a red herring; the
real cause is the page limit.

**UI expectation:** Compact. The rail header replaces the single count ("20") with a row of
status chips, each = icon + count. Chips are toggle filters. Reference: the existing rail
header (`annotations-rail.tsx`).

**UI sketches:**

```
┌─ AnnotationsRail header [E] annotations-rail.tsx:64-76 ──────────────┐
│  ▤ Annotations            [◐ 20] [✓ 3] [✎ 2]   [N status chip row]   │
│                            Open   Resolved Suggestion                 │
│  (each chip = icon + count, multi-toggle; all ON by default)          │
├───────────────────────────────────────────────────────────────────────┤
│  ThreadCard list [E] thread-card.tsx — now fed the COMPLETE set        │
│  DetachedSection [E] — amber, unchanged                                │
└───────────────────────────────────────────────────────────────────────┘

Legend: [E] existing · [N] NEW · [X] MISSING / clarify
```

- Rail header container — `[E]` `apps/web/src/features/viewer/components/annotations-rail.tsx:64`
  (the `.flex h-11` header: Icon `highlight` + "Annotations" + `rail-count`).
- Status chip row (icon+count, toggle, filters rail + dims marks) — `[N]`.
- ThreadCard / DetachedCard list — `[E]` `annotations-rail.tsx` + `thread-card.tsx`.
- The annotation read (load-all instead of page 1) — `[E]` to change:
  `apps/web/src/features/viewer/services/client.ts:147` `listAnnotations(slug)` (no limit param),
  consumed by `viewer-screen.tsx:847` `useApiQuery` → `annoQuery.data?.items`.
- Backend list read — `[E]` `apps/backend/src/routes/annotations.ts:474` `listAnnotationsHandler`
  + `:773` `docListAnnotationsHandler` (both already load the full set via `listByDoc`, then
  `all.slice(start, start+limit)` — see "Decision rationale").

**Happy path:**
1. User opens a doc with 23 annotations in the viewer.
2. The rail loads the COMPLETE set (23) — every annotation gets its highlight mark in the doc;
   the rail's total matches the dashboard (23).
3. The header shows three chips: `Open 20 · Resolved 3 · Suggestion 2` (illustrative split),
   all active.
4. User clicks the `Resolved` chip OFF → resolved threads disappear from the rail and their
   marks dim in the doc; `Open` + `Suggestion` remain. Clicking it back ON restores them.

**Business rules:**
- **Load-all:** the viewer annotation read returns every active annotation for the doc — no
  20-item cap. (Decision: A — marks must place across the whole doc and the rail total must
  match the dashboard count.) If a doc has a very large set, the rail list is virtualized;
  marks are all drawn (existing behavior, just at full count).
- **Chip bucketing (3 chips, mutually exclusive partition):**
  - `Suggestion` = annotation `type === "suggestion"` (ANY `suggestionStatus`:
    pending/accepted/rejected/stale).
  - `Open` = NOT a suggestion AND `status === "unresolved"`.
  - `Resolved` = NOT a suggestion AND `status === "resolved"`.
  Every active annotation lands in exactly one chip → the three counts sum to the doc total.
- **Filter = multi-toggle:** all three chips start active. Toggling a chip OFF hides that
  group from the rail AND dims its highlight marks in the doc; toggling ON restores both.
  Multiple chips can be off at once. (Decision: A multi-toggle + C filter-rail-and-doc.)
- **Counts are client-derived** from the now-complete loaded set — no separate count endpoint.

**Input validation:** none (read + client-side UI state only).

**Edge cases:**
- Empty doc (0 annotations): existing "No annotations yet" empty state (AS-015), no chips
  with counts (or chips show 0 — see Open questions).
- All chips toggled off / a filter that matches nothing: rail shows a "nothing matches the
  current filter" state (distinct from the true-empty state). [Open question]
- Detached/orphaned annotations: still rendered in the amber DetachedSection (unchanged);
  they count toward a chip by their own status/type. [Assumption — confirm]
- Resolved marks are ALREADY visually dimmed; the chip-filter dim must compose with that
  (a filtered-out resolved mark should read as filtered, not just resolved). [Impl note]
- Focus/scroll-to-thread (AS-009): focusing a thread that belongs to a currently-filtered-out
  chip — does it auto-enable that chip, or is focus only reachable for visible threads?
  [Open question]

**Permissions:** unchanged. Same `resolveAccess` read gate (C-010/AS-021/AS-007). The chips
are pure presentation over what the reader can already see.

**Data impact:** none. No schema change. `annotations.isOrphaned`, `status`, `type`,
`suggestionStatus` already exist and are already served on the list read.

**Impact on existing system:**
- `listAnnotations(slug)` FE client + `useAnnotations` hook: must request/consume the full set.
- The rail header (`annotations-rail.tsx`) gains the chip row; `rail-count` (currently
  `anchored.length`) is superseded by the chip totals.
- The mark-dimming path (`htmlPlaceable` for HTML via the bridge; the light-DOM placer for
  markdown) must accept a per-annotation "filtered" flag in addition to the existing
  resolved/redline/stale flags.
- Fixes the doc-wide count mismatch the dashboard already exposes (workspace-project-ui S-007).

**Out of scope:**
- Browse-list pagination (docs list / projects list / search) — separate feature, see
  `docs/explore/browse-pagination.md`. (The two were requested together but are different
  surfaces with OPPOSITE resolutions: this rail removes paging, browse adds it.)
- Persisting the chosen filter across reloads / sharing a filtered view via URL — not asked.
- A 4th "Detached" chip — user chose the 3-chip set (A).

**Decision rationale:**
- Load-all over in-rail pagination (chose A): annotation marks must be placed across the
  entire doc, and the rail total must equal the dashboard count — both impossible if the rail
  only holds a page. Cheap server-side: `listAnnotationsHandler` ALREADY loads the full set
  via `listByDoc` and only slices for the response, so returning everything adds no DB cost —
  the fix is to stop slicing for the viewer read (or request an unbounded limit).
- 3 chips (Open/Resolved/Suggestion), not the fuller type breakdown: covers the review
  workflow (what's open, what's done, what needs an accept/reject decision) without a busy
  header. "icon + số là đủ".
- Filter dims doc marks too (C, not rail-only): the user wants the doc and rail to focus
  together when narrowing by status.

**Assumptions (need confirmation):**
- Detached/orphaned annotations are counted into their status/type chip and still shown in the
  amber DetachedSection.
- Suggestion bucketing wins over status (a resolved suggestion counts under `Suggestion`, not
  `Resolved`).
- Chip icons reuse the existing icon set (e.g. `highlight`/`check`/a suggestion glyph) per
  DESIGN.md; no new iconography needed beyond what exists.

**Open questions:**
- Empty-filter state copy + whether chips render at count 0 or hide.
- Focusing a thread in a filtered-out group (AS-009 scroll-to): auto-unhide that chip, or no-op?
- Virtualization threshold for the rail (only matters for very large docs) — defer unless a
  real doc hits it.
- When MCP `pull-annotations` is built (not yet in the repo), it MUST read the complete set,
  NOT page 1 of this endpoint — otherwise the agent silently loses feedback. Flag for the MCP spec.

**Complexity signal:** medium.
Based on: 0 schema change, 1 read-shape change (load-all), 1 new UI control (chip row), and a
cross-surface filter (rail list + in-doc mark dimming across both the markdown light-DOM placer
and the HTML sandbox-bridge placer).

**Non-functional requirements:**
- Scale: a doc's annotation set is expected in the tens; load-all is fine. Virtualize the rail
  if a doc reaches hundreds. Marks are already all-drawn today.
- Performance: no new DB cost (server already materializes the full set).
- Security/compliance: none new — same read gate.
- Availability: cosmetic surface; no availability impact.

**Technical risks:**
- The in-doc mark dimming spans TWO placement paths (markdown light-DOM placer; HTML
  sandbox-bridge over the opaque iframe). The "filtered" flag must thread through both, like
  the existing resolved/redline/stale flags — easy to update one and miss the other.
- Removing the slice changes `pagination.total`-based assumptions in any test that asserts the
  20-window; those tests must move to asserting the full set.
