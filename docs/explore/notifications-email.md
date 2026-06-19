## Explore: Notifications + Email

_2026-06-18_

**Feature:** Extract Notifications + the shared Email infrastructure out of `workspace-project`
(S-006/AS-011/C-004) into one dedicated spec, then broaden it: notify on the full set of
annotation lifecycle events (not just reply), close the in-app read surface, and give emails a
deep-link. (HTML template + email coalescing are Phase 2; v0 email is per-event plain text.)

**Trigger:** Domain events on annotations/docs (create, reply, resolve, suggestion-decide,
detach) + membership events (invited, invite-accepted) raised by the existing route handlers.
Each event, post-commit, fans out to a recipient set over two channels (in-app always; email for
high-signal events, sent per event in v0).

**UI expectation:** A notification **bell dropdown panel** in the app header (the existing
`NotificationsBell` placeholder, GAP-003) — opens a list of recent notifications, shows an
unread badge, deep-links each item to its doc/thread, marks an item read **on click**, plus a
"mark all read" action. No standalone `/notifications` page in v0.

---

### UI sketch

```
┌─ App header [E] apps/web/src/app/app-header.tsx ───────────────────────────┐
│  … search …                          🔔 NotificationsBell [E] (placeholder) │
│                                          + unread badge pill [N]            │
│                                          ▼ on click                         │
│        ┌─ NotificationPanel [N] ──────────────────────────────────┐        │
│        │  "Notifications"            [Mark all read] [N]           │        │
│        │  ───────────────────────────────────────────────────     │        │
│        │  ● New feedback on "Spec v2" — Bob       2m   [N] unread  │        │
│        │  ● Bob replied in a thread you follow    10m  [N] unread  │        │
│        │  ○ Carol resolved your annotation        1h   [N] read    │        │
│        │  ○ 3 of your annotations detached        2h   [N] read    │        │
│        │  ───────────────────────────────────────────────────     │        │
│        │  (recent N; no infinite scroll v0)                        │        │
│        └────────────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────────────┘

Legend: [E] existing · [N] NEW · [X] MISSING / clarify
```

Backend surface:

```
notifications table [E] apps/backend/src/db/schema.ts:349  (user_id, type, ref_id, read, created_at)
notify logic [E partial] apps/backend/src/notify/notify.ts  (reply + top-level comment only today)
  └─ needs: per-event dispatch for create / resolve / suggestion-decide / detach / membership [N]
  └─ needs: access-filter stage on the recipient set [N]
read API [X→N] GET notifications (list, paginated), GET unread-count, POST mark-read, POST mark-all-read  — NONE exist
email infra [E] apps/backend/src/auth/{mail-queue,mail-transport}.ts  (queue + retry + dead-letter + transport select)
  └─ needs: MailMessage → {to, subject, text?, html?} + light backoff in deliverWithRetry [N]
  └─ (Phase 2) notification-email batcher / 30-min coalescing job
config [N] APP_URL / PUBLIC_URL — absolute base URL for email deep-links (does not exist; invite links are RELATIVE today)
```

---

### Role matrix A — who can TRIGGER each event

Per-doc roles (Google-Docs style): viewer / commenter / editor / owner. Guest = no account.
(Verified against `annotations.ts`: resolve = commenter+ for ordinary annotations but owner-only
for a suggestion/proposal; create-suggestion = commenter+ on a session-required mount;
decide-suggestion = owner-only; publish/detach = editor+.)

| Event | viewer | commenter | editor | owner | guest |
|---|:---:|:---:|:---:|:---:|:---:|
| New annotation | ✗ | ✓ | ✓ | ✓ | ✓ (if guest-commenting on) |
| Comment / reply | ✗ | ✓ | ✓ | ✓ | ✓ (guest-commenting) |
| Create suggestion | ✗ | ✓ | ✓ | ✓ | ✗ (session-required) |
| Resolve / reopen (ordinary) | ✗ | ✓ | ✓ | ✓ | ✗ |
| Decide suggestion | ✗ | ✗ | ✗ | ✓ | ✗ |
| Publish → detach | ✗ | ✗ | ✓ | ✓ | — (system) |
| Invite | ✗ | ✗ | ✓? | ✓ | ✗ |

### Role matrix B — who RECEIVES each event

Recipients are derived by **relationship** (owner / editor / participant / author), then **filtered
by current doc access** (a recipient who lost access is dropped — decided), then the actor is
removed (self-exclusion), then deduped.

| Event | viewer | commenter | editor (no participate) | owner | guest | related author/participant |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| New feedback | ✗ | ✗ | **✓** | ✓ | ✗ | — |
| Thread activity (reply / top-level comment) | ✗ | ✓ if commented | ✗ if not commented | ✓ | ✗ | ✓ participants |
| Suggestion decided | — | ✓ if author | ✗ | ✓ if author | ✗ | ✓ suggestion author |
| Resolved / reopened | — | ✓ if creator | ✗ | ✓ if creator | ✗ | ✓ annotation creator |
| Detached | — | ✓ if author | ✗ | ✓ if author | ✗ | ✓ affected authors |
| Invited | the invitee (no doc role yet) |
| Invite accepted | the inviter (owner/editor) |

**Decided:** new feedback → **owner + all editors** (not owner-only) — a co-editor of a doc learns
of new feedback even before participating. Recipient = relationship candidates, **access-filtered**
at notify time across every event.

---

### Happy path

1. Bob (commenter) opens Alice's doc and **creates a new annotation** "this section is wrong".
2. Post-commit, the system raises a `new_feedback` event → candidates = **doc owner + editors**,
   access-filtered, minus Bob.
3. Each recipient gets an in-app row immediately (bell badge +1) **and** a per-event plain-text
   email (high-signal), enqueued + delivered through the MailQueue.
4. The email carries a deep-link (built from `APP_URL`) to the thread.
5. Alice clicks the link → lands on the doc at that annotation. She opens the bell, clicks the
   item → it marks read, badge decrements.

### Unhappy path 1 — low-signal, in-app only

Carol resolves Bob's annotation → `resolved` event → Bob gets an **in-app row only** (no email).
Bob opens the bell (panel does not auto-clear), clicks the item → navigates to the annotation,
that one item flips to read; the rest stay unread.

### Unhappy path 2 — detached burst (grouped in-app)

Alice publishes a new version; 5 of Bob's annotations lose their anchor at once. Instead of 5
rows, the reanchor job raises **one** `detached` notification per recipient per publish —
"5 of your annotations were detached" (in-app only). (This is in-app row grouping per publish, a
separate concern from email coalescing — it stays in v0.)

### Unhappy path 3 — recipient lost access

Bob commented on a thread, then was removed from the doc. A later reply raises `thread_activity`;
the access-filter drops Bob (no longer has access) → no row, no email for him. (Decided: filter at
notify time.)

### Unhappy path 4 — email transport fails

A notification email hits a provider error → the existing MailQueue retries (light backoff), then
dead-letters after `maxAttempts`. The recipient's **in-app row is unaffected** (already persisted).
The triggering action never fails (best-effort, post-commit).

---

### Event catalog (channel + recipient per event)

| Event | Raised by | Channel | Recipients (then access-filtered, minus actor, deduped) |
|---|---|---|---|
| **New feedback** (new annotation) | `createAnnotationHandler` / `docCreateAnnotationHandler` | in-app + email | doc **owner + editors** |
| **Thread activity** (reply OR top-level comment on an existing annotation) | `commentHandler` | in-app + email | thread participants ∪ doc owner |
| **Suggestion decided** (accept/reject) | `decideSuggestionHandler` | in-app + email | the suggestion's author |
| **Resolved / reopened** | `resolutionHandler` | in-app only | the annotation's creator |
| **Detached** (annotations lost anchor on republish) | `reanchor-job` | in-app only | each affected annotation's author — **coalesced: one per publish per recipient** |
| **Invited** (added to workspace/doc) | invite flow | in-app only (invite *email* already exists, transactional) | the invitee |
| **Invite accepted** | accept flow | in-app only | the inviter |
| **Reply** (baseline, already shipped — folds into thread activity) | `commentHandler` | in-app + email | participants ∪ owner |

**Trigger definition (resolves the current drift):** a **brand-new annotation** → `new_feedback`
→ owner + editors. A **comment/reply on an existing annotation** → `thread_activity` →
participants ∪ owner. This folds the top-level-comment case (which today fires
`dispatchReplyNotify` inconsistently) into the thread-activity bucket cleanly.

**Channel policy (decided):** high-signal (new feedback, thread activity/reply, suggestion
decided) → email + in-app. Low-signal (resolved, detached, invited, invite-accepted) → in-app
only.

---

### Email delivery model (v0)

- **In-app** rows are written **immediately, per event** (cheap, the durable channel — persisted in Postgres).
- **Notification email** is sent **per event, immediately** (v0: plain text). One high-signal
  event → one email, enqueued + delivered through the existing MailQueue.
- **No coalescing in v0** (decided 2026-06-18 — moved to Phase 2). Coalescing was only pulled
  toward v0 to dodge a provider's daily cap (e.g. Resend free tier ~100/day). With the operator
  on their own SMTP (Gmail ~500/day free, ~2000 Workspace — generous, not infinite), the cap stops
  being the forcing function, so per-event-immediate is fine for v0. This also **re-aligns with
  the locked GAP-002** ("always-send, one email per event, digest deferred post-v0") — no CLAUDE.md
  reversal needed any more. The remaining value of coalescing is inbox-noise reduction, which is
  Phase-2 polish.
- **Transactional email** (auth verification + invite) was always immediate and stays so.

**Mail queue (v0 — keep what exists, do NOT over-build):**
- Reuse the existing **in-memory** `MailQueue` (`apps/backend/src/auth/mail-queue.ts`) — enqueue +
  retry + dead-letter + status. No Redis, no DB-backed queue. Acceptable because the in-app row is
  the durable channel (email is best-effort), invite carries an email-independent accept-link, and
  verify is re-requestable; a process restart losing queued mail is an accepted v0 trade-off.
- **One fix, not new infra:** `deliverWithRetry` currently retries in a tight loop with **no delay**
  → a transient SMTP failure dead-letters instantly (retry is cosmetic). Add a **light backoff**
  (e.g. ~2 attempts, ~5s apart) via `setTimeout` — still in-process, no broker.
- **Message contract:** change `MailMessage` from `{ to, subject, body }` to
  `{ to, subject, text?, html? }`. v0 sets `text` only and the transport sends `text/plain`
  (a plain-text body must NOT go in the `html` field). Phase 2 fills `html` (keeping `text` as the
  multipart fallback) → the HTML template is a pure drop-in with **zero queue/transport changes**.
- Durable queue backing (DB table so a restart doesn't lose mail) → Phase 2, only if a real need shows up.

---

### Phasing

**Phase 1 (v0 — ship first):**
- Extract notify + email infra into this spec (ownership move; behavior-preserving for auth/invite).
- All events above, with the decided channel policy + recipient model (owner+editors for new feedback) + access-filter.
- Close the **in-app read surface**: list (paginated) + unread-count + mark-read (per item) + mark-all-read; wire the bell dropdown panel + unread badge.
- **Deep-links in email** — requires the new `APP_URL` config (plain-text emails carry the absolute URL too).
- **Per-event plain-text email** via the existing in-memory MailQueue + light backoff retry; `MailMessage` → `{ to, subject, text?, html? }` (v0 sets `text`).
- Fix the trigger drift (new-feedback vs thread-activity definition above).
- **v0 email is PLAIN TEXT only** (decided 2026-06-18) — subject + a text body with the absolute
  deep-link URL(s). No HTML, no branding/logo, no light/dark, no coalescing. Good enough to close
  the feedback loop; ships faster and dodges the whole email-client compatibility surface.

**Phase 2 (defer):**
- **HTML email template** — the designed shared frame + email-safe primitives (`layout`,
  `button`, `heading`, `paragraph`, `eventRow`, `divider`), light-base + dark-aware
  (`prefers-color-scheme`), hosted-PNG logo + type-wordmark fallback, branded teal. Each feature
  template composes primitives → `{subject, html, text}`. Preview/design done 2026-06-18:
  `~/.gstack/projects/microvn-anchord/designs/email-template-20260618/`. v0 ships the `text` half
  of that contract only; Phase 2 adds the `html` half (pure drop-in — the `{text?, html?}` contract
  is already in place from v0).
- **Email coalescing** (group a recipient's high-signal events into one digest over a ~30-min
  window) — to cut inbox noise. No Redis needed: either an in-memory buffer + `setTimeout` flush
  (lossy on restart) or an `emailed_at` column on `notifications` + a periodic sweep (durable).
  Deferred because the provider-cap forcing function is gone; remaining value is inbox-polish.
- Per-user **notification preferences** table + per-event-type opt-out.
- **Daily digest** option (vs the per-event default).
- **@mentions** — does not exist in the codebase today; new feature: notify the mentioned user.
- Operator dashboard for mail dead-letters (data exists via `MailQueue.statusCounts()`/`deadLetters()`; no route surfaces it).
- Durable mail queue backing (queue is in-memory today).
- Notify guests who left an email (today guests are excluded — no account).

**Dependencies:** Phase 2 preferences gate Phase 1's channel policy (the hardcoded high/low-signal
split becomes a per-user override). Phase 1 must ship the event-type taxonomy so Phase 2 can
attach preferences to it.

---

### Business rules

- **Recipient pipeline (every event):** relationship candidates → **access-filter (drop anyone
  without current doc access)** → remove actor (self-exclusion) → dedup → fan out.
- **Self-exclusion:** the actor is never notified of their own action (generalize the existing
  reply rule to every event).
- **Dedup:** overlapping recipients (e.g. owner who is also a participant/editor) collapse to one
  in-app row per recipient.
- **Guest handling:** a guest (no account, `author_id` null) is never a recipient (no in-app row,
  no email) — but a guest's *action* still notifies account-holders.
- **Best-effort / post-commit:** notify runs AFTER the triggering action persists and never
  throws; a failing repo/mail path is logged + swallowed, never turns the action into a 500
  (existing `notifyOnReply` contract — generalize it).
- **Email eligibility** is derived from the notification `type` (high-signal types are
  email-eligible; low-signal are in-app only).

### Input validation

- No new user-facing form fields. Read API query params: `cursor`/`page` + `limit` (reuse the
  workspace-project pagination convention); `limit` capped (e.g. ≤ 50).
- `APP_URL` config: must be an absolute `http(s)://` URL (Zod-validated at boot like `DATABASE_URL`).

### Edge cases

- **Empty state:** bell panel with no notifications → "You're all caught up" (no badge).
- **Recipient lost access** at notify time → **dropped** by the access-filter (no row, no email).
- **Recipient lost access after notify, before reading:** the row persists; the deep-link is
  access-gated → clicking 404s (existing `resolveAccess` hiding). Acceptable v0; row may dangle.
- **Deleted doc/annotation:** `ref_id` dangles → deep-link 404. Acceptable v0.
- **Mark-read idempotency:** marking an already-read item or mark-all with nothing unread → no-op, 200.
- **Concurrent mark-read:** last-write-wins on `read` (monotonic to true, no conflict).
- **Notification table growth:** unbounded in v0 (no retention/pruning). Note for Phase 2.
- **Mail queue + restart:** the in-memory MailQueue loses pending/failed mail on a process restart.
  Accepted in v0 (in-app row is the durable channel; invite has an accept-link; verify is re-requestable).
  Durable backing → Phase 2.

### Permissions

- **Read own notifications only:** a user lists/marks only rows where `user_id` = their id
  (session-scoped, cross-workspace — a notification is personal).
- No role gate beyond authentication for the read API. Recipients are computed server-side per
  event; the client never picks recipients.

### Data impact

- **`notifications` table [E]:** no new column in v0. (`emailed_at` is Phase 2, for coalescing.)
- **`type` pgEnum [E]:** extend with the new event types (`new_feedback`, `thread_activity`,
  `suggestion_decided`, `resolved`, `detached`, `invited`, `invite_accepted`) — `reply` exists.
  ⚠ Migration additive; existing `reply` rows stay valid.
- **`MailMessage` shape:** `{ to, subject, body }` → `{ to, subject, text?, html? }` (v0 sets `text`).
- **New config `APP_URL`** in `env.ts` (required, Zod-validated).

### Impact on existing system

- **`workspace-project` spec:** S-006/AS-011/C-004 + GAP-002 move out to this spec (cross-reference, don't duplicate).
- **`annotations.ts` routes:** new per-event dispatch in `createAnnotationHandler`,
  `resolutionHandler`, `decideSuggestionHandler`, `reanchor-job`; `commentHandler` drift re-defined.
- **`mail-transport.ts` invite emails:** start using `APP_URL` to make accept-links absolute
  (fixes the latent relative-link bug as a byproduct).
- **FE `app-header.tsx`:** `NotificationsBell` gains real data + the dropdown panel;
  `query-client` gets a notifications query + unread-count polling.

### Out of scope

- **@mentions** — no parsing/storage exists; new feature, Phase 2.
- **Per-user preferences / opt-out / daily digest / email coalescing** — all Phase 2.
- **Real-time push (WebSocket)** — v0 polls unread-count; no live socket.
- **Standalone `/notifications` page** — bell dropdown only in v0.
- **Operator mail dead-letter dashboard** — data exists, no UI/route in v0.
- **Notifying guests** — excluded (no account).

### Decision rationale

- **New feedback → owner + editors** (not owner-only) — anchord has explicit editor roles; a
  co-editor should learn of new feedback without having to participate first. Costs a doc-role
  query per new-feedback event.
- **Access-filter at notify time, across all events** — generalizes the "recipient lost access"
  fix; recipients are relationship-derived candidates filtered to those who currently hold access.
  Costs one access check per candidate per event; cleaner than letting rows dangle to a 404.
- **No coalescing in v0; email is per-event plain text** (reversed an earlier "pull into v0" call,
  2026-06-18). Coalescing was only attractive to dodge a provider daily cap; with the operator on
  their own SMTP the cap is not the forcing function, so per-event-immediate is fine and **keeps
  the locked GAP-002 intact** (no CLAUDE.md reversal). Remaining value (inbox-noise) is Phase-2 polish.
- **v0 mail queue = the existing in-memory one** + a light backoff on retry; no Redis, no DB-backed
  queue. The in-app row is the durable channel, so restart-loss of queued mail is acceptable.
- **`MailMessage` carries `text?`/`html?` from v0** even though v0 only fills `text` — so the
  Phase-2 HTML template is a pure drop-in, no queue/transport surgery.
- **High/low-signal channel split** — without per-user preferences yet, keeps email signal high
  (resolve/detach/membership are FYI → in-app only).
- **Mark-read on click (not auto-on-open)** — preserves "what have I not looked at yet" context.
- **Own email infra + notifications in one spec** — they share the MailQueue/transport and the
  `APP_URL` requirement; auth-verify and invite are *consumers* of that infra.

### Assumptions (need explicit confirmation)

- v0 email is per-event plain text through the existing in-memory MailQueue; a light backoff
  (e.g. ~2 attempts / ~5s) is enough — /mf-plan to confirm the exact attempts/delay.
- Unread-count is delivered by **polling** (no WebSocket); poll interval ~ the get-session cadence.
- `APP_URL` is a single absolute base; the FE doc/thread route shape (`/d/:slug`, `/v/:id` + an
  annotation anchor fragment) is stable enough to build deep-links against.

### Open questions

- Unread-badge cap in the UI ("9+"?) and poll interval.
- Deep-link **fragment** format to scroll to a specific annotation/thread (does the viewer support
  `#annotation-:id` today, or does it need a new anchor target?).
- Plain-text email **body shape** — one-liner per event type + the deep-link URL line (wording per event).
- Should the **owner also be notified on detach** when an editor's publish detaches annotations the
  owner didn't author (matrix B gap #5) — currently recipients = affected authors only.
- Whether `invite_accepted` (in-app to inviter) is worth v0 or trivially deferrable.

### Complexity signal: **high**

New read API (4 endpoints) + FE panel, 7 new event dispatch sites, an access-filter on the
recipient pipeline, an enum extension + `MailMessage` reshape (no new column), a new required
config, an ownership move of existing spec sections, and a behavior change (trigger re-definition)
on the hot annotation routes. (Dropping coalescing removes the scheduled-job infra from v0.)

### Non-functional requirements

- **Scale:** single self-host box; notification rows grow with activity (Phase 2 retention).
  Unread-count is indexed (`notifications_user_read_idx`).
- **Performance:** read API paginated + bounded `limit`; unread-count is a single indexed count;
  notify dispatch is post-commit/async, off the request's critical path. The access-filter adds
  one access check per recipient — bounded by recipient count, run async.
- **Security/compliance:** notifications are personal data — read is strictly `user_id`-scoped;
  deep-links access-gated at click time; email carries minimal content + a link (don't leak doc
  body into email).
- **Availability:** if email is down, in-app still works and actions still succeed (best-effort);
  if notify is down entirely, the triggering actions are unaffected.

### Technical risks

- **No `APP_URL` config exists and invite links are relative today** — emails embed relative hrefs
  that won't resolve in a mail client. Pre-existing latent bug this spec must fix; wire the config
  through both invite and notification email.
- **Behavior change on hot routes** — re-defining the comment/reply notify trigger + adding the
  access-filter touches the most-tested annotation route; needs careful regression coverage so
  existing reply-notify tests pass under the new taxonomy.
- **Enum migration** — extending the `type` pgEnum must stay additive (keep `reply`) and portable
  (no Postgres-only enum tricks that block a future SQLite build).
