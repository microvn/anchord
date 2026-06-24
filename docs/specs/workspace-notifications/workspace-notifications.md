# Spec: Workspace Notifications

**Created:** 2026-06-23
**Last updated:** 2026-06-23
**Status:** Active
**Snapshot limit:** 5

## Overview

Extends the existing notification taxonomy with four workspace-membership events:
being invited to a workspace, a member joining, a member being removed, and a
workspace being renamed. Today only annotation/doc events notify; workspace
membership changes are silent. This spec fires notifications on those changes,
reusing the existing in-app bell + email channel.

Sibling of `notification-preferences` (the per-user opt-out + Settings UI), which
ships AFTER this spec — its toggle list and channel policy consume the event types
this spec produces. Until that spec lands, channel choice here follows the existing
hardcoded high/low-signal policy (no per-user override yet).

## Data Model

- **`notification_type` enum (extend)** — add four values:
  `workspace_invited`, `workspace_member_joined`, `workspace_member_removed`,
  `workspace_renamed`. A single migration adds all four with `ADD VALUE IF NOT EXISTS`
  (idempotent on crash-restart; forward-only — no down-migration), owned by S-001. The
  TS union `NotificationType` lives separately in `notify/types.ts` and MUST be widened in
  lockstep — the pgEnum and the union are hand-synced (F3).
- **`notifications.refId`** — holds the type's action/deep-link target:
  - `workspace_member_joined` / `workspace_member_removed` / `workspace_renamed` → the `workspace_id`.
  - **`workspace_invited` → the `invitation_id`** (the actionable target — the row IS an invite you accept/decline; the invitation row already exists at emit time via the `workspaces:S-004` invite flow). This is what lets the For-you inbox call accept/decline directly (consumed by `your-activity-inbox:S-005` — see Linked Fields). The workspace NAME for display still comes from `refLabel` (below); the workspace id, if ever needed for an invited row, derives from the invitation.
  - NOTE the existing read surface (`notify/read-repo.ts listForUser`) enriches every row by joining `refId → annotations → docs`; a workspace_id OR an invitation_id matches no annotation, so doc-based enrichment returns null for these rows (unchanged). The read path must NOT live-join `workspaces` (that would leak the workspace's CURRENT name to a member who was since removed — F1).
- **Snapshot column (NEW) — `notifications.refLabel` (text, nullable)** — captures the
  human-readable display text at EMIT time so it survives membership deletion (AS-006) and
  cannot drift: the workspace name for invited/joined/removed; `"<old> → <new>"` for renamed;
  the joiner's DISPLAY NAME (never email — F-security) for member_joined. The bell renders
  from `refLabel`, not a live join. `commentId` is null for all workspace types.
  - *Impl (build-time):* every value written to `refLabel` passes through a `sanitizeRefLabel`
    guard at emit — strips CR/LF + control characters and bounds length — so the snapshot is
    inert (C-006). Applied to ALL workspace types including `workspace_invited` (not just the
    removal path AS-009 nominally introduces it on); for `workspace_renamed` BOTH old and new
    names are sanitized before composing `"<old> → <new>"`.
- **Recipient resolution (new)** — workspace-membership-based, unlike the existing
  doc-access-based resolvers. Requires NEW repo ports (none exist today — `TenancyRepo` has
  only `countAdmins` + admin-gated `listMembers`): `listWorkspaceAdminIds(workspaceId)` and
  `listWorkspaceMemberIds(workspaceId)`. This IS new code in the notify repo — not a
  no-op wiring (F2).
  - *Impl (build-time):* two further notify-repo ports back the `refLabel` snapshot resolved
    post-commit WITHOUT a live tenancy join — `getWorkspaceName(workspaceId)` (the workspace
    name for the invited/joined/removed/renamed label, and the OLD name read before a rename)
    and `getUserName(userId)` (the joiner's display name for member_joined — name only, never
    email, F-security). `findUserIdByEmail(email)` resolves the invitee account for
    `workspace_invited` (null → no in-app row).
  - `workspace_invited` → the invited account (only if an account exists for the email).
  - `workspace_member_joined` → all admins of the workspace, minus the joining member.
  - `workspace_member_removed` → the removed user only — resolved AND the workspace name +
    recipient email snapshotted BEFORE the membership delete (post-delete they are
    unreadable via membership joins — F1).
  - `workspace_renamed` → all current members, minus the renamer.
- **Channel per event (default, via the existing high/low-signal mechanism):**
  - `workspace_invited` — in-app only. The invite EMAIL already exists (`workspaces`
    invite flow enqueues it); the notification channel must not re-send it.
  - `workspace_member_joined` — in-app only by default; email is supported but OFF by
    default (admins opt in via `notification-preferences`), to avoid inbox noise on busy
    workspaces. Shipped alone (before that spec), this event emits in-app only.
  - `workspace_member_removed` — in-app + email. The in-app row is a CRITICAL always-on
    notice (mirrors `detached`): `notification-preferences` locks it on so it cannot be
    fully suppressed (F6). The email needs `workspace_member_removed` added to
    `HIGH_SIGNAL_TYPES` + a non-fallback entry in `EVENT_SUBJECT`/`EVENT_SUMMARY` (both are
    total `Record<NotificationType,string>` maps) + a WORKSPACE-shaped deep-link builder
    (the existing one is annotation-shaped `/d/{slug}#annotation-{id}` — F3).
    - *Impl (build-time):* the workspace deep-link is `buildWorkspaceDeepLink(appUrl, workspaceId)`
      → `/w/{id}`, threaded into the shared per-recipient dispatch via an `emailDeepLinkOverride`
      param so a workspace email skips the annotation-shaped (`getDocSlug`) path. The multi-recipient
      events (joined → admins, renamed → members) go through a batch insert (`insertNotifications([])`,
      one round-trip) fired off the request's critical path (C-005).
  - `workspace_renamed` — in-app only.

## Stories

### S-001: Notify an invited member in the bell (P1)

**Description:** As someone invited to a workspace who already has an account, I see an
in-app notification that I've been invited, so I can act on it from the bell — without a
second email beyond the invite itself.
**Source:** Final notification list (conversation 2026-06-23) + product mockup
"Workspace invitations"; rides `workspaces:S-004` invite flow (`POST /api/workspaces/:id/invitations`).
**Applies Constraints:** C-001, C-002, C-004

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` apps/backend/src/db/schema.ts (enum migration + `refLabel` column), apps/backend/src/notify/types.ts (widen `NotificationType` union), apps/backend/src/notify/notify.ts (recipient resolvers + dispatch + `EVENT_SUBJECT`/`EVENT_SUMMARY` keys + `HIGH_SIGNAL_TYPES` + workspace deep-link builder), apps/backend/src/notify/read-repo.ts (render from `refLabel`, not a workspaces live-join) + the notify repo ports `listWorkspaceAdminIds`/`listWorkspaceMemberIds`, apps/backend/src/routes/workspaces.ts (invite handler)
- `autonomous:` checkpoint
- `verify:` invite an email that has an account → that account gets one in-app row carrying the workspace name (from `refLabel`) AND `refId` = the invitation id, and no extra email; invite an email with no account → no in-app row, invite email still sent; a test asserts every email-eligible type has a non-fallback subject + body (no `?? "anchord notification"` leak).

**Acceptance Scenarios:**

AS-001: Inviting an existing account creates an in-app row, no second email
- **Given:** workspace "Acme"; admin Alice invites bob@x as member, and bob@x already has an account
- **When:** the invitation is sent
- **Then:** Bob gets one in-app notification that he was invited to "Acme", and no email beyond the existing invite email is sent
- **Data:** invitee bob@x (account exists), role member

AS-002: Inviting an email with no account creates no in-app row
- **Given:** admin Alice invites new@x to "Acme", and new@x has no account
- **When:** the invitation is sent
- **Then:** no in-app notification row is created (no account to attach it to); the existing invite email is still sent
- **Data:** invitee new@x (no account)

AS-003: The inviting admin is never a recipient
- **Given:** admin Alice invites someone to "Acme"
- **When:** the invitation is sent
- **Then:** Alice gets no in-app notification for this invite
- **Data:** actor = Alice (admin)

AS-010: The invited row carries the invitation id so it is actionable
- **Given:** admin Alice invites bob@x (existing account) to "Acme" — a pending invitation row exists
- **When:** Bob's `workspace_invited` in-app row is created
- **Then:** the row's `refId` is that invitation's id (not the workspace id), so a reader can accept/decline it via `POST /api/invitations/:id/accept|reject`; `refLabel` still carries the workspace name "Acme" for display
- **Data:** invitation id = inv-123, workspace "Acme"; row.refId = inv-123, row.refLabel = "Acme"

### S-002: Notify admins when a member joins (P2)

**Description:** As a workspace admin, I'm notified when someone accepts an invite and
joins my workspace.
**Source:** Product mockup "Workspace members joining"; rides `workspaces:S-004` accept flow (`POST /api/invitations/:id/accept`).
**Applies Constraints:** C-002, C-004, C-005

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/notify/notify.ts, apps/backend/src/routes/workspaces.ts (accept handler)
- `autonomous:` true

**Acceptance Scenarios:**

AS-004: Accepting an invite notifies every admin, not the joiner
- **Given:** "Acme" has admins Alice and Carol and a pending invite to Bob
- **When:** Bob accepts the invite and joins
- **Then:** Alice and Carol each get one in-app notification that Bob joined "Acme"; no email is sent by default; Bob gets none
- **Data:** admins {Alice, Carol}, joiner Bob

### S-003: Notify a removed member (P1)

**Description:** As someone removed from a workspace, I'm told I was removed — even though
I no longer have access to that workspace.
**Source:** Product mockup "Workspace member removal"; rides member removal (`DELETE /api/w/:workspaceId/members/:userId`).
**Applies Constraints:** C-002, C-003, C-004, C-006

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/notify/notify.ts, apps/backend/src/routes/members.ts
- `autonomous:` true
- `verify:` admin removes a member → the removed member gets one in-app row + email titled "removed from <workspace>", delivered despite their lost membership.

**Acceptance Scenarios:**

AS-005: Removing a member notifies that member
- **Given:** admin Alice removes Bob from "Acme"
- **When:** the removal completes
- **Then:** Bob gets one notification that he was removed from "Acme" (in-app and email); Alice (the removing admin) gets none
- **Data:** actor Alice (admin), target Bob

AS-009: A crafted workspace name does not inject into the removal email
- **Given:** the workspace name contains embedded CR/LF and a spoofed line ("Acme\r\nSubject: verify at evil.com")
- **When:** a member is removed and the removal email is built
- **Then:** the name is stripped of control characters before it reaches the email subject/body — no injected header or line; the in-app row renders the name as inert text
- **Data:** workspace name with CRLF + control chars

AS-006: The removal notice reaches the removed member despite lost access
- **Given:** Bob's membership of "Acme" has just been deleted by the removal
- **When:** recipients for the removal notification are resolved
- **Then:** Bob still receives the notification — the membership-based recipient check does not drop the just-removed user
- **Data:** Bob is no longer a member at resolution time

AS-008: A notification failure does not fail the removal
- **Given:** admin Alice removes Bob, and the notification dispatch path throws
- **When:** the removal completes
- **Then:** the removal still succeeds (Bob is removed) and the error is swallowed — the action is never rolled back by a notify failure
- **Data:** notify path errors post-commit

### S-004: Notify members on workspace rename (P2)

**Description:** As a workspace member, I'm notified when an admin renames the workspace
(or changes its URL).
**Source:** Product mockup "Workspace name or URL changes"; rides rename (`PATCH /api/workspaces/:id`).
**Applies Constraints:** C-002, C-004, C-005

**Acceptance Scenarios:**

AS-007: Renaming notifies all members except the renamer, in-app only
- **Given:** "Acme" has admin Alice (the renamer) and members Bob and Carol
- **When:** Alice renames it to "Acme Docs"
- **Then:** Bob and Carol each get one in-app notification that "Acme" was renamed to "Acme Docs"; Alice gets none; no email is sent
- **Data:** renamer Alice, members {Bob, Carol}

**Execution (S-004):**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/notify/notify.ts, apps/backend/src/routes/workspaces.ts (rename handler)
- `autonomous:` true

## Constraints & Invariants

C-001: A `workspace_invited` notification delivers an in-app row only; it never sends an
email — the workspace invite email is the existing invite flow's responsibility and must
not be duplicated by the notification channel. (AS-001, AS-002)

C-002: The actor of a workspace action is never a recipient of its own notification
(the inviter, the joining member for their own join, the removing admin, the renamer).
  - scope: S-001, S-002, S-003, S-004
  - surfaces: invite, join, remove, rename
  - coverage: invite → AS-003, join → AS-004, remove → AS-005, rename → AS-007

C-003: A member removed from a workspace still receives the removal notification despite
no longer being a member; the membership-based recipient resolution must not exclude the
just-removed user. (AS-006)

C-004: Workspace notifications are best-effort and post-commit — a notification failure
never rolls back or fails the underlying invite / accept / remove / rename action.
This mirrors the existing notify seam (all current events fire post-commit, errors
swallowed); the remove surface is the representative coverage. (AS-008)

C-005: Multi-recipient fan-out (join → all admins, rename → all members) delivers exactly
one row per recipient per event, is batch-inserted (not one serial awaited insert per
recipient), and is NOT awaited on the request's critical path — a 500-member rename must
not hold the HTTP response. (AS-004, AS-007, GAP-003)

C-006: Any user-controlled workspace name carried into a notification row or an email is
treated as untrusted — CR/LF and control characters are stripped before any subject/body
interpolation and length is bounded; in-app rendering relies on the existing text-escaping
of `refLabel`. (AS-009)

## Linked Fields

- `workspace_invited / workspace_member_joined / workspace_member_removed / workspace_renamed`
  (notification types + their supported channels) — PRODUCED here (Data Model + the four
  stories). CONSUMED by `notification-preferences:S-002` (channel policy gates each type) and
  `notification-preferences:S-003` (the settings section renders a row per type). ✔ the four
  types are defined in this spec's Data Model; the consumer's seam test is
  `notification-preferences:AS-012`.
- **`invitationId`** (the invitation id, carried as `refId` on the `workspace_invited` row — persisted + served on every `GET /api/me/notifications` read) — PRODUCED here (S-001 / AS-010, Data Model `refId`). CONSUMED by `your-activity-inbox:S-005` (AS-016/AS-017) to call `POST /api/invitations/:id/accept|reject` from the inbox. ✔ surface (the persisted notification row, served on read) + lifecycle (durable, re-readable) match — resolves `your-activity-inbox:GAP-001`. Seam test: `your-activity-inbox`'s accept-from-inbox must reach the real invitation id and succeed.

## What Already Exists

### System Impact & Technical Risks

- **`notify/notify.ts`** — existing dispatch helpers + recipient-compute fns + `HIGH_SIGNAL_TYPES`
  + `EVENT_SUBJECT`/`EVENT_SUMMARY`. The recipe (recipient fn + `notifyOnWorkspace*` dispatch +
  map keys + `HIGH_SIGNAL_TYPES`) holds, BUT three concrete edits the spec must own and which
  are NOT free: (a) widen the `NotificationType` union in `notify/types.ts` AND add keys to the
  total `Record<NotificationType,string>` maps or `tsc` breaks (and a `?? "anchord notification"`
  fallback would otherwise ship placeholder copy for member-removed email — F3); (b) the deep-link
  builder is annotation-shaped (`getDocSlug(annotationId)` → `/d/{slug}#annotation-{id}`) and is
  useless for a workspace — a workspace deep-link builder is new (F3); (c) NO `listWorkspaceAdminIds`
  / `listWorkspaceMemberIds` recipient query exists — they are new repo ports (F2).
- **`notify/read-repo.ts`** — `listForUser` enriches by `refId → annotations → docs` only. Workspace
  rows render from the new `refLabel` snapshot column (NOT a live `workspaces` join — F1).
- **`db/schema.ts`** — `notification_type` pgEnum + `notifications` table. The enum migration uses
  `ADD VALUE IF NOT EXISTS` (idempotent, forward-only) and adds the `refLabel` column; irreversible,
  hence S-001 is a checkpoint. (PG17 + migration 0011 already did an additive `ADD VALUE` safely.)
- **Fire sites present but each needs real work** — `routes/workspaces.ts` (invite `:127`, accept
  `:155`, rename `:113`) and `routes/members.ts` (remove `:87`). NOT a no-op: each needs a recipient
  query + (for removal) a pre-delete snapshot of workspace name + recipient email (F1), so this is a
  new repo + dispatch, not pure wiring.
- **Risk — recipient filter + data lifetime for removal (C-003, F1).** A naive membership filter would
  drop the very person being notified; AND the workspace name / recipient email die with the membership
  row. The removal path must resolve recipient + snapshot the display name + email BEFORE the delete and
  pass them into the dispatch.
- **Existing `invited` (doc-share) event is unrelated** — `workspace_invited` is a new, distinct type;
  do not overload the doc-share `invited` value.

## Not in Scope

- **Per-user opt-out / channel toggles for these events** — owned by the sibling
  `notification-preferences` spec; until it ships, channel follows the hardcoded policy here.
- **Role-change notification** (`PATCH members/:userId` role) — not in the mockup's final
  list; deferred. Add later if needed.
- **Notifying a non-account invitee in-app** — impossible (no `userId` to attach a row to);
  the invite email already reaches them.
- **Workspace deletion notification** — out of the final list; deferred.

## Gaps

GAP-001 (status: resolved → AS-004 + Data Model): Default channel for
`workspace_member_joined` — resolved 2026-06-23 to in-app on, email OFF by default (opt-in via
`notification-preferences`), to avoid noise on busy workspaces. Source: mockup "Workspace
members joining".

GAP-002 (status: deferred — minimal-safe): Clicking a `workspace_member_removed` in-app row — the
target workspace is no longer accessible. The NAME-display half is now resolved (the row renders from
the `refLabel` snapshot, F1); only the click-landing behavior (graceful message vs no link) stays
deferred. Source: derived from S-003 + C-003. Minimal-safe: render `refLabel`, no working deep-link.

GAP-003 (status: open): The `notifications` table has no uniqueness/idempotency (only a
`(user_id, read)` index), so a retried request or double-accept duplicates rows for any event.
C-005 asserts exactly-one-per-recipient on the happy path but the dedup MECHANISM (a uniqueness key
vs an at-most-once guard at dispatch) is unstated. Source: derived from F8 (fan-out). Outcome to
decide at build; minimal-safe: accept rare duplicates in v0 (best-effort), revisit if observed.

GAP-004 (status: open): Each `workspace_invited` is now both an email (existing) and an in-app ping to
an arbitrary registered account; an abusive admin could spam. No rate-limit is specced on the invite
endpoint. Source: derived from F12 (security). Minimal-safe: rely on admin-only gating in v0; add a
per-workspace/admin invite rate-limit if abuse appears.

## Clarifications — 2026-06-23

- **Member-joined email default = OFF.** In-app on; email supported but off by default (admins
  opt in via `notification-preferences`). Avoids spamming admins on busy workspaces.
  (resolves GAP-001 → AS-004)

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-23 | Initial creation | -- |
| 2026-06-23 | /mf-challenge fixes: `refLabel` snapshot column + read path (F1); new recipient ports + corrected "no flow rewrite" (F2); expanded S-001 files — types union, total maps, HIGH_SIGNAL, workspace deep-link builder (F3); member-removed in-app locked-on (F6); C-005 fan-out batch/non-blocking + AS-009 untrusted-name + C-006 (F8/F9); idempotent enum migration (F10); GAP-003/GAP-004 added | mf-challenge |
| 2026-06-23 | Minor doc sync (post-build S3 signals): documented impl seams in Data Model — `sanitizeRefLabel` guard on all `refLabel` writes; notify-repo ports `getWorkspaceName`/`getUserName`/`findUserIdByEmail`; `buildWorkspaceDeepLink` + `emailDeepLinkOverride` + batch `insertNotifications`. No AS/constraint/flow change; Status Draft→Active | mf-build S3 |
| 2026-06-23 | Major (snapshot 2026-06-23-invitation-id.md) — `workspace_invited` `refId` now holds the INVITATION id (was workspace_id) so the For-you inbox can accept/decline directly; +AS-010 (row carries the invitation id, refLabel still the workspace name); +Linked Field `invitationId` → `your-activity-inbox:S-005` (resolves that spec's GAP-001). Other three workspace types keep refId=workspace_id. NOTE: feature is Active/built — the invite emit must be updated to write refId=invitation.id. | your-activity-inbox:GAP-001 |
