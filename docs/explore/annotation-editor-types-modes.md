## Explore: Annotation editor — modes (Select/Pinpoint) + type taxonomy (Comment/Like/Label/Redline/Suggest)
_2026-06-14_

**Feature:** Expand the annotation editor from one type (Comment, text-range) to the full Plannotator-style
taxonomy: two selection **modes** (Select = text range, Pinpoint = whole block) × annotation **types**
(Comment, Like, Label, Redline, Suggest) + Image-region, all anchored, all with a thread, plus a global
(doc-level) comment. Reviewers mark up an immutable published doc; the agent pulls the structured feedback
via MCP and revises. No in-app content editing in v0 — every annotation is a *proposal/signal*, never a
direct edit.

**Trigger:** reviewer selects text (Select mode) or a block (Pinpoint mode) → a popover offers the type.
**UI expectation:** Plannotator's editor (the screenshots the PO supplied are the canonical reference):
a `DocModeToolbar` with a Mode switch (Select ⇄ Pinpoint) + feature buttons, a `SelectionPopover` with
Like · Comment · Label · Redline (+ Suggest), and a `LabelPicker` dropdown of preset tags. Right rail shows
each annotation with a TYPE badge + optional label line.

**Research note (Plannotator, backnotprop/plannotator, AGPL-adjacent OSS — we already borrow `@plannotator/*`):**
its export model has 3 underlying types — `DELETION`, `COMMENT` (+ optional quick-label), `GLOBAL_COMMENT` —
plus image attachments. "Quick labels" = up to 12 customizable presets (text + icon + color + Alt+1..0 shortcut),
grouped into a "Label Summary" on export. "Looks good" (Like) is a label/approval, rendered as a COMMENT row
with a 👍 label line. We adopt the UX, NOT Plannotator's `nodePath`/`web-highlighter` anchor (fragile across
reflow) — we keep our block-scoped anchor. Sources:
https://plannotator.ai/ · https://github.com/backnotprop/plannotator

---

### UI sketch (E/N/X tagged)

```
┌─ Viewer /w/:ws/d/:slug [E] components/viewer-screen.tsx ───────────────────────────┐
│  DocModeToolbar [E] doc-mode-toolbar.tsx  (TODAY: "Select | Markup" no-op)          │
│  ╔ REWORK → Mode switch: [Select] [Pinpoint] [N] · feature row [N] ════════════╗    │
│  ║   Select  = text-range select (existing engine [E])                         ║    │
│  ║   Pinpoint = hover-outline a block → click whole block [N] (blockTargeting) ║    │
│  ╚══════════════════════════════════════════════════════════════════════════════╝   │
│                                                                                     │
│  DocPane [E] → on select, SelectionPopover [E] selection-popover.tsx                │
│  ╔ REWORK popover actions (TODAY: Comment · Dismiss) ══════════════════════════╗    │
│  ║   Like [N] · Comment [E] · Label [N]→LabelPicker · Redline [N] · Suggest [N] ║    │
│  ║   LabelPicker [N]: dropdown of ≤12 presets (icon+color+text+shortcut)        ║    │
│  ╚══════════════════════════════════════════════════════════════════════════════╝   │
│                                                                                     │
│  AnnotationMarks [E] annotation-marks.tsx  (TODAY: comment highlight + resolved)    │
│    + redline strike style [N] · label-color highlight [N] · suggest underline [E?]  │
│                                                                                     │
│  AnnotationsRail [E] annotations-rail.tsx                                           │
│    ThreadCard [E] thread-card.tsx  + TYPE badge (COMMENT/DELETE/SUGGEST) [N]         │
│      + label line ("🔍 Verify this" / "👍 Looks good") [N]                          │
│      + Accept/Reject row for Redline/Suggest [N] (SuggestionThreadCard)             │
│    Composer [E] composer.tsx (reused for the optional note on any type)             │
│  ImageViewer [E placeholder] image-viewer.tsx + RegionLayer overlay [N]             │
│  Global-comment entry [N] (doc-level, type='doc')                                   │
└─────────────────────────────────────────────────────────────────────────────────────┘

Legend: [E] existing · [N] NEW · [X] unclear
Backend schema [E] apps/backend/src/db/schema.ts:213 — annotationType enum already has
  range · multi_range · block · doc · suggestion; suggestion jsonb already has kind:replace|delete +
  suggestionStatus(pending|accepted|rejected|stale). [N] = add `label` to annotations + a preset set.
```

---

### Data model (derived — leans on what the backend ALREADY has)

The key insight from the codebase scan: ~70% of this is already in the schema. The UI actions map onto
existing `type` + `suggestion.kind`; the only NEW persisted field is `label`.

| UI action (popover) | `type` | `suggestion.kind` | `label` | thread | extra lifecycle |
|---|---|---|---|---|---|
| Comment (Select) | `range` / `multi_range` | — | — | yes | resolve |
| Comment (Pinpoint) | `block` | — | — | yes | resolve |
| Global comment | `doc` | — | — | yes | resolve |
| Like (👍 looks good) | `range`/`block` | — | `looks-good` | yes | resolve |
| Label (preset tag) | `range`/`block` | — | `<presetId>` | yes | resolve |
| Redline (delete) | `suggestion` | `delete` | — | yes | accept/reject/stale |
| Suggest (replace) | `suggestion` | `replace` (from→to) | — | yes | accept/reject/stale |
| Image-region | `range` (+region anchor) | — | — | yes | resolve |

```
Annotation {                                  // existing table, +1 field
  id, docId, author, createdAt,
  type:   range | multi_range | block | doc | suggestion,   // [E] — MODE picks range/multi_range vs block
  anchor: { blockId, textSnippet?, offset?, length?, segments?[], region? },  // [E] block target = whole block
  label?: <presetId>,                         // [N] SIGNAL types only (comment/like/label); 'looks-good' = Like.
                                              //     Redline/Suggest carry NO label (Q#2 = C). Mutually exclusive
                                              //     with suggestion payload.
  status: unresolved | resolved,              // [E] thread resolve (ALL types). Accept/Reject auto-sets resolved (Q#3=A).
  suggestion?: { kind: replace|delete, from, to?, againstVersion },  // [E] Redline=delete, Suggest=replace
  suggestionStatus?: pending|accepted|rejected|stale,   // [E] accept/reject → also flips status=resolved (Q#3)
  comments[]                                  // [E] thread; may be empty (a bare mark)
}
LabelPreset { id, workspaceId, text, icon, color, order, shortcut }   // [N] WORKSPACE-scoped (Q#1).
```

**Label presets (Q#1 resolved):** workspace-scoped. On workspace creation, seed the default set below (~10).
A workspace admin can add/edit/reorder/recolor up to 12 in Settings (the customization UI is a later phase, but
the table is workspace-keyed + seeded from day one, so Phase 1 reads real rows, not hardcoded constants).
Default set (PO screenshot): Clarify this · Missing overview · Verify this · Give me an example · Match existing
patterns · Consider alternatives · Ensure no regression · Out of scope · Needs tests · Nice approach.

---

### Happy path (Select mode, Redline)
1. Reviewer in Select mode selects "Real-time Collaboration" in the doc.
2. SelectionPopover appears → clicks **Redline**.
3. Annotation created: `type=suggestion, suggestion.kind=delete, anchor=range(blockId,snippet,offset,len)`,
   `suggestionStatus=pending`. The text renders with a red strikethrough + red-tint background.
4. A rail card shows a **DELETE** badge + the quoted text; the author can later Accept/Reject; anyone with
   comment permission can reply/resolve.
5. The agent pulls it via MCP as a structured deletion against the current version.

### Happy path (Pinpoint mode, Label)
1. Reviewer toggles **Pinpoint** in the toolbar → hovers a paragraph → it outlines → clicks it.
2. Popover → **Label** → LabelPicker → "Out of scope".
3. Annotation: `type=block, anchor={blockId}, label='out-of-scope'`. Rail shows a 🚫 Out of scope row.

### Multi-role flow
Commenter/Editor/Owner create any annotation (it's a proposal, not an edit — same gate as today, C-004).
Redline/Suggest carry an Accept/Reject decision the **author/owner** makes (existing S-002, not author-of-thread).
Resolve/reopen is NOT author-only (existing C-006). Agent applies accepted proposals via MCP (out of scope here).

---

### Phasing (complexity = HIGH — recommend phasing)
- **Phase 1 — types on Select mode:** Redline (suggestion/delete) + Suggest (suggestion/replace, S-001/002) +
  Like + Label (new `label` field + fixed preset set) + threads/resolve on all + rail TYPE badges/label lines +
  redline/label mark styles. Reuses existing schema; only `label` is new.
- **Phase 2 — Pinpoint mode:** block hover-outline element picker (steal `blockTargeting`), `type=block` create
  path on md/html. Backend `block` type already exists.
- **Phase 3 — Image-region:** pin/box overlay on ImageViewer (existing spec S-003/004/005, unbuilt).
- **Phase 4 — Global comment** (`type=doc`) + **label customization** (per-workspace preset editing, Alt+1..0).

---

### Decision rationale
- **Keep Suggest (PO delegated the call; BA verdict).** anchord's value is agent-applicable feedback over MCP;
  Suggest (replace from→to) is the highest-fidelity, directly-applicable instruction — dropping it makes
  replacements lossy free-text. Because there is NO in-app edit mode, every user (esp. non-editors) only
  *proposes*; Suggest is the Google-Docs "suggesting" affordance for people who can't edit. In-app cost is
  low (no apply in-app; status + stale only) and it's already specced. → Redline = delete sibling, Suggest =
  replace sibling, both "edit proposals"; Comment/Like/Label are "signals".
- **Redline ≠ Suggest (PO correction to TODO.md).** Redline = strikethrough delete ONLY, no replacement text
  (PO image: red strike over the whole selection). TODO.md said "Redline = Suggest" — that was WRONG; recorded.
  Data-model-wise Redline rides `suggestion(kind=delete)`, which the schema already supports.
- **Like/Label are not separate types — they are a `COMMENT`/signal with a `label`** (Plannotator model; the
  rail renders COMMENT + a label line). Keeps the type enum small; "looks-good" is just a built-in preset.
- **All types get a thread (reply+resolve)** — PO decision. Redline/Suggest additionally have accept/reject.
- **Reuse our block-scoped anchor, not Plannotator's nodePath/web-highlighter** (fragile across reflow);
  keep the MessageChannel+nonce bridge (more secure than theirs). Adopt only the UX/targeting techniques.
- **"Markup" naming collision:** the existing `DocModeToolbar` "Markup" mode means *annotate-on-doc* (no-op
  today). The PO's "Markup" = the umbrella for the type actions. Rename to avoid clash: keep "Markup" as the
  umbrella; the toolbar modes become **Select / Pinpoint** (not Select/Markup). The leaf highlight-only type
  from the old TODO is REPLACED by Label/Like.

### Resolved decisions (were open questions)
- **Q#1 label scope = WORKSPACE.** Ship a seeded default set on workspace creation; admin customizes up to 12
  in Settings (customization UI = later phase; table is workspace-keyed + seeded from the start). NOT instance-fixed, NOT per-doc.
- **Q#2 label + note = SIGNALS ONLY (C).** Comment/Like/Label may carry a label AND an optional note; Redline/Suggest
  carry NO label (they have their own from/to payload). `label` is mutually exclusive with the `suggestion` payload.
- **Q#3 accept auto-resolves (A).** Accepting OR rejecting a Redline/Suggest flips the thread to `resolved` (dimmed);
  Reopen reverts. One mental model: deciding the proposal closes it.
- **Q#4 pinpoint-in-iframe = resolved by design.** The block element-picker (`blockTargeting`) runs iframe-side in
  the SAME served bridge that already does selection→anchor, relaying only `blockId` over the MessageChannel+nonce
  channel. No new cross-origin/XSS surface beyond the existing select bridge.

### Assumptions (need explicit confirmation)
- Pinpoint block anchor stores the block's text/hash for durability (block-id is a serve-time hint; reanchor ledger already exists).
- Global comment (`type=doc`) is available (schema supports it) but its FE entry point is Phase 4.
- "Looks good" is a built-in label preset (one of the seeded defaults), not a separate `approved` flag.

### Impact on existing system
- `selection-popover.tsx` (Comment+Dismiss → +Like/Label/Redline/Suggest), `doc-mode-toolbar.tsx`
  (Select/Markup no-op → Select/Pinpoint + features), `thread-card.tsx` (type badges + label line + accept/reject),
  `annotation-marks.tsx` (redline strike + label color), `image-viewer.tsx` (region overlay).
- Backend: add `label` to `annotations` + a label-preset source; the create-path re-authz (C-009) and the
  suggestion lifecycle (S-002) already exist and extend naturally.
- Existing `annotation-core-ui-suggest-image.md` spec absorbs this via `/mf-plan` Mode C (it already specs
  Suggest S-001/002 + image-region S-003/004/005); the NEW pieces are modes (Select/Pinpoint), Redline,
  Like/Label, global comment.

### Out of scope
- In-app applying of an accepted Redline/Suggest into content (that's the MCP round-trip / immutable-version model).
- Label customization UI (Phase 4), Alt+1..0 shortcuts (Phase 4).
- Plannotator's nodePath anchor + web-highlighter (rejected — fragile).

### Complexity signal: HIGH
5 types × 2 modes + label presets + threads-on-all + image overlay + global. Mitigated by: backend schema
already covers range/multi_range/block/doc/suggestion(replace|delete); the genuinely new persisted field is `label`.
