import { Link } from "react-router-dom";
import { Icon } from "@/components/icon";
import { getSettingsSectionsByGroup, type SettingsSection } from "../lib/section-registry";

// account-settings S-001: the settings section nav. Two groups — "Settings" (owned) and
// "Reserved" (slots a sibling feature fills). A reserved slot without an owner shows a "Soon"
// badge (C-006). Each item is a Link to /settings/<slug> so sections are deep-linkable (C-002).
// Canonical shape from Anchord-Design/settings.jsx (set-nav / set-nav-group).
export function SettingsNav({ activeSlug }: { activeSlug: string }) {
  const owned = getSettingsSectionsByGroup("owned");
  const reserved = getSettingsSectionsByGroup("reserved");

  return (
    <nav data-testid="settings-nav" className="flex w-full flex-col gap-5 md:w-56 md:flex-none">
      <NavGroup label="Settings" sections={owned} activeSlug={activeSlug} />
      <NavGroup label="Reserved" sections={reserved} activeSlug={activeSlug} />
    </nav>
  );
}

function NavGroup({
  label,
  sections,
  activeSlug,
}: {
  label: string;
  sections: SettingsSection[];
  activeSlug: string;
}) {
  if (sections.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="px-2 pb-1 font-mono text-[10.5px] uppercase tracking-wide text-faint">
        {label}
      </div>
      {sections.map((s) => {
        const active = s.slug === activeSlug;
        return (
          <Link
            key={s.slug}
            to={`/settings/${s.slug}`}
            data-testid={`settings-nav-${s.slug}`}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors ${
              active ? "bg-elev font-medium text-ink" : "text-muted hover:bg-elev hover:text-ink"
            }`}
          >
            <Icon name={s.icon} size={16} />
            <span className="flex-1">{s.label}</span>
            {s.soon && (
              <span className="rounded-full bg-accent-soft px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-wide text-accent-ink">
                Soon
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
