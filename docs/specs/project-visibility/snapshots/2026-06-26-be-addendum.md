# Snapshot: project-visibility
**Date:** 2026-06-26
**Ref:** be-addendum
**Reason:** M1+M4+M6 — /mf-challenge of `project-visibility-fe` found 3 linked fields the FE consumes that the BE does not yet produce. Adds `canToggleVisibility` to the list payload (AS-015/C-011), a `reason` discriminator on the move refusal (AS-021/C-009), and a `newDocAccess` preview field (new AS-030).

---

# Spec: project-visibility

**Created:** 2026-06-26
**Last updated:** 2026-06-26
**Status:** Draft
**Snapshot limit:** 5

## Overview

Give a project a `private | public` visibility. **Private** hides the project SHELL from everyone
except its owner (and gates its name everywhere); **public** is workspace-shared. Visibility is a
LIST/SHELL concept, decoupled from doc access: a project's visibility sets the default access of
NEW docs created in it — EXCEPT the per-member **default project**, whose new docs stay
workspace-shared even though its shell is private (so the quick-publish / agent-publish round-trip
never produces a reviewer-invisible doc). Docs inside any project still follow per-doc two-axis
sharing. This amends `doc-access-two-axis` only for the NON-default-private path; the default-project
shared default (C-007 there) is preserved.

## Data Model

- **projects** — add `visibility` ∈ `private | public` (NOT NULL).
  - `ensureDefaultProject` (auto per-member default) sets `visibility = private` (shell hidden from others).
  - `createProject` (web user-created) sets `visibility = public`; MCP `create_project` accepts an
    optional `visibility` (default public).
  - **Migration**: add the column with a transient `DEFAULT 'public'` and backfill existing rows
    (existing projects were effectively workspace-shared), then the app is the source of truth per
    insert path. This is safe for any already-running self-host install (NOT-NULL-no-default would
    fail on existing rows); greenfield dev still reset+reseed.
  - `ProjectRow`, `ProjectRepo.insert`, `rowToProject`, and the projects-list payload all carry `visibility`.
- **canViewProject(U, project)** = `project.ownerId == U` OR `project.visibility == public`. ONE shared
  predicate; the default project (private) is therefore owner-only in the list.
- **New-doc default DERIVATION** (amends `doc-access-two-axis` S-002/C-007 for non-default-private only):
  at publish/copy, the new doc's `share_links` row is set from the TARGET project —
  - target is the default project (`is_default = true`) → `{ workspace_role: commenter, link_role: null }`
    (shared) regardless of its private shell — the decouple carve-out, agent-loop-safe;
  - target is a public project → `{ workspace_role: commenter, link_role: null }`;
  - target is a NON-default private project → `{ workspace_role: null, link_role: null }` (restricted).
  The visibility is read in the SAME transaction as the doc/version/share_links insert (no read-then-write race).
- **owner_id** stays non-null for live projects: when a member is removed, their owned projects are
  reassigned to a workspace admin (else a private project with `owner_id = null` would be invisible to
  everyone and unreachable — C-012).
- Doc access stays the two axes (`workspace_role` + `link_role`); no docs/share_links schema change.

## Stories

### S-001: A project carries a private/public visibility (P0)

**Description:** As a workspace member, every project I create or own has a visibility. My auto
default project is private (its shell is mine to see); a project I deliberately create is public; an
agent over MCP creates public by default but may specify private.
**Source:** docs/explore/project-visibility.md#data-model.
**Applies Constraints:** C-001

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/backend/src/db/schema.ts`, `apps/backend/drizzle/*`, `apps/backend/src/db/seed.ts`, `apps/backend/src/workspace/projects.ts` (createProject + ensureDefaultProject + repo insert/rowToProject), `apps/backend/src/routes/projects.ts`, `apps/backend/src/mcp/tools/project-tools.ts` + `project-tools-wiring.ts`
- `autonomous:` checkpoint
- `verify:` sign up → default project private; create on web → public; MCP create_project(name) → public; MCP create_project(name, private) → private; migration backfills existing rows without failing.

**Acceptance Scenarios:**

AS-001: A user-created project is public
- **Given:** a workspace member on the Projects page
- **When:** they create a new project "Vantage"
- **Then:** it is created with visibility = public
- **Data:** create "Vantage" → public

AS-002: The auto default project is private
- **Given:** a new account joining/creating a workspace
- **When:** their default project ("<name>'s docs") is auto-created
- **Then:** it has visibility = private (shell visible only to its owner)
- **Data:** signup → default project private

AS-003: MCP create_project defaults to public
- **Given:** an agent with a workspace identity token
- **When:** it calls create_project with only a name
- **Then:** the project is public
- **Data:** MCP create_project("Specs") → public

AS-004: MCP create_project honors explicit private (boundary)
- **Given:** an agent with a workspace identity token
- **When:** it calls create_project with name + visibility = private
- **Then:** the project is private
- **Data:** MCP create_project("Drafts", private) → private

### S-002: Projects are visible by the ownership-or-public invariant, everywhere (P0)

**Description:** As a workspace member, every surface that fetches a project — the Projects list, the
New-doc project picker, the move/copy target picker, and MCP list/read — shows me only my own
projects plus public ones, never another member's private project. A workspace admin gets no exception.
**Source:** docs/explore/project-visibility.md#central-invariant; /mf-challenge surface-inventory findings (move-target picker + MCP file fix).
**Applies Constraints:** C-002, C-003, C-006

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/workspace/projects.ts` (the shared `canViewProject`), `apps/backend/src/workspace/repo.ts` (projects-list + listActive/listAll filter), `apps/backend/src/routes/projects.ts` (list + the `GET …/docs` move-target picker payload), `apps/backend/src/routes/doc-move.ts` (target authorization), `apps/backend/src/mcp/tools/project-tools.ts` + `project-tools-wiring.ts` (list_projects + read_project), `apps/web/src/features/docs/components/new-doc-project-picker.tsx`
- `autonomous:` true
- `verify:` as member B, the Projects list, New-doc picker, AND the move-target picker show only B's own + public projects; A's private project is absent everywhere; MCP list/read for B omit it; moving a doc into A's private project is refused.

**Acceptance Scenarios:**

AS-005: A member sees their own private project; not another member's
- **Given:** A owns a private project; B (same workspace, not owner) opens the Projects list
- **When:** the list renders for B and for A
- **Then:** A sees their private project; B does not
- **Data:** A private project → visible to A, absent for B

AS-006: A public project is visible to every member
- **Given:** a public project owned by A
- **When:** member B opens the Projects list
- **Then:** the public project appears for B
- **Data:** A public project, B → visible

AS-007: A workspace admin gets no exception (boundary)
- **Given:** A owns a private project; C is a workspace admin, not the owner
- **When:** C opens the Projects list
- **Then:** A's private project is absent for C — admin sees own + public only
- **Data:** A private project, admin C → absent

AS-008: The New-doc and move/copy target pickers apply the same invariant
- **Given:** member B opening the New-doc dialog and the move-to-project dialog; A owns a private + a public project
- **When:** each picker renders
- **Then:** both offer B's own + the public project, never A's private project (no project name leaks through a picker)
- **Data:** B's pickers → own + public only

AS-009: Moving a doc into a project the actor cannot see is refused (boundary)
- **Given:** member B who is not A; A owns a private project
- **When:** B attempts to move B's own doc into A's private project by its id
- **Then:** refused, indistinguishable from a missing project (existence-hiding) — B cannot use the move to confirm the project exists
- **Data:** B moves into A's private project id → refused (not-found)

AS-010: MCP list/read apply the same invariant
- **Given:** an agent acting for member B; A owns a private project
- **When:** the agent lists workspace projects and tries to read A's private project by id
- **Then:** the list omits A's private project; reading it by id returns the same error as not-found
- **Data:** MCP list for B → A's private absent; read → not found

### S-003: Toggle a project's visibility (P1)

**Description:** As a project owner (or an admin, for a public project), I switch a project between
private and public; the change affects only the default of docs created afterward, and the toggle
discloses that existing docs are unaffected. The list shows a default badge + a private/public indicator.
**Source:** docs/explore/project-visibility.md#permissions + #business-rules; /mf-challenge toggle-footgun finding.
**Applies Constraints:** C-008, C-011

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/routes/projects.ts`, `apps/backend/src/workspace/projects.ts` (setVisibility + owner/admin gate), `apps/backend/src/workspace/repo.ts` (list payload + visibility), `apps/web/src/features/docs/components/*` (badge + ⋯ toggle + disclosure)
- `autonomous:` true
- `verify:` owner toggles private↔public; a non-owner non-admin is refused; admin can toggle a public project; an existing shared doc in a now-private project keeps its sharing; the toggle UI states existing docs are unaffected; list payload carries visibility.

**Acceptance Scenarios:**

AS-011: The owner toggles a project public → private
- **Given:** owner of a public project
- **When:** they switch it to private
- **Then:** its visibility becomes private; it stays in the owner's list and disappears from other members'
- **Data:** owner sets public → private

AS-012: A non-owner non-admin cannot toggle visibility (error)
- **Given:** member B viewing a public project they neither own nor admin
- **When:** B attempts to change its visibility
- **Then:** refused; visibility unchanged
- **Data:** B toggles → refused

AS-013: An admin can toggle a public project's visibility
- **Given:** a public project not owned by admin C
- **When:** C switches it to private
- **Then:** allowed
- **Data:** admin C sets a public project private

AS-014: Toggling visibility does not change existing docs' access, and the toggle discloses this
- **Given:** a public project with a doc shared at workspace=commenter
- **When:** the owner switches the project to private
- **Then:** the existing doc keeps workspace=commenter (only docs created AFTER the switch get the private default), and the toggle confirmation states that existing shared docs stay shared
- **Data:** existing shared doc unchanged; disclosure shown on toggle

AS-015: The projects list carries the visibility + default badge data
- **Given:** a member's Projects page with their default (private) project and a public project
- **When:** the list loads
- **Then:** each project carries `isDefault` + `visibility` so the UI shows the Default badge + a private/public indicator
- **Data:** payload includes { isDefault, visibility } per project

### S-004: A new doc's default access derives from its project's visibility, with a default-project carve-out (P0)

**Description:** As an author (web, MCP, or copy), a doc I create takes its default access from the
target project — public project shares it with the workspace, a non-default private project makes it
private — EXCEPT the per-member default project, where new docs stay workspace-shared so a
quick-publish or an agent publish is always reviewable.
**Source:** docs/explore/project-visibility.md#data-model; /mf-challenge agent-loop (decouple) + copy-path findings; transparency add (publish reports resulting access).
**Applies Constraints:** C-007, C-013

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/publish/service.ts`, `apps/backend/src/publish/repo.ts` (read target project visibility in the doc-create tx, set share_links), `apps/backend/src/mcp/tools/publish-tools-wiring.ts`, `apps/backend/src/workspace/doc-move.ts` + `doc-move-repo.ts` (copy derives the same way), `apps/backend/test/integration/publish-repo.itest.ts` (amend fixed-default assertions)
- `autonomous:` checkpoint
- `verify:` publish into a public project → member can view+comment; publish into a non-default private project → member can't see; publish (web + MCP-no-projectId) into the DEFAULT project → member can view+comment (loop safe); copy into a non-default private project → restricted.

**Acceptance Scenarios:**

AS-016: Publishing into a public project shares the doc with the workspace
- **Given:** A publishes a doc into a PUBLIC project, touching no sharing
- **When:** member B (not owner, not invited) opens the workspace
- **Then:** B can view and comment; no public link
- **Data:** publish into public project → B commenter

AS-017: Publishing into a non-default private project makes the doc private
- **Given:** A publishes a doc into a NON-DEFAULT private project, touching no sharing
- **When:** member B (not owner, not invited) opens the workspace
- **Then:** B does not see the doc (derived restricted); only A + invited reach it
- **Data:** publish into non-default private project → restricted

AS-018: Quick-publish into the default project stays shared (agent loop, decouple carve-out)
- **Given:** A publishes a doc with no project chosen → it lands in A's default project (private shell)
- **When:** member B opens the workspace
- **Then:** B can view and comment — the default project's private shell does NOT make its new docs private (carve-out preserves the shared default)
- **Data:** default-project publish → B commenter, not restricted

AS-019: MCP publish without a project keeps the agent round-trip reviewable
- **Given:** an agent calls create_document with no projectId → the owner's default project
- **When:** the human reviewer (a workspace member) opens the workspace
- **Then:** the reviewer can view and comment on the agent's doc (shared, not restricted)
- **Data:** MCP-no-projectId publish → reviewer commenter

AS-020: Copying a doc into a non-default private project makes the copy private
- **Given:** A copies an existing workspace-shared doc into a NON-DEFAULT private project
- **When:** member B opens the workspace
- **Then:** the copy is restricted (derived from the target project, same as publish) — no silent over-share
- **Data:** copy into non-default private project → restricted

AS-029: A publish/create response reports the target project + the doc's resulting access
- **Given:** an author publishes a doc — on the web with no project chosen (lands in the default project), or an agent over MCP with no projectId
- **When:** the publish/create completes
- **Then:** the response carries the target project (name) AND the doc's resulting access (its derived level / "visible to the workspace" vs "private"), so the caller is never silently unaware of where the doc went or who can see it — the web success UI shows it, and the MCP create response includes it
- **Data:** publish with no project → response includes { project, resulting access }

### S-005: Moving a doc across a visibility boundary is server-enforced (P1)

**Description:** As someone moving a doc into a project whose visibility implies a different access
than the doc currently has, I must explicitly choose make-private or keep-sharing; the server (not
the browser) detects the mismatch and applies the move + access change atomically.
**Source:** docs/explore/project-visibility.md#edge-cases; /mf-challenge move-atomicity finding.
**Applies Constraints:** C-009

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/routes/doc-move.ts` (require the choice on a server-detected mismatch), `apps/backend/src/workspace/doc-move.ts` (move + access change in one transaction), `apps/web/src/features/docs/components/*` (boundary alert dialog)
- `autonomous:` true
- `verify:` move a workspace-shared doc into a private project with no choice → refused; with make-private → restricted (atomic); with keep → unchanged; a no-mismatch move needs no choice and shows no dialog.

**Acceptance Scenarios:**

AS-021: A mismatched move without an explicit choice is refused (server-enforced)
- **Given:** a workspace-shared doc being moved into a private project, with no choice supplied
- **When:** the move is requested
- **Then:** the server detects the mismatch and refuses — it never silently keeps or changes access; the FE shows the choice dialog before retrying
- **Data:** shared doc → private project, no choice → refused

AS-022: Choosing make-private moves and restricts atomically
- **Given:** the mismatch move with choice = make-private
- **When:** it commits
- **Then:** the doc's project and its access (restricted) change together in one transaction — never half-applied
- **Data:** choose make-private → moved + restricted, atomic

AS-023: Choosing keep-sharing preserves the doc's access
- **Given:** the same mismatch move with choice = keep
- **When:** it commits
- **Then:** the doc moves into the private project but keeps workspace=commenter (still shown to members via the workspace docs list — soft-private)
- **Data:** choose keep → moved, workspace=commenter

### S-006: A private project does not leak via activity, breadcrumb, or doc-card name (P1)

**Description:** As a workspace member, I never learn of another member's PRIVATE project through the
activity feed or through a project name on a doc I can otherwise see — its project-level events are
owner-only (admins included), and its name is suppressed in breadcrumbs and doc-list cards for
non-owners. Doc-level events of a doc I can access still surface (soft-private).
**Source:** docs/explore/project-visibility.md#open-questions (GAP-002/003 resolved); /mf-challenge activity-gate + projectName-label findings.
**Applies Constraints:** C-004, C-010

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/activity/visibility.ts` (VisibilityRow gains projectId; project-level rows gated by project visibility, including the admin path), `apps/backend/src/workspace/repo.ts` (suppress `workspaceDocs.projectName` for non-owner of a private project), `apps/backend/src/routes/viewer-doc.ts` + `apps/web/src/features/viewer/components/*` (breadcrumb)
- `autonomous:` checkpoint
- `verify:` A creates a private project + publishes in it → neither a member nor an admin sees those project-level events; a doc A shared from inside a private project → its publish/comment events DO surface to those who can access the doc, but the project name is hidden in B's breadcrumb + doc card.

**Acceptance Scenarios:**

AS-024: Project-level events of a private project are hidden from other members AND admins
- **Given:** A creates a private project (a project-level "created project" event, doc-less)
- **When:** member B and admin C open the activity feed
- **Then:** neither B nor C sees that event — project-level events of a private project are visible only to the owner; the admin short-circuit does not apply to them
- **Data:** private project create event → absent for B and C
- **Setup:** the activity row carries the project id so the gate can resolve project visibility

AS-025: Doc-level events of an accessible doc still surface (soft-private boundary)
- **Given:** A shares a doc (workspace=commenter) that lives inside A's private project; that doc generates a publish/comment event
- **When:** member B (who can access the doc) opens the activity feed
- **Then:** B sees the doc-level event (doc-level events stay governed by per-doc access, not project visibility) — only PROJECT-level events are project-gated
- **Data:** soft-shared doc event in a private project → visible to B

AS-026: A non-owner does not see the private project's name on the doc or in lists
- **Given:** B opens a doc A shared from inside A's PRIVATE project (and the same doc appears in B's workspace docs list)
- **When:** the doc viewer breadcrumb and the docs-list card render for B
- **Then:** the private project's name is suppressed for B in both (a generic/workspace label is shown); A still sees the name
- **Data:** B viewing/listing a shared doc in A's private project → project name suppressed

### S-007: Removing a member never orphans a private project (P1)

**Description:** As an admin removing a member, that member's owned projects stay reachable — their
ownership is reassigned to an admin so a private project never ends up owner-less and invisible to
everyone.
**Source:** /mf-challenge orphaned-private-project finding (owner_id is nullable, ON DELETE SET NULL).
**Applies Constraints:** C-012

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/workspace/tenancy-repo.ts` (member removal reassigns owned projects), `apps/backend/src/workspace/projects.ts`
- `autonomous:` checkpoint
- `verify:` remove a member who owns a private project with docs → the project + its docs remain reachable (reassigned to an admin), not invisible.

**Acceptance Scenarios:**

AS-027: Removing a member reassigns their private project to an admin
- **Given:** member A owns a private project containing docs; an admin removes A from the workspace
- **When:** the removal completes
- **Then:** the project's ownership is reassigned to a workspace admin so the project remains visible/manageable; it is never left owner-less and invisible to everyone
- **Data:** remove A → A's private project owner becomes an admin

AS-028: The reassigned project's docs survive and stay reachable (error/edge)
- **Given:** A's private project held a workspace-shared doc and a restricted doc when A is removed
- **When:** the removal completes
- **Then:** both docs still exist; the workspace-shared one is still browsable by members, the project is reachable by the new owner — no data is hidden or lost
- **Data:** remove A → docs intact + reachable

## Constraints & Invariants

- C-001: A project's `visibility` ∈ `private | public`; default project private, user-created public,
  MCP create_project public-by-default (overridable). (AS-001, AS-002, AS-003, AS-004)
- C-002: A project is visible to U IFF `ownerId == U OR visibility == public` (`canViewProject`). ONE
  predicate at every project-FETCH surface.
  - scope: S-002
  - surfaces: projects-list, new-doc picker, move/copy target picker, MCP list_projects, MCP read_project
  - coverage: projects-list → AS-005, AS-006; new-doc + move/copy picker → AS-008; move target authorization → AS-009; MCP list+read → AS-010
- C-003: No admin exception to C-002 — admin runs the same predicate (own + public only). (AS-007)
- C-004: A private project's NAME is gated like its shell — suppressed for a non-owner wherever a name
  could surface despite a visible doc: the doc-list card (`workspaceDocs.projectName`) and the viewer
  breadcrumb. (AS-026)
- C-005: Doc-LIST surfaces (the workspace docs grid, the per-project doc count, search) are gated by
  per-doc access (`canBrowseDoc`) ONLY — NOT by project visibility. Project visibility gates the
  project LIST/shell + name, never which docs appear. (a doc soft-shared inside a private project
  still lists/searches — see C-005 boundary). (AS-025, and the doc-count is unchanged by this feature)
- C-006: A project a doc is moved/copied/published INTO must be a project the actor can see
  (`canViewProject`); otherwise the operation is refused, existence-hiding. (AS-009)
- C-007: A new doc's default access derives from the TARGET project — public → `{commenter, null}`,
  NON-default private → `{null, null}` (restricted), and the per-member DEFAULT project →
  `{commenter, null}` regardless of its private shell (the decouple carve-out, agent-loop-safe). The
  visibility is read in the SAME transaction as the doc/share_links insert. This amends
  `doc-access-two-axis` C-007 only for the non-default-private path; the default-project shared default
  is preserved.
  - scope: S-004
  - surfaces: web/UI publish, MCP publish, copy
  - coverage: web publish (public → AS-016; non-default private → AS-017; default → AS-018) ; MCP publish → AS-019 ; copy → AS-020
- C-008: Changing visibility is allowed for the owner always, and for an admin only on a public
  project (an admin cannot see a private project to toggle it); a member/viewer who is neither never
  can. It affects ONLY docs created after; the toggle UI discloses existing docs are unaffected. (AS-011, AS-012, AS-013, AS-014)
- C-009: Moving a doc into a project whose visibility differs from the doc's current access requires
  an explicit choice (make-private | keep), detected server-side; the move + the access change apply
  in one transaction; the server never silently changes or keeps access without the choice. (AS-021, AS-022, AS-023)
- C-010: A private project's PROJECT-LEVEL activity events (doc-less rows: created project, etc.) are
  visible only to the owner — the activity gate's admin short-circuit and "doc-less ⇒ visible" rule
  both get a private-project carve-out. DOC-level events stay governed by per-doc access. (AS-024, AS-025)
- C-011: The projects-list read carries each project's `isDefault` and `visibility` for the badges. (AS-015)
- C-012: A live project's `owner_id` is never null — when a member is removed, their owned projects
  are reassigned to a workspace admin so a private project is never orphaned (owner-less ⇒ invisible
  to everyone under C-002). The removed member's own DEFAULT project is reassigned the same way but
  **demoted to `is_default = false`** in the same transaction, so it cannot collide with the receiving
  admin's existing default under the one-default-per-(workspace, owner) uniqueness. (AS-027, AS-028)
- C-013: A publish / create-document response (web AND MCP) reports the target project + the doc's
  resulting access (derived level), so a quick-publish / agent-publish that falls back to the default
  project is never a silent surprise about where the doc went or who can see it. (AS-029)

## Linked Fields

This spec is the **producer** side of a scope-by-layer split with `project-visibility-fe` (the FE
consumer). The BE was built first (S-001..S-007, all green); the FE spec consumes these fields and
each carries a real-integration seam test on the FE side (never mocked).

- `visibility` (project) — consumed by `project-visibility-fe:AS-001` (ProjectCard badge) and
  `project-visibility-fe:AS-006` (picker option badges) on the projects-list row AND the
  `GET /docs` projects payload (persisted, served on every list fetch). Produced here by **AS-015**
  (projects-list payload) + **S-003** (`visibility` added to the `/docs` picker payload). ✔ match.
- `isDefault` (project) — consumed by `project-visibility-fe:AS-001` on the projects-list row
  (drives the Default badge condition). Produced here by **AS-015**. ✔ match.
- `projectName` suppressed-to-null — consumed by `project-visibility-fe:AS-013` on the doc-list card
  (served on every workspace-docs fetch). Produced here by **AS-026** (`workspaceDocs.projectName`
  nulled for a non-owner of a private project). ✔ match.
- `accessChoice` + the needs-choice refusal — the FE move dialog
  (`project-visibility-fe:AS-009/010/011`) reads the boundary-crossing refusal and sends `accessChoice`
  back on retry. Produced here by **S-005** (C-009 / AS-021,022,023 — server refuses without the
  choice, applies move+access atomically with it). ✔ match.
- `project` + `access` (publish/create response) — consumed by `project-visibility-fe:AS-016`
  (PublishAccessNotice), read transiently from the publish response immediately after publish.
  Produced here by **AS-029** on the web publish AND MCP create-document response. ✔ lifecycle match
  (transient-in-response, consumed at publish time — not a later refetch).
- viewer-breadcrumb `projectName` — the FE viewer breadcrumb would consume a gated project name, but
  the BE viewer payload does NOT emit `projectName` today (S-006 closed the doc-list card channel only;
  the viewer has no project crumb). ✘ not produced → `project-visibility-fe:GAP-001` (a BE producer AS
  is owed before the viewer breadcrumb can suppress anything — until then there is no leak channel there).

## UI Notes

Components to BUILD (`[N]`); existing hosts in italics.

- *`ProjectCard`* — gains `ProjectVisibilityBadge` *(private/public, beside the existing Default badge)* + `VisibilityToggle` *(⋯ menu: "Make public"/"Make private"; owner, or admin on a public project; the confirmation discloses "existing shared docs stay shared" — C-008)*
- *`NewDocProjectPicker`* + *move/copy target picker* — each project option gains `ProjectVisibilityBadge`; New-doc adds `NewDocAccessHint` *("Private project → this doc will be private" / "Default/public project → visible to the workspace")*
- *Doc-move action* — `VisibilityBoundaryAlert` *(shown when the server reports a mismatch: "Make this doc private" / "Keep current sharing" / "Cancel")*
- *Doc viewer breadcrumb* + *doc-list card* — suppress the project name for a non-owner of a private project (C-004)
- *Publish success toast/panel* — `PublishAccessNotice` *(shows the target project + resulting access: "in **Your docs** · visible to your workspace" / "· private — only you"; so a quick-publish into the default project is never silent — C-013)*

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| New-doc dialog + project picker | `apps/web/src/features/docs/components/new-doc-dialog.tsx`, `new-doc-project-picker.tsx` | reuse; picker auto-filtered by C-002; add per-option badge + hint |
| Projects list + Default badge | projects route payload carries `isDefault` | reuse; add visibility indicator + ⋯ toggle |
| Move/copy target picker | `GET /api/w/:workspaceId/docs` projects payload (`routes/projects.ts`) + the move dialog | reuse; MUST apply C-002 filter (currently lists ALL projects) |
| Doc-move | `apps/backend/src/workspace/doc-move.ts` + FE move action | reuse; make move+access atomic + server-required choice |
| Activity gate | `apps/backend/src/activity/visibility.ts` | extend: VisibilityRow gains projectId; project-level rows gated by project visibility |

### System Impact & Technical Risks

- **Amends `doc-access-two-axis` (just built + cascaded)** — but ONLY for the non-default-private path:
  publish/copy into a non-default private project derives restricted. The default project keeps the
  fixed `{commenter, null}` (C-007 there is NOT reversed), so the locked shared-default + the agent
  round-trip stand. The publish itests (AS-005/006/025 there) gain the non-default-private + default
  cases rather than being torn up.
- **`canViewProject` must be a single predicate at every project fetch + name + write-target surface**
  (projects-list, both pickers, MCP `project-tools.ts` list/read, move-target auth, the
  `workspaceDocs.projectName` label, the breadcrumb). The /mf-challenge found three surfaces a
  hand-enumerated list missed (move-target picker, doc-card project name, write-target). Drive every
  caller through it — do not re-enumerate.
- **MCP project reads are in `project-tools.ts` / `project-tools-wiring.ts`** (NOT `read-tools-wiring.ts`),
  and currently carry an explicit "no per-owner ACL in v0" design that this feature REVERSES.
- **Activity gate (`visibility.ts`)** has an admin short-circuit + a "doc-less row ⇒ visible" rule;
  C-010 needs both narrowed for private-project project-level rows + the row to carry `projectId`. S-006
  is `checkpoint`.
- **Doc-LIST vs project-LIST boundary (C-005)**: project visibility gates the project list/shell/name,
  NOT which docs appear — doc lists/search/count stay per-doc (`canBrowseDoc`). Implementer must not
  add the visibility filter into `workspaceDocs`/`countDocsByProject`/search (would break soft-private +
  count-vs-rows).
- **Migration** adds NOT-NULL `visibility` with a transient DEFAULT + backfill (safe for existing
  self-host rows); S-001/S-004/S-006/S-007 are `checkpoint`.
- **Member-removal reassignment (C-012)** changes the `ON DELETE SET NULL` reality for projects — a
  removed member's projects get a new owner, not a null one.
- `workspace-project` still carries stale `settings.defaultAccess` refs (copy C-008, move S-004,
  Clarifications-2026-06-23) from before the two-axis cascade; this feature's cascade reconciles the
  copy/new-doc default to project-derived.

## Not in Scope

- **Cascade edits** to `doc-access-two-axis` (non-default-private derivation note), `workspace-project`
  (visibility field + C-002 on the list + move/copy derivation + retire stale defaultAccess), and
  `mcp-roundtrip` (create_project visibility) — follow-up Mode-C, same release, not stories here.
- **Per-project ROLE override** (a role at project level overriding per-doc access) — deferred v0.5.
- **Hard-containment "vault" project** (hiding even shared docs inside) — rejected; soft private.
- **MCP tool to toggle a project's visibility** after creation — out of v0; MCP sets it at create only.
- **Making the default project's docs private-by-default** — explicitly rejected (decouple): it breaks
  the quick-publish / agent round-trip. The default project's shell is private but its docs default shared.
- **Project-level password / expiry / link** — sharing stays per-doc.

## Gaps

(none open — the four explore open questions were resolved 2026-06-26: default project toggleable
public via C-008; private project activity owner-only via C-010; breadcrumb + name suppressed via
C-004; visibility = enum via Data Model. The /mf-challenge findings are folded into the stories above.)

## Spec Sizing Notes

Stories=7 (= soft target). AS=29 (9 over the 20 soft target, within the 30 hard cap).

The AS over the soft target come from G1 splits, each its own atom (no AS gộp):
- S-002 invariant: AS-005/006/007/008/009/010 — 6 atoms, because C-002 is a cross-surface invariant
  (per-surface coverage: list, picker, move-target auth, MCP) per CC5.
- S-004 derivation + transparency: AS-016/017/018/019/020 (public / non-default-private / default-carve-out /
  MCP-loop / copy — C-007 cross-surface) + AS-029 (publish reports resulting access — C-013) — 6 atoms.
- S-001 create: AS-001/002/003/004 — 4 atoms.
- S-006 no-leak: AS-024/025/026 — 3 atoms (project-level hidden / doc-level surfaces / name suppressed).
- S-007 orphan: AS-027/028 — 2 atoms.

No bloat — each AS traces to one stated atom. The spec is ONE cohesive visibility model (T5/T6 — schema,
predicate, derivation, activity, move, removal all share the visibility concept), kept whole; the
overage is the cross-surface invariants' per-surface coverage, documented here.

## Clarifications — 2026-06-26

- **Soft private, not hard containment:** private hides the project shell + its name + sets the
  new-doc default (for non-default projects); docs inside still follow per-doc two-axis sharing.
- **Decouple (post-/mf-challenge):** the per-member default project is private-SHELL but its new docs
  stay workspace-shared. This was chosen because making the default project's docs private breaks the
  quick-publish / MCP-no-projectId agent round-trip (the agent's doc would be reviewer-invisible) —
  Anchord's core loop. So `doc-access-two-axis` C-007's shared default is preserved for the default
  project; only deliberately-created private projects restrict new docs.
- **Admin cannot see private projects** (C-003) — true privacy over governance; the only admin
  exception is the C-012 orphan-reassignment path (a removed member's projects get an admin owner so
  they don't vanish).
- **Toggle = owner + admin(public-only); only new docs; with disclosure** — and the default project is
  toggleable like any owned project (no special-case lock).
- **One `canViewProject` predicate everywhere** — prevents the per-surface drift the /mf-challenge found
  (move-target picker, doc-card name, write-target were missed by a hand-enumerated surface list).

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-26 | Initial creation (from docs/explore/project-visibility.md) | -- |
| 2026-06-26 | Phase 3 — resolved GAP-001..004 | -- |
| 2026-06-26 | /mf-challenge re-spec (snapshot 2026-06-26-pre-challenge): DECOUPLE (default project private-shell but shared new-docs — agent-loop-safe, C-007 not reversed); one `canViewProject` at all fetch+name+write-target surfaces (+move-target picker, +doc-card projectName, +MCP project-tools file fix); C-005 doc-list-vs-project-list boundary; copy folded into S-004; move server-enforced+atomic (S-005); activity project-level-event carve-out incl. admin (S-006); +S-007 orphan-owner reassignment; migration DEFAULT+backfill. Stories 6→7, AS 24→28. | /mf-challenge |
| 2026-06-26 | Transparency add (chose decouple A + notify): +C-013 + AS-029 — publish/create response (web + MCP) reports target project + resulting access so a default-project fallback is never silent; +PublishAccessNotice UI. AS 28→29. | -- |
| 2026-06-26 | Post-build (snapshot 2026-06-26-fe-split): C-012 gains the default-project demote guard (S-007 S3 signal — reassigned default project demoted to `is_default=false` to avoid the one-default-per-owner collision); +`## Linked Fields` block as producer side of the scope-by-layer split with the new sibling `project-visibility-fe` spec (FE was dropped — UI Notes had components but no FE story/AS). | /mf-plan |
