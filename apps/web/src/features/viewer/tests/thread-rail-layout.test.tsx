import { describe, it, expect } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// annotation-actions-ui S-005 (C-007) — Rail-item layout: capped quote + own-line type-chip.
// A rail item keeps a FIXED shape regardless of content length: the quoted span is capped to ≈3 lines
// with an expand control to a scrollable, read-only full quote, and the type/label chip sits on its
// OWN line so a long / user-extensible label never crowds the author row or breaks the layout.
//
// These are component-level structural/behaviour assertions (test-ids + state), NOT pixel CSS — exact
// visual styling is [→MANUAL] per DESIGN.md. We render ThreadCard directly and assert: a long quote
// clamps + offers an expand control; expanding shows the full text in a bounded scroll area; a label
// keeps the type-chip on its own row.

import { ThreadCard } from "@/features/viewer/components/thread-card";
import { quoteOverflows, QUOTE_CAP_CHARS } from "@/features/viewer/components/thread-card";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

// A quote well over the cap (≈10 lines worth). Built from explicit lines so the full text is exact.
const LONG_QUOTE = Array.from(
  { length: 10 },
  (_, i) => `Line ${i + 1}: this is a fairly long sentence of quoted document text to overflow the cap.`,
).join("\n");
const SHORT_QUOTE = "A short quoted span.";

function thread(overrides: Partial<ViewerAnnotation> = {}): ViewerAnnotation {
  return {
    id: "anno-1",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    anchor: { blockId: "block-1", textSnippet: SHORT_QUOTE, offset: 0, length: 20 },
    comments: [
      {
        id: "cmt-1",
        parentId: null,
        authorName: "Mara",
        body: "A note.",
        createdAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

function renderCard(annotation: ViewerAnnotation) {
  return render(
    <ThreadCard annotation={annotation} focused={false} unplaceable={false} onFocus={() => {}} />,
  );
}

describe("ThreadCard rail-item layout — capped quote + own-line type-chip (S-005)", () => {
  it("AS-017: a long quote is capped (~3 lines) with an expand control; the item keeps a fixed shape", () => {
    // Given a rail item whose quoted span is much longer than the cap.
    renderCard(thread({ anchor: { blockId: "b", textSnippet: LONG_QUOTE, offset: 0, length: 5 } }));

    // When it renders collapsed: the quote is clamped (data-clamped) — NOT showing unbounded full text —
    // and an expand control is present.
    const quoteText = screen.getByTestId("quote-text");
    expect(quoteText.getAttribute("data-clamped")).toBe("true");
    expect(quoteText.getAttribute("data-expanded")).toBeNull();

    const toggle = screen.getByTestId("quote-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveTextContent(/show more/i);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("AS-017: a SHORT quote (≤ cap) shows NO expand control and is not clamped", () => {
    // Edge: a short quote needs no affordance — no expand control, no clamp (no fixed-shape problem).
    renderCard(thread()); // SHORT_QUOTE
    expect(screen.queryByTestId("quote-toggle")).toBeNull();
    expect(screen.getByTestId("quote-text").getAttribute("data-clamped")).toBeNull();
  });

  it("AS-018: expanding shows the full quote in a scrollable, read-only area; collapse returns", async () => {
    // Given a capped quote with its expand control.
    renderCard(thread({ anchor: { blockId: "b", textSnippet: LONG_QUOTE, offset: 0, length: 5 } }));
    const toggle = screen.getByTestId("quote-toggle");

    // When I expand it: the full text is available and the area is scroll-BOUNDED (a max-height +
    // overflow-auto region), not unbounded growth. The quote remains READ-ONLY (no textarea/input).
    await userEvent.click(toggle);

    const quoteText = screen.getByTestId("quote-text");
    expect(quoteText.getAttribute("data-expanded")).toBe("true");
    expect(quoteText.getAttribute("data-clamped")).toBeNull();
    // Full text present (the last line proves the whole quote is shown, not the clamped head).
    expect(quoteText).toHaveTextContent(/Line 10:/);
    // Scroll-bounded, not unbounded: a max-height cap + overflow-auto.
    expect(quoteText.className).toMatch(/max-h-/);
    expect(quoteText.className).toMatch(/overflow-auto/);
    // Read-only: the quote is rendered as inert text, never an editable control.
    expect(quoteText.querySelector("textarea")).toBeNull();
    expect(quoteText.querySelector("input")).toBeNull();
    expect((quoteText as HTMLElement).isContentEditable).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    // A collapse control returns it to the clamped state.
    expect(toggle).toHaveTextContent(/show less/i);
    await userEvent.click(screen.getByTestId("quote-toggle"));
    const collapsed = screen.getByTestId("quote-text");
    expect(collapsed.getAttribute("data-clamped")).toBe("true");
    expect(collapsed.getAttribute("data-expanded")).toBeNull();
  });

  it("AS-018: expanding the quote does NOT trigger the card's focus (stopPropagation)", async () => {
    // The expand control nests inside the role=button card; its click must not bubble to onFocus.
    let focused = false;
    render(
      <ThreadCard
        annotation={thread({ anchor: { blockId: "b", textSnippet: LONG_QUOTE, offset: 0, length: 5 } })}
        focused={false}
        unplaceable={false}
        onFocus={() => {
          focused = true;
        }}
      />,
    );
    await userEvent.click(screen.getByTestId("quote-toggle"));
    expect(focused).toBe(false);
  });

  it("AS-019: a label keeps the type-chip on its OWN line, not crowding the author/name row", () => {
    // Given a rail item with a (long) label — use the longest preset, "Match existing patterns".
    renderCard(
      thread({ type: "comment", label: "match-patterns", comments: [
        { id: "cmt-1", parentId: null, authorName: "Mara", body: "Match existing patterns", createdAt: new Date().toISOString() },
      ] }),
    );

    // The type/label chip occupies its own dedicated row (type-chip-row), separate from the author row.
    const chipRow = screen.getByTestId("type-chip-row");
    const labelLine = within(chipRow).getByTestId("label-line");
    expect(labelLine).toHaveTextContent("Match existing patterns");

    // The chip row is NOT a descendant of the author/name head — the long label can't crowd that row.
    // The author name ("Mara") lives in its own head row outside the chip row.
    const authorName = screen.getByText("Mara");
    expect(chipRow.contains(authorName)).toBe(false);
    expect(labelLine.contains(authorName)).toBe(false);
  });

  it("C-007: empty / whitespace quote does not crash and offers no expand control", () => {
    // Edge: an empty or whitespace-only snippet → no clamp, no control, no crash.
    renderCard(thread({ anchor: { blockId: "b", textSnippet: "   ", offset: 0, length: 0 } }));
    expect(screen.queryByTestId("quote-toggle")).toBeNull();
    expect(screen.getByTestId("quote-text").getAttribute("data-clamped")).toBeNull();
  });

  it("C-007: a redline (proposal) quote caps the same way a comment quote does (fixed shape, any family)", () => {
    // A suggestion/redline quote and a comment quote both cap identically — the fixed-shape rule is
    // family-independent.
    renderCard(
      thread({
        type: "suggestion",
        suggestion: { kind: "delete" },
        suggestionStatus: "pending",
        anchor: { blockId: "b", textSnippet: LONG_QUOTE, offset: 0, length: 5 },
      }),
    );
    expect(screen.getByTestId("quote-text").getAttribute("data-clamped")).toBe("true");
    expect(screen.getByTestId("quote-toggle")).toBeInTheDocument();
  });

  it("C-007: quoteOverflows uses a content-length heuristic (char + newline thresholds)", () => {
    // The overflow detection is a deterministic content-length heuristic (bun/jsdom has no layout) —
    // documented in the component. Assert the contract directly: long-by-chars and long-by-newlines
    // overflow; short / empty / whitespace do not.
    expect(quoteOverflows(LONG_QUOTE)).toBe(true); // many newlines
    expect(quoteOverflows("x".repeat(QUOTE_CAP_CHARS + 1))).toBe(true); // over the char cap
    expect(quoteOverflows("l1\nl2\nl3\nl4")).toBe(true); // > 3 lines (≥ 3 newlines)
    expect(quoteOverflows("l1\nl2\nl3")).toBe(false); // exactly 3 lines — within the cap
    expect(quoteOverflows(SHORT_QUOTE)).toBe(false);
    expect(quoteOverflows("")).toBe(false);
    expect(quoteOverflows("   \n  ")).toBe(false); // whitespace-only
  });
});
