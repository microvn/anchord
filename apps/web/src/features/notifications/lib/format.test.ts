import { describe, it, expect } from "bun:test";
import { relativeTime, summaryFor, deepLinkFor } from "@/features/notifications/lib/format";

// notifications-email S-006 — pure presentation helpers for the bell.

describe("notifications format helpers (S-006)", () => {
  it("relativeTime renders compact buckets", () => {
    const now = Date.parse("2026-06-20T12:00:00.000Z");
    expect(relativeTime("2026-06-20T11:59:50.000Z", now)).toBe("just now");
    expect(relativeTime("2026-06-20T11:55:00.000Z", now)).toBe("5m");
    expect(relativeTime("2026-06-20T09:00:00.000Z", now)).toBe("3h");
    expect(relativeTime("2026-06-18T12:00:00.000Z", now)).toBe("2d");
    expect(relativeTime("not-a-date", now)).toBe("");
  });

  it("summaryFor maps every known type to a non-empty line + a neutral fallback", () => {
    for (const t of ["reply", "new_feedback", "thread_activity", "suggestion_decided", "resolved", "detached", "invited"] as const) {
      expect(summaryFor(t).length).toBeGreaterThan(0);
    }
    // Unknown future type falls back, never empty.
    expect(summaryFor("future_type" as never)).toBe("New notification");
  });

  it("AS-014.T2: deepLinkFor builds /d/:slug#annotation-:refId, null without a slug", () => {
    expect(deepLinkFor({ slug: "spec-v2", refId: "anno-7" })).toBe("/d/spec-v2#annotation-anno-7");
    // No slug (e.g. an `invited` row) → no deep-link.
    expect(deepLinkFor({ slug: null, refId: "x" })).toBeNull();
    // Encodes unsafe characters.
    expect(deepLinkFor({ slug: "a b", refId: "c/d" })).toBe("/d/a%20b#annotation-c%2Fd");
  });
});
