# Snapshot: notifications-email
**Date:** 2026-06-21
**Ref:** --
**Reason:** M1 (S-006 gains AS-026..029 — panel enrichment) + M6 (C-014 added; notifications += comment_id) — the in-app notification row carries doc title + actor + comment snippet instead of a bare per-type string.

---

# Spec: notifications-email

**Created:** 2026-06-20
**Last updated:** 2026-06-21
**Status:** Active
**Snapshot limit:** 5

## Overview

The shared notification + email layer for anchord. Domain events on annotations/docs and on
membership fan out, post-commit, to a relationship-derived recipient set over two channels: in-app
(always, the durable channel) and email (high-signal events only, per-event plain text in v0). It
also closes the in-app read surface — the bell dropdown, unread badge, and mark-read actions — and
gives emails an absolute deep-link via a new `APP_URL` config.

This spec **owns** the notify + email infrastructure that `workspace-project` carried as
S-006 / AS-011 / C-004 / GAP-002 (reply-only notify). Those move here and broaden: the reply case
folds into thread-activity, and five more event types join (new_feedback, suggestion_decided,
resolved, detached, invited). `workspace-project` owes a Mode C update
to retire S-006 and cross-reference this spec — do not duplicate the behaviour back there.

Scope is **Phase 1 (v0)** only. HTML email templates, email coalescing/digest, per-user
preferences, @mentions, and a durable mail queue are explicitly deferred (see Not in Scope).

## Data Model

- **notifications table [E]** (`apps/backend/src/db/schema.ts:405`): `id`, `userId`, `type`,
  `refId`, `read` (default false), `createdAt`. Index `notifications_user_read_idx` on
  `(userId, read)` backs unread queries. **No new column in v0** (`emailed_at` is Phase 2).
- **`notification_type` pgEnum [E]** (`schema.ts:403`, currently `["reply"]`): extended additively
  with `new_feedback`, `thread_activity`, `suggestion_decided`, `resolved`, `detached`, `invited`.
  (`invite_accepted` dropped from v0 — decided 2026-06-20, GAP-006.) The migration is additive —
  existing `reply` rows stay valid; no Postgres-only enum tricks (keep the SQLite door open).
  **Email eligibility is derived from `type`** (high-signal types email-eligible; low-signal in-app
  only) — not a stored column.
- **MailMessage shape [E→change]** (`apps/backend/src/auth/mail-queue.ts:14`): from
  `{ to, subject, body }` to `{ to, subject, text?, html? }`. v0 sets `text` only; the transport
  sends `text/plain`. (Today the transport sends `html: msg.body` — sending the body as HTML — so
  serving plain text is a real v0 change, not a no-op.) Phase 2 fills `html` keeping `text` as the
  multipart fallback → a pure drop-in.
- **New config `APP_URL`** in `apps/backend/src/config/env.ts`: a single absolute `http(s)://` base
  URL, Zod-validated at boot like `DATABASE_URL` (app refuses to start if absent/invalid). Used to
  build absolute deep-links in both notification email and invite accept-links (the latter are
  relative today — a latent bug this fixes as a byproduct).
- **Read API surface** is **session-scoped to the user, not workspace-scoped** — a notification is
  personal and spans workspaces. A user lists/marks only rows where `userId` is their own. The list
  is paginated (default page size 20, `limit` capped at 50, reusing the workspace-project pagination
  convention). Each list row also carries `slug` — the doc slug joined from the row's `refId`
  annotation — so the client builds the in-app deep-link `/d/{slug}#annotation-{refId}` without a
  second round-trip; `slug` is null when `refId` is not an annotation (e.g. an `invited` row) or the
  annotation/doc is gone, and the client then marks-read without navigating.

## Stories

### S-001: Notify on new feedback (P0)

**Description:** As a doc owner or editor, when someone creates a brand-new annotation on my doc, I
am notified in-app and by email — even before I have participated in any thread on it.
**Source:** docs/explore/notifications-email.md#event-catalog (New feedback row) + #role-matrix-b
("new feedback → owner + all editors") + #happy-path (steps 1–5).
**Applies Constraints:** C-001, C-002, C-003, C-005, C-006

**Execution:**
- `depends_on:` S-007
- `parallel_safe:` false
- `files:` `apps/backend/src/db/schema.ts` (extend `notification_type` enum + migration),
  `apps/backend/src/notify/notify.ts` (generalize `computeRecipients` + add a per-event dispatch +
  the access-filter stage), `apps/backend/src/routes/annotations.ts` (`createAnnotationHandler`,
  `docCreateAnnotationHandler` dispatch), reuses `resolveAccess` (doc-access-routing) for owner/editor candidates
- `autonomous:` checkpoint
- `verify:` a commenter creates a new annotation on a doc → the doc owner and every editor (minus the actor, minus anyone without current access) each get one in-app row and one email; the actor gets neither.

**Acceptance Scenarios:**

AS-001: New annotation notifies owner + editors, in-app and email, minus the actor
- **Given:** Alice owns a doc, Dan is an editor on it, Bob is a commenter
- **When:** Bob creates a brand-new annotation "this section is wrong"
- **Then:** Alice and Dan each get one in-app row (bell badge +1) and one email; Bob (the actor) is not notified
- **Data:** owner Alice, editor Dan, actor Bob (commenter)
- **Setup:** doc with one owner + one editor + one commenter; Bob holds an active session

AS-002: A candidate who lost doc access is dropped before any channel fires
- **Given:** the doc's editor Dan was removed from the doc, owner Alice still has access
- **When:** Bob creates a new annotation
- **Then:** Alice is notified (in-app + email); Dan gets no row and no email — the access-filter drops him at notify time
- **Data:** Dan: no current access; Alice: access
- **Setup:** Dan previously an editor, access revoked before the event

### S-002: Notify on thread activity (P0)

**Description:** As a thread participant or the doc owner, I am notified in-app and by email when a
comment or reply lands on an existing annotation. A brand-new annotation is *new feedback* (S-001),
not thread activity — this story fixes the trigger drift where a top-level comment fired the reply
path inconsistently.
**Source:** docs/explore/notifications-email.md#event-catalog (Thread activity row + "Trigger
definition (resolves the current drift)") + #role-matrix-b (thread activity → participants ∪ owner).
**Applies Constraints:** C-001, C-002, C-003, C-004, C-005

**Execution:**
- `depends_on:` S-001, S-007
- `parallel_safe:` false
- `files:` `apps/backend/src/notify/notify.ts` (fold reply baseline into a `thread_activity`
  dispatch; participants ∪ owner), `apps/backend/src/routes/annotations.ts` (`commentHandler`;
  retire the inline `dispatchReplyNotify` closure at ~line 453)
- `autonomous:` true
- `verify:` a reply on an existing annotation notifies the other participants + the owner (not the replier); a top-level comment on an existing annotation does the same (no longer the new-feedback path).

**Acceptance Scenarios:**

AS-003: A reply notifies the other participants and the owner, not the replier
- **Given:** an annotation thread with participants A and B; the doc owner is C
- **When:** A replies in the thread
- **Then:** B and C each get one in-app row and one email; A (the replier) is not notified
- **Data:** thread {A, B}, owner C, actor A
- **Setup:** existing annotation with two participants and a distinct owner

AS-004: A top-level comment on an existing annotation is thread activity, not new feedback
- **Given:** an existing annotation owned-context C with participant B; commenter D has not yet participated
- **When:** D posts a top-level comment on that existing annotation
- **Then:** the event raised is thread activity → B and C are notified (in-app + email); it is NOT routed as new feedback (owner + editors)
- **Data:** existing annotation, actor D (first comment), participant B, owner C
- **Setup:** annotation already exists with at least one prior participant

AS-005: Overlapping recipients collapse to one row per recipient
- **Given:** owner C is also a participant in the thread
- **When:** participant A replies
- **Then:** C receives exactly one in-app row (owner and participant relationships dedup), not two
- **Data:** C is both owner and participant
- **Setup:** owner has previously commented in the same thread

AS-023: A guest's comment notifies account-holders but never the guest
- **Given:** a guest (no account, name only) is commenting on a doc with link-role commenter; participant B and owner C hold accounts
- **When:** the guest posts a comment on an existing annotation
- **Then:** B and C are notified (thread activity); the guest gets no in-app row and no email (a guest is never a recipient — no account)
- **Data:** actor = guest (account-less), recipients B + C
- **Setup:** anyone-with-link doc whose link role is commenter; guest commenting without an account

### S-003: Notify on suggestion decided (P1)

**Description:** As the author of a suggestion/proposal, I am notified in-app and by email when the
owner accepts or rejects it.
**Source:** docs/explore/notifications-email.md#event-catalog (Suggestion decided row) +
#role-matrix-b (suggestion decided → the suggestion's author).
**Applies Constraints:** C-002, C-003, C-005

**Execution:**
- `depends_on:` S-001, S-007
- `parallel_safe:` false
- `files:` `apps/backend/src/notify/notify.ts` (suggestion_decided dispatch),
  `apps/backend/src/routes/annotations.ts` (`decideSuggestionHandler`)
- `autonomous:` true
- `verify:` an owner decides (accept/reject) a suggestion authored by someone else → the author gets one in-app row + one email; if the owner decides their own suggestion, no notify.

**Acceptance Scenarios:**

AS-006: Deciding a suggestion notifies its author
- **Given:** Bob (commenter) authored a suggestion; Alice (owner) reviews it
- **When:** Alice accepts the suggestion
- **Then:** Bob gets one in-app row and one email; Alice (the decider) is not notified
- **Data:** author Bob, decider Alice (owner)
- **Setup:** a pending suggestion authored by a non-owner

AS-007: An owner deciding their own suggestion notifies no one
- **Given:** Alice (owner) both authored and decides a suggestion
- **When:** Alice rejects it
- **Then:** no notification is raised (self-exclusion: the author is the actor)
- **Data:** author = decider = Alice

### S-004: Notify on resolution and detach (P1)

**Description:** As an annotation's creator, I get an in-app notice (no email) when my annotation is
resolved or reopened. As an annotation's author, I get a single grouped in-app notice when a
republish detaches my annotations from their anchor.
**Source:** docs/explore/notifications-email.md#event-catalog (Resolved/reopened + Detached rows) +
#unhappy-path-1 (resolve, in-app only) + #unhappy-path-2 (detached burst grouped per publish).
**Applies Constraints:** C-002, C-003, C-005, C-007

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/notify/notify.ts` (resolved + detached dispatch, in-app only),
  `apps/backend/src/routes/annotations.ts` (`resolutionHandler`, `docResolutionHandler`),
  `apps/backend/src/annotation/reanchor-job.ts` (`runReanchorForNewVersion` raises one detached
  notification per recipient per publish)
- `autonomous:` true
- `verify:` resolving an annotation gives its creator an in-app row and NO email; publishing a version that orphans 5 of one author's annotations gives that author ONE grouped in-app row, no email.

**Acceptance Scenarios:**

AS-008: Resolving an annotation notifies its creator in-app only
- **Given:** Bob created an annotation; Carol resolves it
- **When:** Carol resolves the annotation
- **Then:** Bob gets one in-app row and NO email; the bell does not auto-clear; clicking the row marks just that one read (reopen behaves identically — same event type, same creator recipient)
- **Data:** creator Bob, actor Carol
- **Setup:** an open annotation created by a non-actor

AS-009: A detach burst is one grouped in-app row per recipient per publish
- **Given:** Alice publishes a new version; 5 of Bob's annotations lose their anchor in that republish
- **When:** the reanchor job marks them orphaned
- **Then:** Bob gets ONE in-app row ("5 of your annotations were detached"), not 5; no email
- **Data:** one publish, 5 of Bob's annotations detached
- **Setup:** a doc version that orphans multiple annotations by the same author

### S-005: Notify the invitee on being added (P2)

**Description:** As an invitee, I get an in-app notice when I am added to a workspace/doc. (The
invite *email* already exists and is transactional — this adds the in-app row only.) Invite
*acceptance* raises no notification — decided 2026-06-20 (GAP-006): the inviter does not need a
ping when an invite is accepted.
**Source:** docs/explore/notifications-email.md#event-catalog (Invited row) +
#role-matrix-b (Invited → invitee).
**Applies Constraints:** C-005

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/notify/notify.ts` (invited dispatch, in-app only),
  the invite flow handler
- `autonomous:` true

**Acceptance Scenarios:**

AS-010: Being invited creates an in-app row for the invitee
- **Given:** Alice invites dev@acme.com, who has an account
- **When:** the invite is created
- **Then:** the invitee gets one in-app row (in-app only; the transactional invite email is separate)
- **Data:** invitee dev@acme.com

### S-006: In-app read surface — bell panel, unread count, mark read (P0)

**Description:** As a signed-in user, I open a bell dropdown showing my recent notifications with an
unread badge, click an item to deep-link to its doc/thread and mark just that item read, and clear
everything with "mark all read". I see only my own notifications.
**Source:** docs/explore/notifications-email.md#ui-expectation + #permissions ("read own only") +
#edge-cases (empty state, mark-read idempotency) + Phase 1 ("close the in-app read surface").
**Applies Constraints:** C-008, C-009, C-010

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` new `apps/backend/src/routes/notifications.ts` (list paginated, unread-count, mark-read,
  mark-all-read — user-scoped), `apps/backend/src/index.ts` (route registration),
  `apps/web/src/app/app-header.tsx` (`NotificationsBell` gains real data + badge),
  new `apps/web/src/features/notifications/` (panel, rows, query + unread-count polling)
- `autonomous:` true
- `verify:` signed-in user with mixed read/unread rows → the list returns their rows newest-first, one bounded page; the unread count matches; clicking an unread item flips only it; mark-all clears the badge; another user's rows are never returned.

**Acceptance Scenarios:**

AS-012: The list returns only the caller's notifications, newest first, one bounded page
- **Given:** Bob has 25 notifications; the page limit is 20; Carol has her own separate rows
- **When:** Bob lists notifications (first page)
- **Then:** the response carries Bob's 20 most-recent rows plus a summary of the total and whether more pages exist; none of Carol's rows appear
- **Data:** Bob: 25 rows, limit 20; Carol: unrelated rows
- **Setup:** two users each with their own notification rows

AS-013: Unread count reflects the caller's unread rows
- **Given:** Bob has 3 unread and 7 read rows
- **When:** Bob requests his unread count
- **Then:** the count is 3
- **Data:** 3 unread, 7 read

AS-014: Clicking an item marks only that item read
- **Given:** Bob has 3 unread rows; he opens the bell (the panel does not auto-clear)
- **When:** Bob clicks one unread row
- **Then:** that one row flips to read and the badge decrements to 2; the other two stay unread; the client deep-links to that row's doc/thread
- **Data:** click 1 of 3 unread

AS-015: Mark-all-read clears every unread row for the caller
- **Given:** Bob has 4 unread rows
- **When:** Bob clicks "mark all read"
- **Then:** all 4 flip to read and the unread badge disappears
- **Data:** 4 unread → 0

AS-016: Empty state shows "all caught up" and no badge
- **Given:** Bob has zero notifications
- **When:** Bob opens the bell
- **Then:** the panel shows "You're all caught up" and there is no unread badge
- **Data:** 0 rows

AS-017: A user cannot read or mark another user's notifications
- **Given:** Bob is signed in; a notification belongs to Carol
- **When:** Bob lists notifications, or attempts to mark Carol's row read
- **Then:** Carol's row never appears in Bob's list, and the mark attempt does not change it (not Bob's row)
- **Data:** target row owned by Carol
- **Setup:** Bob authenticated, row owned by another account

AS-018: Marking an already-read item, or mark-all with nothing unread, is a no-op
- **Given:** Bob's notifications are all already read
- **When:** Bob clicks an already-read row, then "mark all read"
- **Then:** both succeed with no change (idempotent no-op); read is monotonic to true
- **Data:** all rows already read

### S-007: Per-event plain-text email with deep-links and resilient delivery (P0)

**Description:** As a recipient of a high-signal notification, I get a plain-text email carrying an
absolute deep-link to the exact annotation, delivered through the existing in-memory mail queue with
a light backoff on retry; a transport failure dead-letters without affecting my in-app row or
failing the triggering action. Clicking the link lands me on the doc scrolled to that annotation.
Low-signal events send no email.
**Source:** docs/explore/notifications-email.md#email-delivery-model + #unhappy-path-4 (transport
fail) + #channel-policy + #input-validation (`APP_URL` absolute, Zod-validated at boot) +
#happy-path (step 5: "lands on the doc at that annotation").
**Applies Constraints:** C-006, C-007, C-011, C-012, C-013

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/backend/src/config/env.ts` (add `APP_URL`, Zod-validated),
  `apps/backend/src/auth/mail-queue.ts` (`MailMessage` → `{to, subject, text?, html?}`; add light
  backoff in `deliverWithRetry`), `apps/backend/src/auth/mail-transport.ts` (send `text/plain` when
  only `text` is set; build invite accept-links with `APP_URL`),
  `apps/backend/src/notify/notify.ts` (email-eligibility by type + build deep-link from `APP_URL`),
  `apps/web/src/features/viewer/components/viewer-screen.tsx` (mount-time `useEffect` reads the
  `#annotation-:id` fragment and calls the existing `focusThread`/`scrollToAnno` —
  `annotation-marks.tsx` already renders `data-anno="{id}"`)
- `autonomous:` true
- `verify:` a high-signal event sends one plain-text email whose body contains the absolute `APP_URL`-based deep-link to the annotation; a forced transport error retries with delay then dead-letters while the in-app row persists and the action still succeeds; a low-signal event sends no email; booting without a valid `APP_URL` fails fast; opening a doc URL with an `#annotation-:id` fragment scrolls to and highlights that annotation.

**Acceptance Scenarios:**

AS-019: A high-signal event sends one plain-text email with an absolute deep-link
- **Given:** `APP_URL` is configured; a new-feedback event fires for recipient Alice on doc slug `spec-v2` for annotation `abc123`
- **When:** the email is delivered
- **Then:** Alice receives one plain-text (not HTML) email whose body contains the absolute deep-link `https://anchord.example.com/d/spec-v2#annotation-abc123` (route `/d/:slug` + annotation fragment, built from `APP_URL`)
- **Data:** APP_URL = `https://anchord.example.com`, slug `spec-v2`, annotation `abc123`, event = new_feedback
- **Setup:** mail transport stubbed to capture the delivered message

AS-020: A transport failure backs off, dead-letters, and never breaks the in-app row or the action
- **Given:** the mail transport returns a transient error
- **When:** the notification email is delivered
- **Then:** delivery retries once after ~5 seconds (2 attempts total), dead-letters after the second failure, the recipient's in-app row remains intact, and the triggering action never fails
- **Data:** transport throws on every attempt; 2 attempts, ~5s apart
- **Setup:** transport stub that always errors

AS-021: A low-signal event sends no email
- **Given:** a `resolved` event fires for the annotation creator
- **When:** notify dispatches
- **Then:** an in-app row is written and NO email is enqueued (email eligibility derived from the notification type)
- **Data:** event = resolved (low-signal)

AS-022: Booting without a valid APP_URL fails fast
- **Given:** `APP_URL` is unset or not an absolute `http(s)://` URL
- **When:** the backend starts
- **Then:** boot fails with a config error (validated at boot like `DATABASE_URL`); the app does not start
- **Data:** APP_URL missing / `"notaurl"`

AS-024: Opening a doc URL with an annotation fragment scrolls to that annotation
- **Given:** the viewer is opened at `/d/spec-v2#annotation-abc123` and the doc renders a mark for annotation `abc123`
- **When:** the viewer mounts
- **Then:** it reads the fragment and scrolls to + highlights annotation `abc123` (reusing the in-app focus path); with no fragment, the viewer opens normally with nothing focused
- **Data:** fragment `#annotation-abc123`, a rendered `data-anno="abc123"` mark
- **Setup:** a published doc with annotation `abc123` anchored in its content

AS-025: A high-signal email whose doc slug cannot be resolved still sends, without the deep-link line
- **Given:** `APP_URL` is configured and a high-signal event fires, but the annotation's doc slug cannot be resolved (the doc was removed, or the ref is not an annotation)
- **When:** the email is delivered
- **Then:** the recipient still receives one plain-text email carrying the event summary, with the deep-link line OMITTED (the mail is never dropped and never crashes for a missing slug)
- **Data:** APP_URL set, slug unresolved for the event's ref
- **Setup:** mail transport stubbed to capture the delivered message

## Constraints & Invariants

The recipient pipeline below runs in a **single shared dispatch path** (`notify/notify.ts`,
generalized from today's `notifyOnReply`/`computeRecipients`) that every event surface calls — it is
not re-implemented per route. So these are covered representatively (ordinary constraints), not by a
per-surface multiplier: one shared function, verified once at a representative surface, plus the
happy-path coverage each event story already carries.

- C-001: Recipients are **relationship-derived candidates** (owner / editor / participant / author,
  per event), computed server-side; the client never selects recipients. (AS-001, AS-003)
- C-002: **Self-exclusion** — the actor is never notified of their own action, at every event.
  (AS-001, AS-003, AS-007)
- C-003: **Access-filter at notify time** — a candidate without current doc access is dropped before
  any channel fires (no in-app row, no email). (AS-002)
- C-004: **Thread-activity trigger definition** — a brand-new annotation is `new_feedback`
  (owner + editors); a comment/reply on an *existing* annotation is `thread_activity`
  (participants ∪ owner). This folds the top-level-comment case (which drifted onto the reply path)
  cleanly into thread activity. (AS-001, AS-003, AS-004)
- C-005: **Dedup** — overlapping recipients (e.g. owner who is also a participant/editor) collapse
  to exactly one in-app row per recipient per event. (AS-005)
- C-006: **Channel policy by signal** — high-signal events (new_feedback, thread_activity,
  suggestion_decided) send email + in-app; low-signal events (resolved, detached, invited) send
  in-app only. Email eligibility is derived from the notification `type`.
  (AS-001, AS-008, AS-019, AS-021)
- C-007: **Best-effort, post-commit** — notify runs after the triggering action persists and never
  throws; a failing repo or mail path is logged and swallowed, never turning the action into an
  error. (AS-009, AS-020)
- C-008: **Read own only** — a user lists and marks only notifications where `userId` is their own;
  the surface is session-scoped and cross-workspace (a notification is personal). (AS-012, AS-017)
- C-009: **Mark-read on click, not on open** — opening the bell does not clear unread; clicking an
  item marks only that item read. (AS-014)
- C-010: **Mark-read idempotency** — marking an already-read item, or mark-all with nothing unread,
  is a no-op; `read` is monotonic to true (last-write-wins, no conflict). (AS-018)
- C-011: **Guest handling** — a guest (no account) is never a recipient (no in-app row, no email),
  but a guest's action still notifies account-holders. (AS-023)
- C-012: **Email carries minimal content** — subject + a short text body + the deep-link; the doc
  body is never embedded in email (personal-data minimization). (AS-019, GAP-004)
- C-013: **Deep-link anchor** — the email link is `{APP_URL}/d/{slug}#annotation-{id}`; the viewer
  reads the `#annotation-:id` fragment on mount and scrolls to + highlights that annotation, reusing
  the existing in-app focus path (`focusThread`/`scrollToAnno`, `data-anno` marks). When the slug
  cannot be resolved, the deep-link line is omitted but the email still sends (AS-025).
  (AS-019, AS-024, AS-025)

## Linked Fields

This spec consumes contracts produced by sibling specs to compute recipients and build deep-links.
Each is a real seam (the running access resolver / participant set / viewer anchor must be hit, not
mocked) — flagged for `/mf-build` to integration-test, not stub.

- **doc access (owner + editors + `resolveAccess`)** — produced by `doc-access-routing` /
  `sharing-permissions`. Consumed HERE by S-001 (owner+editor candidates) and by C-003's
  access-filter on every event (AS-001, AS-002). Seam: the access-filter must call the real
  resolver; AS-002 is the seam integration AS (real access revocation drops the candidate).
  ✔ surface + lifecycle match (access checked live at notify time).
- **thread participants** — produced by `annotation-core` (the thread/comment model). Consumed HERE
  by S-002 (participants ∪ owner, AS-003). Seam: participant set read from the real thread.
  ✔ match. (This supersedes `workspace-project`'s "thread participants + doc owner → S-006" pin.)
- **viewer deep-link anchor** — the viewer route `/d/:slug` and the `data-anno="{id}"` marks +
  `scrollToAnno`/`focusThread` focus path already exist (`viewer-screen.tsx`,
  `annotation-marks.tsx`); only a mount-time fragment reader was missing. S-007 adds that reader and
  builds the matching link, so producer and consumer are both in this spec (AS-019 builds the link,
  AS-024 honors the fragment). ✔ surface + lifecycle match (audited 2026-06-20, GAP-001 resolved).
  Note: the route is `/d/:slug` only — there is no `/v/:id` version route, so deep-links omit it.

## UI Notes

From docs/explore/notifications-email.md#ui-sketch. Component names only; structural reference (AS
win on conflict). Accent = deep teal per DESIGN.md (the unread pill), never purple/orange.

- `AppHeader` *(existing — `app-header.tsx`)*
  - `NotificationsBell` *(existing placeholder, reuse — gains real data + the unread pill)*
    - `UnreadBadge` `[N]` *(teal pill; hidden when count is 0; cap display per GAP-003)*
    - `NotificationPanel` `[N]` *(dropdown, opens on click)*
      - `PanelHeader`: "Notifications" · `MarkAllReadButton` `[N]`
      - `NotificationList` `[N]` → `NotificationRow` `[N]`: unread dot · summary text · relative time · deep-links + marks read on click
      - `EmptyState` `[N]` *("You're all caught up", shown when no rows)*
      - *(recent N rows; no infinite scroll in v0)*

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| `AppHeader` | `apps/web/src/app/app-header.tsx` | reuse as-is; hosts the bell |
| `NotificationsBell` | `apps/web/src/app/app-header.tsx:244` | reuse the placeholder shell; wire real data + unread pill + dropdown panel (GAP-003 in code resolved by S-006) |

### System Impact & Technical Risks

- **notify infra [E partial]** `apps/backend/src/notify/notify.ts` — `notifyOnReply` +
  `computeRecipients`, best-effort/post-commit, `type` hardcoded `"reply"`. Generalize into a
  per-event dispatch + add the access-filter stage. The current reply notify is fired by an inline
  `dispatchReplyNotify` closure in `annotations.ts:~453` — retire it into the shared path.
- **mail queue [E]** `apps/backend/src/auth/mail-queue.ts` — in-memory, enqueue + retry +
  dead-letter + status. Reuse as-is. One fix: `deliverWithRetry` retries in a **tight loop with no
  delay** (retry is cosmetic — a transient error dead-letters instantly); add a light backoff. No
  Redis, no DB-backed queue (in-app row is the durable channel; restart-loss of queued mail is an
  accepted v0 trade-off).
- **mail transport [E]** `apps/backend/src/auth/mail-transport.ts` — currently sends `html: msg.body`
  (body as HTML) and embeds invite accept-links as-passed (relative today). Change to send
  `text/plain` for the `text`-only v0 message and build accept-links from `APP_URL`.
- **config [E]** `apps/backend/src/config/env.ts` — Zod-validated at boot; no `APP_URL` today. Add it.
- **annotation routes [E]** `apps/backend/src/routes/annotations.ts` — `createAnnotationHandler`,
  `docCreateAnnotationHandler`, `commentHandler`, `resolutionHandler`, `decideSuggestionHandler`,
  `docResolutionHandler` all present. **Behavior-change risk on a hot, well-tested route**:
  re-defining the comment/reply trigger + adding the access-filter must keep existing reply-notify
  tests green under the new taxonomy — careful regression coverage required.
- **reanchor job [E]** `apps/backend/src/annotation/reanchor-job.ts` — `runReanchorForNewVersion`
  marks detached annotations `is_orphaned`, fires off the publish path (async). Hook the grouped
  detached notification here.
- **workspace-project spec [E]** — owns the reply-only notify (S-006/AS-011/C-004/GAP-002). This
  spec supersedes it; `workspace-project` owes a Mode C update to retire S-006 and cross-reference.

## Not in Scope

- **HTML email template** — designed frame + email-safe primitives, dark-aware, branded teal.
  Phase 2 fills the `html` half of the `{text?, html?}` contract (pure drop-in). v0 ships `text`.
- **Email coalescing / digest** — group a recipient's high-signal events over a ~30-min window.
  Phase 2; the provider-cap forcing function is gone (operator on own SMTP), remaining value is
  inbox-noise polish. Keeps the locked GAP-002 ("one email per event") intact.
- **Per-user notification preferences / per-event opt-out** — Phase 2; gates the hardcoded channel
  policy. v0 ships the event-type taxonomy so Phase 2 can attach preferences.
- **@mentions** — no parsing/storage exists; new Phase 2 feature.
- **Real-time push (WebSocket)** — v0 polls unread-count (interval per GAP-003); no live socket.
- **Standalone `/notifications` page** — bell dropdown only in v0.
- **Operator mail dead-letter dashboard** — data exists (`statusCounts()`/`deadLetters()`); no UI/route in v0.
- **Durable mail queue backing** — queue is in-memory; Phase 2 only if a real need shows up.
- **Notifying guests** — excluded (no account); a guest who left an email is a Phase 2 candidate.
- **Notification retention/pruning** — table grows unbounded in v0; Phase 2.

## Gaps

- GAP-001 (status: resolved → C-013, AS-019, AS-024): viewer deep-link fragment — **audited
  2026-06-20**: route is `/d/:slug` (no `/v/:id`); marks render `data-anno="{id}"` and
  `scrollToAnno`/`focusThread` exist but only fire in-app, with no mount-time fragment reader.
  Resolved to **add the ~20-line reader in v0** (S-007 files) and use format
  `{APP_URL}/d/{slug}#annotation-{id}` — deep-link lands on the exact annotation, not just the doc.
  Source: "does the viewer support `#annotation-:id` today, or does it need a new anchor target?".
- GAP-002 (status: resolved): owner-also-on-detach — decided 2026-06-20 to **keep recipients =
  affected annotation authors only** (the owner is not notified for others' detached annotations).
  Matrix B gap #5 closed in favour of higher signal. Source: "Should the owner also be notified on
  detach …".
- GAP-003 (status: resolved → build decision 2026-06-21): unread-**badge cap** = "9+" (counts > 9
  display as "9+"); unread-count **poll interval** = 45s (client `refetchInterval`). Build-time UI
  detail, not behaviour-shaping — the testable count/empty behaviour stays AS-013/AS-016. Source:
  "Unread-badge cap in the UI ('9+'?) and poll interval".
- GAP-004 (status: resolved → build decision 2026-06-21): per-event plain-text **body wording** —
  sensible one-liners chosen per event type at build time (kept consistent between the email and the
  in-app summary). The testable contract (plain text + absolute deep-link) stays AS-019; the exact
  copy is tweakable without behaviour change. Source: "Plain-text email body shape — one-liner per
  event type …".
- GAP-005 (status: resolved → AS-020): backoff for `deliverWithRetry` — decided 2026-06-20 to
  **2 attempts, ~5s apart** (one retry after ~5s, then dead-letter). Source: "a light backoff …
  /mf-plan to confirm the exact attempts/delay".
- GAP-006 (status: resolved): `invite_accepted` — decided 2026-06-20 to **drop it from v0** (accept
  raises no notification and no email). S-005 keeps only the `invited`→invitee row; the
  `invite_accepted` enum value is not added. Source: "Whether `invite_accepted` … is worth v0 or
  trivially deferrable".

## Spec Sizing Notes

Stories=7 (target 7, at soft target). AS=24 (target 20, 4 over — in G7 overage range ≤30).

The over-target AS come from G1 splits (one stated atom each, not bloat):
- S-002 thread activity: 4 AS for 4 atoms — reply happy (AS-003), the top-level-comment drift-fix as
  a distinct trigger (AS-004), the dedup atom (AS-005), and guest-action notifies account-holders
  (AS-023, covering C-011). The drift-fix is the whole reason this story exists; it cannot fold into
  the reply AS.
- S-006 read surface: 7 AS for 7 distinct endpoints/rules — list (AS-012), unread-count (AS-013),
  mark-one-on-click (AS-014), mark-all (AS-015), empty state (AS-016), read-own-only permission
  (AS-017), idempotency (AS-018). Each is a separate user-facing surface; merging any two would mix
  intents.
- S-007 email delivery: 6 AS for 6 atoms — email-sent-with-deep-link (AS-019), transport-fail
  backoff/dead-letter (AS-020), low-signal-no-email channel policy (AS-021), boot config validation
  (AS-022), viewer honours the deep-link fragment (AS-024), slug-unresolvable email-still-sends edge
  (AS-025). The email and the viewer halves are one vertical slice (build the link + scroll to it),
  kept whole to avoid orphaning the deep-link seam.

(AS-011 was the dropped `invite_accepted` scenario — GAP-006; its ID is retired, not reused.
AS-025 is the latest sequential ID.)

No bloat — each AS traces to one stated atom.

## Clarifications — 2026-06-18

Decisions carried from the explore doc (the "why", so Phase 3 / Mode C does not re-ask):

- **New feedback → owner + all editors** (not owner-only) — anchord has explicit editor roles; a
  co-editor should learn of new feedback without participating first. Costs a doc-role query per event.
- **Access-filter at notify time, across all events** — recipients are relationship-derived
  candidates filtered to those who currently hold access; cleaner than letting rows dangle to a 404.
- **No coalescing in v0; email is per-event plain text** (reversed an earlier "pull into v0" call,
  2026-06-18) — coalescing was only attractive to dodge a provider daily cap; with the operator on
  their own SMTP the cap is not the forcing function. This **keeps the locked GAP-002 intact** (one
  email per event) — no CLAUDE.md reversal needed. Remaining value (inbox-noise) is Phase-2 polish.
- **v0 mail queue = the existing in-memory one** + a light backoff on retry; no Redis, no DB queue.
  The in-app row is the durable channel, so restart-loss of queued mail is acceptable.
- **`MailMessage` carries `text?`/`html?` from v0** even though v0 only fills `text` — the Phase-2
  HTML template is then a pure drop-in, no queue/transport surgery.
- **High/low-signal channel split** — without per-user preferences yet, keeps email signal high
  (resolve/detach/membership are FYI → in-app only).
- **Mark-read on click (not auto-on-open)** — preserves "what have I not looked at yet" context.
- **Own email infra + notifications in one spec** — they share the MailQueue/transport and the
  `APP_URL` requirement; auth-verify and invite are *consumers* of that infra.

## Clarifications — 2026-06-20

Phase-3 decisions resolving the open gaps:

- **Deep-link to the exact annotation in v0** (GAP-001) — audited the viewer: `/d/:slug` route,
  `data-anno="{id}"` marks, and `scrollToAnno`/`focusThread` already exist; only a mount-time
  fragment reader is missing (~20 lines). Added to v0 (S-007). Link format
  `{APP_URL}/d/{slug}#annotation-{id}`. (No `/v/:id` route exists — deep-links omit version.)
- **Detach notifies affected authors only** (GAP-002) — the owner is not pinged for others'
  detached annotations. Higher signal over completeness.
- **Mail backoff = 2 attempts, ~5s apart** (GAP-005) — one retry after ~5s, then dead-letter.
- **Drop `invite_accepted` from v0** (GAP-006) — accept raises no notification and no email; S-005
  keeps only the `invited`→invitee in-app row; the enum value is not added.

## Clarifications — 2026-06-21

Decisions captured from the build (so a future Mode C / build does not re-derive them):

- **S-005 `invited` fires on the doc-invite path only.** A workspace invite is always a token-based
  PENDING invitation (no account-holder is bound to a `userId` at invite time — membership lands only
  on acceptance), so there is no in-app channel target for it in v0. The `invited` in-app row is
  raised only on the doc-invite **account-exists** path (`inviteByEmail` when the email already has an
  account). The story's "added to a workspace/doc" phrasing is aspirational; v0 has no workspace-invite
  in-app surface. Not a gap — the workspace model has no account-holder-add moment to hang a row on.
- **In-app deep-link uses a `slug` carried on each list row** (Data Model + AS-025/C-013): the client
  navigates to the relative route `/d/{slug}#annotation-{refId}`; the viewer's mount-time fragment
  reader (AS-024) then scrolls + highlights. Verified end-to-end live 2026-06-21.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-20 | Initial creation (from docs/explore/notifications-email.md) | -- |
| 2026-06-20 | Phase-3 clarifications: GAP-001 resolved → deep-link `/d/{slug}#annotation-{id}` in v0 (+ C-013, AS-024, viewer fragment reader in S-007); GAP-002 resolved → detach notifies affected authors only; GAP-005 resolved → backoff 2 attempts/~5s (AS-020); GAP-006 resolved → drop `invite_accepted` (removed AS-011, trimmed S-005, enum value not added) | -- |
| 2026-06-21 | Post-build sync (Major, M1, snapshot 2026-06-21): + AS-025 under S-007 (slug-unresolvable → email sends summary-only, deep-link omitted; codifies the build S3 guard, refines C-013); Data Model Read-API row gains `slug` (S-006 join for the in-app deep-link); GAP-003 resolved → badge "9+" / 45s poll; GAP-004 resolved → per-event one-liners; Clarifications 2026-06-21 (S-005 `invited` doc-invite-path only; deep-link slug). Status Draft→Active. Built + E2E-verified 2026-06-21. | -- |
