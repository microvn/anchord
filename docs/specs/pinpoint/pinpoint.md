# Spec: Pinpoint Mode — whole-block annotation

**Created:** 2026-06-26
**Last updated:** 2026-06-27
**Status:** Draft

## Overview

Pinpoint is the second input mode in the viewer (the counterpart to Select). Instead of dragging
to select a text range, the reviewer toggles **Pinpoint**, hovers a block (paragraph / heading /
list item / table / code block) which outlines, and clicks it to annotate the WHOLE block. The
block annotation carries `type=block` and anchors to the block's id + its full text (reusing the
existing durable re-anchor). The same 5-type popover (Comment / Like / Label / Redline / Suggest),
the same comment thread, rail, sharing, and the hover peek + click-to-pin card all apply — Pinpoint
only changes the *scope* of the anchor (a whole block) and *how* it is picked (hover-outline + click
vs drag-select). This is the Phase-2 mode deferred from `annotation-core-ui-types-modes` (the toolbar
chip already exists, disabled). Covers BOTH markdown and HTML docs.
Source: `docs/explore/annotation-editor-types-modes.md#phase-2-pinpoint-mode`.

## Data Model

No new entity and no schema migration. A block annotation reuses the existing annotation row:
- `type = "block"` — already a value of the `annotation_type` enum (verified `db/schema.ts`).
- `anchor = { blockId, textSnippet, offset: 0, length: <full block text length>, segments?: undefined }`
  — the WHOLE block: `textSnippet` is the block's full text content, `offset` 0, `length` its length.
  This reuses the existing anchor SHAPE AND the shared re-anchor ladder UNCHANGED (see C-002):
  `blockId` is a positional HINT only (`block-{tag}-{n}`, document order — `block-id.ts`) that shifts
  when blocks are inserted/deleted across versions, so durability rides on `textSnippet` through the
  same ladder a range uses (hinted block → exact → normalized → fuzzy → whole-doc fallback ranked by
  context/tier/offset/specificity → orphan). A block annotation is NOT made stricter than a range.
  The one residual edge — two blocks with textually IDENTICAL content (two `### Notes` headings,
  repeated boilerplate rows) where the positional hint has shifted — can carry onto the wrong one of
  the identical pair; its worst case is landing on a block whose text is identical, so the harm is
  near-zero. Tightening that (tie → orphan) is a precision concern of the shared matcher
  (`annotation-reanchor`), tracked there — not a pinpoint special-case.

**Block text bounds + length unit (C-002).** `textSnippet` for a block can be large (a fenced code
block, a wide table) — unlike a range snippet, which is small by nature. To bound storage + the
per-version locate scan, a block's stored `textSnippet` is capped above a threshold —
`MAX_BLOCK_SNIPPET = 8192` UTF-16 units, stored as `head…⟨hash⟩…tail` (leading + trailing window
around a content hash) rather than the whole block verbatim — and `length` is the block text's full
length in the SAME unit the matcher counts (UTF-16 code units, to match `String.length` /
`locateRange`) so an emoji/CJK-heavy block does not desync offsets. (A small/normal block stays
verbatim; only blocks past the cap are abbreviated, and re-anchor then leans on `blockId` + `length`,
since the abbreviated snippet can't exact-match the whole block.)

**Empty / zero-length block.** A block with no text (`<hr>`, an image-only block, an empty paragraph)
has `length 0`; `buildAnchor` already returns `null` for empty/whitespace-only text
(`annotation.ts:84`). Pinpoint on such a block is a NO-OP (no outline pick → no create) — it is not
annotatable in v0 (see S-002 / AS-006b). Image regions are a separate anchor type (Not in Scope).

A block annotation differs from a `range` only in `type`, that its anchor spans the whole block (no
sub-range offset), and the strict-match + bounds rules above. Source:
`docs/explore/annotation-editor-types-modes.md` (data-model table) +
`apps/backend/src/annotation/annotation.ts` (anchor builder) + `apps/backend/src/db/schema.ts`
(`annotation_type`) + `apps/backend/src/annotation/block-id.ts` (positional id scheme).

## Stories

### S-001: Toggle Pinpoint mode (P0)

**Description:** As a reviewer, I switch the input mode between Select and Pinpoint in the toolbar;
in Pinpoint mode a text drag-selection no longer starts an annotation — only a block click does.
**Source:** `docs/explore/annotation-editor-types-modes.md#ui-expectation` (Mode switch Select ⇄ Pinpoint) + the disabled toolbar chip in `annotation-core-ui-types-modes:S-001`.
**Applies Constraints:** C-001

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/components/doc-mode-toolbar.tsx` (enable the Pinpoint chip; remove the required `onPinpointUnavailable` prop AND its call site — replace with an `onModeChange`/active-mode prop the parent drives), `apps/web/src/features/viewer/components/viewer-screen.tsx` (OWNS the input-mode state: add `inputMode: "select" | "pinpoint"`, lifted ABOVE `useCompose`; wire the chip to toggle it), `apps/web/src/features/viewer/hooks/use-compose.ts` (gate the text-selection→popover create path on `inputMode === "select"` — this is where AS-002's suppression actually lives, NOT the toolbar)
- `autonomous:` true
- `verify:` AS-001 (chip active state) → `cd apps/web && bun test doc-mode-toolbar`; AS-002 (selection suppressed in Pinpoint) → `cd apps/web && bun test compose` (the suppression gate is in `use-compose`, not the toolbar — `doc-mode-toolbar` cannot exercise it)

**Acceptance Scenarios:**

AS-001: The reviewer switches to Pinpoint mode
- **Given:** the viewer in the default Select mode
- **When:** the reviewer activates the Pinpoint chip in the toolbar
- **Then:** Pinpoint becomes the active input mode (the chip reads active); no "coming soon" notice appears
- **Data:** toolbar shows Select|Pinpoint; Pinpoint active after the click
- **Setup:** a doc open in the viewer, no annotation tool mid-compose

AS-002: A text selection in Pinpoint mode does not start a range annotation (error/edge)
- **Given:** Pinpoint mode is active
- **When:** the reviewer drags to select a span of text
- **Then:** no selection popover / range-create is triggered (the drag is inert for annotation); switching back to Select restores the normal text-selection create
- **Data:** a non-empty text drag while in Pinpoint → nothing created; toggle to Select → drag creates again
- **Setup:** markdown doc

### S-002: Pick a block and create a block annotation — markdown (P0)

**Description:** As a reviewer in Pinpoint mode on a markdown doc, I hover a block (it outlines),
click it, choose a type from the popover, and a whole-block annotation is created.
**Source:** `docs/explore/annotation-editor-types-modes.md#happy-path-pinpoint-mode-label` + data-model table (all 5 types valid on a block).
**Applies Constraints:** C-001, C-002, C-003

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/components/annotation-marks.tsx` (block targeting: hover-outline + block-click → blockId+rect), `apps/web/src/features/viewer/components/viewer-screen.tsx` (route a pinpoint block-pick → the 5-type popover → create — a block click is NOT a text selection, so it SYNTHESIZES the popover rect + a whole-block anchor and feeds the chooser directly; it does NOT go through the selection→compose path, and dismissing the popover must clear the block's outline state), `apps/web/src/features/viewer/hooks/use-compose.ts` (a new `buildBlockAnchor(blockId, element)` path: `textSnippet = element.textContent` capped per Data Model, `offset 0`, `length` = its UTF-16 length, `segments` undefined — beside the selection→anchor path), `apps/web/src/features/viewer/services/client.ts` (create call carries `type=block`), `apps/backend/src/routes/annotations.ts` (the create Zod schema already accepts `type=block` + the text-anchor shape — VERIFIED; add a `.refine` that `type=block ⇒ anchor.offset === 0`, defense-in-depth so a forged sub-range can't masquerade as a block). `apps/backend/src/annotation/annotation.ts` needs NO change for the happy path (`buildAnchor` already stores `{blockId, text, offset, length}` verbatim — VERIFIED `annotation.ts:272-280`).
- `autonomous:` true
- `verify:` `cd apps/web && bun test annotation-marks` AND `cd apps/web && bun test compose` (block targeting + block-anchor build; no unified `pinpoint` test file exists — tests are per-component)

**Acceptance Scenarios:**

AS-003: Hovering a block in Pinpoint mode outlines it
- **Given:** Pinpoint mode active on a markdown doc
- **When:** the reviewer moves the cursor over a paragraph block
- **Then:** that block shows a hover outline indicating it is the pick target; moving off it removes the outline
- **Data:** a paragraph with a `data-block-id`; hover → outlined, leave → not
- **Setup:** markdown rendered with block ids

AS-004: Clicking a block opens the 5-type popover anchored to it
- **Given:** Pinpoint mode active, cursor over an outlined block
- **When:** the reviewer clicks the block
- **Then:** the 5-type popover (Comment / Like / Label / Redline / Suggest) opens anchored at that block
- **Data:** click a heading block → popover offers all five types
- **Setup:** same as AS-003

AS-005: Choosing a type creates a whole-block annotation
- **Given:** the popover open for a clicked block
- **When:** the reviewer picks a type (e.g. Label "Out of scope")
- **Then:** an annotation is created with type=block, anchored to the whole block (the block id + its full text), carrying the chosen type/label; it appears in the rail
- **Data:** Label on block "block-p-7" → annotation { type: block, anchor spans the whole paragraph, label: out-of-scope }; rail shows the row
- **Setup:** commenter+ role

AS-006: A block annotation's quoted content renders as inert text (security/edge)
- **Given:** a block whose text contains HTML-like markup
- **When:** the block annotation is created and shown in the rail/peek
- **Then:** the block's text renders as literal text, never interpreted (same plaintext rule as a range annotation)
- **Data:** block text `<img onerror=…>` → shown literally

AS-006b: An empty / zero-length block is not annotatable (edge — empty block)
- **Given:** Pinpoint mode active, the cursor over a block with no text (`<hr>`, an image-only block, an empty paragraph)
- **When:** the reviewer clicks it
- **Then:** the pick is a NO-OP — no popover, no create (`buildAnchor` returns null for empty text; the block never carries a hover-outline pick target)
- **Data:** empty paragraph → click does nothing; an adjacent non-empty paragraph still picks normally

AS-006c: A large or unicode-heavy block is bounded (edge — size/length unit)
- **Given:** Pinpoint on a block whose text is large (a long fenced code block) or emoji/CJK-heavy
- **When:** the block annotation is created
- **Then:** the stored `textSnippet` is capped (head+tail+hash above the threshold, per Data Model) — not the whole block verbatim — and `length` is the UTF-16 length so offsets do not desync; the annotation still re-anchors to the same block
- **Data:** an 8 KB+ code block → snippet stored capped; a block with emoji → `length` matches the matcher's count

### S-003: A block annotation renders and is interactive — markdown (P0)

**Description:** As a reviewer, a block annotation marks the whole block (an outline/tint in its
type hue) and behaves like any annotation — hover shows the peek, click pins the thread card, the
rail row focuses it.
**Source:** `docs/explore/annotation-editor-types-modes.md` (block marker) + reuse of `annotation-hover-card` peek/pin + the marks engine.
**Applies Constraints:** C-002, C-004

**Execution:**
- `depends_on:` S-002
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/components/annotation-marks.tsx` (a NEW placement BRANCH, not "reuse": `placeAnnotations` today ONLY locates a text range + wraps it in `<mark>` — verified, there is no element-level path. For `type=block`, branch BEFORE `locateRange`/`wrapRange`: find the block via `findBlock`, mark the ELEMENT itself with an outline/tint class. To avoid `closest('[data-anno]')` resolving a NESTED range `<mark>` instead of its container block (a block that also has a range annotation), key the block mark on a DISTINCT attribute — `data-block-anno` — and extend the click/hover resolver to handle both, so a click inside a nested range still focuses the range while a click on bare block area focuses the block), `apps/web/src/styles.css` (block-mark outline/tint, reusing the `--mark-hue` system), `apps/web/src/features/viewer/components/viewer-screen.tsx` (block marks feed the same focusedId/hover-pin/rail wiring)
- `autonomous:` true
- `verify:` `cd apps/web && bun test annotation-marks`

**Acceptance Scenarios:**

AS-007: A block annotation outlines its whole block
- **Given:** a markdown doc with a block annotation on block "block-p-7"
- **When:** the doc renders
- **Then:** that whole block carries the annotation marker (an outline + tint in the annotation's type hue, via the shared `--mark-hue` system) and is keyed by `data-block-anno` on the block element (a DISTINCT attribute from a range mark's `data-anno`) — NOT a wrapped text sub-range
- **Data:** comment block annotation → amber-tinted block outline; redline block → red

AS-008: Hover and click on a block annotation reuse the peek + pin card
- **Given:** a rendered block annotation (read/select mode, no active text selection)
- **When:** the reviewer hovers the block, then clicks it
- **Then:** the hover shows the read-only peek card and the click pins the full thread card — the SAME hover-card surfaces as a text annotation (the block element is a `[data-block-anno]` target; the resolver matches it like a range `[data-anno]`)
- **Data:** block annotation by Jane → peek on hover, pinned ThreadCard on click
- **Setup:** Select/read mode (Pinpoint create mode off)

AS-009: Clicking a block annotation's rail row focuses its block (error/edge — multi-mark consistency)
- **Given:** the rail lists a block annotation
- **When:** the reviewer clicks its rail row
- **Then:** the matching block is focused/scrolled-to (shared focusedId), exactly as a range annotation's row does
- **Data:** rail row click → block gets the focus emphasis

AS-009b: A block annotation and a range annotation on the SAME block stay independently interactive (edge — overlap)
- **Given:** a block that carries BOTH a whole-block annotation (`data-block-anno` on the element) and a range annotation (a nested `<mark data-anno>` inside it)
- **When:** the reviewer hovers/clicks inside the nested range, then on the bare block area
- **Then:** a hit inside the nested range resolves to the RANGE (peek/pin the range thread); a hit on the bare block area (outside any range mark) resolves to the BLOCK — the nested mark never silently steals the block's interaction
- **Data:** block-anno + range-anno on one paragraph → click range text → range card; click block margin → block card

### S-004: Pinpoint on HTML docs via the sandbox relay (P1)

**Description:** As a reviewer of an HTML doc (sandboxed iframe), Pinpoint works the same — hovering
a block in the iframe outlines it, clicking it creates a block annotation, and the block mark draws
inside the iframe — relayed over the existing bridge.
**Source:** `docs/explore/annotation-editor-types-modes.md` (mode applies to all doc types) + the existing sandbox bridge.
**Applies Constraints:** C-001, C-002, C-005

> **Deferral / split note.** This is the spike (see System Impact). Markdown Pinpoint (S-001–S-003)
> is the P0 deliverable and ships INDEPENDENTLY of S-004 — do not block it on the iframe relay. If
> the relay proves hard, split S-004 into **S-004a** (relay the block-pick + route into create — the
> minimum HTML path) and **S-004b** (in-iframe block hover-outline + block-mark draw — the polish), so
> the minimum relay can land before the drawing work.

**Execution:**
- `depends_on:` S-002, S-003
- `parallel_safe:` false
- `files:` `apps/backend/src/annotation/sandbox-bridge.ts` (in-iframe: Pinpoint block hover-outline + block-click → relay `{ type: "block-pick", blockId, rect, text }` — `text` is the block's plain text content, carried because the parent cannot read the cross-origin iframe DOM to build the whole-block anchor (C-002); it is UNTRUSTED + plaintext-only (C-003/C-005); AND a NEW block-draw path — `drawHighlight`/`drawRange` today ONLY wrap text ranges, verified, so a `type=block` highlight must branch to find the block element by id and outline the ELEMENT, mirroring the markdown `data-block-anno` placement, NOT wrap its text), `apps/web/src/features/viewer/lib/bridge.ts` (parent relay handler + a NEW `block-pick` variant in `relayedMessageSchema` — it is NOT in the discriminated union today, verified; reuse the existing `rectSchema` for the rect), `apps/web/src/features/viewer/components/html-sandbox-frame.tsx` + `viewer-screen.tsx` (route the relayed block-pick into the same create + the parent peek/pin)
- `autonomous:` checkpoint
- `verify:` `cd apps/backend && bun test sandbox-bridge` AND `cd apps/web && bun test bridge`

**Acceptance Scenarios:**

AS-010: Picking a block inside an HTML doc creates a block annotation
- **Given:** Pinpoint mode active on an HTML doc; the cursor over an in-iframe block
- **When:** the reviewer clicks the block
- **Then:** the in-iframe bridge relays the block pick (`{blockId, rect, text}`) to the parent and a block annotation is created for that block id, the same as on markdown — the parent builds the whole-block anchor from the relayed `text` (it cannot read the cross-origin iframe DOM)
- **Data:** HTML doc, click a heading block → relay `{blockId: "block-h2-3", rect, text: "<heading text>"}` → type=block annotation on that block id
- **Setup:** the iframe bridge handshake established

AS-011: A relayed block-pick is schema-hardened; a forged block id cannot place (security path)
- **Given:** an HTML doc whose body script relays a `block-pick` with a malformed rect, or with a block id not present in the doc
- **When:** the parent receives the relayed message
- **Then:** the message is Zod-validated at the parent boundary and a malformed rect is rejected (consistent with the hover-card relay hardening, C-006). A block id that does not resolve in the doc's rendered content does NOT place: the annotation degrades to orphaned/non-placing — the SAME outcome a forged range anchor already has today (the create path stores `blockId` verbatim and the matcher places it; an unresolvable id never marks). The parent does NOT pre-validate the id against the iframe DOM (it cannot — the iframe is cross-origin); this is symmetric with the existing range relay, not a new gap.
- **Data:** rect `{width:1e9}` → rejected at the boundary; forged `block-pick` blockId `"nope"` → annotation never places (orphaned), no mark drawn

AS-012: A block annotation draws its outline inside the HTML iframe
- **Given:** an HTML doc with a block annotation
- **When:** the iframe renders / the parent relays the highlight set
- **Then:** the in-iframe bridge outlines/tints the whole block (same hue system as a text mark) and it is hover/click-relayable like any in-iframe mark
- **Data:** block annotation on the HTML doc → block outlined in the iframe

AS-013: The relayed block `text` is untrusted plaintext, never a sink (security path)
- **Given:** a `block-pick` relayed from the (untrusted) iframe carrying a `text` field with HTML-like markup
- **When:** the parent builds the block annotation from it
- **Then:** the relayed `text` is treated as untrusted input — it becomes ONLY the capped whole-block anchor snippet (`MAX_BLOCK_SNIPPET`, Data Model) and renders as literal text in the rail/peek (C-003); it is never assigned to a markup/HTML target and never executed. The `blockId` is likewise inert (used only to look up the block, escaped before any selector); a forged id at worst fails to resolve (orphans, AS-011)
- **Data:** relayed `text: "<img onerror=…>"` → stored as a plaintext snippet, shown literally, no execution; relayed `blockId: "</style>"` → no selector break, just fails to resolve

## Constraints & Invariants

C-001: Pinpoint and Select are mutually exclusive input modes. In Pinpoint mode a text drag-selection
NEVER creates a range annotation (only a block click creates, as `type=block`); in Select mode a block
click is not a pinpoint-create. The mode is the gate. The hover peek + click-to-pin on EXISTING
annotations stay available in the read/select state (per `annotation-hover-card` C-001 — gated on
text-selection, not tool). Creating a block annotation reuses the SAME write gate as any
annotation: `commenter+` only, re-authorized SERVER-side (`createAnnotation` runs
`can(sessionRole, "comment")` for every type, including `block` — verified `annotation.ts:261`); a
no-account guest is capped at commenter.
  - scope: S-001, S-002, S-004
  - surfaces: markdown-create, html-create
  - coverage: markdown-create → AS-002, html-create → AS-010
C-002: A block annotation is `type=block` with an anchor spanning the WHOLE block — `{blockId,
textSnippet=block's full text (capped), offset:0, length:full}`. It reuses the existing anchor SHAPE
AND the shared re-anchor ladder UNCHANGED (`annotation-reanchor`): hinted block by `block_id` →
exact → normalized → fuzzy, then a whole-doc fallback ranked by context/tier/offset/specificity, else
orphan — the SAME machinery a range annotation rides. `blockId` is a positional HINT only; durability
rides on `textSnippet` through that ladder. A block is NOT made stricter than a range: orphan-on-any-
drift was REJECTED (it would make whole-block annotations more fragile than the text annotations users
rely on, to defend an identical-text-sibling-block corner whose worst case — landing on a textually
identical block — is near-zero harm). The one genuine precision gap (two truly identical sibling
blocks, positional hint shifted → tie should orphan, not pick doc-order-first) is an
`annotation-reanchor` matcher concern, tracked there, not a pinpoint special-case. `textSnippet` is
capped + `length` is UTF-16 units (Data Model). No new matcher branch, no migration. (AS-005, AS-006c, AS-007)
C-003: The block's quoted text + comment bodies are untrusted and render as literal text only
(same plaintext rule as range annotations). (AS-006)
C-004: A block annotation reuses the SAME interaction surfaces as a range annotation — the hover peek
+ click-to-pin card and the shared `focusedId` rail linkage. The marker is placed on the block
ELEMENT (outline/tint) rather than wrapping a text sub-range, and is keyed on a DISTINCT attribute
`data-block-anno` (NOT the range marks' `data-anno`) so that `closest()` on a block that also holds a
nested range `<mark data-anno>` resolves each independently — a hit inside the nested range focuses
the range, a hit on bare block area focuses the block; the nested mark never steals the block's
interaction. The resolver matches both attributes. (AS-008, AS-009, AS-009b)
C-005: Every block-pick message relayed from the sandboxed iframe is untrusted and Zod-validated at
the parent boundary (its rect rejected when malformed), the same hardening as the hover-card relay
(`annotation-hover-card` C-006). The parent does NOT pre-check the block id against the iframe DOM —
the iframe is cross-origin and opaque, so that check is not possible there; instead a block id that
does not resolve in the doc's rendered content simply never places (orphaned), which is the SAME
behaviour a forged range anchor already has (the create path stores the anchor verbatim and the
matcher decides placement — verified `annotation.ts:272-280`). block-pick does not widen the existing
relay attack surface. A true parent-side id gate (and the matching range hardening) is a separate
relay-hardening concern, out of this spec. The relayed payload also carries the block's `text` (the
parent cannot read the cross-origin iframe DOM, so the text rides the relay to build the C-002
anchor): it is UNTRUSTED + plaintext-only — it becomes solely the capped anchor `textSnippet` and
renders literal (C-003), never a markup/exec sink; the `blockId` is escaped before any selector use.
The relayed `text` therefore adds no injection surface. (AS-011, AS-013)

## UI Notes

- `DocModeToolbar` *(reuse — `doc-mode-toolbar.tsx`)*: the **Select | Pinpoint** input-mode group;
  Pinpoint chip changes from disabled/"coming" to an active toggle.
- *Block hover-outline* — a hover affordance on block elements in Pinpoint mode (markdown DOM +
  in-iframe for HTML); not a standalone component, a state on the block.
- *Block annotation marker* — the placed annotation's whole-block outline/tint (reuses the
  `--mark-hue` palette + `.anno-mark` vocabulary at block scope).
- Reused as-is: the composer, `ThreadCard` / rail, `AnnotationPeekCard` + `PinnedCardPopover`
  (hover-card peek/pin). `SelectionPopover` reuses its chooser UI but is opened from a synthesized
  block rect + anchor (a block click is not a live selection — see S-002 / UI Inventory), so it is
  not a verbatim drop-in.

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| `DocModeToolbar` | `apps/web/src/features/viewer/components/doc-mode-toolbar.tsx` | enable the Pinpoint chip (remove the `onPinpointUnavailable` "coming" path); the Select\|Pinpoint group already renders |
| `useAnnotationMarks` / `placeAnnotations` | `apps/web/src/features/viewer/components/annotation-marks.tsx` | a NEW placement branch (not "reuse"): today it ONLY locates a range + wraps `<mark>` — there is no element-level path. For `type=block`, mark the block ELEMENT with `data-block-anno` + an outline class, BEFORE the locate/wrap path |
| `SelectionPopover` (5-type) | `apps/web/src/features/viewer/components/selection-popover.tsx` | reuse the chooser UI, but a block click is NOT a live text selection — the caller SYNTHESIZES the popover rect + a whole-block anchor and owns the outline lifecycle (click→outline, dismiss→clear); it does not flow through the selection→compose path. Not a verbatim drop-in |
| `AnnotationPeekCard` + `PinnedCardPopover` | `apps/web/src/features/viewer/components/annotation-peek-card.tsx`, `pinned-card-popover.tsx` | reuse — block marks are `[data-anno]` targets, so hover-peek + click-pin work unchanged |
| `ThreadCard` / `AnnotationsRail` | `apps/web/src/features/viewer/components/thread-card.tsx`, `annotations-rail.tsx` | reuse — a block annotation is just another rail row |
| `use-compose` | `apps/web/src/features/viewer/hooks/use-compose.ts` | add a block-anchor build path (whole-block) beside the selection→anchor path |

### System Impact & Technical Risks

- Backend is largely ready (VERIFIED): `annotation_type` includes `block` (`db/schema.ts:281`); the
  create route's Zod schema already accepts `type: "block"` + the text-anchor shape and does NOT
  require prefix/suffix (`routes/annotations.ts` `createAnnotationSchema` + `textAnchorSchema`); and
  `buildAnchor` stores `{blockId, text, offset, length}` verbatim (`annotation.ts:272-280`). So a
  whole-block anchor passes today. The ONE BE touch is a defense-in-depth `.refine` (`type=block ⇒
  anchor.offset === 0`) so a forged sub-range can't masquerade as a block — plus enforcing the block
  `textSnippet` cap (Data Model). No migration. NOTE: there is NO create-time check that the block id
  resolves in the doc — the anchor is stored verbatim and the matcher decides placement (same as range
  today); see C-005.
- **HTML block relay (S-004, checkpoint)** is the risk: the in-iframe `sandbox-bridge.ts` must add a
  block hover-outline + block-pick relay + block-level mark draw. The bridge already relays
  `mark-click` + `selection-rect` and (from `annotation-hover-card`) mark hover/rect — this EXTENDS
  that, but the in-iframe half is backend-injected and cross-app; treat as a spike like the hover-card
  relay. Untrusted relay → C-005.
- The marks engine currently ONLY wraps a text sub-range in `<mark data-anno>` (verified — no
  element-level path); a block mark is a NEW placement branch (mark the block element with
  `data-block-anno` + outline) on BOTH the markdown engine AND the in-iframe `sandbox-bridge`
  `drawHighlight`. Re-anchor, by contrast, IS unchanged for blocks: a whole-block anchor rides the
  same shared ladder as a range (C-002) — no block-specific matcher branch.
- Block-id emission for the CLIENT viewer is already in place (VERIFIED): the web viewer's doc route
  returns `injectBlockIds(renderMarkdown(content))` for markdown (`routes/viewer-doc.ts:97`) and the
  sandboxed `/v` HTML carries positional block-ids (`app.ts`), so hover-outline + click have a real
  `data-block-id`/`id` target on both doc kinds. IDs are POSITIONAL (`block-{tag}-{n}`) and a HINT
  only, not stable across versions (`block-id.ts`).

## Not in Scope

- **Block preview in the rail row** (showing a snippet/label of the block) — Phase 2 polish; the rail
  row uses the existing quote rendering for now.
- **Keyboard block navigation** (Tab through blocks to pick one) — a11y pass, like the hover-card
  keyboard gap; out of Phase 1.
- **Image regions / pinpoint on images** — a separate anchor type (`annotation-core` G11 / image
  S-002), unrelated to block pinpoint.
- **Changing an existing range annotation into a block one (or vice-versa)** — no conversion; create
  anew.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-26 | Initial creation — Pinpoint whole-block mode (markdown + HTML), all 5 types, block outline marker; reuses block anchor + hover-card + rail. From docs/explore/annotation-editor-types-modes.md (Phase 2). | -- |
| 2026-06-27 | Mode C (Major, M6) — documented two build-time guards (S3 signals from /mf-build). (1) Pinned the block-snippet cap: `MAX_BLOCK_SNIPPET = 8192` UTF-16 units, shape `head…⟨hash⟩…tail` (Data Model). (2) Documented the block-pick relay carrying an untrusted plaintext `text` field (parent can't read the cross-origin iframe DOM): S-004 payload + AS-010 data updated, C-005 extended, AS-013 added asserting the relayed text/blockId are inert (no injection sink). Snapshot 2026-06-27.md. | -- |
| 2026-06-27 | Build-time audit (during /mf-build S-002 gate) REVERSED the strict-match clause (challenge finding #1). Reading `reanchor.ts` showed the shipped shared ladder (hinted-block + multi-candidate ranking + hard context gate) already carries blocks correctly; "orphan-on-any-drift for type=block" would make block annotations MORE fragile than ranges to defend a near-zero-harm identical-sibling corner. C-002 reworded: block rides the same ladder as a range, no special-case, no `reanchor.ts` change. The lone real precision gap (identical sibling blocks, hint shifted → tie should orphan) is reassigned to `annotation-reanchor` (matcher-wide, benefits ranges too), not pinpoint. Data Model + System Impact synced. | -- |
| 2026-06-26 | Adversarial challenge — 11 findings applied. [C1] block anchor matches STRICTLY (orphan on drift, no fuzzy), identical-text blocks orphan vs guess (NOTE: later REVERSED — see the 2026-06-27 entry above). H-1: empty/zero-length block is a no-op (AS-006b). H-2: `textSnippet` capped + `length` in UTF-16 units (AS-006c). H-3: C-005 reworded — parent can't pre-check id against the cross-origin iframe DOM, an unresolvable id orphans (symmetric with range), only Zod+rect hardened at the boundary. M-1: block mark keyed on distinct `data-block-anno` so it never collides with a nested range `data-anno` (AS-009b). M-2: block placement is a NEW branch on the marks engine AND sandbox-bridge, not "reuse". M-3: `inputMode` owned by ViewerScreen, selection-suppress gate in use-compose, AS-002 verify fixed. M-4: verify commands point at real per-component tests (no `pinpoint` file). M-5: SelectionPopover reuse needs synthesized rect/anchor + outline lifecycle. M-6: `.refine` `type=block ⇒ offset=0` + commenter+ gate noted (C-001). M-7: markdown (S-001–S-003) ships independently; S-004 splittable. Rejected: "markdown has no client block-id" + "create route rejects block anchor" (both FALSE on inspection); block-snippet XSS (AS-006/C-003 cover it). | -- |
