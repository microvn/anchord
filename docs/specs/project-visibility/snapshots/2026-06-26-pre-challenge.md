# Spec: project-visibility

**Created:** 2026-06-26
**Last updated:** 2026-06-26
**Status:** Draft
**Snapshot limit:** 5

## Overview

Give a project a `private | public` visibility. **Private** = the project shell is visible only to
its owner (soft — docs inside still follow per-doc sharing); **public** = shared with the whole
workspace. A project's visibility also sets the DEFAULT access of new docs created in it. The
auto-created default project is private; user-created projects are public. One invariant governs
every place a project is fetched. This SUPERSEDES the fixed new-doc default from `doc-access-two-axis`
(now project-derived) and is the project-level visibility deferred earlier by `workspace-project`.

## Data Model

- **projects** — add `visibility` ∈ `private | public` (NOT NULL). Existing columns
  (`id, workspace_id, name, owner_id, is_default, archived_at, created_at`) unchanged.
  - `ensureDefaultProject` (the auto per-member default project) sets `visibility = private`.
  - `createProject` (web user-created + MCP) sets `visibility = public` by default; MCP `create_project`
    accepts an optional `visibility` to override.
- **No docs / share_links schema change** — doc access stays the two axes (`workspace_role` + `link_role`).
- **Greenfield**: no production users → reset + reseed. The seed sets `visibility` on every project
  (default projects → private, others → public). `visibility` is NOT NULL, so every insert path
  (ensureDefaultProject, createProject, seed) MUST set it.
- **New-doc default derivation** (moves from fixed to project-derived; amends `doc-access-two-axis`
  S-002/C-007): at publish, a new doc's `share_links` row is set from the TARGET project's visibility —
  public → `{ workspace_role: commenter, link_role: null }`; private → `{ workspace_role: null, link_role: null }`.

## Stories

### S-001: A project carries a private/public visibility (P0)

**Description:** As a workspace member, every project I create or own has a visibility. My auto
default project is private; a project I deliberately create is public. An agent creating a project
over MCP gets public by default but may specify private.
**Source:** docs/explore/project-visibility.md#data-model + #happy-path (default private, user-created public; MCP param).
**Applies Constraints:** C-001

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/backend/src/db/schema.ts`, `apps/backend/drizzle/*`, `apps/backend/src/db/seed.ts`, `apps/backend/src/workspace/projects.ts` (createProject + ensureDefaultProject set visibility), `apps/backend/src/routes/projects.ts` (create body), `apps/backend/src/mcp/tools/project-tools.ts` (create_project visibility param)
- `autonomous:` checkpoint
- `verify:` sign up → default project is private; create a project on web → public; MCP create_project(name) → public; MCP create_project(name, visibility=private) → private.

**Acceptance Scenarios:**

AS-001: A user-created project is public
- **Given:** a workspace member on the Projects page
- **When:** they create a new project "Vantage"
- **Then:** the project is created with visibility = public (shared with the workspace)
- **Data:** create "Vantage" → visibility public

AS-002: The auto default project is private
- **Given:** a new account joining/creating a workspace
- **When:** their default project ("<name>'s docs") is auto-created
- **Then:** that default project has visibility = private (only its owner sees it)
- **Data:** signup → default project visibility private

AS-003: MCP create_project defaults to public
- **Given:** an agent with a workspace identity token
- **When:** it calls create_project with only a name
- **Then:** the project is created public
- **Data:** MCP create_project("Specs") → public

AS-004: MCP create_project honors an explicit private visibility (boundary)
- **Given:** an agent with a workspace identity token
- **When:** it calls create_project with name + visibility = private
- **Then:** the project is created private
- **Data:** MCP create_project("Drafts", private) → private

### S-002: Projects are visible by the ownership-or-public invariant (P0)

**Description:** As a workspace member, anywhere projects are listed (Projects page, the New-doc
project picker, MCP list/read), I see all of my own projects plus every public project — never
another member's private project. A workspace admin gets no exception.
**Source:** docs/explore/project-visibility.md#central-invariant.
**Applies Constraints:** C-002, C-003

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/workspace/projects.ts` (the shared `canViewProject` predicate), `apps/backend/src/workspace/repo.ts` (projects-list query filter), `apps/backend/src/routes/projects.ts`, `apps/backend/src/mcp/tools/read-tools-wiring.ts` (list_projects + read_project), `apps/web/src/features/docs/components/new-doc-project-picker.tsx`
- `autonomous:` true
- `verify:` as member B, the Projects list + New-doc picker show only B's own projects + public ones; A's private project is absent. MCP list_projects for B omits A's private project.

**Acceptance Scenarios:**

AS-005: A member sees their own private project
- **Given:** member B who owns a private project "B's docs"
- **When:** B opens the Projects page
- **Then:** "B's docs" appears in B's list
- **Data:** owner B, private project → visible to B

AS-006: A member does not see another member's private project
- **Given:** member A owns a private project; member B is in the same workspace, not the owner
- **When:** B opens the Projects page
- **Then:** A's private project is absent from B's list
- **Data:** A private project, B browsing → absent

AS-007: A public project is visible to every member
- **Given:** a public project owned by A
- **When:** member B opens the Projects page
- **Then:** the public project appears in B's list
- **Data:** A public project, B browsing → visible

AS-008: A workspace admin gets no exception (boundary)
- **Given:** member A owns a private project; C is a workspace admin (not the owner)
- **When:** C opens the Projects page
- **Then:** A's private project is absent for C — admin sees only own + public, same as any member
- **Data:** A private project, admin C browsing → absent

AS-009: The New-doc project picker applies the same invariant
- **Given:** member B opening the New-doc dialog; A owns a private project + a public project
- **When:** the project picker renders
- **Then:** the picker offers B's own projects + the public project, never A's private project
- **Data:** B's picker → own + public only

AS-010: MCP list/read applies the same invariant
- **Given:** an agent acting for member B; A owns a private project
- **When:** the agent lists workspace projects (and tries to read A's private project by id)
- **Then:** the list omits A's private project, and reading it by id is refused (indistinguishable from not-found)
- **Data:** MCP list for B → A's private absent; read A's private → not found

### S-003: Toggle a project's visibility (P1)

**Description:** As a project owner (or an admin, for a public project), I switch a project between
private and public; the change affects only docs created afterward. The Projects list shows a
default badge and a private/public indicator.
**Source:** docs/explore/project-visibility.md#permissions + #business-rules (toggle owner+admin(public), only-new-docs) + #data-model (list payload isDefault+visibility).
**Applies Constraints:** C-004, C-005, C-009

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/routes/projects.ts` (set-visibility route), `apps/backend/src/workspace/projects.ts` (setVisibility domain + owner/admin gate), `apps/backend/src/workspace/repo.ts` (list payload carries visibility), `apps/web/src/features/docs/components/*` (project card badge + ⋯ menu toggle)
- `autonomous:` true
- `verify:` owner toggles a project private↔public; a member who is neither owner nor admin is refused; an admin can toggle a public project; an existing shared doc in a now-private project keeps its sharing.

**Acceptance Scenarios:**

AS-011: The owner toggles a project public → private
- **Given:** owner of a public project
- **When:** they switch it to private
- **Then:** the project's visibility becomes private; it stays in the owner's list and disappears from other members'
- **Data:** owner sets public → private

AS-012: A non-owner non-admin cannot toggle visibility (error)
- **Given:** member B viewing a public project they do not own and are not admin of
- **When:** B attempts to change its visibility
- **Then:** refused; the project's visibility is unchanged
- **Data:** B (not owner/admin) toggles → refused

AS-013: An admin can toggle a public project's visibility
- **Given:** a public project not owned by admin C
- **When:** C switches it to private
- **Then:** allowed (admin manages public projects)
- **Data:** admin C sets a public project private

AS-014: Toggling visibility does not change existing docs' access
- **Given:** a public project containing a doc shared at workspace=commenter
- **When:** the owner switches the project to private
- **Then:** that existing doc keeps workspace=commenter (still visible to members); only docs created AFTER the switch get the private default
- **Data:** existing shared doc unchanged after public → private

AS-015: The projects list carries the visibility + default badge data
- **Given:** a member's Projects page with a default (private) project and a public project
- **When:** the projects list loads
- **Then:** each project carries its `isDefault` and `visibility` so the UI shows the "Default" badge and a private/public indicator
- **Data:** list payload includes { isDefault, visibility } per project

AS-024: The owner can toggle their default project to public
- **Given:** a member's auto default project (private)
- **When:** the owner switches it to public
- **Then:** allowed — the default project is not special-cased; it becomes public (so the owner's later quick-publish docs default to workspace-shared)
- **Data:** owner sets default project private → public

### S-004: A new doc's default access derives from its project's visibility (P0)

**Description:** As an author (web or agent), when I publish a doc, its default access follows the
target project: a public project makes the doc workspace-shared at the comment level; a private
project makes the doc private (restricted).
**Source:** docs/explore/project-visibility.md#data-model (new-doc default derivation) + #decision-rationale (reverses doc-access-two-axis C-007).
**Applies Constraints:** C-006

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/publish/service.ts`, `apps/backend/src/publish/repo.ts` (read resolved project visibility, set share_links accordingly), `apps/backend/src/mcp/tools/publish-tools-wiring.ts`, `apps/backend/test/integration/publish-repo.itest.ts` (amend the fixed-default assertions)
- `autonomous:` checkpoint
- `verify:` publish into a public project → a non-invited member can view+comment; publish into a private project → that member cannot see it; same for MCP publish.

**Acceptance Scenarios:**

AS-016: Publishing into a public project shares the doc with the workspace
- **Given:** member A publishes a doc into a PUBLIC project, touching no sharing
- **When:** another workspace member B (not owner, not invited) opens the workspace
- **Then:** B can view and comment on the doc (workspace=commenter default), and there is no public link
- **Data:** web publish into public project → member B commenter

AS-017: Publishing into a private project makes the doc private
- **Given:** member A publishes a doc into a PRIVATE project, touching no sharing
- **When:** another workspace member B (not owner, not invited) opens the workspace
- **Then:** B does not see the doc (derived access = restricted); only A and individually-invited people reach it
- **Data:** web publish into private project → restricted, B cannot see

AS-018: MCP publish derives the default from the target project too
- **Given:** an agent publishes a doc into a private project over MCP
- **When:** another workspace member opens the workspace
- **Then:** the doc is restricted (private), same derivation as the web path — not a fixed workspace=commenter
- **Data:** MCP publish into private project → restricted

### S-005: Moving a doc across a visibility boundary prompts before changing access (P1)

**Description:** As someone moving a doc into a project whose visibility differs from the doc's
current sharing, I'm asked whether to match the project (make it private) or keep the doc's current
sharing — the move never silently changes access.
**Source:** docs/explore/project-visibility.md#edge-cases (doc-move alert dialog).
**Applies Constraints:** C-008

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/docs/components/*` (move alert dialog), `apps/backend/src/workspace/doc-move.ts` (honor the explicit choice), `apps/backend/src/routes/*` (move route accepts the choice)
- `autonomous:` true
- `verify:` move a workspace-shared doc into a private project → a dialog asks make-private vs keep-sharing; each choice produces the corresponding access; moving with no visibility mismatch shows no dialog.

**Acceptance Scenarios:**

AS-019: Moving a shared doc into a private project prompts
- **Given:** a doc shared at workspace=commenter being moved into a private project
- **When:** the user initiates the move
- **Then:** an alert asks "make this doc private to match the project, or keep its current sharing?" — the move is not committed until the user chooses
- **Data:** shared doc → private project → prompt shown

AS-020: Choosing "make private" restricts the moved doc
- **Given:** the move prompt is shown for a workspace=commenter doc going into a private project
- **When:** the user chooses "make private"
- **Then:** the doc moves and its access becomes restricted (both axes off)
- **Data:** choose make-private → doc restricted

AS-021: Choosing "keep sharing" preserves the doc's access
- **Given:** the same move prompt
- **When:** the user chooses "keep current sharing"
- **Then:** the doc moves into the private project but keeps workspace=commenter (so it still shows to members via the workspace docs list — soft-private)
- **Data:** choose keep → doc stays workspace=commenter

### S-006: A private project does not leak via activity or breadcrumb (P1)

**Description:** As a workspace member, I never learn about another member's PRIVATE project through
the activity feed or through a breadcrumb — its project-level events aren't shown to me, and when I
open a doc that lives in someone's private project, its project name is suppressed.
**Source:** docs/explore/project-visibility.md#open-questions (GAP-002 activity, GAP-003 breadcrumb — resolved 2026-06-26).
**Applies Constraints:** C-010, C-011

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/activity/*` (visibility gate respects project visibility), `apps/backend/src/routes/viewer-doc.ts` / the doc-read payload (breadcrumb/project-name), `apps/web/src/features/viewer/components/*` (breadcrumb)
- `autonomous:` true
- `verify:` A creates a private project + publishes in it → B's activity feed shows neither event; B opens a doc A shared from inside a private project → the breadcrumb does not name the private project.

**Acceptance Scenarios:**

AS-022: A private project's events are hidden from other members' activity
- **Given:** member A creates a private project and publishes a doc in it
- **When:** member B opens the workspace activity feed
- **Then:** B sees neither the "created project" nor the publish event for A's private project (project-level events respect project visibility); per-doc events remain governed by per-doc access
- **Data:** A private project events, B's feed → absent

AS-023: A shared doc inside a private project hides the project name from a non-owner
- **Given:** A shares a doc (workspace=commenter) that lives inside A's PRIVATE project; member B opens that doc
- **When:** the doc viewer renders its breadcrumb
- **Then:** the private project's name is not shown to B (a generic/workspace-level breadcrumb is shown instead); A (the owner) still sees the project name
- **Data:** B viewing a shared doc in A's private project → project name suppressed

## Constraints & Invariants

- C-001: A project's `visibility` ∈ `private | public`. The auto default project is private; a
  user-created project (web) is public; MCP `create_project` is public by default, overridable by an
  explicit `visibility`. (AS-001, AS-002, AS-003, AS-004)
- C-002: A project is visible to user U IFF `project.ownerId == U` OR `project.visibility == public`.
  This single predicate governs EVERY surface that fetches projects.
  - scope: S-002
  - surfaces: projects-list, new-doc project picker, MCP list_projects, MCP read_project
  - coverage: projects-list → AS-005, AS-006, AS-007; new-doc picker → AS-009; MCP list_projects + read_project → AS-010
- C-003: There is NO admin exception to C-002 — a workspace admin runs the same predicate and does
  not see other members' private projects. (AS-008)
- C-004: Changing a project's visibility is allowed for the project owner always, and for a workspace
  admin only on a public project (an admin cannot see, hence cannot toggle, a private project);
  a member/viewer who is neither never can. (AS-011, AS-012, AS-013)
- C-005: Toggling a project's visibility affects ONLY the default access of docs created AFTER the
  change; existing docs keep their current sharing. (AS-014)
- C-006: A newly published doc's access is DERIVED from the target project's visibility — public →
  `{ workspace_role: commenter, link_role: null }`, private → `{ workspace_role: null, link_role: null }`
  (restricted) — applied at publish. This supersedes the fixed default in `doc-access-two-axis` C-007/S-002.
  - scope: S-004
  - surfaces: web/UI publish, MCP publish
  - coverage: web/UI publish → AS-016, AS-017; MCP publish → AS-018
- C-007: Private is SOFT — it hides the project shell (via C-002) and sets the new-doc default; it
  does NOT hard-gate docs inside. A doc explicitly shared (workspace_role set) inside a private
  project still appears to members via the workspace docs list / search / its link, per the two-axis
  rules. (AS-014, AS-021)
- C-008: Moving a doc into a project whose visibility differs from the doc's current access prompts
  the user (make-private vs keep-sharing); the move never silently changes a doc's access without
  that explicit choice. (AS-019, AS-020, AS-021)
- C-009: The projects-list read carries each project's `isDefault` and `visibility` so the UI renders
  the Default badge + a private/public indicator. (AS-015)
- C-010: A private project's PROJECT-LEVEL activity events (e.g. "created project", "published a doc
  in it") are visible only to the project owner — the activity visibility gate respects project
  visibility. Per-doc events stay governed by per-doc access. (AS-022)
- C-011: When a non-owner opens a shared doc that lives inside a private project, the private
  project's NAME is suppressed in the breadcrumb (a generic/workspace-level breadcrumb is shown); the
  owner still sees it. (AS-023)
- C-012: The default project is not special-cased for visibility — its owner may toggle it
  private↔public like any owned project (C-004 applies). (AS-024)

## UI Notes

Components to BUILD (`[N]`); existing hosts in italics. Component names only (no markup).

- *`ProjectCard`* (existing) — each card gains:
  - `ProjectVisibilityBadge` *(private vs public indicator; shown alongside the existing "Default" badge)*
  - `VisibilityToggle` *(in the ⋯ menu: "Make public" / "Make private"; shown only to owner, or admin on a public project — C-004)*
- *`NewDocProjectPicker`* (existing) — each project option gains:
  - `ProjectVisibilityBadge` *(per option)*
  - `NewDocAccessHint` *(reflects the resulting doc default: "Private project → this doc will be private" / "Public project → visible to the workspace")*
- *Doc-move action* (existing) —
  - `VisibilityBoundaryAlert` *(alert dialog on a visibility-mismatch move: "Make this doc private" / "Keep current sharing" / "Cancel"; shown only when the move crosses a visibility boundary — C-008)*

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| New-doc dialog + project picker | `apps/web/src/features/docs/components/new-doc-dialog.tsx`, `new-doc-project-picker.tsx` | reuse; picker already lists projects (now auto-filtered by C-002) + add per-option private/public badge |
| Projects list + Default badge | projects route payload already carries `isDefault` | reuse; add a visibility indicator + a toggle in the ⋯ menu |
| Doc-move | `apps/backend/src/workspace/doc-move.ts` + the FE move action | reuse; add the boundary alert dialog + thread the choice |

### System Impact & Technical Risks

- **Amends `doc-access-two-axis` (just built + cascaded)**: the fixed `{commenter, null}` new-doc
  default in `publish/repo.ts createDocWithV1` becomes project-derived. The live-Postgres publish
  itests (AS-005/006/025 there) assert the fixed default and MUST be updated to the project-derived
  default. Owning story S-004 is `checkpoint`.
- **Amends `workspace-project`**: it owns project create/browse + the projects-list count + doc
  move/copy. Adding `visibility` + the C-002 invariant changes its projects-list query
  (`repo.listActive/listAll` currently return ALL workspace projects). Also `workspace-project` still
  carries stale `settings.defaultAccess` references (C-008 copy, S-004 move, Clarifications-2026-06-23)
  from before the two-axis cascade — this feature's cascade should reconcile those (copy/new-doc
  default now derives from project visibility, not `settings.defaultAccess`).
- **Amends `mcp-roundtrip`**: `create_project` gains an optional `visibility`; MCP publish default
  derives from project visibility.
- **Schema migration**: add NOT-NULL `visibility`; greenfield → reset + reseed (no backfill); every
  insert path must set it or inserts fail.
- The C-002 predicate is the project analogue of `canBrowseDoc` (the doc-visibility predicate) — one
  shared function applied at all fetch surfaces to avoid per-surface drift.

## Not in Scope

- **Cascade edits to the specs this supersedes** — `doc-access-two-axis` (default derivation),
  `workspace-project` (visibility field + C-002 on the list + move/copy + retire stale defaultAccess
  refs), `mcp-roundtrip` (create_project visibility), and the CLAUDE.md domain note — are a follow-up
  Mode-C cascade, same release, not stories here.
- **Per-project ROLE override** (granting a role at project level that overrides per-doc access) —
  still deferred to v0.5; this feature is visibility-only.
- **Hard-containment "vault" project** (a true gate hiding even shared docs inside) — rejected; we
  chose soft private.
- **MCP tool to toggle/update a project's visibility after creation** — out of v0; MCP sets it only
  at create; toggling is web-only.
- **Project-level password / expiry / link** — projects are not shareable units; sharing stays per-doc.

## Gaps

- GAP-001 (status: resolved → AS-024, C-012): the auto default project CAN be toggled public (not
  locked) — it is not special-cased. Decided 2026-06-26.
- GAP-002 (status: resolved → AS-022, C-010): a private project's project-level activity events are
  visible only to the owner (activity gate respects project visibility). Decided 2026-06-26.
- GAP-003 (status: resolved → AS-023, C-011): a non-owner viewing a shared doc inside a private
  project does NOT see the private project's name in the breadcrumb (suppressed). Decided 2026-06-26.
- GAP-004 (status: resolved): visibility is a `visibility` enum (`private|public`), not an `is_private`
  boolean (Data Model). Decided 2026-06-26.

## Clarifications — 2026-06-26

- **Soft private, not hard containment:** private hides the project shell + sets the new-doc default;
  docs inside still follow per-doc two-axis sharing. Chosen because the client wants doc sharing to
  keep working as-is; a true "vault" is a separate future feature.
- **Default project private, user-created public:** a member's own scratch space is private by
  default (own-your-data posture); a project you deliberately create to collaborate is public. This
  DELIBERATELY reverses `doc-access-two-axis` C-007 for the quick-publish-into-default-project path —
  accepted by the product owner. It also fixes the "every member's default project clutters the list"
  problem (now each member sees only their own default + public projects).
- **Admin cannot see private projects:** chosen for true privacy over governance. Trade-off accepted —
  an admin loses visibility into / cleanup of members' private projects. If C changes (governance
  becomes required) → revisit C-003.
- **Toggle = owner + admin(public-only):** follows directly from admin not seeing private projects
  (can't toggle what you can't see).
- **Doc-move prompts instead of auto-applying:** avoids both accidental over-sharing (silent restrict)
  and accidental loss of an intended share (silent keep).
- **One invariant (`ownerId==U OR public`) applied everywhere:** prevents per-surface drift (the
  `canBrowseDoc` lesson) and auto-encodes the admin decision with no special case.

## Spec Sizing Notes

Stories=6 (≤7 target). AS=24 (4 over the 20 soft target, within the 30 hard cap).

The AS over the soft target come from G1 splits, each its own atom (no AS gộp):
- S-002 visibility invariant: AS-005/006/007 (own-private / other-private-hidden / public-shown),
  AS-008 (admin no exception), AS-009 (picker surface), AS-010 (MCP surface) — 6 atoms, because C-002
  is a cross-surface invariant requiring per-surface coverage (CC5).
- S-001 create: AS-001/002/003/004 — 4 atoms (web-public / default-private / MCP-default-public /
  MCP-explicit-private).
- S-006 leak prevention: AS-022 (activity) + AS-023 (breadcrumb) — 2 distinct surfaces a private
  project must not leak through.

No bloat — each AS traces to one stated atom.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-26 | Initial creation (from docs/explore/project-visibility.md) | -- |
| 2026-06-26 | Phase 3 — resolved GAP-001..004: +AS-024/C-012 (default project toggleable), +S-006 (AS-022/023) + C-010/C-011 (private project no-leak via activity/breadcrumb), visibility=enum. Stories 5→6, AS 21→24. | -- |
