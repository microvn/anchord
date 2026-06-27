# TODO — deferred work

Backlog of decisions captured but not yet built. Each entry is ready to turn into a
spec via `/mf-plan` when picked up.

---

## Notification delivery: email coalescing + daily digest

**Status:** deferred (post-v0). **Source:** workspace-project GAP-002.

**Shipped since (no longer deferred):** all 11 event emitters (reply, new-feedback, resolved,
suggestion-decided, thread-activity, detached, workspace invited/member-joined/member-removed/
renamed, doc-invited) + plain-text email delivery (`notifications-email` spec) + per-category /
per-channel preferences (`notification-preferences` spec — `notify/preferences-matrix.ts`
enforced on every emit). What remains deferred is ONLY the two delivery-shaping features below.

### Email coalescing (per-recipient trailing-debounce)

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

### Daily email digest (opt-in, de-duped)

- Opt-in (default OFF). Email only.
- Once per day, summarises **unread** items that were **NOT already delivered** by a per-event
  coalesced email (de-dupe via a per-notification `emailed_at` marker).
- Independent of the per-event email toggles (a user can run both; de-dupe prevents double-notify).
- Nothing sent when there is no new activity.

**Data model sketch (when built):** `notifications.emailed_at` (de-dupe marker between a coalesced
email and the digest); a per-recipient pending-email buffer (items + window_expires_at + count).
(`notification_preferences` already exists — shipped with `notification-preferences`.)

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

---

## Image-region annotation (pinpoint on an image: point / box)

**Status:** deferred — the LAST unbuilt piece of the annotation taxonomy. **Source:** pinpoint spec
"Not in Scope" (image regions are a separate anchor type — `annotation-core` G11 / image S-002).

**Shipped since (the rest of this taxonomy is DONE):** text-select engine (Comment), the
Markup / Comment / Redline / Label / Like types, Select ⇄ Pinpoint modes, **whole-block pinpoint on
markdown AND HTML** (`pinpoint` spec, v0.3.0), and the hover-peek + click-pin cards
(`annotation-hover-card`). Block targeting uses our block-scoped anchor + the MessageChannel+nonce
bridge — NOT Plannotator's `nodePath` / web-highlighter (kept our model on purpose).

Remaining: annotate a **region of an image** doc — a point or a box in normalized 0..1 coords
(distinct from the text/block anchor). When picked up: `/mf-plan` an image-region spec (anchor model
+ the overlay picker + the in-iframe/region draw), then `/mf-build`.

---

## Sidebar "Recent" should be per-user interaction recency, not workspace updated_at

**Status:** deferred — needs spec first (`/mf-plan workspace-project` or a new recency spec).
**Source:** session 2026-06-21 (sidebar `docs?page=1&limit=18` review — "recent phải dựa vào việc
tương tác với doc chứ không phải get danh sách docs").

The sidebar's **Recent** group is currently wrong-semantics: it's `useWorkspaceDocs` page 1 sorted
by `docs.updated_at` desc = "docs most recently **edited** anywhere in the workspace" (by anyone,
incl. an agent via MCP) — NOT "docs **I** recently opened/worked on". A real "Recent" is per-user
interaction history, which the data model does not track today.

Three directions (decide at pickup):

- **A — true per-user Recent (the real fix):** track when each user last opens/views a doc
  (`doc_views` / `last_viewed_at` per (user, doc)), write it on doc open, and the sidebar reads
  "my most-recently-viewed docs". New data model + write-on-open + a per-user read endpoint. A real
  feature → `/mf-plan`.
- **B — relabel "Recently updated" (cheap-honest stopgap):** keep the current `updated_at`-desc list
  but rename the group to "Recently updated" so the label matches what it shows. Zero new infra.
  Ship this now if A is deferred, so the UI isn't lying. Defer A.
- **C — Recent = my annotation activity:** docs where I recently created/edited an annotation
  (reuse `annotations.author_id` + `updated_at` — per-user, no new view-tracking). Middle ground;
  captures "worked on" but not "just viewed".

Note: the sidebar's `docs?limit=18` read itself is fine (1 request, shares the cache key with the
all-docs grid); only the **ordering/semantics** of what it labels "Recent" is the issue.

When picked up: pick A / B / C, then `/mf-plan` (A or C = behavior + likely data-model change → new
story/AS; B = relabel, a Minor UI-copy change). Recommended interim: ship B now, build A later.
