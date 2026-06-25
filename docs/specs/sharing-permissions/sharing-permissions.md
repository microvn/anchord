# Spec: sharing-permissions

**Created:** 2026-06-07
**Last updated:** 2026-06-25
**Status:** Draft
**Snapshot limit:** 12

## Overview

Google-Docs-style sharing model for a doc: 4 roles (viewer/commenter/editor/owner),
two independent access axes (workspace access + link access — see `doc-access-two-axis`,
the source of truth for the access model), anonymous viewing + guest commenting (a commenter+
link lets no-account guests comment — the link role is the grant, no separate toggle; a guest is
capped at commenter), invite by email (pending if no account yet), and link controls
(password/expiry/view-limit). Decides "who can open the link, who can do what".

## Data Model

- **Access axes (`share_links.workspace_role` + `share_links.link_role`)** — the single
  `docs.general_access` enum is DROPPED; a doc's access is two independent nullable role columns,
  defined in `doc-access-two-axis` (the source of truth):
  - `workspace_role`: viewer | commenter | editor | null — the role every member of the doc's own
    workspace gets; `null` = not shared with the workspace.
  - `link_role`: viewer | commenter | editor | null — the role anyone holding the link gets; `null`
    = no public link (and no capability token).
  The legacy 3-value level (restricted | anyone_in_workspace | anyone_with_link) is no longer stored;
  it is DERIVED on read via `deriveLevel(workspace_role, link_role)` — see C-009. **New-doc default:**
  `workspace_role = commenter`, `link_role = null`, written into the `share_links` row at publish (web
  AND MCP) — see C-018; `restricted` ({null, null}) is the per-doc opt-in for a private doc.
- **doc_members**: `doc_id`, `user_id` (nullable if pending), `email` (for pending),
  `role`, `message`, `invited_by`, `status` (active | pending), `created_at`.
- **share_links**: `doc_id`, `workspace_role` (nullable) + `link_role` (nullable) — the two access
  axes (replacing the old single `role`), `password_hash` (nullable), `expires_at` (nullable),
  `view_limit` (nullable), `view_count`, `capability_token` (nullable — minted/cleared with `link_role`),
  `editors_can_share` (bool, default true — the owner-controlled toggle that lets editors manage
  sharing, Google-Docs style). The row exists from publish (not lazily), so the access config is
  always present. Link controls attach to the link axis.
- Guest commenting has NO separate toggle (Google-Docs model): a doc whose `link_role` is commenter+
  lets anyone with the link — including no-account guests — comment; the link role IS the grant. A
  no-account guest is capped at commenter regardless of `link_role`, applied at the anonymous-admission
  seam (`doc-access-two-axis`:C-004). `guest_name` on a comment lives in `annotation-core`.

## Stories

### S-001: Set the two access axes for a doc (P0)

**Description:** As an owner, I set a doc's workspace access role and link access role as two
independent axes (each viewer/commenter/editor or off), written per-axis (partial update — setting
one never touches the other); when `link_role` is commenter+, the link role is the grant for everyone
with the link including no-account guests (capped at commenter — no separate guest toggle).
**Source:** docs/explore/sharing-permissions.md#decisions (items 1, 2); access model: `doc-access-two-axis`.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (expected `src/routes/share.*`, `src/db/schema`)
- `autonomous:` true
- `verify:` set link=commenter → link openable by an outsider at the comment level; set workspace=commenter → a non-invited member can comment.

**Acceptance Scenarios:**

AS-001: Turn link access on at the commenter level
- **Given:** owner opens the doc's Share box
- **When:** they set link access = commenter (workspace axis left as-is)
- **Then:** settings saved; anyone with the link gets access at the commenter level, and the
  workspace axis is unchanged
- **Data:** link_role = commenter

AS-002: Make a doc private (both axes off)
- **Given:** owner opens the Share box
- **When:** they turn both workspace access and link access off
- **Then:** only the owner + specifically invited people get access (derived level = restricted);
  someone with the link but not invited is denied
- **Data:** workspace_role = null, link_role = null


AS-018: An invalid role on either axis is rejected
- **Given:** owner opens the Share box
- **When:** they set workspace access (or link access) to "owner" (or any value outside viewer/commenter/editor)
- **Then:** the setting is rejected; only viewer, commenter, editor, or off is accepted on each axis (and as an invite role)
- **Data:** workspace_role = owner → rejected

AS-022: Owner toggles whether editors can share
- **Given:** owner opens the Share box; `editors_can_share` is at its default (on)
- **When:** the owner turns it off
- **Then:** the setting is saved; only the owner toggles it (an editor cannot change `editors_can_share` itself)
- **Data:** owner sets editors_can_share = off

### S-002: Open a doc via link as anonymous (P0)

**Description:** As someone opening a link without an account, I can view the doc with a
random name, and rename myself if I want.
**Source:** docs/explore/sharing-permissions.md#decisions (item 3 anon view).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-004: Anonymous view with a random name
- **Given:** doc with link access on (link_role set)
- **When:** a logged-out person opens the link
- **Then:** they can view the content; assigned a random name (e.g. "Anonymous Cat") for the session
- **Data:** no account

AS-005: Rename the anonymous identity
- **Given:** an anonymous person viewing with a random name
- **When:** they choose to rename themselves to "Lan"
- **Then:** the displayed name updates to "Lan" for the session (and is attached to comments if they comment)
- **Data:** rename "Anonymous Cat" → "Lan"

AS-006: Restricted + a stranger is denied
- **Given:** doc with both axes off (derived level = restricted)
- **When:** an uninvited person opens the link
- **Then:** show "You do not have access"; do not leak content (no request-access in v0)
- **Data:** someone not on the invite list

AS-015: workspace access on, link off — members get in, outsiders/anonymous do not
- **Given:** doc with workspace access on (workspace_role set) and link access off (link_role null)
- **When:** a logged-in member opens the doc (without being individually invited); and a
  logged-out / non-member person opens the same address
- **Then:** the member gets in at the workspace role; the logged-out or out-of-workspace person is denied
- **Data:** workspace_role = commenter, link_role = null; internal member vs anonymous guest

### S-003: Invite by email with role (P0)

**Description:** As an owner, I invite others by email + role + message; someone
without an account receives a pending invite that activates when they sign up.
**Source:** docs/explore/sharing-permissions.md#decisions (item 5 invite pending).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (coordinates with auth)
- `autonomous:` true
- `verify:` invite an email with no account → creates pending; sign up that email → receives role.

**Acceptance Scenarios:**

AS-007: Invite someone who already has an account
- **Given:** owner opens Share; `dev@acme.com` already has an account
- **When:** invite `dev@acme.com` with role editor + message, send
- **Then:** that person gets the editor role on the doc + is notified; the invite response returns
  the new member's id, so the Share dialog can target a change/remove on that row immediately
  (consumed by `sharing-permissions-ui:S-006`) without re-reading the share state
- **Data:** editor + message "please review"

AS-008: Invite an email with no account → pending, activates on sign up
- **Given:** owner invites `bob@x.com` with role editor; Bob has no account yet
- **When:** the invite is created (email sent if SMTP available); later Bob signs up with the same
  `bob@x.com` (email verified)
- **Then:** the create returns the new pending member's id (the dialog can revoke that row
  immediately); the invite activates when Bob signs up and Bob enters the doc with the editor role
- **Data:** email did not exist at invite time

### S-004: Apply link controls (P1)

**Description:** As an owner, I set a password / expiry / open-count limit on the link; once
expired or over the limit, the link stops working.
**Source:** docs/explore/sharing-permissions.md#decisions (item 4 link controls).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: Link with a password
- **Given:** owner sets a password on the link
- **When:** someone opening the link enters the wrong password
- **Then:** denied, content not leaked; entering the correct one gets them in
- **Data:** password set; wrong then right

AS-010: Expired link stops working
- **Given:** owner sets a 7-day expiry
- **When:** someone opens the link after it has expired
- **Then:** show "Link no longer available"
- **Data:** expiry in the past

AS-011: Over the open-count limit
- **Given:** owner sets view-limit = total number of opens
- **When:** opens exceed the limit
- **Then:** show "Link no longer available"
- **Data:** small view-limit, opened more than that

AS-016: Password link is rate-limited against brute-force [harden M2]
- **Given:** link has a password
- **When:** the wrong password is tried many times in a row
- **Then:** past a threshold → temporary lock/wait (no HTTP-speed guessing)
- **Data:** repeated wrong attempts

AS-017: view-limit not exceeded under concurrent opens [harden M2]
- **Given:** view-limit = N
- **When:** N+M requests open the link nearly simultaneously
- **Then:** only ≤ N requests are served (atomic increment), the surplus is denied
- **Data:** N=5, fire 20 parallel requests

AS-019: A correct password resets the wrong-attempt counter
- **Given:** a password link with some wrong-password attempts recorded, still below the lockout threshold
- **When:** the correct password is then entered
- **Then:** access is granted AND the wrong-attempt counter resets to zero (honest typos do not accumulate toward a lockout)
- **Data:** 2 wrong attempts (threshold 5), then the correct password

AS-020: Expiry boundary — valid up to the instant, denied after
- **Given:** a link with an expiry set to a specific instant T
- **When:** the link is opened at exactly T, and again one moment after T
- **Then:** opening at exactly T is allowed; opening after T shows "Link no longer available"
- **Data:** open at T (allowed) and T+1 (denied)

AS-021: An expired link is refused before any password check
- **Given:** a link that has both a password and an expiry that has passed
- **When:** someone opens the expired link
- **Then:** it is refused as expired without the password being prompted for or verified (expiry is checked before the password step)
- **Data:** expired link with a password set

AS-033: Setting a view limit starts a fresh viewing budget
- **Given:** an anyone-with-link doc whose link has already been opened several times (a non-zero open count)
- **When:** the owner sets or changes the link's view limit
- **Then:** the open count resets to zero — the new limit is a fresh budget counted from that point, so a link is never instantly "no longer available" just because past opens already exceeded the newly-set number
- **Data:** link opened 30 times, owner then sets view-limit = 20 → open count resets to 0, the link still opens (not treated as 30-over-20)

### S-005: Enforce role capabilities & precedence (P0)

**Description:** As the system, I apply the correct capabilities per role and take the highest
role when a person has access from multiple sources.
**Source:** docs/explore/sharing-permissions.md#decisions (item 6 roles, item 7 precedence).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown
- `autonomous:` true

**Acceptance Scenarios:**

AS-012: Viewer cannot comment
- **Given:** a user with the viewer role on the doc
- **When:** they open the doc
- **Then:** no comment box; if they try to call create-comment → denied
- **Data:** viewer

AS-013: Highest role wins across multiple sources
- **Given:** a person is invited as editor, while link access = commenter
- **When:** they open the doc
- **Then:** they get the editor role (higher than the commenter link role)
- **Data:** invited=editor + link_role=commenter

AS-014: An editor can manage sharing when editors-can-share is enabled
- **Given:** a doc whose `editors_can_share` is enabled (the default); user B has the editor role (not owner)
- **When:** B opens the Share box to change general-access / invite people
- **Then:** B is allowed (Google-Docs default: editors can share)
- **Data:** editor B, editors_can_share = on (changing either access axis / inviting)

AS-023: An editor cannot manage sharing when the owner has disabled editors-can-share
- **Given:** the owner has turned `editors_can_share` off; user B has the editor role
- **When:** B opens the Share box to change general-access / invite people
- **Then:** not allowed (owner has locked sharing to themselves)
- **Data:** editor B, editors_can_share = off

AS-024: A viewer or commenter can never manage sharing
- **Given:** a user with the viewer (or commenter) role on the doc, regardless of editors_can_share
- **When:** they try to change general-access / invite people / set link controls
- **Then:** not allowed (only owner + permitted editors manage sharing)
- **Data:** viewer tries to change access

### S-006: Read sharing state for the Share dialog (P0)

**Description:** As an owner (or an editor when `editors_can_share`), I read the doc's current
sharing state so the Share box can show both raw access axes (workspace_role + link_role) and the
derived access level (`doc-access-two-axis`:C-008), editors-can-share, the people list, and the link controls.
**Source:** sharing-permissions-ui:GAP-003 (FE needs a read surface to prefill the dialog; the 3
management routes are write-only).

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (expected the sharing repo read + a GET route in `src/routes/sharing.ts`)
- `autonomous:` true
- `verify:` as owner, read the share state of a doc with an invited member + a password-protected
  link → returns the raw workspace_role + link_role + derived level + editors_can_share + the people
  list + the link controls with a password BOOLEAN (not the hash).

**Acceptance Scenarios:**

AS-025: Owner reads the current share state (happy path)
- **Given:** a doc with workspace access = commenter and link access = commenter, one pending + one active
  invite, a password-protected link
- **When:** the owner reads the doc's share state
- **Then:** returns the raw `workspaceRole` + `linkRole` AND the derived access level
  (`doc-access-two-axis`:C-008), editors-can-share on/off, the list of invited people (each with their
  **member id**, email/name, role, and active|pending status — the member id lets the Share dialog
  target the change/remove member actions, S-007), the link controls (expiry, view limit, view count,
  and WHETHER a password is set), and the **caller's own effective role** (`viewerRole`) on this doc —
  the same role the gate resolved — so the dialog can apply the owner-only editors-can-share gate
  (C-015) regardless of how it was opened (the docs-list entry preloads no role; `sharing-permissions-ui:C-003`)
- **Data:** workspace_role=commenter, link_role=commenter, 1 pending + 1 active invite, password link;
  each person row carries its member id

AS-026: The stored password is never returned (security)
- **Given:** a password-protected link
- **When:** the share state is read
- **Then:** only a boolean "password is set" is returned; no password hash appears anywhere in the
  read
- **Data:** a password-protected link

AS-027: A caller who cannot manage sharing is refused the read (error/gate)
- **Given:** a commenter on the doc (or an editor when editors_can_share is off)
- **When:** they request the share state — which carries the people list + link config
- **Then:** refused, gated exactly like the management writes (C-007)
- **Data:** a commenter requests the share state → refused

### S-007: Change or remove a doc member (P1)

**Description:** As someone who can manage sharing (owner, or an editor when `editors_can_share`), I
change an active member's role, remove an active member, or revoke a pending invite. The owner is
not a member that can be reassigned or removed through these actions.
**Source:** sharing-permissions-ui:GAP-005 (the people list shows members but there was no route to
change a role or remove/revoke a person); closes the manage-existing-members gap left by S-003.

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` unknown (expected the doc-member repo gains update-role + delete, + `PATCH`/`DELETE`
  member routes in `src/routes/sharing.ts`)
- `autonomous:` true
- `verify:` as owner, change an active member viewer→editor → that member now has the editor role;
  remove an active member → they lose access; revoke a pending invite → it no longer activates on
  signup; as a commenter, both are refused; the owner row cannot be changed or removed.

**Acceptance Scenarios:**

AS-028: Change an active member's role (happy path)
- **Given:** a doc with an active member at the viewer role; the caller can manage sharing
- **When:** they change that member's role to editor
- **Then:** the member's role becomes editor (their effective role on the doc reflects it)
- **Data:** active member viewer → editor

AS-029: Remove an active member (happy path)
- **Given:** a doc with both axes off (derived restricted) with an active member; the caller can manage sharing
- **When:** they remove that member
- **Then:** the member loses access — they no longer appear among the doc's people and can no longer
  view the restricted doc
- **Data:** remove an active member from a restricted doc

AS-030: Revoke a pending invite (happy path)
- **Given:** a doc with a pending invite for an email that has no account yet
- **When:** the caller revokes that pending invite
- **Then:** the pending invite is gone — creating an account for that email later does NOT grant the
  doc role (the invite no longer activates, C-006)
- **Data:** revoke a pending invite for bob@x.com

AS-031: A caller who cannot manage sharing is refused (error/gate)
- **Given:** a commenter on the doc (or an editor when `editors_can_share` is off)
- **When:** they try to change a member's role or remove a member
- **Then:** refused, gated exactly like the other management writes (C-007); the member set is unchanged
- **Data:** a commenter tries to change a role → refused

AS-032: The owner cannot be role-changed or removed (error)
- **Given:** the doc owner appears in the people set
- **When:** any manager tries to change the owner's role or remove the owner via these actions
- **Then:** refused — the owner is not a reassignable or removable member (owner is separate from the
  invited-member roles, C-004)
- **Data:** attempt to change/remove the owner → refused

## Constraints & Invariants

- C-001: A doc has TWO independent access axes — workspace access (`workspace_role`) + link access
  (`link_role`) — each set per-axis (setting one never touches the other; `doc-access-two-axis`:C-001/C-011);
  link controls (password/expiry/view-limit) attach to the link axis, independent of each other.
  (AS-001, AS-002, AS-009, AS-010, AS-011)
- C-002: Highest role wins when access comes from multiple sources. (AS-013)
- C-004: anyone-with-link allows anonymous viewing without an account; assigns a random name, renameable. (AS-004, AS-005)
- C-005: Expired link or over view-limit → stops working ("not available" page). Expiry boundary
  is inclusive of the instant: a link is valid up to and including its expiry instant and denied
  only after it. (AS-010, AS-011, AS-020)
- C-006: Pending invite is keyed by email, activates when an account for that email exists + verified. (AS-008)
- C-007: Manage-sharing model (Google-Docs style): the **owner can always** manage sharing
  (change access, invite, link controls, toggle `editors_can_share`). An **editor may manage
  sharing when the doc's `editors_can_share` is enabled** (the default); when the owner has
  turned it off, only the owner can. A **viewer/commenter/link-holder can never** manage sharing.
  (AS-014, AS-023, AS-024)
- C-015: `editors_can_share` defaults to **on** (editors can share, matching Google Docs); only
  the owner may toggle it — an editor cannot change the toggle itself even when it is on. (AS-022)
- C-008: view-limit counts TOTAL opens (not unique viewers); the open count resets to 0 when the owner sets or changes the limit — a fresh limit is a fresh budget (it does not carry over past opens). (AS-011, AS-033)
- C-009: The legacy 3-value level is DERIVED from the two axes on read, never stored
  (`doc-access-two-axis`:C-008): `{null, null}` → restricted (owner + invitees only);
  `{workspace_role set, link_role null}` → anyone_in_workspace (every logged-in member, no
  anon/outsiders); `{*, link_role set}` → anyone_with_link (includes anon/outsiders, anon capped at
  commenter). Workspace browse visibility is keyed on `workspace_role` (set ⇒ visible),
  NOT on `link_role` (`doc-access-two-axis`:C-006). (AS-002, AS-004, AS-015)
- C-010 [harden M2]: password link stores its hash with the same KDF as the user password
  (argon2id/bcrypt) + rate-limit/lockout like login (extends auth C-007 to the
  link password). (AS-016)
- C-011 [harden M2]: enforce view-limit with an atomic increment
  (`UPDATE … SET view_count=view_count+1 WHERE view_count<view_limit RETURNING`,
  no row → deny); check expiry/limit server-side on every request before
  serving content. (AS-017)
- C-012: each axis role (workspace_role / link_role) and an invite role must be one of
  viewer | commenter | editor (or off/null on an axis); "owner" is the doc creator and is never
  assignable on either axis or as an invite role. (AS-018)
- C-013: link-access checks run in the order expiry → lockout → password; an expired or
  locked link is refused before any password verification (no password prompt, no timing/leak
  on a link that is already unavailable). (AS-021, AS-016)
- C-014: a correct password resets the wrong-attempt counter, so honest typos do not accumulate
  toward the brute-force lockout. (AS-019)
- C-016: the share-state read is gated identically to the management writes (owner, or editor when
  `editors_can_share`; C-007) and NEVER returns the link password — only a boolean that one is set.
  (AS-025, AS-026, AS-027)
- C-017: changing a member's role / removing a member / revoking a pending invite is gated
  identically to the other management writes (owner, or editor when `editors_can_share`; C-007); the
  doc OWNER is never a reassignable or removable member through these actions (owner is separate from
  the invited-member roles, C-012). (AS-028, AS-029, AS-030, AS-031, AS-032)
- C-018: A newly published doc is created with a FIXED two-axis default — `workspace_role = commenter`,
  `link_role = null` — written into its `share_links` row at publish (NOT inherited from
  `workspaces.settings.defaultAccess`, which is retired by `doc-access-two-axis`). This is the
  shared-workspace model (shared-group-space) default — members see and can comment on new docs by
  default, with no public link; `restricted` ({null, null}) is the explicit per-doc opt-in to make a
  doc private (set later via S-001/AS-002). The default is assigned at publish, so this cross-surface
  invariant is COVERED by `doc-access-two-axis`:C-007 (web/UI publish → AS-005/AS-006; MCP publish →
  AS-025), not by an AS here.
  - scope: doc-access-two-axis:S-002
  - surfaces: web/UI publish, MCP publish
  - coverage: web/UI publish → doc-access-two-axis:AS-005/AS-006; MCP publish → doc-access-two-axis:AS-025

## UI Notes

From `docs/explore/sharing-permissions.md` §UI sketches. Greenfield → `[N]`. Component
names only. Dark-operator (`DESIGN.md`). Precedence: AS > Tree.

- `ShareDialog` `[N]` *(modal; **full-screen sheet** ≤600)*
  - `WorkspaceAccessControl`: role choice (viewer/commenter/editor) + an off option *(the role every
    workspace member gets; off = not shared with the workspace)*
  - `LinkAccessControl`: role choice + an off option *(the link role IS the grant — anyone with the
    link, incl. no-account guests capped at commenter, gets this role; a commenter+ link lets guests
    comment, no separate toggle — Google-Docs model)*
  - `LinkRow`: urlField · CopyButton · `PasswordChip` · `ExpiryChip` · `ViewLimitChip` *(all optional)*
  - `InviteRow`: emailField · `RoleDropdown` · InviteButton *(pending if no account)*
  - `PeopleList` → `PersonRow`: `Avatar` · name · roleLabel · `PendingTag`

## API

HTTP contract for this cluster. Follows `api-core` (envelope C-001, error→status C-003,
auth gate C-005, validation C-007). Sharing-management routes are owner-only (C-007).

| Method · Path | Serves | Auth | Request | Success | Errors |
|---|---|---|---|---|---|
| `GET /api/w/:workspaceId/docs/:slug/share` | S-006 (AS-025/026/027) | session: owner, or editor when `editors_can_share` (C-007) | — | 200 `{ workspaceRole, linkRole, level, editorsCanShare, people[]{ id, email, name?, role, status }, link{ hasPassword, expiresAt, viewLimit, viewCount, url }, viewerRole }` (`workspaceRole`/`linkRole` = the two raw axes (each viewer\|commenter\|editor\|null); `level` = the derived summary; `viewerRole` = the caller's own role on the doc, owner\|editor\|commenter\|viewer) | 403 FORBIDDEN (cannot-manage AS-027), 404 |
| `PUT /api/w/:workspaceId/docs/:slug/access` | S-001 (AS-001/002/018/022) | session: owner, or editor when `editors_can_share` (C-007); `editors_can_share` toggle is owner-only (C-015) | `{ workspaceRole?, linkRole?, editorsCanShare? }` (Zod; per-axis PARTIAL — an omitted axis is left unchanged, each value viewer\|commenter\|editor\|null) | 200 `{ workspaceRole, linkRole, level, editorsCanShare, capabilityUrl }` (`level` = derived summary; `capabilityUrl` = `/s/<token>` when `linkRole` is set, else null — linked field consumed by capability-share-link:S-005/AS-027 so the share box updates in-session) | 400 VALIDATION_ERROR (invalid role AS-018), 403 FORBIDDEN (viewer AS-024; editor when toggle off AS-023), 404 |
| `POST /api/w/:workspaceId/docs/:slug/invites` | S-003 (AS-007/008) | session: owner, or editor when `editors_can_share` (C-007) | `{ email, role, message? }` (Zod) | 201 `{ status, id }` (`status` active\|pending; `id` = new doc_members row, for immediate change/remove) | 400, 403, 404 |
| `PUT /api/w/:workspaceId/docs/:slug/link` | S-004 (AS-009/010/011/016/017/019/020/021/033) | session: owner, or editor when `editors_can_share` (C-007) | `{ password?, expiresAt?, viewLimit? }` (Zod) | 200 `{ link controls }` | 400, 403, 404 |
| `PATCH /api/w/:workspaceId/docs/:slug/members/:memberId` | S-007 (AS-028/031/032) | session: owner, or editor when `editors_can_share` (C-007) | `{ role }` viewer\|commenter\|editor (Zod) | 200 `{ role }` | 400 VALIDATION_ERROR (owner/invalid role AS-032), 403 FORBIDDEN (cannot-manage AS-031), 404 |
| `DELETE /api/w/:workspaceId/docs/:slug/members/:memberId` | S-007 (AS-029/030/031/032) | session: owner, or editor when `editors_can_share` (C-007) | — | 200 `{ removed: true }` | 403 FORBIDDEN (cannot-manage AS-031; owner-target AS-032), 404 |

Link-open / anonymous view (S-002 AS-004/005/006/015) is enforced at the **viewer route** via the
single `resolveAccess` decision (which reads the two axes — `canViewDoc` is retired,
`doc-access-two-axis`:C-010) + link-control checks (S-004), not a separate endpoint; the anon random
name + rename (AS-004/005) is session-side, with the guest role capped at commenter at the
anonymous-admission seam (`doc-access-two-axis`:C-004). A password-gated link prompts then verifies
server-side (AS-009/016, rate-limited). Role capability + precedence (S-005 AS-012/013/014) is
cross-cutting — applied at every route via the api-core auth gate + `can()`/`effectiveRole`, not a
standalone endpoint.

## What Already Exists

### System Impact & Technical Risks

- The access model is the two axes `share_links.workspace_role` + `share_links.link_role`
  (`doc-access-two-axis`, source of truth; `docs.general_access` is dropped); this cluster adds
  doc_members/share_links + enforcement.
- Cross-spec: gate viewer-route access of `render-publish`/`versioning-diff` via the single
  `resolveAccess` decision over the two axes; who can comment/resolve (incl. no-account guests, capped
  at commenter, on a commenter+ link) in `annotation-core`.
- Risk: pending-invite depends on `auth` (activates at sign up). Password link hash
  uses better-auth's utility (`auth`).

## Not in Scope

- Request access + owner approval — v0.5.
- Transfer ownership — v0.5 (table has a slot, UI deferred).
- Multiple named share-links per doc — v0.5+.
- The new-doc default is now a FIXED two-axis value (`workspace_role=commenter`, `link_role=null`)
  written at publish (C-018; `doc-access-two-axis`:C-007). The workspace `settings.defaultAccess`
  field + publish-time inheritance are RETIRED by `doc-access-two-axis` (the default is fixed, not a
  per-workspace setting). Still deferred: an admin UI to change the workspace default role per
  workspace (v0.5+, `workspaces`), project-level default share settings, and project role override
  (v0.5, `workspace-project`).
- Block copy/download for viewers — v2.
- Editor inviting others — v0 is owner-only.

## Linked Fields

- **two-axis access state** (`{ workspaceRole, linkRole }`) — produced by this spec (AS-001/002) and
  by S-006 on the share-state read. Consumed by `render-publish`/`versioning-diff` (via the single
  `resolveAccess` decision over the two axes) when gating viewer-route access, and by the ShareDialog
  to prefill both controls. ✔ enforcement defined in S-005; the other cluster only checks before serving.
- **new-doc default at publish** (`workspace_role=commenter`, `link_role=null`) — produced at publish
  by `doc-access-two-axis`:S-002 (web → AS-005/AS-006; MCP → AS-025), written into the `share_links`
  row (persisted, served on every later read). This spec defines the LEVEL semantics the default lands
  in (C-009/C-018); `doc-access-two-axis` owns the assignment. The retired `workspaces.settings.defaultAccess`
  inheritance no longer feeds this. ✔ surface (publish) + lifecycle (persisted) — covers C-018.
- **pending invite (email→role)** — produced by S-003 (AS-008). Consumed by
  `auth` at sign up to assign the role. ✔ auth picks up by verified email.
- **new member `id`** — produced by S-003 (AS-007/AS-008) in the `POST …/invites` 201 response
  (transient create-response). Consumed by `sharing-permissions-ui:S-006` (AS-022) on the
  just-invited people-list row to target `PATCH`/`DELETE …/members/:id` WITHOUT re-reading the
  share state. ✔ surface (invite create-response) + lifecycle (FE keeps it on the optimistic row
  for the dialog session) match. (The persisted `id` is also served on the `GET …/share` read,
  AS-025 — so a re-opened dialog still has it.)
- **share-state read** (`GET …/share` → `{ workspaceRole, linkRole, level, editorsCanShare,
  people[], link{ hasPassword, expiresAt, viewLimit, viewCount, url }, viewerRole }`) — produced by
  S-006 (AS-025). Consumed by `sharing-permissions-ui` to PREFILL the ShareDialog (both axis controls)
  on open. ✔ password exposed as a boolean only (C-016); raw axes carried alongside the derived level (C-009).
- **`viewerRole`** (the caller's own role on the doc) — produced by S-006 (AS-025) on the
  `GET …/share` read (the role the gate already resolved). Consumed by `sharing-permissions-ui:C-003`
  to apply the owner-only editors-can-share gate from ANY dialog entry point (the docs-list ⋯ entry
  preloads no `effectiveRole`). ✔ surface (the prefill read) + lifecycle (read once on open) match.

## Gaps

- GAP-001 (status: resolved → AS-015, C-009): the 3 levels are kept as a DERIVED read-time summary of
  the two axes (`doc-access-two-axis`:C-008); workspace-shared (workspace_role set) =
  logged-in member (no anon/outsiders), clearly different from link-shared (link_role set). (Decided
  2026-06-07; superseded by the two-axis model 2026-06-25.)
- GAP-002 (status: open): how long until a pending invite expires? Is it needed? Source:
  "how long until a pending invite expires".
- GAP-003 (status: resolved → C-010): password link hashed with argon2id/bcrypt (same
  KDF as user password) + rate-limit. (Decided 2026-06-07 via /mf-challenge M2.)

## Clarifications — 2026-06-07

- **Single general-access instead of multi-link:** simpler, matches Google Docs;
  multi-link adds management/revoke overhead not needed in v0.
- **Anon view + random name:** matches the "send to someone without an account" wedge; a random
  name gives a seamless experience before people name themselves.
- **Pending invite:** allows inviting new people (not just those with an existing account); accept
  the coupling with auth.
- **All 3 link controls, all optional:** §4.3 marks v0; optional so they don't force complexity.
- **view-limit counts total opens** (not unique) — simple, clear.
- **Manage-sharing = Google-Docs model (revised 2026-06-08):** owner always manages; editors
  manage by default via the owner-controlled `editors_can_share` toggle (default on); viewer/
  commenter/link-holder never. Reverses the earlier owner-only v0 stance — faithful to the
  "Google-Docs-style" positioning (editors can re-share unless the owner locks it). Workspace-
  member-based management is NOT part of this (that's an org-admin concept, not Google-Docs;
  needs workspace-project) — deferred.
- **Keep 3 general-access levels:** anyone_in_workspace (logged-in internal, not exposed
  externally) is the common "share with the whole team" case, clearly different from anyone_with_link (public,
  including anon); cheap (just a membership check). Keep it for multi-workspace v2.

## Clarifications — 2026-06-23

> **SUPERSEDED 2026-06-25 by the two-axis model (`doc-access-two-axis`).** The "inherits
> `workspaces.settings.defaultAccess`" mechanism below is retired: the new-doc default is now the
> FIXED `{workspace_role: commenter, link_role: null}` written into the `share_links` row at publish,
> not a value read from the workspace setting (which is now an unread reserved seam). The
> shared-group-space *outcome* (members see + can comment on new docs by default; `restricted` =
> both axes off) is unchanged — only the mechanism. See C-018 + Clarifications-2026-06-25.

- **New-doc default flipped from `restricted` to the workspace `defaultAccess` (`anyone_in_workspace`)
  — shared-workspace model:** a doc is no longer born private; it inherits `workspaces.settings.defaultAccess`
  (default `anyone_in_workspace`, `workspaces`:C-007) at publish. This makes the workspace a shared
  group space (Shared Drive / Notion teamspace model): members see new docs by default, and
  `restricted` is the explicit per-doc opt-in for a private doc (still set via S-001/AS-002, which is
  UNCHANGED). The 3 levels, their semantics, precedence, and all gating are untouched — only the
  DEFAULT a new doc gets changed, and that default is owned by `workspaces` + assigned by the publish
  specs (C-018). Decided after the 2026-06-23 doc-access audit (the `defaultAccess` setting was
  declared but never wired); do not relitigate back to restricted-by-default.

## Spec Sizing Notes

Stories=7 (= soft target). AS=32 — **2 OVER the 30-AS hard cap** (2026-06-13, after +S-007).

The AS over the soft target come from G1 splits, each its own atom (no AS gộp):
- S-004 link controls: AS-019 (rate-limit reset), AS-020 (expiry boundary), AS-021 (expiry-before-password ordering) — 3 distinct safety atoms.
- S-001: AS-018 (invalid-role rejection), AS-022 (owner toggles editors_can_share) — 2 atoms.
- S-005 manage-sharing model: AS-014 (editor can when enabled), AS-023 (editor cannot when disabled), AS-024 (viewer never) — 3 atoms.
- S-006 read state: AS-025/026/027 — full-state / password-boolean-only / gate — 3 atoms.
- S-007 change/remove member: AS-028/029/030/031/032 — change-role / remove / revoke-pending / non-manager-refused / owner-protected — 5 atoms.

No bloat — each AS traces to one stated atom. **Hard-cap note:** this spec is ONE cohesive sharing
state-machine (T5/T6 — a split would duplicate the role/access/link/member model across files, >50%
context), and S-001..S-006 are already built, so a count-driven split now is high-churn / low-value.
The overage is documented and accepted; revisit (phase or scope-by-layer split) only if the spec grows
further. Flagged to the product owner 2026-06-13.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-07 | Initial creation (from docs/explore/sharing-permissions.md) | -- |
| 2026-06-07 | GAP-001 resolved → AS-015 + C-009 (keep 3 general-access levels) | -- |
| 2026-06-07 | /mf-challenge harden M2: C-010/C-011 + AS-016/AS-017 (password rate-limit+hash, view-limit atomic); GAP-003 resolved | -- |
| 2026-06-07 | + ## UI Notes (Component Tree from explore §UI sketches) — Minor | -- |
| 2026-06-08 | + ## API (HTTP contract: access/invites/link controls owner-only; per api-core) — Minor | -- |
| 2026-06-08 | Major: manage-sharing owner-only → Google-Docs (owner always + editor when editors_can_share toggle, default on) — C-007 rewritten, +C-015, AS-014 repurposed, +AS-022/023/024, +editors_can_share Data field | snapshot 2026-06-08.md |
| 2026-06-07 | Major: document build-time S3 guards — +C-012/013/014, +AS-018/019/020/021, C-005 expiry-boundary refined, +Spec Sizing Notes (21 AS) | snapshot 2026-06-07.md |
| 2026-06-12 | Major: +S-006 read sharing-state (GET …/share, AS-025/026/027) + C-016 (gated like writes, password boolean only); fixed STALE `## API` paths to workspace-scoped `/api/w/:workspaceId/docs/:slug/…` + added the GET …/share row — resolves sharing-permissions-ui:GAP-003 | snapshot 2026-06-12.md |
| 2026-06-13 | Major: +S-007 change/remove a doc member (AS-028..032; PATCH + DELETE members routes) + C-017 (gated like writes, owner never reassignable/removable) — resolves sharing-permissions-ui:GAP-005 | snapshot 2026-06-13.md |
| 2026-06-13 | Major: AS-025 Then + share `## API` row now carry each person's member `id` in people[], so FE S-006 can target PATCH/DELETE …/members/:id — closes sharing-permissions-ui S1 (linked-field gap) | snapshot 2026-06-13-2.md |
| 2026-06-13 | Major: S-003 AS-007/AS-008 Then + `## API` `POST …/invites` now return the new member `id` (`201 { status, id }`) + Linked Field; lets `sharing-permissions-ui:S-006` (AS-022) change/remove a JUST-invited row without re-reading the share state. Closes the AS-022 gap (a freshly invited pending person had no id → Remove silently no-op'd) | snapshot 2026-06-13-3.md |
| 2026-06-13 | Major: S-006 AS-025 Then + `## API` `GET …/share` now return `viewerRole` (the caller's own role, already resolved by the gate) + Linked Field; lets `sharing-permissions-ui:C-003` apply the owner-only editors-can-share gate from any dialog entry point (the docs-list ⋯ preloads no `effectiveRole`, so the owner saw it read-only there) | snapshot 2026-06-13-4.md |
| 2026-06-20 | Major (snapshot 2026-06-20.md): DROP the guest-commenting sub-toggle (Google-Docs model) — anon-write is gated by link role ≥ commenter, not a separate toggle. Removed AS-003 + C-003 + the `guestCommenting` field from `GET …/share`, `PUT …/access`, the S-006 read AS, the ShareDialog UI, and the share-state Linked Field. Cascades: annotation-core drops the guestCommentingEnabled gate; CLAUDE.md domain note reversed. Fixes guest-can't-comment bug by construction. | -- |
| 2026-06-22 | Major (snapshot 2026-06-22.md): setting/changing a link view limit resets the open count to 0 (fresh budget) — +AS-033 (S-004), C-008 extended, `PUT …/link` API row updated. Fixes a footgun found in dogfood: setLinkControls only updated password/expiry/viewLimit, never view_count, so a re-set limit could leave a link instantly exhausted by past opens. Scope: SET path only; rotate-resets-count left out of scope. | -- |
| 2026-06-22 | Minor: `PUT …/access` response gains `capabilityUrl` (linked field for capability-share-link:S-005/AS-027 — share box surfaces the link in-session). Contract/doc row only; no behavior AS change here. | -- |
| 2026-06-23 | Major (M6, snapshot 2026-06-23-default-access.md) — doc-access shared-workspace model: +C-018 (a new doc's `general_access` inherits the workspace `settings.defaultAccess`, default `anyone_in_workspace`, NOT hard `restricted`; cross-surface invariant covered by render-publish:AS-027 + mcp-roundtrip:AS-003). Data Model default note + Clarifications-2026-06-23 + Linked Field (`defaultAccess` consumed at publish) + Not-in-Scope narrowed (field/default/inheritance IN; admin-change-knob deferred). No AS added here (spec at 30-AS hard cap; assignment owned by the publish specs). Snapshot limit set to 12 (matches the 11 prior). | doc-access audit 2026-06-23 |
| 2026-06-25 | Major (M6) — reconciled to the TWO-AXIS access model (`doc-access-two-axis` is the source of truth): `docs.general_access` + `share_links.role` DROPPED, replaced by `share_links.workspace_role` + `share_links.link_role` (each viewer/commenter/editor/null); the 3-value level is DERIVED on read (`deriveLevel`), never stored; new-doc default is a FIXED `{workspace_role=commenter, link_role=null}` at publish (NOT inherited from `settings.defaultAccess`, now retired); browse visibility keyed on `workspace_role`; access PUT is per-axis partial; share-state read returns both axes + derived level; `canViewDoc` retired in favor of `resolveAccess`; anon capped at commenter. Rewrote Data Model, C-001/C-009/C-012/C-018, S-001 + AS-001/002/018, S-006 + AS-025, the `## API` access/share rows, UI Notes, Linked Fields, GAP-001. | doc-access-two-axis cascade |
