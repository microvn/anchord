// doc-access-routing S-004 / C-008 — the anonymous comment-write rate limiter.
//
// A fixed-window, in-memory counter keyed per (IP, doc): an anonymous guest can post at
// most `max` comments within `windowSeconds` on a given doc. Past that the limiter refuses,
// and the route 429s the excess AND skips the reply-notification dispatch (no per-comment
// mail flood — the SAME limiter gates both). In-memory is fine for v0 single-instance
// self-host (the same shape `LinkPasswordRateLimiter` uses); a shared/Redis backend can
// swap in later behind the CommentRateLimiter port. The key carries IP + doc so a flood on
// one doc from one source is throttled without blocking other docs/sources.

/** Default: 10 anonymous comments per IP per doc per 60s window. */
export const ANON_COMMENT_RATE_LIMIT_MAX = 10;
export const ANON_COMMENT_RATE_LIMIT_WINDOW_SECONDS = 60;

interface WindowEntry {
  count: number;
  windowStart: number;
}

/**
 * In-memory fixed-window counter. `consume(key, now)` records one write and returns whether
 * it is ALLOWED (i.e. within the window's budget). The first write that would exceed `max`
 * is refused; the window resets after `windowSeconds`.
 */
export class CommentRateLimiterImpl {
  private readonly entries = new Map<string, WindowEntry>();

  constructor(
    private readonly max = ANON_COMMENT_RATE_LIMIT_MAX,
    private readonly windowSeconds = ANON_COMMENT_RATE_LIMIT_WINDOW_SECONDS,
  ) {}

  /** Consume one slot for `key`. Returns `{ allowed }` — false once the window budget is
   *  exhausted. Refused writes do NOT increment further (the count caps at `max`). */
  consume(key: string, now: Date = new Date()): { allowed: boolean } {
    const entry = this.entries.get(key);
    if (!entry || this.windowExpired(entry, now)) {
      this.entries.set(key, { count: 1, windowStart: now.getTime() });
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

/** Build the injectable CommentRateLimiter port from a limiter impl (the shape the
 *  annotation routes consume). Async to match the port even though the impl is sync. */
export function createCommentRateLimiter(
  impl: CommentRateLimiterImpl = new CommentRateLimiterImpl(),
): (key: string) => Promise<{ allowed: boolean }> {
  return async (key: string) => impl.consume(key);
}
