import { describe, it, expect, mock } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityFeed } from "@/features/activity/components/activity-feed";
import type { ActivityEventRow } from "@/features/activity/types";

// Presentational <ActivityFeed/> (workspace-activity S-001). Rows-as-props, so these tests feed
// rows directly — no fetch. Covers the day-grouping (AS-002), the newest-first comment sentence
// (AS-001), the empty state (AS-004), and the retryable error state (AS-005).

const iso = (d: Date) => d.toISOString();
const today = new Date();
const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

function row(over: Partial<ActivityEventRow> & { id: string; createdAt: string }): ActivityEventRow {
  return {
    type: "comment",
    actorUserId: "u",
    actorName: "Devin",
    docId: "d-1",
    projectId: null,
    versionId: null,
    commentId: "c-1",
    annotationId: "a-1",
    summary: "commented on",
    target: "Render + publish pipeline RFC",
    meta: null,
    ...over,
  };
}

describe("ActivityFeed (workspace-activity S-001)", () => {
  it("AS-001: the newest row reads that Devin commented on the doc, under Today", () => {
    const rows = [
      row({ id: "newest", createdAt: iso(today), actorName: "Devin" }),
      row({ id: "older", createdAt: iso(yesterday), actorName: "Someone Else" }),
    ];
    render(<ActivityFeed rows={rows} />);
    const groups = screen.getAllByTestId("activity-day-group");
    // Most-recent day first → the first group is Today and its first row is Devin's comment.
    const firstLabel = within(groups[0]).getByTestId("activity-day-label");
    expect(firstLabel.textContent).toBe("Today");
    const feedRows = screen.getAllByTestId("activity-row");
    expect(feedRows[0].textContent).toContain("Devin");
    expect(feedRows[0].textContent).toContain("commented on");
    expect(feedRows[0].textContent).toContain("Render + publish pipeline RFC");
    expect(feedRows[0].getAttribute("data-activity-type")).toBe("comment");
  });

  it("AS-002.T1: rows are grouped under day labels (Today / Yesterday / dated)", () => {
    const rows = [
      row({ id: "t1", createdAt: iso(today) }),
      row({ id: "y1", createdAt: iso(yesterday) }),
      row({ id: "d1", createdAt: iso(threeDaysAgo) }),
    ];
    render(<ActivityFeed rows={rows} />);
    const labels = screen.getAllByTestId("activity-day-label").map((n) => n.textContent);
    expect(labels[0]).toBe("Today");
    expect(labels[1]).toBe("Yesterday");
    // The third day is a DATED label (not Today/Yesterday).
    expect(labels[2]).not.toBe("Today");
    expect(labels[2]).not.toBe("Yesterday");
    expect(labels[2]).toMatch(/[A-Z][a-z]{2} \d{1,2}/); // e.g. "Jun 20"
  });

  it("AS-002.T2: most-recent day first, newest-first within each day; same-day rows merge under one header", () => {
    // Two events today (newer then older) + one yesterday — 6-events-across-3-days shape, condensed.
    const tNewer = new Date(today.getTime());
    const tOlder = new Date(today.getTime() - 60 * 60 * 1000); // an hour earlier, still today
    const rows = [
      row({ id: "t-newer", createdAt: iso(tNewer), summary: "newer" }),
      row({ id: "t-older", createdAt: iso(tOlder), summary: "older" }),
      row({ id: "y1", createdAt: iso(yesterday) }),
    ];
    render(<ActivityFeed rows={rows} />);
    const groups = screen.getAllByTestId("activity-day-group");
    // Same-day rows collapse under ONE Today header (not two) — Today group + Yesterday group.
    const todayGroups = groups.filter(
      (g) => within(g).getByTestId("activity-day-label").textContent === "Today",
    );
    expect(todayGroups).toHaveLength(1);
    // The Today header reports its 2-event count.
    expect(groups[0].textContent).toContain("2 events");
    // Within Today, the newer row precedes the older (newest-first preserved).
    const allRows = screen.getAllByTestId("activity-row");
    expect(allRows[0].textContent).toContain("newer");
    expect(allRows[1].textContent).toContain("older");
  });

  it("AS-004: zero rows renders the 'No activity yet' empty state", () => {
    render(<ActivityFeed rows={[]} />);
    expect(screen.getByText("No activity yet")).toBeTruthy();
    expect(screen.getByText(/Comments, publishes and version changes/i)).toBeTruthy();
    expect(screen.queryByTestId("activity-feed")).toBeNull();
  });

  it("AS-005: an error renders the retryable ErrorState (not a blank page); Retry re-runs the load", async () => {
    const onRetry = mock(() => {});
    render(<ActivityFeed rows={[]} error="The feed failed to load" onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toContain("The feed failed to load");
    const retry = screen.getByRole("button", { name: /retry/i });
    await userEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("F-12: actorName is rendered as escaped text, never as HTML", () => {
    const rows = [row({ id: "x", createdAt: iso(today), actorName: "<img src=x onerror=alert(1)>" })];
    render(<ActivityFeed rows={rows} />);
    // The raw markup appears as TEXT (escaped) and no <img> element is injected.
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
  });
});
