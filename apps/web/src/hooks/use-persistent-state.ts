import { useEffect, useState } from "react";

/**
 * A `useState` whose value is mirrored to `localStorage`, so a string-union UI preference (the
 * viewer's input mode + markup tool, etc.) survives a reload instead of resetting to its default.
 *
 * No Zustand (locked rejection): React Query owns server state, `useState` owns local — this is just
 * `useState` + a localStorage read on init and a write on change, mirroring `theme-provider`'s
 * pattern (SSR/test-safe `typeof localStorage` guard + try/catch so a blocked/again-quota storage
 * degrades to in-memory state, never throws).
 *
 * `allowed` validates the persisted value: a stored value not in the set (stale key from an older
 * build, or tampering) is ignored and the `initial` default is used — so a renamed enum can never
 * resurrect a value the UI no longer understands.
 */
export function usePersistentState<T extends string>(
  key: string,
  initial: T,
  allowed: readonly T[],
): readonly [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof localStorage === "undefined") return initial;
    try {
      const saved = localStorage.getItem(key);
      if (saved != null && (allowed as readonly string[]).includes(saved)) return saved as T;
    } catch {
      // ignore — a blocked storage just means we fall back to the default this session.
    }
    return initial;
  });

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(key, value);
    } catch {
      // ignore — preference simply won't persist if storage is unavailable.
    }
  }, [key, value]);

  return [value, setValue] as const;
}
