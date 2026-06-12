// Snowflake ID generator — the project's single source of new primary-key ids.
//
// Why snowflake over uuid: a 64-bit, time-ordered id. It sorts by creation time (so a
// plain `ORDER BY id` is chronological, and B-tree inserts stay append-friendly), it is
// far more compact than a uuid, and it carries no Postgres dependency (uuid relied on
// gen_random_uuid()) — which keeps the schema portable to a future SQLite build.
//
// Representation: we return a DECIMAL STRING, never a JS number. A 63-bit id exceeds
// Number.MAX_SAFE_INTEGER (2^53), so a number would silently lose precision the moment it
// crosses the wire as JSON. Every id column is `text`; every API id is a string. This is
// also why we DON'T store it as Postgres bigint — text avoids the bigint⇄string coercion
// footguns at the driver/JSON boundary entirely.
//
// Layout (63 usable bits, high→low): 41-bit ms since EPOCH · 10-bit worker · 12-bit seq.
//   - 41 bits of ms ≈ 69 years from EPOCH.
//   - 10-bit worker (0..1023) — set SNOWFLAKE_WORKER_ID per process when running >1 node.
//   - 12-bit sequence — up to 4096 ids per worker per millisecond; we busy-wait past a
//     full millisecond rather than ever emit a duplicate.

// Custom epoch: 2024-01-01T00:00:00Z. Keeps the timestamp field small (ids stay shorter)
// and buys ~69 years of headroom from a recent anchor.
const EPOCH = 1_704_067_200_000n;

const WORKER_ID = BigInt(Number(process.env.SNOWFLAKE_WORKER_ID ?? 0) & 0x3ff);
const SEQUENCE_BITS = 12n;
const WORKER_BITS = 10n;
const MAX_SEQUENCE = (1n << SEQUENCE_BITS) - 1n; // 4095

let lastMs = -1n;
let sequence = 0n;

function nowMs(): bigint {
  return BigInt(Date.now());
}

/**
 * Generate a new snowflake id as a decimal string. Monotonic within a process: if the
 * sequence for the current millisecond is exhausted, it spins to the next millisecond
 * instead of risking a collision.
 */
export function newId(): string {
  let ms = nowMs();

  // Clock moved backwards (NTP adjustment) — don't emit ids that could collide with ones
  // already issued; wait until the clock catches back up to the last observed instant.
  if (ms < lastMs) {
    while (ms < lastMs) ms = nowMs();
  }

  if (ms === lastMs) {
    sequence = (sequence + 1n) & MAX_SEQUENCE;
    if (sequence === 0n) {
      // Sequence exhausted this ms — advance to the next millisecond.
      while ((ms = nowMs()) <= lastMs) {
        /* spin */
      }
    }
  } else {
    sequence = 0n;
  }

  lastMs = ms;

  const id =
    ((ms - EPOCH) << (WORKER_BITS + SEQUENCE_BITS)) | (WORKER_ID << SEQUENCE_BITS) | sequence;
  return id.toString();
}
