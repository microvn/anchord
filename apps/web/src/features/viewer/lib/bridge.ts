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

export interface BridgeHandlers {
  /** A real (non-null-anchor) selection arrived over the port → open the composer prefilled. */
  onSelection: (anchor: BridgeAnchor, rect: { x: number; y: number; width: number; height: number } | null) => void;
  /** The iframe cleared its selection (anchor null) → dismiss any pending compose popover. */
  onClearSelection?: () => void;
  /** The in-iframe bridge could not place a highlight for this annotation (optional). */
  onPlaceFailed?: (annotationId: string) => void;
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
   *  per-type/label mark colour) is applied as the mark's --mark-hue so it matches the markdown mark. */
  postHighlight: (anchor: BridgeAnchor, annotationId: string, hue?: string) => void;
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
      const msg = (ev.data ?? {}) as {
        type?: string;
        anchor?: BridgeAnchor | null;
        rect?: { x: number; y: number; width: number; height: number } | null;
        annotationId?: string;
      };
      if (msg.type === "selection") {
        if (msg.anchor) {
          handlers.onSelection(msg.anchor, msg.rect ?? null);
        } else {
          // anchor === null → the iframe cleared its selection; drop any pending compose.
          handlers.onClearSelection?.();
        }
      } else if (msg.type === "selection-rect") {
        // MƯỢT TASK 3: a scroll re-post of the live selection rect. A null rect = scrolled out of
        // view → treat as a clear (dismiss); a rect = reposition the open popover.
        if (msg.rect) handlers.onSelectionRect?.(msg.rect);
        else handlers.onClearSelection?.();
      } else if (msg.type === "place-failed" && typeof msg.annotationId === "string") {
        handlers.onPlaceFailed?.(msg.annotationId);
      }
      // Any other port message shape is ignored (defensive; the protocol is fixed).
    };
    port.start?.();
    // HTML-PLACE: the transport is live now → let the parent flush the existing annotation set
    // (postHighlight silently dropped before this). Fires once (a later ready can't rebind — `port`
    // is set, so onWindowMessage early-returns above).
    handlers.onReady?.();
  };

  win.addEventListener("message", onWindowMessage);

  return {
    postHighlight(anchor, annotationId, hue) {
      // The parent cannot draw into the opaque iframe; it asks the in-iframe bridge to, over the
      // port. No port yet (handshake not done) → nothing to do. `hue` carries the per-type/label
      // mark colour (S-001/AS-002) so the in-iframe mark matches the markdown hued mark.
      port?.postMessage({ type: "highlight", anchor, annotationId, hue });
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
