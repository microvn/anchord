import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, within, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// web-core S-005 added the header AppHeader, which reads the /api/me bootstrap through the shared
// client — so the shell now needs a QueryClient + the workspaces client mocked even for the bare
// chrome tests. Mock the client so the bootstrap read resolves to an empty workspace set (the
// S-003 chrome assertions don't depend on its data).
const env = (body: unknown) => ({ data: { success: true, data: body }, error: null });
mock.module("../src/features/workspaces/client", () => ({
  fetchBootstrap: mock(async () => env({ userId: "me", workspaces: [], activeWorkspaceId: null })),
  setActiveWorkspace: mock(async () => env({})),
  fetchMembers: mock(async () => env({ members: [], invitations: [] })),
  createWorkspace: mock(async () => env({})),
  renameWorkspace: mock(async () => env({})),
  inviteMember: mock(async () => env({})),
  removeMember: mock(async () => env({})),
  changeMemberRole: mock(async () => env({})),
  acceptInvitation: mock(async () => env({})),
  rejectInvitation: mock(async () => env({})),
}));

// Mock the auth client so AppShell's UserMenu (which imports signOut) renders without a backend.
mock.module("../src/lib/auth-client", () => ({
  signIn: { email: mock(async () => ({ data: null, error: null })), social: mock(async () => ({})) },
  signUp: { email: mock(async () => ({ data: { user: {} }, error: null })) },
  signOut: mock(async () => ({ data: { success: true }, error: null })),
  sendVerificationEmail: mock(async () => ({ data: {}, error: null })),
  verifyEmail: mock(async () => ({ data: {}, error: null })),
  getSession: mock(async () => ({ data: { user: { email: "a@b.co" } }, error: null })),
  useSession: () => ({ data: { user: { email: "a@b.co" } }, isPending: false }),
  authClient: {},
}));

const { AppShell } = await import("../src/app/app-shell");
const { applyTheme, resolveTheme, readSavedTheme, DEFAULT_THEME } = await import(
  "../src/app/theme-provider"
);

function setWidth(width: number) {
  act(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: width,
    });
    window.dispatchEvent(new Event("resize"));
  });
}

function renderShell() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <AppShell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const ORIGINAL_WIDTH = window.innerWidth;
afterEach(() => setWidth(ORIGINAL_WIDTH));

describe("web-core S-003 — responsive shell (AS-010)", () => {
  it("AS-010: at desktop width (1440) the side region is persistent and there is no drawer toggle", () => {
    setWidth(1440);
    renderShell();
    expect(screen.getByTestId("side-region")).toBeInTheDocument();
    expect(screen.queryByTestId("drawer-toggle")).not.toBeInTheDocument();
  });

  it("AS-010: at tablet width (768) the persistent side region collapses to a drawer toggle", () => {
    setWidth(768);
    renderShell();
    expect(screen.getByTestId("drawer-toggle")).toBeInTheDocument();
    expect(screen.queryByTestId("side-region")).not.toBeInTheDocument();
  });

  it("AS-010: at mobile width (360) the chrome is compact — drawer toggle shown, side region hidden", () => {
    setWidth(360);
    renderShell();
    expect(screen.getByTestId("drawer-toggle")).toBeInTheDocument();
    expect(screen.queryByTestId("side-region")).not.toBeInTheDocument();
  });

  it("AS-010: the drawer toggle opens the off-canvas side drawer at mobile", async () => {
    const user = userEvent.setup();
    setWidth(360);
    renderShell();
    expect(screen.queryByTestId("side-drawer")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("drawer-toggle"));
    expect(screen.getByTestId("side-drawer")).toBeInTheDocument();
  });

  it("AS-010: at mobile the interactive chrome controls meet the ≥40px tap-target rule", () => {
    setWidth(360);
    renderShell();
    const toggle = screen.getByTestId("drawer-toggle");
    // The ≥40px rule is encoded as the min-h-[40px]/min-w-[40px] tap-target classes.
    expect(toggle.className).toContain("min-h-[40px]");
    expect(toggle.className).toContain("min-w-[40px]");
  });
});

describe("web-core S-003 — chrome uses the design system (AS-009)", () => {
  it("AS-009: the top bar is built from semantic design tokens (teal accent), not raw hex", () => {
    setWidth(1440);
    renderShell();
    const banner = screen.getByRole("banner");
    // Chrome surfaces/lines come from the @theme token classes (bg-surface, border-line).
    expect(banner.className).toContain("bg-surface");
    expect(banner.className).toContain("border-line");
    // web-core S-005 moved the brand wordmark into the SIDEBAR (S-004) and made the header-left
    // the breadcrumb (DESIGN.md §App shell). So the banner now hosts the AppHeader (breadcrumb +
    // account cluster), not the wordmark — assert the header mounted here. The Fraunces serif
    // wiring is covered by the @theme/CSS assertion below.
    expect(within(banner).getByTestId("header-breadcrumb")).toBeInTheDocument();
  });

  it("AS-009 / C-003: the @theme token set and chrome contain NO banned colors (no Claude-orange, no purple/violet)", () => {
    // Strip comments first — DESIGN.md and the source files legitimately *name* the banned
    // colors in prose ("never #d97757"). The guard must catch banned colors USED as values,
    // not mentioned in documentation, so we scan code with comments removed.
    const stripComments = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, "") // block comments (CSS + JS)
        .replace(/\/\/[^\n]*/g, ""); // line comments (JS/TS)

    const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");
    const srcDir = join(import.meta.dir, "../src");
    const sources: string[] = [css];
    const walk = (dir: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(ent.name)) sources.push(readFileSync(p, "utf8"));
      }
    };
    walk(srcDir);
    const all = sources.map(stripComments).join("\n").toLowerCase();

    // Claude-orange is explicitly banned (DESIGN.md §Anti-slop).
    expect(all).not.toContain("#d97757");
    // No purple/violet accent anywhere in the token set or chrome.
    expect(all).not.toMatch(/purple|violet|#(8b5cf6|a855f7|7c3aed|6d28d9|9333ea)/);
  });

  it("AS-009: Geist (body/UI) and Fraunces (headings) are the configured fonts", () => {
    const css = readFileSync(join(import.meta.dir, "../src/styles.css"), "utf8");
    expect(css).toContain("Geist");
    expect(css).toContain("Fraunces");
    // Teal is the single accent token.
    expect(css).toContain("--color-accent: #37b3bd");
  });
});

describe("web-core S-003 — theme defaults to dark (AS-011)", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("AS-011: with no saved preference the theme resolves to dark (canonical)", () => {
    expect(readSavedTheme()).toBeNull();
    expect(resolveTheme(readSavedTheme())).toBe("dark");
    expect(DEFAULT_THEME).toBe("dark");
  });

  it("AS-011: applying the resolved theme on a fresh visit stamps the dark marker on the root", () => {
    applyTheme(resolveTheme(readSavedTheme()));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("AS-011: a saved light preference is honored, proving dark is the DEFAULT, not the only option", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    // An invalid/garbage saved value still falls back to the canonical dark default.
    expect(resolveTheme("neon")).toBe("dark");
  });
});
