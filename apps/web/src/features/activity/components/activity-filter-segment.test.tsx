import { describe, it, expect, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ActivityFilterSegment } from "@/features/activity/components/activity-filter-segment";

// Presentational <ActivityFilterSegment/> (workspace-activity S-003). Renders the five segments with
// their per-category counts and reports a selection. The counts come straight from props (the
// server's visible-set bucketing) — never recomputed here (AS-012).

const COUNTS = { all: 11, comments: 3, versions: 2, sharing: 1, people: 2 };

describe("ActivityFilterSegment (workspace-activity S-003)", () => {
  it("AS-011: renders All / Comments / Versions / Sharing / People and reports the selection", async () => {
    const onChange = mock(() => {});
    render(<ActivityFilterSegment active="all" counts={COUNTS} onChange={onChange} />);
    for (const id of ["all", "comments", "versions", "sharing", "people"]) {
      expect(screen.getByTestId(`activity-filter-${id}`)).toBeTruthy();
    }
    await userEvent.click(screen.getByTestId("activity-filter-versions"));
    expect(onChange).toHaveBeenCalledWith("versions");
  });

  it("AS-012: shows the per-category counts from props (the server's visible-set buckets)", () => {
    render(<ActivityFilterSegment active="all" counts={COUNTS} onChange={() => {}} />);
    expect(screen.getByTestId("activity-filter-count-all").textContent).toBe("11");
    expect(screen.getByTestId("activity-filter-count-comments").textContent).toBe("3");
    expect(screen.getByTestId("activity-filter-count-versions").textContent).toBe("2");
    expect(screen.getByTestId("activity-filter-count-sharing").textContent).toBe("1");
    expect(screen.getByTestId("activity-filter-count-people").textContent).toBe("2");
  });

  it("marks the active segment as selected (aria-selected)", () => {
    render(<ActivityFilterSegment active="versions" counts={COUNTS} onChange={() => {}} />);
    expect(screen.getByTestId("activity-filter-versions").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("activity-filter-all").getAttribute("aria-selected")).toBe("false");
  });

  it("renders zeros when counts are absent (no crash before the first load)", () => {
    render(<ActivityFilterSegment active="all" onChange={() => {}} />);
    expect(screen.getByTestId("activity-filter-count-all").textContent).toBe("0");
  });
});
