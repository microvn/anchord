## Explore: annotation-core

_2026-06-07_

**Feature:** Select a text range (or an image region) on a rendered doc → leave a comment
in the right-hand margin; reply threads, resolve/unresolve, suggestions. The anchor stays
durable across versions. The heart of the product.

**Trigger:** A viewer (with comment permission) selects text / click-drags on an image → creates
an annotation. Re-anchor runs automatically when versioning produces a new version.

**UI expectation:** A 2-column layout — content (sandboxed iframe for HTML / app-render
for MD / zoom-pan for images) on the left, the right-hand margin holding comment threads aligned with
the highlight. Reuse the Plannotator editor UX. All **[N] NEW**.

---

### Reference sources read (explore session)

- **Plannotator** (OSS, MIT/Apache, `github.com/backnotprop/plannotator`) —
  `packages/ui/components/html-viewer/bridge-script.ts`: bridge injected into the iframe,
  captures selection → postMessage, renders `<mark class="annotation-highlight"
  data-bind-id>`, re-anchors via `findTextAndMark` = `indexOf(originalText)` across the whole
  doc. Already handles theme/resize/scroll-to/focus/click.
- **uselink** (closed, read the `edit-DR6TUZo_.js` bundle) — the production anchor model:
  `anchor = { type: range|multi_range|block|doc, block_id, text_snippet, offset,
  length, segments[] }`; assigns `data-block-id` to blocks; `is_orphaned` + the
  `comments.unorphan` endpoint; class `uselink-comment-anchor`, viewer inside an iframe. Renders
  MD with markdown-it.
- **W3C Web Annotation / Hypothesis** — TextQuoteSelector + fuzzy matching
  (apache-annotator, Robert Knight's anchor-quote).

---

### Decisions

**1. Anchor model = block-scoped (following uselink), better than Plannotator.**
```
anchor: {
  type: "range" | "multi_range" | "block" | "doc",
  block_id: string,         // anchor by BLOCK, not by the whole doc
  text_snippet: string,     // quote
  offset: number, length: number,   // position within the block
  segments?: [{ block_id, text_snippet, offset, length }]  // multi_range
}
```
- The quote only needs to be unique *within the block* → self-resolves the duplicate-quote
  problem (W3C needs prefix/suffix to do it).
- Type `block` = comment on the whole block; `doc` = comment on the whole doc (no text anchor).
- **doc-level:** the annotation belongs to the DOC, stores the anchor descriptor, re-resolves each
  version (decided jointly with the versioning-diff cluster). `is_orphaned` field.

**2. Transport = reuse the Plannotator bridge + upgrade the matcher.**
- Reuse: inject the agent into the iframe + postMessage (a token handshake instead of validating
  origin since the opaque origin = "null"); render marks; theme/resize/scroll/focus/click.
- **Replace** `findTextAndMark` (whole-doc indexOf) with: find the block by `block_id` →
  find `text_snippet` *within the block* (exact → Hypothesis-style fuzzy). This is the
  extra code we write on top of Plannotator.
- Two transports depending on render: HTML (sandbox) via the postMessage bridge; MD (app origin)
  + images (app) access the DOM/coordinates directly. The annotation UI layer abstracts over both.

**3. block_id assignment = server-side, when serving content.**
- A preprocess pass injects `data-block-id` into block elements (p/div/li/h*/pre/
  table…) + inserts the bridge into the wrapper, then serves via the content-route. Reinforces the
  **src + content-route** decision (not srcdoc). block_id is generated stably (by content
  + order) so it stays durable while the block is unchanged across versions.

**4. Anchor type 2 — image-region.**
- Click = point pin; drag = box region. Stores **normalized 0..1 coordinates relative to the
  original image** (durable across zoom/screen changes). This is anchord's own ⭐ (uselink leans text).

**5. Threading = flat (Google Docs).**
- One thread per annotation; flat replies, no deep nesting. Matches uselink's `comments.reply`.
  (The schema has `parentId` but v0 uses only one level.)

**6. Resolve = toggle, whoever can comment can resolve, with reopen.**
- `status` resolved/unresolved; anyone with comment permission or higher can resolve/reopen.

**7. Suggestion mode = typed annotation + status, applied via MCP.**
- A suggestion is an annotation type carrying a proposal (delete X / replace X→Y). Accept/reject
  = status. **anchord does NOT edit content itself.** An agent pulls the suggestion via MCP, edits
  the source, republishes → a new version. Fits the immutable model + round-trip.

**8. Guest authorship.**
- A comment stores `authorId` (user) OR `guestName` (+ optional email) when a guest
  comments. *Enabling* guest commenting is owned by the sharing-permissions cluster (a sub-toggle of
  anyone-with-link).

---

### Happy path

1. The reviewer opens the doc link (commenter permission), selects the sentence
   "Payment expires after 24h" in the HTML spec rendered in the iframe.
2. The bridge captures the selection → computes `{ block_id: "block-7", text_snippet, offset,
   length, type: "range" }` → postMessage to the parent; the margin column shows an input box.
3. The reviewer types "Should it be 48h?" → submit → creates an annotation (doc-level) + the first
   thread comment; a yellow mark shows on the text, the thread aligned in the margin column.
4. The author opens the link, sees the thread, replies "OK, changed", clicks resolve → the mark dims,
   `status=resolved`.

### Unhappy paths

- **Re-anchor after a new version:** the author publishes v3 changing that sentence to "expires after   48 hours". Re-anchor: find `block-7` → the old snippet doesn't match exactly → fuzzy match
  within the block → still anchors (the text is close). If block-7 is fully deleted → the annotation
  is `is_orphaned=true`, goes into the **detached** list to relocate/resolve.
- **Duplicate quote:** the same phrase appears in 2 different blocks → still correct because it
  anchors by block_id, not by first-occurrence across the whole doc.
- **Guests with the same name:** two guests both set "An" → distinguished by id +
  timestamp, displayed as "An (guest)".
- **Empty / whitespace-only selection:** the bridge ignores it, no annotation created.

---

### Business rules

- An annotation belongs to a doc; each version re-resolves the anchor from the descriptor.
- Re-anchor: block_id → text_snippet exact → fuzzy → not found → orphaned.
- A suggestion never edits content itself; it only changes status + an MCP round-trip.
- Resolve is a toggle, with a history of who resolved (assumption).

### Input validation

- Comment body: non-empty, max ~10k characters (assumption).
- guestName: required when a guest comments; email optional, valid format if present.
- anchor.type ∈ {range, multi_range, block, doc}; image-region coords ∈ [0,1].

### Permissions

- **Create annotation/comment/reply:** commenter role or higher, or a guest (if the doc has
  guest commenting enabled). Viewer: read-only.
- **Resolve/reopen:** whoever can comment.
- **Edit/delete a comment:** that comment's author; owner/editor moderate (can delete anything).
- Role/guest-toggle details are owned by the **sharing-permissions** cluster.

### Data impact

- `annotations`: drop `docVersionId` (the old schema anchored to a version) → switch to **anchoring
  to the doc** + an `anchor jsonb` column (type/block_id/text_snippet/offset/length/segments)
  + `is_orphaned bool` + `status`. **This is a schema change from the original sketch, driven by
  the doc-level decision.**
- `comments`: `annotationId`, `authorId` nullable, `guestName`, `body`, `parentId`
  (one level), `createdAt`.
- Need to store a stable `data-block-id` in the served content (or recompute it
  deterministically on each serve).

### Out of scope (v0 — defer)

- Multi-level nested replies (v0 is flat).
- Reactions/emoji on comments (uselink has `reactions.toggle`) → v0.5.
- Auto-applying suggestions into content → not doing it (immutable model).
- Real-time presence / other people's cursors → v2.
- Advanced moderation (uselink `comments.moderate`) → v0.5, v0 is owner/editor delete only.

### Decision rationale

- Block-scoped instead of whole-doc nodePath/indexOf: durable across versions + self-resolves
  duplicate-quotes; a proven production model (uselink) instead of a brittle one
  (vanilla Plannotator).
- Reuse the Plannotator bridge but swap the matcher: take ~30-50% of the hard UI work (select→
  mark→margin) while still reaching the durability anchord needs.
- Suggestions don't auto-edit: the source content lives in the author's file + an immutable
  version; applying text-edits onto trusted HTML is very hard and risky. The MCP round-trip
  matches the "agent pulls feedback back to keep editing" spirit.
- Flat threads: the margin column is narrow, deep nesting is hard to read; Google Docs is flat too.

### Assumptions (need confirming)

- block_id is generated deterministically by (block content + order); stays stable while the block
  is unchanged. The exact algorithm is decided at build time.
- Comment body max ~10k; there's a resolve history.
- MD (app-render) also assigns block_id to share the re-anchor engine.

### Open questions

- The fuzzy algorithm within a block: what "fuzziness" threshold counts as a match vs
  orphan? (Hypothesis uses diff-match-patch — consider it.)
- How block_id is generated so it's both stable and doesn't collide when a block is inserted/deleted
  mid-doc (a sequential index would shift; hashing content makes blocks with duplicate content collide on id).
- `multi_range` (a selection spanning multiple blocks) re-anchors each segment independently —
  if one segment orphans, does the whole annotation orphan or just that part?
- How much effort to adapt Plannotator's `HtmlBlock`/`useHtmlAnnotation` (assumes srcdoc) to
  src+content-route — measured at build time.
- Image-region: does the pin need to stick to scroll/zoom in real time (overlay layer)?

### Complexity signal: **high**

The hardest cluster in the product: cross-origin bridge + block_id engine + re-anchor fuzzy +
the two-way constraint with versioning. This is where the product lives or dies.

### Cross-cluster dependencies

- **versioning-diff:** triggers re-anchor on a new version; the doc-level model is decided
  jointly. A two-way constraint.
- **render-publish:** block_id injection + bridge injection into the content-route; iframe
  sandbox; image zoom-pan for image-region.
- **sharing-permissions:** who can comment/resolve/moderate; enabling guest commenting.
- **mcp-roundtrip:** pulls annotations (including suggestions) for the agent; may include
  unorphan/relocate via MCP.
- **workspace-project:** notifies on a reply (part of the cross-cutting workspace).

## UI sketches

Dark-operator (see `DESIGN.md`). Greenfield → everything `[N]` NEW. Example doc = the
annotation-core spec itself (dogfood). Legend: `[Share]`=teal · `⬤`=teal · `▣`=detached/amber · `▢`=guest.

**Doc viewer + annotate (text)** `[N]` ← S-001 (block-scoped text annotation) /S-003
(flat reply) /S-004 (resolve) /S-006 (suggestion) /S-007 (guest) · render-publish
S-002 (HTML sandbox) · versioning S-005 (detached)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ ▤ ‹ ⚓ annotation-core ⬤LIVE [HTML] v2·16:34  ↶↷ [Preview|Edit] 💬 [Share] ◐ ⋯│
├──────────────────────────────────────────────────────────────────────────┤
│ SPEC · annotation-core · v2 · 7 stories · 22 AS · [Draft]  …/d/annotation-core│
├────────────┬───────────────────────────────────────────┬─────────────────┤
│ Search…    │  ⌖ Select | ✎ Markup   select to comment    │ ANNOTATIONS   3 │
│ STORIES  7 │  annotation-core            (Fraunces)       │ ┃"block_id is     │
│ ▸P0 S-001◀ │  S-001 Create a text annotation              │ │ positional hint"│
│  P0 S-002  │  Select → comment in margin, anchored by     │ │⬤Lan        2h  │
│  P1 S-003  │  ▁block_id (positional hint)▁ + text_snippet │ │block_id stable? │
│  P1 S-004  │       ┌─────────────┐ ←popover                │ ┕━━━━━━━━━━━━━━━ │
│  P0 S-005  │       │💬 ✦ ✓ 👍 ✕│                          │ ?Cat   [suggest] │
│  P1 S-006  │  C-001: anchor block-scoped; snippet unique  │ "hint"→"best-eff"│
│  P1 S-007  │  within block.                               │ ⬤Hoang[resolved]│
│ CONSTRAINTS│  ┌ anchor jsonb ──────────┐   (Geist Mono)   │ DETACHED      1 │
│  C-001..012│  │ {type,block_id,         │                 │ ?An  ▣detached  │
│            │  │  text_snippet,offset}   │                 │ "AS-018 changed" │
│            │  └─────────────────────────┘                 │ [Reply…]  [Send]│
└────────────┴───────────────────────────────────────────┴─────────────────┘
   TOC (search+scroll-spy+P-badge)     doc ~760px          annotations rail
```

**Mobile (<600, responsive)** `[N]` — TOC + rail become a drawer/bottom-sheet
```
┌──────────────────────┐
│ ▤  annotation-core ⋯ │
│  S-001 …anchored by  │
│  ▁block_id▁ + snippet│ ← tap highlight = open thread
│        ╭───────────╮ │
│        │ 💬 3  ▣1   │ │ ← FAB → bottom-sheet comment
│        ╰───────────╯ │
└──────────────────────┘
```

**Image-region** `[N]` ← S-002 (click=point, drag=box, normalized 0..1 coords durable
on zoom) · render-publish S-004 (image zoom/pan)
```
┌──────────────────────────────────────────┬─────────────────┐
│ ⚓ checkout-wireframe [IMG] v2  [Share] ⋯  │ ANNOTATIONS   2 │
│   ┌────────────────────────────────────┐ │ ⬤Lan  ◉point    │
│   │  ███ image ███             ◉←pin   │ │ "this btn small"│
│   │   ┌╌╌╌┐ ← box (drag)               │ │ ⬤Hoang ▢box     │
│   │   └╌╌╌┘                            │ │ "region off"    │
│   └────────────────────────────────────┘ │ coords 0..1     │
│   [ − ⊕ + ] zoom/pan                      │                 │
└──────────────────────────────────────────┴─────────────────┘
```
