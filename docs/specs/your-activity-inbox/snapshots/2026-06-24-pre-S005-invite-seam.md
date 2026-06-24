# Snapshot: Your Activity — For-you inbox
**Date:** 2026-06-24
**Ref:** --
**Reason:** M4, M5, M6 — S-005 accept/decline flow rewritten (invite-targeting via a dedicated `invitationId` notification field + tokenless email-match accept), C-007 constraint changed, Data Model + Linked Fields + GAP-001 corrected.

---

# Spec: Your Activity — For-you inbox

**Created:** 2026-06-23
**Last updated:** 2026-06-23
**Status:** Draft
**Snapshot limit:** 5

## Overview

The account-scoped **"Your activity"** page (`/me/activity`) and its first tab, **For you** — a full-page, cross-workspace view of the caller's existing in-app notifications (replies, feedback, resolved threads, workspace invites) with day grouping, unread management, an item detail, an inline reply, and accept/decline for workspace invites. Built from the `Anchord-Design/personal.jsx` prototype.

This is **spec 2a of the personal page**. It reuses the EXISTING notification system (`GET /api/me/notifications` + mark endpoints, already user-scoped and cross-workspace) — it is NOT a new inbox data source. Its one backend change is enriching the notification read with the owning **workspace** (id + name) so the cross-workspace chip renders.

**Shared page shell (M7 — no empty placeholder tab):** this spec builds the `/me/activity` page rendering the **For you** content as composable components — and does NOT render a visible-but-empty "Your actions" tab (a dead tab is UX debt, not a placeholder). The sibling spec `your-activity-actions` (2b) introduces the two-tab bar (**For you** | **Your actions**) when it lands, composing 2a's For-you components as the first tab. So: 2a ships a single-surface page that works standalone; 2b adds the tab bar + its own tab. Whichever ships second owns the tab container — built exactly once.

**Out of v0 (decided 2026-06-23):** `@`-mentions — the prototype leads with a "mention" kind, but there is no mention backend (no `@`-parse, no `mention` notification type). Mentions become a separate spec 3; this spec surfaces only the notification types the bell already produces.

## Data Model

No new tables. Two additive changes to the existing notification surface:

- **`workspaceId` + `workspaceName`** added per returned item of `GET /api/me/notifications` — the workspace that owns the notification's target, so the inbox renders a per-item workspace chip across workspaces. Derived: for doc/annotation types via `annotation → doc → project → workspace`; for `workspace_*` types `refId` already IS the workspace id (and `refLabel` already snapshots the name). Read-time only; no schema change. **Additive — the bell ignores the extra fields (no query-param branching needed); they are harmless to existing consumers (M8).**
- **`invitationId`** is carried on the `workspace_invited` notification as its **`refId`** — `workspace-notifications` (AS-010, locked 2026-06-23) sets `workspace_invited`'s `refId` = the invitation id (the actionable target; `refLabel` carries the workspace name for display). The inbox's accept/decline read `refId` and call `POST /api/invitations/:refId/accept|reject`. Linked Field; GAP-001 resolved. (C1)

**FE type sync (prerequisite, H1):** `apps/web/src/features/notifications/types` currently omits the `workspace_*` notification types and the `refLabel` field — they must be added or `workspace_invited` rows won't render/typecheck. Rides S-001's files.

Everything else (the `notifications` table, types, read/unread state) is unchanged and owned by `notifications-email` / `workspace-notifications`.

## Stories

### S-001: View the For-you inbox (P0)

**Description:** As a signed-in user, I open `/me/activity`, land on the **For you** tab, and see my notifications from every workspace I'm in — newest-first, grouped by day, each row showing who did what, in which workspace and doc, with an unread marker — so I have one place to catch up across all my workspaces.
**Source:** docs/explore/workspace-activity.md (Personal page split; "For you = full-page bell view") + `Anchord-Design/personal.jsx` (PersonalScreen inbox list).
**Applies Constraints:** C-001, C-002, C-005, C-006

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` apps/backend/src/notify/read-repo.ts (add `workspaceId`+`workspaceName` to the read enrichment), apps/web/src/features/your-activity/ (new: components/your-activity-page.tsx [single-surface page wrapper — NO empty tab, M7], **components/for-you-content.tsx [standalone composable `ForYouContent` — exported for 2b, resolves 2b:GAP-003]**, components/inbox-list.tsx + inbox-row.tsx, hooks, services — reuse `@/features/notifications` client/hook/format), apps/web/src/app (mount `/me/activity` route), apps/web/src/app/user-menu.tsx (add "Your activity" entry)
- `autonomous:` true
- `verify:` sign in as a user with notifications in 2 workspaces, open `/me/activity` → both workspaces' items appear, newest-first, day-grouped, each with the correct workspace chip.

**Acceptance Scenarios:**

AS-001: Inbox lists my notifications across workspaces
- **Given:** Mara has notifications in "Acme Platform" and "Field IO"
- **When:** she opens `/me/activity` (For you tab)
- **Then:** items from both workspaces appear in one list, newest-first
- **Data:** 3 items in Acme, 1 in Field IO
- **Setup:** Mara is a member of both workspaces

AS-002: Items are grouped by day, newest first
- **Given:** items spanning today, yesterday, and earlier
- **When:** Mara views the inbox
- **Then:** rows are grouped under day labels (Today / Yesterday / dated), most-recent first
- **Data:** 6 items across 3 days

AS-003: Each row shows its owning workspace
- **Given:** a reply notification on a doc in "Acme Platform"
- **When:** Mara views the inbox
- **Then:** the row shows a workspace chip naming "Acme Platform" (the enriched `workspaceName`)
- **Data:** reply on "Web-core behavior contract", workspace Acme Platform

AS-004: Empty state when there's nothing
- **Given:** a user with no notifications
- **When:** they open the inbox
- **Then:** an empty state reads "You're all caught up" with the cross-workspace message
- **Data:** zero notifications

AS-005: Loading and error states
- **Given:** the notification list request is in flight, then fails
- **When:** the inbox renders
- **Then:** a skeleton shows while loading; on failure an error state with Retry shows (not a blank page)
- **Data:** simulated slow then failed fetch

### S-002: Manage unread state (P0)

**Description:** As a user, I see which items are unread, mark one or all read, and filter to unread-only, with an unread count on the tab — so the inbox reflects what I've dealt with. Reuses the existing mark/unread-count endpoints.
**Source:** `Anchord-Design/personal.jsx` (unread dot, unread-only toggle, mark-all, count pill) + notifications-email read API.
**Applies Constraints:** C-002

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/web/src/features/your-activity/ (unread toggle, mark controls, count pill — reuse `markNotificationRead`/`markAllNotificationsRead`/`fetchUnreadCount` from `@/features/notifications/services/client`)
- `autonomous:` true
- `verify:` open an unread item → it becomes read + the count drops; mark-all → all clear; toggle unread-only → only unread rows remain.

**Acceptance Scenarios:**

AS-006: Opening an item marks it read
- **Given:** an unread reply item
- **When:** Mara opens its detail
- **Then:** that item becomes read and the unread count decreases by one — opening the DETAIL is a deliberate engagement gesture, so it marks read (this is a deliberate divergence from the bell's C-009, where merely opening the dropdown panel does NOT mark read; see C-009 below)
- **Data:** 1 of 3 unread, open it → count 3→2

AS-007: Mark a single item read without opening
- **Given:** an unread item with a row-level "mark read" control
- **When:** Mara clicks it
- **Then:** the item becomes read and stays in the list (just no longer marked unread)
- **Data:** row mark-read action

AS-008: Mark all read
- **Given:** several unread items
- **When:** Mara clicks "Mark all read"
- **Then:** every item becomes read and the unread count is zero
- **Data:** 4 unread → 0

AS-009: Unread-only filter
- **Given:** a mix of read and unread items
- **When:** Mara turns on "Unread only"
- **Then:** only unread items are shown; turning it off restores the full list; when nothing is unread a "No unread items" state shows
- **Data:** 2 unread, 4 read

AS-010: A mark on someone else's notification is a no-op (read-own-only)
- **Given:** a notification id that does not belong to Mara
- **When:** a mark-read is attempted for it
- **Then:** nothing changes and no error reveals the row's existence (scoped to the caller, mirrors the bell)
- **Data:** foreign notification id

### S-003: Open an item to its detail (P1)

**Description:** As a user, I click an inbox row to see its detail — who, which workspace/doc, when, the quoted text and body — and an "Open in doc" link to jump to the source.
**Source:** `Anchord-Design/personal.jsx` (PersonalDetail KV + quote/body + "Open in doc").
**Applies Constraints:** C-003

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/web/src/features/your-activity/components/ (inbox detail view; reuse the existing notification fields + `@/features/notifications` format)
- `autonomous:` true
- `verify:` open an item → detail shows actor/workspace/doc/when + quote/body; "Open in doc" navigates to the doc.

**Acceptance Scenarios:**

AS-011: Detail shows the item's metadata
- **Given:** a reply notification on a doc
- **When:** Mara opens it
- **Then:** the detail shows the actor, workspace, document, and when, plus the quoted text and the reply body
- **Data:** Priya replied on "Web-core behavior contract", Acme Platform

AS-012: "Open in doc" jumps to the source, and is shown only for doc-backed items
- **Given:** a reply notification whose `refId` is an annotation thread (resolvable `slug`)
- **When:** Mara clicks "Open in doc"
- **Then:** the doc opens at that annotation (deep-link), falling back to the doc top if the anchor no longer resolves; **"Open in doc" is shown ONLY for doc-backed types with a resolvable slug — it is hidden for `workspace_invited` items (whose `refId` is a workspace, not an annotation) and for items whose doc was deleted (null slug) (H2)**
- **Data:** annotation on "§ Path scoping" (shown); a workspace_invited item (no "Open in doc")

### S-004: Reply to a thread from the inbox (P1)

**Description:** As a user, I reply to (and optionally resolve) a thread directly from an item's detail, without leaving the inbox — posting through the existing annotation comment path.
**Source:** `Anchord-Design/personal.jsx` (reply composer + Resolve in PersonalDetail) + annotations reply route.
**Applies Constraints:** C-003

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` apps/web/src/features/your-activity/components/ (reply composer + resolve action; call the existing `POST /api/annotations/:id/comments` + the annotation resolve route via a thin client)
- `autonomous:` true
- `verify:` reply on a reply/feedback item → a comment is posted to that thread; resolve → the thread is resolved; reply on a doc where the user can't comment is refused.

**Acceptance Scenarios:**

AS-013: Reply posts to the thread
- **Given:** a reply notification whose thread Mara can comment on
- **When:** she types a reply and submits
- **Then:** a reply comment is created on that thread (via the annotation id), and the item is marked read
- **Data:** reply body "Agreed — shipping in v3"

AS-014: Resolve from the inbox
- **Given:** an open thread Mara is allowed to resolve
- **When:** she clicks Resolve
- **Then:** the thread is resolved (same effect as resolving in the doc)
- **Data:** open thread on "§ Path scoping"

AS-015: Reply is refused when the user can't comment on the doc
- **Given:** an item on a doc where Mara's role is viewer (no comment permission)
- **When:** a reply is attempted
- **Then:** it is refused by the existing annotation gate; the inbox surfaces the refusal rather than silently failing
- **Data:** viewer role on the target doc

### S-005: Accept or decline a workspace invite from the inbox (P1)

**Description:** As a user, when an inbox item is a workspace invite, I accept it (join the workspace at the invited role) or decline it (the invite is rejected) — without going elsewhere.
**Source:** `Anchord-Design/personal.jsx` (invite item Accept/Decline) + invitations accept/reject routes.
**Applies Constraints:** C-003, C-007

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` apps/web/src/features/your-activity/components/ (invite actions; call `POST /api/invitations/:id/accept` and `/reject`), apps/backend/src/notify/* + `workspace-notifications` emit (carry `invitationId` on the `workspace_invited` row — C-007, cross-spec, GAP-001)
- `autonomous:` true
- `verify:` accept an invite item → the workspace appears in the switcher at the invited role; decline → the invite is gone and does not activate later; an invite that was already revoked/accepted → the action surfaces "no longer available" and the row clears (no dead 404).

> **Dependency (C1 / GAP-001 — RESOLVED):** accept/decline target the INVITATION id. `workspace-notifications` (AS-010, locked 2026-06-23) now sets the `workspace_invited` row's `refId` = the invitation id, so S-005 reads `refId` and calls `POST /api/invitations/:refId/accept|reject`. No longer a blocker; just verify the seam at build (Linked Field).

**Acceptance Scenarios:**

AS-016: Accept an invite
- **Given:** a workspace-invite item for "Mercury Docs" as editor
- **When:** Mara clicks Accept
- **Then:** she joins "Mercury Docs" at the editor role (the existing accept flow runs) and the item reflects the accepted state
- **Data:** invite to Mercury Docs, role editor

AS-017: Decline an invite
- **Given:** the same pending invite
- **When:** Mara clicks Decline
- **Then:** the invite is rejected — it no longer activates and is cleared from the inbox
- **Data:** decline the Mercury Docs invite

AS-018: Non-invite items show no accept/decline
- **Given:** a reply or feedback item
- **When:** Mara opens it
- **Then:** no Accept/Decline is offered (those actions are invite-only)
- **Data:** a reply item

AS-019: Acting on an already-revoked or already-accepted invite degrades gracefully
- **Given:** an invite item whose invitation was revoked by an admin (or already accepted) since it landed in the inbox
- **When:** Mara clicks Accept or Decline
- **Then:** the action does not dead-error — the inbox surfaces "this invitation is no longer available" and clears/updates the row, rather than leaving a 404-ing item (M4)
- **Data:** invitation revoked between inbox load and the action

## Constraints & Invariants

C-001: The For-you inbox is the caller's EXISTING per-user notification set surfaced full-page — user-scoped (`WHERE userId = actor`), already cross-workspace; NO new inbox data source is created. (AS-001, AS-003)

C-002: Read-own-only + existence-hiding. Every read and every mark (one / all / count) is scoped to the caller; a mark on a notification that isn't theirs is a no-op, never an error that reveals the row exists — inherited from the bell's read surface. (AS-006, AS-008, AS-010)

C-003: The inbox NEVER bypasses the source action's own authorization. Reply/resolve go through the existing annotation gate (comment permission on the doc); accept/decline go through the existing invitation routes (the token is bound to the caller's email). The inbox only invokes them. (AS-013, AS-014, AS-015, AS-016, AS-017)

C-004: The **Your actions** tab is out of scope here (sibling spec `your-activity-actions`, 2b). This spec renders the tab as a present-but-empty placeholder so the shell is complete; 2b fills it. (no AS — structural)

C-005: Only the notification types the bell already produces appear in v0 (reply / thread_activity, new_feedback, resolved, workspace_invited). `@`-mentions are NOT in v0 (separate spec 3); the page subtitle must not promise "mentions". (AS-001)

C-006: Day grouping is rendered client-side over the flat paged list (a day may straddle a page boundary; same-day headers merge/dedupe across consecutive fetches); "Today/Yesterday" are computed in the VIEWER's timezone. The page **loads more** beyond page 1 (the existing read caps at 50/page) — it is a full surface, not the bell's recent-N; occasional page-drift on consecutive fetches is acceptable (manual surface, no realtime). (AS-002, M2)

C-007: An inbox invite action targets the INVITATION id, which the `workspace_invited` notification must carry (its `refId` is the workspace id). This is a cross-spec contract on `workspace-notifications` (Linked Fields + GAP-001) — the notification persists + serves `invitationId`. Acting on a revoked/already-settled invite degrades gracefully ("no longer available"), never a dead 404. (AS-016, AS-017, AS-019)

C-008: Marking read on the inbox is a deliberate engagement signal — opening an item's DETAIL marks it read (distinct from the bell's C-009, where opening the dropdown panel does NOT mark read; the bell only marks on click). The explicit row-level "mark read" and "mark all" remain. (AS-006)

C-009: The For-you list is the caller's notifications across workspaces; v0 does NOT filter out notifications from workspaces the user has since LEFT (matching the existing bell, which is user-scoped with no membership filter) — such an item's workspace chip names a workspace the user is no longer in. Whether to filter these is deferred (GAP-002). (AS-001; GAP-002)

## Linked Fields

- `invitationId` — consumed by `your-activity-inbox:S-005` (AS-016/AS-017) on the **`workspace_invited` notification row** read from `GET /api/me/notifications` (persisted + served on every read, so a re-opened inbox still has it). Produced by **`workspace-notifications`** as the row's **`refId`** (its AS-010 / Data Model, locked 2026-06-23 — `workspace_invited` `refId` = the invitation id; `refLabel` = the workspace name). **✔ produced** (GAP-001 resolved). Seam test: with a real pending invite, the inbox's accept call reaches `POST /api/invitations/:refId/accept` and succeeds (not 404). Cross-spec seam — verify against a running `workspace-notifications` emit, not a mock.
- **`ForYouContent` component** — produced by THIS spec (S-001): the For-you inbox (list + detail + actions) is built as a **standalone, composable `ForYouContent`** component, separable from the `/me/activity` page wrapper, so the sibling `your-activity-actions` (2b) can mount it as tab 1 when it introduces the two-tab bar. Consumed by `your-activity-actions:S-002` (AS-011). ✔ exported as composable (resolves 2b:GAP-003).

## UI Notes

- `YourActivityPage` *(route `/me/activity`, account-scoped — sibling of `/settings`)*
  - `YourActivityHead`: "Account" label + "Your activity" title + subtitle (replies & feedback across your workspaces — NOT "mentions", C-005)
  - `YourActivityTabs`: **For you** (with unread count pill) | **Your actions** *(placeholder until 2b — C-004)*
  - `InboxBar` *(For you only)*: `UnreadOnlyToggle` + `MarkAllReadButton`
  - `InboxDayGroup`: day label
    - `InboxRow`: type node-icon + actor avatar + sentence + `WorkspaceChip` + doc chip + time + unread dot + row `MarkReadButton` — opens detail on click
  - `InboxDetail`: back link, hero (type icon + sentence + badge + time), KV (from / workspace / document / when / invited-as), quote + body, then one of:
    - `ReplyComposer` + `ResolveButton` *(reply-eligible items, S-004)*
    - `AcceptDeclineRow` *(invite items, S-005)*
    - `OpenInDocButton` *(other items with a doc, S-003)*
  - *(empty / loading / error / no-unread states reuse existing primitives — see UI Inventory)*

> Source-of-truth: prototype `Anchord-Design/personal.jsx` + `personal.css` (canonical on conflict; naming/shape only).

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| Notification client | `apps/web/src/features/notifications/services/client.ts` | reuse `listNotifications` / `fetchUnreadCount` / `markNotificationRead` / `markAllNotificationsRead` as-is |
| `useNotifications` / `useUnreadCount` | `apps/web/src/features/notifications/hooks/use-notifications.ts` | reuse for the list + count (the page is a second consumer of the same slice) |
| Notification formatters | `apps/web/src/features/notifications/lib/format.ts` | reuse sentence/snippet formatting |
| `Tabs` | `apps/web/src/components/ui/tabs.tsx` | reuse for For-you / Your-actions tabs |
| `EmptyState` / `ErrorState` / `Skeleton` | `apps/web/src/components/*` | reuse for empty / error / loading states |
| `Avatar` / `Badge` / `Icon` / `Card` | `apps/web/src/components/**` | reuse for rows, chips, detail |
| `UserMenu` | `apps/web/src/app/user-menu.tsx` | add a "Your activity" entry (alongside Settings) |

### System Impact & Technical Risks

- **Notification read API** `apps/backend/src/routes/notifications.ts` + `apps/backend/src/notify/read-repo.ts` — already user-scoped, cross-workspace, returns `id, type, refId, read, createdAt, slug, docTitle, actorName, snippet, refLabel`. The ONLY backend change: add `workspaceId` + `workspaceName` to the enrichment join (doc/annotation chain, and `workspace_*` types where `refId` is the workspace). Low risk, additive.
- **Reply path** `apps/backend/src/routes/annotations.ts` (`POST /api/annotations/:id/comments`) — `refId` on the notification is the annotation id; reply posts there. The route enforces comment permission (C-003) — the inbox surfaces refusals, doesn't bypass.
- **Invite accept/decline** `apps/backend/src/routes/workspaces.ts` (`POST /api/invitations/:id/accept` → `{ workspaceId, role }`, `POST /api/invitations/:id/reject` → `{ rejected: true }`) — both exist; token bound to the caller's server-resolved email (L2: response shapes pinned). **But the accept/decline need the INVITATION id, which the notification must carry — see C-007 / GAP-001 (cross-spec).** Reply-gate caveat (M5): the annotation comment route gates on DOC access, not current workspace membership — a member removed from a workspace but with stale/public doc access could still reply via the notification's `refId` (GAP-003, owner = doc-access / annotation-core).
- **Mark/unread endpoints** `apps/backend/src/routes/notifications.ts` (`/:id/read`, `/read-all`, `/unread-count`) — reused as-is. Read-own scoping (`WHERE userId = actor`) inherited; a foreign mark is a no-op (C-002).
- **FE type sync (H1):** the FE notification `NotificationType` union + `NotificationItem` must add the `workspace_*` types and the `refLabel` field (currently omitted) or `workspace_invited` rows won't render. Additive; rides S-001.
- **Risk — shared page shell with 2b (M7):** 2a renders the For-you page with NO empty second tab; 2b introduces the tab bar + "Your actions" and composes 2a's For-you components. Whichever ships second owns the tab container — built exactly once.

## Not in Scope

- **Your actions tab** — sibling spec `your-activity-actions` (2b); depends on the `workspace-activity` `activity` table. Placeholder tab only here (C-004).
- **`@`-mentions** — separate spec 3 (no mention backend exists); not surfaced here (C-005).
- **Realtime** — the inbox uses the existing polled/manual read (the bell polls the count every 45s); no websocket.
- **A new notifications data model** — none; this is a read-surface presentation over the existing `notifications` table.
- **Per-item delete / archive** — not in the prototype; mark-read is the only state change.

## Gaps

GAP-001 (status: resolved): `workspace-notifications` (AS-010, locked 2026-06-23) sets the `workspace_invited` row's `refId` = the invitation id (with `refLabel` = the workspace name), so the inbox accept/decline (S-005) target it directly. Cross-spec contract pinned both sides (Linked Fields). Source: /mf-challenge 2026-06-23 (assumption lens).

GAP-002 (status: open): Should the For-you list filter out notifications from workspaces the user has since LEFT? v0 matches the existing bell (no membership filter → such items still show, workspace chip names a left workspace). Decide filter-vs-persist; affects the workspaceId enrichment exposure (C-009). Source: /mf-challenge 2026-06-23 (security lens, SEC-1/SEC-4).

GAP-003 (status: open): The annotation reply route gates on DOC access, not current workspace membership — a member removed from a workspace but with stale/public doc access could reply to a thread via a notification's `refId`. Owner = doc-access / annotation-core (out of scope for 2a; 2a only invokes the route). Source: /mf-challenge 2026-06-23 (security lens, SEC-2).

GAP-004 (status: deferred): If a user changes their account email after being invited, the invite's target-email binding no longer matches and accept 404s. Edge case; deferred (revisit if email-change ships). Source: /mf-challenge 2026-06-23 (security lens, SEC-3).

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-23 | Initial creation (personal page split — spec 2a For-you inbox; mention → spec 3; Your-actions → spec 2b) | -- |
| 2026-06-23 | Minor — For-you built as a standalone composable `ForYouContent` (for-you-content.tsx), exported for `your-activity-actions` (2b) to mount as tab 1 (resolves 2b:GAP-003); +Linked Field producer entry. Additive, no AS change. | 2b cross-spec lock |
| 2026-06-23 | Minor — GAP-001 resolved: `workspace-notifications` now carries the invitation id as the `workspace_invited` row's `refId` (its AS-010); S-005 reads `refId` for accept/decline. Linked Field ✘→✔, blocker note + Data Model updated. No AS change here. | invitationId cross-spec lock |
| 2026-06-23 | Major (snapshot 2026-06-23-pre-challenge.md) — /mf-challenge 3-lens hardening (inline actions kept in v0): +C-007 (invite-id contract), +C-008 (mark-on-detail-open divergence from bell C-009), +C-009 (left-workspace notifications persist), +Linked Fields (`invitationId` ← workspace-notifications, ✘→GAP-001), +AS-019 (revoked/settled invite degrades gracefully); Data Model (+invitationId dependency, +FE type-sync prereq, enrichment additive); AS-006 (mark-on-detail-open), AS-012 ("Open in doc" doc-types only); S-005 blocker note + files; System Impact (response shapes, reply-gate caveat, FE types, shell M7); +GAP-001..004. AS 18→19. | /mf-challenge 2026-06-23 |
