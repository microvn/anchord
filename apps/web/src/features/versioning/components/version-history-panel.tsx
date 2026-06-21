import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Icon } from "@/components/icon";
import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";
import { tierForWidth, useBreakpoint } from "@/hooks/use-breakpoint";
import { useVersionHistory } from "@/features/versioning/hooks/use-version-history";
import { restoreVersion, type RestoreResult } from "@/features/versioning/services/client";
import { VersionItem } from "@/features/versioning/components/version-item";
import { DiffOverlay } from "@/features/versioning/components/diff-overlay";

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
  onCompare: _onCompare,
  onRestore: _onRestore,
}: {
  open: boolean;
  workspaceId: string;
  slug: string;
  onClose: () => void;
  /** @deprecated S-003 — the panel now OWNS the diff overlay internally (keeps the diff seam inside
   *  features/versioning/**, so viewer-screen never hosts it). Kept optional for type-compat with
   *  viewer-screen's old placeholder; no longer used. A trivial future cleanup. */
  onCompare?: (version: number) => void;
  /** @deprecated S-002 — the panel now owns restore internally (keeps the diff inside
   *  features/versioning/**). Kept optional for type-compat with viewer-screen's old placeholder;
   *  no longer used. A trivial future cleanup. */
  onRestore?: (version: number) => void;
}) {
  const tier = useBreakpoint();
  const fullWidth = tier === "mobile";
  const queryClient = useQueryClient();

  // Only fetch once the panel is actually open (the history isn't loaded until the reader opens it).
  // doc-access-routing S-005: the history read is DOC-ADDRESSED (slug-only), so the hook no longer
  // takes workspaceId — a signed-out viewer can open the history through the doc link (AS-024).
  const query = useVersionHistory(slug, open);

  // S-003: the panel OWNS the Compare → DiffOverlay seam. A row's Compare opens the overlay for
  // (clickedVersion → current). `compareFrom` holds the clicked version (null = overlay closed).
  // The `to` default is the current (highest) version — the one row marked isCurrent.
  const [compareFrom, setCompareFrom] = useState<number | null>(null);

  // S-002 (AS-005/AS-006 / C-001): the panel OWNS the restore mutation. Restore is always
  // append-copy — the POST asks the backend to copy the chosen version as a NEW current version
  // (older versions stay; never overwrite/delete). It's a pure server mutation: there is NO
  // optimistic row (the only state change is the post-success refetch), so a failure leaves the
  // list untouched (AS-006 rollback = nothing to roll back). On 201 we toast and invalidate the
  // history (so the new current shows + olders remain) AND the viewer doc read (so the top bar's
  // version refreshes — best-effort; the key MUST match viewer-screen's actual read key
  // `["viewer-doc", slug]` — slug-only, doc-addressed. A prior `["viewer-doc", ws, slug]` never
  // matched (invalidateQueries is prefix-based), so the open viewer was not refreshed on restore).
  const restore = useMutation({
    mutationFn: async (version: number) => {
      const res = unwrapEnvelope<RestoreResult>(await restoreVersion(workspaceId, slug, version));
      if (res.error || !res.data) throw new Error("restore-failed");
      return res.data;
    },
    onSuccess: (_data, version) => {
      toast(`Restored v${version} as a new version`);
      // S-005: the history cache is keyed by slug only (doc-addressed read).
      void queryClient.invalidateQueries({ queryKey: ["version-history", slug] });
      void queryClient.invalidateQueries({ queryKey: ["viewer-doc", slug] });
    },
    onError: () => {
      toast.error("We couldn't restore this version.");
    },
  });

  const handleRestore = (version: number) => restore.mutate(version);

  if (!open) return null;

  const items = query.data?.items ?? [];
  const versions = items.map((it) => it.version);
  const currentVersion = items.find((it) => it.isCurrent)?.version ?? versions[0];

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
                  onCompare={setCompareFrom}
                  onRestore={handleRestore}
                />
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* S-003: a row's Compare opens the DiffOverlay for (clickedVersion → current). The panel
          owns the overlay open-state so the diff stays self-contained inside features/versioning. */}
      {compareFrom !== null && currentVersion != null && (
        <DiffOverlay
          slug={slug}
          versions={versions}
          initialFrom={compareFrom}
          initialTo={currentVersion}
          onClose={() => setCompareFrom(null)}
        />
      )}
    </div>
  );
}
