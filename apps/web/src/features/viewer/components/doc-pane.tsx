import type { Ref } from "react";
import { MarkdownView } from "./markdown-view";
import { HtmlSandboxFrame, type HtmlSandboxFrameHandle } from "./html-sandbox-frame";
import { ImageViewer } from "./image-viewer";
import type { BridgeAnchor } from "@/features/viewer/lib/bridge";
import type { ViewerDocResponse } from "@/features/viewer/services/client";

// DocPane (S-001, C-001): the center pane of the 3-pane viewer. It picks the render strategy
// from the doc kind — markdown renders inline in the app theme; html/image render from the
// sandboxed /v content reference. The doc is the high-contrast element; the pane itself is plain
// (chrome recedes). A defensive guard keeps a malformed payload (e.g. html kind without a
// contentUrl) from crashing the render.
//
// S-002: for a kind=html doc the center is the sandboxed iframe. The shell wires the parent-side
// bridge through these props — `onSelection`/`onClearSelection` relay the iframe's text selection
// into the compose flow, and `htmlFrameRef` lets the shell post highlights back down the port.

export function DocPane({
  doc,
  onSelection,
  onClearSelection,
  onSelectionRect,
  htmlFrameRef,
}: {
  doc: ViewerDocResponse;
  /** S-002: a real selection relayed from the HTML sandbox iframe (gated by role upstream). */
  onSelection?: (anchor: BridgeAnchor, rect: { x: number; y: number; width: number; height: number } | null) => void;
  onClearSelection?: () => void;
  /** MƯỢT TASK 3: the iframe re-posted the live selection rect on its own in-iframe scroll. */
  onSelectionRect?: (rect: { x: number; y: number; width: number; height: number }) => void;
  htmlFrameRef?: Ref<HtmlSandboxFrameHandle>;
}) {
  const { kind } = doc.doc;

  if (kind === "markdown") {
    const html = typeof doc.content === "string" ? doc.content : "";
    return <MarkdownView html={html} />;
  }

  const contentUrl =
    doc.content && typeof doc.content === "object" ? doc.content.contentUrl : "";

  if (kind === "image") {
    return <ImageViewer contentUrl={contentUrl} />;
  }
  // kind === "html"
  return (
    <HtmlSandboxFrame
      ref={htmlFrameRef}
      contentUrl={contentUrl}
      onSelection={onSelection}
      onClearSelection={onClearSelection}
      onSelectionRect={onSelectionRect}
    />
  );
}
