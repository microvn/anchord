# Spec: annotation-core-ui-commenting

**Created:** 2026-06-11
**Last updated:** 2026-06-12
**Status:** Draft

## Overview

The **write path** for comments in the doc viewer — the consumer side of `annotation-core`'s
annotation/comment endpoints. Select text on a rendered doc → a floating popover → compose a comment
in the rail → a block-anchored annotation is created with a highlight + thread. Covers Markdown
(app-origin selection), HTML (selection inside the sandboxed iframe relayed via a trusted bridge),
flat replies, resolve/reopen, and guest commenting (random name, name-required, inert render).

Mounts into the viewer shell from `annotation-core-ui` (`ViewerScreen`/`DocPane`/`AnnotationsRail`);
that sibling owns rendering + reading; this owns creating. Sub-spec 2 of the 3-way split.

## Data Model

No persistent data — a client. Writes via the typed client:
- create annotation: `{ type, anchor{blockId,textSnippet,offset,length,segments[]} }` for a text range.
- add comment / reply: `{ body, parentId?, guestName?, guestEmail? }`.
- set resolution: `{ resolved }`.
Client state: current selection (range + quoted text), pending compose (quote + kind), guest name for
the session.
Read-payload field consumed (as built): `effectiveRole` on the doc read response drives `canCompose`
(C-004) — viewer-only ⇒ no compose/reply/resolve affordances. An ABSENT `effectiveRole` is treated as
comment-capable (the server re-authorizes every write per C-001, so a permissive client default is safe).
A `guest` flag on the same payload (owned by sharing-permissions) drives guest mode (S-005); this FE
consumes it, never owns the toggle.

## Stories

### S-001: Comment on a selected text range — Markdown (P0)

**Description:** As someone with comment permission, I select a text range on a rendered Markdown doc,
a popover offers Comment, I write it, and a block-anchored annotation with a highlight + margin thread
is created.
**Source:** annotation-core S-001 (AS-001/002/004), C-001; `POST …/annotations` + `POST …/comments`. Prototype: `viewer.jsx` SelectionPopover + Composer, `viewer-shell.jsx` onDocMouseUp/startComment/addThread.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` new `apps/web/src/features/viewer/{selection-popover,composer}.tsx`, extends `annotations-rail.tsx`, `features/viewer/client.ts` (createAnnotation/addComment); mounts into `annotation-core-ui:S-001` shell
- `autonomous:` true
- `verify:` select a sentence in a markdown doc → popover appears → Comment → composer prefilled with the quote → send → a highlight appears on the text + a new thread tops the rail.

**Acceptance Scenarios:**

AS-001: Create a comment on a Markdown selection
- **Given:** a commenter has a Markdown doc open in the viewer
- **When:** they select a sentence, click Comment in the popover, type a comment, and send
- **Then:** a block-anchored annotation is created (block + snippet/offset); a highlight marks the sentence; a thread with the quote + comment appears at the top of the rail and the count increments
- **Data:** select "Payment expires after 24h"

AS-002: An empty / whitespace-only selection creates nothing
- **Given:** the viewer is open
- **When:** the user releases a selection that covers no real characters (empty/whitespace)
- **Then:** no popover appears and no annotation is created
- **Data:** a 0-character selection

AS-003: A viewer-only role sees no compose affordance
- **Given:** a user whose effective role on the doc is viewer (read-only)
- **When:** they open the doc and select text
- **Then:** no comment popover/composer is offered; the rail is read-only
- **Data:** viewer role

AS-013: A failed comment write rolls back the optimistic thread
- **Given:** a commenter optimistically sees a new highlight + thread on send, but the write is refused
  (e.g. their role was revoked server-side, or the network fails)
- **When:** the create request comes back refused
- **Then:** the optimistic highlight + thread are removed and an error is shown ("couldn't save your
  comment"); the rail returns to its prior state (no ghost thread)
- **Data:** create refused (role revoked / network error)

### S-002: Comment on an HTML doc via the sandbox bridge (P0)

**Description:** As a commenter on an HTML doc (rendered in the sandboxed iframe), I select text inside
the doc and the selection is relayed to the app via a trusted bridge so I can comment; a forged
postMessage from the doc body cannot create an annotation.
**Source:** annotation-core S-001 (AS-001 HTML), C-009/AS-020 (bridge trust); `viewer-data.jsx` ("a small bridge script … relays selection events … via postMessage"). Plannotator bridge reuse (GAP-004).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` new `apps/web/src/features/viewer/bridge.ts` (parent side: dedicated channel, accept selection hints, ignore body-origin forgeries), extends html-sandbox-frame; server-side bridge script + re-authz are `annotation-core` (backend)
- `autonomous:` checkpoint
- `verify:` select text inside an HTML doc → the selection reaches the rail composer → comment → highlight in the iframe + thread; a `<script>parent.postMessage(...)</script>` in the doc body does NOT create an annotation.

**Acceptance Scenarios:**

AS-004: Selecting inside the HTML sandbox relays to the rail and comments
- **Given:** a commenter opens an HTML doc in the sandboxed iframe
- **When:** they select text inside it and choose Comment
- **Then:** the selection (quote + anchor) reaches the app over the trusted bridge channel; on send, a block-anchored annotation is created and a highlight + thread show (the write is re-authorized server-side by session role)
- **Data:** select a sentence in the 3rd block of an HTML doc

AS-005: A forged postMessage from the doc body does not create an annotation
- **Given:** an HTML doc whose body contains a script that calls `parent.postMessage({…annotation…})`
- **When:** it runs inside the sandboxed iframe
- **Then:** the app ignores it (accepts only the trusted bridge channel + re-authorizes server-side); no annotation is created from the forged message
- **Data:** `<script>parent.postMessage(...)</script>` in the body

### S-003: Reply in a thread (P1)

**Description:** As a participant, I reply to a comment and the reply shows flat under that annotation.
**Source:** annotation-core S-003 (AS-008), C-004; `POST …/comments` with `parentId`. Prototype: `viewer.jsx` ThreadCard reply.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/thread-card.tsx` (Reply UI) + the rail/screen wiring `annotations-rail.tsx`, `viewer-screen.tsx` (bind `onReply` → `addComment({body,parentId})`, gated by canCompose, optimistic reconcile + error toast) — as built
- `autonomous:` true

**Acceptance Scenarios:**

AS-006: A reply shows flat under the annotation
- **Given:** a thread that already has a first comment
- **When:** I click Reply, type, and send
- **Then:** the reply shows flat under the thread (one level, not nested deeper)
- **Data:** original comment + 1 reply

### S-004: Resolve / reopen a thread (P1)

**Description:** As someone with comment permission, I resolve a thread (it dims) or reopen it;
resolving is not limited to the author.
**Source:** annotation-core S-004 (AS-009/010), C-005; `PATCH …/resolution`. Prototype: `viewer.jsx` ThreadCard Resolve/Reopen.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/thread-card.tsx`, client.ts (setResolution) + the rail/screen wiring `annotations-rail.tsx`, `viewer-screen.tsx` (bind `onResolve` → `setResolution`, gated by canCompose, optimistic toggle + rollback + highlight dim) — as built
- `autonomous:` true

**Acceptance Scenarios:**

AS-007: Resolve then reopen toggles the status
- **Given:** an unresolved thread
- **When:** I click Resolve, then Reopen
- **Then:** the thread shows resolved (dimmed + Resolved badge, highlight dims) then back to unresolved
- **Data:** toggle twice

AS-008: A non-author commenter can resolve
- **Given:** a thread created by user A; I have commenter permission and am not A
- **When:** I click Resolve
- **Then:** the thread becomes resolved (resolving is not author-only)
- **Data:** I ≠ the thread's author

### S-005: Guest commenting (P1)

**Description:** As someone who opened a link without an account (guest commenting enabled), I view
under a random name and, to comment, I enter a name (and an optional email); my comment renders inert.
**Source:** annotation-core S-007 (AS-016/017/019), C-007/C-008; `POST …/comments` with guestName. Prototype: `viewer.jsx` AnnotationsRail guest-id + GuestNameField, `viewer-shell.jsx` GUEST_NAMES.

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/features/viewer/composer.tsx`
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: A guest is shown a random name on open
- **Given:** a doc with anyone-with-link + guest commenting enabled
- **When:** a logged-out person opens the link
- **Then:** they are shown a random display name (e.g. "Anonymous Lynx") for the session, with a Rename control
- **Data:** no account

AS-010: A guest comments with a name (email optional)
- **Given:** a guest is composing a comment
- **When:** they enter the name "Lan" (email optional) and send
- **Then:** the comment is stored under the guest name "Lan" (no account author) and appears in the thread
- **Data:** name "Lan", no email

AS-011: Send is blocked until a guest provides a name
- **Given:** a guest with no name set is composing
- **When:** they try to send
- **Then:** send is disabled with a "name required" hint; nothing is submitted
- **Data:** empty guest name

AS-012: A comment body / guest name with HTML renders inert
- **Given:** a guest submits a comment body or name containing HTML/script
- **When:** the thread renders at the app origin
- **Then:** the content shows escaped (the script does not run) and an over-long name is truncated
- **Data:** body `<img src=x onerror=alert(1)>`, a very long name

## Constraints & Invariants

- C-001: An annotation write is always re-authorized server-side by the session role; the client
  selection (incl. any iframe postMessage) is an untrusted hint — a forged role/message cannot create
  an annotation. (AS-005)
- C-002: The HTML-sandbox bridge uses a dedicated channel served by the app (not contained in the
  untrusted body) and does not trust by origin (opaque "null"); only its channel's selection hints are
  accepted. (AS-004, AS-005)
- C-003: Empty / whitespace-only selections never create an annotation. (AS-002)
- C-004: The compose / reply / resolve affordances appear only for a role with comment permission or
  higher; a viewer-only role gets a read-only rail. (AS-003)
- C-005: Replies are flat — one level under the annotation, never deeper. (AS-006)
- C-006: Resolve is a toggle; anyone with comment permission (not only the author) can resolve/reopen;
  a resolved thread renders dimmed. (AS-007, AS-008)
- C-007: A guest is assigned a random display name on open; a guest comment requires a name (send
  blocked otherwise); email is optional. (AS-009, AS-010, AS-011)
- C-008: EVERY untrusted string rendered at the app origin — comment body (guest AND session-user),
  guest name, the quoted snippet (`QuoteRef`), and a suggestion's from→to — is rendered inert
  (escaped / plaintext, never as HTML or interpreted markdown); the guest name is length/charset-limited.
  Comment bodies are PLAINTEXT in v0 (no markdown rendering — the composer's "Markdown supported" hint
  is removed until a sanitized markdown pipeline is specced). The guest-name length limit is enforced
  at THREE layers as built: on input, at store/sanitize, AND at render (a stale/forged over-long name
  is truncated on display too). (AS-012)
- C-009: The HTML-sandbox iframe `src` is set once from the doc's `/v/:id` on mount and never changed
  from user input (a parent-origin XSS that redirects it is a separate vuln; annotations add no new
  XSS surface beyond C-001/C-008). (AS-005)
- C-010: A guest comment is visibly attributed as a guest (not a workspace member); the self-entered
  name is a display label, not an identity. Rate-limiting / moderation of guest spam is a
  backend/`sharing-permissions` concern, not enforced here (GAP-004). (AS-010)
- C-011: Comment/annotation creation is optimistic (highlight + thread show on send) but rolls back on
  a refused/failed write — no ghost thread is left behind. The same optimistic-then-rollback rule applies
  as built to a reply (S-003) and a resolve toggle (S-004): the wiring callback resolving to `false` =
  refused write → the optimistic reply/toggle is removed and an error toast shown; on SUCCESS the
  optimistic temp is reconciled by WRITING THE REAL SERVER ROW INTO THE CLIENT CACHE (no refetch —
  create prepends, reply appends a flat comment, resolve patches status; the locally-inserted author
  shows as "You" / the guest name until a genuine read). (AS-013) (reconcile mechanism: Clarifications 2026-06-12)

## Linked Fields

annotation-core-ui-commenting is the **consumer**; `annotation-core` (backend) is the producer.

- create annotation `{type,anchor}` → `{annotationId}` — consumed by S-001/S-002 on send. Produced by
  `annotation-core` `POST …/annotations`. ✘ workspace-scoped path (`/api/w/:ws/docs/:slug/…`) vs the
  BE spec's `/api/docs/:slug/…` → annotation-core-ui:GAP-001.
- add comment / reply `{body,parentId?,guestName?,guestEmail?}` → `{commentId}` — consumed by
  S-001/S-003/S-005. Produced by `POST /api/w/:ws/annotations/:id/comments` (NOT under `docs/:slug`).
  ✔ RESOLVED 2026-06-12 — FE posted under `docs/:slug` (a path with no backend route → Elysia
  NotFoundError → 500); the FE client now posts the un-nested path, matching the BE route. A top-level
  comment (no `parentId`) creates a root comment; with `parentId` it is a flat reply (annotation-core).
- set resolution `{resolved}` — consumed by S-004. Produced by `PATCH …/annotations/:id/resolution`. ✔.
- the **bridge script + block-id markers** in the served HTML — consumed by S-002 to capture a
  selection→anchor inside the iframe. Produced by `annotation-core`/`render-publish` at serve time.
  ✘ no bridge script and no block-id injection exist yet (audit) → annotation-core-ui:GAP-002 + GAP-005 below.

## UI Notes

Design: prototype `viewer.jsx` (CANONICAL). Components mount into the `annotation-core-ui` shell.
Precedence: AS / Constraints > prototype > Tree. All `[N]`.

- `SelectionPopover` `[N]` *(floats ABOVE the selected range, horizontally centered — tooltip-style, flips below only when no room above; Plannotator center-above, 2026-06-12)*: Comment · Suggest *(suggest-image spec)* · Resolve · Dismiss
- `Composer` `[N]` *(an INLINE POPOVER anchored at the selection — appears BELOW the selected text and is DRAGGABLE by its quote-ref header; NOT mounted in `AnnotationsRail` — product decision 2026-06-12, supersedes the original "in the rail"; see Clarifications)*: `PendingQuoteRef` *(the selected quote, rendered inert + cancelable; doubles as the drag handle)* · textarea · `GuestNameField` *(guest only: name + Rename)* · `SendButton` *(disabled until body, and until guest name when guest)* · hint *("Name required" when guest w/o name; otherwise a neutral hint — NOT "Markdown supported": bodies are plaintext in v0 per C-008)*
- `AnnotationsRail` header label is **"Annotations"** (not "Comments") — the rail hosts all annotation types globally, 2026-06-12.
- `ThreadCard` actions `[N]` *(extends the shell's ThreadCard)*: Reply *(inline textarea → flat reply)* · Resolve/Reopen
- `AnnotationHighlight` write state `[N]`: a new annotation's highlight appears immediately on send; resolved → dimmed
- `SandboxBridge` `[N]` *(parent side; non-visual)*: a dedicated message channel to the HTML iframe; receives selection hints, ignores body-origin forgeries (C-001/C-002)

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| Viewer shell (ViewerScreen/DocPane/AnnotationsRail/ThreadCard) | `apps/web/src/features/viewer/` (built by `annotation-core-ui`) | mount the popover + composer + thread actions into it |
| HtmlSandboxFrame | `apps/web/src/features/viewer/html-sandbox-frame.tsx` (sibling) | the bridge attaches to this iframe |
| ConfirmDialog / Button / Select | `apps/web/src/components/` | reuse for any confirm + buttons |
| Typed client | `apps/web/src/features/viewer/client.ts` | extend with createAnnotation/addComment/setResolution |

### System Impact & Technical Risks

- **The HTML-sandbox bridge does not exist on either side** (audit): the backend has route-level
  re-authz (C-009) but no served bridge script + no block-id injection; the FE has no bridge. S-002 is
  the highest-risk story (cross-origin, opaque-origin, Plannotator adaptation — GAP-004).
- Reading/creating annotations depends on block-id injection at serve (annotation-core-ui:GAP-002) so
  the FE can map a selection → a stable anchor and back to a highlight.
- Guest commenting depends on `sharing-permissions` deciding guest-commenting-enabled + the anon
  identity; this FE consumes the flag/name, it does not own the toggle.

## Not in Scope

- Rendering the doc, reading existing annotations, the rail/threads layout, detached display — `annotation-core-ui` (shell).
- Suggestions (create / accept / reject) + image-region annotations — `annotation-core-ui-suggest-image`.
- Re-attach / dismiss of a detached annotation — deferred (needs a backend re-attach surface).
- The toggle that enables guest commenting + the role model deciding who may comment/moderate — `sharing-permissions`.
- The server-side bridge script + block-id injection + write re-authz — `annotation-core` (backend).

## Gaps

- GAP-001 (status: resolved — 2026-06-11): the HTML-sandbox bridge + block-id injection are now
  built on the backend — `/v/:id` serves `injectBridge(injectBlockIds(content))` (block-ids +
  in-iframe bridge script, annotation-core commit `0c49d53`). S-002 built end-to-end.
  Source: annotation-core-ui:GAP-002 + audit ("no bridge script").
- GAP-002 (status: resolved — 2026-06-11): the effort to adapt Plannotator's bridge/mark-rendering
  (assumes `srcdoc`) to the `src="/v/:id"` content-route was measured at build = M; did NOT reuse
  Plannotator's srcdoc transport, built a purpose-made bridge over the content-route instead. S-002
  shipped (not a follow-up). Source: annotation-core GAP-004 (now resolved).
- GAP-005 (status: deferred — owner: backend/annotation-core, v0.x): the bridge runs in the same
  JS realm as the untrusted doc body (the `/v` CSP keeps body scripts running), so a hostile body
  script can race the handshake — nuisance/DoS only, NOT an annotation-create (server re-authz, C-001,
  is the boundary). Fix = nested-iframe realm isolation; SES/ShadowRealm/CSP-nonce all rejected
  (researched 2026-06-11). Tracked on the producer side as annotation-core:GAP-005 + C-014.
  Source: /mf-build S-002 checkpoint + security research 2026-06-11.
- GAP-003 (status: resolved — G3, 2026-06-11): the anchor↔range contract is pinned (see Clarifications
  "Anchor contract"). MD walks the app-origin DOM directly; HTML delegates the walk to the in-iframe
  bridge. Remaining build-risk: adapting Plannotator's mark rendering (GAP-002).
- GAP-004 (status: deferred — owner: sharing-permissions/backend): guest comment rate-limiting +
  moderation (a guest can self-name freely → impersonation/spam). Out of scope here; the FE marks
  guests visibly (C-010). Source: challenge security F3.

## Clarifications — 2026-06-11

**Anchor contract (G3, pinned).** The selection↔anchor↔highlight algorithm (the FE's hardest part):
- **selection → anchor:** from a DOM selection, walk up to the nearest ancestor carrying
  `data-block-id` → `block_id`; within that block's text, capture `text_snippet` (selected substring,
  capped), `offset` (char offset of the selection start within the block text), `length`. A selection
  spanning blocks → `segments[]`, one `{block_id, offset, length}` each.
- **anchor → highlight:** find the element with that `block_id`; locate `text_snippet` at `offset`
  (exact), else fuzzy within the block; wrap the matched range in a highlight span. Zero/multiple/
  not-found → "couldn't place" (annotation-core-ui:GAP-005), never crash.
- **MD (app-origin):** the FE performs the walk + mark directly on the rendered content.
- **HTML (opaque-origin `/v` iframe):** the parent cannot read the iframe DOM, so the served bridge
  script (inside the iframe) does the walk on selection and relays the anchor to the parent; to render
  a highlight the parent sends the anchor over the channel and the bridge wraps the span in-iframe.
- Testable in JSDOM for the MD path (mock blocks + text → assert anchor; anchor → assert wrapped range).

**Other G-decisions:** G4 — the HTML bridge is built in v0 (S-002 stays). G9 — guest rate-limit/
moderation deferred to backend/`sharing-permissions` (GAP-004); FE marks guests visibly (C-010).

## Clarifications — 2026-06-12

Post-build UX + engine decisions made while implementing; recorded so a future Mode C reviewer
doesn't "fix" them back. None changes an AS Given/When/Then (all are UI presentation / mechanism).

- **Composer is an inline popover at the selection, not in the rail.** Clicking Comment opens the
  composer as a popover anchored at the selected text — appears BELOW the selection and is DRAGGABLE
  by its quote-ref header (Plannotator card pattern, Apache-2.0). Supersedes the original UI Notes
  "Composer in `AnnotationsRail`". The composed thread still lands in the rail on send. The
  `SelectionPopover` (quick actions) floats ABOVE the selection (tooltip-style).
- **Write reconcile = client-cache write, NOT refetch (refines C-011).** On a successful
  create/reply/resolve, the FE writes the real server row into the react-query cache (create prepends
  newest-first, reply appends a flat comment, resolve patches `status`) and drops the optimistic temp
  — no list refetch, so the rail doesn't reload/flicker. Trade-off: the locally-inserted author renders
  as "You" / the guest's self-entered name until a genuine read replaces it with the server display name.
- **Anchor matcher robustness (engine, adopted from Plannotator, Apache-2.0; refines the G3 contract).**
  A block is resolved by `id="block-…"` OR `data-block-id` (injectBlockIds emits the `id` form for a
  plain block, `data-block-id` only when the element already had an id). `text_snippet` is located:
  exact-at-offset → whitespace-normalized (with an index map) → nearest-occurrence to the recorded
  offset (a repeated snippet is disambiguated by offset, not refused). A range crossing inline elements
  (`<strong>`/`<a>`/`<code>`) is wrapped PER-TEXT-NODE → one annotation can be several `<mark data-anno>`
  reading as one continuous highlight (replaces a single `surroundContents`, which throws on cross-inline
  ranges). "Couldn't place" behavior (GAP-005) unchanged.
- **Markdown highlights survive a re-render.** Marks are injected imperatively into the
  `dangerouslySetInnerHTML` content; the rendered doc is memoized so a re-render (e.g. opening the
  composer) doesn't re-commit the HTML and wipe the `<mark>` nodes; placement runs in exactly one
  post-commit effect.
- **Touch selection.** On a coarse pointer the selection is captured via `selectionchange` (debounced),
  in addition to `mouseup` for fine pointers (responsive mandate).
- **Rail order.** Annotations list newest-first (matches AS-001 "thread appears at the top of the rail").

## Spec Sizing Notes

Stories=5, AS=13 — under the soft target. Sub-spec 2 of the 3-way annotation-core-ui split
(viewer+read · commenting · suggest+image), each self-contained, forced by the no-phasing scope
decision 2026-06-11.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-11 | Initial creation — FE comment write path (select→comment, bridge, reply, resolve, guest); sub-spec 2 of 3 | -- |
| 2026-06-11 | /mf-challenge: + AS-013 optimistic rollback + C-011; C-008 broadened (all untrusted strings inert, bodies plaintext v0, "Markdown supported" hint removed); + C-009 iframe-src integrity, C-010 guest-marked + GAP-004 (rate-limit); GAP-003 raised to top design risk | -- |
| 2026-06-11 | Gap-loop: GAP-003 resolved — anchor↔range contract PINNED (Clarifications); G4 (bridge in v0) + G9 (guest moderation deferred) recorded | -- |
| 2026-06-11 | Minor (post-build record): GAP-001 + GAP-002 RESOLVED (backend bridge built, commit `0c49d53`; S-002 end-to-end, effort M); + GAP-005 (body-script race → nested-iframe, deferred → annotation-core:GAP-005); S-003/S-004 `files:` += rail/screen wiring (as built); C-008 (guest-name limit at input/store/render) + C-011 (optimistic rollback+reconcile applies to reply/resolve) clarified; Data Model += `effectiveRole`/`guest` read-payload fields consumed | -- |
| 2026-06-12 | Minor (post-build UX/engine record): UI Notes — Composer is an inline popover at the selection (below + draggable), NOT in the rail; SelectionPopover floats above-centered; rail label "Comments"→"Annotations". C-011 reconcile = client-cache write (no refetch). Linked Fields — comment path RESOLVED (FE posts `/api/w/:ws/annotations/:id/comments`, no docs/slug). + Clarifications 2026-06-12 (composer location, cache reconcile, anchor matcher robustness incl. id-or-data-block-id + per-node wrapping, memoized-render mark survival, touch selectionchange, newest-first). All Minor — no AS GWT change | commits `5a1edb8`,`b5077e3`,`3ca07e5`,`7ae892e`,`60708cf`,`edafac1`,`267bccc`,`b87ffdb`,`4528194`,`148f73c`,`bae51c0` |
