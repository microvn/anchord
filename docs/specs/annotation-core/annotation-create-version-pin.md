# Spec: Annotation-create version pin (optimistic concurrency)

**Created:** 2026-06-20
**Last updated:** 2026-06-20
**Status:** Draft

> Sub-spec of `annotation-core` (the create story is `annotation-core:S-001`). Split out because
> `annotation-core.md` is AT its 30-AS hard cap — per its Sizing Notes, any further AS forces a split.
> This sub-spec is self-contained; its IDs are local (S-001, AS-001…).

## Overview

Today an annotation is created with NO awareness of which doc version its anchor was composed against
(`annotation-core:S-001` accepts the anchor verbatim; only re-attach and suggestion-accept validate
against the current version). With the MCP `anchord_patch_document` tool an agent now bumps a doc's
version frequently and out-of-band, so the window "the browser is showing V0 while the server is at V1"
is wider — and a create made on stale V0 content silently anchors against V1 (best case orphaned, worst
case fuzzy-mis-anchored onto a coincidental match). This sub-spec closes that with an OPTIONAL
`expectedVersion` on annotation create: when sent, the create succeeds only if the doc is still at that
version; otherwise it is refused and the client re-reads. Omitting it preserves today's behavior, so
guest/older API clients never break. Together with the viewer's focus-refetch this gives a complete
**pull-based** staleness story for v0 (no realtime push needed).

## Data Model

No schema change. The annotation stays **doc-scoped** (no `version_id` column) — `expectedVersion` is a
transient concurrency token compared at create time and then discarded, NOT stored on the annotation.
The "current version" compared against is the doc's current `doc_versions.version` (the same number the
viewer read and the patch tool pins on).

## Stories

### S-001: Pin an annotation create to the doc version it was composed against (P0)

**Description:** As a client (the viewer, or an API caller) creating an annotation, I may send the doc
version I composed the anchor against; if a newer version has since landed (e.g. an agent patched the
doc), the create is refused so I re-read instead of anchoring against stale content. Omitting the
version keeps today's behavior. On a refusal the viewer reloads the doc + annotations and tells me, so
I redo the annotation against the current version.
**Source:** Discovered during mcp-patch-document review (stale-version annotation-create gap); user
decision 2026-06-20 — "optional expectedVersion on create, stale → refused, omitted preserves current
behavior". Mirrors `mcp-patch-document:C-003` (patch hard pin) and the existing reattach/suggestion
staleness gates (`annotation-core:AS-024`, `annotation-core:AS-022`).
**Applies Constraints:** C-001, C-002

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` apps/backend/src/routes/annotations.ts, apps/backend/src/annotation/annotation.ts, apps/backend/src/annotation/repo.ts, apps/backend/src/routes/annotations.test.ts (or the route test dir), apps/web/src/features/viewer/components/viewer-screen.tsx, apps/web/src/features/viewer/services/client.ts, apps/web/src/features/viewer/components/viewer-screen.test.tsx
- `autonomous:` true
- `verify:` create an annotation while the doc has advanced a version (e.g. patch it via MCP, don't refetch) → the create is refused with a "doc changed" reason and the viewer reloads; create with a matching version → succeeds.

**Acceptance Scenarios:**

AS-001: Create with a matching version succeeds
- **Given:** a doc at version 4 and a commenter composing an annotation against version 4
- **When:** they create the annotation sending `expectedVersion` = 4
- **Then:** the annotation is created normally (anchor + first comment, atomic per `annotation-core:C-018`), exactly as a create with no version would have
- **Data:** anchor on block-p-3; `expectedVersion` = 4; current version = 4
- **Setup:** commenter+ on the doc

AS-002: Create with a stale version is refused with no write
- **Given:** a doc whose current version is 5 (an agent patched it to 5 after the client rendered version 4)
- **When:** the client creates an annotation sending `expectedVersion` = 4
- **Then:** the create is refused with a "document has changed — re-read before annotating" reason, NEITHER an annotation NOR its first comment is written (no partial), and the response carries the doc's current version (5) so the client can re-read
- **Data:** `expectedVersion` = 4; current version = 5
- **Setup:** commenter+ on the doc

AS-003: Create with no version omitted preserves today's behavior
- **Given:** a doc at version 5 and a client that sends NO `expectedVersion` (a guest UI flow, or an older API caller)
- **When:** they create an annotation
- **Then:** the annotation is created with NO version check applied — behavior identical to before this spec
- **Data:** request body without an `expectedVersion` field
- **Setup:** commenter+ (or guest) on the doc

AS-004: A guest create with a stale version is refused
- **Given:** a doc at version 5 shared anyone-with-link with guest commenting, and a guest who rendered version 4
- **When:** the guest creates an annotation sending `expectedVersion` = 4
- **Then:** the create is refused the same way (the version gate is identity-agnostic — it runs before the guest-name assignment), no annotation/comment written, current version returned
- **Data:** guest (name only) on a link-shared doc; `expectedVersion` = 4; current = 5
- **Setup:** anyone-with-link + guest commenting enabled

AS-005: The viewer sends the version it rendered, and reloads on a stale refusal
- **Given:** the viewer is showing a doc it loaded at version 4, and the doc has since advanced to version 5 server-side (the viewer has not refetched)
- **When:** the user creates an annotation
- **Then:** the create request carries `expectedVersion` = 4 (the version the viewer rendered); on the stale refusal the viewer refetches the doc + annotation list (so the current version 5 + its content show), keeps the user's draft comment, and surfaces a "the document changed — reloaded; please re-select and try again" message (the annotation is NOT silently lost)
- **Data:** rendered version = 4; server version = 5
- **Setup:** the viewer screen with a composed-but-unsaved annotation

## Constraints & Invariants

C-001: Annotation-create optimistic concurrency — when `expectedVersion` is PRESENT, the create
succeeds only if it equals the doc's current version at create time; otherwise the create is refused
with NO write (neither the annotation nor its first comment is persisted — `annotation-core:C-018`
atomicity is preserved because the gate runs before the atomic write). When `expectedVersion` is
ABSENT, no version check is applied (back-compat). This is a LIGHT optimistic check (read current
version, compare), NOT the in-transaction hard pin of `mcp-patch-document:C-003` — create does not
append a version or mutate doc content, so a benign check-then-write race (the doc advances again in
the gap) just means the annotation attaches to the doc and re-anchors at the next publish; it is never
a lost write. (AS-001, AS-002, AS-003)

C-002: On a stale refusal, the response carries the doc's CURRENT version so the client can re-read —
this is the pull-based staleness signal that substitutes for a realtime push on the write path. The
viewer acts on it by refetching the doc + annotations and preserving the user's unsaved draft.
  - scope: S-001
  - surfaces: backend-stale-response, viewer-on-stale
  - coverage: backend-stale-response → AS-002; viewer-on-stale → AS-005

## What Already Exists

### System Impact & Technical Risks

- `apps/backend/src/annotation/annotation.ts` `createAnnotationWithComment` + the create routes in
  `apps/backend/src/routes/annotations.ts` (the doc-scoped `POST /api/docs/:slug/annotations` and the
  workspace-scoped mount, plus the guest path) — **extend**: add an optional `expectedVersion` to the
  request schema and a pre-write version check in the shared create service (so all create entry points
  inherit it from one place). The create today does ZERO version validation (unlike reattach).
- The "current doc version" read — `mcp-patch-document` added a `getCurrentVersion(docId) → { version, content }`
  port (publish-tools-wiring) and the route already has `getCurrentVersionContent`; **reuse** a version
  read rather than adding a new one.
- `mcp-patch-document:C-003` (the patch hard version-pin) — the symmetric prior art; this is its lighter
  read-compare cousin for a non-content-mutating write.
- Existing staleness gates this joins: reattach placement-validate → refusal (`annotation-core:AS-024`),
  suggestion-accept `from`-drift → stale refusal (`annotation-core:AS-022`). Create was the only
  anchor-bearing mutation with no version awareness.
- `apps/web/src/features/viewer/services/client.ts` (the create-annotation request thunk) +
  `viewer-screen.tsx` — **extend**: send the viewer's rendered doc version as `expectedVersion`, and on
  the stale refusal refetch `["viewer-doc", slug]` + `["viewer-annotations", slug]` (the focus-refetch
  wiring from the recent viewer change is the read-path sibling of this write-path guard).

## Not in Scope

- **Placement-validation-on-create when `expectedVersion` is OMITTED** — deferred. A raw API client that
  omits the field stays unguarded (it gets today's behavior). The viewer (incl. guests via the viewer)
  always sends it, so the gap is closed for the real UI; only a hand-rolled client opting out is exposed.
- **Storing a `version_id` on the annotation (version-scoped annotations)** — not needed; annotations
  stay doc-scoped and re-anchor across versions via the existing ledger.
- **Realtime push (WebSocket/SSE) for new versions** — separate, deferred; this + the viewer focus-refetch
  is the pull-based v0 substitute, leaving push as a UX optimization, not a correctness need.
- **Extending the pin to reply / resolve / suggestion-create** — those have their own staleness handling
  (reattach 400-class refusal, suggestion stale refusal); only annotation create was the gap.
- **Making `expectedVersion` mandatory** — kept optional by decision so guest/older clients never break.

## Clarifications — 2026-06-20

- **Light optimistic check, NOT the patch in-tx hard pin.** Create does not append a version or mutate
  doc content, so the version compare is a best-effort read-compare at create time; a benign race (the
  doc advances again between check and write) is harmless (annotation re-anchors at next publish). This
  is deliberately weaker than `mcp-patch-document:C-003`, which must be in-transaction because it writes
  version content. (C-001)
- **`expectedVersion` stays OPTIONAL** (not mandatory) so guest/older API clients never break; the viewer
  always sends it, so the real UI is covered. A raw client omitting it keeps today's unguarded behavior
  (recorded in Not in Scope).
- **FE scope = full slice (confirmed 2026-06-20):** on a stale refusal the viewer reloads doc + annotations,
  PRESERVES the user's unsaved draft comment, and shows a "document changed — reloaded" message (AS-005).
  Chosen over a reload-only / BE-only variant — the reload + draft-preserve is the user-facing payoff that
  makes the write-path staleness guard a complete pull-based substitute for realtime push.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-20 | Initial creation — optional expectedVersion on annotation create (split from annotation-core, which is at the 30-AS hard cap) | mcp-patch-document review; user decision 2026-06-20 |
