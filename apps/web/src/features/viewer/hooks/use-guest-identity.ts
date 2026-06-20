import { useCallback, useState } from "react";
import {
  GUEST_NAME_MAX,
  nextGuestName,
  randomGuestName,
  sanitizeGuestName,
} from "@/features/viewer/components/composer";

// useGuestIdentity (annotation-core S-007 / AS-016, C-007): owns the SESSION-stable guest display
// name for a logged-out commenter. One random name (e.g. "swift-otter-k7m2") is assigned for the
// WHOLE viewing session and persisted in `sessionStorage`, so it:
//   - survives a reload (F5) and in-tab navigation (sessionStorage keeps the value while the tab lives),
//   - is the SAME across every composer in that session (NOT re-rolled per comment box),
//   - is NOT shared with a separate tab/session (sessionStorage is per-tab), and is discarded when the
//     tab closes.
// Rename advances to the NEXT name in the pool (mirrors the old composer Rename = cycle-the-pool) and
// persists it everywhere it appears (the header chip + the name that rides up on each guest comment).
//
// The returned name is already inert-safe: the random pool is clean and `nextGuestName` only ever
// yields a pool member, so AS-019's sanitize is never weakened. We still pass the read-back value
// through `sanitizeGuestName` defensively (a tampered sessionStorage value can't smuggle markup).

/** The sessionStorage key the guest name is persisted under (session-scope, per-tab). */
export const GUEST_NAME_STORAGE_KEY = "anchord.guest-name";

/** Guarded sessionStorage read — returns null when storage is unavailable (SSR / disabled / throws). */
function readStored(): string | null {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage.getItem(GUEST_NAME_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Guarded sessionStorage write — silently no-ops when storage is unavailable. */
function writeStored(value: string): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    sessionStorage.setItem(GUEST_NAME_STORAGE_KEY, value);
  } catch {
    // storage full / disabled — the in-memory state still holds the name for this render tree.
  }
}

export interface GuestIdentity {
  /** the session-stable display name (sanitized-safe; non-empty). */
  name: string;
  /** advance to the NEXT pool name + persist it everywhere it appears (AS-016 Rename). */
  rename: () => void;
}

export function useGuestIdentity(): GuestIdentity {
  // On first read: reuse the stored session name when present (stable across reload / in-tab nav /
  // remount), else pick a fresh random one and persist it so this session keeps it. The initializer
  // runs once per hook mount; sessionStorage makes it stable across mounts within the tab.
  const [name, setName] = useState<string>(() => {
    const stored = readStored();
    if (stored) {
      // Defensive: a tampered stored value is sanitized + clamped; an empty result re-rolls.
      const safe = sanitizeGuestName(stored).slice(0, GUEST_NAME_MAX);
      if (safe.length > 0) return safe;
    }
    const fresh = randomGuestName();
    writeStored(fresh);
    return fresh;
  });

  const rename = useCallback(() => {
    setName((current) => {
      const next = sanitizeGuestName(nextGuestName(current)).slice(0, GUEST_NAME_MAX);
      const resolved = next.length > 0 ? next : randomGuestName();
      writeStored(resolved);
      return resolved;
    });
  }, []);

  return { name, rename };
}
