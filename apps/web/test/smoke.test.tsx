import { afterEach, describe, expect, it } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppRoutes } from "../src/app";
import { createQueryClient } from "../src/app/query-client";
import { ThemeProvider, applyTheme } from "../src/app/theme-provider";

// Phase 0 smoke: the foundation boots — the route table resolves the public /signin
// placeholder, and the theme provider stamps the dark canonical marker on the root.

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
});

describe("foundation boots", () => {
  it("renders the sign-in placeholder at /signin", () => {
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
    expect(screen.getByTestId("route-label")).toHaveTextContent("signin");
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
