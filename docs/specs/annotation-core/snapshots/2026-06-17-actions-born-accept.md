# Snapshot: annotation-actions
**Date:** 2026-06-17
**Ref:** --
**Reason:** M1 (new story S-006) + M6 (new constraint C-008, amended C-004) — a creator with edit authority born-accepts their own proposal

---

# Spec: annotation-actions

**Created:** 2026-06-16
**Last updated:** 2026-06-16
**Status:** Draft

## Overview

The single source of truth for the annotation **action & permission model** — who may resolve,
reopen, accept/reject (decide), and delete/restore an annotation, decided by the annotation's
**family** and the actor's per-doc role + identity. Consolidates rules previously scattered across
`annotation-core` (C-005 resolve, C-011 stale, C-016 decided-reopen) + the decide route, and ADDS:
the owner does not self-approve their own proposal, a Delete/Restore action (own + owner-moderation,
soft), and a **durable creator identity** on the annotation so own-vs-others gates have a stable anchor.

Backend-authz scoped. The rail-item UI that renders these actions lives in
`annotation-core-ui-types-modes`. Create / anchor / read mechanics stay in `annotation-core`; this
spec owns the lifecycle **verbs** and their permission gates.

## Data Model

Rides the existing `annotations` table (`apps/backend/src/db/schema.ts`).

- **`annotations.author_id`** (nullable text, FK → user, `on delete set null`) — NEW. The **durable
  creator identity**, written AT CREATE from the session actor (`createAnnotation` / `createSuggestion`
  insert it). NULL when the creator is a guest (no account). This is the SINGLE authoritative creator
  fact for own-vs-others gates — it is NOT derived from the root comment.
  - Why a column, not the root comment's author: `createAnnotation`/`createSuggestion` insert NO
    comment, comments arrive on separate requests, and a `parentId IS NULL` comment is not unique
    (a guest can also top-level-comment), so "earliest comment author" is neither guaranteed to exist
    nor to be the creator (challenge F-1/F-2). The FE unifying root-comment model
    (annotation-core-ui-types-modes C-003) governs DISPLAY attribution (the name shown); `author_id`
    governs AUTHZ. Served on the read as `authorId`.
- **`annotations.deleted_at`** (nullable timestamp) — NEW soft-delete tombstone, mirroring
  `dismissed_at` (annotation-core S-008). A deleted annotation is **terminal** and excluded from EVERY
  read/enumeration surface (C-007). Restore clears it.
- **Two families** (a derived classification, not a column):
  - **Remark** = `type` ∈ range | multi_range | block | doc, with NO `suggestion` payload — Comment /
    Like / Label (Like/Label carry a `label`, AS-027). An **image-region** annotation is stored as
    `type=block` with a region anchor (annotation-core S-002) and is a Remark in v0 (the `block` type
    is overloaded — a future image-region-specific rule must read the anchor kind, not just `type`).
  - **Proposal** = `type` = suggestion — Redline (`suggestion.kind=delete`) / Suggest (`kind=replace`),
    carrying `suggestion_status` (pending | accepted | rejected | stale).

## Stories

### S-001: Persist + serve the creator identity (P0)

**Description:** As the system, every annotation records its creator (`author_id`) at create time —
the session actor, or null for a guest — and serves it on the annotations read as `authorId`, so the
client AND every server gate (delete-own, owner-no-self-approve) have ONE durable creator fact, not a
guess derived from comment ordering.
**Source:** PO action/permission model 2026-06-16 + /mf-challenge F-1/F-2 (creator must be persisted, not root-comment-derived).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/backend/src/db/schema.ts` (`author_id` column), `apps/backend/src/annotation/annotation.ts` + `suggestion.ts` (write `author_id` at create from the session actor), `repo.ts` (insert + select `author_id`; serve on `listByDoc`), `routes/annotations.ts` (pass the actor's id into create; GET serializes `authorId`), `annotation.ts` AnnotationRow
- `autonomous:` checkpoint
- `verify:` create an annotation as Mara → its `authorId` is Mara on the read; create as a guest → `authorId` is absent.

**Acceptance Scenarios:**

AS-001: The creator is recorded at create and served on read
- **Given:** member Mara creates an annotation (a comment or a redline)
- **When:** it is created, then the doc's annotations are read
- **Then:** the annotation's creator is recorded as Mara at create time (a durable creator field, not
  inferred from any comment) and the read carries `authorId` = Mara
- **Data:** member-created annotation

AS-002: A guest-created annotation has no account creator
- **Given:** a guest (anyone-with-link, no account) creates an annotation
- **When:** it is created, then read
- **Then:** the creator field is empty and `authorId` is absent — a guest has no durable identity to own-gate against
- **Data:** guest-created annotation

### S-002: A proposal is closed by the owner, not resolved by a commenter (P1)

**Description:** A participant can reply to anyone's Redline/Suggest, but ONLY the doc owner closes a
proposal — by Accept/Reject (annotation-core AS-015). A non-owner cannot Resolve/close a proposal in
ANY state (pending OR decided) the way they can a Remark; the proposal stays open until the owner
decides. Family boundary: Remarks close by Resolve (commenter+); Proposals close by owner decide.
**Source:** PO 2-family model 2026-06-16; /mf-challenge F-3 (the pending-suggestion resolve hole — `setResolution` today lets a commenter resolve a pending suggestion).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/backend/src/annotation/resolve.ts` (gate resolve by suggestion-presence, not only decided-status), `routes/annotations.ts` (resolution handler passes the full suggestion presence so a non-owner remark-style resolve on ANY suggestion is refused)
- `autonomous:` true
- `verify:` as a commenter, resolving a PENDING redline is refused; replying to it succeeds.

**Acceptance Scenarios:**

AS-003: A non-owner cannot resolve/close a proposal in any state
- **Given:** a redline authored by Mara — try it both pending AND already-decided; user Lan is a commenter, not the owner
- **When:** Lan tries to Resolve (close) it the way she would a comment
- **Then:** the request is refused; the proposal's state is unchanged (only the owner closes a proposal, by deciding). This holds for a PENDING redline, not only a decided one.
- **Data:** commenter Lan ≠ owner; redline status = pending

AS-004: A non-owner can still reply to a proposal
- **Given:** the same redline; commenter Lan
- **When:** Lan replies
- **Then:** the reply is added flat under the redline (participation unchanged; only closing is owner-gated)
- **Data:** reply "agree, the title is redundant"

### S-003: The owner does not self-approve their own proposal (P1)

**Description:** A Redline/Suggest whose creator is the acting user is treated as a Remark — there is
no Accept/Reject to perform on your own proposal (you are the authority); you close it by Resolve.
Accept/Reject is for deciding OTHER people's proposals. The gate keys on **creator user-id =
acting user-id**, NOT role-vs-role, so it is correct under multiple/transferred owners.
**Source:** PO 2026-06-16 ("owner luôn biết mình làm gì"); /mf-challenge F-2 (enforce server-side via the persisted creator) / null-creator path.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/annotation/suggestion.ts` (decide takes the acting user-id + the suggestion's `author_id`), `routes/annotations.ts` (decide handler: refuse when actor === creator), `resolve.ts` (the owner may resolve their own proposal)
- `autonomous:` true

**Acceptance Scenarios:**

AS-005: The creator cannot accept/reject a proposal they authored
- **Given:** a pending redline whose `author_id` is the acting user (the owner authored it themselves)
- **When:** they try to Accept (or Reject) it
- **Then:** the decide is refused SERVER-side (a proposal you authored is implicitly your own call —
  no self-approval); the proposal is unchanged. The check is `acting user-id === the proposal's creator`, independent of how many owners the doc has.
- **Data:** acting user = the redline's creator

AS-006: The owner closes their own proposal by resolving it
- **Given:** the same owner-authored redline
- **When:** the owner Resolves it
- **Then:** the thread becomes resolved (closed like a remark); the proposal is NOT marked accepted/rejected
- **Data:** owner = creator

AS-007: A proposal with no account creator is decidable by the owner (never self)
- **Given:** a pending redline created by a guest (creator is empty / `author_id` null)
- **When:** the owner Accepts it
- **Then:** the decide succeeds — a null creator can never equal the acting user, so it is never a
  self-approval; a guest-authored proposal is always owner-decidable
- **Data:** guest-created redline, owner ≠ creator

### S-004: Delete an annotation — own, or owner moderation (P0)

**Description:** As the author of an annotation I can delete my own; as the doc owner I can delete
anyone's (moderation). Delete requires an authenticated session, runs the same existence-hiding +
parent-doc gate as every annotation route, and a viewer / guest / non-owner-non-author cannot delete.
**Source:** PO 2026-06-16; /mf-challenge F-5 (session-required mount + 404 existence-hiding + parent-doc binding).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` new `apps/backend/src/annotation/delete.ts` (authz: own via `author_id` vs owner-moderate), `routes/annotations.ts` (the delete route, mounted SESSION-REQUIRED, existence-hiding via enforceParentAccess), `repo.ts` (set `deleted_at`)
- `autonomous:` checkpoint
- `verify:` author deletes own → gone; owner deletes another's → gone; a viewer / an anonymous request / a non-owner deleting another's → refused; deleting on a doc you can't view → not-found.

**Acceptance Scenarios:**

AS-008: An author deletes their own annotation
- **Given:** an annotation created by commenter Lan; Lan is signed in
- **When:** Lan deletes it
- **Then:** the annotation is soft-deleted (kept, not hard-removed)
- **Data:** `author_id` = Lan

AS-009: The owner deletes another person's annotation (moderation)
- **Given:** an annotation created by Lan, on a doc owned by Sara
- **When:** Sara (owner, not the author) deletes it
- **Then:** the annotation is soft-deleted
- **Data:** owner Sara ≠ creator Lan

AS-010: A non-owner non-author cannot delete someone else's annotation
- **Given:** Lan's annotation; Bob has commenter permission, is neither author nor owner
- **When:** Bob tries to delete it
- **Then:** the request is refused; the annotation is unchanged
- **Data:** commenter Bob

AS-011: A viewer cannot delete
- **Given:** a viewer-only user on a doc with an annotation
- **When:** they try to delete it
- **Then:** the request is refused
- **Data:** viewer role

AS-012: An unauthenticated (guest/anon) request cannot delete
- **Given:** no signed-in session (a guest on an anyone-with-link doc)
- **When:** a delete is attempted (even for an annotation the guest session created)
- **Then:** the request is refused for lack of an authenticated session — BEFORE any own/owner check
  (delete is session-required; a guest has no durable identity and is not the owner)
- **Data:** no account session

AS-013: Deleting on a doc the caller cannot view is indistinguishable from not-found
- **Given:** an annotation on a restricted doc the caller cannot view
- **When:** the caller attempts to delete it by id
- **Then:** the response is the same not-found as a missing id (existence-hiding) — the role/own
  check runs only AFTER the parent doc is resolved + access-gated, against THAT doc (no cross-doc id confusion)
- **Data:** caller with no access to the parent doc

### S-005: Soft-delete is terminal, excluded everywhere, and restorable (P0)

**Description:** A soft-deleted annotation is **terminal**: it is excluded from EVERY read/enumeration
surface (the annotations list, search, the re-anchor pass + its detached-rate metric, and the MCP
pull), and resolve/decide/reopen on it are refused — so a deletion can never be silently undone by a
concurrent decide or re-anchored onto a new version. The author or owner can restore it (clear the
tombstone), returning it to the active list — this is the durable undo backing the FE's optimistic
undo toast.
**Source:** /mf-challenge F-4 (terminal + total exclusion; search/re-anchor leaks; decide-on-deleted) + F-7 (delete-immediate soft + a small restore route, PO-decided 2026-06-16).

**Execution:**
- `depends_on:` S-004
- `parallel_safe:` false
- `files:` `apps/backend/src/annotation/repo.ts` (exclude `deleted_at` in `listByDoc` + the re-anchor enumeration), `search/repo.ts` or `search-repo.ts` (exclude deleted in the comment-match join), `annotation/reanchor-job.ts` (skip deleted + don't count them in the detached rate), `resolve.ts` / `suggestion.ts` (refuse on a deleted annotation), `routes/annotations.ts` (restore route, author/owner-gated), the MCP pull (exclude deleted)
- `autonomous:` checkpoint
- `verify:` soft-delete an annotation → absent from the list AND from search AND not re-anchored on a new version; accept/resolve on it is refused; author/owner restore → back in the list.

**Acceptance Scenarios:**

AS-014: A deleted annotation is excluded from every read surface
- **Given:** an annotation just soft-deleted, whose comment body contains the word "secret"
- **When:** the doc's annotations are read, the doc is searched for "secret", and a new version is published (re-anchor runs)
- **Then:** the annotation is absent from the active list (its highlight gone), does NOT match the search, and is NOT re-anchored onto the new version nor counted in the detached-rate metric — it does not resurface on any later read
- **Data:** one soft-deleted annotation with searchable comment text

AS-015: Deleted is terminal — decide/resolve/reopen on a deleted annotation is refused
- **Given:** a pending redline that has been soft-deleted
- **When:** the owner tries to Accept it (or anyone tries to resolve/reopen it)
- **Then:** the request is refused — a deleted annotation cannot be decided/resolved, so a concurrent
  delete + decide can never leave it both deleted AND accepted (and an agent never applies a deletion the author removed)
- **Data:** soft-deleted redline, owner attempts accept

AS-016: The author or owner restores a soft-deleted annotation
- **Given:** an annotation the author (or the owner) just soft-deleted
- **When:** they restore it (within the undo window or later)
- **Then:** the tombstone is cleared and the annotation returns to the active list (and re-anchors normally on the next version); a non-owner non-author cannot restore another's
- **Data:** author restores own; owner restores any

## Constraints & Invariants

- C-001: Annotations fall into two **families** — Remark (comment/like/label, incl. image-region) and
  Proposal (suggestion: redline/suggest). Action vocabulary is per-family: a Remark closes by
  Resolve/Reopen; a Proposal closes by Accept/Reject. (AS-003, AS-004, AS-005, AS-006)
- C-002: Remark close — Resolve/Reopen by comment-permission+ (NOT author-gated), unchanged from
  annotation-core C-005/AS-009/AS-010, now scoped to **remarks only**. (annotation-core AS-009, AS-010)
- C-003: Proposal close — Accept/Reject is OWNER-only (annotation-core AS-015); a non-owner may reply
  but may NOT resolve/close a proposal **in any state (pending OR decided)**; reopening a decided
  proposal → pending is owner-only (annotation-core C-016). (AS-003, AS-004)
- C-004: No self-approve — a proposal whose creator (`author_id`) equals the acting user is treated as
  a remark: no Accept/Reject (refused server-side), closed by Resolve. The gate keys on creator
  user-id = acting user-id (NOT role), so it is correct under multiple/transferred owners; a null
  creator (guest) is never a self and is always owner-decidable. Requires C-005. (AS-005, AS-006, AS-007)
- C-005: Creator identity is PERSISTED on the annotation (`author_id`, written at create from the
  session actor; null for a guest) and served on the read as `authorId`. It is NOT derived from the
  root comment (which has no uniqueness/ordering guarantee and may not exist at create). The FE
  root-comment model governs display attribution only. (AS-001, AS-002)
- C-006: Delete — **delete-own** by the author (an account-holder whose `author_id` matches the actor);
  **delete-any (moderation)** by the doc OWNER. Delete is **session-required** (an unauthenticated /
  guest request is refused before any own/owner check), runs existence-hiding (a no-access/missing
  parent doc → the same not-found, never a 403 leak) and binds the annotation to its resolved parent
  doc before the role check; a viewer and a non-owner-non-author cannot delete. (AS-008, AS-009, AS-010, AS-011, AS-012, AS-013)
- C-007: Soft-delete (`deleted_at`) is **terminal + totally excluded** — a deleted annotation is
  excluded from EVERY read/enumeration surface (annotations list, search comment-match, the re-anchor
  enumeration + its detached-rate denominator, and the MCP pull), and resolve/decide/reopen on it are
  refused (so a concurrent delete+decide cannot desync, and a deleted proposal is never re-anchored or
  applied). The author or owner may RESTORE it (clear `deleted_at`), returning it to the active list;
  a non-owner-non-author cannot restore. This is the durable backing for the FE optimistic-undo toast.
  (AS-014, AS-015, AS-016)

## Linked Fields

Producer/consumer split: this spec PRODUCES on the backend read; `annotation-core-ui-types-modes` (FE)
CONSUMES.

- `authorId` (from the persisted `author_id`) — consumed by `annotation-core-ui-types-modes` on the
  annotations LIST row (persisted + served on every read) to gate own-vs-others (owner-self-approve,
  delete-own). Produced HERE by S-001/AS-001 on the list surface. ✔ surface + lifecycle match.
- the **delete + restore** actions + `deleted_at` total-exclusion — consumed by
  `annotation-core-ui-types-modes` (the overflow Delete + optimistic-remove + the undo toast → restore).
  Produced HERE by S-004 (delete) + S-005 (terminal exclusion + restore). ✔ delete-immediate soft +
  restore is the durable undo the FE toast calls.
- `suggestion_status` (the Proposal lifecycle the close rules read) — produced by annotation-core
  AS-030 (served on the list). Consumed HERE by C-001/C-003 to classify family + gate close. ✔ already served.

## What Already Exists

### System Impact & Technical Risks

- The capability matrix (`apps/backend/src/sharing/roles.ts`, `can(role, action)`) gives
  view/comment/resolve/edit/manage_sharing — REUSE it. Delete is CONTEXTUAL (own via `author_id` vs
  owner-moderate), NOT a static `can()` grant (mirrors `manage_sharing`/C-007 in sharing).
- **Creator identity has no durable home today** (challenge F-1): `createAnnotation`/`createSuggestion`
  insert only the annotations row (no comment); the read derives nothing creator-ish. S-001 adds the
  `author_id` column written at create — the keystone the delete-own + self-approve gates need. Without
  it both gates anchor to a non-guaranteed, non-unique "earliest comment author" and mis-authorize.
- Resolve (`resolve.ts setResolution`) special-cases only DECIDED suggestions (challenge F-3) — a
  PENDING suggestion currently falls through to `can(role,"resolve")`, so a commenter can resolve a
  pending redline TODAY. S-002 closes this by gating on suggestion-presence, not decided-status.
- Decide (`suggestion.ts decideSuggestion`) receives NO actor/creator (challenge F-2) — S-003 threads
  the acting user-id + the suggestion's `author_id` so owner-no-self-approve is enforceable at all.
- Soft-delete leaks (challenge F-4): `search-repo.ts` joins comments with no tombstone filter;
  `reanchor-job.ts` enumerates via `listByDoc` filtering only `type`; `getSuggestion`/`findSuggestionDoc`
  filter only `type="suggestion"`. C-007 makes `deleted_at` terminal on ALL of these.
- `dismissed_at` (annotation-core S-008) is the precedent for `deleted_at` (same tombstone shape). NOTE:
  S-008 itself is specced-not-built; `deleted_at` is independent of it.
- Risk: delete is destructive + cross-cutting — S-001/S-004/S-005 are `autonomous: checkpoint` (the
  create-time identity write, the delete authz, and the terminal-exclusion surfaces are human-reviewed
  before landing). Soft + restore keeps it recoverable.

## Not in Scope

- The rail-item UI (action bar, overflow Delete, undo toast, Pending tag, quote expand) —
  `annotation-core-ui-types-modes` (FE), consumes this spec's `authorId` + delete/restore routes.
- A static `delete` capability in `roles.ts` — delete is contextual (own/owner), kept out on purpose.
- Hard delete / purge + a deletion audit-log — v0.5 moderation; v0 is soft-delete + restore only.
- Re-anchor / detached dismiss/reattach mechanics (annotation-core S-005/S-008) — a different lifecycle;
  this spec only requires re-anchor to SKIP deleted rows (C-007), it does not change re-anchor itself.
- Editor moderating others' annotations — owner-only moderation in v0 (editor deletes own only).

## Gaps

(none open — GAP-001 on un-delete resolved into S-005 AS-016: delete-immediate soft + author/owner restore.)

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-16 | Initial creation — the annotation action/permission model (2 families × role × resolve/decide/delete) consolidating annotation-core C-005/C-016/decide; + owner-no-self-approve, + Delete (own/owner-moderate, soft), + serve creator on read. | PO action-model decision 2026-06-16 |
| 2026-06-16 | /mf-challenge hardening (6 findings accepted + GAP-001 re-decided): F-1 creator is a PERSISTED `author_id` column written at create (not root-comment-derived) — Data Model + S-001 reframed; F-2 owner-no-self-approve enforced server-side via creator-user-id, + null-creator AS-007; F-3 S-002 gates non-owner resolve on ANY suggestion (pending too); F-4 + S-005 soft-delete terminal + excluded from list/search/re-anchor/MCP + decide-on-deleted refused; F-5 delete is session-required + existence-hiding 404 + parent-doc binding (AS-012/013); F-6 image-region=Remark note; F-7 GAP-001 → delete-immediate soft + author/owner restore route (AS-016). Stories 4→5, AS 12→16. | /mf-challenge 2026-06-16 |
