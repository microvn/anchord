## Explore: workspace-project

_2026-06-07_

**Feature:** The 3-tier Workspace → Project → Doc organization layer; member
management, project CRUD, browse/move/copy docs, search, and notify on reply. v0 single-workspace.

**Trigger:** First-run creates workspace + admin. Afterward: members create projects/docs, invite
members, search, receive notifications.

**UI expectation:** Sidebar project list; project view list/grid of docs (sort/filter);
member directory (admin); search bar; notification center (in-app). **[N] NEW**.

---

### Decisions

**1. Single workspace = instance (v0).**
- First-run setup: first user → **instance admin**, creates the workspace (name, branding,
  default access, provider toggle). No workspace switcher, no create-
  workspace flow. Multi-workspace / 1-instance → **v2**.

**2. Roles + who does what.**
- Workspace roles: **admin / member**.
- **Every member** creates projects + publishes docs.
- **Admin**: invite/remove members, member directory, workspace settings (auth provider
  toggle, default access policy, branding).

**3. Project = organizational folder; browse by doc-access.**
- Project CRUD: create/rename/archive/delete.
- Browse within a project (list/grid, sort, filter) **shows only docs the user has access to**
  (own/invited/general-access allows it) — project roles deferred to v0.5, so visibility
  anchors on doc-sharing, consistent with `restricted`.
- Move/copy docs between projects.

**4. Search = title + content + comments, scoped by access.**
- Postgres full-text (tsvector) over: title + text extracted from HTML/MD + comment bodies.
- Scope: across-workspace or within a project; **always filtered down to docs the user can
  access**.

**5. Notify on reply = in-app + email; to participants + owner.**
- A reply in a thread → notify everyone who has participated in that thread + the doc owner.
- Channels: in-app (notification center) + email (SMTP — already needed for verify/invite).

---

### Happy path

1. Install the instance, open it for the first time → first-run: create the admin account + name the workspace
   "Acme", enable GitHub+Google, branding logo.
2. Admin invites `dev@acme.com` (member). Dev signs up → joins the workspace.
3. Dev creates project "Billing", publishes "Payment Spec" into it.
4. Reviewer comments; author replies → reviewer receives notify in-app + email.
5. Admin searches "refund" → returns "Payment Spec" (content match) + 1 other doc they have
   access to; a restricted doc they have no access to does not appear.

### Unhappy paths

- **A non-admin member opens settings:** does not see the settings/member-manage menu;
  API rejects it.
- **Search matches an out-of-access doc:** excluded from results (does not leak existence).
- **Archive a project:** docs in it are hidden from browse by default, still accessible via
  direct link (assumption); unarchive to show them again.
- **Remove a member:** the removed member loses workspace access; docs they own → need a transfer
  (transfer is v0.5) → v0 blocks removal if they still own docs, or hands them to admin (open
  question).

### Business rules

- Single workspace; first user = admin.
- Members create projects/docs; admins manage settings/members.
- Browse + search always filter by the user's doc-access.
- Notify goes only to thread participants + owner.

### Input validation

- Workspace/project name: non-empty, max 100 (assumption).
- Move/copy: doc + destination project belong to the same workspace.
- Search query: trim, min 1 character.

### Permissions

- **admin:** member directory, invite/remove, workspace settings, provider toggle,
  branding.
- **member:** create/edit projects they created, publish docs, browse/search within access.
- Doc-level still follows the sharing cluster (a member who creates a doc → owner of that doc).

### Data impact

- `workspaces` (sketched: name, slug, settings jsonb). Exactly 1 row in v0.
- `workspace_members` (sketched: workspaceId, userId, role admin/member).
- `projects` (sketched: workspaceId, name, archivedAt).
- `docs.projectId` (already present).
- Needed: full-text index (tsvector) on docs (title + extracted text) + comments;
  a `notifications` table (userId, type, refId, read, createdAt) for in-app.
- Extracted-text: needs a job to extract text from HTML/MD when publishing a version (couples
  render-publish/versioning).

### Out of scope (v0 — defer)

- Multi-workspace / 1-instance → v2.
- Project membership/roles overriding workspace → v0.5.
- Project default share settings → v0.5.
- Tags/labels, activity log/audit, trash+restore → v0.5.
- Favorites/pin, templates → v2.
- Transfer ownership (needed when removing a member) → v0.5; v0 handles it temporarily (open question).

### Decision rationale

- Single workspace: locked by the design doc; fully avoid tenancy/switcher in v0.
- Browse by doc-access (not project membership): project roles deferred so we
  cannot rely on them; anchoring on doc-sharing keeps `restricted` meaningful.
- Search includes content+comments: AI docs are text-heavy, searching the title is not enough; Postgres FTS
  is available and cheap.
- Notify on both channels: people sent a link usually do not open the app often → email is
  needed to close the feedback loop; SMTP is already required for verify/invite.

### Assumptions (need confirmation)

- Archive hides from browse but the direct link still works.
- Workspace/project name max 100 characters.
- Notifications have read/unread state; in-app is a simple center.

### Open questions

- Removing a member who still owns docs: block, or auto-transfer ownership to admin, or force a
  transfer first? (transfer is v0.5) — need to lock a temporary approach for v0.
- Email notify: allow the user to opt out (preference) in v0 or always send? Digest or one per
  event?
- Extracted-text for search: extract at publish (store a column) or compute at index time? Affects
  the publish pipeline.
- anyone_in_workspace (sharing cluster) in single-workspace v0 is nearly = every member —
  keep it as its own tier or merge it? (already raised in sharing).

### Complexity signal: **medium**

Many facets but each is moderate; the notable parts: the FTS pipeline (extract text),
the notification system (in-app + email), and the browse↔doc-access relationship.

### Cross-cluster dependencies

- **auth:** first-run admin; member = user; SMTP for notify/verify/invite.
- **sharing-permissions:** browse/search filter by general-access + invite;
  anyone_in_workspace; admin managing members ≈ source of the member directory.
- **render-publish / versioning-diff:** extract-text when publishing a version, for search.
- **annotation-core:** notify on reply based on thread participants.
- **self-host:** SMTP config, branding, first-run, storage.

## UI sketches

Dark-operator (`DESIGN.md`). Greenfield → `[N]` NEW. Doc = the real anchord spec.

**Project browser + search** `[N]` ← S-003 (browse only accessible docs) /S-005 (search
title+content+comment) · C-009 (default project per user)
```
┌──────────────────────────────────────────────────────────────────┐
│ ⚓ microvn /     [ Find: "block_id" … ]         [+ New doc]   ⬤HG  │
├────────────┬───────────────────────────────────────────────────────┤
│ PROJECTS   │  Hoang's docs (default)        ⬤anyone-in-workspace    │
│ ▸Hoang's ◀ │  ┌────────────────┐ ┌────────────────┐                │
│  (default) │  │annotation-core │ │render-publish  │                │
│  + New     │  │[HTML] v2 ·22 AS│ │[HTML] v1 ·13 AS│                │
│ FILTER     │  │⬤link 💬3 ▣1     │ │restricted 💬0   │                │
│  All docs  │  └────────────────┘ └────────────────┘                │
│  Shared    │   (only docs you can access; others' restricted hidden;│
│  Has detach│    grid 3→2→1 columns by width)                        │
└────────────┴───────────────────────────────────────────────────────┘
```

**Notifications** `[N]` ← S-006 (reply → participant + owner, in-app + email)
```
┌─────────────────────────────────────────────┐
│ 🔔 Notifications                             │
│ ⬤ Lan replied on annotation-core · "ok 48h" 2h│
│ ⬤ An commented · S-002 image-region        5h│
│ ▣ 1 annotation detached on render-publish  1d│ ← from re-anchor
└─────────────────────────────────────────────┘
```
