import { createContext, useContext, useEffect, useState } from "react";

// S-003 / AS-011: dark is the canonical theme. "Dark is the default" is made an explicit,
// assertable fact here — not an accident of CSS. On first load with no saved preference we
// resolve to dark and stamp the root with `data-theme="dark"` (and `color-scheme`), so a
// test can assert the dark marker is present on a fresh visit. Light is first-class later
// (DESIGN.md), but this slice ships dark canonical.
//
// `Theme` is the RESOLVED, applied theme — always concrete light/dark, the value that hits the
// DOM. `ThemePreference` is what the user PICKS: light, dark, or `system` (follow the OS). The
// viewer overflow menu's Appearance control (viewer-overflow-menu S-002) sets the preference; the
// provider derives the resolved theme (system → the OS `prefers-color-scheme`) and re-derives it
// when the OS flips. Anywhere that only cares about the applied colour keeps reading `theme`.
export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";
const STORAGE_KEY = "anchord-theme";
export const DEFAULT_THEME: Theme = "dark";
// The default PREFERENCE on a fresh device — dark canonical, NOT `system` (so a first visit always
// lands on the operator-dark theme regardless of the OS, preserving AS-011 / AS-008).
export const DEFAULT_PREFERENCE: ThemePreference = "dark";

// Normalize a saved string into a valid preference. Saved `system`/`light`/`dark` win; anything
// else (absent / legacy / corrupt) → the dark canonical default.
export function resolvePreference(saved: string | null | undefined): ThemePreference {
  return saved === "light" || saved === "dark" || saved === "system" ? saved : DEFAULT_PREFERENCE;
}

// Does the OS currently prefer dark? DOM-guarded (SSR / a test env with no matchMedia → false).
export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

// Pure resolver — the single source of "what theme applies". A saved light/dark preference wins;
// `system` follows the OS (`prefersDark`); absent/invalid → the dark canonical default. Deterministic
// and DOM-free (the OS signal is passed in). The `prefersDark` arg defaults to false so existing
// single-arg callers (and the light/dark/invalid cases, which ignore it) are unchanged.
export function resolveTheme(saved: string | null | undefined, prefersDark = false): Theme {
  const pref = resolvePreference(saved);
  if (pref === "system") return prefersDark ? "dark" : "light";
  return pref;
}

export function readSavedTheme(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
}

function writeSavedPreference(pref: ThemePreference) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // ignore — a blocked storage just means the preference doesn't persist this session.
  }
}

// The header theme toggle reads the current theme and flips it dark↔light. The provider owns the
// live preference STATE (so controls re-render) and stamps the root via applyTheme — the same
// mechanism S-003 uses on load, so dark stays canonical.
interface ThemeContextValue {
  /** the RESOLVED, applied theme — always concrete light/dark (system already collapsed to the OS value). */
  theme: Theme;
  /** the user's PICK — light/dark/system. `system` is what the Appearance "System" option stores. */
  preference: ThemePreference;
  toggleTheme: () => void;
  // The Appearance picker selects a SPECIFIC preference (light/dark, or `system` from the viewer
  // overflow menu), not just a flip. It shares the same provider state as the header toggle, so both
  // always reflect the same active theme.
  setTheme: (preference: ThemePreference) => void;
}
const ThemeContext = createContext<ThemeContextValue | null>(null);

// Reads the live theme + the controls. Safe outside a provider (returns the canonical default
// and no-ops) so a bare component render in a test doesn't crash.
export function useTheme(): ThemeContextValue {
  return (
    useContext(ThemeContext) ?? {
      theme: DEFAULT_THEME,
      preference: DEFAULT_PREFERENCE,
      toggleTheme: () => {},
      setTheme: () => {},
    }
  );
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    resolvePreference(readSavedTheme()),
  );
  // Track the OS signal as state so a `system` preference re-resolves when the OS flips while the
  // app is open (the matchMedia listener below drives it).
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());

  const theme: Theme = preference === "system" ? (prefersDark ? "dark" : "light") : preference;

  // Apply on mount + whenever the resolved theme changes (covers the S-003 load-default, the toggle,
  // a system-preference OS flip, and an explicit pick). Persist the PREFERENCE, not the resolved
  // value — so `system` survives a reload as `system` (and keeps following the OS).
  useEffect(() => {
    applyTheme(theme);
    writeSavedPreference(preference);
  }, [theme, preference]);

  // Only listen to the OS while the preference is `system` — a fixed light/dark pick must never be
  // overridden by an OS change. Re-subscribes when the preference flips into/out of `system`.
  useEffect(() => {
    if (preference !== "system") return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
    setPrefersDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preference]);

  const toggleTheme = () => setPreferenceState(theme === "dark" ? "light" : "dark");
  const setTheme = (next: ThemePreference) => setPreferenceState(next);

  return (
    <ThemeContext.Provider value={{ theme, preference, toggleTheme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
