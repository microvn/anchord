import type { ReactNode } from "react";

// account-settings S-001 / C-006: the section-registry mechanism. A settings section is a
// self-contained slot the shell renders by slug. account-settings owns the shell + the
// `account` / `appearance` owned slots; sibling features (mcp-roundtrip → developer,
// notifications-email → notifications, auth → security) mount their own section by registering
// the SAME slug, which overrides the reserved "Soon" stub in place (position preserved).
//
// Canonical shape from Anchord-Design/settings.jsx (SETTINGS_SECTIONS / registerSettingsSection):
// { slug, label, icon, group, sub, render(ctx) }.

// The render context the shell threads into a section body. Kept open here: each section reads
// only the fields it needs (S-003's appearance reads theme; S-002's account reads the session).
// S-001 ships placeholder bodies, so the shape is intentionally permissive for now.
export type SettingsSectionContext = Record<string, unknown>;

export interface SettingsSection {
  /** URL-addressable id, e.g. "account" → /settings/account. Unique within the registry. */
  slug: string;
  /** Nav label. */
  label: string;
  /** Icon name from the shared Icon set. */
  icon: string;
  /** "owned" = a section this shell ships; "reserved" = a slot a sibling feature fills. */
  group: "owned" | "reserved";
  /** Section sub-title shown under the section header. */
  sub: string;
  /** A reserved slot with no owner renders a coming-soon body until a feature registers it. */
  soon?: boolean;
  /** Renders the section body. */
  render: (ctx: SettingsSectionContext) => ReactNode;
}

// The live registry. Order is significant — the nav and the unknown-slug fallback both rely on
// it (the first OWNED section, account, is the default/fallback target — C-002).
const sections: SettingsSection[] = [];

/** Register a section, OR override an existing slug in place (clearing its "Soon" badge). */
export function registerSettingsSection(section: SettingsSection): void {
  const i = sections.findIndex((s) => s.slug === section.slug);
  if (i >= 0) {
    // Override in place — position preserved, "Soon" cleared (a sibling now owns the slot).
    sections[i] = { ...sections[i], soon: false, ...section };
  } else {
    sections.push(section);
  }
}

/** All registered sections, in registration order. */
export function getSettingsSections(): readonly SettingsSection[] {
  return sections;
}

/** Sections in a nav group ("owned" or "reserved"), in registration order. */
export function getSettingsSectionsByGroup(group: SettingsSection["group"]): SettingsSection[] {
  return sections.filter((s) => s.group === group);
}

// C-002: resolve a slug to its section. An unknown (or undefined) slug falls back to the first
// owned section — Account — never null, so the shell never renders a broken/empty page (AS-004).
export function resolveSettingsSection(slug: string | undefined): SettingsSection {
  const fallback = sections.find((s) => s.group === "owned") ?? sections[0];
  if (!slug) return fallback;
  return sections.find((s) => s.slug === slug) ?? fallback;
}
