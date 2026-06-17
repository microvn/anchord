INVESTIGATION REPORT
════════════════════════════════════════════════════════════════

Target:          HTML docs (kind=html) — every annotation shows "COULDN'T PLACE" and no highlight renders in the iframe content (existing AND freshly-created). e.g. /d/shield-infrastructure-9o4d6l
Date:            2026-06-16
Status:          ROOT_CAUSE_FOUND

─── SUMMARY ───
HTML docs have NO working placement path for the EXISTING annotation set. The parent runs the
markdown light-DOM `placeAnnotations` against `docPaneEl` for ALL doc kinds — but an HTML doc's
content lives inside an opaque sandboxed `<iframe>`, so `docPaneEl` holds only the iframe element,
never the doc blocks. Every anchor therefore fails `findBlock` → all are reported `unplaceable` →
the rail badges every annotation "COULDN'T PLACE". The correct HTML path (ask the in-iframe bridge
to draw via `postHighlight`) is wired ONLY in the create flow, never for the existing list on load,
so no highlight is ever drawn. Fix: don't run the light-DOM placer for HTML; instead post every
annotation to the bridge on handshake + on list change, and route the bridge's `onPlaceFailed` to
`reportUnplaceable`.

─── SYMPTOM ───
Expected: opening an HTML doc draws a highlight in the iframe for each anchored annotation; an
          un-locatable anchor (and only that one) shows "couldn't place".
Actual:   ALL annotations show "COULDN'T PLACE"; NO highlight renders in the iframe; a freshly
          created annotation also shows no highlight + couldn't-place.
Frequency: always, HTML docs only. Markdown docs place fine (different path).

─── ROOT CAUSE ───
HYPOTHESIS A (PRIMARY — HIGH)
  Location:   apps/web/src/features/viewer/components/viewer-screen.tsx:847 (useAnnotationMarks runs
              for ALL kinds) + the absence of any bridge-based placement of the existing annotation
              set (postHighlight only at viewer-screen.tsx:321, create-only).
  Mechanism:  Two compounding defects on the HTML path —
              (1) WRONG PATH RUNS. `useAnnotationMarks(docPaneEl, placeable, …, reportUnplaceable)`
                  is called unconditionally (viewer-screen.tsx:847-855). `placeAnnotations`
                  (annotation-marks.tsx) does `findBlock(docRoot, anchor.blockId)` against
                  `docPaneEl`. For HTML, `docPaneEl` is the doc-pane light DOM that contains only
                  `<HtmlSandboxFrame>` → `<iframe>` (opaque origin). The doc blocks (block-div-18,
                  block-article-12, …) live INSIDE the iframe document, unreachable from the parent.
                  So `findBlock` returns null for every anchor → `unplaceable.push(id)` for all →
                  `reportUnplaceable([all ids])` → rail shows "COULDN'T PLACE" on every item.
              (2) RIGHT PATH NEVER RUNS FOR EXISTING ANNOTATIONS. The only correct way to draw in an
                  opaque iframe is `htmlFrameRef.current.postHighlight(anchor, id)` over the bridge
                  port. That is called ONLY in the create flow (viewer-screen.tsx:321,
                  `if (isHtml) htmlFrameRef.current?.postHighlight(...)`). There is NO effect that
                  posts the EXISTING annotation list to the bridge after the handshake or when the
                  list changes. `html-sandbox-frame.tsx` exposes only `postHighlight` (no "place all"
                  / no ready signal), and `bridge.ts:172` `postHighlight` no-ops before the port
                  handshake. So existing annotations are never sent → never drawn.
  Chain:      open HTML doc → useAnnotationMarks(docPaneEl = light DOM holding only <iframe>)
              → placeAnnotations → findBlock("block-div-18") in light DOM → null (block is inside the
              opaque iframe) → unplaceable for ALL 5 → reportUnplaceable([all]) → rail "COULDN'T
              PLACE"; meanwhile no postHighlight is ever sent for the existing set → bridge draws
              nothing → no highlight in the iframe.
  Evidence:
    - viewer-screen.tsx:847-855 — `useAnnotationMarks(docPaneEl, placeable, focusedId, …,
      reportUnplaceable)` with no kind gate (runs for html + markdown alike).
    - viewer-screen.tsx:295 `const isHtml = doc?.kind === "html"`, :299 `isMarkdown` — the kind IS
      known, but only used for layout/compose wiring, not to gate the placer.
    - viewer-screen.tsx:321 — `if (isHtml) htmlFrameRef.current?.postHighlight(anchor, annotationId)`
      sits in the CREATE callback only; grep shows postHighlight is called nowhere else.
    - annotation-marks.tsx placeAnnotations — `findBlock(docRoot, ann.anchor.blockId)`; returns
      `unplaceable.push(id)` when the block isn't in `docRoot`.
    - html-sandbox-frame.tsx:21-24,81-87 — `HtmlSandboxFrameHandle` exposes ONLY `postHighlight`
      ("draw a highlight for a CREATED annotation"); no place-existing/ready API; connectBridge call
      (62-70) wires onSelection/onClearSelection/onSelectionRect but NOT `onPlaceFailed`.
    - bridge.ts:64 — `onPlaceFailed?(annotationId)` handler EXISTS in BridgeHandlers but is never
      supplied by the parent.
    - bridge.ts:169-173 — `postHighlight` is `port?.postMessage(...)`; "No port yet → nothing to do"
      (silently dropped before handshake).
    - DB: shield (kind=html) anchors use blockId block-div-18 / block-article-12 / block-li-4 /
      block-p-2 — these are injected at serve (injectBlockIds) INTO the iframe HTML, not into the
      parent light DOM, so the parent placer can never see them.
  Disproof:   If a kind-gated test showed `useAnnotationMarks` is NOT run for HTML, or if an effect
              posting the existing annotations to the bridge existed and the highlights still didn't
              draw, this hypothesis would be wrong. Neither exists.

─── POTENTIAL GAPS ───
- viewer-screen.tsx:847 — no kind gate on the light-DOM placer; it can ONLY ever false-flag
  couldn't-place for HTML (it has no access to the iframe DOM). No test asserts HTML skips it.
- html-sandbox-frame.tsx — `onPlaceFailed` (bridge.ts:64) is never wired, so even once HTML
  placement is added, genuine in-iframe placement failures won't surface to the rail.
- sandbox-bridge.ts placeAnchor — SECONDARY: the stored anchor snippets carry source-indentation
  whitespace ("…503 3 lần.\n          WhenAdapter…", newline + 10 spaces). Even once the bridge is
  asked to place, `placeAnchor`'s snippet match must tolerate whitespace/textContent differences or
  correctly-posted annotations could still miss. Verify locateRange normalization in the bridge.
- No bridge "ready" signal to the parent; `postHighlight` silently drops before handshake — a naive
  "post on mount" would race the handshake.

─── REGRESSION? ───
No — pre-existing. The HTML placement-for-existing-annotations path was never built; the bridge +
postHighlight were wired for the CREATE round-trip only. (The cross-block/leaf-filter work earlier
today touched the markdown path only and did not affect this.)

─── BLAST RADIUS ───
Scope: MODULE (viewer HTML path).
Direct impact:
  - viewer-screen.tsx — runs the wrong placer for HTML; never posts existing annotations to the bridge.
  - html-sandbox-frame.tsx — no place-existing API; onPlaceFailed unwired.
Data impact: none — anchors are fine; nothing is mis-written. Purely a render/placement-path defect.
User-facing: every HTML doc shows all annotations as "couldn't place" with no in-content highlight;
  markdown docs unaffected.

─── RECOMMENDED ACTIONS ───
1. [CRITICAL] Gate the light-DOM placer to MARKDOWN only.
   viewer-screen.tsx: only call `useAnnotationMarks` / `reportUnplaceable` (the placeAnnotations path)
   when `isMarkdown`. For HTML it can only false-flag couldn't-place (no access to iframe DOM).
   Scope: 1 file, LOW.
2. [CRITICAL] Add the HTML placement path over the bridge.
   On the bridge handshake (ready) AND whenever `annotations` changes, post EVERY current
   annotation's anchor to the bridge (postHighlight per annotation, or a batch `postHighlights`).
   Requires a ready signal: extend BridgeConnection/HtmlSandboxFrameHandle with an `onReady` (or
   reuse `isConnected()` + flush) so the initial set is posted once the port exists (postHighlight
   no-ops before that, bridge.ts:172). The in-iframe bridge already draws on a `highlight` message
   and relays failures. Scope: html-sandbox-frame.tsx + viewer-screen.tsx + bridge.ts, MEDIUM.
3. [HIGH] Wire `onPlaceFailed` → reportUnplaceable.
   In html-sandbox-frame.tsx connectBridge, pass `onPlaceFailed: (id) => …` up to viewer-screen's
   `reportUnplaceable([id])`, and CLEAR the unplaceable flag for ids the bridge successfully draws.
   So a genuinely un-locatable HTML anchor still badges couldn't-place, but a matched one highlights
   + clears. Scope: 2 files, MEDIUM.
4. [MEDIUM] Verify/strengthen sandbox-bridge.ts placeAnchor whitespace tolerance.
   Confirm `placeAnchor`/its locate logic matches a snippet that carries source-indentation
   whitespace (the stored "\n          " runs) against the iframe textContent. Add a test if it
   collapses/normalizes inconsistently. Scope: sandbox-bridge.ts, LOW-MEDIUM.

Test strategy:
  - Component/unit: an HTML doc does NOT invoke the light-DOM placeAnnotations (no spurious
    reportUnplaceable). A markdown doc still does.
  - The parent posts each existing annotation's anchor over the bridge on ready + on annotations
    change (mock BridgeConnection, assert postHighlight called once per annotation).
  - onPlaceFailed(id) → the rail marks only that id couldn't-place; a drawn id is NOT couldn't-place.
  - sandbox-bridge.test.ts: placeAnchor locates a snippet with embedded newline+indentation whitespace.
  Existing tests to keep green: sandbox-bridge.test.ts, the bridge handshake tests, markdown
  annotation-marks tests.

Suggested fix approach:
  ☑ Targeted refactor (split the placement path by doc kind: markdown→light-DOM placeAnnotations,
    html→bridge postHighlight for the whole set + onPlaceFailed→unplaceable). Root cause is a missing
    path, not a one-line bug.

→ To fix: run `/mf-fix docs/investigate/html-annotation-couldnt-place-2026-06-16.md`

─── OPEN QUESTIONS ───
- Issue is SEPARATE from (but on the same doc as) the theme-switch script crash
  ("localStorage … document is sandboxed and lacks allow-same-origin"). That is a different bug
  (the doc's own script needs an in-iframe storage shim); it does NOT affect the bridge (bridge
  touches no storage). Track separately.
- Does the in-iframe bridge (backend sandbox-bridge.ts) currently accept + act on a `highlight`
  message for an arbitrary annotation id (vs only echoing the just-created one)? Confirm the draw
  path handles a batch / arbitrary set, else the fix must extend it too.
════════════════════════════════════════════════════════════════
