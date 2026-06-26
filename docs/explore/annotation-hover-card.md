## Explore: Annotation Hover Peek + Click-to-Pin Card

_2026-06-26_

**Feature:** Hovering an in-doc annotation marker shows a read-only "peek" card with the
annotation's full info at the marker; clicking the marker pins a full interactive ThreadCard
in a floating popover — so a reviewer can read and act on an annotation in place, without
focusing the right-hand rail.

**Trigger:** User action in the viewer (`/d/:slug`, `/v/:slug/:version`) — `mouseenter`
over a `.anno-mark` (peek, after ~200ms dwell) and `click` on it (pin). On touch (no hover),
`tap` opens a bottom sheet. No system/external trigger.

**UI expectation:** Floating cards anchored to the marker. The peek is a condensed
`ThreadCard`; the pinned popover reuses the FULL `ThreadCard` component verbatim, wrapped
with a close (✕) affordance. Positioning reuses the existing `place-popover.ts` math. On
mobile, a bottom sheet hosting the same full ThreadCard.

---

### UI sketches

**Read-budget note:** all tags below carry file-path evidence from the Phase-0 scan
(annotation-marks.tsx, thread-card.tsx, annotations-rail.tsx, viewer-screen.tsx,
place-popover.ts, selection-popover.tsx, components/ui/tooltip.tsx + popover.tsx).

**1. Hover peek (desktop, ~200ms dwell) — condensed ThreadCard, NO action bar:**

```
  …reject expired ⌇tokens before the refresh⌇ step…
                   └── .anno-mark [E] annotation-marks.tsx (nền teal 24%, gạch chân accent) ──┘
            ┌───────────────────────────────────────────────┐
            │ (JS) Jane Smith            2h    [P]           │  header: avatar 22px + author + time mono + StatusDot
            │ ⌫ Delete                                       │  type-chip row (chỉ redline/label)
            │ ▏"tokens before the refresh"                   │  quote-ref (left-rule 2px accent, clamp 2 dòng)
            │ This should also cover the rotating refresh…   │  root body (clamp ~2 dòng)
            │ 3 replies                                      │  CHỈ đếm — không render từng reply
            └────────────────────▽──────────────────────────┘
   AnnotationPeekCard [N] · width ~300px · prefer "above"-centered · read-only · rời chuột → tắt
```

**2. Click → pin = FULL ThreadCard [E] in a floating popover wrapper [N]:**

```
  …reject expired ⌇tokens before the refresh⌇ step…   ← .anno-mark--focus [E] (nền teal 38%)
       ┌──────────────────────────────────────────────────┐
       │ (JS) Jane Smith                  2h   [P]   ⋯  [✕]│  ✕ = PinnedCardPopover wrapper [N]
       │ ⌫ Delete                                          │  ← mọi thứ trong khung = ThreadCard [E]
       │ ▏"tokens before the refresh"          [Show more] │     thread-card.tsx (nguyên vẹn)
       │ This should also cover the rotating refresh token │
       │ ▏ (BL) Bob Lee   1h                               │  reply-list (left-rule, avatar 20px)
       │ ▏ Agreed — added in v3.                           │
       │ ───────────────────────────────────────────────  │  divider
       │ Reply                              Reject  Accept │  action bar 2-slot [E] (redline→owner)
       └────────────────────▽─────────────────────────────┘
   PinnedCardPopover [N] · width ~360px (= rail) · prefer "below" · flip+clamp
   Đóng: click-outside · Esc · ✕ · click lại marker (toggle) · 1 pin tại 1 thời điểm
```

**3. Layout 3-pane (≥1200px) — rail vẫn song song:**

```
┌──────────────┬─────────────────────────────────────┬────────────────────┐
│ TOC (236px)  │ DOC PANE  minmax(0,1fr)   [E]        │ RAIL (312px) [E]   │
│ [E]          │                                     │ Annotations 12  ⏷  │
│ ▸ Auth flow ◀│  …reject expired ⌇tokens before     │ ┌────────────────┐ │
│              │     the refresh⌇ step…              │ │(JS)Jane 2h [P] │◀┼─ aria-current
│              │          ┌────────────────────┐     │ │▏"tokens…"      │ │  ring accent
│              │          │ PinnedCardPopover  │ [N] │ │ Reply  Accept  │ │  (focusedId sync)
│              │          │ = ThreadCard + ✕   │     │ └────────────────┘ │
│              │          └─────────▽──────────┘     │                    │
└──────────────┴─────────────────────────────────────┴────────────────────┘
   Popover absolute trên doc pane — KHÔNG đẩy layout. viewer-screen.tsx grid [E].
```

**4. Mobile (<900px, drawer mode) — tap marker = bottom sheet:**

```
┌──────────────────────────────┐
│  DOC (full width) [E]     (3)│  CommentFab [E] vẫn còn
│  …reject expired ⌇tokens…    │  ← tap marker
├━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┤  bottom sheet trượt lên
│        ▔▔▔ (grab) ▔▔▔        │  AnnotationBottomSheet [N]
│ (JS) Jane Smith    2h  [P] ✕ │  ← bên trong = ThreadCard [E] đầy đủ
│ ▏"tokens before the refresh" │
│ ▏(BL) Bob Lee  1h            │
│ ───────────────────────────  │
│ Reply              Reject Accept│
└──────────────────────────────┘
```

Legend: [E] existing · [N] NEW · [X] MISSING / clarify

**Existing pieces to reuse (evidence):**
- `.anno-mark` + `data-anno=<id>` marker, `useAnnotationMarks` click delegation, `scrollToAnno`,
  `MARK_SELECTOR` — `apps/web/src/features/viewer/components/annotation-marks.tsx`
- `ThreadCard` (full) — `apps/web/src/features/viewer/components/thread-card.tsx`
- `placePopover` / `isRectOutOfViewport` — `apps/web/src/features/viewer/lib/place-popover.ts`
- `useDismissOnOutsideAndEscape` — `apps/web/src/features/viewer/hooks/use-dismiss.ts`
  (used by `selection-popover.tsx` — same dismiss contract reused for the pinned card)
- `focusedId` / `onFocusThread` state + rail sync — `viewer-screen.tsx` (`useAnnotations`)
- HTML-doc iframe bridge — `apps/web/src/features/viewer/lib/bridge.ts`,
  `components/html-sandbox-frame.tsx`
- Annotation/comment data already client-side (no new API) — `ViewerAnnotation` /
  `AnnotationComment` in `apps/web/src/features/viewer/services/client.ts`

**New pieces to build:**
- `AnnotationPeekCard` — condensed read-only card (header + quote + body clamp + reply count).
- `PinnedCardPopover` — floating wrapper hosting the full `ThreadCard` + a ✕ close, positioned
  via `placePopover`, dismissed via `useDismissOnOutsideAndEscape` + click-marker toggle.
- `AnnotationBottomSheet` — mobile sheet hosting the full `ThreadCard`.
- Hover/pin state + `mouseenter`/`mouseleave` delegation (with ~200ms dwell timer) added to
  `useAnnotationMarks` (or a sibling hook), gated OFF while an annotation tool is active.
- HTML-doc bridge messages: in-iframe `mouseenter`/`mouseleave`/`click` on a mark → post
  `{ annoId, rect }` to the parent; parent renders the card in parent coords. (Spike first.)

---

### Happy path (desktop, markdown doc, read mode)

1. Reviewer opens a doc at `/d/spec-abc`, no annotation tool active.
2. Hovers an `.anno-mark`; after ~200ms dwell, `AnnotationPeekCard` floats above-centered on
   the marker: avatar + author + relative time + StatusDot, type-chip (if redline/label),
   quote (clamp 2 lines), root body (clamp 2 lines), and an "N replies" count.
3. Mouse leaves → peek disappears.
4. Clicks the marker → `PinnedCardPopover` opens (prefer below, flip/clamp), hosting the FULL
   `ThreadCard`: full thread, Reply, Resolve/Reopen, Accept/Reject, Like, label — all inline.
   The marker gets `.anno-mark--focus`; `focusedId` is set so the matching rail card also
   highlights (`aria-current`, accent ring). The rail stays fully visible and usable.
5. Closes the pin via click-outside / Esc / ✕ / clicking the same marker again.

### Unhappy paths (confirmed)

- **Annotation tool active:** Markup/Comment tool on → peek + pin DISABLED; clicking a marker
  follows the tool's own behavior (new-annotation create), not pin. Hover-peek suppressed too.
- **HTML doc (iframe):** Marker lives in the sandboxed iframe. In-iframe hover/click → bridge
  posts `{ annoId, rect }` to the parent → parent positions and renders the card in parent
  coordinates (card is NEVER inside the sandbox). ⚠ Technical risk — needs a spike.
- **Network loss mid-action:** The pinned card reuses ThreadCard's existing optimistic +
  rollback behavior for reply/resolve/decide (already built); no new handling.

### Mobile flow

Touch (no hover) → `tap` marker opens `AnnotationBottomSheet` with the full ThreadCard. No
peek on touch. (NEW pattern vs. the current AS-014 behavior, which opens the whole rail
drawer + CommentFab — see Decision rationale.)

---

### Business rules

- Peek dwell delay: ~200ms (mirrors a tooltip; avoids flicker when sweeping the cursor across
  marker-dense text while reading).
- Exactly ONE pinned popover at a time — opening a new pin closes the previous.
- Peek and pin are READ/SELECT-mode only — both suppressed while any annotation-creation tool
  is active (the tool's selection/click wins).
- The pinned card and the rail share the SAME `focusedId` — pinning highlights the rail card
  and vice-versa (one source of truth, no second "active annotation" concept).
- Cards reuse all existing per-role gating inside ThreadCard (commenter+ for reply/resolve,
  owner-only Accept/Reject, author/owner for delete) — the backend re-authorizes every write.

### Input validation

No new inputs. Reply text inside the pinned card uses the existing ReplyComposer
(plaintext, Shift+Enter to send, disabled-until-typed) — unchanged.

### Edge cases

- **Empty state:** A marker always has ≥1 annotation, so a peek always has content. An
  annotation with no comments (quote-only) renders quote-only (ThreadCard already tolerates
  an absent thread — `const [root, ...replies] = comments ?? []`).
- **Unplaceable / detached annotation:** No mark is drawn (GAP-005 / `isOrphaned`), so there
  is nothing to hover or click — these stay rail-only (unchanged).
- **Multi-mark annotation (cross-block `multi_range`):** Hovering ANY segment shows the same
  card; the quote joins per-segment snippets (ThreadCard already does this).
- **Resolved / redline / stale marker:** Peek + pin reflect status via the same StatusDot +
  dim + type-chip styling the rail uses.
- **Marker near a viewport edge:** `placePopover` flips side + clamps horizontally so the card
  stays on-screen (already handles this for the selection popover).
- **Scroll while pinned:** `isRectOutOfViewport` is available to close/hide the card when the
  marker scrolls out (Plannotator `closeOnScrollOut`) — decision deferred (Open question).
- **Double-click marker:** click is a toggle (open → close) — a fast double-click ends closed.

### Permissions

- **Allowed (peek + pin view):** anyone who can view the doc — same audience as the marks
  themselves (no new gate; the data is already loaded client-side).
- **Pinned-card actions:** gated exactly as the rail today (ThreadCard reuses
  `currentUserId` / `isOwner` / callback presence). A viewer-only role gets a read-only card.
- **Blocked:** no one is newly blocked; a user with no doc access never reaches the viewer.

### Data impact

None. No schema change, no migration. All annotation + comment fields are already fetched for
the rail (`ViewerAnnotation` / `AnnotationComment`), so the cards render from existing client
state with zero new API calls.

### Impact on existing system

- `useAnnotationMarks` (`annotation-marks.tsx`): add hover/dwell + a pin-aware click path
  (gated by tool-active). The current click→`onFocusAnno` behavior is preserved when no tool
  is active but now ALSO opens the pin.
- `viewer-screen.tsx`: hosts the new pin/peek state and renders `PinnedCardPopover` /
  `AnnotationPeekCard` / `AnnotationBottomSheet` near the doc pane; reuses `focusedId`.
- HTML path: `bridge.ts` + `html-sandbox-frame.tsx` gain hover/click relay messages.
- Rail (`annotations-rail.tsx`): unchanged — stays parallel.

### Out of scope

- Editing the annotation anchor / re-attaching from the card (rail-only, unchanged).
- A new "active annotation" concept separate from `focusedId` (explicitly reuse `focusedId`).
- Replacing or hiding the rail when a card is pinned (rail stays — client chose parallel).
- Retiring the existing mobile rail-drawer/CommentFab (kept; bottom sheet is additive).
- Real-time push of new replies into an open card (async model — refetch reconciles, as today).

### Decision rationale

- **Hover peek + click-to-pin (not interactive-on-hover):** avoids the classic "can't move the
  cursor into a hover card" problem — peek is throwaway, the pin is the durable interactive
  surface. If users find clicking too heavy, reconsider an interactive HoverCard later.
- **Pinned card = full ThreadCard verbatim:** reuses the entire reply/resolve/decide/delete
  surface + its optimistic/rollback logic → no behavior fork, no re-styling. The ✕ lives on a
  wrapper, NOT inside ThreadCard, so ThreadCard stays untouched (rail has no close button).
- **Rail stays parallel (not replaced):** least disruption to existing code; accepts that the
  same thread can show in two places. If the redundancy annoys, revisit "popover-primary".
- **All 3 doc types from the start:** consistency across markdown/HTML/image. Cost = the HTML
  iframe bridge relay (the main risk). If the spike is expensive, fall back to phasing
  markdown first.
- **Mobile = per-thread bottom sheet (not the existing rail drawer):** client wants tapping a
  marker to jump straight to THAT thread, not open the whole list. Costs a new component; the
  cheaper alternative (reuse the AS-014 rail-drawer open) was offered and declined.
- **~200ms dwell + tool-active suppression:** keeps reading unobtrusive and removes the
  click-conflict between "view existing" and "create new".

### Assumptions (need confirmation)

- Peek width ~300px, pinned popover ~360px (= rail width, so ThreadCard layout is identical).
- Pinned popover prefers BELOW the marker (like the composer); peek prefers ABOVE-centered
  (like the selection popover).
- The pinned card does NOT auto-close on scroll in v1 (stays open until an explicit dismiss) —
  unless the marker fully leaves the viewport (see Open questions).
- Image-region markers expose a hoverable/clickable element carrying `data-anno` analogous to
  the text marks (to verify in `image-viewer.tsx`).

### Open questions

- Should a pinned card auto-close when its marker scrolls out of view (`isRectOutOfViewport`),
  or follow/reposition with the marker on scroll?
- Image docs: exact hover/click target + coordinate source for region markers
  (`image-viewer.tsx` not yet read in depth).
- HTML iframe: throttling of `mousemove`/`mouseenter` relay messages to keep scroll smooth.
- Keyboard: should focusing a marker via keyboard (if focusable) open the peek/pin for a11y?

### Complexity signal: **medium-high**

Based on: 3 new components + hook changes, 0 data/API changes, but a cross-iframe hover/click
bridge for HTML docs (the main unknown), 3 rendering contexts (markdown DOM / HTML iframe /
image regions), and a new mobile bottom-sheet pattern.

### Non-functional requirements

- **Scale:** a doc can carry tens of marks (rail loads the complete set). Hover uses event
  delegation on the doc pane (one listener), so mark count doesn't multiply listeners.
- **Performance:** ~200ms dwell debounce; HTML relay `mousemove` must be throttled. No network
  on hover/pin (data is client-side) → instant render.
- **Security/compliance:** quote + comment bodies are UNTRUSTED — render as plaintext via React
  children only (ThreadCard already enforces this; the peek must do the same — never
  `dangerouslySetInnerHTML`). For HTML docs the card renders OUTSIDE the sandbox, so it must
  not inject any iframe-sourced HTML.
- **Availability:** purely client-side enhancement; if it fails, marks + rail still work.

### Technical risks

- **HTML iframe hover/click relay (primary):** no existing hover bridge — only focus is
  relayed today (`postFocus`). Needs a spike: capture in-iframe `mouseenter`/`mouseleave`/
  `click` on `[data-anno]`, post `{ annoId, rect }` (rect translated to parent coords via the
  iframe's bounding box), throttle moves. Positioning math must add the iframe offset.
- **happy-dom has no layout** (`getBoundingClientRect` → 0): live positioning is
  `[→MANUAL]`/Playwright-only; keep the placement math pure + unit-tested with synthetic rects
  (same approach as `place-popover.ts`).
- **Mobile bottom sheet** is net-new UI (no existing sheet primitive found) — needs a
  responsive component honoring DESIGN.md tap targets (≥44px) and the teal accent.
