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
      <div className="px-2.5 pb-1.5 font-mono text-[11px] uppercase tracking-wider text-subtle">
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
            className={`relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[12.5px] transition-colors ${
              active
                ? "bg-accent-soft font-semibold text-accent-ink"
                : "text-muted hover:bg-elev hover:text-ink"
            }`}
          >
            {/* .set-nav-item.active::before — a 2px left accent bar, rounded on its right edge. */}
            {active && (
              <span
                aria-hidden="true"
                className="absolute -left-2.5 top-1.5 bottom-1.5 w-0.5 rounded-r-sm bg-accent"
              />
            )}
            <Icon name={s.icon} size={16} className={active ? "text-accent-ink" : "text-subtle"} />
            <span className="flex-1">{s.label}</span>
            {s.soon ? (
              <span className="rounded border border-line px-1 py-px font-mono text-[8.5px] uppercase tracking-wider text-subtle">
                Soon
              </span>
            ) : (
              active && <Icon name="chevRight" size={14} className="text-accent" />
            )}
          </Link>
        );
      })}
    </div>
  );
}
