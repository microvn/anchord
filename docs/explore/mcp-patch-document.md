## Explore: MCP patch-document (block-addressed edits) + read-path block ids + create-by-reference
_2026-06-20_

**Feature:** Give the anchord MCP server a way for an agent to edit a doc WITHOUT re-sending the whole
document — a block-addressed, self-verifying patch tool — plus the read-path change that makes blocks
addressable, plus content-by-reference for big creates. The patch doubles as an operation log that lets
re-anchor carry annotations deterministically.
**Trigger:** an MCP client (LLM agent) calls a write tool over `/mcp` (existing Streamable HTTP transport).
**UI expectation:** none — this is an MCP tool surface + backend. No app UI changes. (The Developer
settings PAT/MCP UI is unaffected.)

### Why (the measured problem)

`anchord_update_document` takes the FULL document `content` string. Measured: updating a 15.5KB markdown
doc through an LLM agent = **~66s wall-clock**, but the SAME call via raw `curl` = **59ms server-side**.
Decomposition: ~7s fixed per-agent-turn overhead (a tiny-payload `pull` is also ~7s) + **~59s the model
DECODING ~4–5k output tokens** of the full content. The bottleneck is autoregressive output generation of
the content argument, NOT the server / transport / network / DB. To change one heading in a 250-line doc,
the agent must re-emit all 15KB. This is the core MCP-revise loop — anchord's primary agent workflow — so
it's load-bearing.

Researched + audited (staff AI/MCP engineer, 2026-06-20, cited): the diagnosis is correct; the only lever
is **emitting fewer output tokens**, i.e. not re-emitting content that is unchanged (→ patch) or already
addressable (→ reference). Prior art for the fix: Notion `PATCH /v1/blocks/:id` (block-addressed by id —
anchord already has block ids), Claude Code's own `Edit` (old_string/new_string), Aider diff formats
(leaderboard: "far fewer tokens"). Rejected as over-engineering for anchord: a fast-apply merge model
(Cursor/Morph) — anchord can apply block-addressed patches DETERMINISTICALLY (it has stable block ids +
an append-version pipeline), so a 7B merge model + GPU is needless ops weight that fights the
`docker compose up` self-host positioning. Jira MCP "feels fast" only because its description field is
short in tokens — verified it is ALSO lossy full-replace (drops ADF panels/Smart Links;
atlassian-mcp-server#60), so anchord's block patch is strictly better, not a thing to copy.

### Happy path (Phase 1 — patch tool)

1. Agent calls `anchord_read_document(idOrSlug)` → gets the doc's blocks as `{ blockId, sourceText }[]`
   (e.g. `block-h2-1 → "## Overview"`) PLUS the current `versionId` (for the pin).
2. Agent wants to change the Overview heading. It emits ~50 bytes:
   `anchord_patch_document({ docId, expectedVersionId, edits: [{ blockId: "block-h2-1", find: "## Overview", replace: "## Overview1" }] })`.
3. Server: assert `expectedVersionId` == the doc's current version (else reject — see concurrency). For each
   edit, locate `find` within `blockId`'s source span, splice in `replace`. Re-render, append an immutable
   new version (same as `update_document` does).
4. Re-anchor runs (item 3): annotations on blocks NOT in the edit set carry deterministically (no matcher);
   only annotations on the edited `block-h2-1` run the existing matcher.
5. Tool returns `{ docId, version, previousVersion }` (mirrors update). Model emitted ~50 bytes instead of
   15KB → update drops from ~59s of generation to ~tens of tokens.

### Business rules

- **R1 — request type/shape.** `edits[]` is a non-empty array of `{ blockId, find, replace }`. `blockId` is
  the anchor (narrows the search region so a `find` that recurs doc-wide only matches inside the addressed
  block). `replace` carries the only genuinely-new tokens.
- **R2 — atomic, all-or-nothing.** If ANY edit's `find` is absent or ambiguous (appears >1× in the block),
  the WHOLE patch is rejected (no partial apply, no new version) and the tool returns an error the agent can
  act on. Mirrors the codebase's C-018 atomic-create pattern.
- **R3 — optimistic concurrency (hard pin, CHOSEN).** The agent sends `expectedVersionId` (from
  read_document). If the doc's current version ≠ that, the patch is rejected and the agent must re-read
  before retrying. Rationale: a positional block id (`block-{tag}-{n}`) can shift if another publish landed
  between read and patch; a hard pin prevents applying an edit against stale block addresses. (Considered
  soft "find-verify only" — rejected: find alone tolerates text drift but not block-renumber from an
  interleaved publish; the pin is the safe choice for a write tool.)
- **R4 — text-level edits only; structural changes use replace.** A `find/replace` that stays WITHIN a block
  (changes its text) keeps block numbering stable across the patch's own edits. An edit that would ADD or
  REMOVE a block (e.g. split one paragraph into two, delete a heading) shifts positional ids and is NOT a
  patch operation — the agent uses the full `anchord_replace_document` fallback for restructures.
- **R5 — fallback preserved.** `anchord_update_document` stays (rename to `anchord_replace_document` for
  clarity — "replace the ENTIRE document; use only when you restructured/regenerated"). Tool descriptions
  steer selection: patch = "edit specific blocks, faster, preserves annotations"; replace = whole-doc. When
  a patch is rejected (R2/R3), the agent falls back to replace. Wrong tool choice is therefore cheap.
- **R6 — deterministic re-anchor carry (item 3, CHOSEN).** The patch IS an operation log: it names exactly
  which blocks changed. Annotations whose `block_id` is NOT in the edit set carry forward deterministically
  (clear `is_orphaned`, keep anchor) — NO fuzzy matcher, NO 0.8 threshold guess. Only annotations on an
  edited block run the existing `annotation-reanchor` matcher (their block text genuinely changed). This
  removes the cascade/orphan-by-guess for every untouched block. (Connects to annotation-reanchor C-002/C-008.)
- **R7 — kinds.** markdown: find/replace on source. html: block-addressed DOM op (locate element by block id
  via happy-dom, replace its content re-sanitized through DOMPurify). image: patch N/A — an image doc's
  `content` is the filename/alt (no model-generated body text → the 66s problem never occurs); image stays
  full-replace, already cheap.

### Create-by-reference (item 2 — Phase 2, independent)

- For the "publish a brand-new 15KB doc" case there's no unchanged content to diff against, so patch can't
  help. Add `contentPath?: string` to `anchord_create_document` (and optionally replace): the agent emits a
  short path to a file it already wrote; the server reads it instead of the model re-emitting inline content.
- **Security:** a `contentPath` lets the MCP caller read server files → restrict to an env-allowlisted dir,
  canonicalize the path, reject traversal. Only works when agent + server share a filesystem (anchord's
  self-host deployment); keep inline `content` as the fallback for non-co-located clients.
- Floor (honest): this only helps if the content was ALREADY decoded to a file by a prior step — it
  deduplicates (pay once, not twice), it does not delete the N-new-token cost of genuinely-new content.

### Permissions

- Allowed: an MCP token with `docs:write` scope (same gate as the existing create/update tools), bound to
  the doc's workspace (C-009/C-013 token-workspace gate). Read-path needs `docs:read`.
- Blocked: read-only tokens (no `docs:write`); cross-workspace tokens (a W1 token never patches W2 content).

### Data impact

- No new tables. Patch appends an immutable version via the EXISTING `appendVersion` pipeline (a patch = a
  new version, consistent with the immutable-version model; re-anchor fires as today).
- Read-path companion change: `anchord_read_document` must additionally surface (a) per-block
  `{ blockId, sourceText }` and (b) the current `versionId`. Block ids are injected at render
  (`injectBlockIds`, positional `block-{tag}-{n}`) but today the read tool returns RAW `content` with no ids
  — so this is a required additive change to the read result shape, not a new model.

### Impact on existing system

- `apps/backend/src/mcp/tools/publish-tools.ts` (+ `sdk-server.ts` TOOL_META): new `anchord_patch_document`
  tool; rename `anchord_update_document` → `anchord_replace_document` (keep behaviour).
- `apps/backend/src/mcp/tools/read-tools.ts`: extend `read_document` result with per-block source + ids +
  versionId.
- `apps/backend/src/annotation/reanchor-job.ts` / `reanchor.ts`: accept an optional "changed block set" so
  unchanged-block annotations carry deterministically (item 3) — couples this feature to `annotation-reanchor`.
- `packages/anchor` / `annotation/block-id.ts`: block-id ↔ source-span mapping for apply (markdown line
  range; html DOM element). Reuse happy-dom + DOMPurify already in the repo.

### Out of scope

- Fast-apply / speculative-edit merge model (Cursor/Morph/Relace) — over-engineering; anchord applies
  patches deterministically without it.
- MCP Resources / resource-links as a tool INPUT — the MCP spec only supports resources as tool OUTPUT;
  a plain `contentPath` string achieves the reference goal without it.
- Structural edits (add/remove/move blocks) as patch ops — use `replace`; a structural-diff op set is a
  later, harder design.
- CRDT/OT live editing — anchord ingests opaque republished artifacts (locked out in CLAUDE.md).
- Image patch — N/A (no generated text body).

### Phasing

- **Phase 1 (ship first):** `anchord_patch_document` (markdown + html) + read-path block-ids/version +
  deterministic-carry re-anchor (items 1 + 3). These are tightly coupled — the patch IS the operation log,
  so item 3 rides item 1. Solves the measured 66s pain AND the orphan-by-guess correctness gap together.
- **Phase 2 (defer):** create-by-reference `contentPath` (item 2) — independent, lower value (occasional
  big-create only), adds filesystem-security surface.
- Dependency: item 3 requires item 1; item 2 is independent of both.

### Decision rationale

- Patch over full-replace because the floor is output-token decode; emitting a `{blockId,find,replace}`
  cuts the common "change one block" case >95% (~59s → seconds). If the dominant workflow ever became
  "regenerate the whole doc each turn" (not surgical edits), patch wouldn't help and replace+by-reference
  would matter more — revisit then.
- Hard version-pin (R3) over soft find-verify because block ids are positional and an interleaved publish
  renumbers them; the pin is the safe choice for a write tool even at the cost of one extra round-trip on
  conflict.
- Deterministic carry (R6) over "still run the matcher" because the patch already knows what changed —
  guessing with fuzzy 0.8 on blocks we KNOW are unchanged is strictly worse. This is the whole reason item 3
  is in scope.
- Block-addressed deterministic apply over a fast-apply merge model because anchord has stable block ids +
  an append pipeline; a merge model is ops weight that fights self-host positioning.

### Assumptions (need confirmation at spec/build)

- `read_document` returning per-block `{blockId, sourceText}` is acceptable as an additive change to its
  result (back-compat: existing `content` field stays).
- A patch creating a new immutable version per call is acceptable (could be chatty if an agent patches many
  times; the immutable model is the existing contract, so kept).
- create-by-reference allowlist dir is an env var (e.g. an import-root), canonicalized, traversal-rejected.

### Open questions

- **Block-id → source-span mapping for markdown.** Read returns raw markdown; block ids exist post-render.
  The clean design is read returning per-block `{blockId, sourceText}` so the model find/replaces exact
  SOURCE and the server applies to the source span — confirm the render→source correspondence is 1:1 enough
  to map every addressable block back to a markdown source range (lists/tables/nested blocks are the risk).
- **Annotation sub-block precision (item 3).** When an edit changes part of a block, an annotation anchored
  to an UNTOUCHED span of the SAME block could in principle still carry. Default (safe): any annotation on an
  edited block runs the matcher. Confirm whether offset-through-edit precision is worth it later.
- **expectedVersionId source.** Confirm `read_document` exposes a stable version id the agent echoes back.

### Complexity signal: high

Based on: touches the MCP tool surface (2 new/renamed tools) + the read-path result shape + the
`annotation-reanchor` matcher (item 3 cross-feature coupling) + a security surface (item 2 filesystem) +
markdown AND html apply paths. Likely splits into 2–3 specs at `/mf-plan` (patch+read / re-anchor-carry /
create-by-ref).

### Non-functional / technical risks

- **Risk (medium-high):** item 3 couples to `annotation-reanchor` — the deterministic-carry path must not
  regress the existing fuzzy matcher for non-patch publishes (replace + UI edits still use the full matcher).
- **Risk (medium):** block-id positional instability — mitigated by the self-verifying `find` + the hard
  version pin (R3) + the text-level-only constraint (R4).
- **Security:** create-by-reference `contentPath` is an arbitrary-file-read surface — allowlist + canonicalize
  + traversal-reject is mandatory, and it's why item 2 is phased separately.
- No external service; no PII beyond existing doc content; scale unchanged (same append-version pipeline).
