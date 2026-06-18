import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// account-settings S-001 — the Settings shell + section registry + nav + section routing.
//
// The session is MOCKED via @/lib/api/auth-client (the same seam AuthGuard + UserMenu read,
// mirroring the repo's existing auth-mock pattern). A signed-in session resolves immediately
// (isPending:false) so the AuthGuard renders its outlet; setting it null exercises the redirect.

let session: { user: { name: string; email: string } } | null = {
  user: { name: "Hoang Nguyen", email: "hoang@mobilefolk.com" },
};

// Full surface — bun's mock.module is process-wide, so an incomplete mock would erase exports
// other modules import. Mirror every export of the real auth-client.
mock.module("@/lib/api/auth-client", () => ({
  authClient: {},
  signIn: { email: mock(async () => ({})), social: mock(async () => ({})) },
  signUp: { email: mock(async () => ({ data: { user: {} }, error: null })) },
  signOut: mock(async () => ({ data: { success: true }, error: null })),
  sendVerificationEmail: mock(async () => ({ data: {}, error: null })),
  verifyEmail: mock(async () => ({ data: {}, error: null })),
  getSession: mock(async () => ({ data: session, error: null })),
  useSession: () => ({ data: session, isPending: false }),
}));

const { AppRoutes } = await import("@/app");
const { SettingsPage } = await import("@/features/settings/components/settings-page");
const { UserMenu } = await import("@/app/user-menu");
const { AuthGuard } = await import("@/app/auth-guard");
const {
  resolveSettingsSection,
  registerSettingsSection,
  getSettingsSectionsByGroup,
} = await import("@/features/settings/lib/section-registry");

beforeEach(() => {
  session = { user: { name: "Hoang Nguyen", email: "hoang@mobilefolk.com" } };
});

describe("account-settings S-001 — settings shell", () => {
  it("AS-001: activating Settings in the avatar menu lands on /settings with the Account section by default", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/w/ws-1"]}>
        {/* A minimal app: the header avatar menu + the settings route. */}
        <div>
          <UserMenu />
          <Routes>
            <Route path="/w/:workspaceId" element={<div>workspace home</div>} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/settings/:section" element={<SettingsPage />} />
          </Routes>
        </div>
      </MemoryRouter>,
    );

    await user.click(screen.getByTestId("user-menu-trigger"));
    await user.click(screen.getByTestId("menu-settings"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-section-title")).toHaveTextContent("Account"),
    );
  });

  it("AS-002: deep-linking to /settings/appearance shows Appearance as the active section", () => {
    render(
      <MemoryRouter initialEntries={["/settings/appearance"]}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("settings-section-title")).toHaveTextContent("Appearance");
    expect(screen.getByTestId("settings-nav-appearance")).toHaveAttribute("aria-current", "page");
  });

  it("AS-003: a signed-out visitor to /settings is redirected to sign-in (settings not shown)", () => {
    session = null;
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          {/* /settings sits INSIDE the AuthGuard-protected block, exactly as app.tsx wires it. */}
          <Route path="/signin" element={<div>sign in screen</div>} />
          <Route element={<AuthGuard />}>
            <Route path="/settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/sign in screen/i)).toBeInTheDocument();
    expect(screen.queryByTestId("settings-section-title")).not.toBeInTheDocument();
  });

  it("AS-004: an unknown section slug falls back to the Account section (no broken/empty page)", () => {
    render(
      <MemoryRouter initialEntries={["/settings/does-not-exist"]}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("settings-section-title")).toHaveTextContent("Account");
    // The body renders real content, not an empty/error page.
    expect(screen.getByTestId("settings-section-body")).not.toBeEmptyDOMElement();
  });

  it("C-001: /settings is account-level and resolves under AuthGuard, NOT under /w/:workspaceId", () => {
    // The real route table wires /settings as a sibling of /w/:workspaceId inside the guard.
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <AppRoutes />
      </MemoryRouter>,
    );
    // Signed in (mock session present) → the settings shell renders, not a workspace shell.
    expect(screen.getByTestId("settings-section-title")).toHaveTextContent("Account");
  });

  it("C-002: sections are deep-linkable by slug; an unknown slug resolves to Account, never null", () => {
    expect(resolveSettingsSection("appearance").slug).toBe("appearance");
    expect(resolveSettingsSection("nope").slug).toBe("account");
    expect(resolveSettingsSection(undefined).slug).toBe("account");
  });

  it("C-006.reg: the registry renders sections in two nav groups (owned + reserved with a Soon badge) and a feature can register a slot", () => {
    render(
      <MemoryRouter initialEntries={["/settings/account"]}>
        <Routes>
          <Route path="/settings/:section" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );
    // Owned group: account + appearance are navigable slots.
    expect(screen.getByTestId("settings-nav-account")).toBeInTheDocument();
    expect(screen.getByTestId("settings-nav-appearance")).toBeInTheDocument();
    // Reserved group: developer/notifications/security carry a "Soon" badge until owned.
    const reservedSlugs = getSettingsSectionsByGroup("reserved").map((s) => s.slug);
    expect(reservedSlugs).toEqual(
      expect.arrayContaining(["developer", "notifications", "security"]),
    );
    expect(getSettingsSectionsByGroup("reserved").every((s) => s.soon)).toBe(true);
    expect(screen.getAllByText("Soon").length).toBeGreaterThanOrEqual(1);

    // The registration mechanism: a sibling feature overrides a reserved slug in place,
    // which clears its "Soon" badge (position preserved).
    registerSettingsSection({
      slug: "developer",
      label: "Developer",
      icon: "settings",
      group: "reserved",
      sub: "API tokens.",
      render: () => <div>dev body</div>,
    });
    expect(resolveSettingsSection("developer").soon).toBe(false);
  });
});
