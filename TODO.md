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

---

## Eden end-to-end typing collapses to `/health` (conditional route mounting)

**Status:** deferred (works at runtime; cast is centralized). **Source:** workspaces-ui build (S2).

`createApp(deps)` mounts each data-route group conditionally (`if (deps.x) app.use(...)`), so
`export type App = typeof app` only statically exposes the unconditionally-mounted routes
(`/health`). Eden Treaty `treaty<App>` therefore can't type the `/api/w/:id/…` routes — the FE
reaches them through one typed wrapper (`apps/web/src/features/workspaces/client.ts`) with a
localized cast. This defeats the locked "end-to-end type safety (Eden)" goal for every FE feature.

Fix (when picked up): mount route groups unconditionally so `typeof app` widens to the full surface
(move the deps-presence guard inside handlers, or assemble the `App` type from the route modules
directly). Keep the cast centralized in `client.ts` until then — subsequent FE features route
through it, so the debt stays in one file, not multiplied.

## Workspace invite mismatch is a uniform 404 (existence-hiding) vs the "not for you" UX

**Status:** accepted for v0. **Source:** workspaces-ui AS-015 (S2).

`POST /api/invitations/:id/accept|reject` require `{token}` and return a uniform 404 on
email-mismatch (existence-hiding — correct security posture). So the FE's "this invite isn't for
you" (AS-015) is a client-side pre-check comparing the session email to an `email` param carried in
the invite link, not an authoritative server signal. Acceptable for v0; revisit if we want a
server-authoritative mismatch response without leaking invite existence.

---

## Annotation editor: pinpoint mode + Markup/Redline types (steal Plannotator, FE)

**Status:** deferred — needs spec first (`/mf-plan` on `annotation-core-ui-suggest-image`).
**Source:** Plannotator engine adoption, 2026-06-11/12 (select-mode engine A+B already landed:
commits `4528194`, `148f73c`, `bae51c0`).

The select-mode text engine (Comment type) is built + hardened. Remaining annotation surface,
modelled on Plannotator's **2 modes × types** taxonomy:

- **pinpoint mode (NEW):** pick a whole rendered element dev-tools-style (hover → element outlined →
  click), anchored to the block by block-id — NOT a text sub-range. Works on md/html (whole block)
  and on images (point/box region). The image case = `suggest-image` S-003/S-004 (already specced,
  unbuilt); the **md/html element-picker is new** (no spec yet). Steal from Plannotator
  `packages/ui/utils/blockTargeting.ts` + the hover-outline overlay (Apache-2.0, keep NOTICE).
- **Markup type (NEW):** highlight-only annotation (no comment thread) — not in any current spec;
  add as a new SelectionPopover action + a new annotation kind. Needs a `/mf-plan` line.
- **Redline type = our existing "Suggest"** (propose a text replace) — `suggest-image` S-001/S-002,
  unbuilt. Rename Suggest→Redline if we adopt Plannotator's vocabulary.
- **Label type: DROPPED** (product decision 2026-06-11) — do not build.

Do NOT copy Plannotator's `nodePath` anchor model or `@plannotator/web-highlighter` (whole-doc
position-based, fragile across reflow). Keep our block-scoped anchor. Our MessageChannel+nonce
bridge is more secure than theirs — keep it. Adopt only the targeting/UX techniques.

When picked up: `/mf-plan docs/specs/annotation-core/annotation-core-ui-suggest-image.md` to add
pinpoint mode + Markup, fold in Redline=Suggest, drop Label; then `/mf-build`.
