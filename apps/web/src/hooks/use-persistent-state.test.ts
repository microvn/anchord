import { describe, expect, test, beforeEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { usePersistentState } from "./use-persistent-state";

const KEY = "test-persist-key";
const ALLOWED = ["select", "pinpoint"] as const;

beforeEach(() => {
  localStorage.clear();
});

describe("usePersistentState", () => {
  test("returns the initial value when nothing is stored", () => {
    const { result } = renderHook(() => usePersistentState(KEY, "select", ALLOWED));
    expect(result.current[0]).toBe("select");
  });

  test("reads a previously-stored value that is in the allow-list", () => {
    localStorage.setItem(KEY, "pinpoint");
    const { result } = renderHook(() => usePersistentState(KEY, "select", ALLOWED));
    expect(result.current[0]).toBe("pinpoint");
  });

  test("ignores a stored value not in the allow-list and falls back to the initial", () => {
    localStorage.setItem(KEY, "bogus-old-enum");
    const { result } = renderHook(() => usePersistentState(KEY, "select", ALLOWED));
    expect(result.current[0]).toBe("select");
  });

  test("writes the new value to localStorage on change (survives a remount)", () => {
    const first = renderHook(() => usePersistentState(KEY, "select", ALLOWED));
    act(() => first.result.current[1]("pinpoint"));
    expect(localStorage.getItem(KEY)).toBe("pinpoint");
    // a fresh mount (the F5 case) reads the persisted value, not the default
    const second = renderHook(() => usePersistentState(KEY, "select", ALLOWED));
    expect(second.result.current[0]).toBe("pinpoint");
  });
});
