## Explore: Delete Doc → Trash (soft-delete + restore)
_2026-06-25_

**Feature:** Let an authorized member delete a doc into a per-workspace Trash (soft-delete), and restore it later with all versions and annotations intact. There is currently NO doc delete anywhere — no backend route, no MCP tool, no UI; `docs` has no tombstone column. Projects already have archive + delete; docs have nothing.
**Trigger:** User action — `Delete` from the doc card ⋯ menu (web) and a new MCP `delete_document` tool (agent). `Restore` from a dedicated Trash page (web).
**UI expectation:** Reuse the existing `DocMoreMenu` (⋯) on `doc-card.tsx` (today: Share · Move · Copy → add Delete) + a confirm dialog mirroring the project-delete confirm; a NEW dedicated Trash page per workspace listing deleted docs with Restore.

**Happy path:**
1. Editor/owner/admin opens the workspace doc grid, clicks ⋯ on a doc card → `Delete`.
2. Confirm dialog warns the doc + its N annotations move to Trash and can be restored.
3. On confirm: doc gets a `deleted_at` tombstone, disappears from the grid; toast confirms (Undo optional).
4. Activity logs `doc_deleted` (actor = deleter). The old doc link now shows a "this doc was deleted" notice page (not a bare 404).
5. Later, an authorized user opens the workspace **Trash** page, clicks `Restore` → doc returns to its original project with every version + annotation; activity logs `doc_restored`.

**Decision model (the core forks, resolved):**
- **One tier only: Delete → Trash.** Archive was considered (projects have it) and explicitly dropped for docs — the user only wants delete-with-recovery, not a separate "shelve" state. Do NOT add doc archive.
- **Soft-delete, kept forever.** Delete sets a `deleted_at` tombstone; versions + annotations + comments are NOT removed, just hidden, so Restore brings everything back. **No permanent-delete button and no auto-purge in v0** — soft-deleted docs live in Trash indefinitely.
- A deleted doc's slug is retained (the row stays), so no slug reuse/conflict on restore.

**Business rules:**
- Delete and Restore are allowed for: **doc owner, per-doc editor role, workspace admin** (owner+editor+admin). Commenter / viewer cannot — the Delete item is hidden from their ⋯ menu.
- Delete cascades logically (the doc's versions/annotations/comments all become unreachable while the tombstone is set) but is reversible.
- Restore target: the doc returns to its original `project_id`. If that project no longer exists (FK was set null), the doc falls back to the workspace **Default project**.

**Edge cases:**
- Empty Trash: Trash page shows an empty state ("Nothing in Trash").
- Dead link: opening a deleted doc's `/d/:slug` (or viewer route) → a dedicated "this doc was deleted" notice page, NOT a generic 404.
- Double-delete / already-deleted: deleting an already-deleted doc is a no-op (idempotent on `deleted_at`).
- Concurrent: someone viewing a doc that gets deleted mid-session — next read resolves to the deleted-notice page.
- Restore of a doc whose project vanished → falls back to Default project (see Business rules).

**MCP impact:**
- NEW MCP tool `delete_document` (soft-delete, same authz as web). Restore is **UI-only** in v0 (assumption — see below).
- Existing MCP `list` / `pull` / read tools MUST exclude deleted docs.

**Exclusion sweep (every list must hide deleted docs):**
- Workspace doc browse + project doc grids.
- Project doc **counts** (workspace-project-browse).
- Search (`search.ts` / search-repo).
- MCP list/pull/read tools.
- Activity feed enrichment that references a doc title still resolves (the row exists), but the doc is not "browsable".

**Activity impact:**
- Adds **two new activity types: `doc_deleted`, `doc_restored`.** ⚠ This extends the currently locked set of 12 (`workspace-activity` C-005 / `activity/types.ts` + the `activity_type` pgEnum). The spec must explicitly amend that locked list and the enum (hand-synced) — flag for /mf-plan and likely a workspace-activity spec Mode-C update.

**Data impact:**
- Add `deleted_at timestamptz NULL` (+ likely `deleted_by text` FK to user, set null) to the `docs` table → new migration.
- Extend `activity_type` pgEnum with `doc_deleted`, `doc_restored` (hand-synced with `activity/types.ts`).
- Backfill: none (new nullable columns; existing docs = not deleted).

**Impact on existing system:**
- `docs.ts` (currently POST-only) gains delete + restore routes (web), e.g. `DELETE /api/w/:workspaceId/docs/:slug` and `POST …/docs/:slug/restore`, plus a Trash list endpoint.
- `doc-card.tsx` / `move-copy-dialog.tsx`'s `DocMoreMenu` gains a Delete item (role-gated).
- Viewer/doc-access routing (`viewer-doc.ts`, `resolve-access.ts`, `doc-access-routing`) must treat a tombstoned doc as the deleted-notice state.
- New Trash page + route in `apps/web`.
- MCP read/pull/list tools + new `delete_document` tool.

**Out of scope (explicit):**
- Doc **archive** (the lighter "shelve, link still works" tier) — dropped; one tier only.
- **Permanent delete** / hard-delete-from-DB and **auto-purge** after N days — deferred; Trash is forever in v0.
- MCP **restore** — UI-only for v0 (assumption).
- Bulk delete / multi-select delete.
- Notifying reviewers/commenters when a doc they engaged with is deleted.

**Permissions:**
- Allowed (delete + restore): doc owner, per-doc editor, workspace admin.
- Blocked: commenter, viewer, non-members (Delete item hidden, route refuses).

**Decision rationale:**
- One tier (Delete→Trash) over Archive+Delete: user found archive-vs-delete redundant for docs; only wants delete with recovery. If a "still-shareable shelved" state is later needed, revisit archive.
- Soft-delete kept forever (no purge): simplest safe default for v0; avoids a cron/job. If storage/clutter becomes a problem, add permanent-delete or auto-purge later.
- Editor can delete (not just owner+admin): user chose the broader grant; flagged the risk (an editor can remove other reviewers' annotations from view). Mitigated by soft-delete + Restore. If abuse appears, narrow delete to owner+admin and leave editors archive-only.
- MCP gets delete: parity with the agent-driven publish flow (agents create docs, so they may clean up). Restore stays UI-only to keep a human in the recovery loop.

**Assumptions (need confirmation):**
- MCP `delete_document` only soft-deletes; **restore is UI-only** (no MCP restore tool in v0).
- Delete confirm dialog shows the annotation count ("doc + N annotations will move to Trash").
- Trash is **workspace-scoped** (one Trash page per workspace), not per-project.
- Restore returns the doc to its original project, else Default project.
- No notification is sent on delete/restore (only the activity log entry).

**Open questions:**
- Exact route shapes (`DELETE …/docs/:slug` + `POST …/docs/:slug/restore` + Trash list endpoint) — for /mf-plan to finalize against existing `docs.ts` conventions.
- Does `delete_document` MCP tool key on slug or doc id? (mirror the web route choice.)
- Should the deleted-notice page differ for someone who could restore (offer a Restore link) vs a guest (plain notice)? — default: plain notice for all, Restore only from Trash.

**Complexity signal:** medium
Based on: new schema columns + migration, 2 new locked-enum activity types (touches a locked decision), web routes + Trash page (new screen), MCP tool, and an exclusion sweep across browse/search/counts/MCP. No external integration, no concurrency-critical path.

**Non-functional requirements:**
- Scale: workspace-level doc counts (tens–low thousands); soft-delete is a single column write + filtered reads.
- Performance: deleted-exclusion is an indexed `WHERE deleted_at IS NULL` predicate; consider a partial index if doc lists grow.
- Security/compliance: delete is reversible (no data loss); authz enforced server-side on every route + MCP tool, not just hidden in UI.
- Availability: feature down → docs simply can't be deleted; no impact on viewing/annotating.

**Technical risks:**
- Locked-enum amendment: extending `activity_type` (pgEnum + `activity/types.ts` union, hand-synced) must stay in lockstep or migrations/tests drift.
- Exclusion completeness: every doc-listing surface (browse, project grids, counts, search, MCP list/pull/read) must filter deleted — a missed one leaks a deleted doc. Worth an explicit checklist in the spec.
- Editor-delete blast radius: an editor can soft-delete a doc carrying many reviewers' annotations; mitigated by Restore but worth a confirm dialog + activity trail.
