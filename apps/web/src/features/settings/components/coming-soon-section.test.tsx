import { describe, it, expect, mock, afterEach, afterAll } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// account-settings S-004 / C-006 — reserved settings sections for other features.
//
// Two behaviours proven here, both through the shell so the registry + nav + body wiring is
// exercised end to end (not just the registry function in isolation, which the S-001 shell test
// already covers as C-006.reg):
//   AS-011 — a sibling feature registers a section (Developer); it appears in the nav WITHOUT a
//            "Soon" badge and opens its own content when selected.
//   AS-012 — a still-reserved slot with no owner (Notifications) renders the coming-soon stub
//            with NO interactive controls.
//
// CRITICAL — registry is MODULE-GLOBAL (process-wide under bun test). AS-011 registers over the
// `developer` slug, which mutates shared state other settings test files observe (the documented
// bun mock.module / global-state leak). We snapshot the developer slot's pre-test definition and
// re-register it in afterEach/afterAll so we never leak an owned `developer` slot into siblings
// (e.g. settings-shell.test.tsx asserts every reserved slot still has `soon: true`).

const session: { user: { name: string; email: string } } | null = {
  user: { name: "Hoang Nguyen", email: "hoang@mobilefolk.com" },
};

// Full surface — bun's mock.module is process-wide, so an incomplete mock erases exports other
// modules import. Mirror every export of the real auth-client (same shape as the sibling tests).
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

const { SettingsPage } = await import("@/features/settings/components/settings-page");
const { ComingSoonSection } = await import(
  "@/features/settings/components/coming-soon-section"
);
const { registerSettingsSection, resolveSettingsSection } = await import(
  "@/features/settings/lib/section-registry"
);

// Snapshot the reserved `developer` slot exactly as the shell registered it, so any test that
// overrides it can restore the original reserved stub afterward (no leak to sibling files).
const developerOriginal = { ...resolveSettingsSection("developer") };

function restoreDeveloperSlot() {
  // Re-register the original reserved stub (restores label/sub/render), then put `soon` back —
  // registerSettingsSection clears `soon` on any override, so set the reserved badge explicitly.
  registerSettingsSection(developerOriginal);
  (resolveSettingsSection("developer") as { soon?: boolean }).soon = developerOriginal.soon;
}

afterEach(() => {
  restoreDeveloperSlot();
});

afterAll(() => {
  restoreDeveloperSlot();
});

function renderShellAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("account-settings S-004 — reserved settings sections", () => {
  it("AS-011: a sibling-registered section appears in the nav (no Soon badge) and opens its own content when selected", async () => {
    const user = userEvent.setup();

    // A sibling feature (mcp-roundtrip) mounts its Developer section by registering the slug.
    registerSettingsSection({
      slug: "developer",
      label: "Developer",
      icon: "settings",
      group: "reserved",
      sub: "API tokens and programmatic access.",
      render: () => <div data-testid="developer-owned-body">Create API token</div>,
    });

    renderShellAt("/settings/account");

    // It appears in the settings navigation...
    const devNav = screen.getByTestId("settings-nav-developer");
    expect(devNav).toBeInTheDocument();
    // ...and no longer carries the "Soon" badge (a feature now owns it).
    expect(devNav).not.toHaveTextContent("Soon");
    expect(resolveSettingsSection("developer").soon).toBe(false);

    // Selecting it opens its OWN registered content (not the coming-soon stub).
    await user.click(devNav);
    await waitFor(() =>
      expect(screen.getByTestId("developer-owned-body")).toHaveTextContent("Create API token"),
    );
    expect(screen.queryByTestId("settings-coming-soon")).not.toBeInTheDocument();
  });

  it("AS-012: an unowned reserved section (Notifications) shows the coming-soon state with no interactive controls", () => {
    renderShellAt("/settings/notifications");

    // The coming-soon stub renders for the still-reserved slot.
    const stub = screen.getByTestId("settings-coming-soon");
    expect(stub).toBeInTheDocument();
    // It is informational only — no interactive controls of any kind.
    expect(stub.querySelectorAll("button, a, input, select, textarea, [role='button']")).toHaveLength(
      0,
    );
    // And the section still shows a real, non-empty body (not a broken/empty page).
    expect(screen.getByTestId("settings-section-body")).not.toBeEmptyDOMElement();
  });

  it("C-006.soon: a reserved section without an owner renders the coming-soon stub (icon + title + sub + owner hint), and nothing interactive", () => {
    // Render the stub directly to assert its shape matches the prototype's ComingSoon
    // (Anchord-Design/settings.jsx): an icon, a title, a sub, and an owner "slot · <feature>" hint.
    render(
      <ComingSoonSection
        icon="bell"
        title="Notifications settings coming soon"
        sub="Choose what you're notified about and how."
        owner="slot · notifications"
      />,
    );

    const stub = screen.getByTestId("settings-coming-soon");
    expect(stub).toHaveTextContent("Notifications settings coming soon");
    expect(stub).toHaveTextContent("Choose what you're notified about and how.");
    expect(stub).toHaveTextContent("slot · notifications");
    // The owner hint identifies which feature owns the reserved slot.
    expect(stub).toHaveTextContent(/slot · notifications/);
    // No controls — a coming-soon state has nothing to interact with.
    expect(stub.querySelectorAll("button, a, input, select, textarea")).toHaveLength(0);

    // The owner hint is optional: a stub without an owner still renders title + sub, no controls.
    render(
      <ComingSoonSection
        icon="shield"
        title="Security settings coming soon"
        sub="Manage active sessions."
      />,
    );
    const stubs = screen.getAllByTestId("settings-coming-soon");
    const noOwner = stubs[stubs.length - 1];
    expect(noOwner).toHaveTextContent("Security settings coming soon");
    expect(noOwner.querySelectorAll("button, a, input")).toHaveLength(0);
  });
});
