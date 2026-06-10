import { MarkdownView } from "./markdown-view";
import { HtmlSandboxFrame } from "./html-sandbox-frame";
import { ImageViewer } from "./image-viewer";
import type { ViewerDocResponse } from "./client";

// DocPane (S-001, C-001): the center pane of the 3-pane viewer. It picks the render strategy
// from the doc kind — markdown renders inline in the app theme; html/image render from the
// sandboxed /v content reference. The doc is the high-contrast element; the pane itself is plain
// (chrome recedes). A defensive guard keeps a malformed payload (e.g. html kind without a
// contentUrl) from crashing the render.

export function DocPane({ doc }: { doc: ViewerDocResponse }) {
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
  return <HtmlSandboxFrame contentUrl={contentUrl} />;
}
