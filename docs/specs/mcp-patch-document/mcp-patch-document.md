# Spec: MCP Patch-Document (block-addressed edits)

**Created:** 2026-06-20
**Last updated:** 2026-06-20 (rev 2)
**Status:** Draft

## Overview

Give the anchord MCP server a way for an agent to edit a published doc WITHOUT re-emitting
the whole document: a block-addressed, self-verifying patch tool (`anchord_patch_document`),
plus the read-path change that makes blocks addressable, plus deterministic re-anchor carry
so annotations on untouched blocks survive without a fuzzy guess. The measured problem: an
LLM updating a 15.5KB markdown doc spends ~59s of the ~66s wall-clock just decoding the full
`content` argument; the lever is emitting fewer output tokens by sending only `{blockId, find,
replace}`. This is anchord's primary agent workflow (the MCP-revise loop), so it is load-bearing.

This spec covers **Phase 1** only: the patch tool (markdown + html), the read-path block
ids/version, and deterministic-carry re-anchor. The whole-document tool stays as today's
`anchord_update_document` (the fallback when a patch is rejected or the doc was regenerated);
patch is added alongside it. Create-by-reference (`contentPath`) is Phase 2 and deferred (see
Not in Scope). No app UI changes — this is an MCP tool surface + backend.

## Data Model

No new tables. A patch appends an immutable new version through the EXISTING append pipeline
(`appendVersion` / `appendVersionTx`), identical to the whole-doc update path — a patch = a new
version, consistent with the immutable-version model.

- **Doc / Version** (existing): `docs.slug` immutable; `doc_versions.version` int from 1, append-only
  (no overwrite). `read_document` already returns the current `version` number — this IS the pin
  source the agent echoes back as `expectedVersion`.
- **Block id** (existing, render-publish C-009 / annotation-core C-001): positional
  `block-{tag}-{n}` (per-tag sequential counter, document order), injected at render time by
  `injectBlockIds`. A POSITIONAL hint, not a stable key — it can renumber if an interleaved
  publish lands (the reason for the hard version-pin, C-003).
- **Read result shape** (additive change): `read_document` gains a `blocks` array, each entry
  `{ blockId, sourceText }`. The existing `content` field stays (back-compat).
- **One edit primitive, kind-specific source string** (the unifying model): `find`/`replace`/
  `sourceText` ALWAYS operate on the block's SOURCE-LEVEL string — for markdown that string is the
  block's markdown source (sliced from `token.map`), for html it is the block element's `innerHTML`
  (NOT its `textContent`). Editing the innerHTML string and re-parsing preserves inline markup:
  `<p>Hello <b>world</b></p>` → `find: "world", replace: "earth"` → `<p>Hello <b>earth</b></p>`,
  the `<b>` is kept. So patch is ONE primitive across both kinds; only the source string differs.
- **Markdown block → source-span mapping** (the apply mechanism, GAP-001 resolved): per-block
  source ranges are derived from markdown-it `token.map` (each block token carries a
  `[startLine, endLine)` source line range); `read_document` emits each block's `sourceText`
  sliced from that range, and block-id numbering is taken from the SAME token walk so
  `blockId ↔ source-range` is exact (this is also what disambiguates two blocks with identical
  source — e.g. two `## Overview` — by their distinct ranges). A block whose `token.map` range is
  absent (table cells `td`/`th`, raw `html_block`) OR whose token-walk id does not match the
  rendered-HTML id is **non-patchable**: `read_document` OMITS its `sourceText` (AS-023) and a patch
  addressing it is refused (AS-024). Fail-closed — the server never splices a wrong source range (GAP-005).
- **Annotation anchor / `is_orphaned`** (existing, annotation-reanchor): a patch names exactly
  which blocks changed → the changed-block set drives deterministic carry (C-005).

## Stories

### S-001: Read a document's addressable blocks (P0)

**Description:** As an MCP agent, before editing I read a doc and get its blocks as
`{ blockId, sourceText }` plus the current version, so I can address an edit to one block and
pin the patch to the version I read.
**Source:** docs/explore/mcp-patch-document.md#Happy-path (item 1); #Data-impact (read-path companion change)

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` apps/backend/src/mcp/tools/read-tools.ts, apps/backend/src/mcp/tools/read-tools-wiring.ts, apps/backend/src/render/markdown.ts, apps/backend/src/mcp/tools/read-tools.test.ts
- `autonomous:` true
- `verify:` bun test apps/backend/src/mcp/tools/read-tools.test.ts

**Acceptance Scenarios:**

AS-001: Markdown doc read returns per-block source + version + retains content
- **Given:** a readable markdown doc at version 3 whose rendered blocks include `block-h2-1` ("## Overview") and `block-p-1`
- **When:** the agent calls `anchord_read_document(idOrSlug)`
- **Then:** the result includes `version` = 3, a `blocks` array with an entry `{ blockId: "block-h2-1", sourceText: "## Overview" }` (one entry per addressable block with a resolvable source range), AND the existing `content` field is still present unchanged
- **Data:** a 2-heading markdown doc; blocks for `block-h2-1`, `block-p-1`, `block-h2-2`
- **Setup:** doc published via `anchord_create_document`, token has `docs:read`

AS-002: HTML doc read returns per-block source
- **Given:** a readable html doc whose first paragraph block is `block-p-1` with content "Hello world"
- **When:** the agent calls `anchord_read_document(idOrSlug)`
- **Then:** the `blocks` array includes `{ blockId: "block-p-1", sourceText: "Hello world" }` and the current `version`
- **Data:** an html doc with one `<p>` and one `<h1>`
- **Setup:** doc published as html, token has `docs:read`

AS-003: Doc with no addressable blocks returns an empty blocks array
- **Given:** a readable doc whose content has no block-level elements
- **When:** the agent calls `anchord_read_document(idOrSlug)`
- **Then:** `blocks` is an empty array and `version` is still returned
- **Data:** a doc whose content is whitespace / inline-only
- **Setup:** token has `docs:read`

AS-004: Unreadable doc is rejected with no block data leaked
- **Given:** a doc the token-owner cannot access (no role, or in another workspace than the token's)
- **When:** the agent calls `anchord_read_document(idOrSlug)`
- **Then:** the request is refused with "not found or not accessible" and no `blocks`/`sourceText` are returned (auth unchanged from the existing read tool)
- **Data:** a restricted doc in workspace W2; token bound to W1
- **Setup:** token has `docs:read` for W1

AS-023: A non-mappable markdown block is marked non-patchable in the read result
- **Given:** a markdown doc containing a table cell and a raw-html block (neither has a resolvable source range) alongside an addressable heading block
- **When:** the agent calls `anchord_read_document(idOrSlug)`
- **Then:** the heading block's `blocks` entry carries `sourceText`, while the table-cell and raw-html block entries OMIT `sourceText` (the signal that they are non-patchable); all blocks are still listed by `blockId`
- **Data:** md with `## Title`, a `| a | b |` table, and a raw `<div>…</div>` block
- **Setup:** token has `docs:read`

### S-002: Patch a markdown document (P0)

**Description:** As an MCP agent with edit rights, I send a version-pinned set of
`{ blockId, find, replace }` edits and the server splices each `find` to `replace` within the
addressed block's markdown source, appending a new immutable version — without me re-emitting
the whole document. (The patch tool's description steers selection: "edit specific blocks,
faster, preserves annotations"; the whole-doc `anchord_update_document` stays the fallback.)
**Source:** docs/explore/mcp-patch-document.md#Happy-path (items 2-5); #Business-rules (R1, R2, R3, R4, R5); #Permissions
**Applies Constraints:** C-001, C-002, C-003, C-004, C-006, C-008

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` apps/backend/src/mcp/tools/publish-tools.ts, apps/backend/src/mcp/tools/publish-tools-wiring.ts, apps/backend/src/mcp/sdk-server.ts, apps/backend/src/annotation/block-id.ts, apps/backend/src/render/markdown.ts, apps/backend/src/mcp/tools/publish-tools.test.ts
- `autonomous:` true
- `verify:` bun test apps/backend/src/mcp/tools/publish-tools.test.ts

**Acceptance Scenarios:**

AS-005: Single-block edit splices and appends a new version
- **Given:** a markdown doc at version 5 with block `block-h2-1` whose source is "## Overview"
- **When:** the agent calls `anchord_patch_document({ docId, expectedVersion: 5, edits: [{ blockId: "block-h2-1", find: "## Overview", replace: "## Overview1" }] })`
- **Then:** block `block-h2-1`'s source becomes "## Overview1", a new version 6 is appended (the previous version is unchanged), the other blocks' positional ids are unchanged, and the tool returns `{ docId, version: 6, previousVersion: 5 }`
- **Data:** doc with `block-h2-1`="## Overview", `block-p-1`, `block-h2-2`
- **Setup:** token has `docs:write` and editor+ on the doc

AS-006: An edit whose find is absent rejects the whole patch
- **Given:** a markdown doc at version 5 where block `block-h2-1` does NOT contain the text "## Summary"
- **When:** the agent patches with `edits: [{ blockId: "block-h2-1", find: "## Summary", replace: "## Recap" }]`
- **Then:** the patch is refused with a find-not-found reason, no new version is appended, and the doc stays at version 5
- **Data:** `find` text that does not occur in the addressed block (also covers a `blockId` that is not in the doc — the find can't be located)
- **Setup:** token has `docs:write` and editor+

AS-007: An edit whose find is ambiguous rejects the whole patch
- **Given:** a markdown doc at version 5 where block `block-p-1` contains the word "draft" twice
- **When:** the agent patches with `edits: [{ blockId: "block-p-1", find: "draft", replace: "final" }]`
- **Then:** the patch is refused with an ambiguous-find reason (find occurs more than once in the block), no new version is appended, and the doc stays at version 5
- **Data:** a block whose source contains the `find` string 2 times
- **Setup:** token has `docs:write` and editor+

AS-008: A multi-edit patch with one bad edit applies none (atomic)
- **Given:** a markdown doc at version 5 with a valid edit (find present, unique) and a second edit whose find is absent
- **When:** the agent patches with both edits in one call
- **Then:** the WHOLE patch is refused, NEITHER edit is applied (no partial write), no new version is appended, and the doc stays at version 5
- **Data:** `edits: [validEdit, editWithAbsentFind]`
- **Setup:** token has `docs:write` and editor+

AS-009: A stale version pin is rejected
- **Given:** a markdown doc whose current version is 6
- **When:** the agent patches with `expectedVersion: 5`
- **Then:** the patch is refused with a version-conflict reason instructing the agent to re-read, no edit is applied, and the doc stays at version 6
- **Data:** `expectedVersion` one behind the current version
- **Setup:** token has `docs:write` and editor+; another publish landed between read and patch

AS-010: An empty edit list is rejected
- **Given:** a markdown doc at version 5
- **When:** the agent patches with `edits: []`
- **Then:** the patch is refused with a "non-empty edits required" reason and no new version is appended
- **Data:** `edits: []`
- **Setup:** token has `docs:write` and editor+

AS-011: A read-only token cannot patch
- **Given:** a markdown doc and a token lacking the `docs:write` scope
- **When:** the agent calls `anchord_patch_document`
- **Then:** the call is refused for the missing `docs:write` scope with NO side effect (no version appended)
- **Data:** token scopes = `docs:read` only
- **Setup:** doc exists; token is read-only

AS-012: A cross-workspace token cannot patch
- **Given:** a doc in workspace W2 and a `docs:write` token bound to workspace W1 (owner is also a W2 member)
- **When:** the agent calls `anchord_patch_document` for the W2 doc
- **Then:** the patch is refused (a W1 token never patches W2 content) and no version is appended
- **Data:** doc in W2; token workspace = W1
- **Setup:** token has `docs:write` for W1

AS-013: A non-editor role cannot patch
- **Given:** a doc on which the token-owner's effective role is commenter (below editor)
- **When:** the agent calls `anchord_patch_document`
- **Then:** the patch is refused for insufficient rights (editor+ required) and no version is appended
- **Data:** token-owner role = commenter
- **Setup:** token has `docs:write`; owner has commenter on the doc

AS-014: A replacement that changes the block set is rejected (structural guard)
- **Given:** a markdown doc at version 5 and an edit whose `replace` would split the addressed block into two blocks (e.g. introduces a blank line / a new heading)
- **When:** the agent patches that block
- **Then:** after applying the edit the server re-renders, detects the ordered block-id sequence changed, refuses the patch with a structural-change reason, appends no new version, and the doc stays at version 5
- **Data:** `replace` text containing a block-creating boundary (blank line + new paragraph, or a `#` heading)
- **Setup:** token has `docs:write` and editor+

AS-024: A patch addressing a non-patchable block is rejected
- **Given:** a markdown doc where `block-td-1` was returned by `read_document` WITHOUT `sourceText` (non-patchable per AS-023)
- **When:** the agent patches with an edit on `block-td-1`
- **Then:** the patch is refused with a not-patchable reason that directs the agent to `anchord_update_document`, no new version is appended, and the doc is unchanged
- **Data:** an edit whose `blockId` is a non-patchable / unknown block id
- **Setup:** token has `docs:write` and editor+

AS-025: A patch on an image document is refused (out of scope)
- **Given:** an image document (kind = image — its content is a filename/alt, no model-generated body text)
- **When:** the agent calls `anchord_patch_document` on it
- **Then:** the patch is refused with an "image documents cannot be patched" reason directing the agent to `anchord_update_document` (whole-doc), and no new version is appended
- **Data:** a doc with kind = image
- **Setup:** token has `docs:write` and editor+

### S-003: Patch an HTML document (P0)

**Description:** As an MCP agent editing an html doc, my `{ blockId, find, replace }` edit is
applied to the addressed block's `innerHTML` (the same source string `read_document` handed me),
preserving the block's inline markup, appending a new immutable version. The replacement is NOT
re-sanitized — html docs are served raw to the sandbox (render-publish C-002/C-008), so a patch
keeps the agent's markup verbatim exactly as a whole-doc publish would; well-formedness is enforced
by the structural guard (C-008), and XSS stays contained by sandbox-origin isolation.
**Source:** docs/explore/mcp-patch-document.md#Business-rules (R7 html); #Impact-on-existing-system
**Applies Constraints:** C-002, C-007, C-008

**Execution:**
- `depends_on:` S-002
- `parallel_safe:` false
- `files:` apps/backend/src/mcp/tools/publish-tools.ts, apps/backend/src/annotation/block-id.ts, apps/backend/src/render/markdown.ts, apps/backend/src/mcp/tools/publish-tools.test.ts
- `autonomous:` true
- `verify:` bun test apps/backend/src/mcp/tools/publish-tools.test.ts

**Acceptance Scenarios:**

AS-015: Block-addressed html edit on innerHTML preserves inline markup
- **Given:** an html doc at version 2 whose `block-p-1` element has innerHTML `Hello <b>world</b>`
- **When:** the agent patches with `edits: [{ blockId: "block-p-1", find: "world", replace: "earth" }]` and `expectedVersion: 2`
- **Then:** `block-p-1`'s innerHTML becomes `Hello <b>earth</b>` (the `<b>` is preserved — find/replace ran on the innerHTML string, not the text), a new version 3 is appended, and the tool returns `{ docId, version: 3, previousVersion: 2 }`
- **Data:** html doc with `<p>Hello <b>world</b></p>` carrying `block-p-1`
- **Setup:** token has `docs:write` and editor+

AS-016: Replacement html is kept verbatim (not sanitized)
- **Given:** an html doc and a patch whose `replace` text contains markup the markdown path would strip (e.g. a `<span onclick=…>` handler), inside the addressed block
- **When:** the agent patches that block
- **Then:** the new version's stored html for that block contains the replacement VERBATIM — not stripped — because html docs are served raw to the sandbox (consistent with a whole-doc html publish), and the addressable block set is unchanged so the patch is accepted
- **Data:** `replace` = `text <span onclick="x()">y</span>` that stays within the block
- **Setup:** token has `docs:write` and editor+

AS-017: An absent find rejects the whole html patch (atomic at the html surface)
- **Given:** an html doc at version 2 where the addressed block does not contain the `find` text
- **When:** the agent patches that block
- **Then:** the patch is refused with a find-not-found reason, no new version is appended, and the doc stays at version 2
- **Data:** `find` text absent from the addressed element
- **Setup:** token has `docs:write` and editor+

AS-018: A replacement that breaks out of its html block is rejected (structural guard)
- **Given:** an html doc at version 2 and an edit whose `replace` contains an unbalanced close tag that would escape the addressed block into a sibling (changing the addressable block set)
- **When:** the agent patches that block
- **Then:** after applying, the server re-renders, detects the addressable block set changed, refuses the patch with a structural-change reason, appends no new version, and the doc stays at version 2 (this is the well-formedness net that replaces sanitization for html)
- **Data:** `replace` = `ok</p><p>injected` inside a `<p>` block
- **Setup:** token has `docs:write` and editor+

### S-004: Carry annotations across a patch deterministically (P0)

**Description:** As a doc owner, after an agent patches specific blocks I want annotations on the
UNCHANGED blocks to carry forward without a fuzzy guess (the patch already names what changed),
and only annotations on an edited block to run the existing matcher — and whole-doc publishes
must keep using the full matcher unchanged.
**Source:** docs/explore/mcp-patch-document.md#Happy-path (item 4); #Business-rules (R6); #Non-functional-technical-risks
**Applies Constraints:** C-004, C-005

**Execution:**
- `depends_on:` S-002
- `parallel_safe:` false
- `files:` apps/backend/src/annotation/reanchor-job.ts, apps/backend/src/annotation/reanchor.ts, apps/backend/src/mcp/tools/publish-tools.ts, apps/backend/src/annotation/reanchor-job.test.ts
- `autonomous:` checkpoint
- `verify:` bun test apps/backend/src/annotation/reanchor-job.test.ts

**Acceptance Scenarios:**

AS-019: An annotation on an untouched block carries deterministically (no matcher)
- **Given:** a doc with an annotation anchored to `block-p-5` and another to `block-h2-1`, and a patch that edits ONLY `block-h2-1`
- **When:** the patch appends the new version and re-anchor runs
- **Then:** the annotation on `block-p-5` is carried forward with its anchor unchanged and `is_orphaned` cleared, WITHOUT invoking the fuzzy matcher (it is in no edited block)
- **Data:** changed-block set = { `block-h2-1` }; annotations on `block-p-5`, `block-h2-1`
- **Setup:** doc has ≥2 annotations on different blocks; patch edits one block

AS-020: An annotation on an edited block runs the existing matcher
- **Given:** the same patch from AS-019 that edits `block-h2-1`, which carries an annotation
- **When:** re-anchor runs after the patch
- **Then:** the annotation on `block-h2-1` is processed by the existing re-anchor matcher (carried or orphaned per the 0.8 ladder, annotation-reanchor C-002) — not carried deterministically
- **Data:** annotation on the edited block whose snippet still matches above 0.8 → carried; or below → orphaned
- **Setup:** annotation anchored inside the edited block

AS-021: A whole-doc update still runs the full matcher (no regression)
- **Given:** a doc with annotations republished via `anchord_update_document` (a whole-doc publish, not a patch)
- **When:** the new version is appended and re-anchor runs
- **Then:** ALL annotations run the full fuzzy matcher (the deterministic-carry path is NOT used for non-patch publishes) — behaviour identical to today
- **Data:** a whole-doc republish with no changed-block set
- **Setup:** existing update/UI publish path

AS-022: A multi-range annotation with any segment in an edited block runs the matcher
- **Given:** a multi-range annotation with one segment in `block-p-1` and another in `block-p-2`, and a patch that edits ONLY `block-p-1`
- **When:** the patch appends the new version and re-anchor runs
- **Then:** the WHOLE annotation runs the existing matcher (it is NOT carried deterministically, even though its `block-p-2` segment is in an unchanged block), per the conservative multi-range rule
- **Data:** changed-block set = { `block-p-1` }; annotation segments on `block-p-1` and `block-p-2`
- **Setup:** a multi-range annotation straddling an edited and an unedited block

## Constraints & Invariants

C-001: A patch request is `edits[]` — a NON-EMPTY array of `{ blockId, find, replace }`. `blockId`
is the anchor that narrows the search region (so a `find` that recurs doc-wide only matches inside
the addressed block); `replace` carries the only genuinely-new tokens. `find` and `replace` are
LITERAL strings — never interpreted as regex/glob (a `find` of `.*` matches the literal two
characters, not a wildcard), so the ambiguity gate (C-002) can never be bypassed by a pattern.
`replace` MAY be empty (a deletion) as long as the result keeps the block set unchanged (C-008).
An edit's `blockId` MUST be a patchable block — one `read_document` returned WITH `sourceText`; a
`blockId` that is non-patchable (no source range — a table cell, raw-html block, or a token-walk↔
rendered-HTML mismatch, see GAP-005) or absent is refused, directing the agent to
`anchord_update_document`. For html the block's source string is its `innerHTML`, so a `find` may
include or sit inside inline markup; a `find` that is not unique in that string is refused (C-002). (AS-005, AS-010, AS-024)

C-002: A patch is ATOMIC, all-or-nothing — if ANY edit's `find` is absent or ambiguous (occurs more
than once in the addressed block), the WHOLE patch is refused with no partial apply and no new
version. (mirrors the codebase's atomic pattern, mcp-roundtrip C-018)
  - scope: S-002, S-003
  - surfaces: patch-markdown, patch-html
  - coverage: patch-markdown → AS-006, AS-007, AS-008; patch-html → AS-017

C-003: Optimistic concurrency via a HARD version pin — the patch carries `expectedVersion` (the
`version` from `read_document`); if the doc's current version ≠ that, the patch is refused and the
agent must re-read before retrying (positional block ids can renumber if an interleaved publish
landed). The pin is verified WITHIN the same per-doc-serialized append step that reads the current
version (the existing append serialization, render-publish C-004 / mcp-roundtrip C-011), so two
agents that both pinned the same version cannot both succeed — the one that loses the race sees the
now-newer version and is refused, never silently applied on top (no lost update). (AS-009)

C-004: A patch appends an immutable new version via the EXISTING append pipeline (no overwrite),
and re-anchor fires after the version is committed — identical to the whole-doc update path. (AS-005, AS-019)

C-005: Deterministic re-anchor carry — annotations whose `block_id` is NOT in the patch's edit set
carry forward deterministically (clear `is_orphaned`, keep the anchor, NO fuzzy matcher); only
annotations on an edited block run the existing matcher (annotation-reanchor C-002); non-patch
publishes (whole-doc update + UI edits) still run the full matcher unchanged. **Multi-range
annotation rule:** an annotation carries deterministically ONLY if ALL its segments are in unchanged
blocks; if ANY segment is in an edited block, the WHOLE annotation runs the existing matcher
(conservative default — never deterministic-carry a segment whose sibling segment's block changed). (AS-019, AS-020, AS-021, AS-022)

C-006: A patch requires the `docs:write` scope (mcp-roundtrip C-009), editor+ on the target doc
(mcp-roundtrip C-002), and is bound to the TOKEN's workspace — a W1 token never patches W2 content
(mcp-roundtrip C-013). (AS-011, AS-012, AS-013)

C-007: A patch introduces NO new sanitization step — each kind keeps its existing render/serve
behaviour. A markdown patch's new version is re-rendered through `renderMarkdown` (which DOMPurifies)
at serve time, so it is sanitized exactly as today; an html patch keeps the replacement VERBATIM
because html docs are served raw to the sandbox (render-publish C-002/C-008), identical to a
whole-doc html publish — XSS stays contained by sandbox-origin isolation, no patch-specific
sanitize. (AS-016)

C-008: Text-level edits only — a patch edit's `find`/`replace` stays WITHIN one block; adding or
removing a block (a structural change) is NOT a patch operation (the agent uses the whole-doc
`anchord_update_document`). The server ENFORCES this for BOTH kinds: after applying the edits it
re-renders and refuses the patch if the ORDERED block-id sequence changed (a block added, removed,
retagged, or reordered — compared position-by-position, not as an unordered set) — so a markdown
replacement cannot silently renumber the blocks after it, and an html replacement cannot break out
of its block (e.g. an unbalanced close tag that escapes into a sibling). A within-block edit that
only changes a block's TEXT keeps the sequence identical and is accepted; this preserves the
positional-id invariant the deterministic carry (C-005) relies on. This re-render check is also the
html well-formedness safety net that replaces sanitization (C-007). (AS-005, AS-014)
  - scope: S-002, S-003
  - surfaces: patch-markdown, patch-html
  - coverage: patch-markdown → AS-014; patch-html → AS-018

## What Already Exists

### System Impact & Technical Risks

- `apps/backend/src/mcp/tools/publish-tools.ts` — the `anchord_create_document` /
  `anchord_update_document` tools, `McpToolError`, the `appendVersion` port, and the `fireReanchor`
  seam. **Reuse**: add the `anchord_patch_document` tool here. `anchord_update_document` stays
  unchanged (whole-doc fallback); only its description is reworded to steer patch-vs-whole-doc (R5).
- `apps/backend/src/mcp/sdk-server.ts` `TOOL_META` — the advertised `tools/list` schema. **Reuse**:
  add the `anchord_patch_document` entry (`docId`, `expectedVersion`, `edits[]`).
- `apps/backend/src/mcp/tools/read-tools.ts` `ReadDocumentResult` — already returns `version` +
  `content`. **Extend** (additive) with the `blocks: { blockId, sourceText }[]` array (S-001).
- `apps/backend/src/annotation/block-id.ts` `injectBlockIds` (`block-{tag}-{n}`) — **reuse** to
  locate the addressed element for html apply, and to detect a changed block set for the C-008
  structural guard.
- `apps/backend/src/render/markdown.ts` `renderMarkdown` (markdown-it → DOMPurify) /
  `renderForAnchoring` — **reuse** the sanitize step for C-007. The markdown block→source-span map
  (GAP-001 resolved) uses markdown-it `token.map` line ranges; there is no existing source-map, so
  this mapping (+ the shared block-id numbering walk) is the net-new logic.
- `apps/backend/src/annotation/reanchor-job.ts` `runReanchorForNewVersion` /
  `apps/backend/src/annotation/reanchor.ts` `reanchorForVersion` — **extend** to accept an optional
  changed-block set so unchanged-block annotations carry deterministically (C-005).
  **RISK (medium-high):** the deterministic-carry path must NOT regress the existing fuzzy matcher
  for non-patch publishes (update + UI edits still use the full matcher) — why S-004 is `checkpoint`.
- `appendVersionTx` (services/version-repo) — **reuse** for the per-doc-serialized immutable append.
- happy-dom + isomorphic-dompurify (already in the repo) — **reuse** for the html DOM op + re-sanitize.

## Not in Scope

- **Create-by-reference (`contentPath`)** — Phase 2; independent and lower value (occasional big-create
  only) and adds an arbitrary-file-read security surface (allowlist + canonicalize + traversal-reject).
- **Renaming `anchord_update_document` → `anchord_replace_document`** — declined (GAP-004): both the
  whole-doc tool (keeps its name) and the new patch tool ship together; description text steers selection.
- **Image patch** — N/A; an image doc's content is the filename/alt (no model-generated body text → the
  66s problem never occurs); image stays full-replace.
- **Structural edits (add/remove/move blocks) as patch ops** — use `anchord_update_document`; a
  structural-diff op set is a later, harder design.
- **Cell-level / raw-html-block markdown patching** — `td`/`th` cells and raw `html_block` tokens have
  no `token.map` source range (GAP-005); marked non-patchable (read omits `sourceText`), agent uses
  `anchord_update_document` for them.
- **Sub-block re-anchor precision (Phase 2)** — carrying an annotation on the UNTOUCHED span of an
  EDITED block deterministically (offset-through-edit). Phase 1 conservatively runs the matcher for any
  annotation touching an edited block (GAP-003 resolved); precision is a later optimization.
- **Fast-apply / speculative-edit merge model (Cursor/Morph/Relace)** — over-engineering; anchord applies
  block-addressed patches deterministically (stable block ids + append pipeline), no merge model needed.
- **MCP Resources / resource-links as a tool INPUT** — the MCP spec only supports resources as tool
  OUTPUT; a plain `contentPath` string (Phase 2) achieves the reference goal without it.
- **CRDT / OT live editing** — locked out in CLAUDE.md (anchord ingests opaque republished artifacts).

## Gaps

GAP-003 (status: resolved): Annotation sub-block precision on an edited block — RESOLVED by decision:
Phase 1 does NOT implement offset-through-edit precision. The permanent Phase-1 behaviour is the
conservative one — ANY annotation touching an edited block (single-range or multi-range straddle) runs
the existing matcher (AS-020, AS-022). Sub-block precision is a Phase-2 enhancement (see Not in Scope).
Source: "Confirm whether offset-through-edit precision is worth it later".

GAP-005 (status: resolved): Non-mappable blocks (cells, raw-html, and token-walk↔rendered-HTML
divergence) — RESOLVED by a fail-closed contract. A block is "non-patchable" when its markdown-it
`token.map` source range is absent (table cells `td`/`th`, raw `html_block`) OR its token-walk id does
not match the `injectBlockIds` rendered-HTML id (raw HTML in source, or DOMPurify dropping/altering
elements — the ~70% alignment risk feasibility flagged). For every non-patchable block `read_document`
OMITS `sourceText` (the signal, AS-023); a patch addressing such a block is refused and directed to
`anchord_update_document` (AS-024, C-001). The system therefore never splices a wrong source range —
it fails closed. Source: "confirm the render→source correspondence is 1:1 enough … lists/tables/nested
blocks are the risk" + feasibility review finding #2.

## Clarifications — 2026-06-20 (from explore decision rationale, confirmed assumptions, and Phase 3 answers)

- **Hard version-pin (C-003) chosen** over soft "find-verify only": `find` alone tolerates text drift
  but not block-renumber from an interleaved publish; the pin is the safe choice for a write tool, at
  the cost of one extra round-trip on conflict. (Do not relitigate.)
- **Deterministic carry (C-005) chosen** over "still run the matcher on every block": the patch already
  knows what changed; fuzzy-guessing blocks we KNOW are unchanged is strictly worse. This is the whole
  reason item 3 is in scope.
- **Block-addressed deterministic apply chosen** over a fast-apply merge model: anchord has stable block
  ids + an append pipeline; a 7B merge model + GPU is ops weight that fights `docker compose up` self-host.
- **`expectedVersion` source confirmed:** `read_document` already returns the current `version` number;
  the agent echoes it back. No new id is needed.
- **A patch creating a new immutable version per call is accepted** (the immutable-version model is the
  existing contract; kept even though an agent patching many times is chatty).
- **`read_document` returning per-block `{ blockId, sourceText }` is an additive change** — the existing
  `content` field stays (back-compat).
- **GAP-001 resolved (Phase 3 audit):** markdown block→source-span uses markdown-it `token.map` line
  ranges (verified: heading/paragraph/list/table-row tokens carry `[startLine,endLine)`; the two
  identical `## Overview` blocks disambiguate by distinct ranges); `read_document` emits `sourceText`
  sliced from the range; block-id numbering comes from the SAME token walk so `blockId ↔ range` is exact.
  Residual cell/raw-html case → GAP-005. (A "locate-the-substring" shape and B "token.map line ranges"
  were not competitors — B is the mechanism that builds the per-block range A returns.)
- **GAP-002 resolved (Phase 3):** the server ENFORCES text-level-only by re-rendering after apply and
  rejecting the patch if the addressable block set changed (C-008, AS-014) — not trust-the-agent.
- **GAP-004 resolved (Phase 3):** do NOT rename the whole-doc tool. Both tools ship with distinct
  features — `anchord_patch_document` (block edits) and `anchord_update_document` (whole-doc, name
  unchanged). Selection is steered by the tool descriptions, not a rename.
- **HTML trust boundary not widened (review):** an html patch keeps the replacement verbatim, which
  is EXACTLY what a whole-doc html publish (`anchord_create_document`/`anchord_update_document`)
  already does — patch adds no new XSS exposure. App-origin reads of html doc content (search index,
  title extraction) go through text extraction (strip-to-text), and the in-app viewer serves html via
  the `/v` sandbox; so "kept verbatim" is contained by the EXISTING html-doc sandbox model
  (render-publish), not introduced here. If any app-origin surface ever renders raw html doc markup,
  that is a pre-existing render-publish concern, not a patch-specific one.

## Spec Sizing Notes

Stories=4 (under target 7). AS=25 (target 20, in the G1 overage range ≤30).

G1 splits producing the excess AS (each is one stated atom, no gộp):
- S-001 read: 5 AS for 5 atoms (markdown shape, html shape, empty-blocks boundary, unreadable reject,
  non-mappable block marked non-patchable). The last was added to close GAP-005's read-side signal.
- S-002 patch-markdown: 12 AS for 12 atoms (happy splice, find-absent, find-ambiguous, multi-edit
  atomic, stale version-pin, empty edits, read-only token, cross-workspace token, non-editor role,
  structural guard, non-patchable-block reject, image-kind reject). Each is a distinct stated rule/refusal.
- S-003 patch-html: 4 AS for 4 atoms (innerHTML edit preserves markup, replacement kept verbatim
  /not-sanitized, find-absent, structural breakout). The breakout AS is the well-formedness net that
  makes the no-sanitize decision safe, so it cannot be dropped.
- S-004 deterministic carry: 4 AS for 4 atoms (untouched carries, edited runs matcher, non-patch full
  matcher, multi-range straddle runs matcher).

No bloat — each AS traces to one stated atom. The count rose from review hardening (GAP-005 read +
patch atoms), not padding.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-20 | Initial creation (Phase 1: patch tool + read-path blocks + deterministic-carry re-anchor) | docs/explore/mcp-patch-document.md |
| 2026-06-20 | Phase 3: resolved GAP-001 (token.map mapping), GAP-002 (enforce structural guard → AS-014), GAP-004 (keep both tools, no rename → dropped the rename story); added GAP-005 (cell/raw-html residual) | -- |
| 2026-06-20 | Phase 3 follow-up: redesigned patch-html — one edit primitive (find/replace on the block's source string: markdown source for md, innerHTML for html) preserves inline markup; reversed C-007 (html kept verbatim, NOT sanitized — served raw to sandbox); C-008 structural guard extended to both kinds as the html well-formedness net; AS-015/016 rewritten, AS-018 added (html breakout rejected); S-004 AS renumbered → AS-019/020/021 | -- |
| 2026-06-20 | Sub-agent review (3 lenses): C-001 pinned find/replace as literal (not regex); C-003 pin verified inside the serialized append (no lost update); C-008 tightened to ordered-block-id-sequence; C-005 + AS-022 added multi-range straddle rule; GAP-005 widened to token-walk↔rendered-HTML divergence (fail-closed: omit sourceText); clarified html trust boundary not widened | -- |
| 2026-06-20 | Gap closure (reduce build risk): GAP-003 resolved (no sub-block precision in Phase 1 → Not in Scope; covered by AS-020/022); GAP-005 resolved (fail-closed contract + AS-023 read omits sourceText, AS-024 patch on non-patchable block refused, C-001 extended); no open gaps remain | -- |
| 2026-06-20 | Mode C (Minor): added AS-025 to S-002 — patch on an image doc is refused (out of scope). Documents the build-time S3 signal (patch rejects non-md/non-html kinds). Owes an AS-025-tagged test (follow-up /mf-build) | mf-build S3 |
