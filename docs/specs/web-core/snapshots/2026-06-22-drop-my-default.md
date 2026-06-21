# Snapshot: web-core
**Date:** 2026-06-22
**Ref:** breadcrumb drops "My Default" → stored workspace name
**Reason:** M5 — AS-017 Then reworked: root crumb = stored workspace name (no "My Default" special case); AS-024/025/026 examples updated

---

# Spec: web-core

**Created:** 2026-06-09
**Last updated:** 2026-06-21
**Status:** Draft

## Overview

The frontend core of anchord — the FE analog of `api-core`. It owns the cross-cutting
concerns every screen sits on: signing in/out, the route guard, the typed API client and
its error/session handling, the app shell + theme, and the shared UI primitives. It stands
this up as a side effect of the first real behaviour (sign-in + the authenticated shell).
Every feature UI spec (`<feature>-ui.md`) consumes web-core and builds its screens into the
shell — web-core itself ships no feature screen.

Lives in `apps/web` of the Bun workspace; consumes the already-built backend through the
typed client (dev: proxied to the backend; production: backend serves the built static app).

## Data Model

No persistent data — the frontend is a client. Client-side state only:
- **session view**: the signed-in user resolved from the server session (read on load; no
  auth token is stored client-side).
- **theme**: dark (canonical) by default; a UI preference, not server state.

## Stories

### S-001: Sign in, sign out, and guard the app (P0)

**Description:** As a user, I sign in with my email and password to enter the app; an
unauthenticated visitor only ever sees the sign-in screen; signing out returns me there.
**Source:** user request "Eden client tới API"; CLAUDE.md auth (email+password, better-auth session cookie); DESIGN.md §Auth.

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` unknown (`apps/web/` scaffold — Vite + Tailwind 4 + design tokens + fonts + the typed API client + router + providers + sign-in screen + route guard)
- `autonomous:` true
- `verify:` open the app with no session → sign-in screen; sign in with a valid account → the authenticated shell; sign out → back to sign-in.

**Acceptance Scenarios:**

AS-001: An unauthenticated visit shows the sign-in screen
- **Given:** I have no valid session
- **When:** I open the app
- **Then:** I see the sign-in screen (email + password), not the authenticated app
- **Data:** fresh browser, no session

AS-002: A valid sign-in enters the app
- **Given:** I have a registered account
- **When:** I sign in with the correct email and password
- **Then:** my session is established and the authenticated app shell opens
- **Data:** registered user, correct credentials

AS-003: An invalid sign-in shows an error and stays
- **Given:** I have a registered account
- **When:** I submit the wrong password
- **Then:** I see a sign-in error and remain on the sign-in screen with no session
- **Data:** registered user, wrong password

AS-004: A protected route while unauthenticated redirects to sign-in, preserving the target
- **Given:** I have no valid session
- **When:** I navigate directly to a protected in-app deep link (path + query — e.g. a workspace invite carrying its token and invited email)
- **Then:** I am redirected to the sign-in screen, which carries the attempted route (path + query) as a return target so that after I sign in I land back on it instead of losing it; the return target is honored only for internal paths (same open-redirect guard as doc-access-routing:C-015), and the bare landing route needs no return target
- **Data:** direct deep-link with query, no session

AS-005: Signing out ends the session and returns to sign-in
- **Given:** I am signed in
- **When:** I sign out
- **Then:** my session is cleared and I am returned to the sign-in screen
- **Data:** signed-in user

### S-002: Resilient API and session handling (P0)

**Description:** As any screen in the app, I call the backend through one shared client that
sends my session, surfaces failures as a consistent retryable error, and sends me back to
sign-in if my session has expired — so no screen crashes or goes blank on a bad response.
**Source:** api-core C-005 (server-resolved identity from the session); CLAUDE.md (better-auth DB session cookie, revocable); research note "centralize error handling, no client-side token refresh".

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (`apps/web/` typed client wrapper + query/provider layer + shared error/empty primitives)
- `autonomous:` true
- `verify:` a screen whose request fails shows a retry-able error (not blank); after the session is invalidated, the next request returns the user to sign-in.

**Acceptance Scenarios:**

AS-006: An authenticated request acts as the signed-in user
- **Given:** I am signed in
- **When:** a screen calls the backend
- **Then:** the request carries my session and the backend acts as me (no identity is sent in the request body)
- **Data:** signed-in user, a read request

AS-007: A failed request shows a retryable error, not a crash
- **Given:** the backend is unreachable or returns an error
- **When:** a screen loads data
- **Then:** I see a consistent error surface with a way to retry — not a blank, frozen, or crashed screen
- **Data:** backend unreachable

AS-008: An expired session returns me to sign-in
- **Given:** my session has been invalidated (expired or signed out elsewhere)
- **When:** the app makes a request and the backend rejects it as unauthenticated
- **Then:** I am returned to the sign-in screen rather than left on a broken page
- **Data:** invalidated session mid-use

### S-003: Design-system chrome and responsive shell (P1)

**Description:** As a user, the app chrome looks and behaves like the anchord design system —
dark-operator, teal accent, the right type — and reflows correctly from desktop to mobile.
**Source:** DESIGN.md (Aesthetic Direction, Color, Typography, Responsive — mandatory); memory "responsive mandatory".

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` unknown (`apps/web/` theme + app shell layout + shared primitives EmptyState/ErrorState/FormatBadge/AccessIndicator)
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: The chrome uses the design system
- **Given:** the app is open
- **When:** the chrome renders
- **Then:** it uses the dark-operator palette with teal as the only accent and the Geist/Fraunces type — never purple/violet, never Claude-orange
- **Data:** authenticated shell on screen

AS-010: The shell is responsive across breakpoints
- **Given:** the authenticated shell is open
- **When:** the viewport narrows past the tablet and mobile breakpoints
- **Then:** the chrome reflows per DESIGN.md (off-canvas drawers/sheets, condensed top bar, tap targets ≥40px)
- **Data:** widths 1440 / 768 / 360

AS-011: Theme defaults to dark
- **Given:** a fresh visit with no saved preference
- **When:** the app loads
- **Then:** the dark (canonical) theme is applied by default
- **Data:** fresh browser

### S-004: Left sidebar — workspace nav frame (P1)

**Description:** As a user in the management context, I navigate from a left sidebar that holds the
brand, a New-doc action, the workspace switcher, the primary nav, and (for admins) a Members entry;
I can collapse it to an icon rail, and on a small screen it becomes an off-canvas drawer.
**Source:** user request "thiếu switch workspace … sidebar"; DESIGN.md §Layout "App shell — left sidebar + header"; uselink reference (user screenshots).

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` `apps/web/src/app/app-shell.tsx` + new sidebar components under `apps/web/src/app/`
- `autonomous:` true
- `verify:` open the app signed in → a left sidebar shows brand, New doc, the workspace switcher, the nav, and (as admin) Members; collapse it to an icon rail and back; narrow to mobile → it becomes a drawer.

**Acceptance Scenarios:**

AS-012: The sidebar shows the shell frame in order on a recessed surface
- **Given:** I am signed in and in the management context
- **When:** the sidebar renders
- **Then:** top-to-bottom it shows the brand, a `+ New doc` action, the workspace switcher, the primary nav (Dashboard · All docs · Projects · Activity), and a Members/Settings footer — on a lower-contrast surface than the content
- **Data:** authenticated shell, desktop width

AS-013: The current section's nav item is marked active
- **Given:** I am on a section (e.g. All docs)
- **When:** the sidebar renders
- **Then:** that nav item is marked active (accent-soft background + teal left bar + accent-ink text) and the others are not
- **Data:** current route = All docs

AS-014: The Members entry is admin-only
- **Given:** I am viewing a workspace
- **When:** the sidebar renders for a workspace admin vs a non-admin member
- **Then:** the admin sees the Members entry; the member does not (hidden or disabled) — honoring workspaces-ui C-002
- **Data:** one admin, one member

AS-015: Collapsing the sidebar reduces it to an icon rail
- **Given:** the sidebar is open
- **When:** I toggle the collapse chevron
- **Then:** the sidebar reduces to an icon rail (glyphs + tooltips; the switcher becomes the workspace glyph, New doc a `+`), and toggling again restores the full sidebar
- **Data:** desktop width

AS-016: At mobile width the sidebar becomes an off-canvas drawer
- **Given:** the authenticated shell is open
- **When:** the viewport narrows past the mobile breakpoint
- **Then:** the sidebar becomes an off-canvas drawer opened from the header, with the workspace switcher at the drawer top, and tap targets ≥40px
- **Data:** width 360

### S-005: App header — breadcrumb + account (P1)

**Description:** As a user, a thin header shows where I am (breadcrumb) on the left and my account,
theme, search, and context actions on the right; my account/avatar lives here, not in the sidebar,
and the workspace switcher is never duplicated here.
**Source:** user request "header nên để user (avatar) bên phải + context, theme"; DESIGN.md §Layout "App shell — left sidebar + header".

**Execution:**
- `depends_on:` S-004
- `parallel_safe:` false
- `files:` `apps/web/src/app/app-shell.tsx`, `apps/web/src/app/app-header.tsx` (deriveCrumbs + Breadcrumb), `apps/web/src/app/user-menu.tsx`; reads the project name from the workspace-project React Query cache
- `autonomous:` true
- `verify:` signed in → the header shows a breadcrumb on the left reflecting the current page (workspace root alone on the dashboard; `My Default › Projects` on the projects list; `My Default › [Project Name]` on a project), every crumb but the last is a link, the last is emphasized; on the right, search + theme + the avatar menu (with sign-out); the workspace switcher is NOT in the header.

**Acceptance Scenarios:**

AS-017: The breadcrumb's root crumb is the active workspace, shown with the switcher's label
- **Given:** I am the owner of the auto-created workspace whose stored name is "default"
- **When:** the header renders on any page in that workspace
- **Then:** the breadcrumb's root crumb reads "My Default" — the SAME label the sidebar switcher uses (title-cased workspace name, with the owner's auto-created default reading "My Default"; see workspaces-ui:AS-001) — never the raw stored name or the workspace id
- **Data:** workspace name "default", caller is its owner → "My Default"; a workspace named "acme" → "Acme"

AS-024: The workspace dashboard shows only the root crumb
- **Given:** I am on the workspace dashboard/home route (the workspace root, no sub-section)
- **When:** the header renders
- **Then:** the breadcrumb shows ONLY the workspace root crumb — no second crumb and no separator
- **Data:** the workspace home route

AS-025: A list route appends its page crumb
- **Given:** I am on a workspace list route
- **When:** the header renders
- **Then:** the breadcrumb appends a page crumb after the workspace root — "All Docs" on the All-docs route, "Projects" on the Projects route
- **Data:** All-docs route → "My Default › All Docs"; Projects route → "My Default › Projects"

AS-026: A project detail route shows the project's real name, with a skeleton until it resolves
- **Given:** I open a single project's doc view
- **When:** the header renders and the project's name is already in the loaded browse cache
- **Then:** the breadcrumb appends the project's real NAME as the last crumb (never the raw project id); while the name is not yet resolved (e.g. a cold deep-link before the list loads) that crumb shows a small skeleton placeholder, swapped for the name once it resolves — no blocking fetch is issued
- **Data:** project named "Billing" → "My Default › Billing"; cold deep-link → skeleton then "Billing"

AS-027: Parent crumbs are links; the last crumb is the active page
- **Given:** the breadcrumb shows more than one crumb
- **When:** I read and click it
- **Then:** every crumb except the last is a clickable link that navigates to that level (the workspace root crumb → the workspace home, "All Docs" → the All-docs list, "Projects" → the projects list); the last crumb is the current page — emphasized and NOT a link
- **Data:** on `My Default › Projects`, clicking "My Default" goes to the workspace home; "Projects" is emphasized, not clickable

AS-028: The account/settings route shows a static Account root then Settings
- **Given:** I am on the settings route (outside the workspace path)
- **When:** the header renders
- **Then:** the breadcrumb reads "Account › Settings" — "Account" is a static label (not a link, there is no account landing page), "Settings" is the active page; a settings sub-section appends "› [Section]" with the section as the active crumb
- **Data:** /settings → "Account › Settings"; /settings/appearance → "Account › Settings › Appearance"

AS-018: The account and utilities live in the header right, not the switcher
- **Given:** I am signed in
- **When:** the header renders
- **Then:** the right side shows context actions, search, the theme toggle, and the user avatar menu (whose menu offers settings and sign-out); the workspace switcher does NOT appear in the header (it lives in the sidebar)
- **Data:** authenticated shell

AS-019: At mobile width the header condenses into the avatar menu
- **Given:** the header is open
- **When:** the viewport narrows past the mobile breakpoint
- **Then:** search collapses to an icon and theme/notifications/sign-out fold into the avatar menu, which stays visible; tap targets ≥40px
- **Data:** width 360

### S-006: Empty, loading, and error states (P1)

**Description:** As a user, when a view has no content I see a calm, type-only state with one clear
action; a search that matches nothing reads differently from a view that has no data yet; loading
shows a skeleton, not a spinner; and a failed load is recoverable, never a blank or crashed screen.
**Source:** user request "blank page"; DESIGN.md §"Empty, loading & error states".

**Execution:**
- `depends_on:` S-002
- `parallel_safe:` false
- `files:` `apps/web/src/components/{empty-state,error-state}.tsx` (+ a skeleton primitive)
- `autonomous:` true

**Acceptance Scenarios:**

AS-020: An empty data view nudges the first action
- **Given:** a view whose data set is empty (e.g. a fresh workspace with no docs)
- **When:** it renders
- **Then:** it shows a low-key, type-only empty state (no decorative illustration) with one primary create action ≥40px
- **Data:** zero items

AS-021: A no-results state is distinct from empty
- **Given:** I searched and nothing matched
- **When:** the results render
- **Then:** I see a no-results state that names the query and offers Clear search — NOT the create CTA shown for an empty data set
- **Data:** a query with no matches

AS-022: Loading shows a skeleton, not a full-page spinner
- **Given:** a view is fetching its data
- **When:** it is still loading
- **Then:** it shows a skeleton matching the list shape (a load under ~300ms shows nothing, to avoid a flash) — not a centered full-page spinner
- **Data:** a slow fetch

AS-023: A failed load is recoverable
- **Given:** a view's data request fails
- **When:** it renders the failure
- **Then:** it shows a recoverable error with a Retry action (distinct from the empty state) — never a blank or crashed screen
- **Data:** backend error on load

## Constraints & Invariants

- C-001: The app shows nothing beyond the sign-in screen without a valid server session;
  identity comes from the server session (cookie), and no auth token is stored client-side. (AS-001, AS-004, AS-005)
- C-002: Every screen reaches the backend through the one shared client — a failed request
  surfaces a consistent retryable error and an unauthenticated response returns the user to
  sign-in; a screen never crashes or goes blank on a bad response. (AS-007, AS-008)
- C-003: The app chrome uses the DESIGN.md system (dark-operator canonical, teal the only
  accent, Geist/Fraunces) and is responsive at every breakpoint (tap targets ≥40px); the
  user's rendered doc content is never styled by this system. (AS-009, AS-010, AS-011)
- C-004: A built app loads from the same origin as the API and reaches it through the typed
  client (dev: proxied to the backend; production: served by the backend). (AS-002, AS-006)
- C-005: The workspace switcher appears in exactly ONE place — the sidebar — and is never
  duplicated in the header; conversely the account (avatar menu + sign-out) lives in the header,
  not the sidebar footer. (AS-012, AS-018)
- C-006: The sidebar Members entry shows only to a workspace admin; a non-admin member does not
  see it (honoring workspaces-ui C-002). (AS-014)
- C-007: Empty and no-results are distinct states (empty → a create CTA; no-results → name the
  query + Clear search); loading uses a shape-matching skeleton, not a full-page spinner; a failed
  load is recoverable with Retry, never blank or crashed. (AS-020, AS-021, AS-022, AS-023)
- C-008: The breadcrumb reflects the active route as a path of crumbs. The root crumb is the active
  workspace, shown with the SAME label the switcher uses (title-cased name; the owner's auto-created
  default reads "My Default" — workspaces-ui:AS-001), never the raw stored name or an id. The workspace dashboard shows that root crumb alone; list routes
  append a page crumb (All Docs / Projects); a project route appends the project's real name resolved
  from the loaded browse cache (a skeleton until it resolves — no blocking fetch — never a raw id);
  the settings route shows a static "Account" root then "Settings" (+ section). Every crumb except the
  last is a link to its level; the last crumb is the emphasized active page. (AS-017, AS-024, AS-025,
  AS-026, AS-027, AS-028)

## Linked Fields

web-core is the **consumer**; the backend `auth` cluster is the producer (already built).

- `session` — consumed by web-core:S-001 (AS-001/004/005) on app load and web-core:S-002
  (AS-006/008) on every request. Produced by `auth` (better-auth sign-in / sign-out /
  get-session over `/api/auth/*`), backed by the revocable DB session cookie. ✔ persisted +
  served on every load and request.
- **workspace switcher** (component + bootstrap) — consumed by web-core:S-004 (AS-012) as a
  mounted slot at the sidebar top. Produced by `workspaces-ui:S-001` (the `WorkspaceSwitcher`
  reading the `/api/me` bootstrap). ✔ web-core owns the SLOT/placement; workspaces-ui owns the
  data + behavior — do not rebuild the switcher here.
- **workspace role (admin vs member)** — consumed by web-core:S-004 (AS-014) to show/hide the
  Members entry. Produced by `workspaces-ui` (the bootstrap role) + `workspaces-ui:C-002`
  (admin-only management). ✔ surface match (the bootstrap carries my role per workspace).
- **nav destinations** (Dashboard / All docs / Projects / Activity screens) — consumed by
  web-core:S-004 (AS-012/013) as routes the nav points at. Produced by `workspace-project-ui`
  (now built). ✔ destinations exist (GAP-002 resolved).
- **project name** — consumed by web-core:S-005 (AS-026) for the project-detail breadcrumb crumb,
  read from the workspace-project React Query cache (the project list / project-docs reads already
  loaded by the screens). Produced by `workspace-project`:S-003 (the projects list + project-docs
  rows carry the project name) + `workspace-project-browse`:S-001 (the per-project view loads it).
  ✔ read-from-cache, no new fetch; skeleton until the cache is warm (cold deep-link).
- **notifications count** (the bell) — consumed by web-core:S-005 (AS-018 utilities). No backend
  notifications-count producer exists yet. ✘ → GAP-003; the bell is a placeholder until a
  notifications slice ships.

## UI Notes

The GLOBAL app chrome + shared primitives only. Feature screens (ProjectBrowser, doc viewer,
share dialog, diff) live in the feature `-ui.md` specs and mount into this shell's outlet.
All `[N]` — greenfield, no frontend exists yet. Design source: `DESIGN.md` + the approved
mocks under `~/.gstack/projects/microvn-anchord/designs/design-system-20260607/` (auth screen).
Precedence: AS / Constraints > Tree.

- `AppShell` `[N]` — `ThemeProvider` *(dark canonical, AS-011)* · router · server-state + session providers
  - `SignInScreen` `[N]`: email · password · submit · *error message (AS-003)* · *(email+password only this slice; OAuth/magic-link deferred — GAP-001)*
  - `AuthGuard` `[N]` *(protected routes redirect when unauthenticated — AS-004)*
  - `AppSidebar` `[N]` *(left, recessed surface; collapses to an icon rail AS-015; off-canvas drawer on mobile AS-016)* — brand + chevron · `+ New doc` · *{`WorkspaceSwitcher` slot — owned by workspaces-ui, AS-012}* · `SidebarNav` *(Dashboard · All docs · Projects · Activity; active = teal bar AS-013)* · footer `MembersEntry` *(admin-only, AS-014)*
  - `AppHeader` `[N]` *(thin)* — `Breadcrumb` *(Workspace › Project › Doc, AS-017)* · *{context actions slot}* · `Search` · theme toggle · `NotificationsBell` *(placeholder — GAP-003)* · `UserMenu` *(avatar → settings, sign out — AS-018; folds utilities on mobile AS-019)*
  - shared primitives `[N]`: `EmptyState` *(AS-020)* · `NoResultsState` *(distinct — AS-021)* · `Skeleton` *(AS-022)* · `ErrorState` *(retry — AS-007/AS-023)* · `FormatBadge` *(HTML/Markdown/image)* · `AccessIndicator` *(restricted / workspace / link)*
  - *feature screens mount in the shell outlet (owned by feature `-ui` specs, not here)*

> Note: `AppSidebar` + `AppHeader` SUPERSEDE the earlier single `AppTopBar` (which carried a
> workspace-name slot + UserMenu). The switcher moves to the sidebar (C-005); the account moves to
> the header (C-005). The built `app-shell.tsx` `AppTopBar` is reworked into these two.

## What Already Exists

### System Impact & Technical Risks

- **No frontend exists** — `apps/web` is an empty workspace slot; web-core scaffolds it
  (Vite + Tailwind 4 + design tokens/fonts + the typed client + router + providers).
- Reuse, not rebuild: the backend `auth` surface (better-auth sign-in / sign-out / session)
  is consumed as-is through the typed client. The design system (`DESIGN.md`) and the
  researched FE conventions (React Router, server-state via the typed client, client state in
  a lightweight store, forms via schema-validated inputs) are the inputs.
- web-core is the FOUNDATION every other FE spec depends on (`web-core:S-NNN`); it must be
  built first. The shared primitives (`FormatBadge`, `AccessIndicator`, `EmptyState`,
  `ErrorState`) are reused by every feature screen — owning them here avoids per-screen
  duplication (the api-core rationale, applied to the FE).

## Not in Scope

- **All feature screens** — ProjectBrowser/browse/search → `workspace-project-ui`; doc viewer
  + Plannotator → `render-publish-ui` + `annotation-core-ui`; share dialog → `sharing-permissions-ui`;
  version diff → `versioning-diff-ui`; notification center → a later FE slice. web-core is chrome + auth + client only.
- Magic-link and GitHub OAuth sign-in buttons — email+password first (the backend supports all
  three; the others land in a follow-up). See GAP-001.
- First-run / workspace-setup wizard UI — the backend `/api/setup` exists; its UI is later.
- Light-theme polish — dark is canonical this slice; the tokens exist for full light theming later.
- Workspace switcher data + behavior — owned by `workspaces-ui:S-001`; web-core provides the
  sidebar SLOT and placement (AS-012), not the switcher implementation.
- Nav DESTINATION screens (Dashboard / All docs / Projects / Activity content) — owned by
  `workspace-project-ui`; web-core frames the nav + routes, not the destinations. See GAP-002.
- A real notifications center / unread count — a later FE slice; the header bell is a placeholder. See GAP-003.

## Gaps

- GAP-001 (status: open): which sign-in methods does web-core surface — email+password only,
  or also GitHub OAuth + magic-link (the backend supports all three)? This slice assumes
  email+password and defers the others. Source: user request "Eden + login" (method unspecified).
  *(Note: auth-ui has since built the OAuth buttons + verify/invite screens; revisit whether
  this gap is now resolved by auth-ui when web-core is next touched.)*
- GAP-002 (status: resolved): the sidebar nav destination screens (Dashboard / All docs / Projects /
  Activity) are now built by `workspace-project-ui` + `workspace-project-browse`. The breadcrumb
  (AS-026) also reads the project name from those screens' query cache. Resolved 2026-06-19.
- GAP-003 (status: open): the header notifications bell has no backend count endpoint yet — it
  renders as a placeholder (no badge / inert) until a notifications slice ships. Source: dispatch note "Notifications backend may not exist yet".

## Spec Sizing Notes

Stories=6 (target 7 — under). AS=28 (target 20 — in the G7 overage range ≤30).

G1 splits producing the excess AS (each AS = one atom; no AS gộp):
- S-004 sidebar: 5 AS for 5 atoms (frame/order, active-item marking, admin-only Members, collapse-to-rail, mobile drawer) — collapse (desktop rail) and the mobile drawer are distinct mechanisms at distinct breakpoints, not one responsive AS.
- S-005 breadcrumb: 6 AS for 6 atoms (root label, dashboard-only-root, list page crumb, project-name+skeleton, link-vs-active, account/settings branch) — each is a distinct breadcrumb behavior the product owner stated separately; merging would hide a case.
- S-006 states: 4 AS for 4 atoms (empty, no-results-distinct, loading-skeleton, error-retry) — empty vs no-results is an explicit product distinction (C-007), not a merge.

No bloat — each AS traces to one stated atom.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-09 | Initial creation (FE core: auth lifecycle + shared client + design-system shell) | -- |
| 2026-06-09 | Added S-004 (left sidebar nav frame), S-005 (header breadcrumb + account), S-006 (empty/loading/error states) + C-005/006/007, Linked Fields (switcher slot, role-gating, nav destinations, notifications), GAP-002/003. App shell = sidebar + header (supersedes AppTopBar); switcher in sidebar, account in header. Snapshot 2026-06-09.md (M1). | -- |
| 2026-06-19 | Minor — AS-017/C-008 wording aligned to the new switcher label rule (title-cased name; only the owner's auto-created default reads "My Default"); the default-owner example is unchanged. Rule owned by workspaces-ui:AS-001. | -- |
| 2026-06-19 | Reworked the breadcrumb (S-005): AS-017 now specifies the admin-qualified capitalized root label; added AS-024 (dashboard shows root only), AS-025 (list page crumb All Docs/Projects), AS-026 (project real name from cache + skeleton, no raw id), AS-027 (parent crumbs link, last is active), AS-028 (Account › Settings static-root branch); +C-008. Supersedes the old "names not loadable → fall back to id" limitation. GAP-002 resolved (destinations + name cache now exist). Linked Field for project-name (read-from-cache). Major (M1+M4); snapshot 2026-06-19-breadcrumb.md. | -- |
| 2026-06-21 | Major (M5) — AS-004 Then reworked: the protected-route bounce now PRESERVES the attempted deep link (path + query) as a return target on /signin, so a signed-out visitor returns to it after login instead of losing it (motivating case: a workspace invite link). Internal-path-only, reusing doc-access-routing:C-015's open-redirect guard. Snapshot 2026-06-21.md. | /mf-fix Bug A |
