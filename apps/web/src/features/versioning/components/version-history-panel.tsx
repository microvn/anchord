import { Icon } from "@/components/icon";
import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { tierForWidth, useBreakpoint } from "@/hooks/use-breakpoint";
import { useVersionHistory } from "@/features/versioning/hooks/use-version-history";
import { VersionItem } from "@/features/versioning/components/version-item";

// VersionHistoryPanel (S-001) — the right-hand timeline panel opened from the viewer top bar's
// version button. Lists every version newest-first (the backend returns them newest-first); each row
// shows its label + relative time + publisher, the current (highest) one marked "Current" (C-002).
// Each non-current row offers Compare + Restore; the current row offers Compare only (C-002 / AS-002).
//
// Responsive (C-006 / AS-003): full-width (≤599px = the `mobile` tier) vs a fixed 340px side panel
// (≥600px). The width decision is the pure `versionPanelIsFullWidth` so AS-003 can assert it
// deterministically (mirrors how the viewer tests its breakpoints via `viewerLayoutModeForWidth`).
//
// Error handling (C-007 / AS-004): a failed history read shows an explicit error state, NEVER a
// misleading empty "no versions" list — an open doc always has ≥1 version, so empty-on-error would
// lie. The empty-list state is reserved for a genuinely-empty (but successful) read.

/** ≤599px (the `mobile` tier) → full-width sheet; ≥600px → the 340px side panel. C-006 / AS-003. */
export function versionPanelIsFullWidth(width: number): boolean {
  return tierForWidth(width) === "mobile";
}

export function VersionHistoryPanel({
  open,
  workspaceId,
  slug,
  onClose,
  onCompare,
  onRestore,
}: {
  open: boolean;
  workspaceId: string;
  slug: string;
  onClose: () => void;
  onCompare: (version: number) => void;
  onRestore?: (version: number) => void;
}) {
  const tier = useBreakpoint();
  const fullWidth = tier === "mobile";

  // Only fetch once the panel is actually open (the history isn't loaded until the reader opens it).
  const query = useVersionHistory(workspaceId, slug, open);

  if (!open) return null;

  const items = query.data?.items ?? [];

  return (
    <div data-testid="vh-overlay">
      <button
        type="button"
        aria-label="Close"
        data-testid="vh-scrim"
        className="fixed inset-0 z-50 bg-black/40"
        onClick={onClose}
      />
      <aside
        data-testid="version-history-panel"
        data-fullwidth={fullWidth ? "1" : undefined}
        className={`fixed inset-y-0 right-0 z-[60] flex flex-col border-l border-line bg-surface shadow-xl ${
          fullWidth ? "w-full" : "w-[340px]"
        }`}
      >
        <div className="flex h-12 flex-none items-center gap-2 border-b border-line pl-4 pr-3">
          <Icon name="clock" size={16} />
          <span className="flex-1 text-[13px] font-semibold text-ink">Version history</span>
          <button
            type="button"
            aria-label="Close"
            data-testid="vh-close"
            className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-muted hover:bg-elev hover:text-ink"
            onClick={onClose}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2.5">
          {query.isPending ? (
            <div className="p-2">
              <Skeleton rows={4} delayMs={0} />
            </div>
          ) : query.isError ? (
            // AS-004 / C-007: an explicit error — NOT an empty "no versions" list.
            <div data-testid="vh-error" className="p-2">
              <ErrorState
                message="We couldn't load version history."
                onRetry={() => void query.refetch()}
                retrying={query.isFetching}
              />
            </div>
          ) : items.length === 0 ? (
            <div data-testid="vh-empty" className="p-2">
              <EmptyState title="No versions yet" description="This document has no version history." />
            </div>
          ) : (
            <div data-testid="vh-list">
              {items.map((item, i) => (
                <VersionItem
                  key={item.version}
                  item={item}
                  isLast={i === items.length - 1}
                  onCompare={onCompare}
                  onRestore={onRestore}
                />
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
