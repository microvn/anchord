# Snapshot: annotation-actions-ui
**Date:** 2026-06-17
**Ref:** --
**Reason:** M5+M6 — own-vs-others is now INTERNAL only (drives the no-self-approve + delete-own gates); the rail ALWAYS shows the real author name+avatar, NO visible "You" marker (PO 2026-06-17). AS-001 Then + C-001 changed; the no-self-approve gate (S-002/C-003) holds until the session resolves.

---

# Spec: annotation-actions-ui

**Created:** 2026-06-16
**Last updated:** 2026-06-16
**Status:** Draft

## Overview

The **frontend counterpart** of the `annotation-actions` backend — the rail-item UI that consumes the
durable creator identity, the 2-family close model, soft-delete/restore, and the no-self-approve gate that
backend landed. This spec OWNS: own-vs-others attribution from the durable creator id, the collapsed
2-slot action bar (the locked "Apple-minimal" reduction of accept/reject/resolve/reopen), Delete + restore
with an undo toast, the proposal status surfacing (Pending / decided / stale), and the rail-item layout
redesign (capped quote + own-line type-chip).

Scope-by-layer sibling of `annotation-actions` (backend) — they ship together; the backend produces the
fields/routes, this spec consumes them (see `## Linked Fields`). The annotation **type taxonomy** + selection
modes + create paths live in the sibling `annotation-core-ui-types-modes` (already built); this spec does NOT
re-own create — it reworks how an existing rail item presents its actions/attribution/lifecycle.

No new annotation type, no new create path. Every affordance here is a **client hint** — the backend
re-authorizes every write by session role + creator identity (a forged client action is refused).

## Data Model

No new persisted entity — this spec is pure FE consumption. The read payload it depends on (all produced by
the `annotation-actions` backend + `annotation-core` AS-030):

- **`authorId`** (nullable) — the durable creator id on each annotation (`annotation-actions`:S-001).
  Null = guest-created. The FE compares it to the current session user id to decide own-vs-others, the
  no-self-approve gate, and the delete-own affordance. NOT derived from the root comment author.
- **`suggestionStatus`** — `pending | accepted | rejected | stale` on a proposal (suggestion) annotation
  (`annotation-core` AS-030, decided by `annotation-actions`). Drives the action bar + the status surface.
- **`effectiveRole`** — the viewer's effective role on the doc (already served). Gates owner-only affordances
  (Accept/Reject, moderate-delete) as a hint.
- **soft-delete exclusion** — a deleted annotation never appears in the annotations read (`annotation-actions`
  :S-005, AS-014), so an optimistic remove + refetch stays consistent; restore brings it back.

Annotation **family** (derived, not stored): an annotation with a `suggestion` payload is a **Proposal**;
otherwise (comment / like / label) it is a **Remark**. The family + `authorId` + `effectiveRole` +
`suggestionStatus` together decide which ≤2 actions the bar shows.

Client state: the current session user id (for own-vs-others), an optimistic per-annotation pending-delete
set (for the undo toast window), and the per-item quote expanded/collapsed flag.

## Stories

### S-001: Own-vs-others from the durable creator id (P0)

**Description:** As a reviewer, each rail item is attributed to its creator using the annotation's durable
creator id (served as `authorId`) — not inferred from the first comment — so the app can reliably tell my
own annotations from others' (the basis for the no-self-approve gate and delete-own), and a guest-created
annotation reads as a guest, never as mine.
**Source:** conversation 2026-06-16 (the rail-item redesign keys own-vs-others on the new durable `authorId`);
`annotation-actions`:S-001 (durable `author_id` persisted + served as `authorId`).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/services/client.ts` (add `authorId` to the read type), `apps/web/src/features/viewer/components/thread-card.tsx` (attribution + an `isOwn` derivation), `apps/web/src/features/viewer/components/viewer-screen.tsx` (thread the current user id to the card)
- `autonomous:` true
- `verify:` open a doc with one of your annotations + one by another member + one guest annotation → each shows the correct author, only yours is marked own.

**Acceptance Scenarios:**

AS-001: A member's own annotation is attributed to them from the creator id
- **Given:** I am signed in and viewing a doc with an annotation whose creator id equals my user id
- **When:** the rail renders
- **Then:** the item shows me as the author and is marked as my own (the own-vs-others flag comes from the
  creator id, not from the first comment's author)
- **Data:** annotation `authorId` = my user id

AS-002: Another member's annotation is attributed to that member, not me
- **Given:** a doc with an annotation whose creator id is a different member
- **When:** the rail renders
- **Then:** the item shows that member as the author and is NOT marked as my own
- **Data:** annotation `authorId` = another member's id

AS-003: A guest-created annotation reads as a guest, never as own
- **Given:** an annotation created by a guest (no durable creator id)
- **When:** the rail renders for any signed-in user
- **Then:** the item is attributed to the guest and is never marked as own (a null creator id matches no one)
- **Data:** annotation `authorId` = null

### S-002: The 2-family action bar — at most two contextual actions (P0)

**Description:** As a reviewer, every rail item shows at most two primary actions, chosen by the annotation's
family and my permission: a **Remark** (comment/like/label) offers **Resolve** (or **Reopen** when resolved),
available to commenter+; a **Proposal** (suggestion) offers the doc **owner** **Accept** + **Reject** while
pending and **Reopen** once decided; a non-owner viewing a proposal gets reply only (no close action); and a
proposal I authored is treated like a remark for me — no Accept/Reject (I can't approve my own), I close it
with **Resolve**. The affordance is a hint; the backend re-authorizes every close.
**Source:** conversation 2026-06-16 (locked 2-family model, "Apple-minimal" collapse to 2 slots; owner of
own proposal = treated as remark); `annotation-actions`:S-002 (proposal owner-closed) + S-003 (no self-approve).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/components/thread-card.tsx` (the action-bar slot logic + family/role/own gating), `apps/web/src/features/viewer/components/viewer-screen.tsx` (supply `effectiveRole` + decide/resolve callbacks gated by family)
- `autonomous:` true
- `verify:` a remark shows Resolve; a pending proposal shows Accept+Reject to the owner; a non-owner sees neither on a proposal; a proposal you authored shows Resolve (no Accept/Reject) even as owner.

**Acceptance Scenarios:**

AS-004: A remark offers Resolve / Reopen to a commenter
- **Given:** an unresolved remark (comment/like/label) and I have comment permission
- **When:** the rail item renders
- **Then:** the action bar shows a single Resolve action (and shows Reopen instead once the remark is resolved)
- **Data:** a like annotation, commenter role

AS-005: A pending proposal offers the owner Accept and Reject
- **Given:** a pending proposal authored by someone else and I am the doc owner
- **When:** the rail item renders
- **Then:** the action bar shows Accept and Reject (the proposal's two close actions)
- **Data:** a redline by another member, owner role, status pending

AS-006: A decided proposal offers the owner Reopen
- **Given:** an accepted (decided) proposal and I am the doc owner
- **When:** the rail item renders
- **Then:** the action bar shows Reopen (the universal undo) and no Accept/Reject
- **Data:** a redline, status accepted, owner role

AS-007: A non-owner viewing a proposal gets reply only, no close action
- **Given:** a proposal and I am a commenter (not the owner)
- **When:** the rail item renders
- **Then:** the action bar shows no close action (no Accept/Reject/Resolve) — I can still reply
- **Data:** a redline, commenter role

AS-008: A proposal I authored shows Resolve, never Accept/Reject (no self-approve)
- **Given:** a pending proposal whose creator id equals my user id and I am the doc owner
- **When:** the rail item renders
- **Then:** the action bar shows Resolve (treated as a remark) and hides Accept/Reject — I cannot approve my own proposal
- **Data:** a redline `authorId` = my user id, owner role

### S-003: Delete and restore with an undo toast (P0)

**Description:** As a reviewer, I can delete an annotation I authored from an overflow menu, and the doc owner
can delete anyone's (moderation); deleting removes it from the rail immediately and shows an undo toast that
restores it if I act in time; a viewer, a guest, and a non-owner who isn't the author see no Delete; a refused
delete leaves the item in place.
**Source:** conversation 2026-06-16 (Delete in overflow + undo toast; delete-own author / delete-any owner);
`annotation-actions`:S-004 (delete authz) + S-005 (restore + soft-delete exclusion from the read).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/components/thread-card.tsx` (overflow menu + Delete affordance gating), `apps/web/src/features/viewer/components/viewer-screen.tsx` (optimistic remove + undo-toast + restore wiring), `apps/web/src/features/viewer/services/client.ts` (delete + restore request thunks)
- `autonomous:` true
- `verify:` delete your own annotation → it disappears + an undo toast appears; click undo → it returns; as owner delete another's → disappears; as viewer → no Delete affordance.

**Acceptance Scenarios:**

AS-009: The author deletes their own annotation
- **Given:** an annotation I authored
- **When:** I open its overflow menu and choose Delete
- **Then:** the item is removed from the rail immediately and an undo toast appears
- **Data:** annotation `authorId` = my user id

AS-010: Undo restores a just-deleted annotation
- **Given:** I just deleted an annotation and the undo toast is showing
- **When:** I click Undo
- **Then:** the annotation reappears in the rail (restored)
- **Data:** the undo toast within its window

AS-011: The doc owner deletes another member's annotation (moderation)
- **Given:** an annotation authored by another member and I am the doc owner
- **When:** I choose Delete from its overflow menu
- **Then:** the item is removed (owner moderation) and an undo toast appears
- **Data:** annotation by another member, owner role

AS-012: A non-owner non-author sees no Delete affordance
- **Given:** an annotation authored by someone else and I am a commenter (not the owner)
- **When:** I open its overflow menu
- **Then:** no Delete option appears
- **Data:** annotation by another member, commenter role

AS-013: A refused delete leaves the annotation in place
- **Given:** I optimistically delete an annotation but the write is refused (role revoked / network error)
- **When:** the delete request comes back refused
- **Then:** the annotation is restored in the rail and an error is shown — no item is silently lost
- **Data:** delete refused

### S-004: Surface a proposal's pending / decided / stale status (P1)

**Description:** As a reviewer, a proposal shows where it stands — a Pending marker while it awaits a decision,
an accepted/rejected (dimmed/resolved) treatment once decided, and a distinct stale treatment when its pinned
span has drifted — so I can scan the rail and see what still needs the owner's call.
**Source:** conversation 2026-06-16 (Pending tag confirmed); `annotation-core` AS-030 (`suggestionStatus`
served on the list); `annotation-core-ui-types-modes` C-002 (stale = render-time state).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/components/thread-card.tsx` (status badge row)
- `autonomous:` true

**Acceptance Scenarios:**

AS-014: A pending proposal shows a Pending marker
- **Given:** a proposal whose status is pending
- **When:** the rail item renders
- **Then:** it shows a Pending marker (it awaits the owner's decision)
- **Data:** a redline, status pending

AS-015: A decided proposal shows its outcome and reads as resolved
- **Given:** a proposal the owner accepted
- **When:** the rail item renders
- **Then:** it shows the accepted outcome and reads as resolved (dimmed), not Pending
- **Data:** a redline, status accepted

AS-016: A drifted proposal shows a distinct stale treatment
- **Given:** a proposal whose pinned span no longer matches the current version
- **When:** the rail item renders
- **Then:** it shows a distinct stale treatment (not a confident pending marker)
- **Data:** a redline, status stale

### S-005: Rail-item layout — capped quote + own-line type-chip (P1)

**Description:** As a reviewer, a rail item keeps a clean fixed shape regardless of content length — the quoted
span is capped to a few lines with an expand control that opens a scrollable read-only view of the full quote,
and the type/label chip sits on its own line so a long or user-extensible label never pushes the author name
or breaks the layout.
**Source:** conversation 2026-06-16 (quote cap 3 lines + expand to a scroll area; type-chip on its own line
because label text is variable-length / user-extensible). Visual styling is [→MANUAL] per DESIGN.md.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/components/thread-card.tsx` (quote cap + expand + chip line)
- `autonomous:` true
- `verify:` an item with a long quote shows ~3 lines + an expand control; expanding shows the full quote in a scrollable area; an item with a long label keeps the chip on its own line and the layout intact.

**Acceptance Scenarios:**

AS-017: A long quote is capped with an expand control
- **Given:** a rail item whose quoted span is longer than the cap (a few lines)
- **When:** the item renders collapsed
- **Then:** the quote shows up to the cap (≈3 lines) with an expand control; the item keeps a fixed shape
- **Data:** a quote of ~10 lines

AS-018: Expanding the quote reveals the full text in a scrollable read-only area
- **Given:** a capped quote with its expand control
- **When:** I expand it
- **Then:** the full quote is shown in a scrollable, read-only area (the surrounding layout does not stretch unbounded)
- **Data:** the same ~10-line quote

AS-019: A long label keeps the type-chip on its own line and the layout intact
- **Given:** a rail item with a long (or user-extended) label
- **When:** the item renders
- **Then:** the type/label chip occupies its own line and does not crowd or break the author/name row
- **Data:** label text long enough to overflow a shared line

## Constraints & Invariants

- C-001: Own-vs-others is derived from the durable creator id (`authorId`), NOT the root-comment author; a
  null creator id (guest) matches no signed-in user, so a guest annotation is never marked own. (AS-001, AS-002, AS-003)
- C-002: An item shows at most TWO primary actions, chosen by family + permission: a Remark → Resolve/Reopen
  (commenter+); a pending Proposal → owner Accept + Reject; a decided Proposal → owner Reopen; a non-owner on
  a Proposal → no close action (reply only). Every affordance is a client hint — the backend re-authorizes the
  close by session role (`annotation-actions`:S-002). (AS-004, AS-005, AS-006, AS-007)
- C-003: No self-approve in the UI — when a Proposal's creator id equals the current user, Accept/Reject are
  hidden and Resolve is offered (the proposal is treated as a remark for its author); the gate keys on the
  user id and mirrors the server gate (`annotation-actions`:S-003). (AS-008)
- C-004: The Delete affordance appears only for the annotation's author (delete-own) or the doc owner
  (delete-any/moderation); a viewer, a guest, and a non-owner non-author see no Delete. The affordance is a
  hint — the backend re-authorizes the delete (`annotation-actions`:S-004). (AS-009, AS-011, AS-012)
- C-005: Delete is optimistic with an undo toast — the item is removed immediately and restored if the user
  undoes within the window; a refused/failed delete restores the item and surfaces an error (no silent loss).
  A soft-deleted annotation never reappears in the rail on refetch (it is excluded from the read,
  `annotation-actions`:S-005), and a restore brings it back. (AS-010, AS-013)
- C-006: A Proposal surfaces its lifecycle state from `suggestionStatus` — a Pending marker while pending, the
  accepted/rejected outcome (read as resolved/dimmed) once decided, and a distinct stale treatment when its
  span has drifted; Pending and a decided/stale state are mutually exclusive on one item. (AS-014, AS-015, AS-016)
- C-007: A rail item keeps a fixed shape independent of content length — the quote is capped (≈3 lines) with an
  expand to a scrollable read-only area, and the type/label chip sits on its own line so variable-length /
  user-extensible label text never breaks the layout. Visual styling per DESIGN.md [→MANUAL]. (AS-017, AS-018, AS-019)

## Linked Fields

annotation-actions-ui (consumer) reads what the `annotation-actions` / `annotation-core` backend (producer) writes.

- `authorId` — consumed HERE by S-001 (own-vs-others), S-002 (no-self-approve gate), S-003 (delete-own
  affordance) on the **annotations list read** (persisted + served on every list fetch). Produced by
  `annotation-actions`:S-001 (AS-001 persisted on create + served as `authorId` on the list read; AS-002 null
  for guest). ✔ surface (list read) + lifecycle (persisted + served) match.
- `suggestionStatus` (`pending|accepted|rejected|stale`) — consumed HERE by S-002 (which close actions) +
  S-004 (status surface) on the **annotations list read**. Produced by `annotation-core` AS-030 (served on the
  list) + decided by `annotation-actions` (S-002 close path). ✔ surface + lifecycle match.
- delete route — consumed HERE by S-003 (Delete affordance → request). Produced by `annotation-actions`:S-004
  (session-required, own/owner-moderate, soft-delete). ✔
- restore route — consumed HERE by S-003 (Undo → restore). Produced by `annotation-actions`:S-005 (AS-016
  author/owner restore clears the tombstone). ✔
- soft-delete exclusion from the list — consumed HERE by S-003/C-005 (optimistic remove stays consistent on
  refetch; a deleted item does not reappear). Produced by `annotation-actions`:S-005 (AS-014 excluded from the
  list read). ✔
- `effectiveRole` on the doc read — consumed HERE by S-002/S-003 (owner-only Accept/Reject + moderate-delete
  hints). Produced by the viewer-doc read. ✔ already served.

## UI Notes

Design source: the locked rail-item redesign (conversation 2026-06-16) + DESIGN.md. Precedence: AS / Constraints
> this Tree. The viewer shell, marks, popover, toolbar, and create paths are owned by the
`annotation-core-ui*` siblings and reused unchanged.

- `ThreadCard` *(reuse — `thread-card.tsx`; the focus of this spec)*
  - author/attribution row *(from `authorId`; an own item is marked own — S-001)*
  - `TypeChip` *(on its own line — type/label, variable-length; never shares the author row — S-005/C-007)*
  - `QuotePreview` *(capped ≈3 lines + an expand control → a scrollable read-only full quote — S-005/C-007)*
  - `StatusBadge` *(Proposal only: Pending / accepted / rejected / stale — S-004/C-006)*
  - thread *(reused flat reply + the existing thread, unchanged)*
  - `ActionBar` *(≤2 contextual actions by family + permission + own — S-002/C-002, no-self-approve C-003)*
  - `OverflowMenu` *(houses Delete; shown only for author / owner — S-003/C-004)*
  - `UndoToast` *(post-delete restore window — S-003/C-005)* — supplied by the viewer screen, not the card

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| ThreadCard | `apps/web/src/features/viewer/components/thread-card.tsx` | rework: own-vs-others from `authorId`; collapse the action row to the 2-family bar; add overflow Delete; add the Pending/status surface; cap the quote + own-line chip |
| ViewerScreen | `apps/web/src/features/viewer/components/viewer-screen.tsx` | thread the current user id to each card; wire delete/restore + the undo toast; gate decide/resolve callbacks by family |
| Typed client | `apps/web/src/features/viewer/services/client.ts` | add `authorId` to the read type; add delete + restore request thunks |

### System Impact & Technical Risks

- The backend for all of this already landed (`annotation-actions` S-001..S-005, 737 tests green) — durable
  `author_id`, soft-delete + restore, the 2-family close authority, and the no-self-approve gate are all
  server-enforced. This spec is pure FE consumption; the only risk is the FE relying on a client hint instead
  of the server gate — C-002/C-003/C-004 pin every affordance as a hint with server re-authz.
- `ThreadCard` currently derives the author from the root comment and shows Resolve on every type plus
  Accept/Reject on redlines (both at once). This spec reworks that surface; reply/resolve/reopen mechanics
  from `annotation-core-ui-commenting` are reused unchanged — only their *gating + presentation* change.

## Not in Scope

- The annotation type taxonomy, the Markup popover/tool palette, the create paths (redline/like/label create),
  and the marks — owned by `annotation-core-ui-types-modes` (built); this spec does not re-own create.
- Reply / resolve / reopen thread *mechanics* — owned by `annotation-core-ui-commenting`; reused unchanged.
- The image-region (anchor type 2) UI — `annotation-core-ui-suggest-image` (deferred).
- The MCP pull feed's treatment of deleted/decided annotations — `mcp-roundtrip` (unbuilt); when it lands it
  reads through the same soft-delete-excluding list.
- Per-workspace label customization, Pinpoint mode, global doc-level comment — deferred (see types-modes Not in Scope).

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-16 | Initial creation — FE counterpart of `annotation-actions` backend: own-vs-others from durable `authorId`, the 2-family 2-slot action bar (incl. owner no-self-approve), Delete + restore with an undo toast, proposal status surfacing, and the rail-item layout redesign (capped quote + own-line type-chip). Scope-by-layer sibling of `annotation-actions`. From conversation 2026-06-16 (Mode A). | -- |
