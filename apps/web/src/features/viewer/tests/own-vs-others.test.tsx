import { describe, it, expect } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// annotation-actions-ui S-001 (C-001) — own-vs-others is INTERNAL; the rail ALWAYS shows the real name.
//
// The rail ALWAYS shows an annotation's REAL author name + avatar — own and others displayed
// identically: NO "You" relabel, NO visible own marker (an authenticated user has an identity). The
// own-vs-others determination keys on the annotation's durable `authorId` (served on the list read),
// NOT inferred from the first/root comment, and is kept purely INTERNAL — it only drives the
// no-self-approve gate (S-002) and delete-own (S-003). An item is the current user's OWN only when
// its `authorId` is non-null AND equals `currentUserId` (mirroring the backend null-guard); a
// guest-created annotation (null `authorId`) matches no signed-in user. The internal flag is exposed
// to tests/gates via the non-visible `data-own` attribute on the card — there is no visible badge.
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
  it("AS-001: a member's own annotation shows their REAL name + avatar (no 'You' relabel), own kept internal", () => {
    // The rail shows the real comment-author name ("Demo User") the SAME way as any other author —
    // NO "You" relabel, NO visible own marker. The own-vs-others determination (authorId === my id)
    // stays INTERNAL, exposed only via the non-visible data-own hook for the gates.
    renderCard(
      thread({
        authorId: ME,
        comments: [
          { id: "c", parentId: null, authorName: "Demo User", body: "mine", createdAt: new Date().toISOString() },
        ],
      }),
      ME,
    );

    const card = screen.getByTestId("thread-card");
    const header = within(card).getByTestId("thread-header");
    // The REAL author name is shown — not "You".
    expect(within(header).getByText("Demo User")).toBeInTheDocument();
    expect(within(header).queryByText("You")).toBeNull();
    // No visible own marker.
    expect(within(card).queryByTestId("own-badge")).toBeNull();
    // Own stays INTERNAL — recorded on the non-visible data-own hook (drives the gates).
    expect(card.getAttribute("data-own")).toBe("true");
  });

  it("AS-002: another member's annotation shows that member's name (same treatment, not own)", () => {
    // authorId is another member — the card attributes it to that member, with NO visible own/other
    // distinction, and is NOT internally own even when I am signed in.
    renderCard(
      thread({
        authorId: OTHER,
        comments: [
          { id: "c", parentId: null, authorName: "Mara", body: "theirs", createdAt: new Date().toISOString() },
        ],
      }),
      ME,
    );

    const card = screen.getByTestId("thread-card");
    expect(within(card).getByText("Mara")).toBeInTheDocument();
    expect(card.getAttribute("data-own")).toBeNull();
    expect(within(card).queryByTestId("own-badge")).toBeNull();
  });

  it("AS-003: a guest-created annotation (authorId null) shows the guest name + Guest pill, never own", () => {
    // A null authorId matches NO signed-in user — the keystone. The guest's self-entered name + the
    // Guest pill show; the item is never internally own.
    renderCard(
      thread({
        authorId: null,
        comments: [
          { id: "c", parentId: null, authorName: null, guestName: "Visitor Vee", body: "guest note", createdAt: new Date().toISOString() },
        ],
      }),
      ME,
    );

    const card = screen.getByTestId("thread-card");
    const header = within(card).getByTestId("thread-header");
    expect(within(header).getByText("Visitor Vee")).toBeInTheDocument();
    expect(within(header).getByTestId("guest-badge")).toBeInTheDocument();
    expect(within(header).queryByText("You")).toBeNull();
    expect(card.getAttribute("data-own")).toBeNull();
    expect(within(card).queryByTestId("own-badge")).toBeNull();
  });

  it("C-001: own derives from the durable authorId (not the root comment); null = no one; never a 'You' relabel", () => {
    // Edge 1 — authorId present but NO current user (signed-out viewer): never own, shows real name.
    const { unmount } = renderCard(
      thread({
        authorId: ME,
        comments: [
          { id: "c", parentId: null, authorName: "Demo User", body: "x", createdAt: new Date().toISOString() },
        ],
      }),
      null,
    );
    let card = screen.getByTestId("thread-card");
    expect(card.getAttribute("data-own")).toBeNull();
    expect(within(card).getByText("Demo User")).toBeInTheDocument();
    expect(within(card).queryByTestId("own-badge")).toBeNull();
    unmount();

    // Edge 2 — the root comment author is ME by name, but authorId is a DIFFERENT member: the OWN
    // flag must follow authorId (not own), proving it never derives from the root comment author.
    // The real name still shows (no "You" relabel regardless).
    renderCard(
      thread({
        authorId: OTHER,
        comments: [
          { id: "c", parentId: null, authorName: "Me Myself", body: "mine?", createdAt: new Date().toISOString() },
        ],
      }),
      ME,
    );
    card = screen.getByTestId("thread-card");
    expect(card.getAttribute("data-own")).toBeNull();
    expect(within(card).getByText("Me Myself")).toBeInTheDocument();
    expect(within(card).queryByTestId("own-badge")).toBeNull();
  });
});
