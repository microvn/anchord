import { describe, it, expect } from "bun:test";
import { groupByDay, dayLabel } from "./group-by-day";
import type { NotificationItem } from "@/features/notifications/types";

// your-activity-inbox S-001 — single-subject coverage for the client-side day grouping (AS-002 /
// C-006). Uses a FIXED `now` so "Today"/"Yesterday" are deterministic regardless of the clock.

function item(id: string, createdAt: string): NotificationItem {
  return { id, type: "thread_activity", refId: `ref-${id}`, read: false, createdAt, slug: null };
}

const NOW = new Date("2026-06-24T12:00:00");

describe("groupByDay (your-activity-inbox S-001)", () => {
  it("AS-002: groups a newest-first list into Today / Yesterday / earlier, newest day first", () => {
    const items = [
      item("a", "2026-06-24T10:00:00"), // today
      item("b", "2026-06-24T08:00:00"), // today
      item("c", "2026-06-23T09:00:00"), // yesterday
      item("d", "2026-06-20T09:00:00"), // earlier
    ];
    const groups = groupByDay(items, NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Jun 20"]);
    // Today's bucket keeps both rows in their incoming (newest-first) order.
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(groups[1]!.items.map((i) => i.id)).toEqual(["c"]);
  });

  it("C-006: same-day items split across page boundaries merge under ONE header", () => {
    // Simulate two fetched pages concatenated: page 1 ends mid-day, page 2 continues the same day.
    const page1 = [item("a", "2026-06-24T10:00:00"), item("b", "2026-06-24T09:30:00")];
    const page2 = [item("c", "2026-06-24T09:00:00"), item("d", "2026-06-23T22:00:00")];
    const groups = groupByDay([...page1, ...page2], NOW);
    // One "Today" header covering a/b/c (no duplicate), then Yesterday for d.
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("dayLabel: drops the year in the current year, keeps it for an older year", () => {
    expect(dayLabel("2026-03-03T09:00:00", NOW)).toBe("Mar 3");
    expect(dayLabel("2025-12-31T09:00:00", NOW)).toBe("Dec 31, 2025");
  });
});
