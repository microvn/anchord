import { describe, it, expect } from "bun:test";
import { annotationsToMarkdown, exportFilename } from "@/features/viewer/lib/export-annotations";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

// viewer-overflow-menu S-004 — the pure serializer behind "Download annotations". The menu turns the
// returned string into a Blob download; this file pins the OUTPUT (own-your-data: every thread, its
// anchored quote, and its comments, from data already in the browser — no backend export).

const DOC = { title: "Web-core behavior contract", version: 4 };

function annotation(over: Partial<ViewerAnnotation> = {}): ViewerAnnotation {
  return {
    id: "a1",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    anchor: { blockId: "b1", textSnippet: "tokens before the refresh", offset: 0, length: 25 },
    comments: [
      { id: "c1", parentId: null, authorName: "Jane Smith", body: "Please clarify.", createdAt: "2026-06-28T10:00:00.000Z" },
    ],
    ...over,
  };
}

describe("annotationsToMarkdown S-004", () => {
  it("AS-012: serializes every thread with its type, anchored quote, and comments under a header", () => {
    const annos: ViewerAnnotation[] = [
      annotation(),
      annotation({
        id: "a2",
        status: "resolved",
        anchor: { blockId: "b2", textSnippet: "the second span", offset: 0, length: 15 },
        comments: [
          { id: "c2", parentId: null, authorName: "Bob Lee", body: "Looks fine now.", createdAt: "2026-06-28T11:00:00.000Z" },
          { id: "c3", parentId: "c2", authorName: "Jane Smith", body: "Agreed.", createdAt: "2026-06-28T11:05:00.000Z" },
        ],
      }),
      annotation({
        id: "a3",
        type: "suggestion",
        anchor: { blockId: "b3", textSnippet: "delete me", offset: 0, length: 9 },
        suggestion: { kind: "delete", from: "delete me", againstVersion: 4 },
        suggestionStatus: "pending",
        comments: [],
      }),
    ];

    const md = annotationsToMarkdown(DOC, annos);

    // header
    expect(md).toContain("# Annotations — Web-core behavior contract");
    expect(md).toContain("Document version: v4");
    expect(md).toContain("Total: 3");
    // anchored quotes
    expect(md).toContain("tokens before the refresh");
    expect(md).toContain("the second span");
    // comment authors + bodies
    expect(md).toContain("Jane Smith");
    expect(md).toContain("Please clarify.");
    expect(md).toContain("Bob Lee");
    expect(md).toContain("Agreed.");
    // resolved flag + redline from-text
    expect(md).toContain("resolved");
    expect(md).toContain("Remove:");
    expect(md).toContain("delete me");
  });

  it("AS-013: a doc with no annotations still serializes (states none, does not throw)", () => {
    expect(() => annotationsToMarkdown(DOC, [])).not.toThrow();
    const md = annotationsToMarkdown(DOC, []);
    expect(md).toContain("Total: 0");
    expect(md.toLowerCase()).toContain("no annotations");
  });

  it("AS-014: comment bodies with newlines and Markdown specials are preserved verbatim", () => {
    const body = "First line\nSecond *bold* line\n# heading\n`code`";
    const md = annotationsToMarkdown(DOC, [
      annotation({
        comments: [{ id: "c1", parentId: null, authorName: "Jane Smith", body, createdAt: "2026-06-28T10:00:00.000Z" }],
      }),
    ]);
    expect(md).toContain("First line");
    expect(md).toContain("Second *bold* line");
    expect(md).toContain("# heading");
    expect(md).toContain("`code`");
  });

  it("AS-012: the export filename is derived from the doc title", () => {
    expect(exportFilename("Web-core behavior contract")).toBe("web-core-behavior-contract-annotations.md");
    // empty / symbol-only title falls back to a safe stem
    expect(exportFilename("!!!")).toBe("annotations.md");
  });
});
