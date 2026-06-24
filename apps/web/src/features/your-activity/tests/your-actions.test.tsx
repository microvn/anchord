import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// your-activity-actions S-001 — the "Your actions" feed render/flow test. We mock the SERVICE CLIENT
// (the Eden thunk `listMyActivity`), the seam the hook calls, so the REAL hook + grouping + the
// REUSED workspace-activity feed/row/detail components run over a real QueryClient. bun's mock.module
// is process-wide + persistent (pattern copied from your-activity/tests/for-you-inbox.test.tsx):
// reset the store in beforeEach and the mock fns in afterEach so nothing leaks into sibling suites.

type Row = {
  id: string;
  type: string;
  actorUserId: string | null;
  actorName: string;
  docId?: string | null;
  projectId?: string | null;
  versionId?: string | null;
  commentId?: string | null;
  annotationId?: string | null;
  summary?: string | null;
  target?: string | null;
  meta?: unknown;
  docTitle?: string | null;
  projectName?: string | null;
  workspaceName?: string | null;
  createdAt: string;
};

let pages: Record<number, Row[]> = {};
let total = 0;
let failPage: number | null = null;
let pending = false;

function envelope<T>(data: T) {
  return { data: { success: true, data }, error: null };
}

const listMyActivity = mock(async (page = 1) => {
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
      limit: 20,
      total,
      totalPages: Math.max(1, Math.ceil(total / 20)),
      hasNext: loaded < total,
      hasPrevious: page > 1,
    },
  });
});

mock.module("@/features/your-activity/services/client", () => ({ listMyActivity }));

const { YourActionsContent } = await import(
  "@/features/your-activity/components/your-actions-content"
);

function renderContent(node = <YourActionsContent />) {
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
    type: "comment",
    actorUserId: "u-mara",
    actorName: "Mara",
    summary: "commented on",
    target: "§Intro",
    createdAt: opts.createdAt ?? "2026-06-24T10:00:00",
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
  listMyActivity.mockClear();
});

describe("Your actions feed (your-activity-actions S-001)", () => {
  it("AS-002: actions span every workspace, each row carrying its own workspace label", async () => {
    pages = {
      1: [
        row("e-acme", {
          type: "publish",
          summary: "published",
          target: "v4",
          meta: { from: 3, to: 4, adds: 5, dels: 2 },
          workspaceName: "Acme Platform",
          docTitle: "Web-core behavior contract",
          createdAt: "2026-06-24T12:00:00",
        }),
        row("e-field", {
          summary: "commented on",
          workspaceName: "Field IO",
          docTitle: "Auth flows",
          createdAt: "2026-06-24T11:00:00",
        }),
      ],
    };
    total = 2;
    renderContent();
    await waitFor(() => expect(screen.getByTestId("activity-feed")).toBeInTheDocument());
    // Both workspace labels render (one chip per row), in ONE feed.
    const chips = screen.getAllByTestId("activity-chip-workspace").map((c) => c.textContent);
    expect(chips).toContain("Acme Platform");
    expect(chips).toContain("Field IO");
  });

  it("AS-003: the feed groups by day, newest day first (client-side, viewer tz)", async () => {
    pages = {
      1: [
        row("t1", { createdAt: "2026-06-24T12:00:00" }),
        row("y1", { createdAt: "2026-06-23T20:00:00" }),
        row("o1", { createdAt: "2026-06-20T15:00:00" }),
      ],
    };
    total = 3;
    renderContent();
    await waitFor(() => expect(screen.getByTestId("activity-feed")).toBeInTheDocument());
    const labels = screen.getAllByTestId("activity-day-label").map((l) => l.textContent);
    // Three distinct day groups; Today leads (most-recent day first).
    expect(labels[0]).toBe("Today");
    expect(labels).toContain("Yesterday");
    expect(labels).toHaveLength(3);
  });

  it("AS-004: pages older actions — page 1 newest, 'Load more' loads the rest into the same feed", async () => {
    pages = {
      1: [row("p1", { createdAt: "2026-06-24T12:00:00" })],
      2: [row("p2", { createdAt: "2026-06-23T11:00:00" })],
    };
    total = 2; // page 1 of 1-of-2 → hasNext true
    const user = userEvent.setup();
    renderContent();
    await waitFor(() => expect(screen.getByTestId("activity-feed")).toBeInTheDocument());
    expect(screen.getAllByTestId("activity-row")).toHaveLength(1); // page 2 not loaded yet
    await user.click(screen.getByTestId("your-actions-load-more"));
    await waitFor(() => expect(screen.getAllByTestId("activity-row")).toHaveLength(2));
    expect(listMyActivity).toHaveBeenCalledWith(2);
  });

  it("AS-005: opening a row shows the REUSED detail component in place", async () => {
    pages = {
      1: [
        row("e-share", {
          type: "share",
          summary: "shared",
          target: "Auth & invite flows",
          docTitle: "Auth & invite flows",
          workspaceName: "Acme Platform",
          meta: { access: "Anyone with link", role: "commenter" },
        }),
      ],
    };
    total = 1;
    const user = userEvent.setup();
    renderContent();
    await waitFor(() => expect(screen.getByTestId("activity-row")).toBeInTheDocument());
    await user.click(screen.getByTestId("activity-row"));
    // The SAME workspace-activity detail component renders (its testid), with a Back control.
    await waitFor(() => expect(screen.getByTestId("activity-detail")).toBeInTheDocument());
    expect(screen.getByTestId("your-actions-back")).toBeInTheDocument();
  });

  it("AS-006: a lost-access row still lists, with genericized display (no current content leaked)", async () => {
    // The BACKEND already genericized: docTitle → placeholder, target null, no quote in meta. The FE
    // must still render the row (never hide it) and never show the original title/section/quote.
    pages = {
      1: [
        row("e-lost", {
          summary: "commented on",
          target: null,
          docTitle: "a document you no longer have access to",
          projectName: null,
          workspaceName: "Acme Platform",
          meta: {},
        }),
      ],
    };
    total = 1;
    renderContent();
    await waitFor(() => expect(screen.getByTestId("activity-row")).toBeInTheDocument());
    const feedEl = screen.getByTestId("activity-feed");
    // The placeholder shows; no leaked section text.
    expect(feedEl.textContent ?? "").toContain("a document you no longer have access to");
    expect(feedEl.textContent ?? "").not.toContain("§Pricing");
  });

  it("AS-007: empty state reads 'No activity yet' with the personal cross-action message", async () => {
    pages = { 1: [] };
    total = 0;
    renderContent();
    const title = await screen.findByText("No activity yet");
    expect(title).toBeInTheDocument();
    const region = screen.getByTestId("your-actions");
    expect(region.textContent ?? "").toMatch(/publish, comment on and share/i);
  });

  it("AS-008: on failure an error state with a Retry control shows (not a blank tab)", async () => {
    failPage = 1;
    renderContent();
    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("AS-003: a loading skeleton shows while the first page loads", async () => {
    pending = true;
    renderContent();
    await waitFor(() => expect(screen.getByTestId("skeleton")).toBeInTheDocument(), { timeout: 1500 });
    expect(screen.queryByTestId("activity-feed")).not.toBeInTheDocument();
  });

  it("C-007: rows render through the REUSED workspace-activity feed + detail components (no rebuild)", async () => {
    pages = { 1: [row("e-1", { workspaceName: "Acme Platform", docTitle: "Doc A" })] };
    total = 1;
    const user = userEvent.setup();
    renderContent();
    // The reused <ActivityFeed> + <ActivityRow> render (their own testids — not a 2b reimplementation).
    await waitFor(() => expect(screen.getByTestId("activity-feed")).toBeInTheDocument());
    expect(screen.getByTestId("activity-row")).toBeInTheDocument();
    // Opening shows the reused <ActivityDetailPage> (its testid), proving the detail is reused too.
    await user.click(screen.getByTestId("activity-row"));
    await waitFor(() => expect(screen.getByTestId("activity-detail")).toBeInTheDocument());
  });
});
