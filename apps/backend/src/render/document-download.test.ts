import { describe, it, expect } from "bun:test";
import { buildDocDownload } from "./document-download";

// viewer-overflow-menu S-005 — the pure "download the document by kind" serializer. Given the raw
// stored content + kind + title, it returns the bytes/text, the content type, and the attachment
// filename. The route wires the access gate + Content-Disposition around it; this pins the by-kind
// mapping (AS-015 md, AS-016 html/image) and is the unit-level coverage for C-006 (faithful raw
// source + correct content-type + title-derived filename, per kind).

describe("buildDocDownload S-005", () => {
  it("AS-015: a markdown doc downloads as raw .md (the source, not rendered HTML)", () => {
    const src = "# Title\n\n- a\n- b\n";
    const out = buildDocDownload(src, "markdown", "Refund API spec");
    expect(out.body).toBe(src);
    expect(out.contentType).toBe("text/markdown; charset=utf-8");
    expect(out.filename).toBe("refund-api-spec.md");
  });

  it("AS-016: an HTML doc downloads as its source .html (verbatim, no block-id/bridge injection)", () => {
    const src = "<h1>Hi</h1><p>body</p>";
    const out = buildDocDownload(src, "html", "Strategy Backtest Report");
    expect(out.body).toBe(src);
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.filename).toBe("strategy-backtest-report.html");
  });

  it("AS-016: an image doc (data URL) downloads as the decoded original image with its real type", () => {
    // a 1x1 transparent PNG data URL
    const b64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const out = buildDocDownload(`data:image/png;base64,${b64}`, "image", "Architecture Diagram");
    expect(out.contentType).toBe("image/png");
    expect(out.filename).toBe("architecture-diagram.png");
    expect(out.body).toBeInstanceOf(Uint8Array);
    // decoded bytes start with the PNG magic number
    const bytes = out.body as Uint8Array;
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("AS-016: a non-data-URL image content falls back to an octet-stream download, no throw", () => {
    const out = buildDocDownload("architecture-diagram.png", "image", "Diagram");
    expect(out.contentType).toBe("application/octet-stream");
    expect(out.filename).toBe("diagram");
    expect(out.body).toBe("architecture-diagram.png");
  });

  it("AS-015: a symbol-only title falls back to a safe filename stem", () => {
    expect(buildDocDownload("x", "markdown", "!!!").filename).toBe("document.md");
  });
});
