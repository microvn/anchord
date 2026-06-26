# Spec: project-visibility-fe

**Created:** 2026-06-26
**Last updated:** 2026-06-26
**Status:** Draft
**Snapshot limit:** 5

## Overview

The frontend half of `project-visibility`. The backend (`project-visibility.md`, S-001..S-007) is
already built and green; it produces the visibility state, the boundary-crossing move refusal, the
suppressed project name, and the publish-access response. This spec builds the UI that **consumes**
those fields: the project-card Private/Public badge + visibility toggle, the picker badges + new-doc
access hint, the doc-move boundary alert that collects the make-private/keep choice, the doc-list
card name suppression, and the publish access notice.

**Ships as a scope-by-layer sibling** of `project-visibility` (the BE producer). It does NOT re-derive
any access or visibility rule — the server is the source of truth; the FE renders what the BE reports
and never computes access itself. Every field this spec reads is a **linked field** pinned to a BE
producer AS, and each carries a real-integration **seam test** (the FE talks to a running BE — never a
mock — because a mocked seam hides exactly the surface/lifecycle mismatch the split risks).

## Stories

### S-001: Project card shows a visibility badge and an owner/admin visibility toggle (P0)

**Description:** As a member browsing Projects, I see whether each project is private or public at a
glance, and as the owner (or an admin of a public project) I can flip its visibility from the card's
menu — with a confirmation that tells me existing shared docs are unaffected.
**Source:** `project-visibility` UI Notes (`ProjectVisibilityBadge`, `VisibilityToggle`) + C-008.
**Applies Constraints:** C-001, C-003

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/web/src/features/projects/components/` (project card + `project-visibility-badge.tsx` + `project-visibility-toggle.tsx`), `apps/web/src/features/projects/services/client.ts`, `apps/web/src/features/projects/hooks/`
- `autonomous:` true
- `verify:` open Projects with one private + one public project → each card shows the correct badge; as owner the ⋯ menu offers Make public/private; as a non-owner non-admin it does not.

**Acceptance Scenarios:**

AS-001: The card shows a Private/Public badge from the list payload
- **Given:** the projects list returns a project with `visibility = private` and one with `visibility = public`
- **When:** the Projects page renders
- **Then:** each card shows a visibility badge (Private vs Public) beside the existing Default badge, read straight from the payload `visibility`
- **Data:** payload `[{name:"Scratch", isDefault:true, visibility:"private"}, {name:"Team", visibility:"public"}]` → "Private" + "Public" badges

AS-002: The owner toggles visibility from the card menu
- **Given:** the signed-in user owns a public project shown on the card
- **When:** they open the ⋯ menu and choose "Make private" and confirm
- **Then:** the visibility-toggle request is sent and, on success, the card's badge updates to Private (the list refetches/optimistically updates)
- **Data:** owner toggles "Team" public → private → badge becomes Private

AS-003: The toggle is offered only where the server allows it (boundary)
- **Given:** a project the viewer does not own
- **When:** the viewer is a non-owner non-admin, then separately a workspace admin viewing a public project
- **Then:** the non-owner non-admin sees no visibility toggle action at all; the admin sees it only on the public project (never on a private project, which they cannot see) — matching what the BE would enforce
- **Data:** non-owner non-admin → no toggle; admin on public "Team" → toggle present

AS-004: The confirmation discloses existing docs are unaffected
- **Given:** the owner has chosen to change a project's visibility
- **When:** the confirmation dialog appears
- **Then:** it discloses that the change affects only docs created afterward and existing shared docs keep their current sharing, before the user commits (C-008 disclosure half)
- **Data:** confirm copy contains the "existing shared docs stay shared" disclosure

AS-005: Seam — the live projects-list payload drives the badge + Default condition
- **Given:** a running backend with the signed-in user owning a private default project and a public project
- **When:** the Projects page fetches the real `GET /api/w/:workspaceId/projects`
- **Then:** the response carries `visibility` and `isDefault` per row and the rendered cards show the correct visibility badge and Default badge from those fields — no mock
- **Data:** real fetch → default project card = Default + Private; "Team" = Public

### S-002: Project pickers show visibility badges and the new-doc access hint (P1)

**Description:** As an author choosing where a new doc goes (or where to move/copy one), each project
option shows its visibility, and the new-doc dialog tells me the access the doc will get.
**Source:** `project-visibility` UI Notes (`NewDocProjectPicker` badge, `NewDocAccessHint`, move/copy picker badge).
**Applies Constraints:** C-001

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/web/src/features/docs/components/new-doc-project-picker.tsx`, `apps/web/src/features/docs/components/new-doc-dialog.tsx`, the move/copy target picker component, `apps/web/src/features/docs/components/`
- `autonomous:` true
- `verify:` open New doc → each project option shows a Private/Public badge; selecting a private project shows a "this doc will be private" hint, a public/default one shows "visible to the workspace".

**Acceptance Scenarios:**

AS-006: Each picker option shows a visibility badge
- **Given:** the new-doc project picker (and the move/copy target picker) lists a private and a public project
- **When:** the picker opens
- **Then:** each option shows a Private/Public badge from its `visibility`
- **Data:** options "Scratch (private)", "Team (public)" → each with its badge

AS-007: The new-doc dialog hints at the resulting access
- **Given:** the new-doc dialog with a project selected
- **When:** the selected project is private (non-default), then public/default
- **Then:** the hint reads "Private project → this doc will be private" for the private one, and "visible to the workspace" for the public/default one (mirrors the BE derivation; the FE only displays it)
- **Data:** select private → "will be private"; select default/public → "visible to the workspace"

AS-008: Seam — the live picker payload carries visibility
- **Given:** a running backend
- **When:** the picker loads its projects from the real list / `GET /docs` projects payload
- **Then:** each option's badge and the new-doc hint render from the real `visibility` field returned by the server — no mock
- **Data:** real fetch → private option badged Private + hint "will be private"

### S-003: Doc-move visibility-boundary alert collects the access choice (P0)

**Description:** As someone moving a shared doc into a private project, I am asked whether to make the
doc private or keep its current sharing — never silently either — and the move proceeds only with my
choice.
**Source:** `project-visibility` UI Notes (`VisibilityBoundaryAlert`) + C-009 (server-enforced choice).
**Applies Constraints:** C-001, C-002

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/web/src/features/docs/components/` (move action + `visibility-boundary-alert.tsx`), `apps/web/src/features/docs/services/client.ts`, `apps/web/src/features/docs/hooks/`
- `autonomous:` true
- `verify:` move a workspace-shared doc into a private project → an alert offers Make private / Keep current sharing / Cancel; choosing one completes the move accordingly; Cancel leaves the doc where it was.

**Acceptance Scenarios:**

AS-009: A boundary-crossing move surfaces the alert
- **Given:** a workspace-shared doc and a private target project
- **When:** the user initiates the move and the server refuses for lack of a choice
- **Then:** the FE shows the VisibilityBoundaryAlert with "Make this doc private", "Keep current sharing", and "Cancel" — it does not retry blindly or pick a default
- **Data:** move shared doc → private project → alert shown, no move yet

AS-010: Choosing make-private completes the move restricted
- **Given:** the alert is shown
- **When:** the user chooses "Make this doc private"
- **Then:** the move is retried carrying the make-private choice and, on success, the doc is in the target project and now private
- **Data:** choose make-private → doc moved + restricted

AS-011: Cancel performs no move (edge)
- **Given:** the alert is shown
- **When:** the user chooses "Cancel"
- **Then:** no move request is sent, the doc stays in its original project, and its sharing is unchanged
- **Data:** cancel → doc unmoved, sharing intact

AS-012: Seam — a live boundary move drives the alert and the choice completes it
- **Given:** a running backend, a real workspace-shared doc, and a real private project
- **When:** the FE issues the real move, receives the server's needs-a-choice refusal, shows the alert, and the user picks "Keep current sharing"
- **Then:** the retry carrying the keep choice succeeds against the real server and the doc is moved with its sharing unchanged — no mock of the refusal
- **Data:** real move → refusal → keep → moved, still workspace-shared

### S-004: The doc-list card suppresses a private project's name for a non-owner (P1)

**Description:** As a member viewing a doc that lives in someone else's private project, I see the doc
(it's shared with me) but not the private project's name.
**Source:** `project-visibility` C-004 + UI Notes (doc-list card name suppression).
**Applies Constraints:** C-001

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/web/src/features/docs/components/doc-card.tsx`, `apps/web/src/features/docs/components/`
- `autonomous:` true
- `verify:` as a non-owner, open the workspace docs grid containing a shared doc that lives in another member's private project → the doc lists but shows no project-name chip.

**Acceptance Scenarios:**

AS-013: The card omits an absent project name without breaking
- **Given:** a doc-list row whose doc is browsable but whose project name the server returned absent (a non-owner's view of a doc in a private project)
- **When:** the card renders
- **Then:** the project-name chip is omitted and the doc still lists normally — no empty chip, no placeholder leak of the private name
- **Data:** row `{title:"Plan", projectName:null}` → card shows "Plan", no project chip

AS-014: Seam — the live workspace-docs payload omits the private project name and the card lists the doc anyway
- **Given:** a running backend, two members, and a shared doc inside member A's private project
- **When:** member B fetches the real workspace docs grid
- **Then:** the response carries the doc with its project name absent and the card renders the doc without a project chip — confirming the soft-private boundary (doc visible, project name gated) end to end, no mock
- **Data:** B's real fetch → doc present, projectName absent, no chip

### S-005: Publish shows the target project and the resulting access (P1)

**Description:** As someone publishing a doc (especially a quick-publish that falls back to the
default project), I am told where the doc landed and who can see it — never a silent surprise.
**Source:** `project-visibility` C-013 + AS-029 + UI Notes (`PublishAccessNotice`).
**Applies Constraints:** C-001

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/web/src/features/docs/components/` (publish flow + `publish-access-notice.tsx`), `apps/web/src/features/docs/services/client.ts`
- `autonomous:` true
- `verify:` publish a doc → a notice shows the target project and the resulting access (e.g. "in Your docs · visible to your workspace").

**Acceptance Scenarios:**

AS-015: The publish notice reports the target project and access
- **Given:** a publish has completed
- **When:** the success notice renders
- **Then:** it names the target project and the resulting access ("in **<project>** · visible to your workspace" for a workspace-shared result, "· private — only you" for a restricted one), read from the publish response
- **Data:** publish into default → "in Your docs · visible to your workspace"; into a private project → "· private — only you"

AS-016: Seam — the live publish response drives the notice
- **Given:** a running backend
- **When:** the FE publishes a real doc into the default project and reads the response
- **Then:** the response's `project` and `access` fields drive the notice text — confirming the agent/quick-publish fallback is never silent, no mock
- **Data:** real publish → response `{project:{name:"Your docs"}, access:"anyone_in_workspace"}` → notice "in Your docs · visible to your workspace"

## Constraints & Invariants

- C-001: All visibility UI (badge, access hint, boundary alert, suppressed name, publish notice)
  renders the state the backend reports — the FE never computes access or visibility itself, never
  guesses a project's visibility, and never shows access the server didn't return. (AS-001, AS-007, AS-013, AS-015)
- C-002: A boundary-crossing move is never submitted without a user-chosen access option; the FE shows
  the alert and waits, and Cancel submits nothing — it never silently makes-private or keeps. (AS-009, AS-010, AS-011)
- C-003: The visibility toggle is offered only where the server would allow it (owner always; admin
  only on a public project); elsewhere the FE hides the action — but this is a UX affordance, not the
  gate (the server still enforces C-008). (AS-003)

## Linked Fields

Consumer side of the scope-by-layer split; producer is `project-visibility` (already built). Each
field carries a real-integration seam AS (above) — never mocked.

- `visibility` (project) — consumed here by **AS-001** (card badge) + **AS-006** (picker badges) on
  the projects-list row + the `GET /docs` projects payload (persisted, served on every list fetch).
  Produced by `project-visibility:AS-015` + `project-visibility:S-003`. ✔ match. Seam: **AS-005**, **AS-008**.
- `isDefault` (project) — consumed here by **AS-001** on the projects-list row. Produced by
  `project-visibility:AS-015`. ✔ match. Seam: **AS-005**.
- `accessChoice` + the needs-choice refusal — consumed here by **AS-009/010/011** (the move alert reads
  the refusal, sends the choice on retry). Produced by `project-visibility:S-005` (C-009 / AS-021,022,023).
  ✔ match. Seam: **AS-012**.
- `projectName` suppressed-to-absent — consumed here by **AS-013** on the doc-list card (served on every
  workspace-docs fetch). Produced by `project-visibility:AS-026`. ✔ match. Seam: **AS-014**.
- `project` + `access` (publish/create response) — consumed here by **AS-015** (publish notice), read
  transiently from the publish response immediately after publish. Produced by `project-visibility:AS-029`.
  ✔ lifecycle match (transient-in-response, consumed at publish time). Seam: **AS-016**.
- viewer-breadcrumb `projectName` — the doc-viewer breadcrumb would consume a gated project name, but
  the BE viewer payload does NOT emit `projectName` today. ✘ not produced → **GAP-001**.

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| New-doc dialog + project picker | `apps/web/src/features/docs/components/new-doc-dialog.tsx`, `new-doc-project-picker.tsx` | reuse; add per-option visibility badge + access hint (S-002) |
| Projects list + Default badge | projects route payload carries `isDefault` + (now) `visibility` | reuse; add visibility badge + ⋯ visibility toggle (S-001) |
| Move/copy target picker | fed by `GET /api/w/:workspaceId/docs` projects payload | reuse; add per-option visibility badge (S-002) |
| Doc-move action | move action + dialog in `features/docs` | reuse; add the boundary alert + accessChoice retry (S-003) |
| Doc-list card | `apps/web/src/features/docs/components/doc-card.tsx` (renders `projectName` truthily) | reuse; already hides an absent name — assert + harden (S-004) |
| Publish flow | publish action + success surface in `features/docs` | reuse; add the publish access notice (S-005) |

### System Impact & Technical Risks

- The BE produces every consumed field already (built S-001..S-007); the risk is a **seam mismatch**,
  which is why every linked field carries a real-integration seam AS rather than a mock.
- `doc-card.tsx` already guards `projectName` truthily, so an absent name hides the chip with no code
  change — S-004 asserts + hardens that path rather than building new suppression.
- The visibility toggle hits the BE `PATCH …/projects/:id/visibility` (built S-003); the FE affordance
  in AS-003 is UX only — the server remains the authority (C-003).
- FE tests must run as `cd apps/web && bun test` (a root run yields bogus window-undefined fails);
  the seam AS additionally need a running backend.

## Not in Scope

- **Viewer-breadcrumb name suppression** — blocked on a BE producer (GAP-001); deferred until the
  viewer payload emits a gated project name. No leak exists there today (no project crumb is rendered).
- **An MCP-side visibility UI** — MCP sets visibility at create only; no toggle tool (matches BE scope).
- **Re-deriving access in the FE** — explicitly rejected (C-001); the server is the source of truth.
- **Changing any BE behaviour** — this is the FE half; BE is built and frozen for this spec.

## Gaps

- GAP-001 (status: open): the doc-viewer breadcrumb would show a private project's name to a non-owner
  of a shared doc, but the BE viewer payload emits no `projectName` to gate — so the FE cannot suppress
  what isn't sent, and there is no leak channel there yet. A BE producer AS (viewer payload carries a
  `projectNameForViewer`-gated name) is owed before the viewer breadcrumb suppression can be built.
  Source: `project-visibility` Linked Fields (viewer-breadcrumb ✘) + the S-006 build note that the
  viewer has no project crumb today.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-26 | Initial creation — FE half of `project-visibility`, recovered after the FE was dropped from the parent spec (UI Notes had components but no FE story/AS). Scope-by-layer sibling; 5 stories, 16 AS, linked-fields + seam tests pinned to the built BE; GAP-001 (viewer breadcrumb) owed a BE producer. | /mf-plan |
