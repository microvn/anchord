# Spec: annotation-core-ui-suggest-image

**Created:** 2026-06-11
**Last updated:** 2026-06-11
**Status:** Draft

## Overview

The two specialized annotation types in the doc viewer FE: **suggestions** (a reviewer proposes a
replace on a text range; the author accepts/rejects — status only, the content never auto-edits) and
**image-region annotations** (pin a point or box a region on an image, stored in normalized
coordinates that survive zoom/resize). Consumer side of `annotation-core`'s suggestion + image-region
endpoints. Mounts into the viewer shell from `annotation-core-ui`. Sub-spec 3 of the 3-way split.

## Data Model

No persistent data — a client. Writes via the typed client:
- create suggestion: `{ anchor, from, to, againstVersion }` (a text-range suggestion of type replace).
- decide suggestion: `{ decision }` accept | reject.
- create image-region annotation: `{ type: image-region, anchor{ region: point|box, normalized 0..1 coords } }`.

## Stories

### S-001: Create a replace suggestion (P1)

**Description:** As a reviewer, I select a text range and propose a replacement; a suggestion-type
annotation is created (replace, from→to) without changing the doc content.
**Source:** annotation-core S-006 (AS-014), C-003; `POST …/suggestions`. Prototype: `viewer.jsx` SelectionPopover "Suggest" + ThreadCard SuggestBadge.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` new `apps/web/src/features/viewer/suggestion-composer.tsx`, extends thread-card.tsx + `features/viewer/client.ts` (createSuggestion); mounts into `annotation-core-ui:S-001` shell + the commenting popover's Suggest action
- `autonomous:` true
- `verify:` select text → popover Suggest → enter replacement → send → a suggestion thread (Suggestion badge, from→to) appears; the doc content is unchanged.

**Acceptance Scenarios:**

AS-001: Create a replace suggestion without editing content
- **Given:** a reviewer selects a text range in the viewer
- **When:** they choose Suggest, enter the replacement text, and send
- **Then:** a suggestion-type annotation (replace, from→to) is created with the default pending status; a thread with a Suggestion badge shows the from→to; the rendered doc content does NOT change
- **Data:** replace "24h" → "48h"

### S-002: Accept or reject a suggestion (P1)

**Description:** As the doc author, I accept or reject a pending suggestion; only its status changes —
the doc content is not edited (applying the change is an MCP round-trip). A stale suggestion (whose
`from` no longer matches) is shown differently and is not accepted.
**Source:** annotation-core S-006 (AS-015/022), C-003/C-011; `PATCH …/suggestions/:id`. Prototype: ThreadCard SuggestBadge (no decision UI yet → designed, see GAP-001).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/thread-card.tsx`, client.ts (decideSuggestion)
- `autonomous:` true

**Acceptance Scenarios:**

AS-002: Accepting a suggestion changes status only
- **Given:** the author views a pending replace suggestion
- **When:** they click Accept
- **Then:** the suggestion shows accepted; the rendered doc content stays intact (no in-app edit)
- **Data:** accept "24h"→"48h"

AS-003: Rejecting a suggestion changes status only
- **Given:** the author views a pending suggestion
- **When:** they click Reject
- **Then:** the suggestion shows rejected; the doc content stays intact
- **Data:** reject a suggestion

AS-004: A stale suggestion is shown differently and cannot be accepted
- **Given:** a suggestion whose `from` ("24h") no longer matches the current version (the author republished without "24h")
- **When:** the author opens the thread / tries to accept
- **Then:** it shows as stale (distinct from pending) and accept does not apply it
- **Data:** current version no longer contains "24h"

### S-003: Pin a point on an image (P0)

**Description:** As a commenter on an image doc, I click a point on the image and comment; a pin
annotation is created storing normalized coordinates relative to the original image.
**Source:** annotation-core S-002 (AS-005), C-006; `POST …/annotations` (image-region point). No prototype UI (ImageViewer is a placeholder) → designed, GAP-001.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` new `apps/web/src/features/viewer/image-region-layer.tsx` (over the sibling `ImageViewer`), client.ts
- `autonomous:` true
- `verify:` open an image doc → click a point → comment → a pin shows at that point + a thread; the pin maps to normalized 0..1 coordinates on the original image.

**Acceptance Scenarios:**

AS-005: Click a point on an image to pin a comment
- **Given:** a commenter has an image doc open
- **When:** they click a point on the image, enter a comment, and send
- **Then:** a pin (point) annotation is created storing normalized 0..1 coordinates relative to the original image; the pin + thread show
- **Data:** click at ~ (0.4, 0.6)

AS-006: Dismissing without commenting creates no pin
- **Given:** the user clicked a point and the composer opened
- **When:** they dismiss without entering a comment
- **Then:** no pin / annotation is created
- **Data:** click then cancel

### S-004: Box a region on an image (P0)

**Description:** As a commenter, I drag a rectangle on an image and comment; a box-region annotation
is created in normalized coordinates.
**Source:** annotation-core S-002 (AS-006), C-006; `POST …/annotations` (image-region box). No prototype UI → designed, GAP-001.

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/image-region-layer.tsx`
- `autonomous:` true

**Acceptance Scenarios:**

AS-007: Drag a rectangle to box a region
- **Given:** a commenter has an image doc open
- **When:** they drag a rectangle and comment
- **Then:** a box-region annotation is created storing normalized coordinates; the region outline + thread show
- **Data:** box (0.1,0.1)–(0.5,0.4)

AS-009: A zero-area drag does not create a region
- **Given:** a commenter has an image doc open
- **When:** they click-drag without moving (a zero/near-zero area box)
- **Then:** no region annotation is created and no composer opens (treated like an empty selection)
- **Data:** a 0×0 drag

### S-005: Image marks stay in place across zoom/resize (P1)

**Description:** As a viewer, a pin/region stays at the correct spot on the image when I zoom or open
it on a different screen size (normalized coordinates don't drift).
**Source:** annotation-core S-002 (AS-007), C-006. No prototype (zoom on placeholder only) → designed.

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/image-region-layer.tsx`
- `autonomous:` true

**Acceptance Scenarios:**

AS-008: A pin holds its position across zoom
- **Given:** a pin already placed on an image
- **When:** the viewer zooms in then out (and the viewport width changes)
- **Then:** the pin stays at the same point on the original image (its normalized coordinates do not drift)
- **Data:** zoom 200% then 50%

## Constraints & Invariants

- C-001: A suggestion NEVER edits the doc content — accept/reject only changes its status; applying
  the change is an MCP round-trip (out of scope here). (AS-001, AS-002, AS-003)
- C-002: A suggestion whose `from` no longer matches the current version is shown as stale (distinct
  from pending) and is not accepted/applied from the FE. (AS-004)
- C-003: Image-region annotations store normalized 0..1 coordinates relative to the original image;
  marks are durable across zoom and screen-size changes. (AS-005, AS-007, AS-008)
- C-004: Creating any annotation (suggestion or image-region) is re-authorized server-side by session
  role; an empty/cancelled compose creates nothing. (AS-006, AS-009)
- C-005: Accept/reject changes ONLY the suggestion's status — the proposed edit is applied later by an
  agent via MCP republish (`mcp-roundtrip`), NOT in-app. The FE shows the status (pending / accepted /
  rejected / stale), never an applied-content preview; the `from`→`to` text renders inert (plaintext,
  never HTML — same rule as commenting C-008). (AS-002, AS-003, AS-004)
- C-006: `ImageRegionLayer` consumes a coordinate contract from `ImageViewer` — the rendered image's
  natural width/height + current zoom/viewport — to map a click/drag to normalized 0..1 coords and to
  re-project marks on zoom/resize; the same point always maps to the same normalized coords. (AS-005, AS-008)

## Linked Fields

annotation-core-ui-suggest-image is the **consumer**; `annotation-core` (backend) is the producer.

- create suggestion `{anchor,from,to,againstVersion}` → `{suggestionId}` — consumed by S-001. Produced
  by `POST …/docs/:slug/suggestions`. ✔ (workspace-scoped path caveat, annotation-core-ui:GAP-001).
- decide suggestion `{decision}` → `{status accepted|rejected|stale}` — consumed by S-002. Produced by
  `PATCH …/suggestions/:id` (returns `stale` + refuses to apply when `from` drifted, C-011). ✔.
- create image-region annotation `{type:image-region, anchor.region}` — consumed by S-003/S-004.
  Produced by `POST …/annotations` (image-region). ✔ (path caveat).

## UI Notes

Design: prototype shows the suggest action + badge but **no decision UI and no image-region layer**
(ImageViewer is a placeholder) — those parts are DESIGNED here, consistent with the system (GAP-001).
Mount into the `annotation-core-ui` shell. Precedence: AS / Constraints > prototype > Tree. All `[N]`.

- `SuggestionComposer` `[N]` *(when popover Suggest chosen)*: shows the selected `from`, a replacement
  `to` field, send — produces a replace suggestion
- `SuggestionThreadCard` `[N]` *(extends ThreadCard)*: `SuggestBadge` · from→to diff display ·
  `AcceptRejectActions` *(author only; hidden/disabled when stale)* · `StaleBadge`
- `ImageRegionLayer` `[N]` *(absolutely positioned over the sibling `ImageViewer`)*
  - `RegionPin` *(click = point; positioned by normalized coords)*
  - `RegionBox` *(drag = rectangle; normalized coords)*
  - region marks re-project on zoom/resize from normalized coords (C-003)

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| Viewer shell + ImageViewer + ThreadCard | `apps/web/src/features/viewer/` (`annotation-core-ui`) | mount the suggestion decision UI + image-region layer in |
| SelectionPopover (Suggest action) | `apps/web/src/features/viewer/selection-popover.tsx` (`annotation-core-ui-commenting`) | the Suggest button opens `SuggestionComposer` |
| Typed client | `apps/web/src/features/viewer/client.ts` | extend with createSuggestion/decideSuggestion/createImageRegion |

### System Impact & Technical Risks

- **No prototype** for the suggestion decision UI (accept/reject/stale) or the image-region layer
  (pin/box) — both designed here; confirm against a future mockup if one lands (GAP-001).
- Image-region depends on the sibling `ImageViewer` exposing the rendered image's natural dimensions
  so a click/drag maps to normalized 0..1 coordinates — coordinate mapping is the main risk.
- Backend suggestion + image-region endpoints are built + tested (`POST …/suggestions`, `PATCH
  …/suggestions/:id`, image-region via `POST …/annotations`); the stale check (C-011) depends on
  backend block-id injection being live (annotation-core-ui:GAP-002).

## Not in Scope

- Rendering the doc / image, reading annotations, the rail layout — `annotation-core-ui` (shell).
- The selection popover + text comment + bridge — `annotation-core-ui-commenting` (the Suggest button lives in that popover; this spec owns what it opens).
- Actually applying an accepted suggestion into content — `mcp-roundtrip` (immutable model; not in-app).
- Image asset storage / the image viewer's zoom/pan itself — `render-publish` (this adds the region overlay on top).

## Gaps

- GAP-001 (status: resolved — G10, 2026-06-11): the prototype has the Suggest action + suggest badge
  but no accept/reject-decision UI and no image-region layer; the designed components
  (`SuggestionThreadCard` accept/reject/stale = two `tlink`s like Reply/Resolve; `ImageRegionLayer`
  overlay on `ImageViewer`) are ACCEPTED as the build target (consistent with system taxonomy). No
  mockup wait.
- GAP-002 (status: resolved — G11, 2026-06-11): the `ImageViewer` (render-publish/viewer shell) MUST
  expose its coordinate contract (natural width/height + current zoom/viewport) — pinned as C-006;
  `ImageRegionLayer` consumes it. Build-prerequisite on `ImageViewer`.
- GAP-003 (status: resolved-dependency — G2, 2026-06-11): the stale check depends on backend block-id
  injection at serve time (decided G2: serve-time). Blocked until that backend work lands.

## Clarifications — 2026-06-11

Gap-loop decisions: G10 — accept the designed suggestion-decision UI + image-region layer (no mockup
wait). G11 — `ImageViewer` exposes the coordinate contract (C-006). G2 — block-id injection is
serve-time (the stale check + anchor depend on it). All three are build-prerequisites, not open
questions.

## Spec Sizing Notes

Stories=5, AS=9 — under the soft target. Sub-spec 3 of the 3-way annotation-core-ui split
(viewer+read · commenting · suggest+image), each self-contained, forced by the no-phasing scope
decision 2026-06-11.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-11 | Initial creation — FE suggestions (create/accept/reject/stale) + image-region (pin/box/zoom-stable); sub-spec 3 of 3 | -- |
| 2026-06-11 | /mf-challenge: + C-005 (accept=status-only, applied via MCP later, from→to inert) + C-006 (ImageViewer coordinate contract); GAP-002 raised to prerequisite + GAP-003 stale-check depends on block-id | -- |
| 2026-06-11 | Gap-loop: GAP-001 resolved (designed UI accepted, G10), GAP-002 resolved (ImageViewer contract, G11), GAP-003 resolved-dependency (serve-time block-id, G2); + Clarifications | -- |
