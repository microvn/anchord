INVESTIGATION REPORT
════════════════════════════════════════════════════════════════

Target:   TOC "outline" left sidebar in the doc viewer populates sometimes, empty other times
Date:     2026-06-11
Status:   ROOT_CAUSE_FOUND

─── SUMMARY ───
The TOC derives its headings in a `useEffect` keyed ONLY on the content ELEMENT reference
(`apps/web/src/features/viewer/toc-sidebar.tsx:67-73`), but that element — the viewer's
`<main ref={setDocPaneEl}>` — is a STABLE DOM node whose inner content only arrives once the
doc query resolves. The element reference never changes when the doc loads, so the extraction
effect never re-runs, and the TOC stays empty. It only populates when the doc query is already
warm (cached) so the very first render already contains the headings. Hence "lúc chạy lúc không":
it tracks whether the doc was cached, not anything random.

─── SYMPTOM ───
Expected: TOC sidebar lists the doc's h1–h3 headings whenever a doc is open.
Actual:   TOC is empty on a fresh load; populated when the doc was visited before this session.
Frequency: Intermittent from the user's POV; deterministic given TanStack Query cache state.

─── ROOT CAUSE ───
HYPOTHESIS A (PRIMARY — HIGH)
  Location:  apps/web/src/features/viewer/toc-sidebar.tsx:67-73 (the extract effect)
             + apps/web/src/features/viewer/viewer-screen.tsx (the contentEl wiring)
  Mechanism: A React effect-dependency staleness. The TOC's heading extraction runs in
             `useEffect(() => setHeadings(extractHeadings(contentEl)), [contentEl])`. Its only
             dependency is `contentEl`. In viewer-screen, `contentEl` is `docPaneEl`, set by the
             callback ref on `<main ref={setDocPaneEl}>` (viewer-screen.tsx:183). That `<main>`
             is rendered by ViewerShell for the loading, error, AND success states — same tree
             position, so React reconciles it as ONE element that does NOT unmount/remount when
             the screen goes loading → success. The callback ref therefore fires exactly once
             (node mounts during the loading/skeleton render) and never again. The doc's actual
             headings are injected later, into that same `<main>`, by MarkdownView's
             `dangerouslySetInnerHTML` (markdown-view.tsx:10-15) once the query resolves — but
             `contentEl`'s REFERENCE is unchanged, so the `[contentEl]` effect never re-runs and
             `headings` stays `[]`.
  Chain:
    fresh doc open
      → useApiQuery pending → ViewerShell renders loading skeleton inside <main>
      → <main> mounts → setDocPaneEl(main) → contentEl = main (no headings yet)
      → TocSidebar effect runs once: extractHeadings(main) → [] → setHeadings([])
      → query resolves → success render reuses the SAME <main>; DocPane/MarkdownView injects
        the heading HTML into it
      → contentEl reference UNCHANGED → [contentEl] effect does NOT re-run
      → headings stays [] → TOC renders empty
    (cached doc open: first render is already success → <main> mounts WITH headings present →
     ref fires → effect extracts them → TOC populates. This is the "lúc chạy" case.)
  Evidence:
    - toc-sidebar.tsx:67-73 — extract effect dependency array is `[contentEl]` only; nothing
      keyed to the doc content/identity.
    - viewer-screen.tsx:183 — `<main ref={setDocPaneEl}>` is the contentEl source; the same
      `<main>` is emitted by the loading, error, and success branches (all render `<ViewerShell>`
      at the root, reconciled as one instance), so the node is stable across loading→success.
    - markdown-view.tsx:10-15 — headings exist only after `dangerouslySetInnerHTML` injects the
      server HTML, which happens on the success render (after the loading render that set contentEl).
    - Contrast: the scroll-spy effect (toc-sidebar.tsx:77-90) keys on `[contentEl, headings]`, and
      the highlight placement (annotation-marks) keys on `[contentEl, annotations]` — both have a
      second dependency that changes after the content loads, so they recover; the extract effect
      is the only one keyed on contentEl ALONE, so it alone gets stuck.
  Disproof: If the TOC were populated on a hard fresh load (cleared query cache, first-ever visit
            to the slug this session), this hypothesis is wrong. It predicts: empty on cold load,
            populated on warm/repeat load.
  Confidence: HIGH

  Verification (read-only):
    1. Open a doc you have NOT opened this session (cold cache) → TOC empty.
    2. Navigate away and back to the SAME doc (now warm) → TOC populated. Same doc, opposite result
       ⇒ cache-timing, not data.
    3. (Instrumentation, needs a temp edit) log `extractHeadings(contentEl).length` inside the
       effect — fires once with 0 on the cold path, never re-fires.

─── REGRESSION? ───
No — pre-existing since the TOC was built this way (annotation-core-ui S-002). Not introduced by
a recent diff.

─── RECURRING? ───
No — first known bug here. But it is the SAME CLASS as the recent viewer bugs in this session
("tested with content present, live wiring differs"): the unit test feeds an element that already
contains the headings, so it never exercises the set-empty-then-fill-later sequence.

─── BLAST RADIUS ───
Scope: ISOLATED (the extract effect in one component).
Direct impact:
  - toc-sidebar.tsx — `headings` stays empty on the cold-load path → empty outline; the search
    filter + scroll-spy + jump are all dead too (they have no headings to act on).
User-facing impact:
  - Viewer left pane (S-002 outline) — empty on a fresh doc open; AS-005/AS-006 (jump + scroll-spy)
    silently do nothing because `headings` is empty.
No data, cache, or backend impact — purely a client render-timing bug.

─── SIMILAR RISK ───
Scanned the sibling viewer effects that also read from `contentEl`:
  - toc-sidebar.tsx:77-90 (scroll-spy) — keyed `[contentEl, headings]`; recovers once headings
    fill, so NOT at risk on its own (but it's downstream of the broken extract, so it stays idle
    until the extract is fixed).
  - annotation-marks (useAnnotationMarks, viewer-screen useAnnotations) — keyed on the annotations
    list too, which arrives async and changes, so placement re-runs after content loads. Lower
    risk, but worth a glance: if a doc has content but ZERO annotations, the placement effect's
    re-run still depends on the annotations array identity — verify it tolerates the same
    "content arrives after element ref" ordering. Likely fine; note for the fixer.
Pattern: a `useEffect` that reads mutable DOM content but is keyed only on the container element
reference — the meaningful input (content) is not in the dependency array.

─── RECOMMENDED ACTIONS ───
1. [HIGH] Make the heading-extraction re-run when the doc CONTENT is ready, not only when the
   element ref changes (toc-sidebar.tsx:67-73).
   Option A (smallest): give TocSidebar a `contentKey` prop derived from the doc identity (e.g.
     `${slug}@${doc.version}`, or the html string / its length) and add it to the effect deps:
     `useEffect(..., [contentEl, contentKey])`. viewer-screen has `doc.doc.version` + slug + the
     content in scope to build it. Re-runs extraction when content arrives and on version switch.
   Option B (most robust, no prop threading): observe the content element with a MutationObserver
     inside the effect and re-extract on childList/subtree mutations (disconnect on cleanup).
     Handles late hydration, version switches, and any future async content with no caller change.
   Reason: the extract must depend on the content, not just the container node.
   Estimated scope: 1 file (Option A also touches viewer-screen to pass the key), complexity LOW.

Test strategy:
  - Regression test (the gap that hid this): render TocSidebar with `contentEl` set to an EMPTY
    element FIRST, then inject headings into that same element and bump `contentKey` (or trigger
    the MutationObserver) → assert the outline goes from empty to populated WITHOUT swapping the
    element reference. The current test (viewer-toc.test.tsx) only ever passes a pre-filled host
    (mountDoc sets innerHTML before mount), so it cannot catch this.
  - Better: a viewer-screen-level test that mounts with the doc query PENDING (mock resolves on a
    tick), then asserts the TOC populates after the doc resolves — exercises the real loading→
    success sequence on the stable `<main>`.
  - Existing tests to keep green: viewer-toc.test.tsx (extractHeadings, pickActiveHeading, jump).
  - Manual: open a doc with several headings on a COLD load (clear cache / hard refresh) → TOC
    must populate; switch to another doc → TOC must update.

Suggested fix approach:
  ☑ Minimal fix (Option A) — blast radius is ISOLATED; one effect dependency + one prop.

→ To fix: run `/mf-fix docs/investigate/toc-outline-flaky-2026-06-11.md`

════════════════════════════════════════════════════════════════
