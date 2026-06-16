import { describe, it, expect } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// annotation-actions-ui S-004 (C-006) — Surface a proposal's pending / decided / stale status.
//
// A proposal (an annotation carrying a `suggestion` payload) surfaces where it stands from the served
// `suggestionStatus`, so a reviewer can scan the rail:
//   • pending  → a Pending marker (it awaits the owner's decision)         — the NEW bit (AS-014).
//   • accepted → the accepted outcome + reads as resolved (dimmed), NOT Pending (AS-015).
//   • rejected → the rejected outcome + reads as resolved (dimmed), NOT Pending (mutual-exclusion edge).
//   • stale    → a distinct stale treatment, NOT a confident Pending marker (AS-016).
// Pending and a decided/stale state are mutually exclusive on one item (C-006). A remark (no
// suggestionStatus) shows no status marker at all.
//
// Pending hue/treatment is [→MANUAL] per DESIGN.md — DESIGN.md pins detached/error/resolved status
// colours but NOT Pending, so it uses a neutral "awaiting" pill (NOT an outcome colour: not success,
// not error). The AS assert presence + distinctness + mutual exclusivity; the exact CSS is design's call.

import { ThreadCard } from "@/features/viewer/components/thread-card";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

function proposal(overrides: Partial<ViewerAnnotation> = {}): ViewerAnnotation {
  return {
    id: "pr-1",
    type: "suggestion",
    status: "unresolved",
    isOrphaned: false,
    anchor: { blockId: "block-h1", textSnippet: "Implementation Plan", offset: 0, length: 19 },
    suggestion: { kind: "delete", from: "Implementation Plan", againstVersion: 4 },
    suggestionStatus: "pending",
    comments: [
      { id: "pr-1-c", parentId: null, authorName: "Mara", body: "Suggested deletion", createdAt: new Date().toISOString() },
    ],
    ...overrides,
  };
}

function remark(overrides: Partial<ViewerAnnotation> = {}): ViewerAnnotation {
  return {
    id: "rm-1",
    type: "comment",
    status: "unresolved",
    isOrphaned: false,
    anchor: { blockId: "block-h1", textSnippet: "Implementation Plan", offset: 0, length: 19 },
    comments: [
      { id: "rm-1-c", parentId: null, authorName: "Mara", body: "A plain comment", createdAt: new Date().toISOString() },
    ],
    ...overrides,
  };
}

function renderCard(annotation: ViewerAnnotation, props: Partial<Parameters<typeof ThreadCard>[0]> = {}) {
  return render(
    <ThreadCard annotation={annotation} focused={false} unplaceable={false} onFocus={() => {}} {...props} />,
  );
}

describe("Proposal status surface (S-004, C-006)", () => {
  it("AS-014: a pending proposal shows a Pending marker (awaits the owner's decision)", () => {
    renderCard(proposal({ suggestionStatus: "pending" }));
    const card = screen.getByTestId("thread-card");
    expect(within(card).getByTestId("redline-pending-badge")).toHaveTextContent(/pending/i);
    // Mutual exclusivity (C-006): a pending proposal shows no decided/stale outcome.
    expect(within(card).queryByTestId("redline-accepted-badge")).toBeNull();
    expect(within(card).queryByTestId("redline-rejected-badge")).toBeNull();
    expect(within(card).queryByTestId("redline-stale-badge")).toBeNull();
  });

  it("AS-015: a decided (accepted) proposal shows the accepted outcome, reads as resolved (dimmed), and is NOT Pending", () => {
    renderCard(proposal({ status: "resolved", suggestionStatus: "accepted" }));
    const card = screen.getByTestId("thread-card");
    // The accepted outcome surfaces.
    expect(within(card).getByTestId("redline-accepted-badge")).toHaveTextContent(/accepted/i);
    // One-pill locked design: a decided proposal shows its OUTCOME pill (Accepted) + dims
    // (data-resolved), but NOT a separate Resolved pill — the outcome IS the single status.
    expect(card.getAttribute("data-resolved")).toBe("true");
    expect(within(card).queryByTestId("resolved-badge")).toBeNull();
    // Mutual exclusivity (C-006): a decided proposal never shows Pending.
    expect(within(card).queryByTestId("redline-pending-badge")).toBeNull();
  });

  it("AS-015 edge: a decided (rejected) proposal reads as resolved and is NOT Pending", () => {
    // The other decided branch: rejected must also read resolved/dimmed and never show Pending.
    renderCard(proposal({ status: "resolved", suggestionStatus: "rejected" }));
    const card = screen.getByTestId("thread-card");
    expect(within(card).getByTestId("redline-rejected-badge")).toHaveTextContent(/rejected/i);
    expect(card.getAttribute("data-resolved")).toBe("true");
    expect(within(card).queryByTestId("redline-pending-badge")).toBeNull();
  });

  it("AS-016: a drifted proposal shows a distinct stale treatment, NOT a Pending marker", () => {
    renderCard(proposal({ suggestionStatus: "stale" }));
    const card = screen.getByTestId("thread-card");
    // A distinct stale treatment (its own badge), not a confident Pending marker.
    expect(within(card).getByTestId("redline-stale-badge")).toHaveTextContent(/stale/i);
    expect(within(card).queryByTestId("redline-pending-badge")).toBeNull();
    // And distinct from the decided outcomes.
    expect(within(card).queryByTestId("redline-accepted-badge")).toBeNull();
    expect(within(card).queryByTestId("redline-rejected-badge")).toBeNull();
  });

  it("C-006: the status surface is driven by suggestionStatus; a remark (no suggestionStatus) shows no proposal-status marker", () => {
    // A remark (comment/like/label) is not a proposal — it never carries a Pending/accepted/rejected/
    // stale marker (only its own resolve-dim, exercised elsewhere). The surface keys on suggestionStatus.
    renderCard(remark());
    const card = screen.getByTestId("thread-card");
    expect(within(card).queryByTestId("redline-pending-badge")).toBeNull();
    expect(within(card).queryByTestId("redline-accepted-badge")).toBeNull();
    expect(within(card).queryByTestId("redline-rejected-badge")).toBeNull();
    expect(within(card).queryByTestId("redline-stale-badge")).toBeNull();
  });
});
