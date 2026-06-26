import { describe, it, expect } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { AnnotationPeekCard } from "@/features/viewer/components/annotation-peek-card";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

// S-001 — the read-only hover PEEK card: a condensed summary of an annotation, anchored above its
// marker. It renders ONLY from the already-loaded annotation data (no API). It carries NO action bar
// (Reply / Resolve / Accept) — that is the click-to-pin card's job (S-002).
//
// happy-dom has no layout, so positioning (AS-005) is tested PURELY via placePopover (see
// place-popover.test.ts + the AS-005 case below). These tests assert the CONTENT + INERTNESS only.

const comment = (id: string, body: string, author: string, createdAt: string) => ({
  id,
  parentId: null as string | null,
  authorName: author,
  body,
  createdAt,
});

function annotation(over: Partial<ViewerAnnotation> = {}): ViewerAnnotation {
  return {
    id: "a1",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    anchor: { blockId: "block-p-1", textSnippet: "tokens before the refresh", offset: 0, length: 25 },
    comments: [
      comment("c1", "This phrasing is ambiguous.", "Jane Smith", "2h"),
      comment("c2", "Agreed.", "Bob Lee", "1h"),
      comment("c3", "Reworded in the next draft.", "Jane Smith", "1h"),
      comment("c4", "Thanks.", "Bob Lee", "30m"),
    ],
    ...over,
  };
}

describe("AnnotationPeekCard (S-001)", () => {
  it("AS-004: shows author + relative time + quote + root comment + remaining-reply count, NO action bar", () => {
    render(<AnnotationPeekCard annotation={annotation()} />);

    // author + relative time
    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
    expect(screen.getByText("2h")).toBeInTheDocument();
    // quoted phrase (clamped, but text present)
    expect(screen.getByTestId("peek-quote").textContent).toContain("tokens before the refresh");
    // root comment body
    expect(screen.getByTestId("peek-body").textContent).toContain("This phrasing is ambiguous.");
    // remaining-reply count: root + 3 replies → "3 replies"
    expect(screen.getByTestId("peek-reply-count").textContent).toContain("3 replies");

    // NO action bar / interactive controls — the peek is read-only.
    expect(screen.queryByTestId("reply-open")).toBeNull();
    expect(screen.queryByTestId("resolve-toggle")).toBeNull();
    expect(screen.queryByTestId("redline-decide")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("AS-004: a redline annotation shows a Delete type chip and no status dot", () => {
    const redline = annotation({
      type: "suggestion",
      suggestion: { kind: "delete", from: "tokens before the refresh", againstVersion: 1 },
      suggestionStatus: "pending",
    });
    render(<AnnotationPeekCard annotation={redline} />);
    // Delete type chip present (redline)
    expect(screen.getByTestId("peek-type-chip").textContent).toContain("Delete");
    // status dot removed entirely (dogfood 2026-06-26)
    expect(screen.queryByTestId("peek-status")).toBeNull();
    // still no action bar
    expect(screen.queryByTestId("redline-decide")).toBeNull();
  });

  it("AS-004: a label annotation shows the label preset chip", () => {
    render(<AnnotationPeekCard annotation={annotation({ label: "out-of-scope" })} />);
    expect(screen.getByTestId("peek-type-chip").textContent).toContain("Out of scope");
  });

  it("AS-004: a single root comment with no replies shows no reply-count", () => {
    const single = annotation({ comments: [comment("c1", "Only one note.", "Jane Smith", "2h")] });
    render(<AnnotationPeekCard annotation={single} />);
    expect(screen.queryByTestId("peek-reply-count")).toBeNull();
  });

  it("C-003: quote + comment body render as LITERAL text, never interpreted as HTML/markup", () => {
    const malicious = annotation({
      anchor: { blockId: "b", textSnippet: "<b>bold</b>", offset: 0, length: 11 },
      comments: [comment("c1", "<script>alert(1)</script>", "Jane Smith", "2h")],
    });
    const { container } = render(<AnnotationPeekCard annotation={malicious} />);
    // The markup is shown as text — no real <script>/<b> element is created inside the peek.
    expect(container.querySelector("script")).toBeNull();
    const peek = screen.getByTestId("annotation-peek-card");
    expect(within(peek).queryByText("bold")).toBeNull(); // a real <b>bold</b> would yield text "bold"
    expect(screen.getByTestId("peek-quote").textContent).toContain("<b>bold</b>");
    expect(screen.getByTestId("peek-body").textContent).toContain("<script>alert(1)</script>");
  });
});
