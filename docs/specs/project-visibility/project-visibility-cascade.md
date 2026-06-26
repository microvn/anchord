# Spec: Project Visibility — Make-Private Cascade

**Created:** 2026-06-26
**Last updated:** 2026-06-26
**Status:** Draft

## Overview

A phase-2 addition to `project-visibility` (parent spec). When an owner makes a project **private**
(public→private only), the confirm dialog now offers a CHOICE: (1) cascade — make the project AND
every doc in it private, or (2) keep docs shared — the parent spec's existing behaviour (only the
project shell changes; existing docs keep their access). The cascade revokes the workspace-wide and
public-link grants on every doc in the project but preserves per-user specific invites, and it is
irreversible — the dialog discloses this before applying. Sub-spec of `project-visibility`; reuses
its `canViewProject`, `setProjectVisibility`, and the two-axis `share_links` model
(`doc-access-two-axis`). Local S/AS numbering.

## Data Model

No new entities. The cascade is a bulk write over existing rows: for each doc in the project it sets
`share_links.workspace_role = null` AND `share_links.link_role = null` (the doc becomes restricted,
`{null, null}`). It does NOT write `doc_members` (the per-user specific-invite table) and does NOT
write any history of the prior roles (hence irreversible). `projects.visibility` flips to private in
the SAME operation. See parent `project-visibility` Data Model + `doc-access-two-axis` for the
two-axis model.

## Stories

### S-001: Make-private offers cascade vs keep-shared (P1)

**Description:** As a project owner making a public project private, I choose whether to also make all
its docs private (cascade) or to only change the project and keep the docs shared; the cascade revokes
the workspace + public-link grants on every doc in the project but keeps people I invited
specifically, and the dialog warns me the cascade can't be undone.
**Source:** User dogfood request 2026-06-26 — "khi click make private, alertdialog hiện ra với 2 tùy chọn: 1. chuyển toàn bộ về private cả project+doc; 2. giữ nguyên doc-share, chỉ đổi private project." Supersedes the absolute in `project-visibility:AS-014` / `:C-008` (toggle never changes existing docs) for the public→private direction.
**Applies Constraints:** C-001

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/backend/src/workspace/projects.ts` (setProjectVisibility — accept a cascade flag on public→private), `apps/backend/src/workspace/repo.ts` (bulk-null `share_links.workspace_role` + `link_role` for every doc in a project — leaving `doc_members` untouched), `apps/backend/src/routes/projects.ts` (route accepts the cascade choice), `apps/web/src/features/docs/components/project-visibility-toggle.tsx` (2-option dialog on make-private + irreversibility warning)
- `autonomous:` checkpoint
- `verify:` make a public project (with one workspace-shared doc, one public-link doc, one specifically-invited reviewer) private with cascade → the two share_links axes are null on every doc; the specific reviewer still has access; re-opening public does not restore the old roles; the dialog showed an irreversibility warning; the keep-shared choice leaves all docs unchanged; private→public shows no cascade option.

**Acceptance Scenarios:**

AS-001: Cascade makes every doc in the project private
- **Given:** an owner of a public project containing a doc shared with the workspace (workspace=commenter) and a doc with a public link (link=commenter)
- **When:** the owner makes the project private and chooses "make the project and all its docs private" (cascade)
- **Then:** the project becomes private AND every doc in it becomes restricted — both its workspace grant and its public-link grant are removed, so a workspace member with no specific invite and an anonymous link-holder can no longer open it
- **Data:** 2 docs (one workspace-shared, one public-link) → after cascade both are restricted ({none, none}); project private
- **Setup:** owner on the project's settings / ⋯ menu, project currently public

AS-002: Cascade preserves people invited specifically
- **Given:** a public project whose doc D has a specific per-user invite for reviewer R (commenter) in addition to a public link
- **When:** the owner makes the project private with cascade
- **Then:** D's public-link and workspace grants are removed, but R keeps commenter access to D — specific invites are never revoked by the cascade
- **Data:** doc D with {link=commenter} + invite(R=commenter) → after cascade {none, none} but R still commenter
- **Setup:** R is a per-doc invited member, not a workspace-wide or link grant

AS-003: The cascade choice warns it cannot be undone
- **Given:** an owner making a public project private
- **When:** the make-private dialog opens
- **Then:** it offers the two choices (cascade vs keep-shared) and the cascade choice carries a clear warning that revoking the docs' sharing cannot be undone — making the project public again later does NOT restore the docs' previous access
- **Data:** dialog shows both options + an irreversibility notice on the cascade option
- **Setup:** public project, owner

AS-004: Keep-shared changes only the project; private→public never cascades (guard)
- **Given:** an owner making a public project private who chooses "only change the project (keep docs shared)" — and, separately, an owner making a private project public
- **When:** each action is confirmed
- **Then:** the keep-shared choice leaves every doc's access untouched (the parent `project-visibility:AS-014` behaviour); and the private→public dialog never offers a cascade and never changes any doc's access
- **Data:** keep-shared → docs unchanged; private→public → no cascade option shown, docs unchanged

## Constraints & Invariants

- C-001: The make-private cascade applies to **public→private only**. When chosen, it bulk-resets
  every doc in the project to `{workspace_role: null, link_role: null}`; it NEVER writes `doc_members`,
  so per-user specific invites survive. It stores no prior-role history → it is IRREVERSIBLE, and the
  confirm dialog MUST disclose this before applying. The keep-shared choice (and every private→public
  change) touches no `share_links` row — that is the parent `project-visibility:C-008` behaviour,
  preserved as the default/other branch. (AS-001, AS-002, AS-003, AS-004)

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| `ProjectVisibilityToggle` (make-private/public confirm) | `apps/web/src/features/docs/components/project-visibility-toggle.tsx` | reuse; replace the single confirm with a 2-option dialog on the public→private direction + an irreversibility warning on the cascade option |
| `ConfirmDialog` | `apps/web/src/components/confirm-dialog.tsx` | reuse as the dialog shell (or extend for the 2-option layout) |

### System Impact & Technical Risks

- `setProjectVisibility` (`apps/backend/src/workspace/projects.ts`) + `repo.setVisibility`
  (`apps/backend/src/workspace/repo.ts`) currently flip ONLY `projects.visibility` and explicitly do
  NOT touch `share_links` (parent C-008). This story adds an OPTIONAL cascade path that bulk-nulls the
  two `share_links` axes for the project's docs — a multi-row, irreversible mutation → `checkpoint`.
- `resolveAccess` / `resolveDocRole` are UNCHANGED: a doc reset to `{null, null}` with no `doc_members`
  invite is already denied by the existing gate; a surviving `doc_members` invite still grants access.
  So the cascade needs no read-path change — only the bulk write.
- The bulk-null must scope strictly to the one project's docs and skip `doc_members` — a too-wide
  delete (e.g. touching invites, or other projects) is the main risk; the verify asserts the specific
  reviewer survives.

## Not in Scope

- **Undo / restore of cascaded shares** — the cascade is one-way by decision (no prior-role history
  stored); a future "restore" would need a separate audit/history design.
- **Cascade on private→public** (auto-publishing all docs) — deliberately excluded (over-share risk).
- **Per-doc opt-out within the cascade** — the cascade is all-or-nothing for the project; granular
  selection is out of scope.
- **Default-project carve-out** — none here; the default project cascades like any other (parent
  carve-out applies only to NEW-doc derivation, not to this toggle).

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-26 | Initial creation — make-private cascade option (sub-spec of project-visibility; the parent was at the 30-AS hard cap, so the cascade lands here) | dogfood |
