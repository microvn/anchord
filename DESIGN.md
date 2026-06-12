# Design System — anchord

> Source of truth for fonts, color, spacing, aesthetic. Read this file BEFORE any UI
> decision. Do not deviate without explicit approval.

## Product Context
- **What this is:** self-hosted platform to share + annotate AI-generated docs (HTML/MD/images). "Vaultwarden for AI-generated docs".
- **Who it's for:** devs/teams who self-host and use it on their own specs/plans/reports.
- **Space/peers:** uselink.app (SaaS, light-marketing), Plannotator (dark, purple-gradient), Linear (refined dark benchmark).
- **Project type:** hybrid web app — doc viewer + annotation (read-heavy) and management (project browser, version/diff, share, auth, members).
- **Stack:** React 19 + Vite + Tailwind 4. Reuses Plannotator's OSS editor.

## Memorable Thing (guiding star)
**"Serious, trustworthy, mine."** Every design decision serves the feeling of serious
technical software, self-hosted, with the data in your own hands. Trust > polish.

## Aesthetic Direction
- **Direction:** Refined Utilitarian — "operator-grade", dark-first.
- **Decoration:** minimal — type + space + one accent. NO gradients, blobs, or 3-col icon grids.
- **Mood:** calm, confident, technical; the feel of "infrastructure I own", not a SaaS with a marketing funnel.
- **Core principle — chrome recedes behind content:** chrome (topbar, sidebar, rail) is low-contrast; **the doc + comments are the highest-contrast elements**. The design does NOT compete visually with the doc.
- **Doc content is NOT styled by this system:** the user's doc renders in a sandbox iframe and keeps its own style. The design system applies only to the app *chrome*.
- **Deliberate departures:** (1) a **deep teal** accent (not Plannotator-purple, not Claude-orange #d97757); (2) **Fraunces serif** for headings/titles on a technical tool = trustworthy gravitas, distinct from the all-grotesk crowd.
- **Approved artifacts:** `~/.gstack/projects/microvn-anchord/designs/design-system-20260607/` (variant-b-full = canonical viewer; anchord-screens = browser/share/diff/auth).

## Typography
- **Display / doc title / headings:** **Fraunces** (serif, weight 500) — titles + headings only, never body/UI.
- **Body / UI:** **Geist** (400/500/600), enable `tabular-nums` for versions/figures.
- **Code / diff / version label / data:** **Geist Mono** (fallback JetBrains Mono).
- **Loading:** Bunny Fonts (privacy-friendly) — `fraunces`, `geist`, `geist-mono`. Self-host for the single-binary v1.
- **Scale (px):** display 27–46 · h2 20–22 · h3 15 · body 14 · small 12.5 · mono-label 11. Slight negative letter-spacing on headings (-.01 → -.02em).

## Color
Dark is the **canonical** theme (operator); light is **first-class** (equal footing). The chrome theme is independent of doc content.

**Dark (primary):**
- bg: paper `#0c1012` · surface `#11171a` · elev `#161d21` / `#1b2327` · sunken `#0a0e10`
- text: ink `#e7edee` · muted `#939fa3` · subtle `#677074` · faint `#444e52`
- line: `#222a2e` · soft `#1a2024`
- **accent teal:** `#37b3bd` · strong `#56cdd6` · soft `#0e2e30` · ink `#7fdce1`

**Light (secondary):**
- bg: paper `#fbfbfa` · surface `#ffffff` · elev `#f5f6f6` · sunken `#eef0f0`
- text: ink `#14181a` · muted `#5b6568` · subtle `#8a9296`
- line: `#e3e6e6` · soft `#eceeee`
- **accent teal:** `#0b6b73` · strong `#085259` · soft `#e3f0f0` · ink `#0a4a50`

**Semantic (same role in both modes):**
- detached / orphaned annotation → **amber** (dark `#d6a23e` / bg `#26200f`; light `#9a6700` / bg `#fdf3da`)
- error / expired link → **red** (`#f1655d` / `#b3251f`)
- resolved → **green** (`#43b873` / `#1c7a4a`)
- suggestion / active highlight → **teal-soft** bg + teal underline
- priority badge: P0 = red, P1 = amber, P2 = subtle gray
- **Teal is the ONLY accent.** No second accent. No purple/violet gradient.

## Spacing
- **Base:** 4px. Scale: 2(2) xs(4) sm(8) md(12-16) lg(24) xl(32) 2xl(48).
- **Density:** compact-comfortable — dense in lists (versions, members, doc grid, TOC), airy in the reading area + comment threads.

## Layout
- **Doc viewer (the core screen) = 3 panes:** TOC sidebar left (~236px, collapsible, search + outline + P-badge + scroll-spy) · doc center (reading max ~760px) · annotations rail right (~300px, threads + detached + composer).
- **Topbar:** thin, low-contrast — title + status (LIVE/format) + version + Preview|Edit + Comments + Share(teal) + theme + ⋯. Below it, a meta-strip for spec docs (stories/AS/Draft).
- **Selection popover:** floats over the highlighted range — comment / suggest / resolve / react / ✕ (Plannotator-style).
- **Other app chrome (browser/share/auth):** disciplined grid, modal for the share dialog.
- **Border radius:** sm 5–6px · md 7–9px · lg 9–12px · pill 999px. No uniform bubble-radius.

### App shell (browse / workspace / project / members) — left sidebar + header
This is the *management context* (browse projects/docs, members, settings) — **distinct** from the
doc-viewer focus mode. Entering the viewer **replaces** this shell with the 3-pane layout (the app
sidebar hides); never nest the app navbar inside the viewer. Chrome recedes: the sidebar sits on a
lower surface than content, text is low-contrast, only the active item lights up. Structural reference:
uselink (brand + new-doc + switcher + nav in the sidebar; title left, account right in the header).

- **Left sidebar (~248px, `sunken`/`surface` bg — below content), top to bottom:**
  1. **Brand** + a collapse chevron (`‹`) to toggle the icon rail.
  2. **Primary action — `+ New doc`** (full-width, solid): the main create affordance, top of the rail.
  3. **Workspace switcher** (right below New doc): workspace glyph + current name + `⇅`. Opens a menu
     listing the workspaces I belong to (admin-qualified so two "default"s are distinct), a ✓ on the
     active one, and `+ New workspace`. This is the **single workspace anchor** — never duplicated in
     the header.
  4. **Primary nav:** Dashboard · All docs · Projects · Activity. Item = icon + label, sparse hairlines,
     hover `elev`; **active = `accent-soft` bg + `accent-ink` text + a 2px teal bar on the left edge**.
     The PROJECTS group can expand inline under Projects (the workspace's projects + `+ New`); this is
     the doc-grouping tier, not a single doc's TOC.
  5. **Footer (bottom):** `⚙ Members / Settings` (admin sees Members; a member's is hidden/disabled per
     workspaces-ui C-002). The account + sign-out are NOT here — they live in the header (below).
- **Header (thin, same height as the viewer topbar, `surface` bg, `line` hairline at the bottom):**
  - Left: **breadcrumb / page title** — `Workspace › Project › Doc` (last crumb `ink`, parents `muted`,
    separator `faint`), or a screen title (e.g. "All docs").
  - Right (account + utilities + context): **context actions** (e.g. a teal `Share` on a doc screen) ·
    **search** (⌕, `/` to focus) · **theme toggle** (◐) · **notifications** (bell + unread count) ·
    **user avatar menu** (▾ → profile, settings, **sign-out**). The avatar anchors the right edge.
- **Collapse:** ≥1200 the sidebar is open; the chevron collapses it to an **icon rail (~56px)** (glyph +
  tooltip only). The switcher collapses to the workspace glyph; `+ New doc` to a `+` button.
- **No double-nav:** one chrome context at a time — the app shell *or* the viewer's 3-pane, never both.

## Responsive (mandatory — every screen)
Mobile-aware, not desktop-only. Breakpoints (Tailwind-style):
- **≥1200 (desktop):** doc viewer full 3-pane (TOC | doc | rail); app sidebar open.
- **900–1199 (laptop):** TOC collapsible (toggle ▤ in the topbar, can default hidden); rail stays or narrows. App sidebar can collapse to the icon rail.
- **600–899 (tablet):** TOC + rail become an **off-canvas drawer/sheet** (open via a button); doc full width. Topbar condenses: Share/Comments become icons, some folded into ⋯. **App sidebar → off-canvas drawer** (hamburger in the header); breadcrumb truncates to the last 1–2 crumbs.
- **<600 (mobile):** single column. Doc full width; **comment rail becomes a bottom-sheet** opened by a count badge (💬 3); tapping a highlight opens that thread. Selection popover sticks to touch (long-press to select), buttons ≥40px. Topbar = title + ⋯. App sidebar = drawer; the **switcher sits at the drawer top**. In the header right, search collapses to an icon and theme/notifications/sign-out fold into the **avatar menu**; the avatar stays visible.

Per-screen:
- **Project browser:** doc grid 3-col → 2 (≤900) → 1 (≤600); sidebar projects → drawer on mobile.
- **Members screen:** member rows full-width on mobile; role dropdown + remove stay ≥40px tap targets.
- **Share dialog:** centered modal → **full-screen sheet** at <600.
- **Version diff:** rendered side-by-side (v2 | v3) → **stacked** (v2 over v3) at ≤760; source line-diff always horizontally scrollable.
- **Auth / first-run:** 2 panes → stacked at ≤760.

Rule: doc content in the iframe is self-responsive (the user's content); chrome does not force layout onto it. Tap targets ≥40px. Test at 360 / 768 / 1024 / 1440.

## Empty, loading & error states
The "blank page" family — what a screen shows before or without content. Follows the locked
aesthetic: type-only, low-key, NO illustration blobs / emoji-art, one primary action. Never a giant
centered hero — a contained block inside the content pane.

- **Structure:** a small contained block, vertically centered within the content pane (not the whole
  viewport). One title line (h3 or body-strong, `ink`), one `muted` help line, then ONE primary action
  (teal button, ≥40px) + an optional ghost secondary. An icon is optional; if used, a single small
  `subtle` glyph — never a colored circle.
- **Empty (no data yet) vs no-results (a query matched nothing) are different states:** empty = an
  onboarding nudge + a create action; no-results = "No matches for '…'" + a Clear-search action. Do NOT
  show a create CTA on a no-results state.

Real cases:
- **Fresh workspace, no projects:** "No projects yet" + "Create your first project" (primary).
- **Project with no docs:** "This project is empty" + "Publish a doc" (docs arrive via publish/MCP).
- **All docs empty (workspace scope):** same shape as above.
- **Search no-results:** "No docs match '<query>'" + Clear search.
- **Members — solo workspace:** admin → "It's just you" + "Invite teammates"; member → a read-only note, no invite control.
- **Pending invite (not yet a member):** owned by the accept/reject landing, not an empty state.
- **Doc viewer, no annotations:** owned by the annotations rail (its own copy: "No comments yet — select text to start"), not the app shell.
- **Notifications empty:** "You're all caught up."

- **Loading (skeleton, not spinner):** grey `elev` skeleton rows matching the list shape (doc card, member
  row, project item) — chrome stays calm, no centered full-page spinner. Loads under ~300ms show nothing (avoid flash).
- **Error (fetch failed):** `ErrorState` — a short title + the cause in `muted` + a Retry button; `error`
  red only on the icon/accent, never a full red panel. Distinct from empty (something broke vs nothing there).

## Motion
- **Approach:** minimal-functional — only transitions that aid comprehension (open/close rail, scroll-to mark, resolve fade). No bouncing.
- **Easing:** enter ease-out · exit ease-in. **Duration:** micro 80ms · short 150–200ms · medium 250ms.

## Anti-slop (forbidden in code and mocks)
purple/violet gradient · 3-col icon grid · centered-everything · gradient CTA · uniform bubble-radius · Inter/Roboto/Space Grotesk as primary · system-ui display · Claude-orange accent #d97757.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-07 | Created the design system (dark-operator, teal, Geist+Fraunces+Geist Mono) | /design-consultation; researched uselink/Plannotator/Linear; memorable = "serious, trustworthy, mine"; user picked variant B (dark operator), full mocks for 5 screens. |
| 2026-06-07 | Added the Responsive section (breakpoints + per-screen mobile behavior) | User mandated responsive; 3-pane → drawer/bottom-sheet on tablet/mobile. |
| 2026-06-09 | Added the App shell spec (left sidebar + header) and the Empty/loading/error states section; translated the file to English | /design-consultation; user added management chrome for workspace/project UI. Sidebar = brand + `New doc` + workspace switcher + nav (uselink-referenced); the app shell is distinct from the doc-viewer focus mode. |
| 2026-06-09 | Header right holds the account, not the sidebar | User: avatar/account + context + theme + search + notifications all live in the header right (uselink reference); the sidebar keeps the workspace switcher (the single workspace anchor) + nav. Sign-out moved into the header avatar menu. |
