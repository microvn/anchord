# Spec: Notification Preferences

**Created:** 2026-06-23
**Last updated:** 2026-06-24
**Status:** Draft
**Snapshot limit:** 5

## Overview

Gives each user control over how anchord notifies them: per-event, per-channel toggles
plus a master email switch, surfaced in Settings → Notifications (the reserved slot from
`account-settings` AS-012, currently a coming-soon stub). Realizes the "Per-user
notification preferences / per-event opt-out" that `notifications-email` deferred to Phase 2.

Ships AFTER `workspace-notifications` — the toggle list and the channel policy here enumerate
the full notification taxonomy, including the four workspace event types that spec produces.
Defaults are fully on, so behavior is unchanged until a user opts out.

## Data Model

- **`notification_preferences` (NEW table)** — `userId` → user, `type` (`notification_type`
  enum), `channel` (`in_app` | `email`), `enabled` (boolean). Unique on
  (`userId`, `type`, `channel`). A row is an OVERRIDE; absence means the default. Only changed
  toggles are stored. A write for an unsupported OR locked (type, channel) pair is rejected at
  the API — so a `{detached, in_app, false}` row can never exist (F7).
- **Default semantics for types added LATER (F11):** absence-means-default cannot tell "new
  user" from "type added after I curated my prefs". A notification type added in a future
  release defaults ON for existing users per its matrix row — including email if the matrix
  marks it email-on. This is the INTENDED v0 behavior (no per-user baseline version); stated
  explicitly so a future email-on type emailing already-curated users is a known decision, not
  a surprise.
- **Master email switch** — a single per-user boolean (modeled as one preference row with a
  reserved `email`-master key, or a dedicated column). When off it suppresses all email
  regardless of per-event email rows. It does NOT touch in-app; in particular the locked
  in-app notices (`detached`, `workspace_member_removed`) still deliver, so "you were removed"
  is never fully silenceable (F6).
- **Supported-channel matrix per event (the default-on set)** — defines which channels each
  event offers and which are on by default. The doc-share `invited` event is in-app only — it
  already has its OWN transactional invite email, so the notification channel never emails for it
  (a notification email would duplicate the invite mail):

  | Event | In-app | Email | Notes |
  |---|---|---|---|
  | new_feedback | on | on | |
  | thread_activity | on | on | |
  | suggestion_decided | on | on | |
  | invited (doc shared with you) | on | — | no email channel — the transactional invite email is separate |
  | resolved | on | — | no email channel |
  | detached | on (locked) | — | always-on in-app, no toggle |
  | workspace_member_joined | on | **off** | email supported but off by default (opt-in); from `workspace-notifications` |
  | workspace_member_removed | on (locked) | on | in-app locked-on (critical — you lost access); email togglable; from `workspace-notifications` |
  | workspace_invited | on | — | email is the existing invite mail |
  | workspace_renamed | on | — | no email channel |

  Daily email digest is a UI row only — not a real notification type, not delivered in v0.

## Stories

### S-001: Notification choices default to on and persist (P0)

**Description:** As a user, my notification preferences start fully on and persist when I
change them, so anchord behaves predictably until I deliberately opt out.
**Source:** Mockup header "Defaults are on"; `notifications-email` Not-in-Scope
("Per-user notification preferences / per-event opt-out — Phase 2").
**Applies Constraints:** C-005

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` apps/backend/src/db/schema.ts (new table + migration), apps/backend/src/routes/notifications.ts (preferences read/write, `/api/me`-scoped), apps/backend/src/notify/notify.ts
- `autonomous:` checkpoint
- `verify:` a fresh user reads all preferences as on; turning off one channel persists across a re-read; an unsupported OR locked (event,channel) change is refused; one user cannot read or write another user's preferences.

**Acceptance Scenarios:**

AS-001: A user who never changed anything reads every preference at its documented default
- **Given:** a fresh user with no stored preferences
- **When:** they read their notification preferences
- **Then:** every (event, channel) reads at the supported-channel matrix default — in-app on for every event, email on for the high-signal personal events, and email OFF for member-joined (the one default-off channel)
- **Data:** new user, empty preference set

AS-002: A changed preference persists across sessions
- **Given:** a user turns off email for new-feedback
- **When:** they re-read their preferences in a later session
- **Then:** new-feedback email reads as off and every other preference stays on
- **Data:** override {new_feedback, email, off}

AS-003: A change for a channel the event does not support is refused
- **Given:** the detached event supports in-app only (no email channel)
- **When:** the user tries to set detached email to on
- **Then:** the change is refused with an "unsupported channel" reason and no preference row is stored
- **Data:** rejected {detached, email}

AS-014: One user cannot read or write another user's preferences
- **Given:** users Alice and Bob, both signed in
- **When:** Alice calls the preferences API attempting to read or change Bob's preferences
- **Then:** the API only ever reads/writes the caller's own preferences (scoped server-side to the session user); Alice cannot affect Bob's rows
- **Data:** actor Alice, target Bob

AS-015: A write to a locked (type, channel) pair is refused
- **Given:** `detached` in-app and `workspace_member_removed` in-app are locked-on
- **When:** the user tries to store a row disabling either locked in-app channel
- **Then:** the write is refused and no override row is stored — the lock cannot be bypassed via the API
- **Data:** rejected {detached, in_app, off}

### S-002: Email and in-app delivery honor my preferences (P0)

**Description:** As a user, turning a channel off stops that delivery while leaving the other
channel intact; the master email switch silences all email; critical in-app notices cannot
be turned off.
**Source:** Final notification list (channel matrix + locked detached, conversation 2026-06-23);
mockup.
**Applies Constraints:** C-001, C-002, C-003, C-006

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/notify/notify.ts (channel policy reads preferences — batched once per dispatch, fail-closed on email)
- `autonomous:` true

**Acceptance Scenarios:**

AS-004: Turning off email for an event still delivers it in-app
- **Given:** a user turned off email for new-feedback
- **When:** new feedback fires for them
- **Then:** they get the in-app bell row and no email
- **Data:** override {new_feedback, email, off}

AS-013: A preferences-read failure fails CLOSED for email, open for in-app
- **Given:** a user who turned email OFF for new-feedback, and the preferences read errors transiently when the event fires
- **When:** new feedback fires for them
- **Then:** no email is sent (email fails closed — never re-send a silenced email) and the in-app row is still delivered (in-app fails open)
- **Data:** override {new_feedback, email, off}; prefs read throws

AS-005: The master email switch silences all email but keeps in-app
- **Given:** a user turns the master email switch off
- **When:** any email-eligible event fires for them
- **Then:** no email is sent for any event, and the in-app rows still appear
- **Data:** master email = off

AS-006: Documents shared with you creates an in-app row only (no notification email)
- **Given:** a user with default (unchanged) preferences
- **When:** a document is shared with them
- **Then:** they receive one in-app row and NO notification email (the doc-share `invited` event is in-app only — the transactional invite email is a separate channel; the notification channel never emails for it)
- **Data:** default preferences, event = invited (doc share)

AS-007: A critical in-app notice cannot be turned off
- **Given:** the detached event is always-on for in-app
- **When:** the next republish detaches the user's annotations
- **Then:** the detached in-app row is delivered regardless of any stored preference
- **Data:** detached event, any preference state

### S-003: Notifications settings section (P1)

**Description:** As a user, I open Settings → Notifications and toggle in-app and email per
event, grouped sensibly, with critical notices locked on and a daily-digest row shown as
coming later.
**Source:** Product mockup (conversation 2026-06-23); `account-settings` reserved
"Notifications" slot (AS-012 coming-soon) + its `registerSettingsSection` contract.
**Applies Constraints:** C-002, C-004

**Execution:**
- `depends_on:` S-001, S-002
- `parallel_safe:` false
- `files:` apps/web/src/features/notifications/components/ (settings section), apps/web/src/features/notifications/services/client.ts, apps/web/src/features/settings/lib/section-registry.ts (register over the reserved slot)
- `autonomous:` true
- `verify:` Settings → Notifications shows grouped per-event rows reflecting saved prefs; toggling a switch persists across reload; detached is locked; the digest row is disabled/email-only.

**Acceptance Scenarios:**

AS-008: The section reflects saved preferences per event
- **Given:** a user who turned off new-feedback email
- **When:** they open Settings → Notifications
- **Then:** new-feedback shows in-app on and email off, every other event shows its channels on
- **Data:** override {new_feedback, email, off}

AS-009: Toggling a switch saves and survives reload
- **Given:** the Notifications section is open
- **When:** the user turns off email for thread-activity
- **Then:** the change persists and re-opening the section shows thread-activity email off
- **Data:** toggle {thread_activity, email}

AS-010: Critical and unsupported toggles are locked
- **Given:** the Notifications section is open
- **When:** the user views the detached row and the workspace-member-removed row
- **Then:** detached shows its in-app toggle locked on with no email toggle; workspace-member-removed shows its in-app toggle locked on with the email toggle still available
- **Data:** detached + workspace_member_removed events

AS-011: The daily-digest row is shown disabled, email-only, off
- **Given:** the Notifications section is open
- **When:** the user views the daily-digest row
- **Then:** it is presented as email-only, off, and not yet active (deferred), and changing other preferences does not enable it
- **Data:** digest row

AS-012: The section's event rows match the live notification taxonomy (seam)
- **Given:** the full notification taxonomy is in place (the `workspace_*` types from `workspace-notifications` plus the existing types), built and running as a real integration (not a hardcoded list)
- **When:** the Notifications section renders
- **Then:** there is exactly one row per firing event type with its supported channels, and no row for a type that does not fire
- **Data:** live taxonomy = existing 7 types + 4 workspace types

## Constraints & Invariants

C-001: The master email switch, when off, suppresses every notification email regardless of
per-event email preferences; in-app delivery is unaffected. (AS-005)

C-002: Critical in-app notices (`detached` and `workspace_member_removed`) are always-on for
in-app and cannot be disabled by any preference. The lock is enforced at DELIVERY (a hardcoded
always-deliver set consulted before reading any stored row — a stray `{type, in_app, false}`
row cannot win) AND at the WRITE API (such a row is refused, AS-015), not in the UI alone.
(AS-007, AS-010, AS-015)

C-003: Default preferences follow the supported-channel matrix in Data Model — in-app on for
every event and email on for the high-signal personal events; the doc-share `invited` event is
in-app only (no email channel — its transactional invite email is separate), and
`workspace_member_joined` email is the one channel OFF by default (opt-in). (AS-001, AS-006)

C-004: The daily email digest is presented in the Settings UI but is not delivered in v0
(deferred); toggling any other preference never triggers a digest. (AS-011)

C-005: Notification preferences are read and written ONLY for the caller — the user id is
derived server-side from the session, never taken from the request body or path. One user can
never read or mutate another user's preferences. (AS-014)

C-006: When the per-recipient preferences read fails, EMAIL fails closed (the email is skipped
and logged — a transient error must never re-send something a user silenced) while IN-APP fails
open (the durable bell row is still written). The read is batched once per dispatch, not once
per recipient. (AS-013)

## Linked Fields

- `notification taxonomy + per-event supported-channel set` — consumed by
  `notification-preferences:S-002` (channel policy gates email/in-app per type) and
  `notification-preferences:S-003` (the settings section renders one row per event with its
  supported channels). Produced by `workspace-notifications` (the four `workspace_*` types)
  and `notifications-email` (the existing seven types). ✔ match once `workspace-notifications`
  is merged. **Seam integration AS:** AS-012 — built as a real integration (live taxonomy,
  not a hardcoded list).

## UI Notes

- `NotificationsSettingsSection` *(registered over the reserved `notifications` slot, clearing its coming-soon stub)*
  - `NotificationPrefGroup: Comments & feedback`
    - `NotificationPrefRow` per event: label + description + `In-app` toggle + `Email` toggle *(detached + resolved + invited rows: in-app only, no email toggle — detached's in-app is locked on)*
  - `NotificationPrefGroup: Workspace`
    - `NotificationPrefRow` per workspace event *(workspace_invited & workspace_renamed: in-app only, no email toggle)*
  - `NotificationPrefGroup: Email digest`
    - `DigestPrefRow` *(email-only, disabled, off — deferred)*

> Source-of-truth: product mockup (ASCII, conversation 2026-06-23) — canonical on conflict for grouping/labels. AS win over the tree on any behavioral conflict.

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| Settings section registry | `apps/web/src/features/settings/lib/section-registry.ts` | reuse `registerSettingsSection` to claim the `notifications` slot |
| `ComingSoonSection` (current Notifications stub) | `apps/web/src/features/settings/components/coming-soon-section.tsx` | replaced by the real section on registration |
| `DeveloperSection` (pattern reference) | `apps/web/src/features/settings/components/developer-section.tsx` | template for a sibling-owned section with React Query reads/writes |
| Notifications client thunks | `apps/web/src/features/notifications/services/client.ts` | extend with preference read/write thunks |

### System Impact & Technical Risks

- **`notify/notify.ts` `isEmailEligible(type)`** — today a pure `HIGH_SIGNAL_TYPES.has(type)`
  check. S-002 generalizes it to read per-user preferences + the master switch while keeping
  the high/low-signal default. Touches the hot path of every notification dispatch. The read is
  batched ONCE per dispatch (not per-recipient — avoid the N+1). On read failure the fallback is
  split BY CHANNEL: in-app fails open (deliver the durable row), email fails CLOSED (skip — never
  re-send a silenced email). The high/low-signal gate still runs first; preferences only ever
  narrow delivery, never widen it. (C-006)
- **New table + migration** — `notification_preferences`; S-001 is a checkpoint.
- **Risk — taxonomy drift (Linked Fields).** The settings UI must enumerate event rows from the
  live taxonomy, not a hardcoded list, or it drifts when types are added/removed. AS-012 is the
  real-integration seam test guarding this.
- **Local-only theme pattern does NOT apply** — unlike Appearance (localStorage), preferences
  must be server-side: email is sent by the backend and must sync across devices.

## Not in Scope

- **Daily email digest delivery** — UI row only; the digest job (scheduler + aggregation +
  "nothing-new → no send") is deferred to a separate Phase 2 spec (`notifications-email`
  Not-in-Scope, email coalescing/digest).
- **Per-workspace preference scoping** — preferences are account-level (one set per user),
  matching the account-level `/settings` and bell; per-workspace overrides deferred.
- **Notifying guests / non-account recipients** — no account, no preference row; out of scope.
- **Quiet hours / scheduling** — not in the mockup; deferred.

## Gaps

GAP-001 (status: resolved → AS-009): Save model for the settings section — resolved 2026-06-23
to live per-toggle save (optimistic, with a toast on failure), matching the mockup (no Save
button) and the existing AppearanceSection pattern. Source: mockup layout.

## Clarifications — 2026-06-23

- **Live per-toggle save.** Each switch persists on change (optimistic), with a toast on
  failure — no explicit Save button. Mirrors AppearanceSection's apply-immediately pattern.
  (resolves GAP-001 → AS-009)
- **Member-joined email default = OFF** (cross-spec, from `workspace-notifications`): the matrix
  encodes member-joined email as supported-but-off; reflected in AS-001 and C-003.

## Clarifications — 2026-06-24

- **Doc-share `invited` stays in-app only** (reverses an earlier in-app + email upgrade). The
  `invited` event already has its OWN transactional invite email (sent when a doc is shared with
  an account-holder), so having the notification channel ALSO email would double-send. The matrix
  marks `invited` email as unsupported (no email channel — like `resolved`/`workspace_invited`);
  the bell row is the only notification-channel output. (cross-spec with `notifications-email`
  C-006/AS-010; affects matrix, AS-001, AS-006, C-003, the settings UI)

## Spec Sizing Notes

Stories=3 (under target 7). AS=15 (AS-001…AS-015, incl. seam AS-012) (under target 20). No overage.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-23 | Initial creation | -- |
| 2026-06-23 | /mf-challenge fixes: email fails-closed + batched prefs read + AS-013 (F4); caller-scoping C-005 + AS-014 (F5); member-removed in-app locked-on (F6); lock enforced at delivery + write, C-002 + AS-015 (F7); future-type default-on documented (F11). Scope-cut finding (S1) rejected — this work IS the deferred Phase 2 | mf-challenge |
| 2026-06-24 | Doc-share `invited` reverted to in-app-only (was in-app + email): matrix email→unsupported, AS-006 now in-app row only, C-003 + UI Notes + Clarifications updated. Avoids double-email with the transactional invite mail | -- |
