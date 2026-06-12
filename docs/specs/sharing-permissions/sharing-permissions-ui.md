# Spec: sharing-permissions-ui

**Created:** 2026-06-12
**Last updated:** 2026-06-13 (rev 4)
**Status:** Draft

## Overview

The **ShareDialog** — the FE consumer of the already-built `sharing-permissions` backend
(producer). An owner (or an editor when `editors_can_share` is on) opens the dialog from the
viewer's Share button, sets general access (Restricted / Anyone-in-workspace / Anyone-with-link)
+ the associated role (viewer | commenter | editor only), toggles guest commenting (only when
Anyone-with-link), invites people by email + role + message (no-account → pending), manages a
people list, and — when Anyone-with-link — copies the link and sets optional password / expiry /
view-limit controls. A viewer/commenter sees no Share affordance (or read-only). Every mutation
is optimistic-with-rollback on a refused write.

This spec owns only the **share dialog + its wiring**. It does NOT own backend enforcement, the
anonymous link-open / password-prompt route (that's `render-publish`'s `/d` · `/v` viewer), the
doc viewer itself, or the role-precedence engine. It consumes three backend mutations
(`PUT /access`, `POST /invites`, `PUT /link`), the `GET …/share` prefill read (backend S-006),
and the `effectiveRole` read-payload field.

## Data Model

No persistent data — a client. Local/client state only; the backend is the source of truth and
re-authorizes every write (C-007 backend). The dialog reads `effectiveRole` from the doc read
payload (`render-publish GET /api/w/:ws/docs/:slug`) to gate the Share affordance, then on OPEN
reads its full prefill state (access level, role, guest, `editorsCanShare`, people list, link
controls) from `GET /api/w/:ws/docs/:slug/share` (backend `sharing-permissions:S-006`), then
mutates via the typed client.

Client state held by the dialog while open:
- `generalAccess`: `restricted | anyone_in_workspace | anyone_with_link` (mirrors `docs.general_access`).
- `accessRole`: `viewer | commenter | editor` (the role attached to the chosen general access; never `owner`).
- `guestCommenting`: bool (only meaningful + editable when `generalAccess === anyone_with_link`).
- `editorsCanShare`: bool (visible to all who can manage; editable by the **owner only**).
- `linkControls`: `{ password?: string; expiresAt?: string; viewLimit?: number }` (all optional, anyone-with-link only).
- `inviteDraft`: `{ email: string; role: viewer|commenter|editor; message?: string }`.
- `people[]`: `{ userId?: string; email: string; name?: string; role; status: active|pending }` rows (read from the doc/share read).

Read-payload fields consumed (as built / owed):
- `effectiveRole` on the doc read response (`viewer | commenter | editor | owner`, added in
  `annotation-core-ui-commenting`) → drives `canManageShare` (C-007 mirror): owner always; editor
  only when `editorsCanShare` is on; viewer/commenter never. ABSENT `effectiveRole` is treated as
  NOT able to manage (conservative — a missing role must not expose the editable dialog; the server
  would 403 the write anyway). NOTE: `canManageShare` ALSO needs `editorsCanShare` for the
  editor case; this is delivered by the dialog's `GET …/share` prefill read (backend S-006), not
  the doc read payload (GAP-002/003 RESOLVED).

## Stories

### S-001: Open the Share dialog from the viewer (P0)

**Description:** As someone who can manage sharing, I click the viewer's Share button and the
ShareDialog opens — a centered modal on desktop, a full-screen sheet ≤600px. A viewer/commenter
sees no Share button (or it is inert); an unauthorized open is never shown the editable dialog.
**Source:** Consumes backend C-007 (who may manage) + `effectiveRole` read field. Prototype:
`Anchord-Design/viewer-dialogs.jsx` `ShareDialog` (P16) inside `Dialog{wide:true}`; entry point
`apps/web/src/features/viewer/viewer-top-bar.tsx` `onShare` (placeholder this wires).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` new `apps/web/src/features/sharing/share-dialog.tsx`; wire `features/viewer/viewer-top-bar.tsx` (`onShare`) + the viewer screen that passes the placeholder (`features/viewer/viewer-screen.tsx`); ALSO the docs-list entry (AS-019): refactor `features/docs/move-copy-dialog.tsx` `DocMoreMenu` from a direct MoveCopy open into a ⋯ dropdown (Share · Move · Copy) reusing `components/ui/dropdown-menu.tsx` (mirrors `features/docs/project-more-menu.tsx` `ProjectCardMoreMenu`); reuse `components/ui/dialog.tsx` (desktop modal) + `components/ui/sheet.tsx` (≤600 full-screen)
- `autonomous:` true
- `verify:` open a doc as owner → click Share → dialog appears with the four sections; resize ≤600 → it is a full-screen sheet; open as a viewer → no editable dialog (button absent or inert); on the docs list, the doc-card ⋯ opens a menu with a Share item that opens the same dialog for that doc.

**Acceptance Scenarios:**

AS-001: Owner opens the Share dialog
- **Given:** an owner has a doc open in the viewer
- **When:** they click the Share button in the top bar
- **Then:** the ShareDialog opens showing General access, Guest commenting, Link (when anyone-with-link), and Invite people / People list sections, prefilled from the doc's current sharing state
- **Data:** owner, doc currently restricted

AS-002: Responsive — full-screen sheet ≤600
- **Given:** the ShareDialog is reachable
- **When:** the viewport width is ≤600px and the dialog opens
- **Then:** it renders as a full-screen sheet (not a narrow centered modal); ≥601px it is a centered modal
- **Data:** 360px and 768px widths

AS-003: A non-manager who opens the dialog gets the read-only surface (lazy gate)
- **Given:** a user who cannot manage sharing (viewer/commenter, or an editor when `editors_can_share` is off) opens the Share dialog
- **When:** the dialog's `GET …/share` prefill read is REFUSED (the read is gated server-side identically to the writes, backend C-016)
- **Then:** the dialog shows a read-only "you can't manage sharing" surface — never the editable controls; the management controls are unreachable. (In the viewer top bar, the Share button is additionally hidden for a viewer/commenter as a pre-read hint via `effectiveRole`.)
- **Data:** commenter opens the dialog → read refused → read-only surface

AS-004: A manager who opens the dialog gets the editable controls (lazy gate)
- **Given:** a user who can manage sharing (owner, or an editor when `editors_can_share` is on) opens the Share dialog
- **When:** the gated `GET …/share` prefill read SUCCEEDS
- **Then:** the editable controls are shown — a successful read IS the proof of manage-eligibility (the backend gated it, C-016); the dialog does not need to pre-decide from `effectiveRole`
- **Data:** editor with editors_can_share on → read succeeds → editable dialog

AS-018: The dialog prefills its current sharing state on open (happy path)
- **Given:** a manager opens the Share dialog on a doc that already has a general-access level,
  role, guest setting, people, and link controls
- **When:** the dialog opens, it reads `GET /api/w/:ws/docs/:slug/share`
- **Then:** it shows the doc's CURRENT sharing state — general-access level, role, guest-commenting
  toggle, `editorsCanShare`, the people list (active + pending), and the link controls (incl.
  whether a password is set) — not a blank form
- **Data:** anyone-with-link/commenter, guest on, 1 active + 1 pending person, a password link

AS-019: Open the Share dialog from the docs-list doc-card ⋯ menu
- **Given:** any user on the docs list looking at a doc card's ⋯ button
- **When:** they open the ⋯ menu and choose Share
- **Then:** the ⋯ presents a menu offering Share · Move · Copy (no longer opening Move/Copy
  directly), and choosing Share opens the same ShareDialog for that doc — the Share item is shown
  UNCONDITIONALLY (no per-doc role is preloaded into the list); the dialog's own gated read then
  decides editable vs read-only (lazy gate, AS-003/AS-004), like Google Docs
- **Data:** a doc card in the browse list (manager → editable; non-manager → read-only surface)

### S-002: Set general access + role + guest commenting (P0)

**Description:** As someone who can manage sharing, I pick the general-access level via a segmented
control and the associated role via a dropdown (viewer | commenter | editor only — owner never
selectable), and toggle guest commenting, which is enabled only for Anyone-with-link. The change
persists via `PUT /access`; a refused write reverts.
**Source:** Consumes backend S-001 (AS-001/002/003/018/022), C-003 (guest gating), C-012
(role ∈ {viewer,commenter,editor}), C-015 (`editors_can_share` owner-only); `PUT /api/w/:ws/docs/:slug/access`.
Prototype: `ShareDialog` `.ga-seg` + `.mini-select` + `.switch-row` (guest), `.access-hint`.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` new `apps/web/src/features/sharing/access-section.tsx`; new `features/sharing/client.ts` (`setAccess`); reuse the prototype `.ga-seg` segmented control + role `Select` (`components/ui/select.tsx`) + the `.switch` toggle
- `autonomous:` true
- `verify:` set Anyone-with-link + commenter → `PUT /access` fires, hint updates, guest toggle enables; set Restricted → guest toggle disables; force the PUT to fail → the segmented control reverts + an error shows.

**Acceptance Scenarios:**

AS-005: Set Anyone-with-link with a role (happy path)
- **Given:** the dialog is open on a restricted doc
- **When:** the manager selects general-access = Anyone-with-link and role = commenter
- **Then:** `PUT /api/w/:ws/docs/:slug/access` is called with `{ level: "anyone_with_link", role: "commenter" }`; on 200 the segmented control + hint reflect the new state and the Link section appears
- **Data:** anyone_with_link + commenter

AS-006: A refused access change reverts (error path)
- **Given:** the manager flips general-access optimistically
- **When:** `PUT /access` comes back 403 or fails (e.g. role revoked, network)
- **Then:** the segmented control + role revert to the prior value and an error is shown ("couldn't update access"); no silent partial state
- **Data:** PUT refused

AS-007: Role dropdown never offers owner
- **Given:** the access (or invite) role dropdown is open
- **When:** the manager looks at the options
- **Then:** only viewer, commenter, and editor are offered; owner is never selectable (mirrors backend C-012 / AS-018); a forged owner value would be rejected by the server
- **Data:** options = {viewer, commenter, editor}

AS-008: Guest commenting toggle enabled only for Anyone-with-link
- **Given:** the dialog is open
- **When:** general-access is Restricted or Anyone-in-workspace, then switched to Anyone-with-link
- **Then:** the guest-commenting toggle is disabled (with the hint "Available only for Anyone with link") while not Anyone-with-link, and becomes enabled once Anyone-with-link is selected (backend C-003); enabling it sends `guestCommenting: true` on `PUT /access`
- **Data:** restricted → toggle disabled; anyone_with_link → toggle enabled

AS-009: editors_can_share toggle is shown but owner-editable only
- **Given:** the dialog is open
- **When:** the viewer is the owner, then an editor (with manage rights)
- **Then:** the owner sees the `editors_can_share` toggle editable (sends `editorsCanShare` on `PUT /access`); an editor sees it read-only/absent (cannot change it — backend C-015 / AS-022)
- **Data:** owner editable; editor read-only

### S-003: Invite by email with role + message (P0)

**Description:** As someone who can manage sharing, I invite a person by email + role + optional
message; if they have no account the invite shows as Pending. A malformed email is rejected inline
before the request.
**Source:** Consumes backend S-003 (AS-007/008), C-006 (pending keyed by email); `POST /api/w/:ws/docs/:slug/invites`.
Prototype: `ShareDialog` `.invite-row` (`.invite-field` + email input + Invite button); reuse the
`members-screen.tsx` invite pattern (Zod email validation, role control, pending tag).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` new `apps/web/src/features/sharing/invite-row.tsx`; `features/sharing/client.ts` (`invitePerson`); pattern from `features/workspaces/members-screen.tsx` `InviteRow` (Zod resolver, email validation, role toggle/select)
- `autonomous:` true
- `verify:` invite an existing-account email → row appears active; invite a no-account email → row appears with a Pending tag; a malformed email is blocked inline with no request; force the POST to fail → optimistic row removed + error.

**Acceptance Scenarios:**

AS-010: Invite an existing account (happy path)
- **Given:** the dialog is open and `dev@acme.com` already has an account
- **When:** the manager enters `dev@acme.com`, role = editor, message = "please review", and clicks Invite
- **Then:** `POST /api/w/:ws/docs/:slug/invites` is called with `{ email, role: "editor", message }`; on 201 `{ status: "active" }` a person row is added to the people list with the editor role and no Pending tag
- **Data:** editor + message

AS-011: Invite a no-account email → Pending
- **Given:** `bob@x.com` has no account
- **When:** the manager invites `bob@x.com` and the POST returns 201 `{ status: "pending" }`
- **Then:** a person row appears with a "Pending" tag (the prototype `.badge.amber`); it activates server-side when Bob signs up (not this FE's job)
- **Data:** status pending

AS-012: A malformed email is blocked inline (error path)
- **Given:** the invite field
- **When:** the manager types `not-an-email` and tries to Invite
- **Then:** the Invite button is disabled / an inline validation error shows ("Enter a valid email address"); no request is sent (same inline Zod check as members-screen AS-012)
- **Data:** `not-an-email`

AS-013: A refused invite reverts (error path)
- **Given:** the manager submits a valid invite optimistically
- **When:** `POST /invites` returns 403/400 or fails
- **Then:** the optimistically-added row is removed and an error is shown; the people list returns to its prior state
- **Data:** POST refused

### S-004: People list with role + pending (P1)

**Description:** As someone who can manage sharing, I see every invited person as a row with an
avatar, name, role, and a Pending tag when not yet active; the owner row shows a static "Owner"
label (owner is not a reassignable role).
**Source:** Consumes the people/share read state (the doc/share read; **owed — GAP-003**) +
backend C-012 (owner not assignable). Prototype: `ShareDialog` `.person-row` (`.avatar` ·
`.person-info` name/email · `.person-role` / `.mini-select` · `.badge.amber` Pending). Reuse
`members-screen.tsx` `MemberRowView` patterns.

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` new `apps/web/src/features/sharing/people-list.tsx`; reuse `lib/initials` (`initials`/`avatarColor`) + the `members-screen.tsx` row layout + `components/ui/select.tsx` role control
- `autonomous:` true
- `verify:` open a doc with an owner + an active member + a pending invite → three rows render with the right avatar/name/role; the owner row shows "Owner" (no dropdown); the pending row shows a Pending tag.

**Acceptance Scenarios:**

AS-014: People list renders rows with role + pending
- **Given:** a doc shared with the owner, an active editor, and a pending invitee
- **When:** the dialog opens
- **Then:** three person rows show — avatar + name + email + role; the active editor has an editable role dropdown (viewer/commenter/editor), the pending invitee shows a "Pending" tag, and the owner shows a static "Owner" label with no dropdown
- **Data:** owner + active editor + pending invitee

### S-005: Link controls (P1)

**Description:** As someone who can manage sharing on an Anyone-with-link doc, I copy the link and
set optional password / expiry / view-limit controls via chips; changes persist via `PUT /link`.
The Link section appears only when general-access is Anyone-with-link.
**Source:** Consumes backend S-004 (AS-009/010/011), C-001 (controls attach to the link, each
independent); `PUT /api/w/:ws/docs/:slug/link`. Prototype: `ShareDialog` `.link-row` (`.link-url` code +
Copy) + `.link-chips` (`.link-chip` Password / Expiry / View limit, `.on` when set).

**Execution:**
- `depends_on:` S-002
- `parallel_safe:` false
- `files:` new `apps/web/src/features/sharing/link-controls.tsx`; `features/sharing/client.ts` (`setLinkControls`); reuse `components/ui/input.tsx` for the password/expiry/limit fields
- `autonomous:` true
- `verify:` set Anyone-with-link → Link section shows the URL + Copy + chips; click Copy → link on clipboard + toast; set a chip (e.g. expiry) → `PUT /link` fires and the chip reads "set"; force the PUT to fail → the chip reverts + error.

**Acceptance Scenarios:**

AS-015: Copy the link
- **Given:** the doc is Anyone-with-link and the Link section is visible
- **When:** the manager clicks Copy
- **Then:** the share URL is written to the clipboard and a "Link copied" toast shows
- **Data:** clipboard write

AS-016: Set a link control (happy path)
- **Given:** the Link section is visible
- **When:** the manager sets a password (or expiry, or view-limit)
- **Then:** `PUT /api/w/:ws/docs/:slug/link` is called with that control (e.g. `{ password }`); on 200 the chip reflects the set state (the prototype `.link-chip.on`, "Expiry · set"); the other controls are independent (C-001)
- **Data:** password set; expiry unset

AS-017: A refused link-control change reverts (error path)
- **Given:** the manager sets a control optimistically
- **When:** `PUT /link` returns 403 or fails
- **Then:** the chip reverts to its prior state and an error is shown; no partial control persists
- **Data:** PUT refused

### S-006: Change or remove a person in the share list (P1)

**Description:** As someone who can manage sharing, I change an existing member's role from the
people-list dropdown, or remove a person (active member or pending invite) via a Remove control;
both persist to the backend and roll back on a refused write. The owner row has neither control.
**Source:** Consumes backend `sharing-permissions:S-007` (AS-028/029/030/031/032), C-017 (gated like
the writes, owner protected); `PATCH …/members/:id` + `DELETE …/members/:id`. Resolves GAP-005.
Prototype: `ShareDialog` `.person-row` `.person-role` dropdown + a row Remove affordance.

**Execution:**
- `depends_on:` S-004
- `parallel_safe:` false
- `files:` `apps/web/src/features/sharing/people-list.tsx` (wire the dropdown onChange + a Remove
  control); `features/sharing/client.ts` (`changeMemberRole`, `removeMember`); the dialog's people
  state (optimistic update + rollback)
- `autonomous:` true
- `verify:` change a member's role in the dropdown → `PATCH …/members/:id` fires, the row reflects
  the new role; remove a person → `DELETE …/members/:id` fires, the row disappears; force either to
  fail → the row reverts + an error shows; the owner row shows no dropdown and no Remove.

**Acceptance Scenarios:**

AS-020: Change a member's role (happy path)
- **Given:** the people list shows an active member at the commenter role; the dialog is in manage mode
- **When:** the manager picks "editor" in that row's role dropdown
- **Then:** `PATCH /api/w/:ws/docs/:slug/members/:id` is called with `{ role: "editor" }`; on success the
  row shows the editor role (optimistically, then confirmed)
- **Data:** commenter → editor

AS-021: A refused role change reverts (error path)
- **Given:** the manager changes a member's role optimistically
- **When:** `PATCH …/members/:id` returns 403 or fails
- **Then:** the row's role reverts to its prior value and an error is shown; no partial state
- **Data:** PATCH refused

AS-022: Remove a person (happy path)
- **Given:** the people list shows an active member (or a pending invite); the dialog is in manage mode
- **When:** the manager clicks Remove on that row
- **Then:** `DELETE /api/w/:ws/docs/:slug/members/:id` is called; on success the row disappears from the
  people list (optimistically, then confirmed)
- **Data:** remove an active member

AS-023: A refused removal restores the row (error path)
- **Given:** the manager removes a person optimistically
- **When:** `DELETE …/members/:id` returns 403 or fails
- **Then:** the removed row is restored and an error is shown; the people list returns to its prior state
- **Data:** DELETE refused

## Constraints & Invariants

FE-side mirrors of the backend constraints (the backend re-authorizes / enforces; these govern
what the dialog SHOWS and SENDS, never the security boundary).

- C-001 (mirror of backend C-003): The guest-commenting toggle is enabled only when
  `generalAccess === anyone_with_link`; otherwise it is disabled with the "Available only for
  Anyone with link" hint. (AS-008)
- C-002 (mirror of backend C-007, LAZY gate 2026-06-13): manage-eligibility is decided by the
  RESULT of the gated `GET …/share` prefill read, not by a pre-computed `effectiveRole` — a read that
  SUCCEEDS proves the caller can manage (the backend gated it identically to the writes, backend
  C-016) → editable controls; a read REFUSED (403/forbidden) → the read-only "can't manage" surface
  (distinct from a generic load error). `effectiveRole` is used ONLY as a pre-read hint to hide the
  viewer top-bar Share button for a viewer/commenter; the docs-list ⋯ shows Share unconditionally and
  lets the read decide (Google-Docs model). (AS-003, AS-004, AS-019)
- C-003 (mirror of backend C-015): The `editors_can_share` toggle is editable by the **owner only**;
  an editor who can manage sees it read-only (or hidden), never editable. (AS-009)
- C-004 (mirror of backend C-012): The access role and invite role dropdowns offer only
  `viewer | commenter | editor`; `owner` is never an option. The people list shows the owner with a
  static "Owner" label and NO role dropdown / NO Remove control (not a reassignable or removable
  member, backend C-017). (AS-007, AS-014, AS-020, AS-022)
- C-005: Every mutation (`PUT /access`, `POST /invites`, `PUT /link`, `PATCH …/members/:id` role
  change, `DELETE …/members/:id` remove) is OPTIMISTIC but ROLLS BACK on a refused/failed write — the
  control/row reverts to its prior value and an error is shown; no ghost row / partial state is left
  behind. (AS-006, AS-013, AS-017, AS-021, AS-023) (mirrors the optimistic-rollback rule in
  `annotation-core-ui-commenting` C-011.)
- C-006: A malformed email is rejected inline (same Zod email check as `members-screen`) BEFORE the
  request — a bad email never reaches `POST /invites`. (AS-012)
- C-007: The Link section (URL + Copy + chips) is shown only when `generalAccess === anyone_with_link`;
  it is hidden for restricted / anyone-in-workspace. (AS-015, AS-016)

## Linked Fields

`sharing-permissions-ui` is the **consumer**; `sharing-permissions` (backend) is the producer.
Surface = the typed Eden client `features/sharing/client.ts` calling the three management routes;
lifecycle = on dialog mutation (per-control), optimistic then reconciled/rolled-back.

- `PUT /api/w/:ws/docs/:slug/access` `{ level, role, guestCommenting?, editorsCanShare? }` → `{ level, role,
  guestCommenting, editorsCanShare }` — consumed by S-002 (AS-005/006/008/009). Produced by backend
  S-001. ✔ path RESOLVED (GAP-001): the backend CODE serves the workspace-scoped path
  (`apps/backend/src/routes/sharing.ts:201`); the backend spec's `## API` table showing `/api/docs/:slug`
  is STALE (same class as `annotation-core-ui:GAP-001`, fixed by matching the real route).
- `POST /api/w/:ws/docs/:slug/invites` `{ email, role, message? }` → 201 `{ status: active|pending }` —
  consumed by S-003 (AS-010/011/013). Produced by backend S-003 (`sharing.ts:243`). ✔ workspace-scoped (GAP-001 resolved).
- `PUT /api/w/:ws/docs/:slug/link` `{ password?, expiresAt?, viewLimit? }` → `{ link controls }` — consumed
  by S-005 (AS-016/017). Produced by backend S-004 (`sharing.ts:279`). ✔ workspace-scoped (GAP-001 resolved).
- `effectiveRole` on the doc read payload (`viewer|commenter|editor|owner`) — consumed by S-001 to
  gate `canManageShare` (C-002). Produced by `render-publish`/`annotation-core-ui-commenting`'s doc
  read. ✔ field exists on the viewer read payload (`features/viewer/client.ts`).
- `GET /api/w/:ws/docs/:slug/share` → `{ level, role, guestCommenting, editorsCanShare, people[],
  link{ hasPassword, expiresAt, viewLimit, viewCount, url } }` — consumed by S-001 (AS-018) on
  dialog OPEN to PREFILL the whole dialog state (current general-access, role, guestCommenting,
  `editorsCanShare`, people[], link controls incl. `hasPassword`); also feeds S-002/S-004/S-005
  initial values. Produced by backend `sharing-permissions:S-006`. ✔ surface (dialog-open read) +
  lifecycle match (read once on open, then per-control writes reconcile). RESOLVED GAP-003.
- `editorsCanShare` — delivered by that same `GET …/share` read (NOT the doc read payload), so the
  editor manage-eligibility (C-002 / S-001 AS-004) is decidable client-side once the dialog opens.
  Produced by backend `sharing-permissions:S-006`. ✔ RESOLVED GAP-002.
- `PATCH /api/w/:ws/docs/:slug/members/:id` `{ role }` → `{ role }` AND
  `DELETE /api/w/:ws/docs/:slug/members/:id` → `{ removed: true }` — consumed by S-006 (AS-020/021/022/023)
  on a per-row people-list mutation (optimistic, then reconciled/rolled-back). Produced by backend
  `sharing-permissions:S-007`. ✔ workspace-scoped; gated like the other writes (backend C-017).
  RESOLVED GAP-005.

## UI Notes

Design: prototype `Anchord-Design/viewer-dialogs.jsx` `ShareDialog` (P16) is CANONICAL, styled by
`Anchord-Design/viewer-dialogs.css` (`.share-sec`, `.access-row`, `.ga-seg`, `.mini-select`,
`.access-hint`, `.switch-row`/`.switch`, `.link-row`/`.link-url`/`.link-chips`/`.link-chip`,
`.person-row`/`.person-info`/`.person-role`); tokens from `Anchord-Design/tokens.css` +
`viewer.css`. The dialog uses the existing `Dialog{wide:true}` chrome. Precedence:
AS / Constraints > prototype > Tree. All components new `[N]`.

- `ShareDialog` `[N]` *(desktop = centered `Dialog` (wide); **full-screen sheet** ≤600px via
  `components/ui/sheet.tsx`, per DESIGN.md Responsive + backend UI Notes; title "Share doc",
  doc-title subtext, a "Done" footer button)*
  - `AccessSection` `[N]` *(`.share-sec` "General access")*: `GeneralAccessSegmented` `.ga-seg`
    (Restricted · Anyone in workspace · Anyone with link) + role `Select` `.mini-select`
    (viewer | commenter | editor) + `.access-hint` (icon + per-level sentence)
  - `GuestCommentingToggle` `[N]` *(`.switch-row` `.switch`; ENABLED only when Anyone-with-link —
    C-001; hint "Available only for Anyone with link" otherwise)*
  - `EditorsCanShareToggle` `[N]` *(`.switch-row` `.switch`; visible to managers, EDITABLE by the
    owner only — C-003; read-only/absent for an editor)*
  - `LinkControls` `[N]` *(`.share-sec` "Link"; shown only when Anyone-with-link — C-007)*:
    `.link-url` (link · Copy) + `.link-chips` (`PasswordChip` · `ExpiryChip` · `ViewLimitChip`,
    `.on` when set — all optional)
  - `InviteRow` `[N]` *(`.share-sec` "Invite people"; `.invite-field` email input + role +
    Invite button; optional message)*
  - `PeopleList` `[N]` → `PersonRow` `[N]` *(`.person-row`: `.avatar` · name · email · role
    (`Select` for active, static "Owner" for the owner) · `PendingTag` `.badge.amber`)*

Two entry points (AS-001, AS-019): (1) the viewer top bar's Share button
(`features/viewer/viewer-top-bar.tsx` `vt-share`, currently a placeholder `onShare`); (2) the
docs-list doc-card ⋯ — refactored from a direct `MoveCopyDialog` open into a `DocMoreMenu` dropdown
(`features/docs/move-copy-dialog.tsx`) offering **Share · Move · Copy** (reusing
`components/ui/dropdown-menu.tsx`, mirroring `features/docs/project-more-menu.tsx`
`ProjectCardMoreMenu`). Both open the same `ShareDialog` (GAP-004 resolved).

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| Share button (placeholder `onShare`) | `apps/web/src/features/viewer/viewer-top-bar.tsx` (`vt-share`) | wire it to open the new ShareDialog (S-001) |
| Viewer screen (passes the `onShare` placeholder) | `apps/web/src/features/viewer/viewer-screen.tsx` | host the dialog open-state + pass `effectiveRole`/share state |
| Doc read payload (`effectiveRole`, `generalAccess`) | `apps/web/src/features/viewer/client.ts` (`ViewerDocResponse`) | consume `effectiveRole` for `canManageShare`; needs `editorsCanShare` + people/link state added (GAP-003) |
| Invite-by-email + role + pending row patterns | `apps/web/src/features/workspaces/members-screen.tsx` (`InviteRow`, `MemberRowView`, `StatusBadge`, `inviteResolver`) | reuse the Zod email validation + the person-row layout + the Pending badge |
| Dialog primitive (desktop modal) | `apps/web/src/components/ui/dialog.tsx` | the ShareDialog shell ≥601px |
| Sheet primitive (full-screen ≤600) | `apps/web/src/components/ui/sheet.tsx` | the ShareDialog shell ≤600px (responsive) |
| Select / Input / Button / ConfirmDialog | `apps/web/src/components/ui/` + `components/confirm-dialog.tsx` | role dropdowns, link-control fields, buttons, any confirm |
| Avatar helpers | `apps/web/src/lib/initials.ts` (`initials`, `avatarColor`) | person-row avatars |
| Dialog wiring patterns | `apps/web/src/features/docs/new-doc-dialog.tsx`, `move-copy-dialog.tsx` | open-state, `stopPropagation`, toast, cache-invalidate patterns |
| Doc-card ⋯ menu (currently opens MoveCopy directly) | `apps/web/src/features/docs/move-copy-dialog.tsx` (`DocMoreMenu`) | refactor into a Share·Move·Copy dropdown (AS-019) |
| ⋯-dropdown menu pattern + primitive | `apps/web/src/features/docs/project-more-menu.tsx` (`ProjectCardMoreMenu`) + `components/ui/dropdown-menu.tsx` | mirror for the doc-card Share·Move·Copy menu |
| Typed-client pattern (Eden treaty) | `apps/web/src/features/workspaces/client.ts`, `features/viewer/client.ts` | new `features/sharing/client.ts` follows the same `treaty as any` + `EdenResult<T>` convention |
| toast | `sonner` (`import { toast }`) | success/error toasts |

### System Impact & Technical Risks

- The backend producer (`sharing-permissions`) is built; this is the FE consumer. The three WRITE
  routes exist (`PUT /access`, `POST /invites`, `PUT /link`); the READ surface to PREFILL the dialog
  (current access, people list, link controls, `editorsCanShare`) is now specified as backend
  `sharing-permissions:S-006` `GET …/share` (GAP-002/003 RESOLVED).
- Manage-eligibility is decided LAZILY by the gated `GET …/share` read result (C-002), so no per-doc
  role is preloaded into the docs list — the docs-list ⋯ shows Share unconditionally and the dialog's
  read gates it (Google-Docs model). GAP-001 (path) + GAP-004 (docs-list entry) RESOLVED.
- Change/remove a member (S-006) consumes backend `sharing-permissions:S-007` (`PATCH`/`DELETE
  …/members/:id`); GAP-005 RESOLVED.

## Not in Scope

- Backend enforcement of access / roles / link controls / precedence — `sharing-permissions`
  (backend). This FE only shows + sends; the server re-authorizes (backend C-007) and 403s a
  refused write (surfaced as C-005 rollback).
- The role-precedence engine (highest-role-wins across membership + per-doc share) — backend S-005;
  this FE only consumes the resulting `effectiveRole`.
- Anonymous link-open, the "you don't have access" / "link no longer available" pages, and the
  password-prompt-on-open — the `render-publish` viewer route (`/d/:slug` · `/v/:id`), NOT this
  dialog. This dialog SETS a password; the prompt that VERIFIES it on open is the viewer route.
- The doc viewer itself, the annotations rail, version history, diff — other specs.
- Pending-invite expiry countdown — backend has no expiry policy yet (GAP-006); v0 shows a static
  "Pending" tag. (Per-person remove / revoke + role-change ARE now in scope — S-006, GAP-005 resolved.)

## Gaps

- GAP-001 (status: RESOLVED — 2026-06-12, code-verified): the backend CODE serves the WORKSPACE-SCOPED
  paths `/api/w/:workspaceId/docs/:slug/{access,invites,link}` (`apps/backend/src/routes/sharing.ts:201/243/279`),
  matching every other app route. The "mismatch" was only in the backend spec's `## API` table, which
  still shows the un-scoped `/api/docs/:slug/…` and is STALE (same class as `annotation-core-ui:GAP-001`).
  FE pins the workspace-scoped path. Follow-up: `/mf-plan` the backend `sharing-permissions.md` API table
  to the real paths.
- GAP-002 (status: RESOLVED — 2026-06-12): `editorsCanShare` is now delivered by the share-state
  read `GET /api/w/:ws/docs/:slug/share` (backend `sharing-permissions:S-006` / AS-025), not the
  doc read payload. The editor manage-eligibility (S-001 AS-004 / C-002) is therefore decidable
  client-side once the dialog opens and reads the share state. Resolved by S-006.
- GAP-003 (status: RESOLVED — 2026-06-12): the prefill read surface now exists — backend
  `sharing-permissions:S-006` `GET /api/w/:ws/docs/:slug/share` returns
  `{ level, role, guestCommenting, editorsCanShare, people[], link{ hasPassword, expiresAt,
  viewLimit, viewCount, url } }` (AS-025; password exposed as a boolean only, C-016). The dialog
  reads it on OPEN to prefill general-access + role, guest-commenting, `editorsCanShare`, the
  people list (active + pending), and the link controls. Resolved by S-006.
- GAP-004 (status: RESOLVED — 2026-06-12): product decided v0 ADDS a docs-list Share entry. The
  doc-card ⋯ (`features/docs/move-copy-dialog.tsx` `DocMoreMenu`) is refactored from a direct
  MoveCopy open into a ⋯ dropdown (Share · Move · Copy, reusing `components/ui/dropdown-menu.tsx`,
  mirroring `ProjectCardMoreMenu`); Share opens the ShareDialog. Became AS-019 (S-001).
- GAP-005 (status: RESOLVED — 2026-06-13): remove-person / revoke-pending-invite + role-change now
  have backend routes (`sharing-permissions:S-007` — `PATCH`/`DELETE …/members/:id`), consumed by
  FE S-006 (AS-020..023). The people-list role dropdown persists and a Remove control deletes;
  optimistic + rollback (C-005). Owner row is exempt (C-004 / backend C-017).
- GAP-006 (status: DEFERRED — 2026-06-12, inherited): how long until a pending invite expires
  (backend GAP-002, still open). v0 FE behaviour is DEFINED + assertable: a pending person shows a
  static "Pending" tag with NO countdown/expiry. When the backend decides an expiry policy, the FE
  can add "Pending · expires in N" — that increment is the deferred work. Not a v0 blocker. Owner:
  backend/`sharing-permissions`.

## Consistency Checks

- CC1 (every AS traces to a story): AS-001..004 + AS-018 + AS-019 → S-001; AS-005..009 → S-002;
  AS-010..013 → S-003; AS-014 → S-004; AS-015..017 → S-005; AS-020..023 → S-006. ✔
- CC2 (every P0 has a happy + an error path): S-001 (AS-001/AS-018 happy / AS-003 read-only); S-002
  (AS-005 happy / AS-006 refused-revert); S-003 (AS-010 happy / AS-012 + AS-013 error). S-006 (P1):
  AS-020/022 happy / AS-021/023 refused-revert. ✔
- CC3 (every consumed backend field is in Linked Fields): `PUT /access`, `POST /invites`,
  `PUT /link`, `GET …/share` (prefill read), `effectiveRole`, `editorsCanShare` (via the share
  read) all listed. ✔
- CC4 (constraints trace to AS): C-001→AS-008, C-002→AS-003/004, C-003→AS-009, C-004→AS-007/014,
  C-005→AS-006/013/017, C-006→AS-012, C-007→AS-015/016. ✔
- CC5 (no backend relitigation): general-access levels, roles, guest gating, editors_can_share,
  precedence are CONSUMED as built; no backend decision is changed. ✔
- CC6 (unspecified outcomes recorded as GAPs, not invented): path mismatch (GAP-001 RESOLVED),
  `editorsCanShare` on read (GAP-002 RESOLVED via S-006), prefill read surface (GAP-003 RESOLVED
  via S-006), no docs-list entry (GAP-004 open), remove/revoke route (GAP-005 DEFERRED),
  pending-expiry (GAP-006 open, inherited). ✔
- CC7 (prototype cited as canonical): UI Notes pin `Anchord-Design/viewer-dialogs.jsx` P16 +
  `.css` classes. ✔
- CC8 (responsive mandate): AS-002 + UI Notes cover the ≤600 full-screen sheet. ✔
- CC9 (reuse over rebuild): UI Inventory reuses `members-screen` patterns, `ui/dialog`+`ui/sheet`,
  `lib/initials`, the Eden client convention. ✔

## Spec Sizing Notes

Stories = 6 (target ≤7). AS = 23 (target 20, in the G7 overage range ≤30). No sub-spec split needed —
one cohesive ShareDialog surface (T5/T6). The 3 AS over the soft target are G1 atom-splits on S-006
(role-change happy / role-change refused / remove happy / remove refused = 4 atoms) and S-001's lazy
gate (AS-003 read-only + AS-004 editable, two distinct read outcomes). No bloat — each AS one atom.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-12 | Initial creation — FE ShareDialog consumer of the built `sharing-permissions` backend (open/gate, general-access+guest+editors_can_share, invite, people list, link controls); GAP-001 path mismatch + GAP-002/003 read-surface owed | -- |
| 2026-06-12 | GAP-002/003 RESOLVED by backend `sharing-permissions:S-006` `GET …/share` (prefill read); +AS-018 dialog-open prefill; +Linked Field (share read); GAP-005 → DEFERRED (no remove route, also in Not in Scope) | -- |
| 2026-06-12 | GAP-004 RESOLVED (product): +AS-019 docs-list doc-card ⋯ → Share·Move·Copy dropdown opens the dialog (DocMoreMenu refactor, reuse dropdown-menu + ProjectCardMoreMenu pattern); S-001 files/UI Notes/Inventory updated. GAP-006 → DEFERRED (pending-invite expiry inherited from backend; v0 static "Pending" tag). Spec now build-ready: all Linked Fields ✔ | -- |
| 2026-06-13 | Major: S-001 manage-gate reworked to LAZY/Google-Docs (editable iff the gated GET …/share read succeeds; 403→read-only; docs-list ⋯ shows Share unconditionally) — AS-003/004/019 + C-002 rewritten; +S-006 change/remove a person (AS-020..023, consumes backend S-007 PATCH/DELETE members) + Linked Field; GAP-005 RESOLVED. Snapshot 2026-06-13-ui.md | -- |
