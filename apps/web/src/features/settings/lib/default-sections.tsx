import { registerSettingsSection } from "./section-registry";
import { ComingSoonSection } from "../components/coming-soon-section";
import { AccountSection } from "../components/account-section";

// account-settings S-001 / C-006: register the sections this shell ships. Two OWNED slots
// (account, appearance) and three RESERVED slots (developer, notifications, security) that show
// a "Soon" coming-soon body until a sibling feature registers over the slug.
//
// S-001 ships PLACEHOLDER bodies for the owned slots — S-002 (Account) and S-003 (Appearance)
// fill them in by overriding `render` via registerSettingsSection. The Anchord-Design owner/sub
// strings are kept so the nav + section headers read correctly now.
//
// Registration runs once at module load (the page imports this module). Guarded so a re-import
// (e.g. test re-evaluation) does not duplicate slots.
let registered = false;

function ownedPlaceholder(label: string) {
  // S-002/S-003 replace these bodies. Until then a reserved-free placeholder keeps the section
  // navigable (AS-002 deep-link still resolves a real, non-empty body).
  return (
    <div
      data-testid="settings-section-placeholder"
      className="rounded-[12px] border border-line bg-elev p-8 text-[12.5px] text-subtle"
    >
      {label} settings.
    </div>
  );
}

export function registerDefaultSettingsSections(): void {
  if (registered) return;
  registered = true;

  registerSettingsSection({
    slug: "account",
    label: "Account",
    icon: "user",
    group: "owned",
    sub: "Your profile, email, and how readers see you.",
    render: () => <AccountSection />,
  });
  registerSettingsSection({
    slug: "appearance",
    label: "Appearance",
    icon: "settings",
    group: "owned",
    sub: "Theme and how anchord looks for you.",
    render: () => ownedPlaceholder("Appearance"),
  });
  registerSettingsSection({
    slug: "notifications",
    label: "Notifications",
    icon: "bell",
    group: "reserved",
    soon: true,
    sub: "How and when anchord notifies you.",
    render: () => (
      <ComingSoonSection
        icon="bell"
        title="Notifications settings coming soon"
        sub="Choose what you're notified about and how. This section is owned by the notifications feature."
        owner="slot · notifications"
      />
    ),
  });
  registerSettingsSection({
    slug: "security",
    label: "Security",
    icon: "shield",
    group: "reserved",
    soon: true,
    sub: "Sessions, devices, and account protection.",
    render: () => (
      <ComingSoonSection
        icon="shield"
        title="Security settings coming soon"
        sub="Manage active sessions and sign-in protection. This section is owned by the auth feature."
        owner="slot · auth"
      />
    ),
  });
  registerSettingsSection({
    slug: "developer",
    label: "Developer",
    icon: "settings",
    group: "reserved",
    soon: true,
    sub: "API tokens and programmatic access.",
    render: () => (
      <ComingSoonSection
        icon="settings"
        title="Developer settings coming soon"
        sub="Create API tokens and connect your agent over MCP. This section is owned by the mcp-roundtrip feature."
        owner="slot · mcp-roundtrip"
      />
    ),
  });
}
