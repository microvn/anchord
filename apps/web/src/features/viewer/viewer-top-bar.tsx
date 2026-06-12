import { Icon, Brandmark } from "../../components/icon";
import { useTheme } from "../../app/theme-provider";
import type { ViewerDocKind } from "./client";

// ViewerTopBar (S-005, AS-012): the bar ABOVE the 3-pane viewer body. Mirrors the prototype's
// `.vtop` (viewer-shell.jsx ViewerTopBar) structurally, in Tailwind/DESIGN.md tokens:
//   outline-toggle (drawer mode) · back · brand · title · LiveBadge · FormatBadge · VersionButton ·
//   CommentsToggle · ShareButton · ThemeToggle · OverflowMenu.
//
// The identity fields (title / live / format / version) come from the doc meta the viewer already
// fetches (S-001 GET …/docs/:slug → { title, kind→format, version, status }).
//   - LiveBadge: shown when status is `live` or `published`.
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
}) {
  const { theme, toggleTheme } = useTheme();
  const isLive = doc.status === "live" || doc.status === "published";

  return (
    <header
      data-testid="viewer-top-bar"
      className="flex h-12 flex-none items-center gap-2 border-b border-line bg-paper px-3"
    >
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

      <span className="flex items-center" aria-hidden="true">
        <Brandmark size={18} />
      </span>

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

      <button
        type="button"
        data-testid="vt-comments-toggle"
        aria-label="Comments"
        aria-pressed={railVisible}
        title="Comments"
        className={`${ICON_BTN} ${railVisible ? "bg-elev text-ink" : ""}`}
        onClick={onToggleRail}
      >
        <Icon name="inbox" size={16} />
      </button>

      {/* Share is the doc's primary action — a filled teal button (Anchord-Design `.btn primary sm`),
          not a bare icon, so it reads as the call-to-action it is. Shown only to a potential
          manager (C-002 / AS-003): a viewer/commenter never sees it. */}
      {showShare && (
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

      <button
        type="button"
        data-testid="vt-theme-toggle"
        aria-label="Toggle theme"
        className={ICON_BTN}
        onClick={toggleTheme}
      >
        <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
      </button>

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
    </header>
  );
}
