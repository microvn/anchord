import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// your-activity-inbox S-001 — the For-you inbox render/flow test. We mock the notifications SERVICE
// CLIENT (the Eden thunk `listNotifications`), the seam the For-you hook calls, so the REAL hook +
// grouping + components run over a real QueryClient. bun's mock.module is process-wide + persistent
// (pattern copied from notifications/tests/bell-flow.test.tsx): reset the store in beforeEach and the
// mock fns in afterEach so nothing leaks into sibling suites.

type Row = {
  id: string;
  type: string;
  refId: string;
  read: boolean;
  createdAt: string;
  slug: string | null;
  docTitle?: string | null;
  actorName?: string | null;
  snippet?: string | null;
  quote?: string | null;
  refLabel?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
};

// `pages` is page-number → that page's rows. `failPage` (if set) makes that page reject.
let pages: Record<number, Row[]> = {};
let total = 0;
let failPage: number | null = null;
let pending = false;

function envelope<T>(data: T) {
  return { data: { success: true, data }, error: null };
}

const listNotifications = mock(async (page = 1) => {
  if (pending) await new Promise((r) => setTimeout(r, 10_000)); // never resolves within the test
  if (failPage === page) return { data: null, error: { status: 500, value: { message: "boom" } } };
  const items = pages[page] ?? [];
  const loaded = Object.entries(pages)
    .filter(([p]) => Number(p) <= page)
    .reduce((n, [, rows]) => n + rows.length, 0);
  return envelope({
    items,
    pagination: {
      page,
      limit: 50,
      total,
      totalPages: Math.max(1, Math.ceil(total / 50)),
      hasNext: loaded < total,
      hasPrevious: page > 1,
    },
  });
});

// bun's mock.module replaces the WHOLE module process-wide, so a partial mock would strip the
// client's other exports (e.g. updateNotificationPreference) and break sibling suites that import
// them. Re-export every name; only listNotifications is exercised here.
const fetchUnreadCount = mock(async () => envelope({ count: 0 }));
const markNotificationRead = mock(async () => envelope({ read: true }));
const markAllNotificationsRead = mock(async () => envelope({ marked: 0 }));
const fetchNotificationPreferences = mock(async () => envelope({}));
const updateNotificationPreference = mock(async () => envelope({}));

mock.module("@/features/notifications/services/client", () => ({
  listNotifications,
  fetchUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
  fetchNotificationPreferences,
  updateNotificationPreference,
}));

const { ForYouContent } = await import("@/features/your-activity/components/for-you-content");
const { YourActivityPage } = await import(
  "@/features/your-activity/components/your-activity-page"
);

function renderContent(node = <ForYouContent />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function row(id: string, opts: Partial<Row> = {}): Row {
  return {
    id,
    type: "reply",
    refId: `ref-${id}`,
    read: false,
    createdAt: opts.createdAt ?? "2026-06-24T10:00:00",
    slug: `doc-${id}`,
    ...opts,
  };
}

beforeEach(() => {
  pages = {};
  total = 0;
  failPage = null;
  pending = false;
});
afterEach(() => {
  listNotifications.mockClear();
});

describe("For-you inbox (your-activity-inbox S-001)", () => {
  it("AS-001: lists the caller's notifications across workspaces in one list, newest-first", async () => {
    pages = {
      1: [
        row("a1", { workspaceName: "Acme Platform", createdAt: "2026-06-24T12:00:00" }),
        row("a2", { workspaceName: "Acme Platform", createdAt: "2026-06-24T11:00:00" }),
        row("a3", { workspaceName: "Acme Platform", createdAt: "2026-06-24T10:00:00" }),
        row("f1", { workspaceName: "Field IO", createdAt: "2026-06-24T09:00:00" }),
      ],
    };
    total = 4;
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-list")).toBeInTheDocument());
    // All four (3 Acme + 1 Field IO) appear in one list.
    for (const id of ["a1", "a2", "a3", "f1"]) {
      expect(screen.getByTestId(`inbox-row-${id}`)).toBeInTheDocument();
    }
    // Newest-first: row a1 (12:00) precedes f1 (09:00) in DOM order.
    const list = screen.getByTestId("inbox-list");
    const order = within(list)
      .getAllByTestId(/^inbox-row-/)
      .map((el) => el.getAttribute("data-testid"));
    expect(order).toEqual(["inbox-row-a1", "inbox-row-a2", "inbox-row-a3", "inbox-row-f1"]);
  });

  it("AS-002: items group by day under Today / Yesterday / dated labels, most-recent first", async () => {
    pages = {
      1: [
        row("t1", { createdAt: "2026-06-24T12:00:00" }),
        row("t2", { createdAt: "2026-06-24T08:00:00" }),
        row("y1", { createdAt: "2026-06-23T20:00:00" }),
        row("y2", { createdAt: "2026-06-23T09:00:00" }),
        row("o1", { createdAt: "2026-06-20T15:00:00" }),
        row("o2", { createdAt: "2026-06-20T09:00:00" }),
      ],
    };
    total = 6;
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-list")).toBeInTheDocument());
    // Day labels render; Today leads (most-recent day first). (Labels are viewer-local; this asserts
    // the three distinct day headers exist and are ordered newest-first.)
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    // All six rows present.
    expect(within(screen.getByTestId("inbox-list")).getAllByTestId(/^inbox-row-/)).toHaveLength(6);
  });

  it("AS-003: a reply row on an Acme Platform doc shows a workspace chip naming it", async () => {
    pages = {
      1: [
        row("r1", {
          type: "reply",
          actorName: "Priya",
          docTitle: "Web-core behavior contract",
          workspaceName: "Acme Platform",
        }),
      ],
    };
    total = 1;
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-row-r1")).toBeInTheDocument());
    const chip = screen.getByTestId("inbox-chip-workspace-r1");
    expect(chip).toHaveTextContent("Acme Platform");
  });

  it("a reply row renders the anchored quote AND the comment-body preview as distinct lines", async () => {
    pages = {
      1: [
        row("rq", {
          type: "reply",
          actorName: "Devin",
          docTitle: "Render + publish pipeline RFC",
          workspaceName: "Acme Platform",
          quote: "All AI-generated HTML is sanitized server-side before storage.",
          snippet: "Should we sanitize before the render step or after?",
        }),
      ],
    };
    total = 1;
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-row-rq")).toBeInTheDocument());
    // Both the anchored quote and the body preview render (the quote is NOT a data gap — it comes
    // from the read-repo `quote` enrichment off the annotation's textSnippet).
    expect(screen.getByText(/All AI-generated HTML is sanitized/)).toBeInTheDocument();
    expect(screen.getByText(/Should we sanitize before the render step/)).toBeInTheDocument();
  });

  it("AS-004: empty state reads 'You're all caught up' with a cross-workspace, mention-free message", async () => {
    pages = { 1: [] };
    total = 0;
    renderContent();
    const empty = await screen.findByText("You're all caught up");
    expect(empty).toBeInTheDocument();
    // C-005: the copy must NOT promise mentions.
    const region = empty.closest("div")!;
    expect(region.textContent ?? "").not.toMatch(/mention/i);
    expect(region.textContent ?? "").toMatch(/workspace/i);
  });

  it("AS-005: a skeleton shows while loading", async () => {
    pending = true; // listNotifications never resolves within the test window
    renderContent();
    // Skeleton has a 300ms delay guard; wait for it to appear.
    await waitFor(() => expect(screen.getByTestId("skeleton")).toBeInTheDocument(), { timeout: 1500 });
    expect(screen.queryByTestId("inbox-list")).not.toBeInTheDocument();
  });

  it("AS-005: on failure an error state with a Retry control shows (not a blank page)", async () => {
    failPage = 1;
    renderContent();
    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("C-006: 'Load more' pages in beyond page 1 and merges into the same list", async () => {
    pages = {
      1: [row("p1", { createdAt: "2026-06-24T12:00:00" })],
      2: [row("p2", { createdAt: "2026-06-24T11:00:00" })],
    };
    total = 2; // page 1 of 1-of-2 → hasNext true
    const user = userEvent.setup();
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-row-p1")).toBeInTheDocument());
    // Page 2 not loaded yet.
    expect(screen.queryByTestId("inbox-row-p2")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("inbox-load-more"));
    // Page 2's row joins the SAME list (no replacement).
    await waitFor(() => expect(screen.getByTestId("inbox-row-p2")).toBeInTheDocument());
    expect(screen.getByTestId("inbox-row-p1")).toBeInTheDocument();
    expect(listNotifications).toHaveBeenCalledWith(2);
  });

  it("C-009: a notification from a (left) workspace still shows — no membership filter", async () => {
    // The read carries the workspace chip even for a workspace the user has left (matches the bell).
    pages = { 1: [row("left1", { workspaceName: "Former Co" })] };
    total = 1;
    renderContent();
    await waitFor(() => expect(screen.getByTestId("inbox-row-left1")).toBeInTheDocument());
    expect(screen.getByTestId("inbox-chip-workspace-left1")).toHaveTextContent("Former Co");
  });

  it("C-005: the page defaults to the For-you surface, mention-free (two-tab page since 2b S-002)", async () => {
    // your-activity-actions S-002 SUPERSEDES the original single-surface assertion: the page is now a
    // two-tab shell ("For you" | "Your actions"), so a "Your actions" TAB legitimately exists. What 2a
    // still owns: For you is the DEFAULT surface, and the page copy stays mention-free (C-005).
    pages = { 1: [row("x1", { workspaceName: "Acme Platform" })] };
    total = 1;
    renderContent(<YourActivityPage />);
    await waitFor(() => expect(screen.getByTestId("your-activity-page")).toBeInTheDocument());
    // Default surface is the For-you inbox (2a's content).
    await waitFor(() => expect(screen.getByTestId("for-you-content")).toBeInTheDocument());
    // Subtitle / page copy is mention-free (C-005).
    expect(screen.getByTestId("your-activity-page").textContent ?? "").not.toMatch(/mention/i);
  });
});
