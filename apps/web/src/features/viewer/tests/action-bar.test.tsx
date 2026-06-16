import { describe, it, expect, mock } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// annotation-actions-ui S-002 — the 2-family action bar: at most TWO contextual actions, chosen by
// family (Remark vs Proposal) + permission (owner) + own (no self-approve). This file proves the
// collapsed bar at two levels:
//   1. the pure decision helper `actionBarSlots` (unit) — the rules in isolation;
//   2. the rendered ThreadCard bar (component) — the right affordances show for each scenario.
//
// The 2-family rule (C-002 / C-003):
//   • Remark (no suggestion)            → Resolve / Reopen (commenter+).
//   • Proposal, owner, NOT author, pending  → Accept + Reject (no Resolve).
//   • Proposal, owner, decided          → Reopen (no Accept/Reject).
//   • Proposal, non-owner               → nothing (reply only).
//   • Proposal I authored (isOwn)       → Resolve (treated as a remark), Accept/Reject HIDDEN — even
//                                          as owner (no self-approve, C-003).
// Every affordance is a CLIENT HINT — the backend re-authorizes the close (C-002).

import { ThreadCard, actionBarSlots } from "@/features/viewer/components/thread-card";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

const ME = "user-me-001";
const OTHER = "user-other-002";

function remark(overrides: Partial<ViewerAnnotation> = {}): ViewerAnnotation {
  return {
    id: "rm-1",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    label: "looks-good", // a like → a Remark
    anchor: { blockId: "block-1", textSnippet: "the selected sentence", offset: 0, length: 21 },
    comments: [
      { id: "rm-1-c", parentId: null, authorName: "Mara", body: "Looks good", createdAt: new Date().toISOString() },
    ],
    ...overrides,
  };
}

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

function renderCard(annotation: ViewerAnnotation, props: Partial<Parameters<typeof ThreadCard>[0]> = {}) {
  return render(
    <ThreadCard annotation={annotation} focused={false} unplaceable={false} onFocus={() => {}} {...props} />,
  );
}

// ── The pure decision helper (C-002 / C-003) ──

describe("actionBarSlots — the 2-family decision (S-002)", () => {
  it("C-002: a Remark offers Resolve when unresolved, Reopen when resolved (never Decide)", () => {
    expect(actionBarSlots({ isProposal: false, isOwner: false, isOwn: false, resolved: false })).toEqual({
      showResolve: true,
      showReopen: false,
      showDecide: false,
    });
    expect(actionBarSlots({ isProposal: false, isOwner: true, isOwn: false, resolved: true })).toEqual({
      showResolve: false,
      showReopen: true,
      showDecide: false,
    });
  });

  it("C-002: a pending Proposal offers the OWNER Accept + Reject (Decide), no Resolve", () => {
    expect(
      actionBarSlots({ isProposal: true, sugStatus: "pending", isOwner: true, isOwn: false, resolved: false }),
    ).toEqual({ showResolve: false, showReopen: false, showDecide: true });
  });

  it("C-002: a decided Proposal offers the OWNER Reopen, no Accept/Reject", () => {
    for (const sugStatus of ["accepted", "rejected"] as const) {
      expect(
        actionBarSlots({ isProposal: true, sugStatus, isOwner: true, isOwn: false, resolved: true }),
      ).toEqual({ showResolve: false, showReopen: true, showDecide: false });
    }
  });

  it("C-002: a non-owner on a Proposal gets NO close action (reply only)", () => {
    expect(
      actionBarSlots({ isProposal: true, sugStatus: "pending", isOwner: false, isOwn: false, resolved: false }),
    ).toEqual({ showResolve: false, showReopen: false, showDecide: false });
  });

  it("C-002: a stale Proposal offers the owner NO close action (a drifted redline can't be accepted)", () => {
    expect(
      actionBarSlots({ isProposal: true, sugStatus: "stale", isOwner: true, isOwn: false, resolved: false }),
    ).toEqual({ showResolve: false, showReopen: false, showDecide: false });
  });

  it("C-003: a Proposal I authored is treated as a remark → Resolve, NEVER Decide (even as owner)", () => {
    // pending + owner + isOwn → Resolve (not Accept/Reject): no self-approve.
    expect(
      actionBarSlots({ isProposal: true, sugStatus: "pending", isOwner: true, isOwn: true, resolved: false }),
    ).toEqual({ showResolve: true, showReopen: false, showDecide: false });
    // resolved own proposal → Reopen, still never Decide.
    expect(
      actionBarSlots({ isProposal: true, sugStatus: "accepted", isOwner: true, isOwn: true, resolved: true }),
    ).toEqual({ showResolve: false, showReopen: true, showDecide: false });
  });
});

// ── The rendered bar (the Acceptance Scenarios) ──

describe("ThreadCard action bar — the 2-family scenarios (S-002)", () => {
  it("AS-004: an unresolved REMARK (a like), commenter → a single Resolve (Reopen once resolved), no Accept/Reject", () => {
    // A commenter is modelled by onResolve being supplied (the consumer gates it on comment permission).
    const onResolve = mock(async () => true);
    const { rerender } = renderCard(remark(), { onResolve });
    let card = screen.getByTestId("thread-card");
    // The single close action is Resolve; there is no Accept/Reject on a remark.
    expect(within(card).getByTestId("resolve-toggle")).toHaveTextContent("Resolve");
    expect(within(card).queryByTestId("redline-accept")).toBeNull();
    expect(within(card).queryByTestId("redline-reject")).toBeNull();
    expect(within(card).queryByTestId("redline-decide")).toBeNull();

    // Once resolved, the SAME single action reads Reopen (still no Accept/Reject).
    rerender(
      <ThreadCard annotation={remark({ status: "resolved" })} focused={false} unplaceable={false} onFocus={() => {}} onResolve={onResolve} />,
    );
    card = screen.getByTestId("thread-card");
    expect(within(card).getByTestId("resolve-toggle")).toHaveTextContent("Reopen");
    expect(within(card).queryByTestId("redline-decide")).toBeNull();
  });

  it("AS-005: a PENDING proposal authored by someone else, I am owner → Accept + Reject, no Resolve", () => {
    renderCard(proposal({ authorId: OTHER }), {
      currentUserId: ME,
      isOwner: true,
      onDecide: mock(async () => true),
      onResolve: mock(async () => true), // even with onResolve supplied, a pending proposal hides Resolve
    });
    const card = screen.getByTestId("thread-card");
    expect(within(card).getByTestId("redline-accept")).toBeInTheDocument();
    expect(within(card).getByTestId("redline-reject")).toBeInTheDocument();
    // The proposal's two close actions are Accept/Reject — NOT Resolve (no double close family).
    expect(within(card).queryByTestId("resolve-toggle")).toBeNull();
  });

  it("AS-006: a DECIDED (accepted) proposal, I am owner → Reopen, and NO Accept/Reject", () => {
    renderCard(proposal({ authorId: OTHER, status: "resolved", suggestionStatus: "accepted" }), {
      currentUserId: ME,
      isOwner: true,
      onDecide: mock(async () => true),
      onResolve: mock(async () => true),
    });
    const card = screen.getByTestId("thread-card");
    expect(within(card).getByTestId("resolve-toggle")).toHaveTextContent("Reopen");
    expect(within(card).queryByTestId("redline-accept")).toBeNull();
    expect(within(card).queryByTestId("redline-reject")).toBeNull();
    expect(within(card).queryByTestId("redline-decide")).toBeNull();
  });

  it("AS-007: a proposal, I am a commenter (non-owner) → NO close action (no Accept/Reject/Resolve); reply still available", () => {
    renderCard(proposal({ authorId: OTHER }), {
      currentUserId: ME,
      isOwner: false,
      onReply: mock(async () => true),
      onResolve: mock(async () => true), // supplied, but a non-owner proposal hides it
      onDecide: mock(async () => true), // supplied, but isOwner=false hides it
    });
    const card = screen.getByTestId("thread-card");
    // No close action of any family.
    expect(within(card).queryByTestId("resolve-toggle")).toBeNull();
    expect(within(card).queryByTestId("redline-accept")).toBeNull();
    expect(within(card).queryByTestId("redline-reject")).toBeNull();
    expect(within(card).queryByTestId("redline-decide")).toBeNull();
    // Reply is still available — a non-owner can reply on a proposal (reply only).
    expect(within(card).getByTestId("reply-open")).toBeInTheDocument();
  });

  it("AS-008: a PENDING proposal whose authorId === my id, I am owner → Resolve, HIDES Accept/Reject (no self-approve)", () => {
    renderCard(proposal({ authorId: ME }), {
      currentUserId: ME,
      isOwner: true,
      onDecide: mock(async () => true),
      onResolve: mock(async () => true),
    });
    const card = screen.getByTestId("thread-card");
    // I own it → treated as a remark for me: Resolve, never Accept/Reject (I can't approve my own).
    expect(within(card).getByTestId("resolve-toggle")).toHaveTextContent("Resolve");
    expect(within(card).queryByTestId("redline-accept")).toBeNull();
    expect(within(card).queryByTestId("redline-reject")).toBeNull();
    expect(within(card).queryByTestId("redline-decide")).toBeNull();
    // No visible own marker (C-001) — own is INTERNAL, recorded on the data-own hook.
    expect(within(card).queryByTestId("own-badge")).toBeNull();
    expect(card.getAttribute("data-own")).toBe("true");
  });

  it("AS-020: my OWN pending proposal does NOT flash Accept/Reject while the session is still resolving (currentUserId null)", () => {
    // An owner is always signed in, so currentUserId == null in the card means the session has not
    // resolved yet. The owner-decide row (redline-decide) must be WITHHELD until the user is known,
    // so a signed-in owner's OWN pending proposal never flashes Accept/Reject before correcting to
    // Resolve. authorId is mine, but the card can't yet know that — so it shows no decide row.
    const { rerender } = renderCard(proposal({ authorId: ME }), {
      currentUserId: null, // session still loading
      isOwner: true,
      onDecide: mock(async () => true),
      onResolve: mock(async () => true),
    });
    let card = screen.getByTestId("thread-card");
    expect(within(card).queryByTestId("redline-decide")).toBeNull();
    expect(within(card).queryByTestId("redline-accept")).toBeNull();
    expect(within(card).queryByTestId("redline-reject")).toBeNull();

    // Once the session resolves (currentUserId known === ME), the no-self-approve gate kicks in:
    // it's my own proposal → Resolve, still no decide row.
    rerender(
      <ThreadCard
        annotation={proposal({ authorId: ME })}
        focused={false}
        unplaceable={false}
        onFocus={() => {}}
        currentUserId={ME}
        isOwner
        onDecide={mock(async () => true)}
        onResolve={mock(async () => true)}
      />,
    );
    card = screen.getByTestId("thread-card");
    expect(within(card).queryByTestId("redline-decide")).toBeNull();
    expect(within(card).getByTestId("resolve-toggle")).toHaveTextContent("Resolve");
  });

  it("AS-020: an owner's decide row SHOWS for a resolved session on someone else's pending proposal", () => {
    // The complement: when the session HAS resolved (currentUserId known) and the proposal is by
    // someone else, the decide row shows. This proves the withhold guard only affects the unresolved
    // window, not the normal owner-decide path.
    renderCard(proposal({ authorId: OTHER }), {
      currentUserId: ME,
      isOwner: true,
      onDecide: mock(async () => true),
      onResolve: mock(async () => true),
    });
    const card = screen.getByTestId("thread-card");
    expect(within(card).getByTestId("redline-decide")).toBeInTheDocument();
    expect(within(card).getByTestId("redline-accept")).toBeInTheDocument();
    expect(within(card).getByTestId("redline-reject")).toBeInTheDocument();
  });

  it("C-002: at most TWO primary close affordances — a pending proposal shows exactly Accept + Reject (the affordance is a hint)", () => {
    renderCard(proposal({ authorId: OTHER }), {
      currentUserId: ME,
      isOwner: true,
      onDecide: mock(async () => true),
      onResolve: mock(async () => true),
    });
    const card = screen.getByTestId("thread-card");
    // Exactly the two proposal close actions — and no third (Resolve) crowding the bar.
    expect(within(card).getByTestId("redline-accept")).toBeInTheDocument();
    expect(within(card).getByTestId("redline-reject")).toBeInTheDocument();
    expect(within(card).queryByTestId("resolve-toggle")).toBeNull();
  });

  it("C-003: authorId === currentUserId on a proposal hides Accept/Reject and shows Resolve (mirrors the server gate)", () => {
    // The same proposal rendered for its AUTHOR-owner (no self-approve) vs a different-owner (decide).
    const { rerender } = renderCard(proposal({ authorId: ME }), {
      currentUserId: ME,
      isOwner: true,
      onDecide: mock(async () => true),
      onResolve: mock(async () => true),
    });
    let card = screen.getByTestId("thread-card");
    expect(within(card).queryByTestId("redline-accept")).toBeNull();
    expect(within(card).getByTestId("resolve-toggle")).toHaveTextContent("Resolve");

    // Flip ownership: the SAME proposal authored by someone else → the owner decides it (Accept/Reject).
    rerender(
      <ThreadCard
        annotation={proposal({ authorId: OTHER })}
        focused={false}
        unplaceable={false}
        onFocus={() => {}}
        currentUserId={ME}
        isOwner
        onDecide={mock(async () => true)}
        onResolve={mock(async () => true)}
      />,
    );
    card = screen.getByTestId("thread-card");
    expect(within(card).getByTestId("redline-accept")).toBeInTheDocument();
    expect(within(card).queryByTestId("resolve-toggle")).toBeNull();
  });
});
