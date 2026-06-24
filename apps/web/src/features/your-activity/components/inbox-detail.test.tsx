import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InboxDetail } from "@/features/your-activity/components/inbox-detail";
import type { NotificationItem } from "@/features/notifications/types";

// S-004 added reply/resolve mutations (useMutation) to the detail, so it now needs a QueryClient in
// context. This single-subject test stays presentational — it just supplies a provider; the reply
// flow itself (post/resolve/refusal) is covered by tests/reply-from-inbox.test.tsx.

// your-activity-inbox S-003 — single-subject test for the item DETAIL. The detail is a pure
// presentational component over the REAL `NotificationItem`: it shows the metadata that EXISTS
// (actor / workspace / document / when + snippet), an "Open in doc" link gated on a resolvable slug,
// and marks the item read once on mount for an UNREAD row (C-008). No network — the mark-read
// mutation is passed in, so we assert with a plain mock fn.

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: "n1",
    type: "reply",
    refId: "anno-1",
    read: false,
    createdAt: "2026-06-24T10:00:00.000Z",
    slug: "web-core-behavior-contract",
    docTitle: "Web-core behavior contract",
    actorName: "Priya",
    snippet: "Agreed — shipping in v3",
    workspaceName: "Acme Platform",
    ...overrides,
  };
}

function renderDetail(it: NotificationItem, onMarkRead = mock(() => {})) {
  return {
    onMarkRead,
    ...render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <InboxDetail item={it} onMarkRead={onMarkRead} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

describe("Inbox item detail (your-activity-inbox S-003)", () => {
  beforeEach(() => {});

  it("AS-011: detail shows actor, workspace, document, when, and the body/snippet", () => {
    renderDetail(item());
    // Actor (from `actorName`) — appears in the hero sentence and the From row.
    expect(screen.getAllByText("Priya").length).toBeGreaterThan(0);
    // Workspace (`workspaceName`).
    expect(screen.getByText("Acme Platform")).toBeInTheDocument();
    // Document (`docTitle`).
    expect(screen.getAllByText("Web-core behavior contract").length).toBeGreaterThan(0);
    // The body/preview comes from `snippet`.
    expect(screen.getByTestId("inbox-detail-snippet")).toHaveTextContent("Agreed — shipping in v3");
    // The key/value labels render.
    expect(screen.getByText("From")).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("Document")).toBeInTheDocument();
    expect(screen.getByText("When")).toBeInTheDocument();
  });

  it("AS-011: a field with no value (e.g. no snippet) renders null-safe — its block is absent", () => {
    renderDetail(item({ snippet: null }));
    expect(screen.queryByTestId("inbox-detail-snippet")).not.toBeInTheDocument();
    // Other present fields still render.
    expect(screen.getByText("Acme Platform")).toBeInTheDocument();
  });

  it("AS-012: 'Open in doc' is shown with the deep-link href for a doc-backed item with a slug", () => {
    renderDetail(item({ slug: "the-doc", refId: "anno-42" }));
    const link = screen.getByTestId("inbox-detail-open-doc");
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/d/the-doc#annotation-anno-42");
  });

  it("AS-012: 'Open in doc' is HIDDEN for a workspace_invited item (no slug → deepLinkFor null)", () => {
    renderDetail(
      item({ type: "workspace_invited", slug: null, refId: "inv-1", refLabel: "Mercury Docs" }),
    );
    expect(screen.queryByTestId("inbox-detail-open-doc")).not.toBeInTheDocument();
  });

  it("AS-012: 'Open in doc' is HIDDEN when the doc was deleted (null slug)", () => {
    renderDetail(item({ slug: null }));
    expect(screen.queryByTestId("inbox-detail-open-doc")).not.toBeInTheDocument();
  });

  it("AS-006: opening an UNREAD item's detail marks it read exactly once (C-008)", () => {
    const { onMarkRead } = renderDetail(item({ read: false }));
    expect(onMarkRead).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledWith("n1");
  });

  it("AS-006: opening an ALREADY-read item does NOT re-mark it", () => {
    const { onMarkRead } = renderDetail(item({ read: true }));
    expect(onMarkRead).not.toHaveBeenCalled();
  });
});
