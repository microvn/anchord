import { Icon, Brandmark } from "@/components/icon";
import { useTheme } from "@/app/theme-provider";
import type { ViewerDocKind } from "@/features/viewer/services/client";
import { GuestIdentityChip } from "./guest-identity-chip";

// ViewerTopBar (S-005, AS-012): the bar ABOVE the 3-pane viewer body. Mirrors the prototype's
// `.vtop` (viewer-shell.jsx ViewerTopBar) structurally, in Tailwind/DESIGN.md tokens:
//   brand · outline-toggle (drawer mode) · back · title · LiveBadge · FormatBadge · VersionButton ·
//   CommentsToggle · ShareButton · ThemeToggle · OverflowMenu.
//   (Brand sits at the OUTERMOST left — moved ahead of outline-toggle/back per request 2026-06-20,
//   a deliberate deviation from the prototype, which placed brand after back.)
//
// The identity fields (title / live / format / version) come from the doc meta the viewer already
// fetches (S-001 GET …/docs/:slug → { title, kind→format, version, status }).
//   - LiveBadge: shown when the doc is SHARED (generalAccess beyond `restricted`) — same rule as the
//     dashboard list (projects.ts). "Live" = shared, NOT "has a published version" — a restricted doc
//     is Draft even though it is served as published.
//   - FormatBadge: derived from `kind` (markdown→MD, html→HTML, image→IMG).
//   - VersionButton: shows `v<n>`; onClick opens version history — that panel lives in
//     `versioning-diff-ui` (NOT built here), so the caller wires it to a no-op / toast placeholder.
//   - ShareButton: opens the share dialog — `sharing-permissions-ui` (NOT built here), placeholder.
//   - CommentsToggle: shows/hides the AnnotationsRail. The `railVisible` state is LIFTED into the
//     viewer screen; this button reflects it (aria-pressed) and flips it via onToggleRail.
//   - ThemeToggle: reuses the app theme provider's `useTheme()` (safe outside a provider).

interface TopBarDoc {
  title: string;
  kind: ViewerDocKind;
  version: number;
  status: string;
  /** Doc general access (restricted | anyone_with_link | anyone_in_workspace). Drives the Live badge:
   *  "Live" = shared beyond restricted, matching the dashboard list (projects.ts). NOT the publish state. */
  generalAccess?: string;
}

// kind → the short format-badge label (prototype FORMAT_META: md→MD, html→HTML, img→IMG).
const FORMAT_LABEL: Record<ViewerDocKind, string> = {
  markdown: "MD",
  html: "HTML",
  image: "IMG",
};

const ICON_BTN =
  "inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-muted transition-colors hover:bg-elev hover:text-ink";

export function ViewerTopBar({
  doc,
  railVisible,
  onToggleRail,
  onVersion,
  onShare,
  showShare = true,
  onBack,
  onToggleToc,
  showTocToggle = false,
  onOverflow,
  anonymous = false,
  onSignIn,
  guestIdentity,
}: {
  doc: TopBarDoc;
  /** is the comments rail currently shown (desktop). The toggle reflects + flips this. */
  railVisible: boolean;
  onToggleRail: () => void;
  /** opens version history (versioning-diff-ui, not built) — caller passes a placeholder. */
  onVersion: () => void;
  /** opens the share dialog. */
  onShare: () => void;
  /** S-001/C-002: show the Share button only for a potential manager (owner/editor). A
   *  viewer/commenter — or an absent role — gets no Share affordance (AS-003). */
  showShare?: boolean;
  /** back to workspace — shown only when present (hidden on a public link). */
  onBack?: () => void;
  /** opens the TOC drawer (drawer mode only). */
  onToggleToc?: () => void;
  showTocToggle?: boolean;
  /** overflow menu — caller passes a placeholder. */
  onOverflow?: () => void;
  /** doc-access-routing S-003 (AS-029): an anonymous (signed-out) visitor. The bar shows the doc
   *  title + a Sign in CTA and HIDES every affordance that requires a session — the Share button
   *  and the account/overflow menu. Reading + (when enabled) guest commenting still work. */
  anonymous?: boolean;
  /** AS-029: invoked when the anonymous Sign in CTA is pressed (caller routes to /signin with a
   *  return-to-doc target so sign-in returns the visitor here — AS-016). */
  onSignIn?: () => void;
  /** S-007 (AS-016): a guest's session identity — the persistent chip (session name + Rename) shown
   *  NEXT TO the Sign in CTA. Present only for a guest (anon + can-comment); absent → no chip. */
  guestIdentity?: { name: string; onRename: () => void };
}) {
  const { theme, toggleTheme } = useTheme();
  // "Live" = the doc is shared beyond restricted — the SAME rule the dashboard list uses
  // (projects.ts: generalAccess === "restricted" ? "draft" : "live"). It is NOT the publish state:
  // the backend serves every versioned doc as status:"published", so keying off status lit the badge
  // for unshared docs (the dashboard showed Draft, the detail showed Live).
  const isLive = doc.generalAccess != null && doc.generalAccess !== "restricted";
  // AS-029: an anon never sees session-only chrome. The Share button is gated by the caller's
  // showShare, but we also hard-gate it (and the overflow/account menu) here so a stray showShare
  // can't leak member chrome to an anon.
  const showShareAffordance = showShare && !anonymous;

  return (
    <header
      data-testid="viewer-top-bar"
      className="flex h-12 flex-none items-center gap-2 border-b border-line bg-paper px-3"
    >
      {/* Brandmark pinned to the OUTERMOST left (ahead of the outline-toggle + back nav), so the
          Anchord mark is the first thing on the bar. (Deviates from the prototype `.vtop` order,
          which placed brand after back — intentional per request 2026-06-20.) */}
      <span className="flex flex-none items-center" aria-hidden="true">
        <Brandmark size={18} />
      </span>

      {showTocToggle && onToggleToc && (
        <button type="button" aria-label="Outline" className={ICON_BTN} onClick={onToggleToc}>
          <Icon name="list" size={18} />
        </button>
      )}

      {onBack && (
        <button
          type="button"
          aria-label="Back"
          title="Back to workspace"
          className={ICON_BTN}
          onClick={onBack}
        >
          <Icon name="chevLeft" size={18} />
        </button>
      )}

      <span className="h-4 w-px bg-line" aria-hidden="true" />

      <span data-testid="vt-title" className="truncate text-[13.5px] font-semibold text-ink">
        {doc.title}
      </span>

      {isLive && (
        <span
          data-testid="vt-live-badge"
          className="inline-flex flex-none items-center gap-[5px] font-mono text-[11px] uppercase tracking-[0.06em] text-[var(--green)]"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--green)]" aria-hidden="true" />
          Live
        </span>
      )}

      <span
        data-testid="vt-format-badge"
        className="flex-none rounded-[4px] bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] font-medium tracking-[0.06em] text-accent-ink"
      >
        {FORMAT_LABEL[doc.kind]}
      </span>

      <button
        type="button"
        data-testid="vt-version"
        title="Version history"
        className="flex-none rounded-[4px] px-1 py-0.5 text-[12px] font-medium text-subtle transition-colors hover:bg-elev hover:text-ink"
        onClick={onVersion}
      >
        v{doc.version}
      </button>

      <span className="ml-auto" />

      {/* Share is the doc's primary action — a filled teal button (Anchord-Design `.btn primary sm`),
          not a bare icon, so it reads as the call-to-action it is. Pinned to the LEFT edge of the
          right-hand action cluster (the first action after the spacer), ahead of the icon toggles,
          so the CTA leads the group. Shown only to a potential manager (C-002 / AS-003): a
          viewer/commenter never sees it. */}
      {showShareAffordance && (
        <button
          type="button"
          data-testid="vt-share"
          title="Share"
          className="inline-flex h-8 flex-none items-center gap-1.5 rounded-md bg-accent px-3 text-[12.5px] font-semibold text-on-accent transition-colors hover:bg-accent-strong"
          onClick={onShare}
        >
          <Icon name="share" size={14} />
          Share
        </button>
      )}

      {/* S-007 (AS-016): the guest identity chip — session name + Rename, sitting NEXT TO the Sign in
          CTA. Present only for a guest commenter (the caller passes it only then). */}
      {guestIdentity && (
        <GuestIdentityChip name={guestIdentity.name} onRename={guestIdentity.onRename} />
      )}

      {/* AS-029: the anonymous Sign in CTA — the doc's primary action for a signed-out visitor,
          replacing the member-only Share. Leads the right-hand cluster, teal accent (DESIGN.md). */}
      {anonymous && (
        <button
          type="button"
          data-testid="vt-signin"
          title="Sign in"
          className="inline-flex h-8 flex-none items-center gap-1.5 rounded-md bg-accent px-3 text-[12.5px] font-semibold text-on-accent transition-colors hover:bg-accent-strong"
          onClick={onSignIn}
        >
          <Icon name="user" size={14} />
          Sign in
        </button>
      )}

      <button
        type="button"
        data-testid="vt-comments-toggle"
        aria-label="Comments"
        aria-pressed={railVisible}
        title="Comments"
        className={`${ICON_BTN} ${railVisible ? "bg-elev text-ink" : ""}`}
        onClick={onToggleRail}
      >
        <Icon name="highlight" size={16} />
      </button>

      <button
        type="button"
        data-testid="vt-theme-toggle"
        aria-label="Toggle theme"
        className={ICON_BTN}
        onClick={toggleTheme}
      >
        <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
      </button>

      {/* AS-029: the overflow (account / member actions) menu is session-only — hidden for an anon. */}
      {!anonymous && (
        <button
          type="button"
          data-testid="vt-overflow"
          aria-label="More"
          title="More actions"
          className={ICON_BTN}
          onClick={onOverflow}
        >
          <Icon name="more" size={16} />
        </button>
      )}
    </header>
  );
}
