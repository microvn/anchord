# TODO — deferred work

Backlog of decisions captured but not yet built. Each entry is ready to turn into a
spec via `/mf-plan` when picked up.

---

## Notification delivery: preferences + email coalescing + daily digest

**Status:** deferred (post-v0). **Source:** workspace-project GAP-002 (resolved to the MVP
below; this richer design is the follow-up).

**MVP shipped instead (v0):** always send, one email per action immediately, no preference,
no coalescing, no digest. Lives in workspace-project S-006 (notify on reply), AS-011 / C-004.

When picked up, this becomes its own spec `docs/specs/notifications/notifications.md`
(separate domain from workspace→project→doc organization). Three stories:

### 1. Per-user notification preferences

A settings surface "Choose what you hear about" — per-category, per-channel toggles.
In-app = the bell; Email = the account address. Defaults ON unless noted.

| Category | In-app | Email | Default |
|---|---|---|---|
| New comments on your documents | ✓ | ✓ | on |
| Replies to your comment threads | ✓ | ✓ | on |
| Workspace invitations | ✓ | ✓ | on |
| Workspace members joining | ✓ | ✓ | on |
| Workspace member removal | ✓ | ✓ | on |
| Workspace name or URL changes | ✓ | — (in-app only) | on |
| Documents shared with you | ✓ | ✓ | on |
| Daily email digest | — | ✓ (email only) | **off** |

- Delivery of each notification is gated by the recipient's per-category, per-channel preference.
- Email-off for a category → no email for it; in-app still per its own toggle (and vice versa).
- The settings SCREEN is frontend (needs the React scaffold first). Backend = preference
  storage + enforcement on every emit.
- Note: only the `reply` notification is emitted today (S-006). The other 7 categories need
  their own emitters built before their toggles do anything — that emitter work is part of this
  follow-up, per category.

### 2. Email coalescing (per-recipient trailing-debounce)

In-app stays per-event (one bell item each). Only **email** is coalesced, **per recipient
globally** (one buffer per user across all threads/docs):

- Each pending email-eligible notification enters the recipient's buffer.
- A 60s timer **resets on every new item** (trailing debounce, measured from the last item).
- **Flush** (send ONE summary email of the buffered items) when either:
  - 60s elapse with no new item, OR
  - the buffer reaches **5 items** → flush immediately, then restart the window empty.
- At flush, re-check each buffered item is still live: an item **added then deleted before
  flush** (added by mistake → removed) is excluded. If every buffered item was removed, no
  email is sent.

Worked example (the exact intent):
- `c1`, `c2` at the same second → would send at +60s.
- `c3` arrives at +59s → timer resets; now send at +60s from `c3`.
- Repeat: each new item pushes the send out another 60s from itself.
- At 5 items → flush immediately and restart from empty.

### 3. Daily email digest (opt-in, de-duped)

- Opt-in (default OFF). Email only.
- Once per day, summarises **unread** items that were **NOT already delivered** by a per-event
  coalesced email (de-dupe via a per-notification `emailed_at` marker).
- Independent of the per-event email toggles (a user can run both; de-dupe prevents double-notify).
- Nothing sent when there is no new activity.

**Data model sketch (when built):** `notification_preferences` per-user keyed (category, channel);
`notifications.emailed_at` (de-dupe marker); a per-recipient pending-email buffer
(items + window_expires_at + count).
