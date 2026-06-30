import { useState } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTheme, type ThemePreference } from "@/app/theme-provider";
import type { ViewerAnnotation, ViewerDocKind } from "@/features/viewer/services/client";
import { annotationsToMarkdown, exportFilename } from "@/features/viewer/lib/export-annotations";

// viewer-overflow-menu — the ⋯ "more actions" popover for the doc viewer top bar (S-001 shell).
// Replaces the dead placeholder button. Adapted from Plannotator's overflow popover for Anchord:
// an Appearance control, document quick-actions, and a static, phone-home-free footer. The trigger
// is rendered ONLY when the top bar passes it (the top bar gates on `!anonymous`), so the menu stays
// member-only (C-001). chrome-recedes: low-contrast popover on `elev`, the single teal accent.
//
// Groups grow per story: S-001 = shell + Appearance (light/dark) + footer; S-002 = System theme;
// S-003 = This-document actions; S-004 = Download annotations.

// The project's release-notes link — a plain, user-initiated anchor. No version check, no update
// probe, no telemetry (C-002 / CLAUDE.md "no telemetry, no phone-home, ever").
const RELEASES_URL = "https://github.com/microvn/anchord/releases";

const ICON_BTN =
  "inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-muted transition-colors hover:bg-elev hover:text-ink";

// A group heading inside the popover — the small uppercase mono label (DESIGN.md mono-label 11).
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pb-1 pt-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.07em] text-subtle">
      {children}
    </div>
  );
}

// A full-width action row: icon + label, hover `elev` (mirrors filter-popover's row treatment).
function MenuRow({
  icon,
  label,
  testid,
  onClick,
}: {
  icon: string;
  label: string;
  testid: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-[6px] px-2 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-elev"
    >
      <Icon name={icon} size={15} className="flex-none text-muted" />
      {label}
    </button>
  );
}

// Appearance — the theme control. Light / Dark / System segmented; the active state reflects the
// PREFERENCE (so System reads as selected even though it resolves to a concrete theme), and System
// follows the OS via the provider (viewer-overflow-menu S-002).
function AppearanceControl() {
  const { preference, setTheme } = useTheme();
  const options: { id: ThemePreference; label: string; icon: string }[] = [
    { id: "light", label: "Light", icon: "sun" },
    { id: "dark", label: "Dark", icon: "moon" },
    { id: "system", label: "System", icon: "monitor" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="mx-1 grid grid-cols-3 gap-1 rounded-[7px] bg-sunken p-1"
    >
      {options.map((o) => {
        const active = preference === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            data-testid={`viewer-overflow-theme-${o.id}`}
            onClick={() => setTheme(o.id)}
            className={`inline-flex items-center justify-center gap-1.5 rounded-[5px] px-1.5 py-1.5 text-[12px] font-medium transition-colors ${
              active
                ? "bg-elev text-ink shadow-[0_1px_2px_rgba(0,0,0,0.18)]"
                : "text-muted hover:text-ink"
            }`}
          >
            <Icon name={o.icon} size={14} className="flex-none" />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export interface ViewerOverflowMenuProps {
  doc: { title: string; version: number; kind: ViewerDocKind };
  /** the doc slug — addresses the raw download endpoint GET /api/docs/:slug/download (S-005). */
  slug: string;
  /** the rail's annotation threads — the source for Download annotations (S-004). */
  annotations: ViewerAnnotation[];
  /** opens the version history panel — the same handler the top bar's v{n} button uses (S-003). */
  onVersion: () => void;
}

export function ViewerOverflowMenu({ doc, slug, annotations, onVersion }: ViewerOverflowMenuProps) {
  // Controlled so a chosen action can close the popover (radix Popover, unlike a menu, does not
  // auto-close on an inner button click). Escape / outside-click still close via onOpenChange.
  const [open, setOpen] = useState(false);

  const copyLink = async () => {
    // Copy the address bar verbatim — on /s/:token that is the token URL, so the readable slug is
    // never exposed (C-002: a local clipboard write, no network).
    try {
      await navigator.clipboard?.writeText(window.location.href);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
    setOpen(false);
  };

  const print = () => {
    setOpen(false);
    window.print();
  };

  // Download the document's own source by kind via the access-gated backend surface (S-005). A
  // same-origin <a download> sends the session/admission cookie, so the server applies the SAME
  // viewer+ gate as the doc read; the response's Content-Disposition names the file (.md/.html/img).
  const downloadDocument = () => {
    setOpen(false);
    const a = document.createElement("a");
    a.href = `/api/docs/${encodeURIComponent(slug)}/download`;
    // download="" lets the server's Content-Disposition filename win; presence keeps it a download.
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // Build the Markdown from the rail's annotations already in the browser (C-004: no backend
  // request) and hand it to the browser as a download via a transient object URL.
  const downloadAnnotations = () => {
    setOpen(false);
    const md = annotationsToMarkdown({ title: doc.title, version: doc.version }, annotations);
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename(doc.title);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="vt-overflow"
          aria-label="More"
          title="More actions"
          className={ICON_BTN}
        >
          <Icon name="more" size={16} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="viewer-overflow-content"
        align="end"
        sideOffset={6}
        className="w-72 p-2"
      >
        <GroupLabel>Appearance</GroupLabel>
        <AppearanceControl />

        <div className="my-1.5 h-px bg-line" aria-hidden="true" />

        <GroupLabel>This document</GroupLabel>
        <MenuRow
          icon="clock"
          label="Version history"
          testid="viewer-overflow-version"
          onClick={() => {
            setOpen(false);
            onVersion();
          }}
        />
        <MenuRow icon="link" label="Copy link" testid="viewer-overflow-copy-link" onClick={copyLink} />
        <MenuRow
          icon="download"
          label="Download document"
          testid="viewer-overflow-download-doc"
          onClick={downloadDocument}
        />
        <MenuRow
          icon="highlight"
          label="Download annotations"
          testid="viewer-overflow-download"
          onClick={downloadAnnotations}
        />
        <MenuRow
          icon="printer"
          label="Print / Save as PDF"
          testid="viewer-overflow-print"
          onClick={print}
        />

        <div
          data-testid="viewer-overflow-footer"
          className="mt-2 flex items-center justify-between border-t border-line px-2 pb-0.5 pt-2"
        >
          <span className="text-[12px] font-semibold text-subtle">Anchord</span>
          <a
            data-testid="viewer-overflow-repo-link"
            href={RELEASES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11.5px] text-subtle transition-colors hover:text-accent-ink"
          >
            Release notes
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}
