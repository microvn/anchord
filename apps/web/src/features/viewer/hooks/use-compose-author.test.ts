import { describe, it, expect } from "bun:test";
import { optimisticAuthor } from "@/features/viewer/hooks/use-compose";

// Regression: a freshly created comment showed "You" (and read as a non-owner) until a genuine
// refetch landed the real row. The optimistic temp AND the no-refetch reconciled real row both used
// a hard-coded `{ authorName: "You" }` placeholder and set no `authorId`. A signed-in member must
// see their REAL name + avatar immediately and be recognised as the owner. use-compose.ts.

describe("optimisticAuthor — optimistic/reconciled create attribution", () => {
  it("a signed-in member uses the REAL session name + sets authorId (never the 'You' placeholder)", () => {
    const r = optimisticAuthor({ id: "u-demo", name: "Demo User" }, undefined);
    expect(r.comment.authorName).toBe("Demo User");
    expect(r.comment.guestName).toBeUndefined();
    expect(r.authorId).toBe("u-demo"); // isOwn matches immediately — no refetch needed
  });

  it("a guest uses its self-entered name and NO authorId (a guest matches no signed-in user)", () => {
    const r = optimisticAuthor(null, { guestName: "Visitor Vee" });
    expect(r.comment.guestName).toBe("Visitor Vee");
    expect(r.comment.authorName).toBeUndefined();
    expect(r.authorId).toBeUndefined();
  });

  it("carries NO name (no 'You' fallback) when there is no resolved session name and no guest identity", () => {
    const r = optimisticAuthor(null, undefined);
    expect(r.comment.authorName).toBeUndefined();
    expect(r.comment.guestName).toBeUndefined();
    expect(r.authorId).toBeUndefined();
  });
});
