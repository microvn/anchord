import { useEffect } from "react";

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

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    applyTheme(resolveTheme(readSavedTheme()));
  }, []);

  return <>{children}</>;
}
