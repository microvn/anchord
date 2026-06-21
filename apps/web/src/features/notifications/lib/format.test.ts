import { describe, it, expect } from "bun:test";
import { relativeTime, summaryFor, summaryForItem, deepLinkFor } from "@/features/notifications/lib/format";

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

  it("AS-026/AS-027: summaryForItem interpolates the actor + doc title for a comment-type row", () => {
    expect(
      summaryForItem({ type: "thread_activity", actorName: "Mara", docTitle: "Refund Spec" }),
    ).toBe("Mara commented in Refund Spec");
    expect(summaryForItem({ type: "new_feedback", actorName: "Mara", docTitle: "Refund Spec" })).toBe(
      "Mara left feedback on Refund Spec",
    );
    // AS-026: an actor but no doc title → the title collapses to "a document".
    expect(summaryForItem({ type: "reply", actorName: "Mara", docTitle: null })).toBe(
      "Mara replied in a document",
    );
  });

  it("AS-029: summaryForItem degrades to the generic per-type summary without an actor", () => {
    // A non-comment row → generic summary, no interpolation.
    expect(summaryForItem({ type: "invited", actorName: null, docTitle: null })).toBe(summaryFor("invited"));
    // A comment-type row whose comment is gone (no actor) → generic summary too (AS-029).
    expect(summaryForItem({ type: "thread_activity", actorName: null, docTitle: null })).toBe(
      summaryFor("thread_activity"),
    );
  });

  it("AS-014.T2: deepLinkFor builds /d/:slug#annotation-:refId, null without a slug", () => {
    expect(deepLinkFor({ slug: "spec-v2", refId: "anno-7" })).toBe("/d/spec-v2#annotation-anno-7");
    // No slug (e.g. an `invited` row) → no deep-link.
    expect(deepLinkFor({ slug: null, refId: "x" })).toBeNull();
    // Encodes unsafe characters.
    expect(deepLinkFor({ slug: "a b", refId: "c/d" })).toBe("/d/a%20b#annotation-c%2Fd");
  });
});
