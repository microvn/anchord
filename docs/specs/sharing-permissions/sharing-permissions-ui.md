# Spec: sharing-permissions-ui

**Created:** 2026-06-12
**Last updated:** 2026-06-25
**Status:** Draft

## Overview

The **ShareDialog** — the FE consumer of the already-built `sharing-permissions` backend
(producer), reconciled to the **two-axis access model** (`doc-access-two-axis`, the source of
truth). An owner (or an editor when `editors_can_share` is on) opens the dialog from the
viewer's Share button, sets the two INDEPENDENT access axes — **Workspace access** and **Link
access**, each `{Off | Viewer | Commenter | Editor}` — invites people by email + role + message
(no-account → pending), manages a people list, and — when Link access is on — copies the link and
sets optional password / expiry / view-limit controls. There is NO separate guest-commenting
toggle (the link role IS the grant — a commenter+ link lets no-account guests comment, capped at
commenter — `doc-access-two-axis`:C-004). A viewer/commenter sees no Share affordance (or
read-only). Every mutation is optimistic-with-rollback on a refused write.

This spec owns only the **share dialog + its wiring**. It does NOT own backend enforcement, the
anonymous link-open / password-prompt route (that's `render-publish`'s `/d` · `/v` viewer), the
doc viewer itself, or the role-precedence engine. It consumes three backend mutations
(`PUT /access` with a per-axis partial body, `POST /invites`, `PUT /link`), the `GET …/share`
prefill read (backend S-006, which returns both raw axes + the derived level), and the
`effectiveRole` read-payload field.

## Data Model

No persistent data — a client. Local/client state only; the backend is the source of truth and
re-authorizes every write (C-007 backend). The dialog reads `effectiveRole` from the doc read
payload (`render-publish GET /api/w/:ws/docs/:slug`) to gate the Share affordance, then on OPEN
reads its full prefill state (both raw access axes, the derived level, `editorsCanShare`, people
list, link controls) from `GET /api/w/:ws/docs/:slug/share` (backend `sharing-permissions:S-006`),
then mutates via the typed client.

Client state held by the dialog while open:
- `workspaceRole`: `viewer | commenter | editor | null` — the role granted to every member of the
  doc's own workspace; `null` = Off (not shared with the workspace). One of the two access axes
  (`doc-access-two-axis`:C-002).
- `linkRole`: `viewer | commenter | editor | null` — the role granted to anyone holding the link;
  `null` = Off (no public link). The other access axis (`doc-access-two-axis`:C-003).
- `level`: `restricted | anyone_in_workspace | anyone_with_link` — the DERIVED summary
  (`deriveLevel(workspaceRole, linkRole)`, `doc-access-two-axis`:C-008); read-only display only,
  never stored or sent. The dialog drives its controls off the two raw axes, not this summary.
- `editorsCanShare`: bool (visible to all who can manage; editable by the **owner only**).
- `linkControls`: `{ password?: string; expiresAt?: string; viewLimit?: number }` (all optional, shown only when `linkRole` is set).
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
- `viewerRole` on the `GET …/share` prefill read (`viewer | commenter | editor | owner`, backend
  AS-025) → the caller's OWN role, used for the owner-only `editors_can_share` gate (C-003). Sourced
  from the read (not the passed `effectiveRole`) so the gate holds from any entry point — the
  docs-list ⋯ entry preloads no `effectiveRole`. `effectiveRole` is now only the viewer top-bar
  Share-button pre-read hint (C-002).

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
- **Then:** the ShareDialog opens showing Workspace access, Link access, Link controls (when Link access is on), and Invite people / People list sections, prefilled from the doc's current two-axis sharing state
- **Data:** owner, doc currently restricted (both axes off)

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
- **Given:** a manager opens the Share dialog on a doc that already has a workspace access role, a
  link access role, people, and link controls
- **When:** the dialog opens, it reads `GET /api/w/:ws/docs/:slug/share`
- **Then:** it shows the doc's CURRENT two-axis sharing state — the Workspace access control set to
  `workspaceRole`, the Link access control set to `linkRole`, `editorsCanShare`, the people list
  (active + pending), and the link controls (incl. whether a password is set) — not a blank form
- **Data:** workspace=commenter, link=commenter, 1 active + 1 pending person, a password link

AS-019: Open the Share dialog from the docs-list doc-card ⋯ menu
- **Given:** any user on the docs list looking at a doc card's ⋯ button
- **When:** they open the ⋯ menu and choose Share
- **Then:** the ⋯ presents a menu offering Share · Move · Copy (no longer opening Move/Copy
  directly), and choosing Share opens the same ShareDialog for that doc — the Share item is shown
  UNCONDITIONALLY (no per-doc role is preloaded into the list); the dialog's own gated read then
  decides editable vs read-only (lazy gate, AS-003/AS-004), like Google Docs
- **Data:** a doc card in the browse list (manager → editable; non-manager → read-only surface)

### S-002: Set the two access axes (workspace + link) (P0)

**Description:** As someone who can manage sharing, I set the **Workspace access** axis and the
**Link access** axis as two INDEPENDENT controls, each with an Off option and a role (viewer |
commenter | editor only — owner never selectable). Setting one axis never touches the other. Each
change persists via a per-axis PARTIAL `PUT /access` (`{ workspaceRole? }` or `{ linkRole? }` — the
omitted axis is left unchanged; `null` = Off); a refused write reverts. There is NO separate
guest-commenting toggle — a commenter+ link IS the grant for no-account guests (capped at
commenter, `doc-access-two-axis`:C-004).
**Source:** Consumes backend S-001 (AS-001/002/018/022) + `doc-access-two-axis` (the two-axis model,
source of truth: C-001 independence, C-011 per-axis write), C-012 (role ∈ {viewer,commenter,editor}),
C-015 (`editors_can_share` owner-only); `PUT /api/w/:ws/docs/:slug/access` (per-axis partial body).
Prototype: `ShareDialog` Workspace access + Link access controls (`.access-row` role `Select` /
`.mini-select` + an Off option), `.access-hint`.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` new `apps/web/src/features/sharing/access-section.tsx`; new `features/sharing/client.ts` (`setAccess`); two access controls each a role `Select` (`components/ui/select.tsx`) with an Off option
- `autonomous:` true
- `verify:` set Link access = commenter → `PUT /access` fires with `{ linkRole: "commenter" }`, the Link controls section appears, the Workspace access control is untouched; set Link access = Off → `{ linkRole: null }` fires and the Link controls hide; set Workspace access = editor → `{ workspaceRole: "editor" }` fires and the link axis is unchanged; force a PUT to fail → that axis's control reverts + an error shows.

**Acceptance Scenarios:**

AS-005: Turn Link access on with a role (happy path)
- **Given:** the dialog is open on a restricted doc (both axes Off)
- **When:** the manager sets the Link access control to commenter
- **Then:** `PUT /api/w/:ws/docs/:slug/access` is called with the per-axis partial `{ linkRole: "commenter" }` (the workspace axis omitted, left unchanged); on 200 the Link access control reflects the new state and the Link controls section appears
- **Data:** linkRole = commenter, workspace axis untouched

AS-006: A refused axis change reverts (error path)
- **Given:** the manager changes an access axis optimistically
- **When:** `PUT /access` comes back 403 or fails (e.g. role revoked, network)
- **Then:** that axis's control reverts to its prior value and an error is shown ("couldn't update access"); the other axis is untouched; no silent partial state
- **Data:** PUT refused

AS-007: Role dropdown never offers owner
- **Given:** the access (or invite) role dropdown is open
- **When:** the manager looks at the options
- **Then:** only viewer, commenter, and editor are offered; owner is never selectable (mirrors backend C-012 / AS-018); a forged owner value would be rejected by the server
- **Data:** options = {viewer, commenter, editor}

AS-008: A commenter+ link grants guest commenting with no separate toggle
- **Given:** the dialog is open
- **When:** the manager sets the Link access control to commenter (or editor)
- **Then:** there is NO separate guest-commenting toggle — the link role IS the grant: a commenter+
  link lets anyone with the link, including no-account guests (capped at commenter,
  `doc-access-two-axis`:C-004), comment. Setting Link access to viewer means link-holders may view
  only; setting it Off means no public link at all. (The standalone guest-commenting toggle was
  retired 2026-06-20 — Google-Docs model.)
- **Data:** link=viewer → view only; link=commenter → guests may comment

AS-009: editors_can_share toggle is shown but owner-editable only
- **Given:** the dialog is open (from EITHER the viewer or the docs-list ⋯ entry)
- **When:** the viewer is the owner, then an editor (with manage rights)
- **Then:** the owner sees the `editors_can_share` toggle editable (sends `editorsCanShare` on `PUT /access`); an editor sees it read-only/absent (cannot change it — backend C-015 / AS-022). Owner-ness is decided by the `viewerRole` in the `GET …/share` read (C-003), so the owner gets the editable toggle even from the docs-list entry (which preloads no `effectiveRole`)
- **Data:** owner editable; editor read-only; owner via docs-list ⋯ still editable

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

**Description:** As someone who can manage sharing on a doc whose Link access axis is on, I copy the
link and set optional password / expiry / view-limit controls via chips; changes persist via
`PUT /link`. The Link controls section appears only when Link access is on (`linkRole !== null`).
**Source:** Consumes backend S-004 (AS-009/010/011), C-001 (controls attach to the link, each
independent); `PUT /api/w/:ws/docs/:slug/link`. Prototype: `ShareDialog` `.link-row` (`.link-url` code +
Copy) + `.link-chips` (`.link-chip` Password / Expiry / View limit, `.on` when set).

**Execution:**
- `depends_on:` S-002
- `parallel_safe:` false
- `files:` new `apps/web/src/features/sharing/link-controls.tsx`; `features/sharing/client.ts` (`setLinkControls`); reuse `components/ui/input.tsx` for the password/expiry/limit fields
- `autonomous:` true
- `verify:` set Link access on → the Link controls section shows the URL + Copy + chips; click Copy → link on clipboard + toast; set a chip (e.g. expiry) → `PUT /link` fires and the chip reads "set"; force the PUT to fail → the chip reverts + error.

**Acceptance Scenarios:**

AS-015: Copy the link
- **Given:** the doc's Link access is on and the Link controls section is visible
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

- C-001 (mirror of `doc-access-two-axis`:C-001/C-011): The dialog has TWO independent access
  controls — Workspace access and Link access — each `{Off | Viewer | Commenter | Editor}`. Each is
  set with a per-axis PARTIAL `PUT /access` (`{ workspaceRole? }` / `{ linkRole? }`), so setting one
  axis never changes the other. There is NO separate guest-commenting toggle: a commenter+ Link
  access role IS the grant for no-account guests (capped at commenter,
  `doc-access-two-axis`:C-004). (AS-005, AS-008)
- C-002 (mirror of backend C-007, LAZY gate 2026-06-13): manage-eligibility is decided by the
  RESULT of the gated `GET …/share` prefill read, not by a pre-computed `effectiveRole` — a read that
  SUCCEEDS proves the caller can manage (the backend gated it identically to the writes, backend
  C-016) → editable controls; a read REFUSED (403/forbidden) → the read-only "can't manage" surface
  (distinct from a generic load error). `effectiveRole` is used ONLY as a pre-read hint to hide the
  viewer top-bar Share button for a viewer/commenter; the docs-list ⋯ shows Share unconditionally and
  lets the read decide (Google-Docs model). (AS-003, AS-004, AS-019)
- C-003 (mirror of backend C-015): The `editors_can_share` toggle is editable by the **owner only**;
  an editor who can manage sees it read-only (or hidden), never editable. Owner-ness is read from the
  `GET …/share` payload's `viewerRole` (the caller's own role, backend AS-025), NOT the externally
  passed `effectiveRole` — so the gate holds from ANY entry point. `effectiveRole` only hides the
  viewer top-bar Share button as a pre-read hint (C-002); the docs-list ⋯ entry passes none, so
  relying on it left the owner with a read-only toggle there. (AS-009)
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
- C-007: The Link controls section (URL + Copy + chips) is shown only when the Link access axis is
  on (`linkRole !== null`); it is hidden while Link access is Off, regardless of the Workspace
  access axis. (AS-015, AS-016)

## Linked Fields

`sharing-permissions-ui` is the **consumer**; `sharing-permissions` (backend) is the producer.
Surface = the typed Eden client `features/sharing/client.ts` calling the three management routes;
lifecycle = on dialog mutation (per-control), optimistic then reconciled/rolled-back.

- `PUT /api/w/:ws/docs/:slug/access` `{ workspaceRole?, linkRole?, editorsCanShare? }` (per-axis
  PARTIAL — an omitted axis is unchanged, each value viewer|commenter|editor|null) →
  `{ workspaceRole, linkRole, level, editorsCanShare, capabilityUrl }` (`level` = the derived
  summary) — consumed by S-002 (AS-005/006/008/009). Produced by backend S-001 (the two-axis model,
  `doc-access-two-axis`). ✔ path RESOLVED (GAP-001): the backend CODE serves the workspace-scoped path
  (`apps/backend/src/routes/sharing.ts:201`); the backend spec's `## API` table showing `/api/docs/:slug`
  is STALE (same class as `annotation-core-ui:GAP-001`, fixed by matching the real route).
- `POST /api/w/:ws/docs/:slug/invites` `{ email, role, message? }` → 201 `{ status: active|pending }` —
  consumed by S-003 (AS-010/011/013). Produced by backend S-003 (`sharing.ts:243`). ✔ workspace-scoped (GAP-001 resolved).
- `PUT /api/w/:ws/docs/:slug/link` `{ password?, expiresAt?, viewLimit? }` → `{ link controls }` — consumed
  by S-005 (AS-016/017). Produced by backend S-004 (`sharing.ts:279`). ✔ workspace-scoped (GAP-001 resolved).
- `effectiveRole` on the doc read payload (`viewer|commenter|editor|owner`) — consumed by S-001 to
  gate `canManageShare` (C-002). Produced by `render-publish`/`annotation-core-ui-commenting`'s doc
  read. ✔ field exists on the viewer read payload (`features/viewer/client.ts`).
- `GET /api/w/:ws/docs/:slug/share` → `{ workspaceRole, linkRole, level, editorsCanShare, people[],
  link{ hasPassword, expiresAt, viewLimit, viewCount, url }, viewerRole }` (`workspaceRole`/`linkRole`
  = the two raw axes, each viewer|commenter|editor|null; `level` = the derived summary) — consumed by
  S-001 (AS-018) on dialog OPEN to PREFILL the whole dialog state (both axis controls,
  `editorsCanShare`, people[], link controls incl. `hasPassword`); also feeds S-002/S-004/S-005
  initial values. Produced by backend `sharing-permissions:S-006`. ✔ surface (dialog-open read) +
  lifecycle match (read once on open, then per-control writes reconcile). RESOLVED GAP-003.
- `editorsCanShare` — delivered by that same `GET …/share` read (NOT the doc read payload), so the
  editor manage-eligibility (C-002 / S-001 AS-004) is decidable client-side once the dialog opens.
  Produced by backend `sharing-permissions:S-006`. ✔ RESOLVED GAP-002.
- `viewerRole` — the caller's OWN role, on the same `GET …/share` read. Consumed by S-002 (C-003 /
  AS-009) for the owner-only `editors_can_share` gate, sourced from the read so it holds from any
  entry point (the docs-list ⋯ preloads no `effectiveRole`). Produced by backend
  `sharing-permissions:S-006` (AS-025). ✔ surface (dialog-open read) + lifecycle (read once on open)
  match. RESOLVED the AS-009-from-docs-list gap.
- `PATCH /api/w/:ws/docs/:slug/members/:id` `{ role }` → `{ role }` AND
  `DELETE /api/w/:ws/docs/:slug/members/:id` → `{ removed: true }` — consumed by S-006 (AS-020/021/022/023)
  on a per-row people-list mutation (optimistic, then reconciled/rolled-back). Produced by backend
  `sharing-permissions:S-007`. ✔ workspace-scoped; gated like the other writes (backend C-017).
  RESOLVED GAP-005.

## UI Notes

Design: prototype `Anchord-Design/viewer-dialogs.jsx` `ShareDialog` (P16) is CANONICAL, styled by
`Anchord-Design/viewer-dialogs.css` (`.share-sec`, `.access-row`, `.mini-select`,
`.access-hint`, `.switch-row`/`.switch`, `.link-row`/`.link-url`/`.link-chips`/`.link-chip`,
`.person-row`/`.person-info`/`.person-role`); tokens from `Anchord-Design/tokens.css` +
`viewer.css`. The dialog uses the existing `Dialog{wide:true}` chrome. Precedence:
AS / Constraints > prototype > Tree. All components new `[N]`.

- `ShareDialog` `[N]` *(desktop = centered `Dialog` (wide); **full-screen sheet** ≤600px via
  `components/ui/sheet.tsx`, per DESIGN.md Responsive + backend UI Notes; title "Share doc",
  doc-title subtext, a "Done" footer button)*
  - `AccessSection` `[N]` *(`.share-sec`)*: TWO independent controls —
    `WorkspaceAccessControl` `[N]` *("Workspace access" `.access-row`: a role `Select`
    `.mini-select` (Off | Viewer | Commenter | Editor) — the role every workspace member gets; Off
    = not shared with the workspace)* and `LinkAccessControl` `[N]` *("Link access" `.access-row`:
    a role `Select` (Off | Viewer | Commenter | Editor) — the link role IS the grant for anyone with
    the link, incl. no-account guests capped at commenter; no separate guest toggle, C-001)*, plus
    `.access-hint` (icon + per-axis sentence). The derived `level` is display-only — the controls
    drive off the raw axes.
  - `EditorsCanShareToggle` `[N]` *(`.switch-row` `.switch`; visible to managers, EDITABLE by the
    owner only — C-003; read-only/absent for an editor)*
  - `LinkControls` `[N]` *(`.share-sec` "Link"; shown only when Link access is on — C-007)*:
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
| Doc read payload (`effectiveRole`, derived `level` from the two axes) | `apps/web/src/features/viewer/client.ts` (`ViewerDocResponse`) | consume `effectiveRole` for `canManageShare`; the prefill `GET …/share` carries both raw axes + `editorsCanShare` + people/link state (GAP-003) |
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
- GAP-003 (status: RESOLVED — 2026-06-12; updated 2026-06-25 for two-axis): the prefill read surface
  exists — backend `sharing-permissions:S-006` `GET /api/w/:ws/docs/:slug/share` returns
  `{ workspaceRole, linkRole, level, editorsCanShare, people[], link{ hasPassword, expiresAt,
  viewLimit, viewCount, url }, viewerRole }` (AS-025; password exposed as a boolean only, C-016). The
  dialog reads it on OPEN to prefill both axis controls (Workspace access + Link access),
  `editorsCanShare`, the people list (active + pending), and the link controls. Resolved by S-006.
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
- CC5 (no backend relitigation): the two access axes (workspace + link), roles, the link-role-IS-the-grant
  guest model, editors_can_share, precedence are CONSUMED as built per `doc-access-two-axis` (source of
  truth); no backend decision is changed. ✔
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
| 2026-06-13 | Major: C-003 + AS-009 now source owner-ness from the `GET …/share` read's `viewerRole` (backend AS-025), not the passed `effectiveRole` — so the owner-only editors_can_share toggle is editable from ANY entry point (the docs-list ⋯ preloads no effectiveRole → it was read-only there). +Data Model `viewerRole` field + Linked Field. Snapshot 2026-06-13-ui-2.md | -- |
| 2026-06-25 | Major: reconciled to the TWO-AXIS access model (`doc-access-two-axis`:S-007 is the built two-axis ShareDialog and the source of truth). The single general-access segmented control + one role dropdown + guest-commenting toggle are REPLACED by two independent controls — Workspace access + Link access, each `{Off\|Viewer\|Commenter\|Editor}`; the access write is a per-axis PARTIAL `PUT …/access` `{ workspaceRole?, linkRole?, editorsCanShare? }` (omitted axis unchanged, null = off); the `GET …/share` read returns both raw axes + a derived `level`. Dropped the `generalAccess`/`accessRole`/`guestCommenting` client fields (level is now a read-only derived display); the link role IS the guest-commenting grant (anon capped at commenter, retired 2026-06-20). Rewrote Overview, Data Model, S-002 (+AS-005/006/008), AS-001/018, S-005 + AS-015, C-001/C-007, UI Notes component tree, Linked Fields (`PUT …/access`, `GET …/share`), UI Inventory, GAP-003, CC5. | doc-access-two-axis cascade |
