# Snapshot: workspaces-ui
**Date:** 2026-06-21
**Ref:** /mf-fix Bug C (wrong-account invite dead-end)
**Reason:** M1 + M5 — AS-015 Then changed (wrong-account no longer terminal) + AS-016 added (switch-account)

---

# Spec: workspaces-ui

**Created:** 2026-06-09
**Last updated:** 2026-06-19
**Status:** Draft

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

**Description:** As an invited person, I open the invite link and accept (joining + switching to
the workspace) or reject; an invite for a different account is refused.
**Source:** workspaces:S-004 (AS-010 accept→member, AS-011 reject, AS-012 mismatched email).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (`apps/web/` workspace-invite accept/reject landing)
- `autonomous:` true
- `verify:` opening a valid invite link (matching signed-in email) → accept joins + switches; reject leaves no membership; a mismatched account is refused.

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

AS-015: An invite for a different account is refused
- **Given:** an invite was issued to `bob@acme.com`
- **When:** I open it signed in as `eve@acme.com`
- **Then:** I see "this invite isn't for you" and do not join
- **Data:** mismatched email

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

## Linked Fields

workspaces-ui is the **consumer**; `workspaces` (backend) is the producer.

- `workspaces[]` `{id, name, role, adminName}` + `activeWorkspaceId` — consumed by S-001 switcher
  on the bootstrap (read on app load). Produced by `workspaces:S-003` (AS-006) on the bootstrap
  surface (persisted + served every load). ✔.
- create / rename — consumed by S-002; produced by `workspaces:S-002` (AS-003, AS-004). ✔.
- `members[]` `{userId, email, role, status}` + invite / remove / change-role — consumed by S-003;
  produced by `workspaces:S-005` (AS-021 list) + `workspaces:S-004/S-005` (AS-009 invite, AS-014
  remove, AS-015 change-role). ✔.
- invite accept / reject — consumed by S-004; produced by `workspaces:S-004` (AS-010/011/012). ✔.

## UI Notes

New surfaces (no prior explore sketch — workspace UI didn't exist under single-workspace). All
`[N]`. DESIGN.md dark-operator; the switcher is low-contrast chrome (recedes). Mounts in the
web-core `AppShell`. Precedence: AS / Constraints > Tree.

- `WorkspaceSwitcher` `[N]` *(in the AppTopBar workspace-name slot)* → `WorkspaceMenuItem` *(admin-qualified label + active mark)* · `+ New workspace` → `CreateWorkspaceDialog`
- `CreateWorkspaceDialog` `[N]`: name field · create
- `WorkspaceSettings` `[N]` *(admin-gated, C-002)*: `RenameField` · `MembersScreen`
  - `MembersScreen` `[N]`: `MemberList` → `MemberRow` *(avatar · name/email · `RoleDropdown` · remove · `PendingTag` for pending invites)* · `InviteRow` *(emailField · `RoleSelect` · invite — inline validation AS-012)* — *mobile: full-width; tap ≥40px*
- `WorkspaceInviteLanding` `[N]` *(route from the invite email: workspace name + inviter + Accept / Reject; wrong-account message AS-015)*

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
