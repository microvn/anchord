// doc-access-routing S-004 / C-008 — unit tests for the anon comment rate limiter.
import { describe, expect, test } from "bun:test";
import { CommentRateLimiterImpl } from "./comment-rate-limit";

describe("CommentRateLimiterImpl (C-008)", () => {
  test("AS-022: allows up to `max` writes per key, then refuses the excess", () => {
    const lim = new CommentRateLimiterImpl(3, 60);
    const key = "1.2.3.4:doc_1";
    const now = new Date("2026-06-15T00:00:00.000Z");
    expect(lim.consume(key, now).allowed).toBe(true); // 1
    expect(lim.consume(key, now).allowed).toBe(true); // 2
    expect(lim.consume(key, now).allowed).toBe(true); // 3
    expect(lim.consume(key, now).allowed).toBe(false); // 4 → over the limit
    expect(lim.consume(key, now).allowed).toBe(false); // stays refused
  });

  test("AS-022: the limit is independent per key (IP + doc)", () => {
    const lim = new CommentRateLimiterImpl(1, 60);
    const now = new Date("2026-06-15T00:00:00.000Z");
    expect(lim.consume("ipA:doc_1", now).allowed).toBe(true);
    expect(lim.consume("ipA:doc_1", now).allowed).toBe(false); // same key exhausted
    expect(lim.consume("ipB:doc_1", now).allowed).toBe(true); // different IP → fresh budget
    expect(lim.consume("ipA:doc_2", now).allowed).toBe(true); // different doc → fresh budget
  });

  test("AS-022: the window resets after windowSeconds (boundary)", () => {
    const lim = new CommentRateLimiterImpl(1, 60);
    const key = "1.2.3.4:doc_1";
    const t0 = new Date("2026-06-15T00:00:00.000Z");
    expect(lim.consume(key, t0).allowed).toBe(true);
    expect(lim.consume(key, t0).allowed).toBe(false);
    const t1 = new Date(t0.getTime() + 60_000); // exactly one window later
    expect(lim.consume(key, t1).allowed).toBe(true); // budget refreshed
  });
});
