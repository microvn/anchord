# Snapshot: Annotation Re-anchor
**Date:** 2026-06-27
**Ref:** security-audit H-5
**Reason:** M6 — new constraint C-009 (re-anchor cost depends on bounded anchor input)

---

# Spec: annotation-reanchor

**Created:** 2026-06-19
**Last updated:** 2026-06-20
**Status:** Draft
**Snapshot limit:** 5

## Overview

The cross-version re-anchor matcher for `annotation-core` (the S-005 algorithm, extracted
and deepened). When a new version of a doc is published, every annotation from the previous
version must re-anchor onto the new content: carry it forward when its anchored text still
exists, mark it detached otherwise. This sub-spec owns the **"S1" model** — anchor by CONTENT,
not by position: the positional `block_id` is demoted to a hint, and the durable key is the
selected text located over the whole document. It validates against the W3C Web Annotation
TextQuoteSelector model (Hypothes.is reference) and matches what Plannotator ships (its
`block_id` is `// Legacy - not used`; the durable key is the selected text searched doc-wide).

_Sub-spec of `annotation-core` (shares its `annotations` + `anchor` model — see that spec's
Data Model). Triggered by the `versioning-diff` new-version event. The detached-management
surface (dismiss / re-attach) stays in `annotation-core:S-008`._

## Data Model

Extends `annotation-core`'s model — no new annotation columns beyond the `anchor` jsonb
additions; one new entity for the resolution record.

- **`annotations.anchor`** (jsonb, existing) gains two context fields, captured at selection
  time and stored verbatim: `prefix` (≤32 chars of doc text immediately before the selection)
  and `suffix` (≤32 chars immediately after). W3C TextQuoteSelector context. NON-BREAKING: an
  anchor without them degrades to `text_snippet`+`offset` matching (today's behaviour, no worse).
  `block_id`/`text_snippet`/`offset`/`length`/`segments[]` are unchanged.
- **anchor_resolution** (NEW): the immutable per-(annotation, version) outcome of re-anchoring.
  `id`, `annotation_id` (fk → annotations), `version_id` (fk → versions), `status` (anchored |
  orphaned), `method` (blockid | exact | nearest | normalized | fuzzy — which ladder tier won),
  `confidence` (real 0..1 — the matcher's score), `block_id` / `offset` / `length` (nullable —
  the resolved span in THIS version when anchored), `resolved_at`. UNIQUE (`annotation_id`,
  `version_id`). Versions are immutable, so "where does annotation A land in version V" is also
  immutable — the row is computed once and cached. This persists the C-012 ledger that
  `annotation-core` left as `[→MANUAL]`, and is the seam a later semantic fallback writes into.
- **`annotations.is_orphaned`** (existing, parent) is DERIVED: it mirrors the resolution row for
  the doc's CURRENT version. It is no longer the sole record of re-anchor state — the per-version
  resolution rows are the truth; `is_orphaned` is the current-version projection the UI reads.

## Stories

### S-001: Re-anchor by content, not position (P0)

**Description:** When a new version is published, an annotation re-anchors by trying its
`block_id` hint first, then — on a miss or a structural shift — locating its text over the WHOLE
document; it only detaches when the text is genuinely gone. Deleting or moving unrelated content
never detaches it.
**Source:** Cascade bug dogfooded 2026-06-19 (deleting one table row renumbered positional
`block-td-N` ids → unrelated annotations on other rows cascade-orphaned). Web research
(Hypothes.is fuzzy-anchoring / W3C Web Annotation TextQuoteSelector) + Plannotator source read
(`useAnnotationHighlighter` / `applyEditedDocument`: text-find over the whole container, positional
meta discarded on structure change). Supersedes `annotation-core`'s block-gated S-005 matcher.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` `apps/backend/src/annotation/reanchor.ts`, `packages/anchor/src/locate.ts`, `packages/anchor/src/anchor.ts`
- `autonomous:` true
- `verify:` create an annotation on a table row; publish a new version with an EARLIER row deleted → the annotation still anchors to its own (now-renumbered) row; an annotation whose row was deleted detaches.

**Acceptance Scenarios:**

AS-001: Fast path — unchanged structure carries via the block hint
- **Given:** an annotation whose `block_id` still resolves to a block containing its `text_snippet` unchanged
- **When:** a new version is published
- **Then:** it re-anchors within that block (the hint path), recording method "exact"; the annotation shows on the new version at the same text
- **Data:** the hinted block's content unchanged across versions

AS-002: Structural shift no longer cascades — a renumbered block carries via whole-doc text
- **Given:** a 3-column table; annotations on the `capture_id` and `refund_id` rows; the `transaction_id` row ABOVE them is deleted in the new version, so every later cell's positional `block_id` shifts
- **When:** the new version is published
- **Then:** each annotation's `block_id` hint misses (it now points at the wrong cell), the matcher locates `text_snippet` over the whole document, finds the one cell still containing it, and CARRIES the annotation; neither detaches
- **Data:** the refund-table case — delete 1 of 3 rows, 2 unrelated annotations below it

AS-003: A genuinely deleted block detaches without mis-anchoring to a coincidental mention
- **Given:** an annotation on the `transaction_id` table cell; the new version DELETES that row, while the phrase "transaction_id" still appears in a prose paragraph elsewhere
- **When:** the new version is published
- **Then:** the matcher does NOT carry the annotation onto the prose mention (the stored `prefix`/`suffix` table context fails to match the prose context); the annotation is marked detached and kept in the detached list
- **Data:** deleted cell + a coincidental prose occurrence of the same word

AS-004: A moved block carries (location-independent)
- **Given:** an annotation on a paragraph that, in the new version, is moved from the top of the doc to the bottom (its text unchanged)
- **When:** the new version is published
- **Then:** the annotation carries to the moved paragraph (whole-doc text locate is position-independent), recording method "exact"; it is not detached
- **Data:** a paragraph relocated within the doc, content intact

AS-005: A minor reword within the matcher threshold still carries (fuzzy)
- **Given:** an annotation whose `text_snippet` changed slightly in the new version ("24h" → "24 hours") and the surrounding text is otherwise intact
- **When:** the new version is published
- **Then:** the fuzzy tier carries it (similarity ≥ the match threshold), recording method "fuzzy"; the annotation shows at the reworded text
- **Data:** a small in-place edit, similarity above threshold

AS-006: A change below the match threshold detaches, never force-matches
- **Given:** an annotation whose anchored text is reworded so heavily that no candidate clears the match threshold
- **When:** the new version is published
- **Then:** the annotation is marked detached and kept in the detached list; it is NOT force-anchored onto the closest-but-below-threshold text
- **Data:** a wholesale reword of the anchored sentence (see GAP-001 — the common LLM-regen case)

AS-011: A markdown doc's unchanged-text annotation carries across a new version (re-anchor on rendered HTML)
- **Given:** a markdown-kind doc with an annotation anchored to its rendered content; the author publishes a new version whose content is byte-identical to the previous one
- **When:** the new version is published and re-anchor runs
- **Then:** the annotation carries (it is NOT detached) — the matcher re-anchors against the version's RENDERED HTML, so the rendered block-ids exist and the text is found; before C-008 the matcher saw raw markdown (zero blocks) and detached every annotation here
- **Data:** a markdown doc (the common kind), e.g. a `# Heading`; republish the same source unchanged

### S-002: Disambiguate a duplicate quote in the whole-doc fallback (P1)

**Description:** When the text-search fallback finds the annotation's quote in more than one
place in the new version, it picks the right occurrence using the stored context and position —
not the first match.
**Source:** Plannotator's `findTextInDOM` is first-`indexOf`-wins (no disambiguation); W3C
TextQuoteSelector + dom-anchor-text-quote's `hint` offset is the production fix. This is where S1
beats Plannotator.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `packages/anchor/src/locate.ts`, `apps/backend/src/annotation/reanchor.ts`
- `autonomous:` true

**Acceptance Scenarios:**

AS-007: Prefix/suffix + nearest-offset pick the correct duplicate
- **Given:** an annotation on the phrase "see below" in the second of two blocks that both contain it; the block_id hint has shifted so the fallback runs doc-wide and finds both occurrences
- **When:** the new version is published
- **Then:** the matcher carries the annotation to the occurrence whose surrounding text matches the stored `prefix`/`suffix` (ties broken toward the one nearest the stored `offset`), NOT to the first occurrence in document order
- **Data:** "see below" present twice; the annotation's stored context matches the second

### S-003: Immutable per-version resolution record (P0)

**Description:** Each re-anchor outcome is recorded as one immutable row per (annotation,
version), so re-running re-anchor for the same version is a no-op and every carry/detach carries
its method + confidence for audit and for a later semantic pass to build on.
**Source:** `annotation-core:C-012` (the idempotency ledger, currently `[→MANUAL]`); principal-eng
review 2026-06-19 (freeze the per-(annotation,version) resolution; it is the seam that makes a
later semantic/LLM fallback additive).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/annotation/reanchor.ts`, `apps/backend/src/db/schema.ts`, migration
- `autonomous:` checkpoint
- `verify:` publish a version → a resolution row exists per annotation with status+method+confidence; re-run the re-anchor for the same version → no row changes, no second apply.

**Acceptance Scenarios:**

AS-008: A resolution row is written per annotation per version, with method + confidence
- **Given:** a doc with annotations and a newly published version
- **When:** re-anchor runs for that version
- **Then:** exactly one resolution row exists per (annotation, version) recording status (anchored | orphaned), the winning method, the confidence score, and the resolved span when anchored
- **Data:** 3 annotations → 3 resolution rows for the new version

AS-009: Re-running re-anchor for the same version is idempotent
- **Given:** a version whose annotations have already been re-anchored (resolution rows exist)
- **When:** re-anchor runs again for that same version
- **Then:** the existing rows are reused unchanged — no row is rewritten, no carry/detach is applied twice
- **Data:** the same (annotation, version) pairs re-processed

### S-004: A wholesale rewrite detaches gracefully (P1)

**Description:** When the author republishes a fully regenerated doc (the common LLM loop) and an
annotation's text is reworded past the threshold, the annotation detaches into the list it can be
re-attached or dismissed from — it is never silently dropped and never mis-anchored.
**Source:** This session's conclusion + principal-eng review — full rewrite is unsolved by string
matching and is anchord's most common revision pattern; the honest behaviour is graceful detach
(GitHub-outdated style), with the semantic fallback named as the v0.5 lever (GAP-001).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/backend/src/annotation/reanchor.ts`
- `autonomous:` true

**Acceptance Scenarios:**

AS-010: A regenerated doc detaches its reworded annotations into the detached list
- **Given:** a doc whose new version is wholesale-regenerated, rewording the sentences several annotations were anchored to
- **When:** the new version is published
- **Then:** those annotations are marked detached and appear in the detached list with a count; none is silently lost and none is anchored onto unrelated text; the reviewer can re-attach or dismiss them (`annotation-core:S-008`)
- **Data:** an LLM-regenerated revision where ~half the anchored sentences are reworded

## Constraints & Invariants

- C-001: `block_id` is a HINT, not a gate. Re-anchor tries the hinted block first; on a miss (block
  gone, or text not found within it) it falls back to locating `text_snippet` over the WHOLE
  document. Durability rides on the text + context, never on a stable positional id. (AS-001, AS-002, AS-004)
- C-002: The locate ladder, in order, first hit wins: (1) hinted block — exact → nearest-to-offset
  → whitespace-normalized → fuzzy; (2) whole-doc flat text — exact → nearest-to-offset → normalized
  → fuzzy; (3) none → detached. The fuzzy tier uses normalized Levenshtein similarity at a **0.8**
  threshold (raised from 0.7: precision over recall — a wrong carry is worse than an honest detach).
  The fuzzy tier also scores the WHOLE block text against the snippet (not only equal-length windows),
  so an in-place reword that CHANGES the snippet's length ("24h" → "24 hours") still clears the bar and
  the carried span follows the new block text — this same shared ladder backs the FE highlighter, so the
  behaviour is identical in-app and at re-anchor. Resolves `annotation-core:GAP-001`. (AS-001, AS-005, AS-006)
- C-003: Precision over recall — the matcher NEVER force-anchors below threshold and NEVER
  mis-anchors. A duplicate quote in the whole-doc fallback is disambiguated by `prefix`/`suffix`
  context plus nearest-`offset`, not first-match. Candidate ranking also prefers the **most specific
  (innermost / smallest) block** that contains the match: a nested PARENT container (a `<table>`/`<tr>`
  whose concatenated text spans its cells) must never win over the actual `<td>` cell that holds the
  snippet, so a cell anchor re-anchors to its cell, not the surrounding container. When nothing clears
  the bar → detach. (AS-003, AS-006, AS-007)
- C-004: `prefix`/`suffix` (≤32 chars each) are captured at selection time in the shared anchor
  module and stored in the `anchor` jsonb. An anchor lacking them degrades to `text_snippet`+`offset`
  matching (no worse than today). (AS-003, AS-007)
- C-005: The re-anchor outcome per (annotation, version) is immutable + idempotent — recorded once
  in an `anchor_resolution` row (status, method, confidence, resolved span); re-running for the same
  version reuses the row and never double-applies. (AS-008, AS-009)
- C-006: multi_range stays all-or-nothing — each segment re-anchors through this ladder; if ANY
  segment detaches, the whole annotation detaches (no partial anchoring). Owned by
  `annotation-core:AS-018`; this ladder is what each segment runs. (cross-ref `annotation-core:AS-018`)
- C-007: A detached annotation is kept in the detached list (`annotation-core:S-008`/C-013) — never
  silently dropped — and can be re-attached or dismissed. (AS-003, AS-006, AS-010)
- C-008: Re-anchor AND anchor-placement validation (the re-attach + create-anchor "does this range
  place against the current version?" check) operate on the version's **rendered HTML**, never the raw
  stored content. A markdown doc's stored content is markdown source; the positional `block_id`s the
  ladder needs (`block-h1-1`, `block-td-7`, …) are injected at RENDER time, so they do not exist in the
  source. The render step is the SAME one the viewer uses (markdown → rendered HTML; an html doc passes
  through unchanged; image is N/A). Without it the ladder sees zero blocks and EVERY annotation detaches
  on every new version — even when the text is byte-identical — and re-attach is refused on markdown
  docs. The doc `kind` is carried into the re-anchor input (required, so a caller cannot forget to
  render). (AS-011) — scope: S-001 (publish/new-version), `annotation-core:S-008` (re-attach), `annotation-core:S-001` (create-anchor validation).

## Linked Fields

- **"new version created" (event)** — produced by `versioning-diff:S-001/S-003`. Consumed HERE
  (S-001) to trigger re-anchor for the previous version's annotations. ✔ producer fires on update + restore.
- **`anchor` descriptor incl. `prefix`/`suffix`** — produced by `annotation-core:S-001` create path
  (the shared `@anchord/anchor` `selectionToAnchor`, captured at selection time, persisted on the
  annotation). Consumed HERE by S-001/S-002 at re-anchor. ✔ surface (annotation row) + lifecycle
  (persisted at create, read at re-anchor) match.
- **`is_orphaned` (current-version projection) + detached list** — produced HERE (S-001/S-004,
  via the resolution row for the current version). Consumed by `annotation-core:S-008` (dismiss /
  re-attach) and `annotation-core-ui`'s DetachedSection. ✔ surface (annotations list read) + lifecycle
  (set on publish, served on read) match.
- **`anchor_resolution.method` / `confidence`** — produced HERE (S-003). OPTIONALLY consumed by
  `annotation-core-ui` to badge an auto-re-attached annotation ("re-attached automatically — verify").
  Not required for v0; the UI consumer is a future surface. (no v0 consumer pin)

## What Already Exists

### System Impact & Technical Risks

- `apps/backend/src/annotation/reanchor.ts` — the current BLOCK-GATED matcher (`reanchorSegment`
  looks up the stored `block_id` and searches only within that block; the C-012 ledger shape exists
  in memory but is not persisted). S-001 rewrites it to the hint → whole-doc ladder; S-003 persists
  the ledger as `anchor_resolution`.
- `packages/anchor/src/locate.ts` — the shared locate ladder (exact → nearest → normalized → fuzzy)
  already exists and is reused by the FE markdown path AND the in-iframe bridge; it is BLOCK-scoped
  today. S-001 reuses this same ladder for the whole-doc fallback (do not fork a second matcher,
  `annotation-core` C-011); the threshold constant moves 0.7 → 0.8 in both `reanchor.ts` and `locate.ts`.
- `packages/anchor/src/anchor.ts` — `selectionToAnchor` already produces `text_snippet`+`offset` from
  the block text; C-004 adds `prefix`/`suffix` capture here (the block text + selection offsets are
  already in hand). One change point serves both markdown and iframe surfaces.
- Risk (medium): the whole-doc fallback widens the search space, so duplicate-quote disambiguation
  (C-003) carries the false-positive risk — the precision bar (0.8 + context + offset) is the guard.

## Not in Scope

- **Stage 0 — block-identity structural diff** (GumTree-style tree match to map blocks across
  versions and scope matching to a candidate block): a v0.5 accuracy upgrade for move/duplicate.
  Deferred — S1's whole-doc fallback already kills the cascade without it.
- **Stage 2 — embedding / semantic re-anchoring** for the rewrite case (a local MiniLM/ONNX model
  embedding the orphaned quote + new-version candidates, cosine-aligned on the residual orphans
  only, with a margin guard): the NAMED v0.5 lever for GAP-001. Deferred — needs a precision-tuned
  eval set; runs self-hosted with no external API.
- **Stage 3 — agent-emitted edit-patch over MCP**: opportunistic only. Worth little in the
  regenerate-wholesale loop (a post-hoc patch from the agent is itself a guessed diff the server can
  compute more reliably); never the foundation. Deferred.
- **Image-region re-anchor** — image anchors use normalized 0..1 coordinates (`annotation-core:C-006`),
  not text locate; unaffected by this ladder.
- **Real-time / CRDT anchor maintenance** (Yjs/Automerge/Peritext) — requires owning the editor +
  incremental ops; anchord ingests opaque republished artifacts. Out of v0 (and product positioning).

## Gaps

- GAP-001 (status: deferred — owner: annotation-reanchor, v0.5): full-rewrite / wholesale-LLM-regen
  still detaches under S1 — string + fuzzy matching has a character-similarity ceiling (Hypothes.is's
  own ladder detaches here too), and this is anchord's MOST COMMON revision pattern (the author
  regenerates the doc each MCP round-trip). The named lever is the Stage-2 local-embedding semantic
  fallback on residual orphans (Not in Scope), precision-tuned against an eval set. Until then, the
  honest behaviour is graceful detach (S-004). Source: this session's principal-eng review +
  Hypothes.is fuzzy-anchoring (char-Levenshtein ceiling) + Plannotator source (no fuzzy at all).
- GAP-002 (status: open): the 0.8 fuzzy threshold (C-002) is a working default chosen for precision,
  NOT empirically tuned. Needs an eval set of (version N, version N+1, hand-labeled correct anchors)
  tuned to precision ≥ ~0.95 before it is trusted as final. Supersedes `annotation-core:GAP-001`
  (which asked the question at 0.7, block-scoped). Source: principal-eng review — "tune τ against
  precision, don't quote a recovery number from vibes".

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-19 | Initial creation (Mode A) — extracted + deepened from `annotation-core:S-005`. The "S1" content-anchored re-anchor model: block_id demoted to a hint, whole-doc text fallback, W3C prefix/suffix context, 0.8 fuzzy threshold (resolves annotation-core:GAP-001), immutable per-(annotation,version) `anchor_resolution` ledger (persists annotation-core:C-012). Kills the row-delete cascade (dogfooded 2026-06-19). Validated vs Hypothes.is/W3C + Plannotator source + principal-eng review. Stages 0/2/3 (structural-diff, semantic, agent-patch) deferred to v0.5; full-rewrite limitation recorded GAP-001. | annotation-core:S-005 |
| 2026-06-20 | Major (M6, snapshot 2026-06-20-reanchor-render-html.md): + C-008 (re-anchor AND re-attach/create-anchor validation operate on the version's RENDERED HTML; markdown is rendered first because positional block-ids are injected at render time; doc `kind` carried into the re-anchor input, required) + AS-011 (a markdown doc's unchanged-text annotation carries across a new version). Refined C-002 (fuzzy tier also scores whole-block-vs-snippet so a length-changing reword still carries; shared with the FE highlighter) + C-003 (candidate ranking prefers the innermost/most-specific block — a cell, not its parent table/row). Captures the /mf-fix render-markdown signal (commit 9225044, live-verified: publish markdown v2 unchanged → carries; re-attach markdown → succeeds) + the /mf-build S-001/S-002 ladder refinements. | /mf-fix 9225044 + /mf-build S-001/S-002 |
