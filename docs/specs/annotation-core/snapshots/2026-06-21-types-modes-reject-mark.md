# Snapshot: annotation-core-ui-types-modes
**Date:** 2026-06-21
**Ref:** --
**Reason:** M5 (AS-006 Then changed, P0) + M6 (C-002 extended) — a REJECTED redline removes its doc strike mark (annotation treated as dead), not just dims it.

---

# Spec: annotation-core-ui-types-modes

**Created:** 2026-06-14
**Last updated:** 2026-06-16
**Status:** Draft

## Overview

The annotation **type taxonomy** + selection **modes** for the doc viewer — the umbrella that turns a
selection into one of several annotation types. "Markup" is the parent action: select text → a popover
offers **Comment · Like · Label · Redline · Suggest**. This spec OWNS the new types (Like, Label, Redline)
+ the popover/mode surface; it cross-refs the siblings that already own the other two: Comment
(`annotation-core-ui-commenting`) and Suggest + image-region (`annotation-core-ui-suggest-image`). The
viewer shell + DocModeToolbar live in `annotation-core-ui`. The rail-item **lifecycle-action UI** that consumes
the `annotation-actions` backend — own-vs-others from the durable `authorId`, the 2-family action bar (incl.
owner no-self-approve), Delete/restore + undo toast, the Pending tag, and the rail-item layout redesign — lives
in the sibling **`annotation-actions-ui`** (added 2026-06-16).

Phase 1 (this spec) covers **Select mode** only (text-range). Pinpoint mode (whole-block element picker),
global doc-level comment, and per-workspace label customization are deferred (see Not in Scope). Sub-spec 4
of the annotation-core-ui family. No in-app content editing in v0 — every annotation is a *proposal/signal*
an agent pulls via MCP, never a direct edit.

Primary input: `docs/explore/annotation-editor-types-modes.md`. Hardened by `/mf-challenge` 2026-06-14
(see Clarifications).

## Data Model

**Root-comment + body model (challenge #3):** EVERY annotation has a **root comment** — the creator's act is
recorded as the first `comments` row (carrying `createdAt` + `body`), so the **thread + body pre-fill** work
uniformly for all types. Like/Label/Redline are NOT "bare marks": picking one opens the composer with the
`body` **pre-filled from the label/type's display text** (e.g. "Looks good", "Out of scope"), editable before
send. A plain Comment opens with an empty body. This removes the "comment-less annotation" case entirely.

> **DE-STALED 2026-06-16:** the original draft said "the `annotations` table itself has no author column" and
> derived the creator from the root-comment author. That was **REVERSED** by `annotation-actions`:S-001, which
> added a durable `annotations.author_id` (null for guest) written at create and served as `authorId` on the
> read. **Creator identity now comes from the durable `authorId`, NOT the root comment.** The root-comment
> model still holds for the *thread* and the *body pre-fill* above. Own-vs-others, the owner no-self-approve
> gate, and delete-own are consumed from `authorId` by the sibling **`annotation-actions-ui`** (which also owns
> the lifecycle-action UI: the 2-family action bar, Delete/restore + undo toast, the Pending tag). See that
> spec's `## Linked Fields`.

Types ride the existing `annotations` table (`apps/backend/src/db/schema.ts`) — `annotation_type` already has
`range · multi_range · block · doc · suggestion`, and `suggestion` jsonb already carries `kind: replace|delete`
+ `suggestion_status`. The UI actions map to columns:

| Popover action | `type` | `suggestion.kind` | `label` | root-comment body default | owner spec |
|---|---|---|---|---|---|
| Comment | range / multi_range | — | — | empty | commenting (sibling) |
| Like | range / multi_range | — | `looks-good` | "Looks good" | THIS spec |
| Label | range / multi_range | — | `<presetId>` | the preset's text | THIS spec |
| Redline | suggestion | `delete` | — | empty (the strike conveys it) | THIS spec |
| Suggest | suggestion | `replace` | — | empty | suggest-image (sibling) |

- **`annotations.label`** (nullable) — a label-preset id. Set ONLY on signal types (comment/like/label);
  `looks-good` is the built-in Like preset. Redline/Suggest carry NO label. `label` and the `suggestion`
  payload are **mutually exclusive**, enforced at the create boundary (challenge #8). The `label` value is
  validated server-side ∈ the preset set (challenge #7) — a forged/foreign/garbage id is rejected.
  `label` stores structured (NOT folded into the comment body) so the rail renders the label line and MCP
  exports a "Label Summary". **This column does not exist yet — see Prerequisites.**
- **`DEFAULT_LABEL_PRESETS`** (challenge #1) — a v0 fixed CONSTANT set (~10), shared across all workspaces,
  each `{ id, text, icon, color }`. The picker lists it; `annotations.label` stores the `id`. A
  per-workspace customizable preset TABLE (+ Alt+1..0 shortcuts) is deferred to Phase 4 — v0 does NOT build
  a `label_presets` table or any seed/backfill.

Default set (PO screenshot): Clarify this · Missing overview · Verify this · Give me an example · Match
existing patterns · Consider alternatives · Ensure no regression · Out of scope · Needs tests · Nice approach.

Client state: current mode (Select; Pinpoint deferred), pending selection (range + quote + prefilled body),
the open LabelPicker. Read-payload consumed: `effectiveRole` (gates whether markup affordances appear, C-001).

## Prerequisites (backend — build-blockers, not soft gaps)

These must land before the dependent FE stories build + verify end-to-end (challenge #2). Owned by backend
`annotation-core` — **now specced there (S-009 + C-015/C-016, GAP-001 resolved):**
- **`annotations.label` column** (nullable text) + the create-annotation route accepts `label`, validates it
  ∈ the preset set, and rejects a payload carrying BOTH `label` and a `suggestion` payload → annotation-core
  S-009 (AS-027/028/029) + C-015. Blocks S-003 (Like) / S-004 (Label).
- Decided-suggestion reopen → pending, owner-only → annotation-core AS-026 / C-016. Blocks S-002 reopen (AS-008).
- The suggestion engine is ALREADY kind-agnostic (verified — see Clarifications): no backend change for Redline.

## Stories

### S-001: Markup a text selection — the popover offers the annotation types (P0)

**Description:** As someone with comment permission, the doc toolbar shows a markup **tool palette**
(Markup · Comment · Redline · Label); with the **Markup** tool active (the default) selecting text in a
Markdown doc shows the Markup popover offering Comment · Like · Label · Redline · Suggest; a viewer-only
role gets no palette/popover. The popover is the single entry mapping to one create path (the chosen action
sets `type`/`label`). (The other tools' routing — Comment/Redline/Label — is S-006.)
**Source:** docs/explore/annotation-editor-types-modes.md#ui-sketch (Markup popover); PO model "Markup = parent of the rest"; PO prototype refinement 2026-06-15 (toolbar tool palette).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/components/selection-popover.tsx` (extend Comment·Dismiss → +Like/Label/Redline/Suggest), `doc-mode-toolbar.tsx` (Select/Markup → Select/Pinpoint label; Pinpoint disabled-coming)
- `autonomous:` true
- `verify:` select a sentence → popover shows Comment · Like · Label · Redline · Suggest; a viewer-only role → no popover.

**Acceptance Scenarios:**

AS-001: The Markup popover lists the annotation types
- **Given:** a commenter has a Markdown doc open in Select mode, with the **Markup** tool active (the default)
- **When:** they select a sentence
- **Then:** a popover appears offering Comment, Like, Label, Redline, and Suggest
- **Data:** select "Real-time Collaboration"

AS-002: A viewer-only role gets no markup affordance
- **Given:** a user whose effective role on the doc is viewer (read-only)
- **When:** they select text
- **Then:** no Markup popover appears; the rail is read-only
- **Data:** viewer role

AS-003: An empty / whitespace-only selection offers nothing
- **Given:** the viewer is open in Select mode
- **When:** the user releases a selection covering no real characters
- **Then:** no popover appears and no annotation is created
- **Data:** a 0-character selection

### S-002: Redline — strike a selection as a deletion proposal (P0)

**Description:** As a reviewer, I pick Redline on a selection; the text shows a red strikethrough and a
deletion-proposal annotation (with its creator's root comment) is created without editing the doc; the doc
**owner** can accept or reject it (auto-resolving the thread); a drifted redline shows stale.
**Source:** docs/explore/annotation-editor-types-modes.md#happy-path-select-mode-redline; PO correction "Redline = strike only, not Suggest"; challenge #4/#5/#10.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/components/annotation-marks.tsx` (red-strike + stale style), `thread-card.tsx` (DELETE badge + Accept/Reject), `services/client.ts` (create suggestion kind=delete; decide)
- `autonomous:` true
- `verify:` select text → Redline → red strikethrough + a rail DELETE card; the doc owner Accept → card resolves (dims); doc content unchanged.

**Acceptance Scenarios:**

AS-004: Create a redline without editing content
- **Given:** a reviewer selects "Implementation Plan: Real-time Collaboration"
- **When:** they choose Redline
- **Then:** a delete-kind proposal annotation + its root comment are created; the text renders a red
  strikethrough; a rail card shows a DELETE badge with the quote; the doc content does NOT change
- **Data:** redline the H1 title

AS-005: The owner accepting a redline auto-resolves the thread
- **Given:** the doc owner views a pending redline
- **When:** they Accept it
- **Then:** the redline shows accepted, the thread becomes resolved (dimmed), and the doc content stays intact
- **Data:** owner accepts the title redline

AS-006: The owner rejecting a redline auto-resolves the thread
- **Given:** the doc owner views a pending redline
- **When:** they Reject it
- **Then:** the redline shows rejected and the thread becomes resolved (dimmed)
- **Data:** owner rejects the title redline

AS-007: A drifted redline shows stale at read time and cannot be accepted
- **Given:** a redline whose pinned span no longer matches the current version (the author republished without it)
- **When:** the reviewer opens the doc
- **Then:** the redline renders in a distinct stale style (not a confident red strike on possibly-wrong text)
  and the rail card shows stale on open; Accept does not apply it
- **Data:** current version no longer contains the redlined text

AS-008: Reopening a decided redline is owner-only and returns it to pending
- **Given:** a redline the owner already accepted (resolved)
- **When:** the owner Reopens it
- **Then:** the thread returns to unresolved AND the proposal returns to pending (decision cleared); a
  non-owner cannot Reopen a decided redline
- **Data:** owner reopens an accepted redline

AS-009: A refused redline write rolls back the optimistic strike
- **Given:** a reviewer optimistically sees a red strike + card on creating a redline, but the write is refused
- **When:** the create request comes back refused
- **Then:** the optimistic strike + card are removed and an error is shown; no ghost mark remains
- **Data:** create refused (role revoked / network error)

### S-003: Like — mark a selection "looks good" (P1)

**Description:** As a reviewer, I pick Like on a selection; the composer opens pre-filled with "Looks good"
(editable); on send a signal annotation carrying the `looks-good` label + its root comment is created,
rendering in the rail as a 👍 row.
**Source:** docs/explore/annotation-editor-types-modes.md#data-model (Like = label:looks-good); challenge #3/#6/#9.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/components/thread-card.tsx` (👍 label line), `services/client.ts` (one labeled-create path)
- `autonomous:` true

**Acceptance Scenarios:**

AS-010: Like a selection with a pre-filled, editable body
- **Given:** a commenter selects a paragraph and chooses Like
- **When:** the composer opens pre-filled "Looks good", they send (as-is or edited)
- **Then:** an annotation carrying the `looks-good` label + a root comment by them is created; the rail card
  shows a 👍 "Looks good" row paired to a highlight
- **Data:** like the "Context" paragraph

AS-011: A refused Like/Label write rolls back the optimistic mark
- **Given:** a reviewer optimistically sees a Like/Label highlight + row, but the write is refused
- **When:** the create comes back refused
- **Then:** the optimistic highlight + row are removed and an error is shown; no ghost mark remains
- **Data:** create refused

### S-004: Label — tag a selection from the preset set (P1)

**Description:** As a reviewer, I pick Label; a picker lists the (v0 constant) preset set; choosing one tags
the annotation with that preset and pre-fills the body with the preset text (editable); a forged label id is
refused server-side.
**Source:** docs/explore/annotation-editor-types-modes.md#happy-path-pinpoint-mode-label; challenge #1/#3/#7/#8.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` new `apps/web/src/features/viewer/components/label-picker.tsx`, `thread-card.tsx` (label line), `services/client.ts`; consumes the backend `label` column (Prerequisites)
- `autonomous:` true

**Acceptance Scenarios:**

AS-012: Tag a selection with a preset label
- **Given:** a commenter selects a sentence and chooses Label
- **When:** the picker opens, they choose "Out of scope" and send (body pre-filled "Out of scope", editable)
- **Then:** the annotation is tagged with the `out-of-scope` preset; the rail card shows the preset icon + "Out of scope"
- **Data:** label "wss://collab.plannotator.ai" as Out of scope

AS-013: The picker lists the default preset set
- **Given:** any workspace (v0 has one shared constant set)
- **When:** a reviewer opens the Label picker
- **Then:** it lists the default set (Clarify this, Verify this, Out of scope, Needs tests, …)
- **Data:** the DEFAULT_LABEL_PRESETS set

AS-014: A forged or unknown label id is rejected server-side
- **Given:** a client sends a create with `label` not in the preset set (a foreign/garbage/script-bearing id)
- **When:** the server processes the create
- **Then:** the write is refused; no annotation is persisted with an unknown label
- **Data:** `label` = `<svg onload=…>` / a non-preset id

AS-015: A note / label text containing HTML renders inert
- **Given:** a label annotation whose (edited) body contains HTML/script
- **When:** the rail renders at the app origin
- **Then:** the body shows escaped plaintext (the markup does not run)
- **Data:** body `<img src=x onerror=alert(1)>`

### S-005: Threads + server-authorized writes on every type (P1)

**Description:** As a participant, I can reply (flat) and resolve/reopen on ANY annotation type — because
every annotation has a root comment (Data Model), the existing thread reuses unchanged; and every type's
create is re-authorized server-side, not by the client affordance.
**Source:** docs/explore/annotation-editor-types-modes.md#resolved-decisions (all types have a thread); challenge #3 (root comment), commenting C-001 (server re-authz).

**Execution:**
- `depends_on:` S-002, S-004
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/components/thread-card.tsx` (reuse the built reply/resolve on every type)
- `autonomous:` true
- **PREREQ (cross-spec):** `annotation-core-ui-commenting` S-003 (reply) + S-004 (resolve) supply the
  `onReply`/`onResolve` wiring this story reuses; this story adds NO new thread mechanism, it points the
  existing one at the new types.

**Acceptance Scenarios:**

AS-016: Reply flat on a redline
- **Given:** a redline thread (with its creator's root comment)
- **When:** I reply, type, and send
- **Then:** the reply shows flat under the redline (one level, never nested deeper)
- **Data:** reply "Agree, the title is redundant"

AS-017: Resolve then reopen a label
- **Given:** an unresolved label annotation
- **When:** I Resolve it, then Reopen
- **Then:** the thread shows resolved (dimmed) then back to unresolved
- **Data:** toggle twice

AS-018: A viewer's forged create is refused server-side
- **Given:** a viewer-only user (no popover client-side) crafts the raw create a Like/Label/Redline would send
- **When:** the server processes it
- **Then:** the write is refused by session role (the client affordance is a hint only)
- **Data:** viewer role forging a create

AS-019: A create carrying both a label and a suggestion payload is rejected
- **Given:** a client sends a create with BOTH `label` and a `suggestion` payload
- **When:** the server processes it
- **Then:** the write is refused (label and suggestion are mutually exclusive)
- **Data:** `{ label: "looks-good", suggestion: {kind:"delete", …} }`

### S-006: Markup tool palette — the active tool routes the selection (P1)

**Description:** As someone with comment permission, the doc toolbar shows a markup tool palette
(Markup · Comment · Redline · Label); exactly one tool is active, and the active tool decides what a text
selection does — Markup opens the 5-type popover, Comment opens the comment composer directly, Redline
strikes the selected text directly, Label opens the label picker directly. Each tool chip is collapsed to
an icon at rest and expands to icon + label + its per-type colour when active or hovered. Wide/Focus sits
at the far right of the toolbar.
**Source:** PO prototype refinement 2026-06-15 (toolbar tool palette + per-tool routing + collapse/expand colour affordance); DESIGN.md "Annotation type / tool colors" + the affordance pattern.

**Execution:**
- `depends_on:` S-002, S-004
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/components/doc-mode-toolbar.tsx` (add the markup tool group + move Wide|Focus right + per-tool colour/collapse-expand), `viewer-screen.tsx` (active-tool state → route the selection: Markup popover / Comment composer / Redline strike / Label picker), `selection-popover.tsx` (only shown under the Markup tool)
- `autonomous:` true
- `verify:` toolbar shows Markup·Comment·Redline·Label (active = icon+text+colour, others icon-only) + Wide|Focus at right; pick Comment then select text → comment composer (no type popover); pick Redline then select → red strike, no popover; pick Label then select → label picker; pick Markup then select → the 5-type popover.

**Acceptance Scenarios:**

AS-020: With the Markup tool active, a selection opens the 5-type popover
- **Given:** a commenter with the Markup tool active in the toolbar palette
- **When:** they select a sentence
- **Then:** the Markup popover (Comment · Like · Label · Redline · Suggest) appears over the selection
- **Data:** Markup active; select "Real-time Collaboration"

AS-021: With the Comment tool active, a selection opens the comment composer directly
- **Given:** a commenter with the Comment tool active
- **When:** they select a sentence
- **Then:** the comment composer opens directly on the selection — the 5-type popover does NOT appear
- **Data:** Comment active; select a paragraph

AS-022: With the Redline tool active, a selection is struck directly
- **Given:** a commenter with the Redline tool active
- **When:** they select a sentence
- **Then:** the selection is struck (a red strikethrough redline is created) directly — no popover appears
- **Data:** Redline active; select the H1 title

AS-023: With the Label tool active, a selection opens the label picker directly
- **Given:** a commenter with the Label tool active
- **When:** they select a sentence
- **Then:** the label picker opens directly on the selection — the 5-type popover does NOT appear
- **Data:** Label active; select a sentence

## Constraints & Invariants

- C-001: Markup affordances appear only for comment-permission+ (a viewer-only role gets a read-only rail);
  AND every type's create is re-authorized SERVER-side by session role — `effectiveRole` is a client hint
  only, a forged create by a viewer is refused. (AS-002, AS-018)
- C-002: Redline = a delete-kind proposal — NEVER edits content; the doc OWNER (not the thread author)
  accepts/rejects, which auto-resolves the thread (dimmed); a redline whose pinned span drifted renders in a
  distinct STALE style at read time and cannot be accepted; Reopening a DECIDED redline is owner-only and
  resets the proposal to pending. (AS-005, AS-006, AS-007, AS-008)
- C-003: EVERY annotation has a root comment (creator's author + time + body); for Like/Label/Redline the
  body is pre-filled from the label/type text (editable at creation), so there is no comment-less mark. The
  `label` is stored STRUCTURED on the annotation (signal types only), validated server-side ∈ the preset set;
  `label` and the `suggestion` payload are mutually exclusive, enforced at the create boundary. (AS-010, AS-012, AS-014, AS-019)
- C-004: v0 ships a fixed shared `DEFAULT_LABEL_PRESETS` constant (~10); the picker lists it; `annotations.label`
  stores the preset id. A per-workspace customizable preset table is deferred to Phase 4 — NO table/seed/backfill in v0. (AS-013)
- C-005: Every annotation type carries a thread — flat reply + resolve/reopen; a resolved thread renders
  dimmed. Because every annotation has a root comment (C-003), reply/resolve reuse the existing thread
  unchanged. (AS-016, AS-017)
- C-006: Every untrusted string rendered at the app origin — the comment body, the label display text, the
  quoted snippet — renders inert (escaped plaintext, never HTML/markdown), consistent with commenting C-008. (AS-015)
- C-007: Optimistic create rolls back on a refused/failed write for ALL types (comment/like/label/redline) —
  no ghost mark is left behind (extends commenting C-011 beyond comments). (AS-009, AS-011)
- C-008: The anchor stays block-scoped (`blockId` + `textSnippet` + `offset`/`length`, or `segments[]`) —
  NOT Plannotator's nodePath/web-highlighter. Select mode → `range`/`multi_range`. (AS-004, AS-010, AS-012)
- C-009: The doc toolbar carries a markup tool palette (Markup · Comment · Redline · Label) with exactly one
  tool active; the ACTIVE tool routes a text selection — Markup → the 5-type popover, Comment → the comment
  composer directly, Redline → a red strike directly (no popover), Label → the label picker directly. Each
  tool chip is collapsed to an icon at rest and expands to icon + label + its per-type hue (DESIGN.md
  "Annotation type / tool colors": Markup teal · Comment amber · Redline red · Label gold) when active or
  hovered; Wide/Focus sits at the toolbar's far right. Pinpoint stays Phase-2 deferred (disabled "coming").
  (AS-020, AS-021, AS-022, AS-023; collapse/expand colour styling is visual [→MANUAL])

## Linked Fields

annotation-core-ui-types-modes consumes lifecycle machinery owned by sibling specs.

- `suggestion.kind = delete` + `suggestionStatus` (accept/reject/stale) — consumed here by S-002 (Redline
  create + decide). Produced by the backend suggestion engine + route (`apps/backend/src/annotation/suggestion.ts`,
  `routes/annotations.ts`): `createSuggestion` emits `kind:delete` when `to` is omitted, the create route's
  Zod has `to: z.string().optional()` (`annotations.ts:219`), and `decideSuggestionHandler` enforces
  owner-only (`annotations.ts:371`) then runs the kind-agnostic decide + stale check. ✔ verified — no backend
  change needed for Redline; only `annotations.label` is new (Prerequisites).
- comment thread (flat reply + resolve) — reused from `annotation-core-ui-commenting` S-003/S-004; every
  annotation here has a root comment (C-003) so the thread reuses unchanged. ✔ (S-005 PREREQ pins it).
- `annotations.label` — consumed HERE by S-003/S-004 (rendered as the rail label line; read on the
  annotations list). Produced by `annotation-core`:S-009 (AS-027: persisted on create, served on the GET list;
  validated ∈ preset set AS-028; mutually exclusive with suggestion AS-029). ✔ surface (list read) +
  lifecycle (persisted + served) match.
- `effectiveRole` on the doc read — consumed by C-001 (markup gating). Produced by the viewer-doc read. ✔ already served.

## UI Notes

Design source: the Plannotator editor (PO screenshots in the explore doc) — canonical for naming/shape on
conflict. Precedence: AS / Constraints > prototype > this Tree.

- `DocModeToolbar` *(reuse — `doc-mode-toolbar.tsx`)*: **Select** mode *(Pinpoint disabled/coming — Phase 2)*
  · a **markup tool palette** `Markup · Comment · Redline · Label` *(exactly one active; active tool routes
  the selection, S-006/C-009)* · **Wide / Focus at the far right**. Each tool chip: collapsed to icon at
  rest, expands to icon + label + per-type hue on active/hover *(DESIGN.md type/tool palette: Markup teal ·
  Comment amber · Redline red · Label gold)*.
- `SelectionPopover` *(reuse — `selection-popover.tsx`; extend)*: the **Markup tool's** surface — Comment
  *(commenting)* · Like · Label *(opens LabelPicker)* · Redline · Suggest *(suggest-image)* · Dismiss; same
  compact icon → hover-expand + colour treatment. *(Only shown under the Markup tool; the other tools route
  directly per C-009.)*
- `LabelPicker` *(NEW)*: a dropdown of the constant preset set — each row icon + colour + text
- `Composer` *(reuse — `composer.tsx`)*: opens with `body` pre-filled from the chosen label/type, editable
- `AnnotationMarks` *(reuse — `annotation-marks.tsx`; add styles)*: redline = red strikethrough + red-tint bg;
  a STALE redline = a distinct muted/dashed style (not a confident strike); like/label = preset-coloured highlight
- `ThreadCard` *(reuse — `thread-card.tsx`; extend)*: a TYPE badge (COMMENT / DELETE / SUGGEST) · a label line
  (icon + text, e.g. "🔍 Verify this" / "👍 Looks good") · Accept/Reject row for Redline *(owner only, auto-resolve)*

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| SelectionPopover | `apps/web/src/features/viewer/components/selection-popover.tsx` | extend Comment·Dismiss → +Like/Label/Redline/Suggest |
| DocModeToolbar | `apps/web/src/features/viewer/components/doc-mode-toolbar.tsx` | relabel Select/Markup → Select/Pinpoint; Pinpoint disabled |
| ThreadCard | `apps/web/src/features/viewer/components/thread-card.tsx` | + type badge + label line + owner Accept/Reject (reuse reply/resolve already built) |
| AnnotationMarks | `apps/web/src/features/viewer/components/annotation-marks.tsx` | + redline strike + stale style + label-colour highlight |
| Composer | `apps/web/src/features/viewer/components/composer.tsx` | reuse; open with pre-filled body |
| Typed client | `apps/web/src/features/viewer/services/client.ts` | + one labeled-create path, redline create, decide |

### System Impact & Technical Risks

- Backend schema models the types already (`range/multi_range/block/doc/suggestion`, `suggestion.kind`,
  `suggestion_status`); the suggestion engine + route are kind-agnostic and owner-gate the decide (verified).
  The one NEW persisted piece is `annotations.label` (Prerequisites) — additive, but a real backend blocker
  for S-003/S-004, with server-side validation (∈ preset set) + label/suggestion mutual-exclusion.
- Reply + resolve are built and hardened (commenting S-003/S-004) — reused unchanged because every annotation
  has a root comment (C-003), removing the comment-less-mark edge.

## Not in Scope

- **Pinpoint mode** (whole-block element picker, `type=block`, hover-outline) — Phase 2. Resolved-by-design:
  runs iframe-side in the existing select bridge, relaying only `blockId`.
- **Global / doc-level comment** (`type=doc`) — Phase 4 (schema supports it; no FE entry yet).
- **Per-workspace label customization** (a `label_presets` table, admin add/edit/reorder/recolor ≤12,
  Alt+1..0 shortcuts, seed + backfill) — Phase 4. v0 ships the shared constant set, read-only.
- **Post-hoc comment editing** beyond the create-time pre-fill — out of v0 (the body is editable BEFORE send only).
- Comment type create/reply/resolve — `annotation-core-ui-commenting`. Suggest (replace) create/decide +
  image-region — `annotation-core-ui-suggest-image`.
- Applying an accepted Redline/Suggest into content — the MCP round-trip (immutable-version model).
- Plannotator's nodePath anchor + web-highlighter — rejected (fragile); we keep the block-scoped anchor + bridge.

## Gaps

- GAP-001 (status: resolved — annotation-core S-009 + C-015, 2026-06-14): the backend `annotations.label`
  column + create-route validation (label ∈ preset set, AS-028; label/suggestion mutual-exclusion, AS-029)
  + serve-on-read (AS-027) are now specced in `annotation-core` (Mode C). The decided-suggestion reopen →
  pending (challenge #4) is annotation-core AS-026 / C-016. This spec consumes them — see Linked Fields.

## Clarifications — 2026-06-14

Backend audit of `apps/backend/src/annotation/suggestion.ts` + `routes/annotations.ts` and the `/mf-challenge`
adjudication (PO decisions in parentheses):
- **Suggestion engine is kind-agnostic** — `createSuggestion` emits `kind:delete` by omitting `to`; the
  create route's Zod has `to` optional (`annotations.ts:219`); `decideSuggestionHandler` enforces owner-only
  (`:371`) and the stale check (`fromStillMatches`) is kind-agnostic. Redline rides this unchanged; only
  `annotations.label` is new. (GAP-001/002 from the prior draft resolved.)
- **Root-comment + body model (#3):** every annotation has a root comment; Like/Label/Redline pre-fill the
  body from the label/type text (editable before send); `label` stays structured for the rail + MCP export.
  Removes the comment-less-mark case → thread reuse unchanged. **(SUPERSEDED 2026-06-16:** the original "avoids
  adding `annotations.authorId`, derive creator from the root comment" was reversed — `annotation-actions`:S-001
  added a durable `annotations.author_id`; creator identity is now that column, served as `authorId`. The
  root-comment model is retained only for the thread + body pre-fill. See §Data Model DE-STALED note.)
- **Labels are a v0 constant (#1):** shared `DEFAULT_LABEL_PRESETS`, no per-workspace table/seed in v0;
  customization + the workspace table land in Phase 4.
- **Decide is owner-only (#10), not "author"** — wording corrected; server-enforced at `annotations.ts:371`.
- **Reopen of a decided redline (#4)** resets the proposal to pending and is owner-only (prevents a non-owner
  resurfacing a rejected deletion / an MCP-applied deletion the owner took back).
- **Stale is a render-time state (#5):** a drifted redline renders muted/dashed, not a confident strike on
  fuzzy-matched (possibly wrong) text.
- **Optimistic rollback extends to Like/Label/Redline (#6)**; **label validated server-side ∈ preset set (#7)**;
  **label/suggestion mutually exclusive, enforced at create (#8)**; **one labeled-create path for Like/Label (#9)**.

## Spec Sizing Notes

Stories=6 (target 7 — under), AS=23 (target 20 — in the G7 overage range ≤30). Phase 1 only (Select-mode
types); Pinpoint, global comment, and label customization deferred to keep the slice small and
independently shippable.

The 3-AS overage comes from S-006's per-tool routing (PO prototype refinement 2026-06-15) — each AS is one
routing atom, no bloat:
- S-006 tool palette: AS-020 (Markup→popover), AS-021 (Comment→composer), AS-022 (Redline→strike),
  AS-023 (Label→picker) — 4 atoms, one per toolbar tool.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-16 | Major (M6): DE-STALED §Data Model + Clarifications #3 — `annotation-actions`:S-001 reversed the "annotations table has no author column / derive creator from root comment" model by adding a durable `annotations.author_id` (served as `authorId`); creator identity now comes from that column, root-comment retained only for thread + body pre-fill. Lifecycle-action UI (own-vs-others, 2-family action bar incl. owner no-self-approve, Delete/restore + undo toast, Pending tag, rail-item redesign) split out to the new sibling `annotation-actions-ui`. Stories/AS/Constraints unchanged. Snapshot 2026-06-16-types-modes-destale.md | -- |
| 2026-06-14 | Initial creation — annotation type taxonomy (Like/Label/Redline) + Markup popover + Select mode; Pinpoint/global/customization deferred. From docs/explore/annotation-editor-types-modes.md (Mode A). | -- |
| 2026-06-15 | Major (M1+M4+M6): PO prototype refinement — DocModeToolbar gains a markup TOOL PALETTE (Markup·Comment·Redline·Label) where the active tool routes the selection (+S-006, AS-020..023); S-001 flow reframed (popover = the Markup tool's surface, Markup = default); +C-009 (palette + per-tool routing + collapse→icon/active+hover→expand+colour + Wide\|Focus right); UI Notes + Spec Sizing updated. Colours formalized in DESIGN.md (type/tool palette, PO-approved deviation from teal-only). Snapshot 2026-06-15-types-modes.md | PO prototype 2026-06-15 |
| 2026-06-14 | /mf-challenge hardening (10 findings accepted): unifying root-comment model (#3); labels = v0 constant, table→Phase 4 (#1); backend `label` column Prerequisite + GAP-001 (#2); reopen-decided resets to pending owner-only (#4); stale = render-time style (#5); optimistic rollback for Like/Label (#6); server-side label validation (#7); label/suggestion mutual exclusion (#8); one labeled-create path (#9); decide owner-only wording + route cite (#10). Stories 5, AS 14→19. | -- |
