# Spec: doc-access-two-axis

**Created:** 2026-06-25
**Last updated:** 2026-06-25
**Status:** Draft
**Snapshot limit:** 5

## Overview

Replace a doc's single `general_access` enum with TWO independent access axes (the Google-Docs
two-layer model): a **workspace axis** (the role every member of the doc's own workspace gets) and
a **link axis** (the role anyone holding the link gets). Each axis carries its own role
(viewer/commenter/editor) or is off. The two are independent, so sharing a doc externally never
demotes workspace members nor removes the doc from their workspace — the bug this redesign fixes.
It also closes a latent gap where a freshly published doc granted non-owner members no access at all.

This is a clean architectural replacement, not a patch. The product has **no users yet**, so the
change ships as a schema replace + reseed (no data backfill, no expand/contract) and this spec
becomes the single source of truth for the access model — the older single-level specs are amended
to point here (see Not in Scope → committed cascade).

## Data Model

- **share_links** (the per-doc access config row): the single `role` column is replaced by two
  nullable role columns —
  - `workspace_role`: `viewer | commenter | editor | null`. The role granted to every member of
    the doc's OWN workspace. `null` = the doc is not shared with the workspace (only owner +
    individually-invited members reach it).
  - `link_role`: `viewer | commenter | editor | null`. The role granted to anyone holding the link.
    `null` = no public link (and no capability token).
  - The existing link controls (`password_hash`, `expires_at`, `view_limit`, `view_count`,
    `editors_can_share`, `capability_token`) are unchanged and attach to the link axis.
- **`docs.general_access` is DROPPED.** The legacy three-value level is no longer stored anywhere;
  it is DERIVED on read by `deriveLevel(workspace_role, link_role)`:
  - `{null, null}` → `restricted`
  - `{set, null}` → `anyone_in_workspace`
  - `{*, set}` → `anyone_with_link`
- **share_links row now exists from publish.** Publishing a doc creates its `share_links` row with
  the new-doc defaults (below), so the access config is always present and editable. (Previously the
  row was created lazily on first sharing edit — the cause of the latent no-access gap.)
- **New-doc defaults:** `workspace_role = commenter`, `link_role = null`. A new doc is shared with
  its workspace at the comment level (the shared-review-space default) and has no public link.
- **No data migration.** Greenfield: the schema change drops `general_access` and replaces the role
  column outright; the dev/test/demo databases are reset and reseeded (`bun db:seed`). The seed sets
  both axes explicitly. There is no production data to backfill, no expand/contract rollout, and no
  reverse-mapping of the old level (so the lossy `{*, set}` direction never has to be resolved).
- **doc_members** (individual invites) and **roles** (viewer < commenter < editor < owner, cumulative
  capabilities) are unchanged — owned by `sharing-permissions`.

## Stories

### S-001: Replace the access model with two independent axes (P0)

**Description:** As someone who can manage sharing, I set the workspace access role and the link
access role for a doc as two separate controls, so I can share with my team and with outside
link-holders at different levels without one affecting the other. The stored model is the two role
columns; the legacy single level is gone.
**Source:** Session decision 2026-06-25 (two independent axes replace the single general-access level).
**Applies Constraints:** C-001, C-002, C-003, C-009, C-011

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/backend/src/db/schema.ts`, `apps/backend/src/db/migrations/*`, `apps/backend/src/db/seed.ts`, `apps/backend/src/routes/sharing.ts`, `apps/backend/src/sharing/share.ts`, `apps/backend/src/sharing/share-state.ts`, `apps/backend/src/sharing/share-repo.ts`
- `autonomous:` checkpoint
- `verify:` set workspace=commenter + link=viewer on one doc → the share state reads back both roles independently; reseed brings up docs with both axes set.

**Acceptance Scenarios:**

AS-001: Share with the workspace at the comment level, no public link
- **Given:** a doc; the caller can manage sharing
- **When:** they set workspace access = commenter and leave link access off
- **Then:** the setting is saved; every workspace member can open and comment on the doc; someone outside the workspace with no invite is denied
- **Data:** workspace=commenter, link=off

AS-002: Link access does not demote workspace members
- **Given:** a doc with workspace access = commenter
- **When:** the caller turns link access on at the viewer level
- **Then:** workspace members still have the commenter role, while anyone opening the link gets only the viewer role — the two roles are independent and the lower link role does not pull members down
- **Data:** workspace=commenter, link=viewer

AS-003: Keep a doc out of the workspace while sharing it by link
- **Given:** a doc with workspace access = commenter and link access off
- **When:** the caller turns workspace access off and sets link access = viewer
- **Then:** the doc is no longer shared with the workspace (only the owner and individually-invited members reach it), while anyone with the link can view it
- **Data:** workspace=off, link=viewer

AS-004: An invalid role on either axis is rejected (error)
- **Given:** the caller is editing access
- **When:** they set workspace access (or link access) to "owner" or any value outside viewer/commenter/editor
- **Then:** the change is rejected; only viewer, commenter, editor, or off is accepted on each axis; the stored access is unchanged
- **Data:** workspace_role = owner → rejected

AS-007: Two managers editing different axes concurrently do not clobber each other
- **Given:** a doc with workspace access = commenter and link access = viewer; two managers open the Share dialog at once
- **When:** manager A changes workspace access to editor and manager B (a moment later, from a snapshot where workspace was still commenter) turns link access off
- **Then:** the final state is workspace access = editor AND link access = off — B's change to the link axis does not revert A's change to the workspace axis, because each axis is written independently rather than as a whole-row overwrite
- **Data:** A sets workspace→editor, B sets link→off, overlapping

### S-002: A new doc is shared with its workspace by default (P0)

**Description:** As a workspace member, when a teammate publishes a doc — via the web app or via an
agent over MCP — I can open and comment on it immediately, without anyone having to touch its
sharing settings first.
**Source:** Session decision 2026-06-25 (default workspace=commenter at publish; fixes the latent no-access gap).
**Applies Constraints:** C-007

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/publish/service.ts`, `apps/backend/src/publish/repo.ts`, `apps/backend/src/mcp/tools/publish-tools.ts`, `apps/backend/src/mcp/tools/publish-tools-wiring.ts`
- `autonomous:` checkpoint
- `verify:` publish a doc as user A (web and MCP); open it as workspace member B (not invited) → B can view and comment; a logged-out opener is denied.

**Acceptance Scenarios:**

AS-005: A freshly published doc is commentable by every workspace member
- **Given:** user A publishes a new doc into a workspace via the web app, touching no sharing settings
- **When:** another workspace member B (not the owner, not individually invited) opens it
- **Then:** B can view the doc AND leave a comment, because a new doc is shared with its workspace at the comment level by default
- **Data:** new doc, default access, member B opens it

AS-006: A new doc has no public link until one is turned on
- **Given:** user A publishes a new doc, touching no sharing settings
- **When:** a logged-out person who somehow has the readable address opens it
- **Then:** they are denied — a new doc has no public link by default; only after link access is turned on does the link grant access
- **Data:** new doc, default access, anonymous opener

AS-025: A doc published over MCP gets the same workspace default
- **Given:** an agent publishes a new doc into a workspace over MCP, setting no access
- **When:** another workspace member B (not the owner, not individually invited) opens it
- **Then:** B can view and comment, and the doc has no public link — the MCP publish surface applies the same new-doc default as the web publish surface (not the old `restricted` default)
- **Data:** MCP-published doc, default access, member B opens it

### S-003: Resolve a person's effective role from both axes, capping guests (P0)

**Description:** As the system, I grant a person the highest role they qualify for across the
workspace axis, the link axis, their individual invite, and ownership — but a no-account guest is
never allowed to edit, and the guest cap is applied at the anonymous-admission seam so every write
surface inherits it.
**Source:** Session decision 2026-06-25 (two link-role sources + anon capped at commenter, applied at the anon seam).
**Applies Constraints:** C-004, C-005, C-010

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/sharing/resolve-doc-role-repo.ts`, `apps/backend/src/sharing/resolve-access.ts`, `apps/backend/src/sharing/capability-cookie.ts`, `apps/backend/src/routes/sharing.ts` (the `canViewDoc` reconciliation, see C-010)
- `autonomous:` true
- `verify:` editor link → logged-in opener can publish a version; same link → no-account guest can comment but not publish; an anon hitting a write surface is capped at commenter regardless of route.

**Acceptance Scenarios:**

AS-008: A logged-in person on an editor link can edit
- **Given:** a doc with link access = editor
- **When:** a logged-in person opens it via the link
- **Then:** they get the editor role and can publish a new version of the doc
- **Data:** link=editor, logged-in opener

AS-009: A no-account guest on an editor link is capped at commenter (error/boundary)
- **Given:** a doc with link access = editor
- **When:** a no-account guest opens it via the link and tries to publish a new version
- **Then:** they may view and comment, but publishing is denied — the guest's role is clamped to commenter at the anonymous-admission seam, so no write surface (comment, resolve, or version publish) ever sees a guest as editor
- **Data:** link=editor, no-account guest attempts publish

AS-010: Highest role wins across sources
- **Given:** a doc with workspace access = commenter, where member C is also individually invited as editor
- **When:** C opens the doc
- **Then:** C gets the editor role (the higher of the invite and the workspace role)
- **Data:** workspace=commenter + invite=editor for C

AS-011: A no-account guest on a viewer link cannot comment (boundary)
- **Given:** a doc with link access = viewer
- **When:** a no-account guest opens it via the link
- **Then:** they may view only; the comment action is denied
- **Data:** link=viewer, no-account guest

### S-004: A doc appears in the workspace only when it is shared with the workspace (P0)

**Description:** As a workspace member, I see a doc in my workspace (dashboard list, search results,
project doc counts, MCP browse, and the doc's draft/live status badge) exactly when it is shared
with the workspace or with me personally — and sharing a doc externally by link does not change that.
**Source:** Session decision 2026-06-25 (browse keyed on workspace_role; one shared predicate across every listing surface).
**Applies Constraints:** C-006, C-010

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/workspace/projects.ts`, `apps/backend/src/workspace/repo.ts`, `apps/backend/src/search/search-repo.ts`, `apps/backend/src/mcp/tools/read-tools-wiring.ts`, `apps/backend/src/routes/projects.ts` (status + list payload derivation), `apps/backend/src/sharing/access.ts` (`canViewDoc` reconciliation)
- `autonomous:` true
- `verify:` workspace-shared doc shows in a member's dashboard; the same doc turned link-only (workspace off) drops out for a non-invited member but stays for an invited one; the list count and the listed rows match.

**Acceptance Scenarios:**

AS-012: A workspace-shared doc is listed in every member's dashboard
- **Given:** a doc with workspace access on
- **When:** any member of that workspace opens their dashboard
- **Then:** the doc appears in their list
- **Data:** workspace=commenter, a member browsing

AS-013: Sharing externally keeps the doc in the workspace
- **Given:** a doc with workspace access = commenter that is listed in members' dashboards
- **When:** the owner additionally turns link access on
- **Then:** the doc still appears in every member's dashboard — turning on the public link does not remove it from the workspace
- **Data:** workspace=commenter + link=viewer

AS-014: A link-only doc is hidden from non-invited members but shown to invited ones
- **Given:** a doc with workspace access off and link access = viewer
- **When:** a workspace member who is not individually invited browses their dashboard; and a member who IS individually invited browses theirs
- **Then:** the non-invited member does not see the doc (they can still open it if they have the link), while the invited member does see it
- **Data:** workspace=off, link=viewer, one invited member + one not

AS-015: Search applies the same visibility rule
- **Given:** a doc with workspace access off and link access = viewer (not shared with the workspace), and a workspace-shared doc
- **When:** a non-invited member searches the workspace
- **Then:** the link-only doc is absent from results while the workspace-shared one appears — search uses the same visibility rule as the dashboard
- **Data:** non-invited member searches a term both docs match

AS-016: Project doc counts apply the same visibility rule
- **Given:** a project containing one workspace-shared doc and one link-only (workspace off) doc
- **When:** a non-invited member views the project's doc count
- **Then:** the count includes the workspace-shared doc but not the link-only one — the count matches what the member can actually browse
- **Data:** non-invited member, project with 1 workspace-shared + 1 link-only doc

AS-017: MCP browse applies the same visibility rule
- **Given:** a workspace-shared doc and a link-only (workspace off) doc
- **When:** an agent lists workspace docs over MCP on behalf of a non-invited member
- **Then:** the workspace-shared doc is listed and the link-only one is not — MCP browse uses the same visibility rule as the dashboard
- **Data:** MCP browse for a non-invited member

AS-026: The doc-list payload derives status and access without leaking a hidden doc
- **Given:** a project with a workspace-shared doc and a link-only (workspace off) doc, browsed by a non-invited member
- **When:** the dashboard list loads
- **Then:** the visible doc's draft/live status and access summary are derived from the two axes (no reference to a stored level), and the link-only doc appears in neither the listed rows nor the count — the count and the rows come from the same filtered set
- **Data:** non-invited member, mixed project

### S-005: A public link exists exactly when link access is on (P1)

**Description:** As someone managing sharing, turning link access on gives me a shareable link, and
turning it off makes that link stop working — the link's existence is driven by the link axis, not
by any stored level.
**Source:** Session decision 2026-06-25 (capability token lifecycle keyed on link_role being set).
**Applies Constraints:** C-003

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/sharing/share-token.ts`, `apps/backend/src/sharing/share-repo.ts` (mint/rotate + the redeem gate), `apps/backend/src/sharing/share-state.ts`
- `autonomous:` true
- `verify:` turn link access on → a link is returned and redeems; turn it off → redeeming the old link is denied; a workspace-off + link-on doc still mints a link (proves link-keyed, not level-keyed).

**Acceptance Scenarios:**

AS-018: Turning link access on mints a shareable link
- **Given:** a doc with link access off and no public link (workspace access may be on or off)
- **When:** the caller turns link access on at the commenter level
- **Then:** a shareable link is returned that redeems and opens the doc at the commenter level
- **Data:** link off → link=commenter

AS-019: Turning link access off stops the link working
- **Given:** a doc with link access on and a shareable link in circulation
- **When:** the caller turns link access off
- **Then:** redeeming the previously shared link is denied — the capability token is cleared with the link axis
- **Data:** link=commenter → off

AS-020: Changing the link role keeps the same link working at the new role
- **Given:** a doc with link access = commenter and a shareable link
- **When:** the caller changes link access to viewer
- **Then:** the same link still opens the doc, now at the viewer level
- **Data:** link=commenter → viewer

### S-006: Reads expose both the raw axes and a derived summary (P1)

**Description:** As a client (web viewer, Share dialog, or MCP), I read both the two raw axis roles
and a single derived access summary for a doc, so the dialog can show each axis precisely while
simpler displays keep working off the summary.
**Source:** Session decision 2026-06-25 (legacy level derived on read, never stored) + challenge finding (the 3-value summary is lossy, so reads must also carry the raw axes).
**Applies Constraints:** C-008

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/sharing/share-state.ts`, `apps/backend/src/render/viewer-loaders.ts`, `apps/backend/src/routes/viewer-doc.ts`, `apps/backend/src/routes/projects.ts`, `apps/backend/src/mcp/tools/read-tools.ts`
- `autonomous:` true
- `verify:` read a doc with workspace=commenter/link=off → summary "anyone in workspace" + raw {commenter, null}; set link on → summary "anyone with link" + raw {commenter, viewer}.

**Acceptance Scenarios:**

AS-021: A workspace-shared, link-off doc summarizes as "anyone in workspace"
- **Given:** a doc with workspace access on and link access off
- **When:** a client reads the doc's access summary
- **Then:** the summary reads as "anyone in workspace" (derived from the two axes, not stored)
- **Data:** workspace=commenter, link=off

AS-022: A link-on doc summarizes as "anyone with link"
- **Given:** a doc with workspace access on and link access on
- **When:** a client reads the doc's access summary
- **Then:** the summary reads as "anyone with link"
- **Data:** workspace=commenter, link=viewer

AS-027: Reads carry the raw two-axis state so workspace-shared is distinguishable from link-only
- **Given:** doc X with workspace access = commenter and link access = viewer, and doc Y with workspace access off and link access = viewer (both summarize to "anyone with link")
- **When:** a client reads each doc's access
- **Then:** the response carries the raw workspace and link roles for each, so the client can tell X is also shared with the workspace while Y is link-only — the derived summary alone does not lose that distinction
- **Data:** X={commenter, viewer}, Y={off, viewer}

### S-007: The share dialog shows two independent controls (P1)

**Description:** As an owner opening the Share dialog, I see and set workspace access and link access
as two separate controls, each with its own role; FE displays that previously read the single level
read the derived summary or the raw axes as appropriate.
**Source:** Session decision 2026-06-25 (FE ShareDialog two controls) + challenge finding (FE facet/badge consumers of the old level).
**Applies Constraints:** C-001

**Execution:**
- `depends_on:` S-001, S-006
- `parallel_safe:` false
- `files:` `apps/web/src/features/sharing/components/*`, `apps/web/src/features/sharing/services/client.ts`, `apps/web/src/features/sharing/types/*`, `apps/web/src/features/docs/lib/doc-filter.ts`, `apps/web/src/features/viewer/components/viewer-top-bar.tsx`
- `autonomous:` true
- `verify:` open Share on a doc → two controls (Workspace access / Link access) each with a role dropdown and an off option; the docs-list access facet + viewer top-bar badge render off the derived summary.

**Acceptance Scenarios:**

AS-023: The dialog presents workspace access and link access separately
- **Given:** an owner opens the Share dialog for a doc
- **When:** the dialog renders
- **Then:** it shows a Workspace access control and a Link access control, each with its own role choice and an off option, reflecting the doc's current two-axis state
- **Data:** workspace=commenter, link=off

AS-024: Setting link access lower than workspace access persists both independently
- **Given:** an owner in the Share dialog of a doc with workspace access = commenter
- **When:** they set link access = viewer and save
- **Then:** the dialog shows workspace access still at commenter and link access at viewer — neither control overrides the other
- **Data:** workspace=commenter, link=viewer

## Constraints & Invariants

- C-001: A doc has two independent access axes — workspace access and link access; setting one axis
  never changes the other. (AS-002, AS-003, AS-024)
- C-002: `workspace_role` grants its role to every member of the doc's OWN workspace; `null` = the
  doc is not shared with the workspace (only owner + individually-invited members reach it). (AS-001, AS-003, AS-014)
- C-003: `link_role` grants its role to anyone holding the link; `null` = no public link and no
  capability token. The capability token is minted when `link_role` goes from off to set, kept while
  set, and cleared when `link_role` goes to off — keyed on the link axis, NOT on any stored level.
  (AS-018, AS-019, AS-020)
- C-004: A no-account guest is capped at commenter regardless of `link_role` — editing (publishing a
  version) always requires a logged-in account. The cap is applied at the anonymous-admission seam
  (`resolve-access.ts` anon branch / the capability-cookie role), so every read AND write surface
  inherits it without each route re-implementing it. (AS-009, AS-011)
- C-005: Effective role = the highest of {owner, individual invite role, `workspace_role` when the
  caller is a member of the doc's workspace, `link_role` when the caller holds the link / a valid
  admission cookie}. The logged-in resolver folds owner + invite + both axis sources; the anonymous
  branch contributes the capped link role. (AS-008, AS-010)
- C-006: A doc is visible in the workspace iff the caller is the owner OR individually invited OR
  `workspace_role` is set; `link_role` is irrelevant to workspace visibility. This rule is ONE shared
  predicate that must hold identically across every workspace-listing surface, including the
  draft/live status and the list payload (the count and the listed rows come from the same filtered set).
  - scope: S-004
  - surfaces: dashboard list, search, project doc counts, MCP browse, list payload (status + access summary)
  - coverage: dashboard list → AS-012, AS-013, AS-014; search → AS-015; project doc counts → AS-016; MCP browse → AS-017; list payload (status + access) → AS-026
- C-007: A newly published doc is created with `workspace_role = commenter` and `link_role = null`,
  applied at publish so the access config always exists. This holds at every publish surface.
  - scope: S-002
  - surfaces: web/UI publish, MCP publish
  - coverage: web/UI publish → AS-005, AS-006; MCP publish → AS-025
- C-008: The legacy `general_access` level is DERIVED from the two axes at read time
  (`{null,null}`=restricted, `{set,null}`=anyone_in_workspace, `{*,set}`=anyone_with_link) and is
  never stored. Because the 3-value summary collapses distinct axis states, every read surface that a
  richer client consumes ALSO carries the raw `{workspaceRole, linkRole}` alongside the summary.
  (AS-021, AS-022, AS-027)
- C-009: Each axis role must be one of viewer | commenter | editor (or off/null); "owner" is the doc
  creator and is never assignable on either axis. (AS-004)
- C-010: There is ONE access decision for a doc. Every code path that read the dropped
  `general_access` is migrated to read the two axis columns (or `deriveLevel`), and the parallel
  `canViewDoc` decision is reconciled to the two-axis model so the share-management read gate and the
  resolver never disagree. The full reader inventory (What Already Exists) must be exhausted — a
  missed reader is a correctness/security defect, not cosmetic. (AS-009, AS-026)
- C-011: Each axis is written with a column-scoped update, never a read-modify-write of the whole
  share-config row, so two managers editing different axes concurrently cannot clobber each other's
  axis (no lost update across axes). (AS-007)

## What Already Exists

### System Impact & Technical Risks

- The role/capability model (`apps/backend/src/sharing/roles.ts`: viewer<commenter<editor<owner,
  cumulative; `effectiveRole` highest-wins; contextual `canManageSharing`) is UNCHANGED — this spec
  only changes which axes feed roles into it. Reuse as-is.
- **Full `general_access` reader inventory (C-010) — every site below must be migrated, not just the
  four browse predicates.** A grep for `generalAccess` / `general_access` was incomplete in the first
  draft; the build must re-grep and exhaust this list:

  | Site | Today reads | Must become |
  |---|---|---|
  | `sharing/resolve-doc-role-repo.ts` | `docs.general_access` switch for the link-role source | two columns: workspace_role (member-gated) + link_role |
  | `sharing/resolve-access.ts:88` | anon gate `generalAccess !== 'anyone_with_link'` | `link_role IS NOT NULL`; anon role capped at commenter (C-004) |
  | `sharing/access.ts` `canViewDoc` | parallel access decision switching on the level | reconciled to the two-axis model or retired in favor of `resolveAccess` (C-010) |
  | `sharing/share-repo.ts` capability-token repo + redeem gate | `eq(docs.general_access,'anyone_with_link')` | `link_role IS NOT NULL` |
  | `sharing/share-token.ts` mint/rotate | keyed on the level enum | keyed on `link_role` transitions (C-003) |
  | `sharing/share-repo.ts` `setGeneralAccess` | writes `docs.general_access` + a single role | per-axis column writes (C-011); no `docs.general_access` write |
  | `routes/sharing.ts` (`loadVisibleDoc` via `canViewDoc`) | `doc.generalAccess` | the reconciled decision (C-010) |
  | `workspace/projects.ts` `canBrowseDoc` + `workspace/repo.ts` stats SQL | level checks | `workspace_role IS NOT NULL` (C-006) |
  | `search/search-repo.ts`, `mcp/tools/read-tools-wiring.ts` | level checks | `workspace_role IS NOT NULL` (C-006) |
  | `routes/projects.ts` status + list payload | `d.generalAccess` for draft/live + raw level out | `deriveLevel` + raw axes (C-006, C-008) |
  | `annotation/guest.ts` + `routes/annotations.ts` guest gate | "commenter+ on an anyone_with_link doc" | gate via `link_role` + the capped anon role (C-004) |
  | `mcp/tools/publish-tools.ts` + wiring | documents `restricted` default | the new-doc default (C-007) |
  | FE `features/docs/lib/doc-filter.ts` facets | `d.generalAccess` buckets | the derived summary from the read payload (C-008) |
  | FE `features/viewer/components/viewer-top-bar.tsx` `isLive` | `generalAccess !== 'restricted'` | the derived summary (C-008) |

- `share_links` today: `role` (single), `default 'viewer'`, and the row is created LAZILY on first
  sharing edit. This redesign makes the row exist from publish and replaces `role` with two columns.
- Migration risk is LOW (greenfield): no production data, so the change is a schema replace + reseed
  (Data Model), not an expand/contract with backfill. S-001/S-002 stay `autonomous: checkpoint`
  because they are schema + publish-path changes a human should eyeball, not because of data loss.
- `sharing-permissions` owns the single-level model today (C-009/C-018, the share-state read, the
  management routes). This spec supersedes the level semantics; that spec (and four others + CLAUDE.md)
  must be amended so the spec set stays consistent — a committed cascade, see Not in Scope.

## Not in Scope

- **Committed cascade (follow-up, same release, tracked — NOT optional):** amend the specs that
  describe the OLD single-level model so the spec set stays transparent and consistent —
  `sharing-permissions` (C-009/C-018, S-001, S-006 share state), `doc-access-routing` (C-003
  "anyone_with_link is not a browse grant"), `render-publish` (C-011), `mcp-roundtrip` (C-006),
  `workspaces` (C-007), and the locked 2026-06-23 default-access note in `CLAUDE.md`. They are not
  built as stories HERE, but they must land in the same release; `doc-access-two-axis` is the source
  of truth they point to. (Whether to fold this spec INTO `sharing-permissions` vs keep it standalone
  is a build-time call; standalone is fine if the cascade lands.)
- A separate per-axis password / expiry / view-limit — link controls stay attached to the link axis
  only, as today. v0.5+.
- An admin UI to change the workspace default role per workspace — still deferred (`workspaces`, v0.5+).
- Request-access / approval flows — v0.5 (unchanged from `sharing-permissions`).

## Linked Fields

- **two-axis access state** (`{ workspaceRole, linkRole }`) — produced by S-001 on the access-write
  response and by S-006 on the share-state + doc-read responses. Consumed by S-007 (the ShareDialog)
  on open to prefill both controls, and by any client that must distinguish workspace-shared from
  link-only (persisted + served on every read). ✔ surface (reads) + lifecycle (persisted) match.
- **derived `generalAccess` summary** — produced by S-006 on the doc-read, list, and share-state
  responses (derived at read). Consumed by the web docs-list facet, the viewer top-bar badge, and MCP
  read displays. ✔ surface (reads) + lifecycle (recomputed each read) match; the raw axes accompany it
  (C-008) so no consumer is forced to reverse the lossy summary.
- **new-doc defaults at publish** — produced by S-002 at the web publish surface (AS-005, AS-006) and
  the MCP publish surface (AS-025). Consumed by every member-visibility surface in S-004. ✔ both
  publish surfaces asserted in this spec.

## Gaps

- GAP-001 (status: resolved → AS-025): the new-doc default (`workspace_role=commenter`,
  `link_role=null`) also applies when a doc is published over MCP, asserted by AS-025 with the MCP
  publish files listed in S-002. The shared publish path makes both surfaces apply the same default.
  Source: "DEFAULTS at publish … the MCP create port both supply it".

## Spec Sizing Notes

Stories=7 (= soft target). AS=27 (7 over the 20 soft target, within the 30 hard cap).

The AS over the soft target come from G1 splits, each its own atom (no AS gộp):
- S-004 visibility: AS-012/013/014 (dashboard: shown / stays-on-external-share / link-only-hidden),
  AS-015 (search), AS-016 (project counts), AS-017 (MCP browse), AS-026 (list payload status+access
  consistency) — 7 atoms, because C-006 is a cross-surface invariant requiring per-surface coverage (CC5).
- S-002 defaults: AS-005/006 (web: member-commentable / no-link) + AS-025 (MCP publish same default)
  — 3 atoms, because C-007 covers both publish surfaces.
- S-001 set-access: AS-001/002/003 (workspace-only / no-demotion / link-only) + AS-004 (invalid role)
  + AS-007 (concurrent per-axis writes, C-011) — 5 atoms.
- S-003 resolution: AS-008/009/010/011 (logged-in editor / guest cap at the write surface / highest-wins /
  guest-viewer) — 4 atoms.
- S-006 reads: AS-021/022 (derived summary) + AS-027 (raw axes distinguish workspace-shared from
  link-only) — 3 atoms.

No bloat — each AS traces to one stated atom. The spec is ONE cohesive access state-machine (T5/T6:
schema, resolver, browse, link lifecycle, and FE all share the two-axis data model), so it is kept
whole rather than split.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-25 | Initial creation (session decision: two independent access axes replace the single general_access level) | -- |
| 2026-06-25 | GAP-001 resolved → AS-025 (MCP publish applies the same new-doc default); C-007 MCP-surface coverage + Linked Field updated | -- |
| 2026-06-25 | /mf-challenge applied: greenfield reseed replaces data-migration (no users); +full reader inventory (C-010) + canViewDoc reconciliation; anon cap moved to the anon-admission seam (C-004); token mint re-keyed on link_role (C-003); +concurrency per-axis writes (C-011, AS-007 repurposed from migration-preserve); reads carry raw axes (C-008, +AS-027); +list-payload consistency (AS-026); MCP publish files added to S-002; cascade elevated to committed follow-up | /mf-challenge |
