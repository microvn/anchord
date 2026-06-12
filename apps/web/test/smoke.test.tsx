import { afterEach, describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppRoutes } from "@/app";
import { createQueryClient } from "@/app/query-client";
import { ThemeProvider, applyTheme } from "@/app/theme-provider";

// Smoke: the foundation boots — the route table resolves the public /signin route to the
// real sign-in screen (Phase 1 replaced the placeholder), and the theme provider stamps the
// dark canonical marker on the root.

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("foundation boots", () => {
  it("renders the real sign-in screen at /signin", () => {
    const queryClient = createQueryClient();
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/signin"]}>
            <AppRoutes />
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    // The real screen renders the email + password form (not a placeholder label).
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("stamps data-theme=dark by default", () => {
    render(
      <ThemeProvider>
        <span>themed</span>
      </ThemeProvider>,
    );
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("applyTheme switches the root marker", () => {
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
