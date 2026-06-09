import { createContext, useContext, useEffect, useState } from "react";

// S-003 / AS-011: dark is the canonical theme. "Dark is the default" is made an explicit,
// assertable fact here — not an accident of CSS. On first load with no saved preference we
// resolve to dark and stamp the root with `data-theme="dark"` (and `color-scheme`), so a
// test can assert the dark marker is present on a fresh visit. Light is first-class later
// (DESIGN.md), but this slice ships dark canonical.
export type Theme = "dark" | "light";
const STORAGE_KEY = "anchord-theme";
export const DEFAULT_THEME: Theme = "dark";

// Pure resolver — the single source of "what theme applies". Saved preference wins;
// absent/invalid preference → the dark canonical default. Deterministic, DOM-free.
export function resolveTheme(saved: string | null | undefined): Theme {
  return saved === "light" ? "light" : DEFAULT_THEME;
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

function writeSavedTheme(theme: Theme) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // ignore — a blocked storage just means the preference doesn't persist this session.
  }
}

// S-005 (AS-018): the header theme toggle reads the current theme and flips it dark↔light.
// The provider owns the live theme STATE (so the toggle re-renders its glyph) and stamps the
// root via applyTheme — the same mechanism S-003 uses on load, so dark stays canonical.
interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
}
const ThemeContext = createContext<ThemeContextValue | null>(null);

// Reads the live theme + the toggle. Safe outside a provider (returns the canonical default
// and a no-op) so a bare component render in a test doesn't crash.
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext) ?? { theme: DEFAULT_THEME, toggleTheme: () => {} };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => resolveTheme(readSavedTheme()));

  // Apply on mount + whenever the theme changes (covers the S-003 load-default AND the toggle).
  useEffect(() => {
    applyTheme(theme);
    writeSavedTheme(theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}
