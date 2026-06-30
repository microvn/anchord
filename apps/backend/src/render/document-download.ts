// viewer-overflow-menu S-005 — "Download the document by kind". Given a version's RAW stored
// content + kind + the doc title, return the body, content type, and attachment filename for a
// faithful download: markdown → the .md source (NOT the rendered HTML), html → the .html source
// (verbatim, none of the viewer's block-id/bridge injection — the route serves this loader content
// directly, not the /v/:id surface), image → the decoded original image bytes from its data URL.
// Pure + DOM-free so it is unit-testable; the route wraps the gate + Content-Disposition around it.

export type DownloadKind = "html" | "markdown" | "image";

export interface DocDownload {
  body: string | Uint8Array;
  contentType: string;
  /** the attachment filename the route puts in Content-Disposition. */
  filename: string;
}

// A filesystem-safe filename stem from the doc title. Empty / symbol-only → "document".
function stem(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "document"
  );
}

// image/<x> → file extension for the download name.
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+);base64,(.*)$/s;

export function buildDocDownload(content: string, kind: DownloadKind, title: string): DocDownload {
  const base = stem(title);
  if (kind === "markdown") {
    return { body: content, contentType: "text/markdown; charset=utf-8", filename: `${base}.md` };
  }
  if (kind === "html") {
    return { body: content, contentType: "text/html; charset=utf-8", filename: `${base}.html` };
  }
  // image: the stored content is the original image as a base64 data URL → decode to the real
  // bytes + content type. Anything else (e.g. a bare filename from a not-yet-wired upload path) →
  // a safe octet-stream fallback so the action never throws.
  const m = DATA_URL.exec(content);
  if (m) {
    const mime = m[1].toLowerCase();
    const bytes = Uint8Array.from(Buffer.from(m[2], "base64"));
    const ext = IMAGE_EXT[mime] ?? "img";
    return { body: bytes, contentType: mime, filename: `${base}.${ext}` };
  }
  return { body: content, contentType: "application/octet-stream", filename: base };
}
