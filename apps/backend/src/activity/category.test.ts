// Unit tests for the activity category taxonomy (workspace-activity S-003 / C-003).
//
// Pure mapping + bucketing — no DB, no visibility (the route applies the shared visibility gate
// BEFORE these run; here we prove the taxonomy itself: Versions = publish/restore (AS-011), counts
// bucket correctly over whatever set is handed in (AS-012's "over the visible set" arithmetic).

import { describe, expect, test } from "bun:test";
import { countByCategory, filterByCategory, isActivityCategory, segmentOf } from "./category";
import type { ActivityType } from "./types";

const row = (type: ActivityType) => ({ type });

describe("segmentOf — category mapping (S-003, spec #event-categories)", () => {
  test("Comments = comment/reply/resolve", () => {
    expect(segmentOf("comment")).toBe("comments");
    expect(segmentOf("reply")).toBe("comments");
    expect(segmentOf("resolve")).toBe("comments");
  });
  test("Versions = publish/restore", () => {
    expect(segmentOf("publish")).toBe("versions");
    expect(segmentOf("restore")).toBe("versions");
  });
  test("Sharing = share", () => {
    expect(segmentOf("share")).toBe("sharing");
  });
  test("People = invite/member/member_removed/workspace_renamed", () => {
    expect(segmentOf("invite")).toBe("people");
    expect(segmentOf("member")).toBe("people");
    expect(segmentOf("member_removed")).toBe("people");
    expect(segmentOf("workspace_renamed")).toBe("people");
  });
  test("project/detached map to no named segment (All only)", () => {
    expect(segmentOf("project")).toBeNull();
    expect(segmentOf("detached")).toBeNull();
  });
});

describe("filterByCategory (S-003)", () => {
  test("AS-011: the Versions filter returns ONLY publish/restore events", () => {
    const rows = [row("comment"), row("publish"), row("restore"), row("share"), row("reply")];
    const versions = filterByCategory(rows, "versions");
    expect(versions.map((r) => r.type)).toEqual(["publish", "restore"]);
  });
  test("'all' returns every row, order preserved", () => {
    const rows = [row("comment"), row("publish"), row("share")];
    expect(filterByCategory(rows, "all")).toEqual(rows);
  });
  test("a named filter with no matching rows returns empty (drives the no-results state, AS-013)", () => {
    const rows = [row("comment"), row("publish")];
    expect(filterByCategory(rows, "sharing")).toEqual([]);
  });
});

describe("countByCategory (S-003)", () => {
  test("AS-012: counts bucket the given (visible) set; all = total, project/detached only in all", () => {
    const rows = [
      row("comment"), row("reply"), row("resolve"), // 3 comments
      row("publish"), row("restore"), // 2 versions
      row("share"), // 1 sharing
      row("invite"), row("member"), // 2 people
      row("project"), row("detached"), // other → all only
    ];
    expect(countByCategory(rows)).toEqual({ all: 10, comments: 3, versions: 2, sharing: 1, people: 2 });
  });
  test("counts never exceed the input set (a count of N requires N input rows — AS-012)", () => {
    const rows = [row("comment"), row("comment")];
    const counts = countByCategory(rows);
    expect(counts.all).toBe(2);
    expect(counts.comments).toBe(2);
    expect(counts.versions + counts.sharing + counts.people).toBe(0);
  });
});

describe("isActivityCategory (S-003 — query-param validation)", () => {
  test("accepts the five segments, rejects junk", () => {
    for (const c of ["all", "comments", "versions", "sharing", "people"]) expect(isActivityCategory(c)).toBe(true);
    expect(isActivityCategory("bogus")).toBe(false);
    expect(isActivityCategory(undefined)).toBe(false);
  });
});
