# Spec: annotation-core-ui

**Created:** 2026-06-11
**Last updated:** 2026-06-18
**Status:** Draft

## Overview

The frontend doc **viewer** — the consumer side of `annotation-core` (backend) + the render
contract of `render-publish`. A React route `/d/:slug` renders a published doc (Markdown in the
app theme, HTML in a sandboxed iframe, image with zoom) inside a 3-pane shell (TOC · doc · comments
rail), shows existing annotations as margin threads paired to in-text highlights, surfaces the
detached (orphaned) list, and reflows to drawers on mobile. This is the **viewer shell + read/
display** slice; creating comments lives in `annotation-core-ui-commenting`, suggestions + image
regions in `annotation-core-ui-suggest-image` — both mount into this shell.

**Direction B (decided 2026-06-11, see [[render-publish-viewer-direction]]):** the viewer is a
React route in the SPA, NOT the bare server-rendered `/d` page. This spec replaces that stopgap and
fixes the FE-reach gap (doc cards currently navigate to a `/d/:slug` the SPA can't render). The
backend keeps `/v/:id` (sandboxed content) as the HTML iframe `src`; `/d/:slug` server-render
becomes a fallback only.

Builds on `web-core` (shell, router, typed client, theme). Mounts into `apps/web`.

## Data Model

No persistent data — a client. Reads (TanStack Query, keyed by `docSlug`):
- the **doc** (title, kind html|markdown|image, current version, status, format, general_access) +
  its **rendered content** — Markdown HTML (app-origin) for kind=markdown; the `/v/:id` URL for the
  sandbox iframe for kind=html/image.
- the **annotations list** for the doc: each `{ id, type, anchor{blockId,textSnippet,offset,length,
  segments[],region?}, status, isOrphaned, suggestion?, suggestionStatus?, comments[] }` and each
  comment `{ id, parentId, authorName|guestName, body, createdAt }`.
Client state: active TOC section, focused annotation id, rail-visible / drawer-open, theme, active
status-chip filters (which of Open/Resolved/Suggestion are toggled on — all on by default).

## Prerequisites (backend — build-blockers, not gaps)

These must land/settle BEFORE the dependent FE stories can be built + verified end-to-end (from the
/mf-challenge 2026-06-11). Treat as hard prerequisites, not soft gaps:
- **block-id injection at serve time** (GAP-002) — blocks S-003 (highlights can't anchor) + the
  suggestion stale check. Backend must inject `data-block-id` into served MD/HTML.
- **anchor ↔ DOM-range algorithm** (the FE side of the anchor model: selection→anchor and
  anchor→highlight range) — must be PINNED (not just "reuse Plannotator", which assumes `srcdoc`,
  not the `/v` cross-origin iframe). Blocks S-003 + commenting. See `annotation-core-ui-commenting`:GAP-003.
- **annotation API path** (GAP-001) — the real route is workspace-scoped `/api/w/:workspaceId/docs/
  :slug/annotations`; the `annotation-core` spec's API table is stale → fix it (Mode C) so the FE pins
  the right surface.

## Stories

### S-001: Open a doc in the viewer (P0)

**Description:** As someone with at least view access, I open a doc link and see it rendered in the
viewer — Markdown styled in the app theme, HTML in an isolated sandbox, an image with zoom — with
the doc as the high-contrast element and the chrome receding.
**Source:** annotation-core UI Notes (`DocViewer`/`DocPane`); render-publish S-002/003/004 (render contract); audit: doc cards link to `/d/:slug` the SPA can't render (FE-reach gap). Prototype: `viewer.jsx` MarkdownView/HtmlSandbox/ImageViewer, `viewer-shell.jsx` Viewer.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/web/src/app/` (router: add `/d/:slug` route), new `apps/web/src/features/viewer/` (viewer-screen, doc-pane, markdown-view, html-sandbox-frame, image-viewer), `apps/web/src/features/viewer/client.ts`
- `autonomous:` true
- `verify:` open a published markdown doc's link → it renders styled in the app theme; an HTML doc → renders in a sandbox iframe; an image doc → renders with zoom; a doc with no access → not shown (404/redirect).

**Acceptance Scenarios:**

AS-001: A Markdown doc renders in the app theme, 3-pane
- **Given:** a published Markdown doc I can access
- **When:** I open `/d/:slug`
- **Then:** its content renders styled in the app theme (not in an iframe), inside the 3-pane viewer (outline · content · annotations), content at the prose reading width
- **Data:** a doc with headings + a bullet list

AS-002: An HTML doc renders in an isolated sandbox, full-bleed, 2-pane
- **Given:** a published HTML doc I can access
- **When:** I open `/d/:slug`
- **Then:** the doc renders inside a sandboxed iframe (its own styles preserved, isolated origin; the app chrome does not restyle it) in a 2-pane layout — the iframe is full-bleed: it fills the doc pane edge-to-edge with no side padding/margin and fills the available height, with the annotations rail beside it and no outline pane
- **Data:** an HTML doc with its own CSS

AS-003: An image doc renders with zoom, full-width, 2-pane
- **Given:** a published image doc I can access
- **When:** I open `/d/:slug` and use the zoom control
- **Then:** the image displays and zooms in/out in a 2-pane layout — content area at full width, annotations rail beside it, and no outline pane
- **Data:** a PNG doc

AS-004: A doc I cannot access does not open
- **Given:** a restricted doc I am not invited to (or a non-existent slug)
- **When:** I open its `/d/:slug`
- **Then:** the doc does not render; I see a not-found / no-access state, never its content (existence-hiding)
- **Data:** restricted doc, non-member viewer

### S-002: Navigate a Markdown doc with the outline (P1)

**Description:** As a reader of a **Markdown** doc, I use a collapsible outline (TOC) to jump between
sections; the active section highlights as I scroll; I can collapse the outline to give the content
more room. The outline exists only for Markdown — HTML and image docs have no outline pane (C-006).
**Source:** annotation-core UI Notes (`TocSidebar`/`TocSearch`/scroll-spy); kind-conditional layout decision 2026-06-14 (outline only for markdown; html/image full-width content). Prototype: `viewer.jsx` TocSidebar.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/toc-sidebar.tsx`, viewer-screen
- `autonomous:` true

**Acceptance Scenarios:**

AS-005: Jumping to an outline entry scrolls to that section
- **Given:** the viewer is open on a Markdown doc with several sections
- **When:** I click an outline entry
- **Then:** the doc scrolls to that section
- **Data:** a Markdown doc with 5 sections

AS-006: The active section follows the scroll position
- **Given:** the viewer is open on a Markdown doc
- **When:** I scroll the doc down past a section heading
- **Then:** the outline marks the section currently in view as active
- **Data:** scroll past section 3

AS-018: Collapsing the outline from the top bar gives the content more room
- **Given:** the viewer is open on a Markdown doc with the outline shown
- **When:** I collapse the outline via the top-bar outline-toggle
- **Then:** the outline pane hides and the content area reflows wider; toggling the top-bar control again restores it
- **Data:** a Markdown doc on a desktop-width screen

AS-019: Collapsing the outline from inside the pane
- **Given:** the viewer is open on a Markdown doc with the outline shown
- **When:** I click the collapse control beside the outline search inside the outline pane
- **Then:** the outline pane hides and the content area reflows wider; because that control hides with the pane, the persistent top-bar outline-toggle is what brings the outline back
- **Data:** a Markdown doc on a desktop-width screen

### S-003: Read existing annotations (P0)

**Description:** As a reader, I see existing annotations as threads in the right-hand rail, each
paired to a highlight on the quoted text; clicking a highlight focuses its thread and clicking a
thread scrolls to its highlight.
**Source:** annotation-core S-001 (AS-001 margin thread + highlight), C-001 (anchor); annotation-core:GET annotations. Prototype: `viewer.jsx` AnnotationsRail/ThreadCard, `viewer-shell.jsx` focus pairing.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/{annotations-rail,thread-card,annotation-marks}.tsx`, `services/client.ts`, `viewer-screen.tsx` (the complete-set read)
- `autonomous:` true
- `verify:` open a doc that has annotations → the rail lists each thread (quote, author, time, body, replies); the quoted text is highlighted; clicking a highlight focuses its thread, clicking a thread scrolls to + focuses its highlight. Open a doc with MORE annotations than one page → the rail still lists every one and its total matches the dashboard's count.
- **BLOCKED until** the backend prerequisites above (block-id injection + the pinned anchor↔range algorithm); a highlight that cannot be placed must render gracefully (thread shown, marked "couldn't place") — never crash or silently drop (see GAP-005).

**Acceptance Scenarios:**

AS-007: Annotations show as rail threads with in-text highlights
- **Given:** a doc with 3 annotations I can access
- **When:** I open the viewer
- **Then:** the rail lists 3 threads (quote · author · time · body · replies, flat) and each quoted range is highlighted in the doc; the rail count shows 3
- **Data:** 3 annotations, one with a reply

AS-008: Clicking a highlight focuses its thread
- **Given:** the viewer shows several highlights + threads
- **When:** I click a highlighted range in the doc
- **Then:** its thread in the rail becomes focused (scrolled into view + emphasized)
- **Data:** click the 2nd highlight

AS-009: Clicking a thread scrolls to its highlight
- **Given:** the rail shows several threads
- **When:** I click a thread
- **Then:** the doc scrolls to its highlighted range and the highlight is emphasized
- **Data:** click the 3rd thread

AS-010: A resolved annotation shows dimmed
- **Given:** one of the annotations is resolved
- **When:** I open the viewer
- **Then:** its thread shows a Resolved badge + dimmed, and its highlight shows the resolved (not active) style
- **Data:** 1 resolved of 3

AS-015: A doc with no annotations shows an empty rail
- **Given:** a doc I can access that has no annotations
- **When:** I open the viewer
- **Then:** the rail shows an empty state ("no comments yet"), no highlights render, the count is 0, and the doc still renders
- **Data:** 0 annotations

AS-021: The rail loads the complete annotation set, not a capped subset
- **Given:** a doc I can access whose dashboard cell reports 23 annotations
- **When:** I open the viewer
- **Then:** the rail lists all 23 threads (not a capped first-page subset), every quoted range gets its in-text highlight, and the rail total equals the dashboard's annotation count for the doc — no annotation is silently absent from the rail or left without a highlight
- **Data:** a doc with 23 active annotations (more than one read-page's worth)

### S-004: Manage detached annotations — view, dismiss, re-attach (P1)

**Description:** As a reader, I see annotations that no longer anchor to the current version in a
separate "detached" section; I can dismiss an orphan (it leaves the rail) or re-attach it by
selecting a range in the current version.
**Source:** annotation-core S-005 (AS-013 detached), C-002; G8 decision 2026-06-11 (build both actions in v0). Prototype: `viewer.jsx` AnnotationsRail DetachedSection + Re-attach/Dismiss buttons (lines 160-162), `viewer-data.jsx` VIEWER_DETACHED.

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/annotations-rail.tsx`, client.ts (dismiss/re-attach)
- `autonomous:` true
- **needs** a backend dismiss + re-attach surface (GAP-006) — re-attach sets the annotation's anchor to a newly-selected range; dismiss removes it from the active list.

**Acceptance Scenarios:**

AS-011: Detached annotations are listed in their own section
- **Given:** a doc whose annotations include 1 marked orphaned (`isOrphaned`)
- **When:** I open the viewer
- **Then:** the orphaned annotation shows in a distinct "detached" section (amber, with a count), separate from the anchored threads, with its quote + body, and Re-attach + Dismiss actions
- **Data:** 1 detached of 4 annotations

AS-016: Dismissing a detached annotation removes it from the rail
- **Given:** a detached annotation in the rail
- **When:** I click Dismiss
- **Then:** the annotation leaves the detached section (and the rail count drops); it does not reappear on reload
- **Data:** dismiss 1 detached

AS-017: Re-attaching a detached annotation anchors it to a new range
- **Given:** a detached annotation; I select a range in the current version
- **When:** I choose Re-attach for that annotation onto the selection
- **Then:** the annotation moves out of the detached section and shows as an anchored thread with a highlight on the new range
- **Data:** re-attach onto a sentence in block 4

### S-005: Viewer top bar + spec meta (P1)

**Description:** As a reader, the top bar shows the doc title, live/format/version, and controls to
toggle the comments rail and theme; for a Markdown doc it also shows an outline-toggle (HTML and image
docs have no outline, so no outline-toggle — C-006); a spec-type doc also shows a meta strip (slug,
version, story/AS counts, draft, url).
**Source:** annotation-core UI Notes (`ViewerTopBar`/`SpecMetaStrip`). Prototype: `viewer-shell.jsx` ViewerTopBar/MetaStrip.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/{viewer-top-bar,meta-strip}.tsx`
- `autonomous:` true

**Acceptance Scenarios:**

AS-012: The top bar shows doc identity + a working comments toggle
- **Given:** the viewer is open on a SHARED doc (general access beyond restricted)
- **When:** I view the top bar and click the comments toggle
- **Then:** the bar shows title · Live badge · format · version; the toggle shows/hides the comments rail.
  The Live badge appears because the doc is shared (the same condition the dashboard list uses) — not
  because it has a published version
- **Data:** a markdown doc at v4 with general access "anyone with link"

AS-020: A restricted doc shows NO Live badge in the top bar (reads Draft, matching the dashboard)
- **Given:** the viewer is open on a RESTRICTED doc (not shared) that is served as published
- **When:** I view the top bar
- **Then:** no Live badge is shown — the doc reads as Draft, consistent with the dashboard list; the
  rest of the identity (title · format · version) still shows
- **Data:** a markdown doc at v4 with general access "restricted"

AS-013: A spec-type doc shows the meta strip
- **Given:** a spec doc (has story/AS counts) open on desktop
- **When:** the viewer renders
- **Then:** a meta strip shows slug · version · updated · stories · AS · url (and a Draft badge if draft)
- **Data:** a spec doc, 6 stories / 23 AS

### S-006: Responsive viewer (P1)

**Description:** As a reader on a tablet/phone, the TOC and comments rail collapse to drawers; a
comment FAB (with count) opens the rail.
**Source:** annotation-core UI Notes (mobile drawer + `CommentFab`); [[responsive-mandatory]]. Prototype: `viewer-shell.jsx` drawerMode/CommentFab.

**Execution:**
- `depends_on:` S-001, S-003
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/viewer-screen.tsx`
- `autonomous:` true

**Acceptance Scenarios:**

AS-014: On a narrow screen the side panes become drawers
- **Given:** the viewer open on a phone-width screen
- **When:** it renders
- **Then:** the side panes are not inline; for a Markdown doc both the outline and comments rail become drawers, for an HTML/image doc only the comments rail does (no outline drawer) and content stays full-width; a comment FAB shows the annotation count and opens the rail as a drawer; tapping a highlight opens the rail
- **Data:** 360px width, a doc with 3 annotations

### S-007: Summarize + filter the rail by status (P1)

**Description:** As a reader, the rail header shows the annotation set as status chips — Open,
Resolved, Suggestion — each an icon with its count, instead of a single total; I toggle a chip
to focus the rail on (or away from) that group, which also dims the matching highlights in the
doc, so I can read just the open threads, just the resolved ones, or just the suggestions.
**Source:** docs/explore/annotation-rail-completeness.md#Feature ("the rail header shows a status
breakdown as toggleable filter chips … that filter the rail AND dim non-matching marks"); clarify
2026-06-18 (count covers the complete active set; empty-filter placeholder; focus re-activates a
toggled-off group). The Suggestion chip filters suggestion-type threads this shell already displays
(`SuggestBadge`, Data Model `suggestion?`); creating/deciding suggestions stays out of scope (suggest-image).

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/components/annotations-rail.tsx` (chip header + filtered list), `apps/web/src/features/viewer/components/viewer-screen.tsx` (filter state + mark-dim wiring), the in-text mark path (markdown light-DOM placer + the HTML sandbox-bridge placer — the "filtered" flag rides the same channel as the resolved/redline/stale flags)
- `autonomous:` true
- `verify:` open a doc with a mix of open/resolved/suggestion annotations → the header shows three chips with counts that sum to the total; toggle one off → its threads leave the rail and its highlights dim in the doc; toggle it back on → both return.

**Acceptance Scenarios:**

AS-022: The rail header summarizes the set as status chips
- **Given:** a doc with 20 open, 1 resolved, and 2 suggestion annotations (23 active total)
- **When:** I open the viewer
- **Then:** the rail header shows three chips — Open 20 · Resolved 1 · Suggestion 2 — each an icon with its count, all active by default, and the three counts sum to the doc's active total (23)
- **Data:** 20 open + 1 resolved + 2 suggestion = 23 active

AS-023: Toggling a chip off filters the rail and dims those marks
- **Given:** the viewer open with all three chips active
- **When:** I toggle the Resolved chip off
- **Then:** resolved threads leave the rail list and their in-text highlights dim in the doc, while the Open and Suggestion threads and their highlights stay; the detached section (if any) is unaffected
- **Data:** toggle Resolved off on the 23-annotation doc

AS-024: Toggling the chip back on restores its threads and marks
- **Given:** the Resolved chip is toggled off (resolved threads hidden, their marks dimmed)
- **When:** I toggle the Resolved chip back on
- **Then:** the resolved threads return to the rail and their highlights return to the resolved (dimmed-as-resolved, not filtered) style
- **Data:** re-enable Resolved

AS-025: With no group selected the rail shows a distinct no-match state
- **Given:** the viewer open on a doc that HAS annotations
- **When:** I toggle all three chips off so no group is selected
- **Then:** the rail body shows a "no annotations match the filter" state — visibly distinct from the empty-doc "no annotations yet" state — and no highlights are emphasized
- **Data:** all chips off on the 23-annotation doc

AS-026: Acting on a highlight or thread in a toggled-off group re-activates it
- **Given:** the Open chip is toggled off, so an open annotation's highlight is dimmed in the doc
- **When:** I click that dimmed highlight (or would click its thread)
- **Then:** the Open chip re-activates, the annotation's thread reappears in the rail, and it focuses (scrolled into view + emphasized) — the click is never a dead no-op
- **Data:** click a filtered-out open highlight

## Constraints & Invariants

- C-001: The viewer never restyles doc content — Markdown renders in the app theme but HTML/image
  render in the sandboxed iframe (`/v/:id`, opaque origin) so the author's own styles are preserved
  and scripts stay isolated (render-publish C-001/C-002). (AS-001, AS-002)
- C-002: A doc the viewer-session cannot access never renders; not-found and no-access are
  indistinguishable (existence-hiding). A 404 from the annotations read is treated as no-access (the
  not-found state), NEVER rendered as an empty "0 comments" rail (which would leak existence). (AS-004)
- C-003: Every highlight is paired to exactly one annotation by its anchor; clicking either focuses
  the other; a resolved annotation renders dimmed in both rail and text. (AS-007, AS-008, AS-009, AS-010)
- C-004: Detached (`isOrphaned`) annotations are shown in a separate section, never silently dropped
  and never rendered as if still anchored; each offers Dismiss (leaves the rail) + Re-attach (anchor to
  a new range). Needs a backend dismiss/re-attach surface (GAP-006). (AS-011, AS-016, AS-017)
- C-005: Every viewer screen uses the DESIGN.md system (teal accent; chrome recedes behind doc +
  comments) and is responsive (TOC + rail reflow to drawers on tablet/mobile; tap targets ≥40px). (AS-001, AS-014; pixel/responsive visual is [→MANUAL] + a Playwright runtime check)
- C-006: The viewer layout is conditional on doc kind. kind=markdown → 3-pane: a collapsible outline ·
  content at prose reading width · annotations rail. kind=html and kind=image → 2-pane: content filling
  the full content width (no prose clamp) · annotations rail — with NO outline pane and NO outline-toggle
  in the top bar. An HTML doc is additionally full-bleed: the sandbox iframe sits edge-to-edge (no side
  padding/margin) and fills the available height. The outline is derived from headings, which only the app-origin Markdown render exposes
  (the HTML sandbox is cross-origin, images have no headings — GAP-004). (AS-001, AS-002, AS-003, AS-018, AS-019)
- C-007: The top bar's Live badge reflects the doc's GENERAL ACCESS, not its publish state — shown when
  the doc is shared beyond restricted (anyone-with-link / anyone-in-workspace = Live), hidden when
  restricted (= Draft). This is the SAME rule the dashboard doc list uses, so a doc reads the same
  Live/Draft in the list and in the viewer. A restricted doc is still served as published (it has a
  version) yet must read Draft. (AS-012, AS-020)
- C-008: The viewer reads the COMPLETE active annotation set for the doc on open — never a capped
  first-page subset. Every active annotation gets a rail thread and (when placeable) an in-text
  highlight, and the rail total equals the dashboard's annotation count for the doc, so the count is
  consistent between the doc list and the viewer. (AS-021)
- C-009: The rail header summarizes the active set as three status chips that PARTITION it —
  Suggestion (`type` = suggestion, any lifecycle), then Open (not a suggestion, unresolved), then
  Resolved (not a suggestion, resolved) — so the three counts always sum to the active total
  (detached/`isOrphaned` annotations are counted into their status/type chip; they still also appear
  in the separate detached section per C-004). Chips are independent multi-toggles, all active by
  default. Toggling a chip OFF hides its group from the rail thread list and dims its in-text
  highlights; toggling it back ON restores both. The detached section always renders regardless of
  chip state (C-004). When no chip is selected the rail shows a no-match state distinct from the
  empty-doc state. Acting on a highlight/thread whose chip is off re-activates that chip and focuses
  the thread. (AS-022, AS-023, AS-024, AS-025, AS-026)

## Linked Fields

annotation-core-ui is the **consumer**; `annotation-core` (backend) + `render-publish` are producers.

- doc + rendered content (MD html / `/v/:id` iframe url / image) — consumed by S-001 on viewer load.
  Produced by `render-publish` (`/d` loader served MD-render; `/v/:id` content route). ✔ surface
  exists; **the SPA route `/d/:slug` is NEW here** (was server-rendered).
- annotations list `{id,type,anchor,status,isOrphaned,suggestion?,comments[]}` — consumed by S-003/
  S-004 on viewer load (read on open). Produced by `annotation-core` `GET …/annotations`. ✘ the
  endpoint path is workspace-scoped `/api/w/:workspaceId/docs/:slug/annotations`, NOT the
  `/api/docs/:slug/annotations` the annotation-core spec's API table still lists → GAP-001.
- annotations list **completeness** — S-003 (C-008) consumes the COMPLETE active set on viewer
  load (every active annotation, so the rail total reconciles with the dashboard and every highlight
  places). Produced by `annotation-core` `GET …/annotations`, which currently returns a single
  page (default page size 20) — the producer materializes the whole set server-side and only slices
  for the response, so it can deliver all of it, but does not today. ✘ surface mismatch (paged vs
  complete) → GAP-007.
- `data-block-id` markers on the served content — consumed by S-003 to resolve each annotation's
  anchor → an in-text highlight. Produced by render-publish/annotation-core block-id injection at
  serve time. ✘ block-id injection is NOT wired at serve time (audit/runtime-confirmed) → GAP-002.
- `generalAccess` — consumed by S-005/AS-012+AS-020 on viewer load (the top-bar Live badge derives
  from it: shared = Live, restricted = Draft — C-007). Produced by `render-publish` viewer-doc read
  (`GET …/docs/:slug` → `doc.generalAccess`, render-publish API shape). ✔ surface + lifecycle match
  (persisted, served on the doc read the viewer already makes).

## UI Notes

Design source: the Anchord-Design prototype (`viewer.jsx`, `viewer-shell.jsx`, `viewer-data.jsx`) —
CANONICAL on conflict. Precedence: AS / Constraints > prototype > this Tree. Dark-operator
(`DESIGN.md`); chrome recedes behind doc + comments. All `[N]`.

- `ViewerScreen` `[N]` *(React route `/d/:slug`; replaces the server-rendered `/d` page — direction B)*
  - `ViewerTopBar`: outline-toggle *(kind=markdown only — desktop collapse + drawer mode; absent for html/image)* · back *(non-public)* · brand · title · `LiveBadge` · `FormatBadge` · `VersionButton` *(opens version history — versioning-diff-ui, sibling)* · `CommentsToggle` · `ShareButton` *(opens share — sharing-permissions-ui, sibling)* · `ThemeToggle` · `OverflowMenu`
  - `MetaStrip` *(spec docs only, desktop: slug · version · updated · stories · AS · Draft · url)*
  - `ViewerBody` *(kind-conditional per C-006 — markdown: 3-pane outline·content·annotations, outline collapsible; html/image: 2-pane full-width content·annotations, no outline. Collapses to drawers <1200 TOC / <600 rail)*
    - `TocSidebar` *(kind=markdown only)*: `TocSearch` · `TocCollapse` *(chevron beside the search — collapses the outline from inside the pane, AS-019; re-expand is the top-bar outline-toggle)* · `TocGroup` → `TocItem` *(scroll-spy active; `PriorityBadge` if spec)*
    - `DocPane` *(html/image fill full content width — no prose clamp)*
      - `DocModeToolbar`: Select·Markup · Wide·Focus *(Markup mode = commenting spec; Select/width here)*
      - `MarkdownView` *(kind=markdown; app-origin render; prose width; `AnnotationHighlight` spans paired by anchor)*
      - `HtmlSandboxFrame` *(kind=html; full-width; iframe `src="/v/:id"` sandbox allow-scripts; highlights via the bridge — commenting spec)*
      - `ImageViewer` *(kind=image; full-width; zoom/pan; `ImageRegionLayer` — suggest-image spec)*
    - `AnnotationsRail`
      - `RailHeader`: `StatusChip` ×3 *(Open · Resolved · Suggestion — icon + count, multi-toggle, all on by default; filters the thread list + dims non-matching marks, C-009)* · empty state · no-match state
      - `ThreadCard`: `QuoteRef` · avatar · name · time · body · `ReplyList` *(flat)* · `SuggestBadge`/`ResolvedBadge`
      - `DetachedSection` *(amber; `isOrphaned`; Re-attach/Dismiss actions are commenting/suggest specs)*
      - `Composer` *(the create/reply UI is the commenting spec; this shell renders the slot)*
  - `CommentFab` *(drawer mode; count → opens rail)*
  - `DrawerScrim`

> The `ShareButton`/`VersionButton` open panels owned by sibling specs (`sharing-permissions-ui`,
> `versioning-diff-ui`) — not built here; the top bar only wires the buttons.

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| App shell + router | `apps/web/src/app/` | add the `/d/:slug` route + viewer layout (outside the workspace `/w/:id` shell) |
| Theme toggle + tokens | `apps/web/src/app/`, `styles.css` | reuse the DESIGN.md tokens + theme switch |
| Icon set | `apps/web/src/components/icon.tsx` | reuse (inbox/shield/list/chevLeft/share/more present) |
| Typed Eden client | `apps/web/src/lib/api.ts` | add a viewer/annotation client slice |
| Doc cards / sidebar recent | `apps/web/src/features/docs/{doc-card,doc-list}.tsx`, `app/app-sidebar.tsx` | their `/d/:slug` links now resolve to this React route |

### System Impact & Technical Risks

- **Backend is ~90% built** (annotation-core: 6 routes wired, 542 tests) but has runtime gaps this FE
  depends on: **block-id injection not wired at serve** (GAP-002 — highlights can't anchor reliably)
  and the annotation **API path is workspace-scoped**, not what the BE spec documents (GAP-001). Both
  must be settled for S-003 to work end-to-end.
- The viewer route `/d/:slug` is greenfield in the SPA; the current bare server-rendered `/d` page is
  a stopgap this replaces. In dev, the Vite proxy forwards only `/api` `/mcp` — the React route serves
  the shell and uses `/v/:id` (via `/api`-style proxying or absolute backend origin) for the HTML iframe;
  confirm the dev proxy/origin for `/v` (GAP-003).
- Resolving each annotation's anchor (`block_id`+`text_snippet`+offset) to an in-text highlight range
  is non-trivial (reuse Plannotator mark rendering) — risk concentrated in S-003.

## Not in Scope

- Creating / replying / resolving comments, the selection popover, guest commenting, the HTML-sandbox
  selection bridge — `annotation-core-ui-commenting` (mounts into this shell).
- Suggestions (create / accept / reject / stale) + image-region annotations (pin/box) — `annotation-core-ui-suggest-image`.
- Version history panel + diff view (`VersionButton` opens them) — `versioning-diff-ui` (not built).
- Share dialog + link gates (`ShareButton` opens it) — `sharing-permissions-ui` (not built).
- Preview/Edit toggle + Markup mode behavior — deferred (no in-app editing in v0).
- The re-anchor matcher itself + block-id injection — `annotation-core` (backend); this FE consumes the result.

## Gaps

- GAP-001 (status: resolved — G1, 2026-06-11): the annotation API path is workspace-scoped
  `/api/w/:workspaceId/docs/:slug/annotations`. The `annotation-core` backend spec's `## API` table is
  stale (lists `/api/docs/:slug/…`) and is being updated (Mode C). The FE pins the workspace-scoped path.
- GAP-002 (status: resolved — G2, 2026-06-11): block-id injection happens at **serve time** (in the
  viewer loaders / `/v` content route), transparent to storage; each served version gets `data-block-id`
  in DOM order. Backend build-blocker for S-003. Durability stays snippet+fuzzy (block-id is a hint).
- GAP-003 (status: resolved — G5, 2026-06-11): the Vite dev proxy will forward `/v` (and `/d`) to the
  backend too, so the iframe `src` uses a relative path matching prod same-origin.
- GAP-004 (status: resolved — G6, 2026-06-11): the FE derives the TOC outline from headings (h1–h3) in
  the rendered content; no backend outline payload for v0. Spec priority badges (P0/P1) are dropped in
  v0 (no data); revisit if the backend serves a structured outline later.
- GAP-005 (status: resolved — G7, 2026-06-11): when the FE cannot place a highlight at runtime (snippet
  matches zero/multiple times, block missing) — distinct from backend `isOrphaned` — the thread is still
  shown in the rail, flagged "couldn't place" (no scroll-to target), never crashing or silently dropped.
- GAP-006 (status: open — owner: backend, IN v0 per G8): a backend dismiss + re-attach surface for a
  detached annotation (dismiss removes from the active list; re-attach sets the anchor to a new range).
  Required by S-004 AS-016/AS-017. Source: G8 decision 2026-06-11.
- GAP-007 (status: open — owner: backend/FE, IN v0): the viewer annotation read must deliver the
  COMPLETE active set (C-008 / AS-021), not one page. The endpoint already materializes the full set
  and slices to a default page of 20 — the FE viewer requests only the first page, so a doc with >20
  annotations loses the rest from the rail AND the doc (no highlight). Fix = the viewer read returns
  the complete set (FE requests it unpaginated / a complete-set mode on the read). Required by S-003.
  Source: live confirmation 2026-06-17 (calendar-integration-foundations: dashboard 23, rail 20).
  NOTE: when MCP `pull-annotations` is built it MUST likewise read the complete set, never page 1.

## Clarifications — 2026-06-11

Gap-resolution loop (G1–G11) decisions affecting this spec:
- G1: API path → workspace-scoped (backend spec updated via Mode C).
- G2: block-id injection → serve-time, transparent to storage.
- G4: HTML annotation → **in v0** (build the sandbox bridge; not deferred).
- G5: dev → Vite proxies `/v` + `/d` to the backend (relative iframe `src`).
- G6: TOC outline → FE-derived from headings; P-badges dropped for v0.
- G7: un-placeable highlight → thread shown, flagged "couldn't place".
- G8: detached → **Re-attach + Dismiss both built in v0** (needs backend surface, GAP-006).
- G11: image-region → `ImageViewer` exposes natural-dims + transform (suggest-image C-006).

## Spec Sizing Notes

Stories=7 (target 7, at soft target). AS=26 (target 20, in G7 overage range ≤30).

This is sub-spec 1 of a 3-way by-flow split of annotation-core-ui (forced by the "everything, no
phasing" scope decision 2026-06-11): viewer+read (this) · commenting · suggest+image. Each sub-spec
is self-contained.

G1 splits producing the over-target AS (each AS = one stated atom, no AS gộp):
- S-007 status chips: 5 AS for 5 atoms — render-chips (AS-022), toggle-off hides+dims (AS-023),
  toggle-on restores (AS-024), no-group no-match state (AS-025), act-on-filtered-out re-activates
  (AS-026). The off/on pair and the no-match/re-activate edges are distinct assertions, not variants.

No bloat — each AS traces to one stated atom.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-11 | Initial creation — FE viewer shell + read/display (sub-spec 1 of 3; direction B React viewer) | -- |
| 2026-06-11 | /mf-challenge: + Prerequisites (block-id/anchor-algo/API-path as build-blockers); C-002 existence-hiding tightened (404→no-access); S-003 blocked-until + GAP-005 (couldn't-place highlight); C-004 detached v0 view-only + GAP-006 (dismiss surface) | -- |
| 2026-06-11 | Gap-loop G1–G11 resolved: GAP-001/002/003/004/005 resolved (decisions); S-004 expanded to Re-attach+Dismiss in v0 (AS-016/017, GAP-006 → backend surface in v0); + Clarifications | -- |
| 2026-06-14 | Kind-conditional layout (Major, M4+M6, snapshot 2026-06-14): + C-006 (markdown=3-pane collapsible outline·prose content·rail; html/image=2-pane full-width content·rail, no outline/outline-toggle); S-001 AS-001/002/003 pin per-kind layout + html/image full-width; S-002 scoped to Markdown (AS-005/006) + AS-018 (collapse outline); S-005 outline-toggle markdown-only; AS-014 responsive per-kind | -- |
| 2026-06-14 | HTML full-bleed (Major, M5, snapshot 2026-06-14-3): AS-002 Then — HTML iframe is full-bleed (edge-to-edge, no side padding/margin) and fills the available height, not just full-width; C-006 note added. Verified E2E (leftGutter/rightGutter=0, iframe fills pane height). | -- |
| 2026-06-14 | In-pane outline collapse (Major, M4 + new AS, snapshot 2026-06-14-2): AS-018 When disambiguated to the top-bar toggle; + AS-019 (collapse via a chevron beside the outline search inside the pane, top-bar toggle re-expands); UI Notes TocSidebar gains `TocCollapse`; C-006 coverage += AS-019 | -- |
| 2026-06-17 | Live badge = share state (Major, M5+M6, snapshot 2026-06-17-core-ui-live-badge): AS-012 Given/Then — the Live badge is shown when the doc is SHARED (general access beyond restricted), matching the dashboard list, NOT when merely published; + AS-020 (restricted doc → no Live badge, reads Draft); + C-007. Pins the fix for the list/detail status mismatch (commit 3f75006: viewer-top-bar isLive ← generalAccess, not status). | -- |
| 2026-06-18 | Rail completeness + status chips (Major, M1+M6, snapshot 2026-06-18-core-ui-rail-chips): S-003 + AS-021 (rail loads the COMPLETE active set; total = dashboard count — pins the 23-vs-20 mismatch on calendar-integration-foundations); + S-007 status chips (AS-022..026: Open·Resolved·Suggestion icon+count, multi-toggle, filter rail + dim marks, no-match state, focus-reactivates); + C-008 (complete-set read), C-009 (chip partition + filter); + GAP-007 (backend/FE: viewer read must deliver the complete set, not page 1; MCP pull-annotations likewise); Data Model client-state += status filters; UI Notes RailHeader = StatusChip×3. Source: docs/explore/annotation-rail-completeness.md + clarify 2026-06-18. | -- |
