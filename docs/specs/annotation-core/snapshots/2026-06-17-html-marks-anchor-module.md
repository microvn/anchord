# Snapshot: annotation-html-marks
**Date:** 2026-06-17
**Ref:** --
**Reason:** M1 (new story S-005 — anchor placement parity via the shared module), M6 (new constraints C-007/C-008)

---

# Spec: annotation-html-marks

**Created:** 2026-06-17
**Last updated:** 2026-06-17
**Status:** Draft
**Snapshot limit:** 5 (per-spec; the `snapshots/` dir is shared across annotation-core specs — rotate by THIS spec's snapshots only, never by raw file count)

## Overview

Bring an **HTML doc's** in-content annotation highlights to full parity with the markdown viewer. An
HTML doc renders inside a sandboxed, opaque-origin iframe (`sandbox="allow-scripts"`, no
`allow-same-origin`), so the parent app cannot read or write the iframe's DOM, selection, styles, or
scroll — every highlight operation must go through a **backend-injected in-iframe bridge** talking to
the parent over a `MessageChannel`. Today that bridge is a stub: it draws a bare, unstyled `<mark>` on
create + on load, but lacks everything else the markdown highlight engine does — app styling, type/
state appearance (resolved / redline / stale / type hue), removal on delete, and click/scroll/focus
pairing. This spec specifies the HTML realization of all of it.

This is a **scope-by-layer sibling**: the doc-agnostic BEHAVIOR is already specced in
`annotation-core-ui`:S-003 (AS-007 highlight, AS-008 click→thread, AS-009 thread→scroll, AS-010
resolved-dim) and the per-type appearance in `annotation-core-ui-types-modes` (C-002 redline/stale,
"like/label highlight") + `annotation-actions-ui` (the hue). Those were built for the **inline
markdown** path (app DOM, `annotation-marks.ts`) only. This spec specifies the **iframe/bridge** path
that realizes the SAME behavior for `kind=html`. It adds no new product behavior — only HTML parity.

## Data Model

No new persisted data. Two contracts change:

- **The bridge highlight message carries the mark's STATE**, not just `{anchor, id}`. Per annotation
  the parent sends `{ annotationId, anchor, resolved, kind, stale, hue }` so the in-iframe draw can
  reproduce the markdown mark's appearance. (Markdown sets these as `data-resolved` / `data-anno-kind`
  / `data-anno-stale` / `data-anno-hue` + `--mark-hue` on the `<mark>`; the in-iframe draw applies the
  same.)
- **The served iframe content carries the highlight stylesheet.** The backend already injects the
  bridge `<script>` into the `/v/:id` HTML; it must ALSO inject the highlight CSS (the `.anno-mark`
  rule set — base, hue, resolved, redline, stale, focus) so a drawn mark renders in the app's visual
  language inside the opaque iframe (which has none of the app's styles). The hue/status palette
  values are the same ones DESIGN.md pins for the markdown marks.

The in-iframe highlight set is **idempotent**: a sync replaces it wholesale (unwrap all existing
`<mark data-anno>` then redraw the provided set), mirroring `placeAnnotations`' clear-then-place.

## Stories

### S-001: An HTML doc's highlights render in the app's highlight style (P0)

**Description:** As a reviewer opening an HTML doc, each anchored annotation shows the app's highlight
treatment (the teal-accent underline/tint, and the per-type hue — Comment amber, Label gold) on the
quoted text — the same look as a markdown doc — not the browser's default yellow `<mark>`.
**Source:** annotation-core-ui:S-003/AS-007 (annotations show as in-text highlights), realized for the
HTML iframe; annotation-actions-ui marks hue (4 tool colors); DESIGN.md type/tool palette.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/backend/src/annotation/sandbox-bridge.ts` (inject the mark stylesheet; the in-iframe draw sets `class="anno-mark"` + hue), `apps/backend/src/render/sandbox.ts` (CSP allows the injected style), `apps/web/src/features/viewer/components/html-sandbox-frame.tsx` + `apps/web/src/features/viewer/lib/bridge.ts` (send hue in the highlight payload)
- `autonomous:` true
- `verify:` open an HTML doc with annotations → each highlight shows the app teal/hue treatment (not default yellow); a label highlight is gold, a comment amber.

**Acceptance Scenarios:**

AS-001: An HTML highlight uses the app highlight style, not the browser default
- **Given:** an HTML doc with a comment annotation anchored to a phrase
- **When:** the doc opens in the sandbox iframe
- **Then:** the quoted phrase shows the app's highlight treatment (accent underline + soft tint), NOT
  the browser-default `<mark>` yellow block
- **Data:** a comment on "webhook receiver"

AS-002: An HTML highlight carries its type/label hue
- **Given:** an HTML doc with a label annotation (e.g. the "looks-good"/a preset label) and a plain comment
- **When:** the doc opens
- **Then:** the label highlight renders in the Label hue (gold) and the comment highlight in the Comment hue (amber)
- **Data:** one label + one comment annotation

AS-003: An anchor that cannot be located shows couldn't-place, never an unstyled or crashing mark
- **Given:** an HTML doc and an annotation whose stored snippet no longer matches the content
- **When:** the doc opens
- **Then:** no highlight is drawn for it and its rail thread is flagged couldn't-place; the iframe does
  not crash and other highlights still render
- **Data:** an annotation whose snippet was removed from the doc

AS-013: A cross-block highlight is drawn on every block it spans, not just the first
- **Given:** an HTML doc and an annotation whose selection spans more than one block (a multi_range
  anchor carrying a segment per spanned block — e.g. text running from one list item through a later one)
- **When:** the doc opens
- **Then:** the highlight covers EVERY spanned block end-to-end (it reaches the last block's quoted text),
  not just the first block; the un-spanned blocks before and after stay unhighlighted
- **Data:** an annotation spanning 4 blocks, ending mid-list at "(4 stories, 13 AS)."

### S-002: An HTML highlight reflects the annotation's lifecycle state (P1)

**Description:** As a reviewer, an HTML highlight shows the same state appearance as a markdown one — a
resolved annotation dims, a redline (delete proposal) shows the red strikethrough, and a drifted
(stale) redline shows the distinct muted/dashed treatment (not a confident strike).
**Source:** annotation-core-ui:S-003/AS-010 (resolved dimmed) + annotation-core-ui-types-modes:C-002
(redline strike; stale render-time style), realized for the HTML iframe.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/annotation/sandbox-bridge.ts` (apply resolved/kind/stale to the drawn mark + the injected CSS), `apps/web/src/features/viewer/lib/bridge.ts` + `apps/web/src/features/viewer/components/html-sandbox-frame.tsx` (send resolved/kind/stale in the payload)
- `autonomous:` true

**Acceptance Scenarios:**

AS-004: A resolved annotation's HTML highlight dims
- **Given:** an HTML doc with a resolved annotation
- **When:** the doc opens
- **Then:** its highlight renders in the resolved (dimmed) treatment, distinct from an active highlight
- **Data:** a resolved comment

AS-005: A redline's HTML highlight is a red strikethrough
- **Given:** an HTML doc with a pending redline (delete-kind suggestion)
- **When:** the doc opens
- **Then:** the redlined text renders with the red strikethrough treatment (the doc content is NOT edited)
- **Data:** a redline on a sentence

AS-006: A stale redline's HTML highlight is the distinct stale treatment
- **Given:** an HTML doc with a redline whose pinned span has drifted (stale)
- **When:** the doc opens
- **Then:** the highlight renders in the muted/dashed stale treatment, not a confident red strike
- **Data:** a redline whose snippet shifted

### S-003: Deleting an annotation removes its HTML highlight; restoring re-draws it (P0)

**Description:** As a reviewer, when I delete an annotation its in-content highlight disappears from the
HTML doc (not just the rail card); restoring it brings the highlight back. The highlight set stays in
sync with the live annotation set after any add/delete/restore.
**Source:** annotation-actions-ui:S-003 (delete + restore + undo) realized for the HTML iframe; the bug
where a deleted annotation's iframe mark persisted.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/annotation/sandbox-bridge.ts` (clear-then-redraw sync: unwrap-all + draw the set), `apps/web/src/features/viewer/lib/bridge.ts` (a batch highlight-set message), `apps/web/src/features/viewer/components/html-sandbox-frame.tsx` (send the full current set on change)
- `autonomous:` true
- `verify:` delete an annotation on an HTML doc → its highlight disappears from the content; undo/restore → it returns.

**Acceptance Scenarios:**

AS-007: Deleting an annotation removes its highlight from the HTML content
- **Given:** an HTML doc showing a highlight for an annotation I can delete
- **When:** I delete that annotation
- **Then:** its highlight is removed from the iframe content (the quoted text returns to normal); the
  other highlights remain
- **Data:** delete one of several annotations

AS-008: Restoring a deleted annotation re-draws its highlight
- **Given:** I just deleted an annotation on an HTML doc (its highlight gone)
- **When:** I undo/restore it
- **Then:** its highlight reappears on the quoted text
- **Data:** restore the just-deleted annotation

AS-009: A newly created annotation's highlight appears without disturbing the others
- **Given:** an HTML doc with existing highlights
- **When:** I create a new annotation on a selection
- **Then:** the new highlight appears and the existing highlights stay intact (the sync is idempotent —
  no duplicate or dropped marks)
- **Data:** create one redline while two comments already exist

AS-010: A refused delete keeps the highlight in place
- **Given:** an HTML doc highlight whose delete is refused (role revoked / failed write)
- **When:** the delete comes back refused and the annotation stays in the served set
- **Then:** the highlight remains drawn on the quoted text (the sync redraws the still-present
  annotation) — no highlight is silently lost
- **Data:** a delete that is refused

### S-004: Click an HTML highlight to focus its thread; focusing a thread scrolls the iframe to it (P1)

**Description:** As a reviewer, clicking a highlight inside the HTML doc focuses its rail thread, and
focusing a thread (clicking the rail card) emphasizes its highlight and scrolls the iframe to bring it
into view — the same pairing markdown docs have.
**Source:** annotation-core-ui:S-003/AS-008 (click highlight → focus thread) + AS-009 (click thread →
scroll to + emphasize highlight), realized for the HTML iframe.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/annotation/sandbox-bridge.ts` (relay a mark-click up; handle a focus/scroll message in-iframe), `apps/web/src/features/viewer/lib/bridge.ts` + `apps/web/src/features/viewer/components/html-sandbox-frame.tsx` (mark-click handler + post focus), `apps/web/src/features/viewer/components/viewer-screen.tsx` (wire mark-click → focus the rail thread; thread focus → post focus to the frame)

**Acceptance Scenarios:**

AS-011: Clicking a highlight in the HTML doc focuses its rail thread
- **Given:** an HTML doc showing several highlights + their rail threads
- **When:** I click a highlighted range in the iframe
- **Then:** the matching rail thread becomes focused (and the rail opens on a narrow layout)
- **Data:** click the 2nd highlight

AS-012: Focusing a thread emphasizes + scrolls the iframe to its highlight
- **Given:** an HTML doc whose highlight for a thread is scrolled out of view
- **When:** I focus that thread from the rail
- **Then:** the iframe scrolls to bring the highlight into view and the highlight is emphasized
- **Data:** focus a thread anchored below the fold

## Constraints & Invariants

- C-001: For an HTML doc, highlights are drawn ONLY by the in-iframe bridge over the trusted
  `MessageChannel` port — the parent NEVER reads or writes the opaque iframe's DOM directly (the
  sandbox isolation is the security boundary; this spec must not weaken it, e.g. must not add
  `allow-same-origin`). (AS-001, AS-007, AS-011)
- C-002: The HTML highlight set is idempotent — on any change to the annotation set the iframe unwraps
  ALL existing annotation marks then redraws the current set (clear-then-place), so add / delete /
  restore / re-anchor never leave a stale or duplicate mark. (AS-007, AS-008, AS-009, AS-010)
- C-003: An HTML highlight carries the SAME visual states as the markdown highlight — base accent, the
  type/label hue, resolved (dim), redline (red strike), stale (muted/dashed) — driven by the served
  annotation state, using the DESIGN.md palette injected into the iframe. (AS-001, AS-002, AS-004, AS-005, AS-006)
- C-004: A highlight whose anchor can't be located in the current content is reported couldn't-place
  (thread shown, no mark) and never crashes the iframe script or drops the other marks. (AS-003)
- C-005: Interaction parity — clicking a highlight focuses its rail thread; focusing a thread
  emphasizes + scrolls the iframe to its highlight. (AS-011, AS-012)
- C-006: A highlight range that spans multiple text nodes / child elements (a container block, or text
  broken by inline tags / line breaks) is wrapped per text node (one mark per intersected node), never
  via a single whole-range wrap that fails across element boundaries. (AS-001, AS-005)
- C-007: A multi_range anchor (one carrying `segments[]`, one segment per spanned block) is drawn on
  EVERY spanned block — each segment is located and wrapped in its own block — not only the top-level
  `blockId`; a couldn't-place is reported only when NO segment of the anchor places. This mirrors the
  markdown engine's per-segment placement. (Distinct from C-006: C-006 wraps across text nodes within a
  single block; C-007 fans out across blocks.) (AS-013)

## Linked Fields

annotation-html-marks (the FE parent + the in-iframe bridge) consumes annotation state the backend reads serve.

- `status` (resolved) — consumed by S-002/AS-004 to dim the HTML highlight. Produced on the annotations
  list read (annotation-core). ✔ served on the list.
- `suggestion.kind` (=delete → redline) + `suggestionStatus` (=stale) — consumed by S-002/AS-005/AS-006.
  Produced on the list read (annotation-core AS-030 + the decide path). ✔ served on the list.
- type/label hue — consumed by S-001/AS-002. Derived FE-side from `type`/`label`/`suggestion` (the same
  derivation `annotation-actions-ui`/viewer uses for markdown marks); no new backend field. ✔.
- delete/restore → set change — consumed by S-003. The deleted annotation drops from the list read
  (annotation-actions soft-delete exclusion); restore re-includes it. ✔ the set drives the sync.

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| HtmlSandboxFrame | `apps/web/src/features/viewer/components/html-sandbox-frame.tsx` | extend: send the full annotation set + state on change; post focus; relay mark-click |
| bridge (parent) | `apps/web/src/features/viewer/lib/bridge.ts` | extend: batch highlight-set message with state; focus message; onMarkClick |
| in-iframe bridge | `apps/backend/src/annotation/sandbox-bridge.ts` | extend: inject mark CSS; full-state draw; clear-then-redraw sync; mark-click relay; focus/scroll handler |
| sandbox CSP | `apps/backend/src/render/sandbox.ts` | confirm the injected `<style>` is allowed by the CSP |
| markdown mark engine | `apps/web/src/features/viewer/components/annotation-marks.ts` + `styles.css` (.anno-mark) | SOURCE OF TRUTH for the appearance + states the iframe must mirror (do not change) |

### System Impact & Technical Risks

- The in-iframe bridge is plain ES5 serialized into the iframe; it cannot import the app's TS/CSS, so
  the `.anno-mark` styling must be DUPLICATED as an injected stylesheet string (kept in sync with
  `styles.css` by value). Risk: drift between the two — mitigate by sourcing the palette from one place
  if practical, else note the coupling.
- Already shipped (do not rebuild): the cross-node per-text-node wrap (C-006), the place-existing-on-
  load + onPlaceFailed wiring, and the locate ladder (`placeAnchor`). This spec layers state + sync +
  interaction on top.
- Security: the opaque-origin sandbox is the isolation boundary. Nothing here may add `allow-same-
  origin` or read the iframe DOM from the parent (C-001).

## Not in Scope

- **Image-region annotations** (anchor type 2) — a separate deferred surface.
- **The doc's own scripts using `localStorage`** (theme switch crash) — a SEPARATE bug (the doc script,
  not the bridge); fix via an in-iframe storage shim, tracked elsewhere.
- **Hover-sync** (rail hover ↔ mark hover) — markdown doesn't have it either; out of parity scope.
- **Re-anchoring across versions inside the iframe** — handled by the backend re-anchor + the sync
  redrawing whatever the read serves; no iframe-specific re-anchor logic here.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-17 | Initial creation — HTML iframe highlight parity with the markdown engine: app styling + type/state appearance, clear-then-redraw sync (delete/restore), click/scroll/focus pairing, via the in-iframe bridge. Derived from the HTML-mark gap matrix (conversation 2026-06-16/17). Mode A. | -- |
| 2026-06-17 | Mode C (Major, M6) — added AS-013 + C-007: a cross-block (multi_range `segments[]`) highlight is drawn on EVERY spanned block, not just the top-level `blockId`. Documents the gap mf-fix closed (the bridge's draw side iterated no segments while markdown's `placeAnnotations` did → cross-block highlights stopped at the first block). Snapshot `2026-06-17-html-marks-crossblock.md`. | -- |
