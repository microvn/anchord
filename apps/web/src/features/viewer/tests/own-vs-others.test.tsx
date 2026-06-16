import { describe, it, expect } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// annotation-actions-ui S-001 — own-vs-others attribution from the durable creator id.
//
// Each rail item is attributed to its creator using the annotation's durable `authorId` (served on
// the annotations list read), NOT inferred from the first/root comment. The ThreadCard takes a
// `currentUserId` prop and marks an item as the current user's OWN only when its `authorId` is
// non-null AND equals that id — mirroring the backend null-guard. A guest-created annotation carries
// a null `authorId` and so can never match a signed-in user (it reads as a guest, never own). This
// is the foundation for the later no-self-approve gate (S-002) and delete-own (S-003), so the
// `isOwn` derivation keys on `authorId` alone — never on who wrote the root comment.
//
// We render ThreadCard directly with explicit `authorId` + `currentUserId` so the test asserts the
// own-vs-others flag in isolation, not a real round-trip.

import { ThreadCard } from "@/features/viewer/components/thread-card";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

const ME = "user-me-001";
const OTHER = "user-other-002";

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

function renderCard(annotation: ViewerAnnotation, currentUserId?: string | null) {
  return render(
    <ThreadCard
      annotation={annotation}
      focused={false}
      unplaceable={false}
      onFocus={() => {}}
      currentUserId={currentUserId}
    />,
  );
}

describe("ThreadCard own-vs-others from authorId (annotation-actions-ui S-001)", () => {
  it("AS-001: a member's own annotation (authorId === my id) is attributed to me AND marked own", () => {
    // The root comment author ("Mara") is irrelevant to the OWN flag — only authorId === currentUserId
    // decides own. Here authorId is my id, so the card is marked own even though the root says "Mara".
    renderCard(thread({ authorId: ME }), ME);

    const card = screen.getByTestId("thread-card");
    expect(card.getAttribute("data-own")).toBe("true");
    // The own marker is surfaced on the card (the basis for the later self-only affordances).
    expect(within(card).getByTestId("own-badge")).toBeInTheDocument();
  });

  it("AS-002: another member's annotation (authorId is a different member) is NOT marked own", () => {
    // authorId is another member — the card attributes it to that member and is NOT marked own,
    // even when I am signed in.
    renderCard(thread({ authorId: OTHER }), ME);

    const card = screen.getByTestId("thread-card");
    expect(card.getAttribute("data-own")).toBeNull();
    expect(within(card).queryByTestId("own-badge")).toBeNull();
  });

  it("AS-003: a guest-created annotation (authorId null) reads as a guest, never own", () => {
    // A null authorId matches NO signed-in user — the keystone. Even rendered for a signed-in user,
    // a guest-created annotation is never marked own.
    renderCard(thread({ authorId: null }), ME);

    const card = screen.getByTestId("thread-card");
    expect(card.getAttribute("data-own")).toBeNull();
    expect(within(card).queryByTestId("own-badge")).toBeNull();
  });

  it("C-001: own-vs-others derives from the durable authorId (not the root comment), and null = no one", () => {
    // Edge 1 — authorId present but NO current user (signed-out viewer): never own.
    const { unmount } = renderCard(thread({ authorId: ME }), null);
    expect(screen.getByTestId("thread-card").getAttribute("data-own")).toBeNull();
    expect(screen.queryByTestId("own-badge")).toBeNull();
    unmount();

    // Edge 2 — the root comment author is ME by name, but authorId is a DIFFERENT member: the OWN
    // flag must follow authorId (not own), proving it never derives from the root comment author.
    renderCard(
      thread({
        authorId: OTHER,
        comments: [
          { id: "c", parentId: null, authorName: "Me Myself", body: "mine?", createdAt: new Date().toISOString() },
        ],
      }),
      ME,
    );
    expect(screen.getByTestId("thread-card").getAttribute("data-own")).toBeNull();
    expect(screen.queryByTestId("own-badge")).toBeNull();
  });
});
