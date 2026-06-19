// mcp-roundtrip S-001 — per-token rate limiter unit (C-007/AS-024).

import { describe, expect, test } from "bun:test";
import { McpRateLimiter, MCP_RATE_LIMIT_MAX, MCP_ACTIVE_TOKEN_CAP } from "./rate-limit";

describe("McpRateLimiter (C-007/AS-024)", () => {
  test("AS-024: a token over its per-token budget is throttled within the window", () => {
    const limiter = new McpRateLimiter(3, 60); // 3 requests / 60s
    const now = new Date("2026-06-19T12:00:00Z");
    const tok = "tok_1";
    expect(limiter.consume(tok, now).allowed).toBe(true); // 1
    expect(limiter.consume(tok, now).allowed).toBe(true); // 2
    expect(limiter.consume(tok, now).allowed).toBe(true); // 3
    expect(limiter.consume(tok, now).allowed).toBe(false); // 4 → over → throttled
    expect(limiter.consume(tok, now).allowed).toBe(false); // stays throttled
  });

  test("AS-024: the window resets after windowSeconds — a new window allows again", () => {
    const limiter = new McpRateLimiter(1, 60);
    const t0 = new Date("2026-06-19T12:00:00Z");
    expect(limiter.consume("tok", t0).allowed).toBe(true);
    expect(limiter.consume("tok", t0).allowed).toBe(false);
    const t1 = new Date(t0.getTime() + 60_000); // window elapsed
    expect(limiter.consume("tok", t1).allowed).toBe(true);
  });

  test("AS-024: limits are per-token — one token's burst doesn't throttle another", () => {
    const limiter = new McpRateLimiter(1, 60);
    const now = new Date("2026-06-19T12:00:00Z");
    expect(limiter.consume("tok_a", now).allowed).toBe(true);
    expect(limiter.consume("tok_a", now).allowed).toBe(false);
    expect(limiter.consume("tok_b", now).allowed).toBe(true); // independent budget
  });

  test("C-007: documented defaults are 60/min/token and a 10-token-per-user cap", () => {
    expect(MCP_RATE_LIMIT_MAX).toBe(60);
    expect(MCP_ACTIVE_TOKEN_CAP).toBe(10);
  });
});
