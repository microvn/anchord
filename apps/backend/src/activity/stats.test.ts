// Unit tests for the pure stats-rail aggregator (workspace-activity S-007).
//
// `computeStats` aggregates the ALREADY-VISIBLE row set (the route filters through the ONE shared
// visibility gate first — C-003/F-7 — then hands the visible rows here) over a trailing 7-day
// window (C-006). It NEVER decides visibility itself; that is the route's gate. So every assertion
// here is about windowing + aggregation, not access.
//
// AS map:
//   AS-026  events older than 7 days are excluded from every aggregate
//   AS-027  contributors ranked highest-first by event count

import { describe, expect, test } from "bun:test";
import { computeStats } from "./stats";
import type { ActivityRow } from "./repo";

// A fixed "now" so the window math is deterministic.
const NOW = new Date(2026, 5, 24, 9, 0, 0);
const daysAgo = (n: number) => new Date(2026, 5, 24 - n, 9, 0, 0);

let seq = 0;
function row(over: Partial<ActivityRow> & { createdAt: Date }): ActivityRow {
  return {
    id: `e-${seq++}`,
    type: "comment",
    actorUserId: "u-x",
    actorName: "X",
    docId: null,
    projectId: null,
    versionId: null,
    commentId: null,
    annotationId: null,
    summary: null,
    target: null,
    meta: null,
    ...over,
  };
}

describe("computeStats — trailing 7-day window (C-006 / AS-026)", () => {
  test("AS-026: events older than 7 days are excluded from the counts and contributors", () => {
    const rows: ActivityRow[] = [
      // inside the window (days 0..6)
      row({ createdAt: daysAgo(0), actorName: "Mara" }),
      row({ createdAt: daysAgo(3), actorName: "Mara" }),
      row({ createdAt: daysAgo(6), actorName: "Devin" }),
      // older than 7 days (days 8..10) — must be excluded
      row({ createdAt: daysAgo(8), actorName: "Old" }),
      row({ createdAt: daysAgo(9), actorName: "Old" }),
      row({ createdAt: daysAgo(10), actorName: "Old" }),
    ];
    const stats = computeStats(rows, NOW);
    // only the 3 in-window events count
    expect(stats.counts.all).toBe(3);
    // the day-7..9 actor never appears in the contributors
    expect(stats.contributors.map((c) => c.name)).not.toContain("Old");
  });

  test("AS-026: per-category counts also cover only the window", () => {
    const rows: ActivityRow[] = [
      row({ createdAt: daysAgo(1), type: "comment" }),
      row({ createdAt: daysAgo(2), type: "publish" }),
      row({ createdAt: daysAgo(8), type: "publish" }), // stale → excluded
      row({ createdAt: daysAgo(8), type: "share" }), // stale → excluded
    ];
    const stats = computeStats(rows, NOW);
    expect(stats.counts).toEqual({ all: 2, comments: 1, versions: 1, sharing: 0, people: 0 });
  });
});

describe("computeStats — contributors ranked (AS-027)", () => {
  test("AS-027: 'most active' lists contributors highest-first by in-window event count", () => {
    const rows: ActivityRow[] = [
      ...Array.from({ length: 5 }, () => row({ createdAt: daysAgo(1), actorName: "Mara" })),
      ...Array.from({ length: 3 }, () => row({ createdAt: daysAgo(2), actorName: "Devin" })),
      ...Array.from({ length: 2 }, () => row({ createdAt: daysAgo(3), actorName: "Priya" })),
    ];
    const stats = computeStats(rows, NOW);
    expect(stats.contributors).toEqual([
      { name: "Mara", count: 5 },
      { name: "Devin", count: 3 },
      { name: "Priya", count: 2 },
    ]);
  });

  test("AS-027: the System actor and rows with no actorName still rank by their display name", () => {
    const rows: ActivityRow[] = [
      row({ createdAt: daysAgo(1), actorName: "System" }),
      row({ createdAt: daysAgo(1), actorName: "System" }),
      row({ createdAt: daysAgo(1), actorName: "Mara" }),
    ];
    const stats = computeStats(rows, NOW);
    expect(stats.contributors[0]).toEqual({ name: "System", count: 2 });
  });
});

describe("computeStats — busiest doc (AS-028 aggregate side)", () => {
  test("the busiest doc is the doc with the most in-window events; its name comes from the row target", () => {
    const rows: ActivityRow[] = [
      row({ createdAt: daysAgo(0), docId: "d-rfc", target: "Render pipeline RFC", type: "comment" }),
      row({ createdAt: daysAgo(1), docId: "d-rfc", target: "Render pipeline RFC", type: "comment" }),
      row({ createdAt: daysAgo(1), docId: "d-rfc", target: "Render pipeline RFC", type: "publish" }),
      row({ createdAt: daysAgo(2), docId: "d-notes", target: "Meeting notes", type: "comment" }),
    ];
    const stats = computeStats(rows, NOW);
    expect(stats.busiestDoc?.docId).toBe("d-rfc");
    expect(stats.busiestDoc?.name).toBe("Render pipeline RFC");
    expect(stats.busiestDoc?.events).toBe(3);
  });

  test("workspace-level rows (docId null) never become the busiest doc", () => {
    const rows: ActivityRow[] = [
      row({ createdAt: daysAgo(0), docId: null, type: "member" }),
      row({ createdAt: daysAgo(0), docId: null, type: "invite" }),
      row({ createdAt: daysAgo(1), docId: "d-rfc", target: "RFC", type: "comment" }),
    ];
    const stats = computeStats(rows, NOW);
    expect(stats.busiestDoc?.docId).toBe("d-rfc");
  });

  test("no doc-scoped events in the window → busiestDoc is null", () => {
    const rows: ActivityRow[] = [row({ createdAt: daysAgo(0), docId: null, type: "member" })];
    const stats = computeStats(rows, NOW);
    expect(stats.busiestDoc).toBeNull();
  });
});
