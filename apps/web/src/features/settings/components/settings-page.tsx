import { useParams } from "react-router-dom";
import { SettingsNav } from "./settings-nav";
import { registerDefaultSettingsSections } from "../lib/default-sections";
import { resolveSettingsSection } from "../lib/section-registry";

// Register the shell's owned + reserved sections once, at module load — before the page reads
// the registry. (S-002/S-003 override the owned bodies via the same registry.)
registerDefaultSettingsSections();

// account-settings S-001: the account-level Settings shell, mounted at /settings and
// /settings/:section under the AuthGuard (C-001). It resolves the :section slug to a registered
// section (unknown → Account fallback, C-002 / AS-004), renders the section nav + the active
// section's header (label + sub-title) + its body. The section bodies themselves come from the
// registry — S-002 (Account) / S-003 (Appearance) fill the owned slots; S-004 finalizes the
// reserved coming-soon stubs.
export function SettingsPage() {
  const { section } = useParams<{ section: string }>();
  const active = resolveSettingsSection(section);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-8">
      <div className="flex flex-col gap-8 md:flex-row md:gap-10">
        <SettingsNav activeSlug={active.slug} />
        <div className="min-w-0 flex-1">
          <header className="mb-6">
            <h1 data-testid="settings-section-title" className="text-[20px] font-semibold text-ink">
              {active.label}
            </h1>
            <p className="mt-1 text-[13px] text-subtle">{active.sub}</p>
          </header>
          <div data-testid="settings-section-body">{active.render({})}</div>
        </div>
      </div>
    </div>
  );
}
