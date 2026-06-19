# Spec: account-settings

**Created:** 2026-06-19
**Last updated:** 2026-06-19
**Status:** Draft

## Overview

An account-level Settings area for the signed-in user, reached from the avatar menu. This
spec owns the Settings SHELL (route, navigation, section mounting) plus the Account and
Appearance sections. It does NOT own the content of other sections — it exposes a
mechanism for sibling features to mount their own (mcp-roundtrip → Developer;
notifications-email → Notifications; auth → Security). It is the gate that unblocks the
mcp-roundtrip Personal-Access-Token UI.

## Data Model

No new persistent entity or column in v0. Reuses the existing `user` record
(`name`, `email`, `emailVerified`, `image`, `createdAt`) and the `account` record
(sign-in provider). The theme preference lives in the browser (per-device, localStorage
key `anchord-theme`) — not server-persisted (matches the existing `theme-provider`).

## Stories

### S-001: Open account settings from anywhere (P0)

**Description:** As a signed-in user, I open my account settings from the avatar menu and
move between settings sections by URL.
**Source:** Conversation 2026-06-19 (settings shell is the gate for the PAT UI); existing
`app/user-menu.tsx` Settings placeholder ("workspace-project-ui owns it" — superseded);
`app/app.tsx` route table.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` apps/web/src/app/app.tsx, apps/web/src/app/user-menu.tsx, apps/web/src/features/settings/components/settings-page.tsx, apps/web/src/features/settings/components/settings-nav.tsx, apps/web/src/features/settings/lib/section-registry.ts
- `autonomous:` true
- `verify:` signed in → navigating to /settings shows the Account section; signed out → /settings redirects to sign-in.

**Acceptance Scenarios:**

AS-001: Open settings from the avatar menu
- **Given:** a signed-in user on any app screen
- **When:** they activate "Settings" in the avatar menu
- **Then:** they land on /settings with the Account section shown by default
- **Data:** authenticated session
- **Setup:** user belongs to at least one workspace

AS-002: Deep-link directly to a section
- **Given:** a signed-in user
- **When:** they navigate directly to /settings/appearance
- **Then:** the Appearance section is shown as the active section
- **Data:** URL /settings/appearance

AS-003: Signed-out visitor is redirected
- **Given:** no authenticated session
- **When:** the visitor navigates to /settings
- **Then:** they are redirected to sign-in (the settings area is not shown)
- **Data:** no session cookie

AS-004: Unknown section slug falls back
- **Given:** a signed-in user
- **When:** they navigate to /settings/<unrecognized-slug>
- **Then:** the Account section is shown (no broken or empty page)
- **Data:** URL /settings/does-not-exist

### S-002: View and edit account profile (P0)

**Description:** As a signed-in user, I see my identity details, change my display name, and
sign out.
**Source:** Conversation 2026-06-19 (Account section content); `user` schema
(`name`/`email`/`emailVerified`/`image`/`createdAt`); `auth-client` (signOut, useSession).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/web/src/features/settings/components/account-section.tsx, apps/web/src/lib/api/auth-client.ts
- `autonomous:` true
- `verify:` change display name + save → new name persists across reload; clearing the name is refused; sign out ends the session.

**Acceptance Scenarios:**

AS-005: Identity details are shown read-only
- **Given:** a signed-in user who joined in June 2026 via Google with a verified email
- **When:** they open the Account section
- **Then:** their email, sign-in provider, email-verified status, and join date are shown,
  and the email is not editable
- **Data:** user{ email, provider: google, emailVerified: true, createdAt: 2026-06 }
- **Setup:** authenticated session

AS-006: Edit and save display name
- **Given:** a signed-in user whose display name is "Hoang Nguyen"
- **When:** they change the display name to "Hoang N." and save
- **Then:** the new display name is persisted and shown wherever the user's name appears
- **Data:** new name "Hoang N."

AS-007: Empty display name is refused
- **Given:** a signed-in user editing their display name
- **When:** they clear the field and save
- **Then:** the save is refused with a clear message and the display name is unchanged
- **Data:** name ""

AS-008: Sign out
- **Given:** a signed-in user in the Account section
- **When:** they activate sign out
- **Then:** the session ends and they are returned to the signed-out entry
- **Data:** authenticated session

AS-013: Over-length display name is refused
- **Given:** a signed-in user editing their display name
- **When:** they enter an 81-character name and save
- **Then:** the save is refused with a clear message and the display name is unchanged
- **Data:** name of 81 characters

### S-003: Choose appearance theme (P1)

**Description:** As a user, I pick light or dark in settings and the choice applies
immediately and persists on this device.
**Source:** Conversation 2026-06-19 (Appearance section); existing
`app/theme-provider.tsx` (dark canonical, localStorage, header toggle).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/web/src/features/settings/components/appearance-section.tsx, apps/web/src/app/theme-provider.tsx
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: Appearance reflects the active theme
- **Given:** the app is currently in dark theme
- **When:** the user opens the Appearance section
- **Then:** dark is shown as the selected theme
- **Data:** active theme dark

AS-010: Changing theme applies and persists per-device
- **Given:** the app is in dark theme
- **When:** the user selects light in the Appearance section
- **Then:** the app re-themes to light immediately, the header theme toggle reflects light,
  and the choice survives a reload on the same device
- **Data:** select light

### S-004: Reserved settings sections for other features (P2)

**Description:** As another feature, I mount my own settings section into the shell;
sections without an owner show a coming-soon state.
**Source:** Conversation 2026-06-19 (Developer slot for mcp-roundtrip; Notifications/Security
reserved); CLAUDE.md frontend architecture (feature-based).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/web/src/features/settings/lib/section-registry.ts, apps/web/src/features/settings/components/coming-soon-section.tsx
- `autonomous:` true

**Acceptance Scenarios:**

AS-011: A feature-registered section appears
- **When:** a sibling feature registers a settings section (e.g. Developer)
- **Then:** that section appears in the settings navigation and opens its own content when selected

AS-012: An unowned section shows coming-soon
- **When:** the user opens a reserved section that has no owning feature yet (Notifications, Security)
- **Then:** a coming-soon state is shown with no controls

## Constraints & Invariants

- C-001: /settings is account-level (not under /w/:workspaceId) and requires an
  authenticated session; a signed-out visitor is redirected to sign-in. (AS-001, AS-003)
- C-002: Settings sections are deep-linkable by slug; an unknown slug falls back to the
  Account section, never an error page. (AS-002, AS-004)
- C-003: Email is read-only in settings in v0 (cannot be changed). (AS-005)
- C-004: Display name must be non-empty and at most 80 characters; saving an empty or
  over-length name is refused and the stored name is unchanged. (AS-007, AS-013)
- C-005: Theme is per-device (browser-local) with dark as the canonical default; the
  Appearance control and the header toggle always reflect the same active theme. (AS-009, AS-010)
- C-006: Sibling features mount their own settings section via a registration mechanism;
  account-settings owns only the shell + Account + Appearance. A reserved section with no
  owner shows a coming-soon state. (AS-011, AS-012)

## Linked Fields

- **settings section registry** — consumed by `mcp-roundtrip` (its Developer section mounts
  through this mechanism, registering `{ slug, label, icon, group, sub, render(ctx) }`).
  Produced by `account-settings`:S-004 / C-006. ✔ extension contract: registering the
  `developer` slug overrides the reserved stub in place; mcp-roundtrip adds "Developer"
  without editing the shell core. Signature validated against `Anchord-Design/settings.jsx`
  (`registerSettingsSection`).

## UI Notes

Structural reference only (no layout/styling). Canonical source for naming + shape:
`Anchord-Design/settings.jsx` (and `settings-dev.jsx` for the Developer section, owned by
mcp-roundtrip) — canonical on conflict; AS/Constraints still win over it. `[N]` new, `[E]` existing.

- `SettingsPage` `[N]` *(account-level shell at /settings under the auth guard; renders the
  section nav + the active section's header (label + sub-title) + body)*
  - `SettingsNav` `[N]` *(two groups: "Settings" = owned sections, "Reserved" = slots; a
    reserved slot without an owner shows a "Soon" badge)*
    - owned: Account · Appearance
    - reserved: Developer *(filled by mcp-roundtrip)* · Notifications *(filled by notifications-email)* · Security *(filled by auth)*
  - `AccountSection` `[N]`: identity readout (avatar from OAuth · name · email/provider/verified/joined)
    + display-name field + sign-out *(prototype also shows an editable bio + avatar change/remove — deferred, see Not in Scope)*
  - `AppearanceSection` `[N]`: theme choice light / dark *(reads/writes the existing
    theme-provider; prototype shows a 3-option grid incl. System — System deferred)*
  - `ComingSoonSection` `[N]` *(generic stub for any reserved slot without an owner)*
- Avatar menu "Settings" item `[E]` `app/user-menu.tsx` *(currently inert — wire to /settings)*

Section registry signature (the extension contract): a feature registers
`{ slug, label, icon, group, sub, render(ctx) }`; registering an existing slug overrides it
in place (position preserved) and clears its "Soon" badge — so a sibling fills a reserved slot
without editing the shell core.

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| `ThemeProvider` / `useTheme` | apps/web/src/app/theme-provider.tsx | reuse as-is; AppearanceSection reads `theme` + `toggleTheme` |
| Avatar "Settings" item | apps/web/src/app/user-menu.tsx | wire the inert placeholder to navigate to /settings |
| App header | apps/web/src/app/app-header.tsx | reuse (search/bell/avatar) above the settings shell |
| `authClient` (signOut, useSession) | apps/web/src/lib/api/auth-client.ts | reuse for sign-out + reading the session user |

### System Impact & Technical Risks

- `user` record exposes `name`, `email`, `emailVerified`, `image`, `createdAt`; display-name
  edit updates the better-auth user (`name`); email stays read-only. Sign-in provider read
  from the `account` record. No new column → no migration.
- `app/app.tsx`: add `/settings` (+ `/settings/:section`) under the existing AuthGuard,
  as a sibling of the `/w/:workspaceId` block (account-level, not workspace-scoped).
- Risk (low): the settings shell introduces the first account-level (non-workspace) route +
  section-registry pattern; sibling specs (mcp-roundtrip, notifications-email, auth) depend
  on the registry contract being stable.

## Not in Scope

- **Bio field / public profile page** — anchord has no public profile surface in v0 to
  display a bio; defer with the public-profile feature (v0.5).
- **Custom avatar upload** — depends on the asset-storage pipeline (self-host `ASSETS_DIR`);
  v0 shows the provider/OAuth image only. Defer.
- **Theme "system / auto" option** — the existing theme is dark/light only; system-follow deferred.
- **Email change** — read-only in v0 (the better-auth change-email flow is deferred).
- **Developer section content (PAT)** — owned by `mcp-roundtrip`; this spec only reserves the
  slot + registry entry.
- **Notifications section content (preferences/opt-out/digest)** — owned by
  `notifications-email` Phase 2; reserved slot only.
- **Security section content (password change, active sessions, 2FA)** — owned by `auth`;
  reserved slot only.
- **Workspace settings (members, rename, default general access)** — workspace-scoped, live
  under /w/:workspaceId, owned by the workspace specs.
- **Billing, Public URL, Roadmap, Integrations, Connected Apps (OAuth)** — out of v0
  (Connected Apps/OAuth → v0.5).

## Gaps

- GAP-001 (status: resolved → C-004, AS-013): display-name maximum length set to 80
  characters (decided 2026-06-19). Source: "Display name must be non-empty" (no max stated).

## Clarifications — 2026-06-19

- **Account scope = minimal gate:** bio and custom avatar-upload are deferred (Not in Scope).
  Bio has no public-profile surface to display it in v0 (Public URL is out of v0), and
  avatar-upload depends on the self-host asset pipeline (`ASSETS_DIR`). v0 shows the
  provider/OAuth image read-only and edits only the display name.
- **Display-name length:** non-empty and ≤ 80 characters (C-004); resolves GAP-001.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-19 | Initial creation (Mode A; from conversation 2026-06-19 — settings shell as the gate for mcp-roundtrip PAT UI) | -- |
| 2026-06-19 | Phase 3 clarifications: defer bio+avatar-upload; display-name ≤80 chars (GAP-001 resolved → C-004 + AS-013) | -- |
| 2026-06-19 | Minor: UI Notes aligned to prototype `Anchord-Design/settings.jsx` (nav owned/reserved groups + Soon badge, per-section sub-title, registry signature `{slug,label,icon,group,sub,render}`); decisions confirmed unchanged (defer bio+avatar, dark/light only, name ≤80) | -- |
