# Annotation parity + fixes — review matrix (2026-06-17)

State after this session. Servers: backend `:3007` (non-hot), web `:5173`. Suites: web 453/0, backend 752/0, typecheck clean.

## A. Mark / highlight capability — Markdown (app DOM) vs HTML (sandbox iframe via bridge)

| # | Capability | Markdown | HTML (iframe) | Notes |
|---|---|---|---|---|
| 1 | Draw existing on load | ✅ | ✅ | HTML: posted to the in-iframe bridge on handshake |
| 2 | Draw on create | ✅ | ✅ | |
| 3 | Cross-block / table selection → segment per leaf cell | ✅ | ✅ (create-side bridge) | leaf-filter drops ol/li/tr/table ancestors |
| 4 | Snippet matches at placement (no false "couldn't place") | ✅ | ✅ | snippet sliced from `textContent`, not `selection.toString()` |
| 5 | Multi-node / container range wraps (no `surroundContents` throw) | ✅ | ✅ | per-text-node wrap both sides |
| 6 | Rail quote shows the FULL multi-segment selection | ✅ | ✅ | joins segment snippets (was just block 1) |
| 7 | App highlight style (teal accent), not browser-yellow | ✅ | ✅ | HTML: `.anno-mark` stylesheet injected into the iframe |
| 8 | Type/label hue (Comment amber · Label gold · Redline red · Markup teal) | ✅ | ✅ | same 4-tool palette; hue carried in the bridge payload |
| 9 | Resolved → dim | ✅ | ✅ | `data-resolved` + injected rule |
| 10 | Redline → red strikethrough | ✅ | ✅ | `data-anno-kind=redline` |
| 11 | Stale redline → muted/dashed (not confident strike) | ✅ | ✅ | `data-anno-stale`; stale wins over redline |
| 12 | Delete removes the highlight | ✅ | ✅ | HTML: clear-then-redraw sync (was additive → stale mark) |
| 13 | Restore re-draws | ✅ | ✅ | |
| 14 | Couldn't-place reported (not crash) | ✅ | ✅ | `onPlaceFailed` relayed + reset per sync |
| 15 | Click highlight → focus thread | ✅ | ✅ | HTML: `mark-click` relayed up the port |
| 16 | Focus thread → scroll to + emphasize highlight | ✅ | ✅ | HTML: `postFocus` → in-iframe `scrollIntoView` + `anno-mark--focus` |

Live-verified on `/d/shield-infrastructure-9o4d6l` (HTML): 5 cards, **0 couldn't-place**, marks render app-styled (not yellow). Interactive bits (delete-removal, state appearance, click/scroll) are unit-tested; flagged `[→MANUAL]` for a human spot-check in the browser (the opaque iframe can't be DOM-inspected from the parent / happy-dom).

## B. Rail-item / attribution + action model

| # | Behavior | Status |
|---|---|---|
| 17 | Own annotation shows REAL name + avatar (no "You" relabel) | ✅ live: shield shows "Demo User", 0 "You" |
| 18 | own-vs-others is INTERNAL (drives gates only, no visible marker) | ✅ |
| 19 | 2-family action bar (Remark→Resolve · Proposal→Accept/Reject owner-only) | ✅ (built earlier) |
| 20 | Owner CANNOT self-approve own proposal (Resolve, not Accept/Reject) | ✅ + no longer flashes during session load (withheld until session resolves) |
| 21 | Delete in overflow (author or owner) + undo toast | ✅; toast now styled (was unstyled) |
| 22 | Pending / decided / stale status surface in the rail | ✅ |
| 23 | Quote capped 3 lines + expand; type-chip own line | ✅ |
| 24 | Rail-item layout matches the locked ASCII (header→chip→quote→divider→2-slot bar) | ✅ |

## C. Toolbar / colours

| # | Item | Status |
|---|---|---|
| 25 | Active toolbar tool reads clearly (was faint 12% → 20%) | ✅ |
| 26 | Marks 4-tool palette, readable strength (was faint 15% → 26%) | ✅ |

## D. Specs touched this session

| Spec | Mode | What |
|---|---|---|
| `annotation-html-marks.md` | A (new) | HTML iframe mark parity — 4 stories (S-001 style+hue · S-002 states · S-003 delete-sync · S-004 click/scroll). Built + 19/19 AS-C covered. |
| `annotation-actions-ui.md` | C | own is internal + real name+avatar (drop "You"); owner-decide withheld until session resolves. Built. |
| `annotation-core-ui-types-modes.md` | C (earlier) | de-staled (durable `authorId` supersedes root-comment model). |

## E. Data state (dev)

- Backfilled `author_id` from each annotation's root-comment author (26 rows) → old annotations now recognised as own by the gates. 7 remain null = genuine guests.
- Deleted 2 stale broken-anchor (tab-snippet) annotations.
- Restored shield's 5 (were soft-deleted from delete-flow testing).

## F. Known follow-ups / NOT done

- **Theme-switch script in HTML docs** — the doc's own `localStorage` use crashes under the opaque-origin sandbox (no `allow-same-origin`). SEPARATE bug; proposed fix = inject an in-memory storage shim. NOT done.
- **Whole-table selection** anchored across the WHOLE table places per-leaf-cell correctly; a selection whose endpoint resolves outside any block falls back to the start block (partial). Edge, low priority.
- The `[→MANUAL]` HTML interactions (delete-removal, state styling, click/scroll) — recommend a 2-minute human spot-check in the browser.
- v0 clusters still unbuilt: `mcp-roundtrip`, `self-host`, image-region annotation UI.
