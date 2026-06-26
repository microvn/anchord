# Snapshot: project-visibility-fe
**Date:** 2026-06-26
**Ref:** fe-create-vis
**Reason:** M1 — new vertical-slice story S-005 (create a project with a chosen Public/Private visibility; dialog control + the backend create route/schema that honors it).

---

# Spec: project-visibility-fe

**Created:** 2026-06-26
**Last updated:** 2026-06-26
**Status:** Draft
**Snapshot limit:** 5

## Overview

The frontend half of `project-visibility`. The backend (`project-visibility.md`, S-001..S-007) is
built and green for the read/derive/move/suppress logic; this spec builds the UI that consumes it:
the project-card Private/Public badge + visibility toggle, the picker badges + new-doc access hint,
the doc-move boundary alert that collects the make-private/keep choice, and the publish access notice.

**Prerequisite BE addendum (build FIRST).** A /mf-challenge of this spec found that three fields the
FE needs are NOT yet produced by the built backend. They were added to `project-visibility` as a small
BE addendum (AS-015 `canToggleVisibility`, AS-021 move-refusal `reason`, AS-030 `newDocAccess`) and
**must be built before this FE spec** — every story below consumes at least one. Treat them as the
real `depends_on` of this spec (cross-spec): `project-visibility:AS-015/AS-021/AS-030`.

**Source of truth is the server.** The FE never computes access or visibility itself (C-001): the
toggle affordance reads a server `canToggleVisibility` flag, the access hint displays the server's
`newDocAccess`, the boundary alert keys on a server `reason` discriminator, and the publish access
comes from the publish response. This is a scope-by-layer sibling of `project-visibility`; the field
contracts are pinned in `## Linked Fields`.

**Seam verification — typed-contract + fixture, not a live e2e harness.** The web test stack is
`bun test` + happy-dom only (no Playwright / e2e / running-backend harness). So the cross-layer
guarantee is carried two ways, NOT by five live-backend tests: (1) the hand-maintained FE `ProjectRow`
type mirror is the primary shape guard — NOTE the Eden `App` treaty does NOT statically cover the
projects payload (the projects routes are mounted conditionally and cast to `unknown` in the Eden
client, per `services/client.ts`), so the FE type mirror, not the treaty, is what a dropped/renamed
producer field breaks against; (2) ONE contract assertion against a recorded/typed payload fixture
(pinning the fields via a `Required` pick of the mirror) confirms the fields the FE reads are present
and shaped right, and ONE behavioural integration covers the single genuinely stateful flow (move
refusal → choice → retry). Two seam AS, not five — the rest is the FE type mirror.

## Stories

### S-001: Project card shows a visibility badge and a server-gated visibility toggle (P0)

**Description:** As a member browsing Projects, I see whether each project is private or public, and
where the server says I may change it I can flip its visibility from the card menu — with a
confirmation that existing shared docs are unaffected, and a clean rollback if the change is rejected.
**Source:** `project-visibility` UI Notes (`ProjectVisibilityBadge`, `VisibilityToggle`) + C-008; /mf-challenge C-2/H-1/H-3.
**Applies Constraints:** C-001, C-003

**Execution:**
- `depends_on:` none in THIS spec; cross-spec requires `project-visibility:AS-015` (the `canToggleVisibility` flag) built first
- `parallel_safe:` false
- `files:` `apps/web/src/features/docs/components/projects-screen.tsx`, `apps/web/src/features/docs/components/project-more-menu.tsx`, a new `project-visibility-badge.tsx` + `project-visibility-toggle.tsx` under `apps/web/src/features/docs/components/`, `apps/web/src/features/docs/services/client.ts`, `apps/web/src/features/docs/hooks/`
- `autonomous:` true
- `verify:` open Projects with one private + one public project → each card shows the correct badge; the toggle appears only on rows where the payload's `canToggleVisibility` is true; a rejected toggle rolls the badge back and shows an error.

**Acceptance Scenarios:**

AS-001: The card shows a Private/Public badge from the list payload
- **Given:** the projects list returns a project with `visibility = private` and one with `visibility = public`
- **When:** the Projects page renders
- **Then:** each card shows a visibility badge (Private vs Public) beside the existing Default badge, read straight from the payload `visibility`
- **Data:** payload `[{name:"Scratch", isDefault:true, visibility:"private"}, {name:"Team", visibility:"public"}]` → "Private" + "Public" badges

AS-002: The owner toggles visibility, with an optimistic update reconciled by the authoritative refetch
- **Given:** a project row whose payload `canToggleVisibility` is true, currently public
- **When:** the user chooses "Make private" and confirms
- **Then:** the toggle request is sent, the badge optimistically shows Private, and on success the projects query is invalidated so the authoritative refetch settles the final value; while the request is in flight the toggle is disabled (no concurrent toggles)
- **Data:** owner toggles "Team" public → private → badge Private, list refetched

AS-003: The toggle is rendered only where the server says it is allowed
- **Given:** two rows — one with payload `canToggleVisibility = true`, one with `canToggleVisibility = false`
- **When:** the cards render
- **Then:** the visibility toggle action appears only on the `true` row and is absent on the `false` row — the FE reads the server flag and does NOT re-derive owner/admin/visibility itself
- **Data:** canToggleVisibility true → toggle shown; false → no toggle

AS-004: The confirmation discloses existing docs are unaffected
- **Given:** the user has chosen to change a project's visibility
- **When:** the confirmation dialog appears
- **Then:** it discloses that the change affects only docs created afterward and existing shared docs keep their current sharing, before the user commits (C-008 disclosure half)
- **Data:** confirm copy contains the "existing shared docs stay shared" disclosure

AS-005: A rejected or failed toggle rolls back and surfaces the error (error path)
- **Given:** the user confirmed a toggle but the server rejects it (e.g. a 403 from the C-008 gate, or a transient failure)
- **When:** the response (or network failure) arrives
- **Then:** the optimistic badge rolls back to the project's prior visibility and an inline/toast error is shown — the badge never stays on a value the server didn't accept
- **Data:** toggle → server 403 → badge reverts to public + error shown

AS-006: Seam (contract) — the projects payload carries the fields the card + toggle read
- **Given:** a recorded/typed projects-payload fixture pinned via a `Required` pick of the FE `ProjectRow` mirror (the Eden treaty does NOT cover these conditionally-mounted, `unknown`-cast routes, so the mirror is the shape guard)
- **When:** the payload is asserted against the fixture
- **Then:** each row carries `visibility`, `isDefault`, and `canToggleVisibility` with the right shapes (a dropped/renamed/retyped producer field breaks the `Required` pick at compile time AND this asserts presence + value on the wire) — no full live-backend boot required
- **Data:** fixture row `{visibility, isDefault, canToggleVisibility}` present and typed

### S-002: Project pickers show visibility badges, a server-derived access hint, and the card hides a suppressed name (P1)

**Description:** As an author choosing where a doc goes, each project option shows its visibility and
the new-doc dialog tells me the access the doc will get — taken from the server's derived value, not a
client guess. And a doc in someone else's private project lists without leaking that project's name.
**Source:** `project-visibility` UI Notes (`NewDocProjectPicker` badge, `NewDocAccessHint`) + C-004; /mf-challenge H-4/H-5.
**Applies Constraints:** C-001

**Execution:**
- `depends_on:` none in THIS spec; cross-spec requires `project-visibility:AS-030` (the `newDocAccess` field) built first
- `parallel_safe:` false
- `files:` `apps/web/src/features/docs/components/new-doc-project-picker.tsx`, `new-doc-dialog.tsx`, the move/copy target picker component, `apps/web/src/features/docs/components/doc-card.tsx`
- `autonomous:` true
- `verify:` open New doc → each option shows a Private/Public badge and the hint reflects the option's server `newDocAccess`; a doc whose payload `projectName` is absent lists with no project chip.

**Acceptance Scenarios:**

AS-007: Each picker option shows a visibility badge
- **Given:** the new-doc project picker (and the move/copy target picker) lists a private and a public project
- **When:** the picker opens
- **Then:** each option shows a Private/Public badge from its `visibility`
- **Data:** options "Scratch (private)", "Team (public)" → each with its badge

AS-008: The new-doc hint DISPLAYS the server-derived access (carve-out included)
- **Given:** the new-doc dialog with a project selected, the picker payload carrying each project's `newDocAccess`
- **When:** the selected project is a non-default private one, then the member's default (private-shell) project
- **Then:** the hint shows "this doc will be private" for the non-default private project and "visible to your workspace" for the default project — read from the option's `newDocAccess`, NOT recomputed in the FE; the default-project carve-out is therefore honored automatically
- **Data:** newDocAccess "restricted" → "will be private"; newDocAccess "anyone_in_workspace" (default project) → "visible to your workspace"

AS-009: The doc-list card omits an absent project name (regression guard, folded from the BE suppression)
- **Given:** a doc-list row whose doc is browsable but whose `projectName` the server returned absent (a non-owner's view of a doc in a private project, suppressed by `project-visibility:AS-026`)
- **When:** the card renders
- **Then:** the project-name chip is omitted and the doc still lists normally — no empty chip, no placeholder leak (the existing `doc-card` truthy guard already does this; this asserts it does not regress)
- **Data:** row `{title:"Plan", projectName:null}` → card shows "Plan", no project chip

### S-003: Doc-move visibility-boundary alert keyed on a server discriminator, with defined retry outcomes (P0)

**Description:** As someone moving a shared doc into a private project, I am asked to make it private
or keep its sharing — triggered by a precise server signal, never a guessed 409 — and every retry
outcome (success, no-longer-crossing, terminal error) is handled, never a silent over-share.
**Source:** `project-visibility` UI Notes (`VisibilityBoundaryAlert`) + C-009; /mf-challenge C-1/H-2/M-2.
**Applies Constraints:** C-001, C-002

**Execution:**
- `depends_on:` none in THIS spec; cross-spec requires `project-visibility:AS-021` (the move-refusal `reason` discriminator) built first
- `parallel_safe:` false
- `files:` `apps/web/src/features/docs/components/` (move action + `visibility-boundary-alert.tsx`), `apps/web/src/features/docs/services/client.ts`, `apps/web/src/features/docs/hooks/`
- `autonomous:` true
- `verify:` move a workspace-shared doc into a private project → the alert appears (keyed on reason="visibility_boundary"); a non-boundary 409 does not; make-private completes restricted; a target that flips public mid-flow reconciles to the real access; a 404/403 retry closes the alert with an error and no loop.

**Acceptance Scenarios:**

AS-010: A boundary-crossing refusal opens the alert; Cancel sends nothing
- **Given:** a workspace-shared doc and a private target project
- **When:** the move is refused with `reason = "visibility_boundary"`
- **Then:** the FE shows the VisibilityBoundaryAlert ("Make this doc private" / "Keep current sharing" / "Cancel"); choosing Cancel sends no further request and leaves the doc and its sharing unchanged
- **Data:** move shared → private, refusal reason=visibility_boundary → alert; Cancel → nothing sent

AS-011: A non-boundary conflict does NOT open the alert (boundary)
- **Given:** a move that the server refuses for a DIFFERENT reason (a conflict whose `reason` is not "visibility_boundary")
- **When:** the FE receives the refusal
- **Then:** the visibility-boundary alert is NOT shown; the FE surfaces a generic error instead — the trigger is the reason discriminator, never the bare HTTP status
- **Data:** move refused with a non-visibility reason → no boundary alert

AS-012: Choosing make-private completes the move restricted
- **Given:** the alert is shown
- **When:** the user chooses "Make this doc private"
- **Then:** the move is retried carrying the make-private choice and, on success, the doc is in the target project and now private
- **Data:** choose make-private → doc moved + restricted

AS-013: A retry that fails terminally closes the alert with an error, no loop (error path)
- **Given:** the alert is shown and, between refusal and choice, the target became unviewable or gone
- **When:** the retry carrying the choice is refused (not-found / forbidden)
- **Then:** the FE surfaces the error and dismisses the alert — it does NOT silently re-arm the alert or loop
- **Data:** retry → 404/403 → error shown, alert closed, no re-loop

AS-014: A retry that no longer crosses reconciles the real access, never asserts blindly (error/edge)
- **Given:** the user chose "Make this doc private", but the target project was toggled PUBLIC before the retry (so the server no longer treats the move as boundary-crossing and applies a plain move)
- **When:** the retry returns success
- **Then:** the FE reconciles the doc's ACTUAL resulting access from the response/refetch and reflects that — it must NOT report "now private" when the doc was in fact moved still-shared; if the outcome diverges from the user's choice, the FE surfaces that (re-prompt or notice), never a false "private" confirmation
- **Data:** target flipped public → retry 200 plain move → FE shows actual (still workspace-shared), not a false "private"

AS-015: Seam (behavioural integration) — a real refusal → choice → retry roundtrip
- **Given:** a running backend, a real workspace-shared doc, and a real private project
- **When:** the FE issues the real move, receives the `reason="visibility_boundary"` refusal, shows the alert, and the user picks "Keep current sharing"
- **Then:** the retry carrying the keep choice succeeds against the real server and the doc is moved with its sharing unchanged — this is the one genuinely stateful seam (server re-evaluates the boundary), kept as a real integration rather than a fixture
- **Data:** real move → refusal → keep → moved, still workspace-shared

### S-004: Publish shows the target project and the resulting access, null-safe (P1)

**Description:** As someone publishing a doc (especially a quick-publish that falls back to the
default project), I am told where the doc landed and who can see it — and the notice never breaks when
the response carries no project or no name.
**Source:** `project-visibility` C-013 + AS-029 + UI Notes (`PublishAccessNotice`); /mf-challenge M-1.
**Applies Constraints:** C-001

**Execution:**
- `depends_on:` none in THIS spec; consumes the already-built `project-visibility:AS-029` publish response
- `parallel_safe:` false
- `files:` `apps/web/src/features/docs/components/` (publish flow + `publish-access-notice.tsx`), `apps/web/src/features/docs/services/client.ts` (extend the publish result type with `project` + `access`)
- `autonomous:` true
- `verify:` publish a doc → a notice shows the target project and the resulting access; publish where the response project is null → the notice shows access only, no blank "in ****" and no crash.

**Acceptance Scenarios:**

AS-016: The publish notice reports the target project and access
- **Given:** a publish has completed and the response carries a non-null `project` + `access`
- **When:** the success notice renders
- **Then:** it names the target project and the resulting access ("in **<project>** · visible to your workspace" for a workspace-shared result, "· private — only you" for a restricted one), read from the publish response
- **Data:** publish into default → response `{project:{name:"Your docs"}, access:"anyone_in_workspace"}` → "in Your docs · visible to your workspace"

AS-017: The notice is null-safe when project or access is absent (error/edge)
- **Given:** a publish whose response has `project = null` (or `project.name = null`, or an unrecognized `access`)
- **When:** the notice renders
- **Then:** it omits the "in **<project>**" clause (rather than rendering "in ****" or dereferencing null), shows the access clause when present, and never crashes the success surface
- **Data:** response `{project:null, access:"restricted"}` → "· private — only you", no project clause, no crash

## Constraints & Invariants

- C-001: All visibility UI (badge, access hint, boundary alert, suppressed name, publish notice)
  renders state the backend reports — the FE never computes access or visibility itself: the toggle
  reads `canToggleVisibility`, the hint reads `newDocAccess`, the boundary trigger reads `reason`, the
  notice reads `project`/`access`. No client-side replica of any server rule. (AS-001, AS-003, AS-008, AS-016)
- C-002: A boundary-crossing move is never submitted without a user-chosen access option; the FE shows
  the alert only on the `reason="visibility_boundary"` discriminator (never on a bare 409), Cancel
  submits nothing, and a retry whose outcome diverges from the choice is reconciled, never falsely
  confirmed. (AS-010, AS-011, AS-012, AS-013, AS-014)
- C-003: The visibility toggle is rendered iff the server's per-row `canToggleVisibility` is true; the
  FE does not re-derive the owner/admin/public gate (that lives only in the BE, C-008). A rejected
  toggle still rolls back — the flag is an affordance, the server is the authority. (AS-003, AS-005)

## Linked Fields

Consumer side of the scope-by-layer split; producer is `project-visibility` (built, incl. the three
be-addendum producers `canToggleVisibility`, `newDocAccess`, the move `reason`). Shape is guarded by
the hand-maintained FE `ProjectRow` type mirror (the Eden `App` treaty does NOT statically cover the
projects payload — conditionally-mounted routes cast to `unknown`); the seam AS (AS-006 contract,
AS-015 behavioural) cover presence/value + the one stateful flow.

- `visibility` (project) — consumed by **AS-001** (card badge) + **AS-007** (picker badges) on the
  projects-list row + `GET /docs` projects payload. Produced by `project-visibility:AS-015` + `:S-003`.
  ✔ match. Seam: AS-006.
- `isDefault` (project) — consumed by **AS-001** on the projects-list row. Produced by
  `project-visibility:AS-015`. ✔ match. Seam: AS-006.
- `canToggleVisibility` (project) — consumed by **AS-002/003** to render the toggle (no client gate
  re-derivation). Produced by `project-visibility:AS-015` (be-addendum). ✔ match. Seam: AS-006.
- `newDocAccess` (project) — consumed by **AS-008** for the access hint (server-derived, carve-out
  applied). Produced by `project-visibility:AS-030` (be-addendum) on the picker payload. ✔ match. Seam: AS-006.
- `projectName` suppressed-to-absent — consumed by **AS-009** on the doc-list card. Produced by
  `project-visibility:AS-026`. ✔ match (the existing card guard already hides null). Seam: AS-006 (asserts absent).
- move-refusal `reason: "visibility_boundary"` + `accessChoice` — consumed by **AS-010..014** (the
  alert keys on the reason; the choice is sent on retry). Produced by `project-visibility:AS-021`
  (be-addendum) / C-009. ✔ match. Seam: AS-015 (the stateful roundtrip).
- `project` + `access` (publish response) — consumed by **AS-016** (publish notice), read transiently
  from the publish response immediately after publish; `project` and `project.name` are NULLABLE and
  handled (AS-017). Produced by `project-visibility:AS-029`. ✔ lifecycle match.
- viewer-breadcrumb `projectName` — NOT produced (the viewer payload emits no project name, no crumb is
  rendered). ✘ → GAP-001 (no leak channel exists today; out of scope).

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| Projects screen + cards | `apps/web/src/features/docs/components/projects-screen.tsx`, `project-more-menu.tsx` | reuse; add the visibility badge + the ⋯ visibility toggle here (S-001) — NOT a new `features/projects/` tree |
| New-doc dialog + project picker | `apps/web/src/features/docs/components/new-doc-dialog.tsx`, `new-doc-project-picker.tsx` | reuse; add per-option badge + the server-derived access hint (S-002) |
| Move/copy target picker | fed by `GET /api/w/:workspaceId/docs` projects payload | reuse; add per-option visibility badge (S-002) |
| Doc-move action | move action + dialog in `features/docs` | reuse; add the boundary alert keyed on `reason`, with retry outcomes (S-003) |
| Doc-list card | `apps/web/src/features/docs/components/doc-card.tsx` (already guards `projectName` truthily) | reuse as-is; S-002/AS-009 is a regression assertion, NOT new suppression code |
| Publish flow | publish action + success surface in `features/docs` | reuse; add the null-safe publish access notice (S-004) |

### System Impact & Technical Risks

- **The BE is NOT fully frozen.** Three consumed fields (`canToggleVisibility`, `newDocAccess`, the
  move `reason`) are a small BE build added by the be-addendum (`project-visibility` AS-015/021/030) and
  must ship before this FE spec. Until then S-001/S-002/S-003 cannot render correctly.
- **No live-backend FE harness exists** (happy-dom only). The seam guarantee is the Eden type (compile)
  + one contract fixture (AS-006) + one behavioural integration (AS-015) — not five live tests.
- `doc-card.tsx` already hides a falsy `projectName`, so S-002/AS-009 builds no production code — it is
  a regression guard for an existing behaviour, folded in after the standalone S-004 (name-suppression)
  story was cut as a no-op.
- FE tests must run as `cd apps/web && bun test` (a root run yields bogus window-undefined fails).

## Not in Scope

- **Viewer-breadcrumb name suppression** — blocked on a BE producer (GAP-001); deferred. No leak exists
  there today (no project crumb is rendered).
- **A standalone doc-card name-suppression story** — cut: the existing card already hides an absent
  name; folded into S-002/AS-009 as a one-line regression assertion.
- **Re-deriving access/visibility/affordance in the FE** — rejected (C-001/C-003); the server produces
  `canToggleVisibility`, `newDocAccess`, the move `reason`, and the publish `access`.
- **A live e2e harness (Playwright + compose-up backend)** — not introduced for this feature; the Eden
  type + a contract fixture + one behavioural integration cover the seam at far lower cost.

## Gaps

- GAP-001 (status: deferred): if a project breadcrumb is ever added to the doc viewer, its name must be
  gated for a non-owner of a private project (per `project-visibility` C-004), which requires a BE
  producer AS (the viewer payload emitting a `projectNameForViewer`-gated name). Today the viewer emits
  no project name and renders no crumb, so there is no leak channel and nothing to build. Owner: product
  (only if a viewer project crumb is added). Source: `project-visibility` Linked Fields (viewer-breadcrumb ✘).

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-26 | Initial creation — FE half of `project-visibility`, recovered after the FE was dropped from the parent spec (UI Notes had components but no FE story/AS). 5 stories, 16 AS. | /mf-plan |
| 2026-06-26 | Build correction: the seam shape-guard mechanism was reworded from "the Eden `App` treaty" to "the FE `ProjectRow` type mirror + fixture" — `/mf-build` S-001 found the projects routes are mounted conditionally and cast to `unknown` in the Eden client, so the treaty does not statically cover the payload (the mirror does). AS-006 requirement unchanged; mechanism clarified (Overview, AS-006, Linked Fields). | /mf-build |
| 2026-06-26 | /mf-challenge (snapshot 2026-06-26-fe-pre-challenge): 3 Critical + 5 High + 3 Medium applied. BE not frozen → 3 be-addendum producers consumed (`canToggleVisibility` C-2, `newDocAccess` H-5, move `reason` C-1). Toggle gated on the server flag not client role-math (C-2/C-003). Seam strategy → Eden type + 1 contract fixture + 1 behavioural integration, 5 seams → 2 (C-3). S-001 retargeted to `features/docs/components` (H-1). Added toggle rollback/concurrency/error (H-3), retry terminal + no-longer-crossing reconcile (H-2), publish-notice null-safety (M-1). Cut the no-op name-suppression story → folded to AS-009 (H-4). Merged Cancel into AS-010 (M-2). GAP-001 trimmed to deferred (M-3). Stories 5→4, AS 16→17. | /mf-challenge |
