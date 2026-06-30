# Spec: Viewer Overflow Menu

**Created:** 2026-06-30
**Last updated:** 2026-06-30
**Status:** Draft

## Overview

The doc viewer top bar (public routes `/d/:slug` and the capability route `/s/:token`) has a
three-dot (⋯) "more actions" button that currently does nothing — it fires a placeholder toast.
This feature turns it into a real popover menu suited to Anchord: an Appearance control (theme),
quick document actions (version history, copy link, print, download annotations), and a static
footer. It draws on Plannotator's overflow popover but drops the parts that don't fit Anchord
(per-app settings, review import, an update-check nag) and keeps everything self-hosted and
phone-home-free. The menu is a member-only affordance — it stays hidden for signed-out visitors and
no-account guests, exactly as the current button does.

## Data Model

No new persistent entities. One client-side preference changes shape:

- **Theme preference** (device-local, already persisted under the `anchord-theme` key). Today it is
  one of `light | dark`. This feature widens it to `light | dark | system`, where `system` means
  "follow the OS `prefers-color-scheme`". The RESOLVED theme stamped on the document stays concrete
  (`light | dark`); `system` resolves to the OS value and re-resolves when the OS flips. The default
  on a fresh device stays `dark` (canonical), NOT `system`.
- **Annotation export** is derived at click time from the rail's already-loaded annotation threads
  (`ViewerAnnotation[]` — type, anchor quote, comments, status, suggestion). No new storage, no
  backend read.

## Stories

### S-001: Overflow button opens the menu (P0)

**Description:** As a signed-in member viewing a doc, I click the ⋯ button in the top bar and a
popover menu opens with the available actions grouped, so the button is no longer a dead control.
**Source:** User request — "button three dot chưa làm gì, tôi muốn cải tiến nó… cho tôi 1 popover
phù hợp với Anchord". Existing dead handler: `viewer-screen.tsx` `onOverflow={() => toast(...)}`.
**Applies Constraints:** C-001, C-002

**Execution:**
- `depends_on:` none
- `parallel_safe:` false
- `files:` apps/web/src/features/viewer/components/viewer-overflow-menu.tsx (new), apps/web/src/features/viewer/components/viewer-top-bar.tsx, apps/web/src/features/viewer/components/viewer-screen.tsx, apps/web/src/components/ui/popover.tsx (reuse), apps/web/src/features/viewer/components/viewer-overflow-menu.test.tsx (new)
- `autonomous:` true
- `verify:` cd apps/web && bun test viewer-overflow-menu

**Acceptance Scenarios:**

AS-001: Menu opens for a signed-in member
- **Given:** a signed-in member has a doc open in the viewer
- **When:** they activate the ⋯ button in the top bar
- **Then:** a popover opens showing the grouped actions (Appearance, document actions) and a footer
- **Data:** member session; any published doc
- **Setup:** viewer mounted with a non-anonymous session

AS-002: Button stays hidden for visitors without an account
- **Given:** an anonymous visitor (signed-out, or a no-account guest) has the doc open
- **When:** the top bar renders
- **Then:** the ⋯ button is absent, so the menu cannot be opened (preserves the existing contract)
- **Data:** anonymous viewer
- **Setup:** viewer mounted with `anonymous` true

AS-003: Menu dismisses without choosing an action
- **Given:** the menu is open
- **When:** the visitor presses Escape or clicks outside the popover
- **Then:** the popover closes and no action was triggered
- **Data:** menu open state

AS-004: Footer is a static, phone-home-free link
- **Given:** the menu is open
- **When:** the footer renders
- **Then:** it shows the Anchord name and a single user-initiated link to the project's release
  notes / source (`https://github.com/microvn/anchord`); opening the menu performs no network
  request, version check, or update probe
- **Data:** menu open state

### S-002: Appearance control with System (P0)

**Description:** As a member, I pick the chrome theme — Light, Dark, or System — from the menu's
Appearance control, and the standalone sun/moon toggle is removed from the top bar so theme lives in
one place.
**Source:** Locked decision (1) "thêm System (theo prefers-color-scheme)" + (3) "Gỡ nút sun/moon,
dồn vào popover". Current `theme-provider.tsx` supports only `light | dark`.
**Applies Constraints:** C-003

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/web/src/app/theme-provider.tsx, apps/web/src/features/viewer/components/viewer-overflow-menu.tsx, apps/web/src/features/viewer/components/viewer-top-bar.tsx, apps/web/src/components/icon.tsx (monitor glyph), apps/web/src/app/theme-provider.test or test/design-system-shell.test.tsx
- `autonomous:` true
- `verify:` cd apps/web && bun test theme

**Acceptance Scenarios:**

AS-005: Picking Light switches and persists the theme
- **Given:** the chrome is in dark and the menu is open
- **When:** the member chooses Light in the Appearance control
- **Then:** the chrome switches to light, Light is shown as the selected option, and the choice
  persists on the device across a reload
- **Data:** preference starts dark; pick light
- **Setup:** no saved preference initially (dark canonical), then choose light

AS-006: System follows the operating system
- **Given:** the menu is open
- **When:** the member chooses System
- **Then:** the resolved chrome theme matches the OS `prefers-color-scheme`, and when the OS
  preference flips while the doc stays open the chrome follows without re-opening the menu
- **Data:** OS prefers dark → chrome dark; OS flips to light → chrome light
- **Setup:** mockable `matchMedia("(prefers-color-scheme: dark)")`

AS-007: The standalone theme toggle is gone from the viewer top bar
- **Given:** a member has the viewer open
- **When:** the top bar renders
- **Then:** the separate sun/moon theme-toggle button is no longer present; theme is changed only
  through the Appearance control in the menu
- **Data:** member session

AS-008: A fresh device with no saved preference is dark, not System
- **Given:** a device with no saved theme preference
- **When:** the viewer first loads
- **Then:** the resolved theme is dark (canonical), and the Appearance control reflects Dark as
  active — System is never auto-selected
- **Data:** empty storage

### S-003: Document quick actions (P1)

**Description:** As a member, I use the menu to open version history, copy the link to this doc, and
print / save the doc as PDF — including on mobile, where the top bar's `v{n}` button is hidden.
**Source:** Locked menu groups — "This document: Version history (the only mobile path to history),
Copy link, Print / Save as PDF".
**Applies Constraints:** C-002

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/web/src/features/viewer/components/viewer-overflow-menu.tsx, apps/web/src/features/viewer/components/viewer-screen.tsx, apps/web/src/components/icon.tsx (printer glyph)
- `autonomous:` true

**Acceptance Scenarios:**

AS-009: Version history opens from the menu
- **Given:** the menu is open (on a narrow viewport the top bar `v{n}` button is hidden)
- **When:** the member chooses Version history
- **Then:** the version history panel opens — the same panel the `v{n}` button opens — giving mobile
  the only entry point to history

AS-010: Copy link copies the current viewer URL
- **Given:** the menu is open at the current route (`/d/:slug` or `/s/:token`)
- **When:** the member chooses Copy link
- **Then:** the current viewer URL is written to the clipboard and a confirmation is shown; on a
  capability route the copied URL is the token URL (the readable slug is never exposed)

AS-011: Print / Save as PDF invokes the browser print dialog and prints only the document content
- **Given:** the menu is open
- **When:** the member chooses Print / Save as PDF
- **Then:** the browser's print dialog is invoked (from which the OS offers "Save as PDF"), and the
  print output shows ONLY the document content — the chrome (top bar, meta strip, outline, comments
  rail, the menu itself) is hidden and a long doc flows across pages instead of being clipped to the
  on-screen scroll box. (Markdown prints fully; html/image render in a sandboxed iframe and print
  best-effort — verified visually, the print stylesheet is `[→MANUAL]`.)

### S-004: Download annotations as Markdown (P1)

**Description:** As a member, I download all of the doc's annotations as a Markdown file straight
from the menu, so the feedback is mine to keep — built entirely from data already in the browser,
with no backend export endpoint.
**Source:** Locked menu item "Download annotations — client-side serialize the rail's annotation
threads to a Markdown file, no backend endpoint" + own-your-data positioning.
**Applies Constraints:** C-004

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/web/src/features/viewer/lib/export-annotations.ts (new), apps/web/src/features/viewer/lib/export-annotations.test.ts (new), apps/web/src/features/viewer/components/viewer-overflow-menu.tsx, apps/web/src/components/icon.tsx (download glyph)
- `autonomous:` true
- `verify:` cd apps/web && bun test export-annotations

**Acceptance Scenarios:**

AS-012: Download produces a Markdown file of all threads
- **Given:** a doc with several annotations (each a type + an anchored quote + a comment thread)
- **When:** the member chooses Download annotations
- **Then:** a Markdown file downloads containing, per annotation, its type/status, the anchored
  quote, and each comment's author + time + body, with a header naming the doc and version; the file
  name is derived from the doc title
- **Data:** 3 annotations: a comment, a resolved comment, a redline (delete suggestion)
- **Setup:** rail annotations already loaded in the viewer

AS-013: Download on a doc with no annotations
- **Given:** a doc with zero annotations
- **When:** the member chooses Download annotations
- **Then:** a Markdown file still downloads, stating there are no annotations yet, and nothing throws
- **Data:** empty annotation list

AS-014: Comment bodies are preserved verbatim
- **Given:** annotations whose comment bodies contain newlines and Markdown special characters
- **When:** the export is generated
- **Then:** those bodies appear in the output without being dropped or truncated (multi-line bodies
  stay under their bullet)
- **Data:** a comment body with `\n`, `#`, `*`, backticks

### S-005: Download the document by kind (P1)

**Description:** As a member with at least viewer access, I download the document's own source file
from the menu — Markdown → `.md`, HTML → `.html`, image → the original image file — so I keep the
artifact itself, not just its annotations. Distinct from S-004 (which exports the feedback threads).
**Source:** Review feedback 2026-06-30 — "k có download file à?? nếu là md thì down md, nếu là html
down html, tương tự với ảnh". Un-defers the previously-deferred "Export document source" once a
faithful backend raw-content surface exists.
**Applies Constraints:** C-006, C-007

**Execution:**
- `depends_on:` S-001
- `parallel_safe:` false
- `files:` apps/backend/src/app.ts (or routes/) — new access-gated raw-download surface; apps/backend/src/render/viewer-loaders.ts (reuse the view gate); apps/web/src/features/viewer/components/viewer-overflow-menu.tsx (new "Download document" item); apps/web/src/features/viewer/services/client.ts; backend itest for the download route
- `autonomous:` true
- `verify:` cd apps/backend && bun test download

**Acceptance Scenarios:**

AS-015: A markdown doc downloads as raw Markdown
- **Given:** a member with at least viewer access to a markdown doc
- **When:** they choose Download document
- **Then:** the original Markdown source downloads as a `.md` file (NOT the rendered HTML), named
  from the doc title
- **Data:** a markdown doc whose source contains headings + lists

AS-016: An HTML doc downloads as its source HTML, an image as the original image file
- **Given:** a member with viewer access to an HTML doc (and, separately, an image doc)
- **When:** they choose Download document
- **Then:** the HTML doc downloads as a `.html` file carrying the stored source (without the viewer's
  block-id / bridge injection); the image doc downloads as the original image file with its real
  content type and extension
- **Data:** one html doc, one image doc

AS-017: Download is refused without at least viewer access
- **Given:** a visitor who cannot view the doc under EITHER access axis (no workspace/generic role
  AND no link/people grant)
- **When:** they request the document download
- **Then:** the request is refused exactly as the viewer read is (existence-hiding 404) — no bytes
  are served; a viewer/commenter/editor/owner under either axis succeeds
- **Data:** a restricted doc + a non-member, no-grant requester

## Constraints & Invariants

C-001: The overflow menu and its ⋯ trigger are session-only — hidden for any visitor without an
account (signed-out or no-account guest). (AS-002)
C-002: No phone-home — opening or using the menu performs no telemetry, update check, or external
network request; the only outbound link is the user-initiated footer link to the project source
(CLAUDE.md "no telemetry, no phone-home, ever"). (AS-004, AS-010, AS-011)
C-003: The theme preference (`light | dark | system`) persists on the device; the resolved theme
stamped on the document is always concrete `light | dark`; `system` follows the OS and re-resolves
when the OS preference changes; a fresh device with no saved preference resolves to dark. (AS-005,
AS-006, AS-008)
C-004: Download annotations is built entirely from the rail's already-loaded annotation data — it
issues no backend request. (AS-012, AS-013)
C-005: The menu follows DESIGN.md — chrome recedes (low-contrast popover on `elev`), the single teal
accent, never purple, responsive at 360/768/1024/1440. (Design constraint — verified visually,
[→MANUAL])
C-006: Download document serves the faithful raw source by kind — Markdown text, the stored HTML
source (without the viewer's block-id/bridge injection), or the original image bytes — with the
correct content type and a title-derived filename. (AS-015, AS-016)
C-007: The document download is access-gated identically to the doc read — at least viewer access
under EITHER axis (workspace/generic role OR link/people grant); a requester who cannot view the doc
gets the same existence-hiding refusal as the read, never the bytes. (AS-017)

## Behavior Matrix

| State | Viewer | Surface | Expected behavior | Source / timing | Cascade / parity obligations | Coverage |
|---|---|---|---|---|---|---|
| viewer open | signed-in member | top bar ⋯ trigger | button shown; activating it opens the menu | rendered on load | none | AS-001 |
| viewer open | anonymous / no-account guest | top bar ⋯ trigger | button absent; menu unreachable | rendered on load | none | AS-002 |
| theme = system | member | app chrome | resolved theme follows the OS preference and updates live when the OS flips | realtime via OS media query | none | AS-006 |
| theme = light/dark pick | member | app chrome | resolved theme = the pick; persists across reload | persisted on device + applied on load | none | AS-005, AS-008 |

## What Already Exists

### UI Inventory

| Component | Path | Reuse plan |
|---|---|---|
| `Popover` / `PopoverTrigger` / `PopoverContent` | `apps/web/src/components/ui/popover.tsx` | reuse as-is (radix wrapper, `bg-elev`, `shadow-pop`) as the menu container |
| `Icon` | `apps/web/src/components/icon.tsx` | reuse; ADD three glyphs — `monitor` (System), `printer` (Print), `download` (Download annotations) |
| `ViewerTopBar` | `apps/web/src/features/viewer/components/viewer-top-bar.tsx` | modify — replace the bare ⋯ button with the menu trigger; REMOVE the standalone `vt-theme-toggle` (sun/moon) button (AS-007) |
| Version history panel | opened today by `vt-version` (`v{n}`) via `onVersion` in `viewer-screen.tsx` | reuse — the menu's Version history item calls the same `onVersion` (AS-009) |

### System Impact & Technical Risks

- `theme-provider.tsx` exports `resolveTheme`, `applyTheme`, `readSavedTheme`, `DEFAULT_THEME`,
  and a `useTheme()` returning `{ theme, toggleTheme, setTheme }`. These are depended on by
  `test/design-system-shell.test.tsx`, `test/smoke.test.tsx`, `app/app-header.tsx`, and
  `features/settings/components/appearance-section.tsx`. Widening to `system` MUST stay backward
  compatible: keep `resolveTheme(saved)` returning a concrete `light | dark` for the existing
  light/dark/invalid cases (its single-arg callers and tests are unchanged); `useTheme()` keeps
  `theme` (resolved) and gains the preference + a `setTheme` that accepts `system`. The header
  toggle (`app-header.tsx`) and the settings Appearance section are NOT part of this feature and keep
  their current behavior (settings stays a 2-option Light/Dark picker; `account-settings` deferred
  System — this feature adds System to the provider for the viewer menu only, it does not add a
  System swatch to settings).
- `viewer-top-bar.test.tsx` asserts `vt-overflow` is null for an anonymous viewer (AS-002) — keep
  that test green. It does not assert the standalone theme toggle, so removing it (AS-007) is safe.
- Annotation data for the export is the rail list (`ViewerAnnotation[]` from
  `features/viewer/services/client.ts`), already loaded by the viewer; the serializer is a pure,
  DOM-free helper so it is unit-testable, and the component turns its string into a Blob download.
- Date formatting in the export uses `date-fns` (project convention), never hand-rolled Date math.

## Not in Scope

- **"For your agent" group (Copy MCP pull command).** Deferred per locked decision (3). The MCP
  round-trip is the differentiator but is parked for a later slice; the menu leaves room for it.
- ~~Export document source (raw .md / .html / image).~~ **Un-deferred 2026-06-30 → now S-005.**
  Review feedback asked for it; it is built via a dedicated access-gated backend raw-content surface.
- **Settings / per-viewer preferences item.** Plannotator-style "Settings" has no per-viewer content
  in Anchord; management settings live in the app shell, not the viewer focus mode.
- **Import Review.** Plannotator-specific; Anchord's inbound path is MCP, not a review-file import.
- **Update-available nag / "Copy update command".** Violates the no-phone-home constraint (C-002).
- **A System swatch in the account-settings Appearance section.** This feature adds System only to
  the viewer menu; the settings page keeps its 2-option picker (separate spec, `account-settings`).
- **Guest/anonymous access to the menu.** The trigger stays member-only (C-001); a guest "copy link"
  affordance is a separate future consideration.

## Change Log

| Date | Change | Ref |
|------|--------|-----|
| 2026-06-30 | Initial creation | -- |
| 2026-06-30 | Refined AS-011 (print content-only); added S-005 Download document by kind (AS-015/016/017, C-006/C-007); un-deferred Export source. Snapshot 2026-06-30.md | review feedback |
