# Snapshot: workspaces-ui
**Date:** 2026-06-22
**Ref:** drop "My Default" label → stored name + creator-mark
**Reason:** M4/M5 — AS-001 switcher label rule reworked: show stored name; "mine" from creator_id (not name+role)

---

# Spec: workspaces-ui

**Created:** 2026-06-09
**Last updated:** 2026-06-21
**Status:** Draft
**Snapshot limit:** 6

## Overview

The frontend for multi-workspace tenancy — the consumer side of `workspaces` (backend). It
gives the user a **workspace switcher** (list the workspaces they belong to, switch the active
one), **create / rename** a workspace, a **members screen** (admin: invite by email, remove,
change role), and an **invite accept/reject landing**. Builds on `web-core` (shell, router,
session, typed client) and consumes the `workspaces` backend. Ships into `apps/web`.

Active-workspace scope is the URL path `/w/:workspaceId/…` (matching the backend's
`/api/w/:workspaceId/…`): switching = navigating to another workspace's path; the active
workspace is whatever is in the route, not a hidden global.

## Data Model

No persistent data — a client. Reads the bootstrap (my workspaces + active) and per-workspace
member lists; client state holds the active workspace (derived from the route) and TanStack
Query keys scoped by `workspaceId`.

## Stories

### S-001: Switch the active workspace (P0)

**Description:** As a user in several workspaces, I see them in a switcher (each shown by its
title-cased name; my own auto-created default reads "My Default") and switch the active one,
which re-scopes the whole app.
**Source:** workspaces:S-003 (AS-006 bootstrap list + role + active); researched path-scoping + query-key-by-workspace.

**Execution:**
- `depends_on:` none (builds on web-core)
- `parallel_safe:` false
- `files:` unknown (`apps/web/` workspace switcher in the top bar + active-workspace route context + workspace-scoped query keys)
- `autonomous:` true
- `verify:` the switcher lists my workspaces with the active one marked; selecting another switches and shows that workspace's data; a workspace id in the URL I don't belong to redirects me away.

**Acceptance Scenarios:**

AS-001: The switcher lists my workspaces with the active one marked
- **Given:** I own the auto-created "default" workspace and am a member of Lan's "default", and I also own a workspace named "hoang nguyen"
- **When:** the app loads
- **Then:** the switcher lists them, each labelled with its title-cased name ("default" → "Default", "hoang nguyen" → "Hoang Nguyen"); the ONE exception is my own auto-created default workspace, which reads "My Default" to mark it as my home — no other workspace is admin-qualified (the workspace I'm only a member of shows plain "Default"); the active workspace is marked
- **Data:** owner-default → "My Default"; member-default → "Default"; owner "hoang nguyen" → "Hoang Nguyen"

AS-002: Selecting a workspace switches the active scope
- **Given:** I am viewing workspace "default"
- **When:** I pick "Acme" in the switcher
- **Then:** the app navigates into "Acme" and shows only "Acme"'s data (projects/docs), not "default"'s
- **Data:** distinct content per workspace

AS-003: A workspace I do not belong to does not load
- **Given:** the URL carries a workspace id I am not a member of (stale link / typo)
- **When:** the app loads that route
- **Then:** I am redirected to a workspace I do belong to (or a "no access" state), never a broken or empty app showing nothing
- **Data:** non-member / stale workspace id

### S-002: Create and rename a workspace (P1)

**Description:** As a user, I create a new workspace (becoming its admin, and the app switches
to it) and rename a workspace I own; a non-admin has no rename control.
**Source:** workspaces:S-002 (AS-003 create→admin, AS-004 rename, AS-005 non-admin refused).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (`apps/web/` create-workspace dialog + rename control)
- `autonomous:` true

**Acceptance Scenarios:**

AS-004: Creating a workspace switches into it as admin
- **Given:** I am signed in
- **When:** I create a workspace named "Acme"
- **Then:** "Acme" appears in the switcher with me as admin and the app switches into it
- **Data:** name "Acme"

AS-005: Renaming a workspace I own updates it everywhere
- **Given:** I own "Acme"
- **When:** I rename it to "Acme Docs"
- **Then:** the new name shows in the switcher and the top bar
- **Data:** new name "Acme Docs"

AS-006: A non-admin sees no rename control
- **Given:** I am a member (not admin) of "Acme"
- **When:** I view the workspace
- **Then:** no rename affordance is offered (admin-only)
- **Data:** member, not admin

### S-003: Manage workspace members (admin) (P0)

**Description:** As a workspace admin, I open a members screen to see members and pending
invites, invite by email, remove a member, revoke a pending invite, and change a member's role;
a non-admin cannot manage. Destructive actions (remove, revoke) ask for confirmation first.
**Source:** workspaces:S-004 (invite AS-009, only-admin AS-013), S-005 (remove AS-014, change-role AS-015, non-admin AS-017, member-list AS-021).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (`apps/web/` members screen — list, invite row, role dropdowns, remove)
- `autonomous:` true
- `verify:` an admin sees members + pending invites and can invite/remove/change-role; a member sees no manage controls.

**Acceptance Scenarios:**

AS-007: The admin sees members and pending invites
- **Given:** I own "Acme" with member Bob and a pending invite for `eve@acme.com`
- **When:** I open the members screen
- **Then:** I see Bob (member) and the pending invite for `eve@acme.com` with its status
- **Data:** 1 member + 1 pending invite

AS-008: The admin invites a member by email
- **Given:** I am on the members screen of "Acme" I own
- **When:** I enter `dev@acme.com`, pick a role, and invite
- **Then:** a pending invite for `dev@acme.com` appears in the list
- **Data:** email `dev@acme.com`

AS-009: The admin removes a member after confirming
- **Given:** Bob is a member of "Acme"
- **When:** I click remove on Bob and confirm in the dialog
- **Then:** Bob disappears from the members list
- **Data:** member Bob

AS-010: The admin changes a member's role
- **Given:** Bob is a member of "Acme"
- **When:** I change Bob's role to admin
- **Then:** Bob's role shows as admin in the list
- **Data:** promote Bob

AS-011: A non-admin cannot manage members
- **Given:** I am a member (not admin) of "Acme"
- **When:** I open the workspace
- **Then:** I see no member-management controls (invite/remove/change-role hidden or disabled; the members view is read-only or unavailable)
- **Data:** member, not admin

AS-012: An invalid invite email is rejected before sending
- **Given:** I am on the members screen
- **When:** I try to invite `not-an-email`
- **Then:** I see an inline validation error and no invite is created
- **Data:** malformed email

AS-016: Cancelling the remove confirmation keeps the member
- **Given:** Bob is a member of "Acme"
- **When:** I click remove on Bob and choose Cancel in the confirmation dialog
- **Then:** the dialog closes and Bob is still a member of "Acme"
- **Data:** member Bob

AS-017: Revoking a pending invite requires confirmation
- **Given:** "Acme" has a pending invite for `eve@acme.com`
- **When:** I click revoke on the invite and confirm in the dialog
- **Then:** the pending invite for `eve@acme.com` disappears from the list
- **Data:** pending invite `eve@acme.com`

### S-004: Accept or reject a workspace invite (P0)

**Description:** As an invited person, I open the invite link on a public landing that adapts to
my state: signed in with the matching email → accept (join + switch) or reject; signed in as a
different account → refused with a switch-account path; signed out with an existing account →
sign in to accept; signed out with no account → create my account inline and join (no separate
sign-up page, no email-verification step — the invite proves my email).
**Source:** workspaces:S-004 (AS-010 accept→member, AS-011 reject, AS-012 mismatched email, AS-022 validate, AS-024 accept-as-new-user); unified invite-flow design 2026-06-21.
**Applies Constraints:** C-005

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (`apps/web/` workspace-invite landing — moved OUTSIDE AuthGuard to a public token-addressed route; validate-driven state branch; inline create-account form)
- `autonomous:` checkpoint
- `verify:` a valid invite link (matching signed-in email) → accept joins + switches; reject leaves no membership; a mismatched account is refused but offered switch-account; signed out + the invited email already has an account → "sign in to accept" carrying the invite (web-core:AS-004); signed out + no account → the inline create form makes the account + joins + switches with no verify step.

**Acceptance Scenarios:**

AS-013: Accepting an invite joins and switches to the workspace
- **Given:** I hold a valid invite link to "Acme" and am signed in with the matching email
- **When:** I open the landing and accept
- **Then:** I become a member of "Acme" and the app switches into it
- **Data:** matching signed-in email

AS-014: Rejecting an invite leaves no membership
- **Given:** I hold a valid invite link
- **When:** I open the landing and reject
- **Then:** I do not become a member and stay where I was
- **Data:** reject action

AS-015: An invite for a different account is refused, but offered a way out
- **Given:** an invite was issued to `bob@acme.com`
- **When:** I open it signed in as `eve@acme.com`
- **Then:** I see "this invite isn't for you" (naming both the invited address and the account I'm signed in as) and cannot accept as `eve@acme.com`; the screen is NOT a dead-end — it offers to sign in as the invited account, plus a way back to my own workspaces
- **Data:** mismatched email

AS-022: Switching to the invited account from the wrong-account state returns to the invite
- **Given:** I am on the wrong-account refusal (AS-015), signed in as `eve@acme.com`, for an invite issued to `bob@acme.com`
- **When:** I choose to sign in as the invited account
- **Then:** I am signed out of `eve@acme.com` and sent to sign-in, which carries this invite as its return target (web-core:AS-004) so that signing in as `bob@acme.com` lands me back on the invite to accept it
- **Data:** wrong-account refusal → switch-account action

AS-023: An invited email that already has an account is offered sign-in-to-accept
- **Given:** an invite for `bob@acme.com`, who already has an account, and I open the invite link with no active session
- **When:** the landing loads (the invite token validates and reports an account exists for the invited email)
- **Then:** I see "you already have an account — sign in to accept" and a sign-in action that carries this invite as its return target (web-core:AS-004); I am NOT shown a create-account form and NOT dropped on a generic sign-in dead-end
- **Data:** existing account for the invited email, no session
- **Setup:** a pending invite whose email already has an account

AS-024: An invited email with no account creates the account inline and joins
- **Given:** an invite for `new@acme.com`, which has no account, and I open the invite link with no active session
- **When:** I enter my name and a password (≥8) on the landing's create-account form (the invited email is shown read-only) and submit
- **Then:** my account is created for `new@acme.com` with no separate email-verification step, I am signed in, I become a member of the workspace, and the app switches into it
- **Data:** new email, name + 8-char password, no prior account
- **Setup:** a pending invite whose email has no account

## Constraints & Invariants

- C-001: The switcher shows ONLY workspaces I belong to, each labelled with its admin; switching
  re-scopes the whole app to the chosen workspace (the active workspace is the URL path, and data
  queries are keyed by workspace so switching never shows another workspace's cached data). (AS-001, AS-002, AS-003)
- C-002: Member-management controls (invite / remove / change-role / rename) are shown only to a
  workspace admin; a non-admin sees a read-only view (or no manage affordance). (AS-006, AS-011)
- C-003: Every workspace screen uses the DESIGN.md dark-operator system (teal-only accent) and is
  responsive (switcher + members screen reflow on tablet/mobile; tap targets ≥40px). (AS-001, AS-007; responsive/pixel visual is [→MANUAL], inheriting web-core's responsive shell + tokens)
- C-004: Every destructive action (remove a member, revoke a pending invite) shows a confirmation
  dialog and only mutates on explicit confirm; cancelling leaves state unchanged. (AS-009, AS-016, AS-017)
- C-005: The invite landing is a public, token-addressed route (reachable signed-out, like the
  doc viewer outside AuthGuard) and NEVER bounces an invitee to a generic sign-in dead-end. It
  branches by the active session and whether the invited email has an account: matching session →
  accept/reject; wrong session → switch-account; no session + existing account → sign-in-to-accept
  carrying the invite; no session + no account → create-account-and-join inline. (AS-013, AS-014, AS-015, AS-022, AS-023, AS-024)

## Linked Fields

workspaces-ui is the **consumer**; `workspaces` (backend) is the producer.

- `workspaces[]` `{id, name, role, adminName}` + `activeWorkspaceId` — consumed by S-001 switcher
  on the bootstrap (read on app load). Produced by `workspaces:S-003` (AS-006) on the bootstrap
  surface (persisted + served every load). ✔.
- create / rename — consumed by S-002; produced by `workspaces:S-002` (AS-003, AS-004). ✔.
- `members[]` `{userId, email, role, status}` + invite / remove / change-role / revoke-invite —
  consumed by S-003 (AS-008 invite, AS-009 remove, AS-010 change-role, AS-017 revoke pending invite);
  produced by `workspaces:S-005` (AS-021 list) + `workspaces:S-004/S-005` (AS-009 invite, AS-014
  remove, AS-015 change-role, AS-026 revoke). ✔. Revoke targets the invitations surface (an invite
  id is not a membership id) — distinct from member-remove.
- invite accept / reject — consumed by S-004; produced by `workspaces:S-004` (AS-010/011/012). ✔.
- `accountExists` (+ workspace name + invited email) — consumed by S-004 (AS-023/AS-024 branch) on
  the invite-**validate** surface, read on the public landing BEFORE branching (no session). Produced
  by `workspaces:S-004` (AS-022) on the validate surface. ✔ surface + lifecycle match. Seam: S-004's
  `verify` exercises the FE branch against the REAL validate (not mocked).
- create-account-and-join (accept-as-new-user) — consumed by S-004 (AS-024) on the landing's inline
  create form. Produced by `workspaces:S-004` (AS-024) — creates a verified account + session +
  membership in one call. ✔. Seam: S-004 `verify` runs the inline create against the real endpoint.

## UI Notes

New surfaces (no prior explore sketch — workspace UI didn't exist under single-workspace). All
`[N]`. DESIGN.md dark-operator; the switcher is low-contrast chrome (recedes). Mounts in the
web-core `AppShell`. Precedence: AS / Constraints > Tree.

- `WorkspaceSwitcher` `[N]` *(in the AppTopBar workspace-name slot)* → `WorkspaceMenuItem` *(admin-qualified label + active mark)* · `+ New workspace` → `CreateWorkspaceDialog`
- `CreateWorkspaceDialog` `[N]`: name field · create
- `WorkspaceSettings` `[N]` *(admin-gated, C-002)*: `RenameField` · `MembersScreen`
  - `MembersScreen` `[N]`: `MemberList` → `MemberRow` *(avatar · name/email · `RoleDropdown` · remove · `PendingTag` for pending invites)* · `InviteRow` *(emailField · `RoleSelect` · invite — inline validation AS-012)* — *mobile: full-width; tap ≥40px*
- `WorkspaceInviteLanding` `[N]` *(PUBLIC route from the invite email, outside AuthGuard; validates the token then branches by session + accountExists — C-005)*
  - `InviteAcceptCard` *(matching session → workspace name + inviter + Accept / Reject — AS-013/014)*
  - `WrongAccountCard` *(wrong session → names both addresses + Sign in as invited + Back to workspaces — AS-015/022)*
  - `SignInToAcceptCard` *(no session + existing account → "you already have an account" + Sign in carrying the invite — AS-023)*
  - `CreateAccountAndJoinForm` *(no session + no account → invited email read-only + name + password → create & join, no verify step — AS-024)*

## What Already Exists

### System Impact & Technical Risks

- `web-core` provides the AppShell (with a workspace-name SLOT in the top bar), router, session,
  typed client, theme, and shared primitives (EmptyState/ErrorState) — workspaces-ui fills the
  slot with the switcher and adds the workspace screens.
- Producer is `workspaces` (backend), which is itself a large rework (route restructure under
  `/api/w/:id/`, setup removal, role enum) — workspaces-ui depends on it being built first.
- The active-workspace-in-the-URL + query-keys-by-workspace pattern is the researched approach;
  the SPA routes move under `/w/:id/…` to mirror the API.
- This shares the "accept an invite" pattern with `auth-ui`'s per-doc invite landing but is a
  DISTINCT flow (workspace membership vs a doc role); see GAP-002.

## Not in Scope

- Workspace deletion, leave-workspace (self-removal), domain-allowlist auto-join — backend defers these (v0.5+).
- Per-doc sharing UI (the Share dialog) — `sharing-permissions-ui` (orthogonal to workspace membership).
- The workspace's projects/docs/browse screens — `workspace-project-ui` (rendered inside the active workspace).

## Gaps

- GAP-001 (status: open): on switching workspace, the FE must scope/clear cached data so no
  other workspace's content flashes — researched answer is "TanStack Query keys include
  workspaceId" (divergent keys, no manual invalidation). Confirm this is the mechanism the build adopts. Source: researched query-cache-on-switch.
- GAP-002 (status: open): the workspace-invite accept/reject landing (`WorkspaceInviteLanding`)
  vs `auth-ui`'s per-doc invite-accept landing — are they one shared accept surface keyed by
  invite type, or two distinct routes? Recommendation: distinct routes (workspace membership and
  a doc role are different outcomes). Source: overlap noted in What Already Exists.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-09 | Initial creation — FE multi-workspace (switcher, create/rename, members, invite-accept) | -- |
| 2026-06-19 | Major (M5) — AS-001 switcher label rule reworked: drop admin-qualified "My <name>"/"<admin>'s <name>"; every workspace shows its title-cased name; ONLY the owner's auto-created "default" workspace reads "My Default". Breadcrumb (web-core AS-017) mirrors this label. Snapshot 2026-06-19-label.md. | -- |
| 2026-06-10 | Major — added C-004 (confirm-before-destructive); AS-009 now via confirm; added AS-016 (cancel keeps member), AS-017 (revoke pending invite w/ confirm); S-003 scope adds revoke. Snapshot 2026-06-10.md | -- |
| 2026-06-21 | Major (M1+M5) — S-004 wrong-account invite is no longer a dead-end: AS-015 Then reworked (names both addresses; offers switch-account + back-to-workspaces); added AS-022 (switch-account → sign out + return to the invite via sign-in, web-core:AS-004). S-004 verify covers the signed-out→return path. Snapshot 2026-06-21-invite-switch-account.md. | /mf-fix Bug C |
| 2026-06-21 | Major (M1+M6) — unified invite flow: S-004 landing made PUBLIC + state-branched; added AS-023 (existing account, signed out → sign-in-to-accept) + AS-024 (no account → create-account-and-join inline, no verify step); +C-005 (public token-addressed landing, branch by session+accountExists); S-004 → checkpoint; Linked Fields + UI Notes updated (`accountExists` validate + accept-as-new-user, both pinned w/ seam). Snapshot 2026-06-21-invite-states-3-4.md. | unified invite design |
| 2026-06-21 | Minor — Linked Fields: pinned revoke-pending-invite (S-003 AS-017 consumer) to its now-built producer `workspaces:S-004 AS-026`; noted revoke targets the invitations surface, not member-remove (the 404 fix). | /mf-fix revoke 404 |
