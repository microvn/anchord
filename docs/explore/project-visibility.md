# Explore: Project Visibility (private / public)
_2026-06-26_

**Feature:** Add a `private | public` visibility axis to projects. Private = the project shell is
hidden from everyone except its owner (soft — see scope); public = shared with the whole workspace.
A project's visibility ALSO sets the default access of NEW docs created in it. The auto default
project is private; user-created projects are public.
**Trigger:** user (or agent) creates/opens a project; user publishes a new doc into a project; owner toggles a project's visibility.
**UI expectation:** existing Projects grid + New-doc dialog (both already shipped); add a private/public indicator badge, a visibility toggle in project settings, and an alert dialog on doc-move across a visibility boundary.

## Central invariant (the one rule, applied everywhere a project is fetched)

> **A project is visible to user U ⟺ `project.ownerId == U` OR `project.visibility == public`.**

- U sees: ALL of U's own projects (default-private + any U created, regardless of visibility) + every public project (anyone's).
- U does NOT see: other people's private projects.
- **No admin exception** — workspace admin runs the same predicate, so admin does NOT see other members' private projects either (true privacy, locked decision below).
- Applied at EVERY project-fetch surface: Projects list, New-doc project picker, MCP `list_projects` / `read_project`, breadcrumb/project-name resolution. This is the project analogue of `canBrowseDoc` (one shared predicate; no per-surface drift).

## Data Model

- **projects** — add `visibility` ∈ `private | public` (NOT NULL). Existing columns unchanged
  (`id, workspace_id, name, owner_id, is_default, archived_at, created_at`).
  - `ensureDefaultProject` sets `visibility = private` (the auto per-member default project).
  - `createProject` sets `visibility = public` by default (web user-created + MCP), param-overridable.
- **No change to docs/share_links schema** — doc access stays the two axes (`workspace_role` + `link_role`).
- **Default-access derivation moves from fixed to project-derived** (amends `doc-access-two-axis` S-002/C-007):
  a new doc's `share_links` row at publish is set from the TARGET project's visibility:
  - public project → `workspace_role = commenter, link_role = null` (the current shared default).
  - private project → `workspace_role = null, link_role = null` (derived `restricted`).

## Happy path

1. User opens **New doc** dialog → picks a project (picker defaults to their default project, which is **private**).
2. Each project option shows a **private/public badge**; a hint reflects the resulting doc default
   ("Private project → this doc will be private" / "Public project → visible to the workspace").
3. User publishes → the doc's `share_links` row is created from the project's visibility
   (private→restricted, public→workspace=commenter).
4. In the **Projects** grid, the user sees: their own default (Default badge + private indicator),
   their own created projects, and every public project — never another member's private project.

## Multi-role / actors

- **Owner** of a project: sees it always; can rename/archive/delete (default protected); can toggle its visibility.
- **Other member**: sees the project only if it is public; sees public-project docs filtered per-doc.
- **Workspace admin**: NO special project visibility — same invariant; sees own + public only.
  Can rename/archive/delete + toggle visibility only on projects they can see (i.e. public ones).
- **MCP agent (identity token)**: `create_project(name, visibility?)` (default public); `create_document` inherits the target project's visibility; `list_projects`/`read_project` run the invariant.

## Business rules

- New-doc default = f(target project visibility): private→`{null,null}` (restricted); public→`{commenter,null}`.
- Toggling a project private↔public affects ONLY docs created AFTER the change; existing docs keep their current sharing (consistent with "visibility sets the default, not a retro-gate").
- **Soft private**: private hides the project shell (via the invariant) and sets new-doc defaults. It does NOT hard-gate docs already inside — a doc explicitly shared (workspace_role set) inside a private project STILL appears to members via All-docs / search / its link, per the two-axis rules. "Private project" ≠ "private docs".
- Default project is protected from archive/delete (unchanged); it is private and cannot be made... (open: can the default project be toggled public? see Open questions).

## Permissions

- **See a project (any fetch surface):** the invariant (`ownerId==U OR public`).
- **Create a project:** any workspace member (unchanged). Visibility on create: web user-created → public; MCP → param (default public).
- **Rename / archive / delete:** owner-or-admin (unchanged) — but admin only reaches public projects (can't see private), so effectively owner-only for private.
- **Toggle visibility:** owner always; admin only on public projects (admin can't see private to toggle them). [locked]

## Edge cases

- **Doc-move across a visibility boundary** — moving a doc INTO a project whose visibility differs
  from the doc's current access → show an **alert dialog**: "This project is private — make this doc
  private too, or keep its current sharing?" User chooses; never silent either way. (Move itself
  never auto-changes access without the prompt.)
- **Empty private default project**: shows only to its owner; other members simply don't see it (fixes the "4 Default badges" clutter from the current build).
- **Shared doc inside a private project**: visible to members via All-docs (soft model). Its breadcrumb/project-name can surface the private project's NAME to a doc viewer — accepted (project names aren't sensitive); flagged.
- **Migration / greenfield**: no production users → reset+reseed. Seed sets `visibility` (default projects→private, user-created→public). If a backfill were needed: `is_default ? private : public`.

## Out of scope

- Per-project ROLE override (granting a role at project level that overrides per-doc access) — still deferred to v0.5 (`workspace-project`). This feature is visibility-only, not project-level access roles.
- A hard-containment "vault" project (true gate hiding even shared docs inside) — explicitly rejected; we chose soft private.
- MCP tool to TOGGLE/UPDATE a project's visibility after creation — out of v0; visibility is set at MCP create (param) and toggled only on the web.
- Project-level password / expiry / link — projects are not shareable units; sharing stays per-doc.

## Impact on existing system

- **Amends `doc-access-two-axis`** S-002/C-007: the new-doc publish default is no longer a fixed
  `{commenter,null}` — it is derived from the target project's visibility. The publish path
  (`publish/service.ts` + `publish/repo.ts createDocWithV1`) must read the resolved project's
  visibility and set the `share_links` row accordingly.
- **`workspace-project`**: add the `visibility` field, the central invariant on the projects-list
  query (`repo.listActive/listAll` currently return ALL workspace projects — must filter), the
  create/toggle routes, and the list payload (`{ isDefault, visibility }`).
- **`workspace-project-browse`**: the project-list predicate gains the visibility invariant.
- **`mcp-roundtrip`**: `create_project` gains an optional `visibility` param; `create_document`
  default-access now derives from project visibility.
- **Activity / search**: docs already filter per-doc; confirm a private project's own events (e.g.
  "created a project") don't leak to other members' activity (open question).

## UI sketches

```
┌─ Projects page [E] apps/web/src/features/.../projects (list) ───────────────┐
│  Header: "Projects"  [Show archived] [+ New project] [E]                     │
│  Project card [E]:                                                           │
│    folder icon · name · [Default badge] [E]  · [Private|Public badge] [N]    │
│    · ⋯ menu [E] (rename/archive/delete + Make public/private [N])            │
│  (list is FILTERED by the invariant — only own + public shown [N: query])    │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ New doc dialog [E] new-doc-dialog.tsx ─────────────────────────────────────┐
│  Title · content/upload [E]                                                  │
│  Project picker [E] new-doc-project-picker.tsx                               │
│    each option: name + [Private|Public badge] [N]                            │
│  Hint [N]: "Private project → this doc will be private" /                    │
│            "Public project → visible to the workspace"                       │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ Doc-move (drag into / move-to project) [E?] doc-move ──────────────────────┐
│  On move across a visibility boundary →                                      │
│  AlertDialog [N]: "This project is private. Make this doc private,           │
│    or keep its current sharing?"  [Make private] [Keep sharing] [Cancel]     │
└──────────────────────────────────────────────────────────────────────────────┘

Legend: [E] existing · [N] NEW · [X] missing/clarify
```
- `[E]` New-doc dialog + project picker: `apps/web/src/features/docs/components/new-doc-dialog.tsx`, `new-doc-project-picker.tsx`.
- `[E]` Projects list + Default badge: projects route payload already carries `isDefault`.
- `[N]` private/public badge + visibility toggle (⋯ menu / project settings) + new-doc visibility hint + doc-move alert dialog.

## Decision rationale

- **Soft private (not hard containment)** because the client wants docs to keep sharing per the two-axis rules; private is about the project SHELL + new-doc default, not a per-project gate. If a true "vault" need appears later → revisit (separate feature).
- **Default project = private, user-created = public** because a member's own "scratch" space should be private by default (own-your-data posture), while a project you deliberately create to collaborate is shared. This deliberately **reverses** doc-access-two-axis C-007 for the default-project path (quick publish → private), and the client accepted that.
- **Admin cannot see private projects** — chosen for true privacy over governance. Trade-off accepted: an admin loses visibility into / cleanup of members' private projects.
- **Toggle = owner + admin(public-only)** — follows from admin not seeing private projects.
- **Doc-move shows an alert** rather than silently keeping or restricting — avoids both accidental over-sharing and accidental loss of an intended share.
- **One invariant `ownerId==U OR public`** applied everywhere — prevents per-surface drift (the canBrowseDoc lesson) and auto-encodes the admin decision with no special-case.

## Assumptions (confirm at spec time)

- Visibility stored as a `visibility` enum column (`private|public`), NOT a nullable `is_private` boolean — keeps it explicit and matches the two-value intent.
- The default project STAYS private and is typically not toggled, but the toggle is allowed on it (owner) unless we decide to lock it (open question).
- Existing seeded docs inside a (now-private) default project keep their current sharing (workspace-shared) — only NEW docs get the private default.

## Open questions

- Can the **default project** itself be toggled public, or is it locked private? (Toggling it public would make the member's quick-publish docs workspace-shared again — basically opting back into the old shared-default.)
- Does a **private project's own activity** (e.g. "created project X", "published doc in X") appear in other members' workspace activity feed? Should the activity visibility gate also respect project visibility?
- **Breadcrumb leak**: when a member opens a *shared* doc that lives in someone's *private* project, do we show the private project's name in the breadcrumb, or suppress it? (Soft model currently leaks the name.)
- Visibility field representation: `visibility` enum vs `is_private` boolean — confirm.

## Complexity signal: medium
Based on: 1 schema field + 1 shared predicate (project list, applied at 4 fetch surfaces) + publish-default rework (amends a just-built spec) + FE badges/toggle/alert-dialog + MCP create_project param. Touches 4–5 specs. No new external integration; no concurrency beyond the existing per-axis writes.

## Technical risks
- **Amends doc-access-two-axis (just built + cascaded)**: the fixed `{commenter,null}` default in `publish/repo.ts` becomes project-derived. Must update the spec + the publish path + the live-PG publish itests (AS-005/006/025 assert the fixed default) so they assert the project-derived default instead.
- **Projects-list query change**: `repo.listActive/listAll` currently return ALL workspace projects; adding the `ownerId==U OR public` filter must not break the doc-count GROUP BY or pagination, and must be applied identically on web + MCP list.
- **Migration ordering** (greenfield → reseed): the `visibility` column is NOT NULL; seed + ensureDefaultProject/createProject must all set it, or inserts fail.
