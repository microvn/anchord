import { describe, it, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import { ActivityStatsRail } from "@/features/activity/components/activity-stats-rail";
import type { ActivityStats } from "@/features/activity/types";

// <ActivityStatsRail/> (workspace-activity S-007). PRESENTATIONAL — it renders the server-computed
// stats (trailing-7-day window + visible-set filtering happen on the server, C-006/C-003). These
// tests assert the rail renders the supplied (already-filtered, already-windowed) payload faithfully:
// the headline count, contributors in the given order (AS-027), and the busiest-doc name (AS-028).
// The rail never re-derives visibility — it shows exactly what the server returned for THIS viewer.

const stats = (over: Partial<ActivityStats> = {}): ActivityStats => ({
  counts: { all: 10, comments: 6, versions: 2, sharing: 1, people: 1 },
  contributors: [
    { name: "Mara", count: 5 },
    { name: "Devin", count: 3 },
    { name: "Priya", count: 2 },
  ],
  busiestDoc: { docId: "d-rfc", name: "Render pipeline RFC", events: 5 },
  ...over,
});

describe("ActivityStatsRail (S-007)", () => {
  it("renders the trailing-7-day headline event count", () => {
    render(<ActivityStatsRail stats={stats()} />);
    expect(screen.getByTestId("stat-recent-count").textContent).toBe("10");
  });

  it("AS-027: lists contributors in the order given (server-ranked highest-first)", () => {
    render(<ActivityStatsRail stats={stats()} />);
    const names = screen.getAllByTestId("contributor-row").map((r) => r.textContent ?? "");
    // The first name in each row is its contributor; assert Mara → Devin → Priya order is preserved.
    expect(names[0]).toContain("Mara");
    expect(names[0]).toContain("5");
    expect(names[1]).toContain("Devin");
    expect(names[2]).toContain("Priya");
  });

  it("AS-028: shows the busiest doc by the name the server returned (the viewer's visible set)", () => {
    render(<ActivityStatsRail stats={stats()} />);
    expect(screen.getByTestId("busiest-doc-name").textContent).toBe("Render pipeline RFC");
  });

  it("AS-028: when the server returns no busiest doc (none visible), the rail names none", () => {
    render(<ActivityStatsRail stats={stats({ busiestDoc: null })} />);
    expect(screen.queryByTestId("busiest-doc-name")).toBeNull();
  });

  it("renders nothing while the stats are still loading", () => {
    render(<ActivityStatsRail loading />);
    expect(screen.queryByTestId("activity-stats-rail")).toBeNull();
  });
});
