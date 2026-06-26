import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { connectBridge, type BridgeAnchor, type BridgeConnection } from "@/features/viewer/lib/bridge";

// HtmlSandboxFrame (S-001/AS-002, C-001/C-008; S-002/AS-004/AS-005, C-002/C-009): renders a
// kind=html doc inside a sandboxed iframe whose `src` is the backend's /v/:id content route (opaque
// origin, own styles, scripts isolated). The app chrome NEVER restyles the framed content — that is
// the whole point of the isolation. `sandbox="allow-scripts"` (no allow-same-origin) keeps the
// framed doc on an opaque origin so it can't reach the app's cookies/DOM (render-publish C-001/C-002).
// The /v path is proxied to the backend in dev (vite.config), so this relative src resolves
// same-origin in prod and dev alike.
//
// S-002 — THE BRIDGE. The parent can't read the opaque iframe's DOM/selection, so the backend
// injects an in-iframe bridge that relays selections over a dedicated MessageChannel. This component
// wires the PARENT side (bridge.ts): on mount it starts listening for the iframe's `ready` handshake,
// captures the transferred port, and forwards selection hints to `onSelection`. A forged
// `parent.postMessage` from the doc body lands on the window listener (not the port) and is ignored
// (AS-005). Highlights go back DOWN the port via the imperative `postHighlight` handle (the parent
// can't draw a <mark> into the opaque iframe). C-009: `src` is set ONCE from `contentUrl` and is
// NEVER reassigned from message data — the bridge only ever READS selections, never sets navigation.

export interface HtmlSandboxFrameHandle {
  /** S-002: ask the in-iframe bridge to draw a highlight for a created annotation (over the port). */
  postHighlight: (anchor: BridgeAnchor, annotationId: string) => void;
  /** S-004/AS-012 (C-005): ask the in-iframe bridge to emphasise + scroll to a thread's mark (over
   *  the port — the parent can't reach the opaque iframe DOM). Null clears emphasis. */
  postFocus: (annotationId: string | null) => void;
}

export const HtmlSandboxFrame = forwardRef<
  HtmlSandboxFrameHandle,
  {
    contentUrl: string;
    /** S-002: a real selection (non-null anchor) arrived from the iframe over the trusted port. */
    onSelection?: (anchor: BridgeAnchor, rect: { x: number; y: number; width: number; height: number } | null) => void;
    /** S-002: the iframe cleared its selection (anchor null) → dismiss any pending compose. */
    onClearSelection?: () => void;
    /** MƯỢT TASK 3: the iframe re-posted the live selection rect on its own in-iframe scroll. */
    onSelectionRect?: (rect: { x: number; y: number; width: number; height: number }) => void;
    /** HTML-PLACE: the current placeable annotation set. The parent can't draw <mark>s into the
     *  opaque iframe, so we post EACH anchor down the bridge once the handshake is ready and again
     *  whenever this set changes. Without this, existing HTML annotations are never highlighted.
     *  S-002/C-003: each item also carries the lifecycle state (resolved / kind / stale) so the
     *  in-iframe mark reproduces the markdown mark's resolved-dim / redline-strike / stale-dashed look. */
    annotations?: {
      id: string;
      anchor: BridgeAnchor;
      hue?: string;
      resolved?: boolean;
      kind?: "redline";
      stale?: boolean;
      /** S-007 (C-009): the status chip is toggled off → dim the in-iframe highlight. */
      filtered?: boolean;
    }[];
    /** HTML-PLACE: the in-iframe bridge couldn't place a posted highlight → surface it so the rail
     *  can badge only that annotation "couldn't place" (markdown reports this via the light-DOM placer). */
    onPlaceFailed?: (id: string) => void;
    /** S-004/AS-011 (C-005) + annotation-hover-card S-003/AS-016: a highlight click inside the iframe
     *  → focus that rail thread AND pin the card at the mark. The clicked mark's rect (already
     *  translated to PAGE coords) rides along so the parent anchors the pinned popover (C-008). */
    onMarkClick?: (id: string, rect: { x: number; y: number; width: number; height: number } | null) => void;
    /** S-003/AS-015 (peek): the cursor entered an in-iframe mark → the parent runs the dwell + shows
     *  the peek at the (page-translated) mark rect. Null rect → the bridge couldn't read it. */
    onMarkEnter?: (id: string, rect: { x: number; y: number; width: number; height: number } | null) => void;
    /** S-003/AS-015 (peek): the cursor left the mark (not to a same-id sibling) → hide the peek. */
    onMarkLeave?: (id: string) => void;
    /** S-003/AS-021: the in-iframe scroll re-posted the hovered/pinned mark's (page-translated) rect →
     *  reposition or auto-close the pinned card. Null rect (mark gone) → treat as scrolled-out. */
    onMarkRect?: (id: string, rect: { x: number; y: number; width: number; height: number } | null) => void;
  }
>(function HtmlSandboxFrame(
  {
    contentUrl,
    onSelection,
    onClearSelection,
    onSelectionRect,
    annotations,
    onPlaceFailed,
    onMarkClick,
    onMarkEnter,
    onMarkLeave,
    onMarkRect,
  },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const connRef = useRef<BridgeConnection | null>(null);
  // Hold the latest handlers in a ref so the bridge connection (wired once on mount) always calls
  // the current callbacks without re-running the connect effect (which would re-add a window
  // listener and could accept a stale/duplicate handshake).
  const handlersRef = useRef({
    onSelection,
    onClearSelection,
    onSelectionRect,
    onPlaceFailed,
    onMarkClick,
    onMarkEnter,
    onMarkLeave,
    onMarkRect,
  });
  handlersRef.current = {
    onSelection,
    onClearSelection,
    onSelectionRect,
    onPlaceFailed,
    onMarkClick,
    onMarkEnter,
    onMarkLeave,
    onMarkRect,
  };
  // HTML-PLACE: true once the bridge handshake is accepted (onReady). The post-existing effect below
  // depends on it so the initial flush waits for the port (postHighlight no-ops before the handshake).
  const [ready, setReady] = useState(false);

  // S-002 / HTML-PLACE: wire the parent side of the bridge ONCE per iframe (keyed on contentUrl, the
  // only thing that re-mounts the iframe). It MUST connect on mount — NOT gated on `onSelection` or
  // on annotations being present — because the in-iframe bridge fires its `ready` handshake EXACTLY
  // ONCE and never re-sends it. Re-keying this effect on a late-arriving condition (annotations
  // loading after the iframe already handshook) would tear down the already-handshook connection and
  // reconnect with `ready` reset to false — and since the iframe won't re-handshake, the highlight
  // batch would never post (annotations loaded, but no marks — the race this fixes). A viewer-only
  // role still passes no `onSelection`, so a relayed selection can't open a composer (AS-005/C-004) —
  // the bridge then only ever draws, never creates. Connecting with nothing to draw is harmless (it
  // just listens); the post-existing effect below flushes the set once `ready` AND annotations exist.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    // The bridge relays a selection rect in the IFRAME's own viewport coordinates (its
    // getBoundingClientRect, relative to the iframe's top-left, after the iframe's internal scroll).
    // The parent positions the popover in PAGE/window coordinates, so add the iframe's current
    // offset (its own getBoundingClientRect) to translate iframe-local → page coords. Without this
    // the popover lands at the wrong place and jumps as the iframe geometry / inner scroll changes.
    const toPageRect = (
      rect: { x: number; y: number; width: number; height: number },
    ): { x: number; y: number; width: number; height: number } => {
      const box = iframe.getBoundingClientRect();
      return { x: rect.x + box.left, y: rect.y + box.top, width: rect.width, height: rect.height };
    };
    const conn = connectBridge(iframe, {
      onSelection: (anchor, rect) =>
        handlersRef.current.onSelection?.(anchor, rect ? toPageRect(rect) : rect),
      onClearSelection: () => handlersRef.current.onClearSelection?.(),
      onSelectionRect: (rect) => {
        if (rect) handlersRef.current.onSelectionRect?.(toPageRect(rect));
        else handlersRef.current.onClearSelection?.();
      },
      // HTML-PLACE: relay the in-iframe placement failure up so the rail badges only that id.
      onPlaceFailed: (id) => handlersRef.current.onPlaceFailed?.(id),
      // S-004/AS-011 (C-005) + S-003/AS-016: a highlight click → focus + pin. Translate the clicked
      // mark's iframe-local rect to PAGE coords so the parent anchors the pinned popover (C-008).
      onMarkClick: (id, rect) => handlersRef.current.onMarkClick?.(id, rect ? toPageRect(rect) : null),
      // S-003/AS-015 (peek): hover enter/leave → the parent dwell + peek. Translate the rect to page.
      onMarkEnter: (id, rect) => handlersRef.current.onMarkEnter?.(id, rect ? toPageRect(rect) : null),
      onMarkLeave: (id) => handlersRef.current.onMarkLeave?.(id),
      // S-003/AS-021: the in-iframe scroll re-posted the mark rect → reposition / auto-close the pin.
      onMarkRect: (id, rect) => handlersRef.current.onMarkRect?.(id, rect ? toPageRect(rect) : null),
      // HTML-PLACE: the port is live → flip `ready` so the post-existing effect flushes the set.
      onReady: () => setReady(true),
    });
    connRef.current = conn;
    return () => {
      conn.dispose();
      connRef.current = null;
      setReady(false);
    };
    // Connect once per iframe — keyed ONLY on contentUrl (a new doc re-mounts the iframe → reconnect).
    // Handler identity changes are absorbed by handlersRef so we never tear down + re-add the window
    // listener on a re-render, and crucially we never reconnect on annotations loading (which would
    // drop the one-shot handshake — see the comment above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentUrl]);

  // S-003 (C-002): once the bridge is ready, post the FULL current annotation set down the port as
  // ONE clear-then-redraw batch (postHighlights) — the in-iframe bridge unwraps ALL existing anno
  // marks then draws this set. Re-runs when `annotations` changes (create/delete/restore): an id
  // absent from the set has its mark REMOVED (the delete-removes-highlight fix, AS-007), a restored
  // id reappears (AS-008), a new id is added without disturbing the others (AS-009) — idempotent, no
  // duplicate or dropped marks. The parent can't draw into the opaque iframe, so this batch is the
  // only draw path; a genuinely-unplaceable item posts place-failed per sync → the rail.
  useEffect(() => {
    if (!ready || !annotations) return;
    const conn = connRef.current;
    if (!conn) return;
    // S-002/C-003: forward the lifecycle state alongside the anchor/hue so the in-iframe draw sets
    // data-resolved / data-anno-kind / data-anno-stale → the mark reads like the markdown one.
    conn.postHighlights(
      annotations.map((a) => ({
        anchor: a.anchor,
        annotationId: a.id,
        hue: a.hue,
        resolved: a.resolved,
        kind: a.kind,
        stale: a.stale,
        // S-007 (C-009): dim the in-iframe highlight when its chip is toggled off (AS-023).
        filtered: a.filtered,
      })),
    );
  }, [ready, annotations]);

  useImperativeHandle(
    ref,
    () => ({
      postHighlight: (anchor, annotationId) => connRef.current?.postHighlight(anchor, annotationId),
      postFocus: (annotationId) => connRef.current?.postFocus(annotationId),
    }),
    [],
  );

  return (
    // C-006: an HTML doc is FULL-BLEED — the sandbox iframe fills the doc pane edge-to-edge (no side
    // padding/margin) and fills the full available height (the doc pane is a flex column; the frame
    // is flex-1). No chrome around it; the outline pane is dropped for html (2-pane layout).
    // The isolation is enforced by `sandbox="allow-scripts"` WITHOUT allow-same-origin (opaque
    // origin) — the untrusted doc can't reach the app's cookies/DOM; the parent talks to it only
    // over the postMessage bridge, never by sharing an origin.
    <iframe
      ref={iframeRef}
      data-testid="html-sandbox-frame"
      className="h-full min-h-0 w-full flex-1 border-0 bg-white"
      sandbox="allow-scripts"
      // C-009: src is set ONCE from the doc's /v/:id contentUrl and is NEVER reassigned from
      // bridge/message data — the bridge only reads selections, it never drives navigation.
      src={contentUrl}
      title="doc"
    />
  );
});
