import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
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
  }
>(function HtmlSandboxFrame({ contentUrl, onSelection, onClearSelection, onSelectionRect }, ref) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const connRef = useRef<BridgeConnection | null>(null);
  // Hold the latest handlers in a ref so the bridge connection (wired once on mount) always calls
  // the current callbacks without re-running the connect effect (which would re-add a window
  // listener and could accept a stale/duplicate handshake).
  const handlersRef = useRef({ onSelection, onClearSelection, onSelectionRect });
  handlersRef.current = { onSelection, onClearSelection, onSelectionRect };

  // S-002: wire the parent side of the bridge ONCE on mount. Only connect when there's a consumer
  // for selections (the viewer passes onSelection only for a comment-capable role — C-004).
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !onSelection) return;
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
    });
    connRef.current = conn;
    return () => {
      conn.dispose();
      connRef.current = null;
    };
    // Connect once; `onSelection` presence (not identity) gates it. Identity changes are absorbed by
    // handlersRef so we never tear down + re-add the window listener on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(onSelection)]);

  useImperativeHandle(
    ref,
    () => ({
      postHighlight: (anchor, annotationId) => connRef.current?.postHighlight(anchor, annotationId),
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
