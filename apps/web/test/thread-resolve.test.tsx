import { describe, it, expect, mock } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// annotation-core-ui-commenting S-004 — Resolve / reopen a thread. The ThreadCard gains a
// Resolve/Reopen action that calls an injected onResolve(resolved); resolving dims the card + shows
// a Resolved badge, reopening reverts it (AS-007). The control is gated on comment permission
// (onResolve supplied), NOT authorship — a non-author commenter can resolve (AS-008/C-006). A
// viewer-only role (no onResolve) gets no Resolve control. We render ThreadCard directly with a
// mocked onResolve so the test asserts the toggle behaviour + render state, not a real round-trip.

import { ThreadCard } from "../src/features/viewer/thread-card";
import type { ViewerAnnotation } from "../src/features/viewer/client";

function thread(overrides: Partial<ViewerAnnotation> = {}): ViewerAnnotation {
  return {
    id: "anno-1",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    anchor: { blockId: "block-1", textSnippet: "the selected sentence", offset: 0, length: 21 },
    comments: [
      {
        id: "cmt-1",
        parentId: null,
        authorName: "Mara",
        body: "Why 24h and not 48h?",
        createdAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

function renderCard(
  annotation: ViewerAnnotation,
  onResolve?: (resolved: boolean) => Promise<boolean>,
) {
  return render(
    <ThreadCard
      annotation={annotation}
      focused={false}
      unplaceable={false}
      onFocus={() => {}}
      onResolve={onResolve}
    />,
  );
}

describe("ThreadCard resolve / reopen (S-004)", () => {
  it("AS-007: Resolve then Reopen toggles the status (dimmed + Resolved badge then back)", async () => {
    // Given an unresolved thread: no Resolved badge, the action reads "Resolve", the card is not dimmed.
    const onResolve = mock(async () => true);
    const { container } = renderCard(thread(), onResolve);

    const card = screen.getByTestId("thread-card");
    expect(card.getAttribute("data-resolved")).toBeNull();
    expect(screen.queryByTestId("resolved-badge")).toBeNull();
    const toggle = screen.getByTestId("resolve-toggle");
    expect(toggle).toHaveTextContent("Resolve");

    // When I click Resolve → the thread shows resolved: data-resolved flag (the dim, [→MANUAL] CSS),
    // a Resolved badge, and the action flips to "Reopen". onResolve(true) was called.
    await userEvent.click(toggle);
    await waitFor(() => expect(onResolve).toHaveBeenLastCalledWith(true));
    await waitFor(() => {
      expect(screen.getByTestId("thread-card").getAttribute("data-resolved")).toBe("true");
    });
    expect(screen.getByTestId("resolved-badge")).toBeInTheDocument();
    expect(screen.getByTestId("resolve-toggle")).toHaveTextContent("Reopen");
    // The quote-ref rule switches to the resolved (success) color — visual dim cue on the card.
    expect(container.querySelector(".border-success")).not.toBeNull();

    // When I click Reopen → back to unresolved: badge gone, flag cleared, action back to "Resolve".
    await userEvent.click(screen.getByTestId("resolve-toggle"));
    await waitFor(() => expect(onResolve).toHaveBeenLastCalledWith(false));
    await waitFor(() => {
      expect(screen.getByTestId("thread-card").getAttribute("data-resolved")).toBeNull();
    });
    expect(screen.queryByTestId("resolved-badge")).toBeNull();
    expect(screen.getByTestId("resolve-toggle")).toHaveTextContent("Resolve");

    // Toggled twice total (resolve, reopen).
    expect(onResolve).toHaveBeenCalledTimes(2);
  });

  it("AS-008: a non-author commenter can resolve (resolving is NOT author-only)", async () => {
    // The thread was created by "Mara" (the root comment author). The acting session is a different
    // person with commenter permission — modelled by onResolve being supplied at all (the consumer
    // gates that on comment permission, never on authorship). There is NO author check in the card.
    const onResolve = mock(async () => true);
    renderCard(
      thread({ comments: [{ id: "cmt-1", parentId: null, authorName: "Mara", body: "Mara's comment.", createdAt: new Date().toISOString() }] }),
      onResolve,
    );

    // The Resolve control is present for the non-author commenter and works.
    const toggle = screen.getByTestId("resolve-toggle");
    expect(toggle).toHaveTextContent("Resolve");
    await userEvent.click(toggle);

    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onResolve).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(screen.getByTestId("thread-card").getAttribute("data-resolved")).toBe("true");
    });
    expect(screen.getByTestId("resolved-badge")).toBeInTheDocument();
  });

  it("C-006: a viewer-only role (no onResolve) gets NO Resolve control", () => {
    // No onResolve supplied → read-only rail: the Resolve/Reopen affordance is absent entirely.
    renderCard(thread()); // onResolve omitted
    expect(screen.queryByTestId("resolve-toggle")).toBeNull();
  });

  it("C-006: a refused write rolls the optimistic toggle back (reflects the SERVER result)", async () => {
    // The server refuses the toggle (e.g. role revoked) → onResolve resolves false. The card must
    // revert: the optimistic Resolved badge/flag is removed, the action returns to "Resolve".
    const onResolve = mock(async () => false);
    renderCard(thread(), onResolve);

    await userEvent.click(screen.getByTestId("resolve-toggle"));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));

    // After the refusal reconciles, the resolved state is rolled back — no ghost resolved render.
    await waitFor(() => {
      expect(screen.getByTestId("thread-card").getAttribute("data-resolved")).toBeNull();
    });
    expect(screen.queryByTestId("resolved-badge")).toBeNull();
    expect(screen.getByTestId("resolve-toggle")).toHaveTextContent("Resolve");
  });

  it("AS-007: an already-resolved thread renders dimmed + Reopen, and reopens", async () => {
    // Boundary: the card may be handed a thread that is ALREADY resolved (e.g. resolved last session).
    // It must render resolved up-front and offer Reopen.
    const onResolve = mock(async () => true);
    renderCard(thread({ status: "resolved" }), onResolve);

    expect(screen.getByTestId("thread-card").getAttribute("data-resolved")).toBe("true");
    expect(screen.getByTestId("resolved-badge")).toBeInTheDocument();
    const toggle = screen.getByTestId("resolve-toggle");
    expect(toggle).toHaveTextContent("Reopen");

    await userEvent.click(toggle);
    await waitFor(() => expect(onResolve).toHaveBeenLastCalledWith(false));
    await waitFor(() => {
      expect(screen.getByTestId("thread-card").getAttribute("data-resolved")).toBeNull();
    });
  });

  it("AS-007: clicking Resolve does not also trigger the card's focus (stopPropagation)", async () => {
    // The Resolve control nests inside the role=button card; its click must not bubble to onFocus.
    const onResolve = mock(async () => true);
    const onFocus = mock(() => {});
    render(
      <ThreadCard
        annotation={thread()}
        focused={false}
        unplaceable={false}
        onFocus={onFocus}
        onResolve={onResolve}
      />,
    );

    await userEvent.click(screen.getByTestId("resolve-toggle"));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    expect(onFocus).not.toHaveBeenCalled();
  });

  it("C-008: the quote + comment body still render inert when resolved (no HTML injected)", async () => {
    // Resolving must not change the C-008 plaintext guarantee on untrusted strings.
    const xss = "<img src=x onerror=alert(1)>";
    const onResolve = mock(async () => true);
    renderCard(
      thread({ comments: [{ id: "cmt-1", parentId: null, authorName: "Mara", body: xss, createdAt: new Date().toISOString() }] }),
      onResolve,
    );
    await userEvent.click(screen.getByTestId("resolve-toggle"));
    await waitFor(() => expect(onResolve).toHaveBeenCalledTimes(1));
    const card = screen.getByTestId("thread-card");
    expect(within(card).getByText(xss)).toBeInTheDocument();
    expect(card.querySelector("img")).toBeNull();
  });
});
