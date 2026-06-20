import { describe, it, expect, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useGuestIdentity, GUEST_NAME_STORAGE_KEY } from "./use-guest-identity";

// annotation-core S-007 / AS-016 — the session-stable guest identity. One random name is assigned for
// the WHOLE viewing session: persisted in sessionStorage so it is the SAME across reloads / remounts /
// every composer (NOT re-rolled per comment box), and Rename advances + persists the session name.
// sessionStorage is cleared by the global afterEach (test/setup.ts), so each test starts fresh.

beforeEach(() => {
  sessionStorage.clear();
});

describe("useGuestIdentity (S-007)", () => {
  it("AS-016: a fresh session assigns a random adjective-animal-suffix name AND persists it", () => {
    expect(sessionStorage.getItem(GUEST_NAME_STORAGE_KEY)).toBeNull();
    const { result } = renderHook(() => useGuestIdentity());
    expect(result.current.name).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/);
    // Persisted to sessionStorage so a reload re-reads the same name.
    expect(sessionStorage.getItem(GUEST_NAME_STORAGE_KEY)).toBe(result.current.name);
  });

  it("AS-016: the SAME name is returned across separate mounts (stable across reload / per-composer)", () => {
    const first = renderHook(() => useGuestIdentity());
    const assigned = first.result.current.name;
    first.unmount();

    // A new mount in the SAME session (sessionStorage intact) re-reads the same name — not re-rolled.
    const second = renderHook(() => useGuestIdentity());
    expect(second.result.current.name).toBe(assigned);
  });

  it("AS-016: rename() changes the name AND persists the new value", () => {
    const { result } = renderHook(() => useGuestIdentity());
    const before = result.current.name;
    act(() => result.current.rename());
    const after = result.current.name;
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{4}$/);
    // Persisted: a remount reads the renamed value, not a re-roll.
    expect(sessionStorage.getItem(GUEST_NAME_STORAGE_KEY)).toBe(after);
  });

  it("AS-016: a renamed name survives a remount (in-tab navigation keeps the chosen name)", () => {
    const first = renderHook(() => useGuestIdentity());
    act(() => first.result.current.rename());
    const renamed = first.result.current.name;
    first.unmount();

    const second = renderHook(() => useGuestIdentity());
    expect(second.result.current.name).toBe(renamed);
  });

  it("AS-019: a tampered/empty stored value is sanitized — markup is stripped, name stays inert", () => {
    // A stored value carrying markup (e.g. tampered sessionStorage) must not surface raw.
    sessionStorage.setItem(GUEST_NAME_STORAGE_KEY, "<img src=x onerror=alert(1)>");
    const { result } = renderHook(() => useGuestIdentity());
    expect(result.current.name).not.toMatch(/[<>]/);
    expect(result.current.name.length).toBeGreaterThan(0);
  });
});
