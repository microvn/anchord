// mcp-roundtrip S-001 / C-007 — per-token MCP rate limiting + the per-user active-token cap.
//
// Two distinct controls:
//  1. Per-token request rate: a token may issue at most `max` JSON-RPC requests per
//     `windowSeconds` (default 60/min). Exceeding it throttles the call (AS-024).
//  2. Per-user active-token cap: a user holds at most `cap` active tokens (default 10), so
//     the per-token rate can't be bypassed by minting many tokens (AS-025).
//
// The rate limiter is in-process/in-memory — acceptable for a single-box self-host (C-007,
// documented); a durable backend (Redis) swaps in behind this port in v0.5. Same fixed-window
// shape as annotation/comment-rate-limit.ts.

/** Default: 60 MCP requests per token per 60s window (C-007, tunable). */
export const MCP_RATE_LIMIT_MAX = 60;
export const MCP_RATE_LIMIT_WINDOW_SECONDS = 60;

/** Default: 10 active tokens per user (C-007, tunable). */
export const MCP_ACTIVE_TOKEN_CAP = 10;

interface WindowEntry {
  count: number;
  windowStart: number;
}

/**
 * In-memory fixed-window counter keyed per token id. `consume(tokenId, now)` records one
 * request and returns whether it is ALLOWED (within the window budget). The first request
 * that would exceed `max` is refused (AS-024); the window resets after `windowSeconds`.
 */
export class McpRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(
    private readonly max = MCP_RATE_LIMIT_MAX,
    private readonly windowSeconds = MCP_RATE_LIMIT_WINDOW_SECONDS,
  ) {}

  consume(tokenId: string, now: Date = new Date()): { allowed: boolean } {
    const entry = this.entries.get(tokenId);
    if (!entry || this.windowExpired(entry, now)) {
      this.entries.set(tokenId, { count: 1, windowStart: now.getTime() });
      return { allowed: this.max >= 1 };
    }
    if (entry.count >= this.max) {
      return { allowed: false }; // over the limit — do not grow the counter unbounded
    }
    entry.count += 1;
    return { allowed: true };
  }

  private windowExpired(entry: WindowEntry, now: Date): boolean {
    return now.getTime() - entry.windowStart >= this.windowSeconds * 1000;
  }
}
