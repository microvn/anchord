import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, useTheme } from "@/app/theme-provider";
import { AppearanceSection } from "@/features/settings/components/appearance-section";

// account-settings S-003 — the Appearance section: a theme picker (Light / Dark) that reflects
// the active theme, applies a pick immediately, keeps the header toggle in sync, and persists
// per-device.
//
// No module is mocked here — the real ThemeProvider is the shared source of truth, exactly as
// the contract requires (the header toggle and the picker must read the same provider state).
// The header toggle is the same provider consumer the app header uses: a button reading
// useTheme() and showing the sun glyph in dark / moon in light. We render a faithful stand-in
// (the real ThemeToggle is not exported from app-header, which also drags in routing/session),
// so "header reflects light" is asserted against the same provider, the real contract.
//
// State to reset between/after tests: the localStorage key the provider persists to, and the
// data-theme attribute it stamps on the document root — both are process-global under the
// shared happy-dom, so leaving them dirty would leak into sibling settings test files.

const STORAGE_KEY = "anchord-theme";

// A faithful header-toggle stand-in: same provider, same dark→sun / light→moon glyph contract
// as app-header's ThemeToggle. It exposes the active theme so the test can assert header sync.
function HeaderThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button type="button" aria-label="Toggle theme" data-testid="header-theme-toggle" onClick={toggleTheme}>
      {theme === "dark" ? "sun" : "moon"}
    </button>
  );
}

function renderAppearance() {
  return render(
    <ThemeProvider>
      <HeaderThemeToggle />
      <AppearanceSection />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterAll(() => {
  // Reset shared global state so it doesn't leak into other settings test files.
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("account-settings S-003 — Appearance section", () => {
  it("AS-009: with the app in dark, opening Appearance shows dark as the selected theme", async () => {
    // No saved preference → the provider resolves to the canonical dark default.
    renderAppearance();

    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
    // Dark is selected; light is not.
    expect(screen.getByTestId("theme-opt-dark")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("theme-opt-light")).toHaveAttribute("aria-checked", "false");
  });

  it("AS-010: selecting light re-themes immediately, the header toggle reflects light, and the choice persists", async () => {
    const user = userEvent.setup();
    renderAppearance();

    // Starts dark (header shows the sun glyph for dark).
    expect(screen.getByTestId("header-theme-toggle")).toHaveTextContent("sun");

    await user.click(screen.getByTestId("theme-opt-light"));

    // Applies immediately: the root re-themes to light and the picker reflects light.
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
    expect(screen.getByTestId("theme-opt-light")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("theme-opt-dark")).toHaveAttribute("aria-checked", "false");
    // The header toggle (same provider) now reflects light → shows the moon glyph.
    expect(screen.getByTestId("header-theme-toggle")).toHaveTextContent("moon");
    // Survives a reload on this device: persisted under the provider's localStorage key.
    await waitFor(() => expect(localStorage.getItem(STORAGE_KEY)).toBe("light"));
  });

  it("C-005: the picker and the header toggle always reflect the same active theme (provider is shared)", async () => {
    const user = userEvent.setup();
    renderAppearance();

    // Flip from the HEADER toggle → the picker must follow (one shared provider, not two states).
    await user.click(screen.getByTestId("header-theme-toggle"));
    await waitFor(() => expect(screen.getByTestId("theme-opt-light")).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByTestId("header-theme-toggle")).toHaveTextContent("moon");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    // Flip back from the PICKER → the header must follow.
    await user.click(screen.getByTestId("theme-opt-dark"));
    await waitFor(() => expect(screen.getByTestId("header-theme-toggle")).toHaveTextContent("sun"));
    expect(screen.getByTestId("theme-opt-dark")).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("C-005: dark is the canonical default when no preference is saved (and a saved light is honored)", async () => {
    // Fresh device, no saved theme → dark.
    renderAppearance();
    await waitFor(() => expect(screen.getByTestId("theme-opt-dark")).toHaveAttribute("aria-checked", "true"));
    expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
  });
});
