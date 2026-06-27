import { z } from "zod";

// Parent-side sandbox bridge (S-002, AS-004/AS-005, C-001/C-002/C-009).
//
// WHAT THIS IS. An HTML doc renders inside a sandboxed, opaque-origin iframe (html-sandbox-frame:
// `sandbox="allow-scripts"`, no allow-same-origin). The parent CANNOT read that iframe's DOM or its
// text selection — cross-origin. So the backend injects a tiny bridge script INSIDE the iframe
// (annotation-core `sandbox-bridge.ts`, commit 0c49d53) that, on load, creates a `MessageChannel`,
// keeps `port1`, and posts `{source:'anchord-bridge', type:'ready', nonce}` UP to the parent with
// `port2` transferred. This module is the PARENT half: it accepts that one handshake, keeps the
// transferred port as the SOLE transport, and relays the iframe's selection hints into the app's
// existing compose flow (S-001). A highlight goes back DOWN the same port (the parent cannot draw
// into the opaque iframe itself).
//
// SECURITY MODEL (C-002 / C-001 — documented because the nonce is NOT a secret):
//  - DEDICATED CHANNEL, NOT window.postMessage. After the handshake, selection traffic flows ONLY
//    over the transferred port. A body script that calls `parent.postMessage({...annotation...})`
//    lands on the parent's WINDOW listener — which, after the first ready, we deliberately ignore —
//    never on the port. So a forged body message cannot become a selection or a create (AS-005).
//  - NO ORIGIN TRUST. The iframe origin is opaque ("null"); origin checks are useless (C-009). The
//    handshake identity is `event.source === iframe.contentWindow`. We accept the FIRST such ready
//    and ignore every later window message as a transport.
//  - NONCE IS NOT THE GUARANTEE. The nonce ARRIVES IN the ready message, so it is not an independent
//    secret — a body script shares the iframe's contentWindow and could post a ready too. The bridge
//    channel is therefore DEFENSE-IN-DEPTH, not the authz boundary. The HARD guarantee that a forged
//    "create this annotation" can never succeed is SERVER-SIDE RE-AUTHORIZATION (C-001): the only
//    create path is the app's own authorized client call (S-001 `createAnnotation`), which the server
//    re-checks against the session role regardless of what any message claimed. This module never
//    turns a window message into a create — it only ever opens the composer from a PORT selection.

/** The anchor shape the in-iframe bridge sends over the port (mirrors backend `Anchor`). */
export interface BridgeAnchor {
  blockId: string;
  textSnippet: string;
  offset: number;
  length: number;
  segments?: { blockId: string; textSnippet: string; offset: number; length: number }[];
}

/** S-002/C-003: the lifecycle STATE flags carried on a highlight so the in-iframe mark reproduces
 *  the markdown mark's appearance. `resolved` → dim; `kind:"redline"` → red strikethrough;
 *  `stale` → muted/dashed (a stale redline reads muted/dashed, not a confident strike). */
export interface BridgeHighlightState {
  resolved?: boolean;
  kind?: "redline";
  stale?: boolean;
  /** S-007 (C-009): the mark's status chip is toggled OFF → the in-iframe highlight is DIMMED
   *  (de-emphasized), mirroring the markdown placer's `data-anno-filtered`. */
  filtered?: boolean;
}

/** One item in a full-set highlight batch (S-003) — the anchor + id + hue + lifecycle state. */
export interface BridgeHighlightItem extends BridgeHighlightState {
  anchor: BridgeAnchor;
  annotationId: string;
  hue?: string;
  /** pinpoint S-004/AS-012 (C-002): `"block"` → the in-iframe bridge outlines the whole block ELEMENT
   *  (data-block-anno) instead of wrapping a text range. Absent/undefined → a range highlight. */
  type?: "block";
}

/** A selection hint relayed from the iframe over the trusted port. `anchor === null` → clear. */
export interface BridgeSelection {
  type: "selection";
  anchor: BridgeAnchor | null;
  rect?: { x: number; y: number; width: number; height: number } | null;
}

/** A placement failure relayed from the iframe (a highlight the bridge couldn't draw in-iframe). */
export interface BridgePlaceFailed {
  type: "place-failed";
  annotationId: string;
}

/** MƯỢT TASK 3: a fresh selection rect relayed on the iframe's own in-iframe scroll (rAF-throttled
 *  in the in-iframe bridge). `rect === null` → the selection scrolled out of view → clear. */
export interface BridgeSelectionRect {
  type: "selection-rect";
  rect: { x: number; y: number; width: number; height: number } | null;
}

/** A relayed rect in IFRAME-LOCAL coordinates. annotation-hover-card S-003 / C-006. */
export interface BridgeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── annotation-hover-card S-003 / C-006 — UNTRUSTED relayed-message validation ──────────────
//
// Every message that arrives over the port from the sandboxed iframe is UNTRUSTED input (a hostile
// body script shares the iframe's contentWindow and can post over the channel). C-006 mandates:
//   1. Zod-parse every relayed message at the parent boundary (a shape that doesn't match → ignored).
//   2. Its annotationId is looked up in the loaded, role-filtered set; a miss is a NO-OP (no card).
//   3. Its rect is REJECTED when non-finite/negative/over-viewport, and the card position is CLAMPED
//      to the viewport.
// The card itself is PRESENTATION over server-trusted content (C-003): it renders only from the
// already-loaded ViewerAnnotation, never from anything in the message — so even a forged-but-known id
// can only surface data the user is already allowed to see; the message carries no text.

/** A finite, non-negative rect — the parse-level guard before clamping (C-006). Non-finite (NaN,
 *  ±Infinity) and negative width/height are rejected here; x/y may be negative (off-screen left/top
 *  is legitimate before clamping). */
const finite = z.number().refine(Number.isFinite, "non-finite");
const rectSchema = z.object({
  x: finite,
  y: finite,
  width: finite.refine((n) => n >= 0, "negative"),
  height: finite.refine((n) => n >= 0, "negative"),
});

/** The relayed-message schemas (C-006). A `.nullable()` rect tolerates the bridge posting `rect:null`
 *  when it can't read one; an invalid rect SHAPE makes the whole message fail parse (→ ignored). */
const markEventSchema = z.object({
  type: z.enum(["mark-click", "mark-enter", "mark-rect"]),
  annotationId: z.string().min(1),
  rect: rectSchema.nullable().optional(),
});
const markLeaveSchema = z.object({
  type: z.literal("mark-leave"),
  annotationId: z.string().min(1),
});

/** pinpoint S-004/AS-010/AS-011 (C-005): a relayed Pinpoint block-pick from the sandboxed iframe.
 *  UNTRUSTED — Zod-validated here at the parent boundary exactly like the hover-card relay: `blockId`
 *  must be a non-empty string and any `rect` is finite + non-negative (a malformed/NaN/negative rect
 *  fails parse → the whole message is dropped, never routed). The parent does NOT pre-check the
 *  blockId against the iframe DOM (cross-origin/opaque) — an unresolvable id is stored verbatim and
 *  the matcher orphans it, symmetric with the existing range relay. The rect is reused (the same
 *  `rectSchema`) to position the synthesized 5-type popover. */
const blockPickSchema = z.object({
  type: z.literal("block-pick"),
  blockId: z.string().min(1),
  rect: rectSchema.nullable().optional(),
  // C-002: the block's full text rides along so the parent builds the durable whole-block anchor
  // (textSnippet capped + UTF-16 length) — the parent can't read the opaque iframe DOM to get it
  // itself. UNTRUSTED like the rest of the message: it is stored as quote/anchor text only and
  // rendered as literal text (C-003, the existing plaintext rule), never interpreted. Optional so an
  // older bridge (no text) still parses — the parent then degrades to a blockId-only anchor.
  text: z.string().optional(),
});

/** The discriminated union of EVERY message the in-iframe bridge may relay over the port (C-006). A
 *  message that matches none (a forged `{annotation:…}`, a garbage shape) → `success:false` → ignored. */
export const relayedMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("selection"), anchor: z.unknown().nullable().optional(), rect: rectSchema.nullable().optional() }),
  z.object({ type: z.literal("selection-rect"), rect: rectSchema.nullable() }),
  z.object({ type: z.literal("place-failed"), annotationId: z.string().min(1) }),
  markEventSchema,
  markLeaveSchema,
  blockPickSchema,
]);
export type RelayedMessage = z.infer<typeof relayedMessageSchema>;

/**
 * clampRectToViewport — C-006 (AS-027): reject a non-finite/negative/over-viewport rect and clamp the
 * accepted one into the viewport so a forged or absurd rect can never push the card off-screen.
 *
 * Returns `null` when the rect is unusable (non-finite, negative size, or so oversized/off-screen it
 * has no on-screen intersection) — the caller then opens NO card. Otherwise returns a rect clamped to
 * [0, viewport]: x/y clamped to the viewport box, width/height clamped so the rect never extends past
 * the viewport edge. Pure (no DOM), so it is unit-tested with synthetic rects + viewports.
 */
export function clampRectToViewport(rect: BridgeRect, viewport: { width: number; height: number }): BridgeRect | null {
  const parsed = rectSchema.safeParse(rect);
  if (!parsed.success) return null;
  const { x, y, width, height } = parsed.data;
  // An over-viewport rect (≥ a full viewport in either axis) is absurd for a single mark → reject so
  // a `{width:1e9,height:1e9}` forgery opens nothing rather than a giant clamped box (AS-027).
  if (width > viewport.width || height > viewport.height) return null;
  // No on-screen intersection (entirely past the right/bottom edge, or entirely above/left) → reject.
  if (x >= viewport.width || y >= viewport.height || x + width <= 0 || y + height <= 0) return null;
  // Clamp to the VISIBLE intersection with the viewport: a left/top overflow shifts the origin to 0
  // and shrinks the size by the clipped amount; a right/bottom overflow shrinks the far edge to the
  // viewport edge. So a partly off-screen mark anchors the card to the part actually on-screen.
  const cx = Math.max(x, 0);
  const cy = Math.max(y, 0);
  const cw = Math.min(x + width, viewport.width) - cx;
  const ch = Math.min(y + height, viewport.height) - cy;
  return { x: cx, y: cy, width: cw, height: ch };
}

/** isKnownAnnotationId — C-006 (AS-027): a relayed annotationId is acted on ONLY when it is in the
 *  loaded, role-filtered set; a miss is a no-op (no card opens). Pure membership check, unit-tested. */
export function isKnownAnnotationId(annotationId: string, loadedIds: ReadonlySet<string>): boolean {
  return loadedIds.has(annotationId);
}

export interface BridgeHandlers {
  /** A real (non-null-anchor) selection arrived over the port → open the composer prefilled. */
  onSelection: (anchor: BridgeAnchor, rect: { x: number; y: number; width: number; height: number } | null) => void;
  /** The iframe cleared its selection (anchor null) → dismiss any pending compose popover. */
  onClearSelection?: () => void;
  /** The in-iframe bridge could not place a highlight for this annotation (optional). */
  onPlaceFailed?: (annotationId: string) => void;
  /** S-004/AS-011 (C-005) + annotation-hover-card S-003/AS-016: a click on a [data-anno] highlight
   *  inside the iframe was relayed up the port → focus the rail thread AND pin the card at the mark.
   *  The CLICKED mark's iframe-local rect rides along (C-008) so the parent can anchor the pinned
   *  popover outside the sandbox; `rect` is null when the bridge couldn't read it. The rect is
   *  Zod-validated before this fires (C-006); the parent still translates + clamps it. */
  onMarkClick?: (annotationId: string, rect: BridgeRect | null) => void;
  /** S-003/AS-015 (peek): the cursor entered a [data-anno] mark in the iframe → start the dwell and
   *  (after it) show the peek at the mark's translated rect. Zod-validated (C-006). */
  onMarkEnter?: (annotationId: string, rect: BridgeRect | null) => void;
  /** S-003/AS-015 (peek): the cursor left the mark (and did not move to a same-id sibling) → cancel
   *  the dwell / hide the peek. */
  onMarkLeave?: (annotationId: string) => void;
  /** S-003/AS-021: the iframe re-posted the hovered/pinned mark's rect on its own in-iframe scroll →
   *  reposition or auto-close the pinned card (the parent can't see the iframe scroll). A null rect
   *  (mark gone) → treat as scrolled-out. Zod-validated (C-006). */
  onMarkRect?: (annotationId: string, rect: BridgeRect | null) => void;
  /** pinpoint S-004/AS-010 (C-001/C-005): a Pinpoint block-pick was relayed from the iframe → route
   *  it into the SAME beginBlockCompose/create the markdown pick uses. The picked block's iframe-local
   *  rect rides along (the parent translates + clamps it to position the synthesized 5-type popover);
   *  `rect` is null when the bridge couldn't read it. Zod-validated before this fires (C-005) — a
   *  malformed rect already dropped the message. The parent does NOT pre-validate the blockId against
   *  the opaque iframe DOM; a forged/unresolvable id is stored verbatim and the matcher orphans it. */
  onBlockPick?: (blockId: string, rect: BridgeRect | null, text: string) => void;
  /** HTML-PLACE: the handshake was accepted and the port captured. Fires ONCE (the first trusted
   *  ready binds the transport). The parent uses this to flush the existing annotation set down the
   *  port — `postHighlight` no-ops before this, so a naive post-on-mount would race the handshake. */
  onReady?: () => void;
  /** MƯỢT TASK 3: the iframe re-posted the live selection's rect on its own scroll → reposition the
   *  open popover. A null rect means the selection scrolled out of view → dismiss. */
  onSelectionRect?: (rect: { x: number; y: number; width: number; height: number } | null) => void;
}

/** A minimal window-message event shape (so the predicate type-checks without lib.dom specifics). */
interface ReadyLikeEvent {
  data: unknown;
  source: unknown;
  ports?: ReadonlyArray<MessagePort>;
}

/**
 * isTrustedReady — the PURE accept-predicate for the handshake (AS-005 / C-002), unit-testable
 * without a real cross-document `event.source`. A window message is the trusted ready ONLY when:
 *   1. it originates from the iframe's own contentWindow (`event.source === iframeWindow`), AND
 *   2. its data is `{ source: 'anchord-bridge', type: 'ready', nonce: <string> }`, AND
 *   3. it carries a transferred port in `event.ports[0]`.
 * Origin is NOT checked (opaque/null — C-009). The nonce is required to be present but is not an
 * independent secret (see security model above); the hard backstop is server-side re-authz (C-001).
 * Everything else — a forged `{annotation:…}`, a `parent.postMessage` from the body, a ready whose
 * source is not the contentWindow, a ready with no port — returns false and is ignored.
 */
export function isTrustedReady(event: ReadyLikeEvent, iframeWindow: unknown): boolean {
  if (!iframeWindow || event.source !== iframeWindow) return false;
  const data = event.data;
  if (!data || typeof data !== "object") return false;
  const msg = data as Record<string, unknown>;
  if (msg.source !== "anchord-bridge" || msg.type !== "ready") return false;
  if (typeof msg.nonce !== "string") return false;
  const port = event.ports?.[0];
  return Boolean(port);
}

/** The live bridge connection the parent talks over. */
export interface BridgeConnection {
  /** Send a highlight DOWN the port so the in-iframe bridge wraps the range in a <mark>. `hue` (the
   *  per-type/label mark colour) is applied as the mark's --mark-hue so it matches the markdown mark.
   *  S-002/C-003: `resolved`/`kind`/`stale` carry the lifecycle STATE so the in-iframe mark reads like
   *  the markdown one (resolved → dim, redline → red strike, stale → muted/dashed). */
  postHighlight: (anchor: BridgeAnchor, annotationId: string, opts?: BridgeHighlightState) => void;
  /** S-003: send the FULL current highlight set DOWN the port as one batch so the in-iframe bridge
   *  runs a clear-then-redraw (unwrap ALL anno marks, then draw the set) — idempotent (C-002): a
   *  deleted id (absent from `items`) has its mark removed, a restored/new id is (re)drawn, with no
   *  duplicates. No-op before the handshake (no port yet), like `postHighlight`. */
  postHighlights: (items: BridgeHighlightItem[]) => void;
  /** S-004/AS-012 (C-005): ask the in-iframe bridge to emphasise + scroll to the mark for this
   *  annotation id (the parent can't reach the opaque iframe — it posts focus over the port). A null
   *  id clears all emphasis. No-op before the handshake (no port yet), like `postHighlight`. */
  postFocus: (annotationId: string | null) => void;
  /** pinpoint S-004/AS-010 (C-001): toggle Pinpoint mode in the in-iframe bridge so a block click
   *  relays a block-pick (Select mode = inert). No-op before the handshake, like the other posts. */
  postPinpoint: (enabled: boolean) => void;
  /** True once the handshake has been accepted and the port captured. */
  isConnected: () => boolean;
  /** Remove the window listener + close the port. Idempotent. */
  dispose: () => void;
}

/**
 * connectBridge — wire the PARENT side of the bridge for one iframe (S-002).
 *
 * It adds a single `window` 'message' listener and waits for the FIRST trusted ready
 * (`isTrustedReady`) from this iframe's contentWindow. On that one message it captures
 * `event.ports[0]` as the sole transport and STOPS treating any further window message as a
 * transport (later readies, forged `{annotation:…}` from the body, etc. are ignored — AS-005).
 * Thereafter only `port.onmessage` selection hints reach `handlers.onSelection`; a create only ever
 * happens through the app's authorized client (S-001), re-authorized server-side (C-001).
 *
 * Returns a connection with `postHighlight` (parent → iframe, over the port) and `dispose`.
 */
export function connectBridge(
  iframe: { contentWindow: unknown },
  handlers: BridgeHandlers,
  win: { addEventListener: typeof window.addEventListener; removeEventListener: typeof window.removeEventListener } = window,
): BridgeConnection {
  let port: MessagePort | null = null;
  let disposed = false;

  const onWindowMessage = (event: MessageEvent) => {
    if (disposed) return;
    // Once the port is captured, the window channel is no longer a transport — ignore EVERYTHING
    // on it (AS-005: a body `parent.postMessage` lands here, never on the port; reject it).
    if (port) return;
    if (!isTrustedReady(event as unknown as ReadyLikeEvent, iframe.contentWindow)) return;

    // Accept the first trusted ready: capture its transferred port as the sole transport.
    port = event.ports[0]!;
    port.onmessage = (ev: MessageEvent) => {
      if (disposed) return;
      // C-006 (AS-027): Zod-parse EVERY relayed message at the boundary. A shape that matches none of
      // the protocol schemas (a forged `{annotation:…}`, a garbage payload, a bad rect) fails parse
      // and is dropped — never duck-typed. The rect inside an accepted message is finite + non-negative
      // (the schema rejects NaN / Infinity / negative size); the caller still translates + clamps it
      // against the live viewport, and looks the annotationId up in the loaded set (a miss = no card).
      const parsed = relayedMessageSchema.safeParse(ev.data);
      if (!parsed.success) return;
      const msg = parsed.data;
      if (msg.type === "selection") {
        if (msg.anchor) {
          handlers.onSelection(msg.anchor as BridgeAnchor, msg.rect ?? null);
        } else {
          // anchor === null → the iframe cleared its selection; drop any pending compose.
          handlers.onClearSelection?.();
        }
      } else if (msg.type === "selection-rect") {
        // MƯỢT TASK 3: a scroll re-post of the live selection rect. A null rect = scrolled out of
        // view → treat as a clear (dismiss); a rect = reposition the open popover.
        if (msg.rect) handlers.onSelectionRect?.(msg.rect);
        else handlers.onClearSelection?.();
      } else if (msg.type === "place-failed") {
        handlers.onPlaceFailed?.(msg.annotationId);
      } else if (msg.type === "mark-click") {
        // S-004/AS-011 (C-005) + S-003/AS-016: a highlight click → focus its rail thread + pin the
        // card at the mark. The rect (iframe-local) rides along; the caller translates + clamps it.
        handlers.onMarkClick?.(msg.annotationId, msg.rect ?? null);
      } else if (msg.type === "mark-enter") {
        // S-003/AS-015: hover entered a mark → the caller runs the dwell then shows the peek.
        handlers.onMarkEnter?.(msg.annotationId, msg.rect ?? null);
      } else if (msg.type === "mark-leave") {
        // S-003/AS-015: hover left the mark (not to a same-id sibling) → cancel dwell / hide peek.
        handlers.onMarkLeave?.(msg.annotationId);
      } else if (msg.type === "mark-rect") {
        // S-003/AS-021: the mark's rect re-posted on in-iframe scroll → reposition / auto-close.
        handlers.onMarkRect?.(msg.annotationId, msg.rect ?? null);
      } else if (msg.type === "block-pick") {
        // pinpoint S-004/AS-010 (C-005): a Pinpoint block click in the iframe → route the blockId +
        // (iframe-local) rect into the parent's block create. The rect is already finite/non-negative
        // (schema); the caller translates + clamps it. The blockId is stored verbatim — an unresolvable
        // one orphans (AS-011), the SAME outcome a forged range anchor has; no DOM pre-check possible.
        handlers.onBlockPick?.(msg.blockId, msg.rect ?? null, msg.text ?? "");
      }
    };
    port.start?.();
    // HTML-PLACE: the transport is live now → let the parent flush the existing annotation set
    // (postHighlight silently dropped before this). Fires once (a later ready can't rebind — `port`
    // is set, so onWindowMessage early-returns above).
    handlers.onReady?.();
  };

  win.addEventListener("message", onWindowMessage);

  return {
    postHighlight(anchor, annotationId, opts) {
      // The parent cannot draw into the opaque iframe; it asks the in-iframe bridge to, over the
      // port. No port yet (handshake not done) → nothing to do. `hue` carries the per-type/label
      // mark colour (S-001/AS-002); resolved/kind/stale carry the lifecycle state (S-002/C-003) so
      // the in-iframe mark matches the markdown mark's resolved/redline/stale appearance.
      port?.postMessage({ type: "highlight", anchor, annotationId, ...opts });
    },
    postHighlights(items) {
      // S-003: one batch carrying the WHOLE live set → the in-iframe bridge unwraps all anno marks
      // then redraws this set (clear-then-redraw, C-002). No port yet (pre-handshake) → drop, like
      // postHighlight, so a naive post-on-mount can't race the handshake.
      port?.postMessage({ type: "highlights", items });
    },
    postFocus(annotationId) {
      // S-004/AS-012 (C-005): the parent focused a rail thread → ask the in-iframe bridge to
      // emphasise + scroll to the matching mark. No port yet (pre-handshake) → drop, like the others.
      port?.postMessage({ type: "focus", annotationId });
    },
    postPinpoint(enabled) {
      // pinpoint S-004/AS-010 (C-001): toggle the in-iframe block-pick gate. Pre-handshake → drop.
      port?.postMessage({ type: "pinpoint", enabled });
    },
    isConnected() {
      return port !== null;
    },
    dispose() {
      disposed = true;
      win.removeEventListener("message", onWindowMessage);
      if (port) {
        port.onmessage = null;
        port.close?.();
        port = null;
      }
    },
  };
}
