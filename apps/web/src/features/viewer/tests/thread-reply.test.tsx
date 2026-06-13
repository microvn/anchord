import { describe, it, expect, mock } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// annotation-core-ui-commenting S-003 — Reply in a thread (flat). The ThreadCard gains an inline
// Reply affordance (Reply button → textarea → Send) that calls an injected onReply(body); the
// reply then shows FLAT under the annotation (one level, never nested deeper, C-005). Bodies render
// INERT (escaped plaintext via React children, C-008). We render ThreadCard directly with a mocked
// onReply so the test asserts the reply WRITE + flat render, not a real round-trip.

import { ThreadCard } from "@/features/viewer/components/thread-card";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

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

/** Render a ThreadCard with a no-op focus + a supplied onReply. */
function renderCard(annotation: ViewerAnnotation, onReply: (body: string) => unknown | Promise<unknown>) {
  return render(
    <ThreadCard
      annotation={annotation}
      focused={false}
      unplaceable={false}
      onFocus={() => {}}
      onReply={onReply}
    />,
  );
}

/** Count nesting depth of reply-list containers — flat means exactly one level. */
function maxReplyListDepth(): number {
  const lists = screen.queryAllByTestId("reply-list");
  let max = 0;
  for (const list of lists) {
    let depth = 1;
    let parent = list.parentElement;
    while (parent) {
      if (parent.getAttribute("data-testid") === "reply-list") depth += 1;
      parent = parent.parentElement;
    }
    max = Math.max(max, depth);
  }
  return max;
}

describe("ThreadCard reply (S-003)", () => {
  it("AS-006: a reply shows flat under the annotation", async () => {
    // Given a thread that already has a first comment, when the reply succeeds the server-revived
    // row carries the new reply flat under the annotation. The card calls onReply; we resolve it and
    // assert the reply renders at one level (a flat reply row), not nested deeper.
    const onReply = mock(async () => true);
    renderCard(thread(), onReply);

    // Click Reply → an inline textarea + Send appear.
    await userEvent.click(screen.getByTestId("reply-open"));
    const input = await screen.findByTestId("reply-input");
    await userEvent.type(input, "Because the trial window is 24h.");
    await userEvent.click(screen.getByTestId("reply-send"));

    // The send calls onReply with the typed body (consumer wires addComment({ body, parentId })).
    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));
    expect(onReply.mock.calls[0]![0]).toBe("Because the trial window is 24h.");

    // The reply shows flat under the thread: exactly one reply row, at one nesting level.
    await waitFor(() => {
      expect(screen.getAllByTestId("reply")).toHaveLength(1);
    });
    expect(screen.getByText("Because the trial window is 24h.")).toBeInTheDocument();
    // Original comment + 1 reply (one root comment, one reply row).
    expect(screen.getByText("Why 24h and not 48h?")).toBeInTheDocument();
    // Flat — one reply-list level, never nested deeper.
    expect(maxReplyListDepth()).toBe(1);
  });

  it("C-005: a reply to a reply still renders flat — one level, never deeper", async () => {
    // A thread that ALREADY carries a reply (so the reply target is itself a reply). Sending another
    // reply must still render under the single flat reply-list — no nested reply-list, no deeper level.
    const onReply = mock(async () => true);
    renderCard(
      thread({
        comments: [
          { id: "cmt-1", parentId: null, authorName: "Mara", body: "First comment.", createdAt: new Date().toISOString() },
          { id: "cmt-2", parentId: "cmt-1", authorName: "Lee", body: "A reply.", createdAt: new Date().toISOString() },
        ],
      }),
      onReply,
    );

    // Pre-existing reply renders flat (one level) before we add more.
    expect(screen.getAllByTestId("reply")).toHaveLength(1);
    expect(maxReplyListDepth()).toBe(1);

    await userEvent.click(screen.getByTestId("reply-open"));
    await userEvent.type(await screen.findByTestId("reply-input"), "Reply to the reply.");
    await userEvent.click(screen.getByTestId("reply-send"));

    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));

    // Two replies now, BOTH flat: still a single reply-list level, no nested deeper container.
    await waitFor(() => {
      expect(screen.getAllByTestId("reply")).toHaveLength(2);
    });
    expect(maxReplyListDepth()).toBe(1);
    // The new reply sits as a sibling under the SAME reply-list as the first reply, not inside it.
    const list = screen.getByTestId("reply-list");
    expect(within(list).getByText("Reply to the reply.")).toBeInTheDocument();
    expect(within(list).getByText("A reply.")).toBeInTheDocument();
  });

  it("C-008: a reply body renders inert (escaped plaintext, no HTML injected)", async () => {
    const onReply = mock(async () => true);
    const xss = "<img src=x onerror=alert(1)>";
    renderCard(thread(), onReply);

    await userEvent.click(screen.getByTestId("reply-open"));
    await userEvent.type(await screen.findByTestId("reply-input"), xss);
    await userEvent.click(screen.getByTestId("reply-send"));

    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));
    const replyRow = await screen.findByTestId("reply");
    // The body shows as text; no injected <img> element exists inside the reply.
    expect(replyRow).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(replyRow.querySelector("img")).toBeNull();
  });
});
