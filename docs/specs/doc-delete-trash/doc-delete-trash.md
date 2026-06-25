# Spec: Delete Doc → Trash (soft-delete + restore)

**Created:** 2026-06-25
**Last updated:** 2026-06-25
**Status:** Draft

## Overview

Let an authorized member delete a doc into a per-workspace Trash and restore it later with every version and annotation intact. Delete is a reversible soft-delete (a `deleted_at` tombstone) — nothing is removed from the database, so content restore is lossless (access is deliberately reset on restore — the doc comes back private, C-008). Today there is no doc delete anywhere (no web route, no MCP tool, no UI, no tombstone column); only projects have archive/delete. This feature adds delete + restore on both the web (⋯ menu + a dedicated Trash page) and over MCP (`delete_document` / `restore_document`), makes a deleted doc disappear from every listing/read surface, and adds a manual permanent-delete escape hatch from Trash.

Scope is one tier only: **Delete → Trash**. Doc archive (the lighter "shelve, link still works" tier projects have) was considered and dropped — see `## Not in Scope`.

## Data Model

- **`docs` table — add two nullable columns** (new migration):
  - `deleted_at timestamptz NULL` — the soft-delete tombstone. `NULL` = active; a timestamp = in Trash.
  - `deleted_workspace_id text NULL` — the doc's owning workspace, **captured at delete time** (resolved via `project_id → projects.workspace_id` in the delete service). A doc's workspace is otherwise derivable ONLY through its project, and `project_id` is nullable + `on delete set null`; without this column, deleting a doc and then its (now-empty) project would orphan the tombstone — it would belong to no workspace and appear in no Trash. This column is the stable Trash-membership and restore-scoping key (C-004, C-005). FK to `workspaces.id` (`on delete cascade` — if the workspace is gone, the Trash row is meaningless). `NULL` while the doc is active.
  - No backfill: existing rows default to `NULL` (= not deleted).
  - **No `deleted_by` column.** The deleting actor is already recorded on the `doc_deleted` activity row (AS-005); a second FK would be a write-only column no v0 surface reads. The Trash UI shows deleted-at only (see UI Notes). If "deleted by X" is ever surfaced, recover it from the activity log.
- **Partial index for the exclusion filter:** `create index docs_active_idx on docs (project_id) where deleted_at is null` (rides the S-001 migration). Every doc-list query gains a `deleted_at IS NULL` predicate; the partial index keeps active-doc listing scans off the tombstones. (SQLite also supports partial indexes, so this stays portable.)
- **`activity_type` pgEnum — add two members:** `doc_deleted`, `doc_restored`. Hand-synced with the `ActivityType` union in `apps/backend/src/activity/types.ts`. ⚠ This extends the set previously locked at 12 by `workspace-activity` C-005 — that lock is amended here (see `## What Already Exists § System Impact`).
- Restore target is derived, not stored: a restored doc keeps its `project_id`; if that project no longer exists (or `project_id` is null), it falls back to **the restoring actor's default project** in `deleted_workspace_id` (`ensureDefaultProject(workspaceId, actorId, actorName)`) — NOT the original owner's default, which may not exist if the owner was removed (C-004).
- **Slug invariant:** a slug is `<slugified-title>-<random-suffix>`, generated once at publish (`apps/backend/src/publish/slug.ts`) and globally unique. A deleted doc keeps its slug on the retained row, and restore reuses that same slug — it is never regenerated. The random suffix means a fresh publish never derives a colliding slug, so neither publish-during-deletion nor restore can collide on `slug` uniqueness.

## Stories

### S-001: Delete a doc into Trash (P0)

**Description:** As a doc owner, per-doc editor, or workspace admin, I can delete a doc from the workspace doc grid's ⋯ menu so it leaves the browse view and stops being viewable, while its data is preserved for later restore.
**Source:** docs/explore/doc-delete-trash.md#happy-path, #permissions, #decision-model
**Applies Constraints:** C-001, C-003, C-006

**Gate (explicit — this is net-new, not "mirror project delete"):** project delete gates on owner-or-admin and has no per-doc role concept; this feature additionally grants the per-doc *editor* destructive rights, so the gate composes two orthogonal resolvers:
`(resolveAccess(docId, actor).role ∈ {owner, editor})` **OR** `(workspaceRole(actor, workspace) === "admin")`.
Precedence: the two are OR'd — either path alone admits. A workspace admin with NO per-doc grant (resolveAccess returns `role: null`) is still admitted via the workspace-role arm (AS-021). A null per-doc role with a non-admin workspace role is refused.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/backend/src/db/schema.ts` (migration: `deleted_at`/`deleted_by` + enum members), `apps/backend/src/workspace/doc-delete.ts` (new soft-delete service), `apps/backend/src/workspace/doc-delete-repo.ts` (new), `apps/backend/src/routes/docs.ts` (DELETE route), `apps/backend/src/activity/types.ts` + `apps/backend/src/activity/emit.ts` (new event types), `apps/web/src/features/docs/services/client.ts` (deleteDoc thunk), `apps/web/src/features/docs/components/move-copy-dialog.tsx` (DocMoreMenu → Delete item), `apps/web/src/features/docs/components/doc-card.tsx`, `apps/web/src/features/docs/components/delete-doc-dialog.tsx` (new)
- `autonomous:` checkpoint
- `verify:` `bun test apps/backend/test/routes/docs-routes.test.ts`

**Acceptance Scenarios:**

AS-001: Owner deletes a doc with annotations
- **Given:** owner Mai is viewing the workspace doc grid; her doc "Spec v1" has 8 annotations and 2 versions
- **When:** she opens the doc card ⋯ menu, clicks Delete, and confirms in the dialog
- **Then:** the doc is recorded as deleted (tombstoned), disappears from the grid, and a toast confirms the deletion; the 8 annotations and 2 versions remain stored (not removed)
- **Data:** doc "Spec v1", ownerId = Mai, 8 annotations, 2 versions

AS-002: A per-doc editor can delete
- **Given:** Lan holds the editor role on a doc she does not own
- **When:** she clicks Delete on that doc and confirms
- **Then:** the doc is tombstoned and leaves the grid
- **Data:** doc owned by someone else, Lan's doc role = editor

AS-003: A workspace admin can delete
- **Given:** Huy is a workspace admin and is not the doc owner nor a per-doc editor
- **When:** he clicks Delete on a workspace doc and confirms
- **Then:** the doc is tombstoned and leaves the grid
- **Data:** doc owned by another member, Huy's workspace role = admin

AS-004: A commenter is refused
- **Given:** Nam's only grant on a doc is the commenter role
- **When:** Nam attempts to delete the doc
- **Then:** the request is refused with "insufficient permission" and the doc stays active; the Delete item is not offered in Nam's ⋯ menu
- **Data:** doc role = commenter

AS-005: Delete is logged to workspace activity
- **Given:** owner Mai deletes "Spec v1"
- **When:** the delete succeeds
- **Then:** a `doc_deleted` activity entry is recorded with Mai as the actor and the doc as the subject
- **Data:** actor = Mai, subject doc = "Spec v1"

AS-021: A workspace admin with no per-doc role can delete
- **Given:** Huy is a workspace admin whose effective per-doc role (resolveAccess) is `null` — he is neither owner, invited, nor covered by the workspace-axis share
- **When:** he clicks Delete on that doc and confirms
- **Then:** the doc is tombstoned (admitted via the workspace-admin arm of the composed gate)
- **Data:** doc with no per-doc grant to Huy, Huy's workspace role = admin

AS-022: Delete is idempotent — a double-delete makes one tombstone and one activity row
- **Given:** a doc is deleted, then the same delete is issued again (double-click or MCP retry)
- **When:** the second delete runs
- **Then:** the doc has exactly one `deleted_at` (the second is a no-op: `UPDATE … WHERE deleted_at IS NULL` changes 0 rows), and exactly one `doc_deleted` activity entry exists (emit happens only when the conditional update changes a row)
- **Data:** one doc, two delete requests

### S-002: A deleted doc disappears from every web listing (P1)

**Description:** As a workspace member, I never see a deleted doc in any browse list, project grid, project doc count, or search result, so Trash is the only place deleted docs appear.
**Source:** docs/explore/doc-delete-trash.md#exclusion-sweep
**Applies Constraints:** C-002

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/routes/docs.ts` (workspace doc list), `apps/backend/src/routes/projects.ts` (project doc grid + counts), `apps/backend/src/workspace/repo.ts` / `apps/backend/src/workspace/doc-move-repo.ts` (doc-by-project + counts), `apps/backend/src/search/search-repo.ts` + `apps/backend/src/search/search.ts`
- `autonomous:` true
- `verify:` `bun test apps/backend/test/integration/workspace-docs.itest.ts apps/backend/test/integration/search.itest.ts`

**Acceptance Scenarios:**

AS-006: Deleted doc is absent from the workspace browse list
- **Given:** a workspace with 5 active docs; one is then deleted
- **When:** a member loads the workspace doc grid
- **Then:** 4 docs are listed and the deleted one is absent
- **Data:** 5 docs, 1 deleted

AS-007: Deleted doc is absent from its project's doc grid
- **Given:** project "Billing" holds 3 docs; one is deleted
- **When:** a member opens the "Billing" project doc grid
- **Then:** 2 docs are listed and the deleted one is absent
- **Data:** project "Billing", 3 docs, 1 deleted

AS-008: Project doc count excludes deleted docs
- **Given:** project "Billing" had a count of 3; one of its docs is deleted
- **When:** the projects list is loaded
- **Then:** "Billing" reports a doc count of 2
- **Data:** project "Billing", 3 → 2 after delete

AS-009: Search does not return deleted docs
- **Given:** a deleted doc whose title and body match the query "invoice"
- **When:** a member searches "invoice"
- **Then:** the deleted doc does not appear in results
- **Data:** query "invoice", 1 matching-but-deleted doc

### S-003: Restore a doc from Trash (P0)

**Description:** As a doc owner, per-doc editor, or workspace admin, I can open the workspace Trash, see deleted docs, and restore one back to its project with all annotations and versions intact. The restored doc comes back **private** — restore never silently re-arms the public link the deleter may have intended to kill.
**Source:** docs/explore/doc-delete-trash.md#happy-path (step 5), #decision-model, #assumptions
**Applies Constraints:** C-001, C-003, C-004, C-007, C-008

**Scoping & gate:** the Trash list and the restore route are scoped to the path `:workspaceId` in SQL (`deleted_at IS NOT NULL AND deleted_workspace_id = :workspaceId`). Deleted rows escape the normal browse access filter, so this workspace check is the ONLY thing preventing a cross-workspace restore — it is mandatory, not implied (C-007). The restore gate is the same composed gate as delete (S-001). Restore is idempotent: `UPDATE … WHERE deleted_at IS NOT NULL`; a no-op (already active) emits no `doc_restored` (C-006).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/routes/docs.ts` (Trash list + restore routes, both scoped to `:workspaceId`), `apps/backend/src/workspace/doc-delete.ts` (restore service: reset `share_links` to {null,null} + rotate capability token for AS-023; fallback project resolution for AS-011/AS-024), `apps/backend/src/workspace/doc-delete-repo.ts`, `apps/web/src/features/docs/services/client.ts` (listTrash + restoreDoc thunks), `apps/web/src/features/docs/components/trash-screen.tsx` (new), `apps/web/src/app/` (Trash route)
- `autonomous:` true
- `verify:` `bun test apps/backend/test/routes/docs-routes.test.ts`

**Acceptance Scenarios:**

AS-010: Restore returns the doc with its data intact
- **Given:** owner Mai opens the workspace Trash and sees "Spec v1" (deleted, 8 annotations, 2 versions)
- **When:** she clicks Restore on "Spec v1"
- **Then:** the doc returns to its original project, reappears in the browse grid, and still has its 8 annotations and 2 versions
- **Data:** "Spec v1", originalProject = "Billing" (still exists), 8 annotations, 2 versions

AS-011: Restore falls back to the restorer's default project when the original project is gone
- **Given:** a deleted doc whose original project no longer exists (or whose `project_id` is null)
- **When:** an authorized user restores it
- **Then:** the doc is restored into the **restoring actor's** default project in the doc's `deleted_workspace_id` (via `ensureDefaultProject`)
- **Data:** deleted doc, original project removed, restorer's default project present

AS-023: Restore comes back private — the old public link stays dead until re-shared
- **Given:** owner Mai had made "Spec v1" anyone-with-link (link_role = commenter), then deleted it
- **When:** an authorized user restores it from Trash
- **Then:** the doc returns with both access axes off (`workspace_role = null`, `link_role = null`) and its capability token rotated; the previously-shared URL no longer grants access until someone re-shares the doc
- **Data:** deleted doc that was anyone-with-link before delete

AS-024: A doc whose project was deleted AND whose owner was removed still restores
- **Given:** a deleted doc whose owner was removed from the workspace (`owner_id` is null) and whose original project was deleted (`project_id` is null), with `deleted_workspace_id` still set
- **When:** admin Huy restores it
- **Then:** the doc lands in Huy's default project in that workspace and reappears in the grid (no 500, no orphan)
- **Data:** deleted doc, owner_id null, project_id null, deleted_workspace_id set, restorer = admin Huy

AS-025: Cross-workspace restore is refused
- **Given:** Huy is admin of workspace X and also a member of workspace Y; a doc in Y has been deleted
- **When:** Huy issues a restore for that doc through workspace X's route (`/api/w/X/.../restore`)
- **Then:** the request is refused as not-found and the Y doc stays in Y's Trash (the restore query is scoped to `deleted_workspace_id = X`)
- **Data:** deleted doc in workspace Y, request scoped to workspace X

AS-026: The Trash list never includes another workspace's deleted docs
- **Given:** workspace X has 1 deleted doc and workspace Y has 2, and the caller is a member of both
- **When:** the caller opens workspace X's Trash
- **Then:** only X's 1 deleted doc is listed; Y's 2 are absent
- **Data:** X = 1 deleted, Y = 2 deleted, caller in both

AS-012: Restore is logged to workspace activity
- **Given:** Mai restores "Spec v1"
- **When:** the restore succeeds
- **Then:** a `doc_restored` activity entry is recorded with Mai as the actor and the doc as the subject
- **Data:** actor = Mai, subject doc = "Spec v1"

AS-013: Empty Trash shows an empty state
- **Given:** a workspace with no deleted docs
- **When:** a member opens the Trash page
- **Then:** an empty state is shown ("Nothing in Trash") and no rows are listed
- **Data:** 0 deleted docs

AS-020: A commenter is refused on restore
- **Given:** Nam's only grant on a deleted doc is the commenter role
- **When:** Nam attempts to restore it from Trash
- **Then:** the request is refused with "insufficient permission" and the doc stays in Trash; no Restore action is offered to Nam
- **Data:** deleted doc, Nam's doc role = commenter

AS-027: Restore is idempotent — restoring an already-active doc is a no-op
- **Given:** a doc that is active (not deleted)
- **When:** a restore is issued for it (stale Trash view, retry)
- **Then:** nothing changes (`UPDATE … WHERE deleted_at IS NOT NULL` changes 0 rows) and no `doc_restored` activity entry is written
- **Data:** one active doc, one restore request

### S-004: A deleted doc's link shows a deleted notice — only to viewers who had access (P1)

**Description:** As someone who *had* access to a doc that was then deleted, opening its link shows a clear "this doc was deleted" notice rather than a bare not-found page. As someone who never had access, the link returns the same existence-hiding not-found as any other inaccessible doc — the notice must not become a slug-enumeration oracle.
**Source:** docs/explore/doc-delete-trash.md#edge-cases (dead link)
**Applies Constraints:** C-002

**Existence-hiding (locked):** the viewer stack returns byte-identical NOT_FOUND for a missing doc and a no-access doc. The deleted notice is therefore gated on prior access: it is shown ONLY to a viewer whom `resolveAccess` *would have admitted before the delete* — a signed-in member with a role, or an anon carrying a valid admission cookie for that doc's (pre-rotation) token. Everyone else gets the standard NOT_FOUND. Since restore rotates the token and clears both axes (AS-023), an anon with no admission cookie always falls through to NOT_FOUND.

**Single chokepoint (C-002 / C-009):** the `deleted_at IS NULL` check lives inside `resolveAccess` (or its repo query), which returns a distinct `deleted` reason (still `canView = false`). This one change covers EVERY id-keyed read path that flows through `resolveAccess`, not just the viewer route: `/v/:versionId` version content, the annotations GET, comment POST on an existing annotation id, and version-diff. Those paths must not re-derive access independently.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/sharing/resolve-access.ts` (add `deleted_at` check → `deleted` reason), `apps/backend/src/routes/viewer-doc.ts`, `apps/backend/src/routes/versions.ts` (`/v/:versionId`, diff), `apps/backend/src/annotation/` (annotation GET + comment POST honor the `deleted` reason), `apps/web/src/features/viewer/components/no-access-view.tsx` (reuse — add a `"deleted"` reason/copy, do NOT build a new component)
- `autonomous:` true

**Acceptance Scenarios:**

AS-014: A member who had access opening a deleted doc's link sees the deleted notice
- **Given:** a doc that has been deleted, and a member who previously had a role on it
- **When:** the member opens the doc's link
- **Then:** a "this doc was deleted" notice is shown (the `"deleted"` variant of `NoAccessView`) and the doc content is not rendered
- **Data:** deleted doc, member with prior access

AS-015: A visitor who never had access gets the standard not-found, not the notice
- **Given:** a deleted doc and an anon visitor with no admission cookie (the doc is now private + token-rotated), OR a signed-in non-member
- **When:** they open the link
- **Then:** the standard existence-hiding NOT_FOUND is returned — byte-identical to a never-existed slug; the deleted notice is NOT shown (no existence oracle)
- **Data:** deleted doc, visitor with no prior access

AS-028: A deleted doc is unreadable via a version-id or annotation-id, and uncommentable
- **Given:** a doc that has been deleted, and a reviewer holding a `/v/:versionId` URL and an annotation id from before the delete
- **When:** the reviewer requests the version content, the annotations list, or POSTs a comment on the existing annotation id
- **Then:** each is refused (the `deleted` reason from `resolveAccess`); no content is rendered and no comment is created
- **Data:** deleted doc, valid pre-delete version id + annotation id

### S-005: Delete and restore docs over MCP, and exclude deleted docs (P1)

**Description:** As an agent connected over MCP, I can delete a doc via a `delete_document` tool and restore one via a `restore_document` tool, and the MCP list/pull/read tools never surface a deleted doc.
**Source:** docs/explore/doc-delete-trash.md#mcp-impact, #assumptions
**Applies Constraints:** C-002, C-003, C-006, C-007

**MCP gate (surface-specific — differs from web, by design):** the MCP layer resolves only a per-doc role via `resolveAccess`; it has NO path that reads `workspace_members.role === "admin"`. So `delete_document`/`restore_document` are gated on **owner-or-editor only** — workspace-admin-without-a-per-doc-role can delete/restore on the WEB surface but not over MCP. This surface difference is intentional (avoids net-new admin plumbing in the MCP server) and is recorded in C-003.

**Cross-tenant binding (mandatory — C-007):** a slug is globally unique and ids are guessable, and a token-owner may belong to more than one workspace. Both tools MUST verify the resolved doc's workspace equals the token's `ctx.workspaceId` (reject identically to not-found), mirroring `read-tools.ts` C-013. Resolve-by-slug-or-id is always scoped to the token's workspace.

**Symmetry (H-6):** restore over MCP is in scope so an agent that deletes can also recover its own mistake — the destructive and recovery halves ship together rather than forcing a human into every agent rollback. MCP restore obeys the same private-on-restore reset as the web path (AS-023).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/mcp/tools/publish-tools.ts` (or a new delete/restore tool module) + `*-wiring.ts`, `apps/backend/src/mcp/tools/read-tools.ts`, `apps/backend/src/mcp/tools/pull-tools.ts`, `apps/backend/src/mcp/tools/project-tools.ts`, `apps/backend/src/mcp/server.ts`
- `autonomous:` checkpoint

**Acceptance Scenarios:**

AS-016: The MCP delete tool soft-deletes a doc
- **Given:** an agent token whose workspace owns a doc the token's identity may delete
- **When:** the agent calls `delete_document` for that doc, identifying it by either its slug or its id
- **Then:** the doc is tombstoned (same soft-delete as the web path) and its annotations/versions are preserved
- **Data:** doc resolvable by slug OR id, token identity = owner-or-editor

AS-029: MCP delete cannot reach another workspace's doc
- **Given:** a token scoped to workspace X whose owner is also a member (even admin) of workspace Y; a doc lives in Y
- **When:** the agent calls `delete_document` with the Y doc's slug or id
- **Then:** the call is refused as not-found (the resolved doc's workspace ≠ the token's workspace) and the Y doc stays active
- **Data:** W-X token, target doc in W-Y, slug or id supplied

AS-030: A commenter/viewer token is refused MCP delete
- **Given:** a token whose identity's only per-doc role is commenter (or viewer)
- **When:** the agent calls `delete_document` for that doc
- **Then:** the call is refused for insufficient permission and the doc stays active
- **Data:** token per-doc role = commenter

AS-031: The MCP restore tool restores a deleted doc, private
- **Given:** a deleted doc the token's identity may restore (owner-or-editor in the token's workspace)
- **When:** the agent calls `restore_document` by slug or id
- **Then:** the doc is un-tombstoned into the restorer-identity's default project (or its original project if present), with both access axes off and token rotated (AS-023), and annotations/versions intact
- **Data:** deleted doc in the token's workspace, token identity = owner-or-editor

AS-017: The MCP doc list excludes deleted docs
- **Given:** a workspace with one deleted doc among several active ones
- **When:** the agent lists docs over MCP
- **Then:** the deleted doc is absent from the list
- **Data:** several active docs + 1 deleted

AS-018: MCP pull excludes deleted docs
- **Given:** a doc that has been deleted
- **When:** the agent pulls annotations across the workspace's docs
- **Then:** no annotations from the deleted doc are returned
- **Data:** deleted doc with annotations

AS-019: MCP read of a deleted doc is refused
- **Given:** a doc that has been deleted
- **When:** the agent reads that specific doc over MCP
- **Then:** the read is refused as not-found (the deleted doc is treated as unreachable)
- **Data:** deleted doc, direct read by slug

### S-006: Deleted docs don't leak through activity or deep-links (P1)

**Description:** As a workspace member, I never learn the title or content of a deleted doc I had no access to via the activity feed or a notification/mention deep-link.
**Source:** docs/explore/doc-delete-trash.md#exclusion-sweep
**Applies Constraints:** C-002, C-010

**Execution:**
- `depends_on:` S-001, S-004
- `parallel_safe:` false
- `files:` `apps/backend/src/activity/` (read/visibility for `doc_deleted`/`doc_restored` + title enrichment), `apps/backend/src/notify/read-repo.ts` (deep-link routing for deleted docs)
- `autonomous:` true

**Acceptance Scenarios:**

AS-032: A member without prior access does not see a deleted doc's title in activity
- **Given:** a doc that was briefly workspace-shared, then made private, then deleted; and a member who never held a role on it
- **When:** that member opens the workspace activity feed
- **Then:** the `doc_deleted` row (and its title) is not shown to them; a workspace admin and anyone who held a role on it before delete still see it
- **Data:** deleted doc, member with no prior access, plus an admin

AS-033: A deep-link to a deleted doc lands on the gated notice, never raw content
- **Given:** a member was @mentioned in a comment on doc A (notification deep-link with an annotation anchor); doc A is then deleted
- **When:** the member clicks the notification deep-link
- **Then:** they are routed through the gated viewer and see the deleted notice (if they had access, per S-004) or the standard not-found (if not) — never the raw annotation/version content
- **Data:** deleted doc A, notification deep-link with `#anno-id`

### S-007: Permanently delete a doc from Trash (P2)

**Description:** As a doc owner or workspace admin, I can permanently delete a doc from Trash so its data is truly removed from the box — the escape hatch a self-hosted, own-your-data product needs (e.g. to honor a "remove my data" request). Auto-purge and a scheduled job remain out of scope; this is a manual, single-doc, double-confirmed action.
**Source:** /mf-challenge 2026-06-25 (M-4)
**Applies Constraints:** C-003 (gate), C-007 (workspace scoping)

**Execution:**
- `depends_on:` S-003
- `parallel_safe:` false
- `files:` `apps/backend/src/routes/docs.ts` (hard-delete route, workspace-scoped), `apps/backend/src/workspace/doc-delete.ts` (purge service — cascade versions/annotations/comments/share_links), `apps/web/src/features/docs/components/trash-screen.tsx` (Delete-forever action + second confirm)
- `autonomous:` checkpoint

**Acceptance Scenarios:**

AS-034: Owner/admin permanently deletes a doc from Trash
- **Given:** a doc sits in Trash and the actor is its owner or a workspace admin
- **When:** the actor clicks "Delete forever" and confirms the second dialog
- **Then:** the doc row and its versions, annotations, comments, and share_links are removed from the database; it is gone from Trash and unrecoverable
- **Data:** deleted doc in Trash with versions + annotations, actor = owner or admin

AS-035: A per-doc editor (non-owner) and commenter cannot permanently delete
- **Given:** a doc in Trash; the actor's only grant is per-doc editor (not owner) or commenter
- **When:** the actor attempts "Delete forever"
- **Then:** the action is refused and not offered in the UI; permanent delete is owner-or-admin only (narrower than soft-delete, which also allows editors)
- **Data:** deleted doc in Trash, actor role = editor (non-owner) / commenter

## Constraints & Invariants

C-001: Delete is a soft-delete — versions, annotations, and comments are never removed; a restore recovers the doc with all of them intact (but access state is reset — see C-008). (AS-001, AS-010)
C-002: A soft-deleted doc is not listed or readable on ANY surface; Trash (S-003) is the sole exception.
  - scope: S-002, S-004, S-005
  - surfaces: browse, project-grid, project-count, search, viewer, version-content, annotation-by-id, version-diff, activity/notification deep-link, mcp-list, mcp-pull, mcp-read
  - coverage: browse → AS-006, project-grid → AS-007, project-count → AS-008, search → AS-009, viewer → AS-014/AS-015, version-content + annotation-by-id + version-diff → AS-028, activity/notification deep-link → AS-033, mcp-list → AS-017, mcp-pull → AS-018, mcp-read → AS-019
C-003: Delete and restore are gated on `(per-doc role ∈ {owner, editor})` OR `(workspace role === admin)`; commenter and viewer cannot, on every surface. **Surface difference (intentional):** the admin arm applies on the WEB surface only — the MCP layer resolves no workspace-admin role, so MCP delete/restore are owner-or-editor only (see S-005 MCP gate). (AS-004, AS-016, AS-020, AS-021, AS-030)
C-004: Restore returns the doc to its original project; if that project no longer exists or `project_id` is null, to the **restoring actor's** default project in the doc's `deleted_workspace_id`. (AS-010, AS-011, AS-024)
C-005: A deleted doc's `deleted_workspace_id` (captured at delete time) is the stable Trash-membership and restore-scoping key — Trash membership and restore must not depend on `project_id`, which can be nulled by project deletion. (AS-024)
C-006: Delete and restore are idempotent: delete is `UPDATE … WHERE deleted_at IS NULL`, restore is `UPDATE … WHERE deleted_at IS NOT NULL`; the `doc_deleted`/`doc_restored` activity entry is emitted ONLY when the conditional update changes a row (no double-emit on retry). (AS-022, AS-027)
C-007: Every Trash, restore, and MCP delete/restore path is scoped to the caller's workspace (`deleted_workspace_id` / `ctx.workspaceId`); a doc in another workspace is unreachable (refused as not-found), even for a caller with a qualifying role there. (AS-025, AS-026, AS-029)
C-008: Restore returns the doc **private** — both access axes off (`workspace_role = null`, `link_role = null`) and the capability token rotated; the pre-delete public link does not work until the doc is re-shared. (AS-023, AS-031)
C-009: The `deleted_at IS NULL` read check lives in the single `resolveAccess` chokepoint (returning a distinct `deleted` reason); all id-keyed read paths (viewer, version content, annotation GET, comment POST, version-diff) inherit it rather than re-deriving access. (AS-028)
C-010: The `doc_deleted`/`doc_restored` activity rows are visible only to actors who held a role on the doc at delete time plus workspace admins; title enrichment for a deleted doc must not leak to a member who never had access. Activity/notification/mention deep-links to a deleted doc route through the gated viewer (C-009), never a raw id-keyed read. (AS-032, AS-033)

## UI Notes

- `DeleteDocDialog` *(new — confirm dialog, mirrors the project-delete confirm; warns "this doc and its N annotations move to Trash and can be restored")*
- `TrashScreen` *(new — workspace-scoped Trash page)*
  - `TrashRow`: doc title + deleted-at + `[Restore]` + `[Delete forever]` *(one per deleted doc; deleted-at is null-safe — show "—"/"removed member" if the deleter is unknown)*
  - `[Delete forever]` opens a second confirm (S-007); offered only to owner/admin
  - *empty state when no deleted docs (per AS-013)*
- **Deleted notice — reuse `NoAccessView`** *(existing, `apps/web/src/features/viewer/components/no-access-view.tsx`)*: add a `"deleted"` reason/copy variant; do NOT build a new `DocDeletedNotice` component. Shown only to a viewer who had access (S-004); others get the standard not-found.
- `DocMoreMenu` *(existing — gains a role-gated `Delete` item; reuse, see UI Inventory)*

> Precedence: AS / Constraints > this tree. No prototype URL provided for this feature.

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| `DocMoreMenu` | `apps/web/src/features/docs/components/move-copy-dialog.tsx` | reuse; add a role-gated `Delete` item alongside Share · Move · Copy |
| `doc-card` | `apps/web/src/features/docs/components/doc-card.tsx` | reuse; it already renders the ⋯ menu host |
| project-delete confirm dialog | `apps/web/src/features/docs/components/project-more-menu.tsx` | pattern reference for `DeleteDocDialog` |

### System Impact & Technical Risks

- **Mirror the SHAPE, not the gate — project delete/restore:** `apps/backend/src/workspace/projects.ts` already implements `archiveProject` / `unarchiveProject` / `deleteProject` with a `ProjectRejected` reason taxonomy and route mapping. Reuse that *shape* (reason codes + route mapping). Do NOT copy its gate: project delete is **owner-or-admin with no per-doc role concept**, whereas doc delete additionally grants the per-doc *editor*. The doc gate is net-new — see S-001 § Gate.
- ⚠ **Gate is a composition, not a reuse (risk):** the delete/restore gate is `(resolveAccess(docId).role ∈ {owner, editor})` OR `(workspaceRole === admin)` — it composes two orthogonal resolvers (`apps/backend/src/sharing/resolve-access.ts` `AccessResult.role` + the workspace-role gate). This is new logic with explicit precedence and a null-role case (S-001 § Gate). Note the MCP layer resolves only the per-doc role — there is no workspace-admin resolution over MCP — so the admin arm is web-only (C-003, S-005 § MCP gate).
- **Activity emit exists:** `apps/backend/src/activity/emit.ts` (`emitActivity`) already resolves `workspaceOfDoc`; S-001/S-003 add two event types and two emit call-sites — emitted only when the conditional soft-delete/restore UPDATE changes a row (C-006).
- ⚠ **Locked-enum amendment, forward-only (risk):** adding `doc_deleted`/`doc_restored` extends the set `workspace-activity` C-005 declared as exactly 12 (`activity_type` pgEnum + `ActivityType` union, hand-synced). Both must change in lockstep. **Postgres cannot drop an enum value**, so this migration is one-way: there is no down-migration that removes the values — rollback means redeploying the prior app image against the superset schema, never reverting the migration. Deploy order: the boot migrator must apply the enum members BEFORE any new code path can emit them (migrate-then-serve, which the boot migrator already enforces). A `workspace-activity` Mode-C spec update is owed to amend the locked count.
- ⚠ **Exclusion completeness (risk):** every doc-listing/reading surface must filter `deleted_at IS NULL` (S-002 web surfaces, S-004 viewer, S-005 MCP). A missed surface leaks a deleted doc — C-002's per-surface coverage is the checklist.
- ⚠ **Editor-delete blast radius (accepted):** an editor can soft-delete a doc carrying other reviewers' annotations. Accepted per the explore decision; mitigated by soft-delete + Restore + the confirm dialog + the activity trail.
- **Migration:** the `deleted_at` + `deleted_workspace_id` columns, the `docs_active_idx` partial index, and the enum members ride a new drizzle-kit migration applied by the boot migrator. (No `deleted_by` column — see Data Model.)
- **Performance:** the exclusion filter is a `deleted_at IS NULL` predicate on every doc-list query, backed by the `docs_active_idx` partial index (`where deleted_at is null`) added in the S-001 migration — so active-doc scans never touch tombstones. Soft-delete itself is a single-column write. No SLA/scale numbers were quantified in discovery — none are blocking.

## Not in Scope

- **Doc archive** (the lighter "shelve, link still works" tier) — dropped; one tier only. Revisit if a still-shareable shelved state is needed.
- **Auto-purge after N days / scheduled hard-delete job** — deferred; no cron/job is introduced. (Manual, single-doc permanent delete IS in scope — S-007 — so a self-hoster has a data-removal escape hatch; only the *automatic* purge is out.)
- **Bulk / multi-select delete** — single-doc delete only.
- **Notifying reviewers/commenters when a doc they engaged with is deleted** — only the activity-log entry is written (no notification fan-out).
- **Trash per project** — Trash is workspace-scoped, one page per workspace.

## Clarifications — 2026-06-25

From `docs/explore/doc-delete-trash.md` decision-rationale + assumptions (carried, not re-asked):

- One tier (Delete→Trash), not Archive+Delete — user found archive-vs-delete redundant for docs.
- Soft-delete kept forever; no permanent-delete button and no auto-purge in v0.
- Delete + restore allowed for owner + per-doc editor + workspace admin (broader grant chosen knowingly; risk flagged).
- Trash is workspace-scoped; restore returns to original project else the default project.
- A deleted doc's link shows a deleted-notice page (not a bare 404) — but only to a viewer who had access; visitors with no prior access get the standard existence-hiding not-found (revised by /mf-challenge 2026-06-25 to preserve existence-hiding; supersedes the original "same content for member and guest").
- MCP gets both `delete_document` and `restore_document` (soft-delete + restore), gated owner-or-editor (revised by /mf-challenge 2026-06-25 for delete/restore symmetry; supersedes the original "restore stays UI-only").
- Deleting/restoring logs `doc_deleted`/`doc_restored` workspace-activity events.

## Gaps

GAP-001 (status: resolved → AS-016): The `delete_document` MCP tool accepts EITHER the doc slug OR its id (resolve by whichever is supplied). Resolved 2026-06-25. Source: docs/explore/doc-delete-trash.md#open-questions.
GAP-002 (status: resolved → S-004, REVISED 2026-06-25): The deleted-notice page is shown only to a viewer who had access to the doc; visitors with no prior access get the standard existence-hiding not-found (the notice must not be a slug-enumeration oracle). Restore is only from Trash, no inline Restore on the notice. (The original resolution — "plain notice for everyone, member and guest" — was reversed by /mf-challenge to preserve the codebase's existence-hiding invariant.) Source: docs/explore/doc-delete-trash.md#open-questions + /mf-challenge 2026-06-25.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-25 | Initial creation (from docs/explore/doc-delete-trash.md) | -- |
| 2026-06-25 | GAP-001 resolved → MCP delete accepts slug or id (AS-016); GAP-002 resolved → plain deleted-notice for all (S-004) | -- |
| 2026-06-25 | /mf-challenge: 14 findings applied. Critical — deleted_at check moved into the single `resolveAccess` chokepoint to cover version/annotation/diff read paths (C-009, AS-028); composed delete gate spelled out as net-new, not "mirror project" (S-001 § Gate, AS-021); MCP delete given a cross-tenant workspace-binding + owner-or-editor scope (C-007, S-005, AS-029/AS-030); Trash + restore workspace-scoped (C-007, AS-025/AS-026); slug invariant reworded (random-suffix → no collision). High — restore returns private + token rotated (C-008, AS-023, AS-031); `deleted_workspace_id` added + `deleted_by` dropped + restorer-default fallback (C-004/C-005, AS-011/AS-024); deleted-notice gated on prior access + reuse `NoAccessView` (S-004, AS-014/AS-015); delete/restore idempotency + emit-on-change (C-006, AS-022/AS-027); enum amendment marked forward-only with deploy order (System Impact); MCP `restore_document` added for symmetry (S-005, AS-031). Medium — activity/deep-link leak closed (C-010, S-006, AS-032/AS-033); MCP refusal AS (AS-030); partial index `docs_active_idx` added to migration (M-3); manual permanent-delete from Trash (S-007, AS-034/AS-035). | -- |
