// IIFE entry for the in-iframe sandbox bridge. `bun build --target browser --format iife` of THIS
// file produces a string the backend bridge inlines into the served (opaque-origin) iframe — the
// bridge cannot `import` server modules at runtime, so the shared anchor logic is compiled in here
// (one source, no hand-mirrored drift; the iframe inherits the FE's normalize + fuzzy tiers).
//
// It exposes the PURE anchor fns on a single global namespace the bridge glue calls. The bridge glue
// (MessageChannel handshake, wrapTextRange DOM mutation, drawHighlight, focusAnno, mark-click relay)
// stays in the backend bridge script and reads `selectionToAnchor` / `placeAnchorAll` from here.

import { selectionToAnchor, placeAnchorAll, unwrapAnnoMarks } from "./anchor";
import { BLOCK_SELECTOR, SNIPPET_CAP } from "./types";

// Attach to the frame global the bridge glue reads (`window.__anchordAnchor`). In the sandboxed
// iframe `window === globalThis`; resolve `window` off globalThis (no `lib.dom` so it isn't named
// directly) and fall back to globalThis so the artifact is environment-agnostic.
const g = globalThis as unknown as Record<string, unknown>;
const target: Record<string, unknown> = (g.window as Record<string, unknown> | undefined) ?? g;

target.__anchordAnchor = {
  selectionToAnchor,
  placeAnchorAll,
  unwrapAnnoMarks,
  BLOCK_SELECTOR,
  SNIPPET_CAP,
};
