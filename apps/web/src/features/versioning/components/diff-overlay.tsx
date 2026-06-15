import { useState } from "react";
import { Icon } from "@/components/icon";
import { ErrorState } from "@/components/error-state";
import { Skeleton } from "@/components/skeleton";
import { useDiff } from "@/features/versioning/hooks/use-diff";
import { SourceLineDiff } from "@/features/versioning/components/source-line-diff";
import { RenderedPair } from "@/features/versioning/components/rendered-pair";
import { ImageDiffPair } from "@/features/versioning/components/image-diff-pair";

// DiffOverlay (S-003) — the full-screen two-level diff (prototype `DiffView` P18, styled
// viewer-dialogs.css `.diff-overlay`/`.diff-head`/`.diff-title`/`.diff-picker`/`.diff-count`/
// `.diff-tabs`/`.diff-tab`/`.line-diff`/`.rendered-pair`). It owns the from/to picker state, the
// active tab, and the diff query; changing either picker re-fetches via the query key (AS-009). The
// header shows a +adds/−removed change count (AS-007 / C-004). The Source tab renders the line-diff
// (added teal / removed red+strike — C-004); the Rendered tab the two renders side-by-side (AS-008),
// stacking ≤760 (AS-010 / C-006). A refused diff shows an explicit error, never a blank/half diff
// (AS-011 / C-007).
//
// S-004 completes the NO-DIFF (`identical`) and IMAGE-doc (`mode:image`) branches:
//   - identical (AS-012 / C-005): the Source tab body shows a "No differences" state (NoDiffState —
//     check icon · "No differences" · "vX and vY are identical") with change count 0, BUT the tabs are
//     NOT hidden and the Rendered tab STILL renders the two versions side-by-side (backend AS-007
//     overrides the prototype's tab-hiding on identical).
//   - image doc (AS-013 / C-005): the Source tab is DROPPED entirely (no tabs, no line-diff, no change
//     count); the body renders ImageDiffPair — the two images side-by-side using the renderPair urls.

type DiffTab = "source" | "rendered";

export function DiffOverlay({
  slug,
  versions,
  initialFrom,
  initialTo,
  onClose,
}: {
  // doc-access-routing S-005: the diff read is DOC-ADDRESSED (slug-only) — no workspaceId.
  slug: string;
  /** every version number available to pick (newest-first, from the panel's history). */
  versions: number[];
  /** the version the user clicked Compare on — the default `from`. */
  initialFrom: number;
  /** the current (highest) version — the default `to`. */
  initialTo: number;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [tab, setTab] = useState<DiffTab>("source");

  // Re-fetches whenever from/to change (the key carries both) — AS-009. doc-access-routing S-005:
  // the diff read is DOC-ADDRESSED (slug-only), anon-capable — opened through the doc link (AS-024).
  const query = useDiff(slug, from, to, true);
  const diff = query.data;

  const adds = diff?.lines?.filter((l) => l.type === "added").length ?? diff?.changeCount ?? 0;
  const dels = diff?.lines?.filter((l) => l.type === "removed").length ?? 0;
  const fromLabel = `v${from}`;
  const toLabel = `v${to}`;
  const isImage = diff?.mode === "image";

  return (
    <div
      data-testid="diff-overlay"
      className="fixed inset-0 z-[70] grid grid-rows-[auto_1fr] bg-surface"
    >
      {/* header: back · title · pickers · change count · tabs (C-005: Source dropped only for image) */}
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2">
        <button
          type="button"
          aria-label="Close diff"
          data-testid="diff-close"
          className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-muted hover:bg-elev hover:text-ink"
          onClick={onClose}
        >
          <Icon name="chevLeft" size={18} />
        </button>
        <span className="flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <Icon name="list" size={15} />
          Compare versions
        </span>

        <div className="flex items-center gap-2" data-testid="diff-picker">
          <select
            data-testid="diff-from"
            aria-label="Compare from version"
            value={from}
            onChange={(e) => setFrom(Number(e.target.value))}
            className="h-[30px] rounded-[6px] border border-line bg-surface px-2 text-[12.5px] text-ink outline-none hover:border-subtle focus-visible:border-accent"
          >
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
          <Icon name="arrowRight" size={14} />
          <select
            data-testid="diff-to"
            aria-label="Compare to version"
            value={to}
            onChange={(e) => setTo(Number(e.target.value))}
            className="h-[30px] rounded-[6px] border border-line bg-surface px-2 text-[12.5px] text-ink outline-none hover:border-subtle focus-visible:border-accent"
          >
            {versions.map((v) => (
              <option key={v} value={v}>
                v{v}
              </option>
            ))}
          </select>
        </div>

        {!query.isError && !isImage && (
          <span data-testid="diff-count" className="flex items-center gap-2 font-mono text-[12px]">
            <span className="text-accent-ink">+{adds}</span>
            <span className="text-error">−{dels}</span>
          </span>
        )}

        <span className="flex-1" />

        {/* Tabs: Source dropped only for an image doc (C-005); identical keeps both (S-004). */}
        {!isImage && (
          <div data-testid="diff-tabs" className="flex gap-1 rounded-[8px] bg-elev p-0.5">
            <button
              type="button"
              data-testid="diff-tab-source"
              data-active={tab === "source" ? "1" : undefined}
              className={`rounded-[6px] px-3 py-1 text-[12px] font-medium ${
                tab === "source" ? "bg-surface text-ink shadow-sm" : "text-subtle hover:text-ink"
              }`}
              onClick={() => setTab("source")}
            >
              Source
            </button>
            <button
              type="button"
              data-testid="diff-tab-rendered"
              data-active={tab === "rendered" ? "1" : undefined}
              className={`rounded-[6px] px-3 py-1 text-[12px] font-medium ${
                tab === "rendered" ? "bg-surface text-ink shadow-sm" : "text-subtle hover:text-ink"
              }`}
              onClick={() => setTab("rendered")}
            >
              Rendered
            </button>
          </div>
        )}
      </div>

      {/* body */}
      <div className="flex min-h-0 flex-col overflow-hidden">
        {query.isPending ? (
          <div className="p-4">
            <Skeleton rows={6} delayMs={0} />
          </div>
        ) : query.isError ? (
          // AS-011 / C-007: an explicit error — NEVER a blank or half-rendered diff.
          <div data-testid="diff-error" className="p-4">
            <ErrorState
              message="We couldn't load this comparison."
              onRetry={() => void query.refetch()}
              retrying={query.isFetching}
            />
          </div>
        ) : isImage ? (
          // AS-013 / C-005: an image doc has NO Source tab and NO line-diff — only the two images
          // side-by-side using the renderPair urls.
          diff?.renderPair ? (
            <ImageDiffPair renderPair={diff.renderPair} fromLabel={fromLabel} toLabel={toLabel} />
          ) : null
        ) : tab === "rendered" ? (
          // AS-008 / AS-012: the two renders side-by-side (before|after) — STILL shown for identical
          // text versions (the Rendered tab stays available, backend AS-007 / C-005).
          diff?.renderPair ? (
            <RenderedPair renderPair={diff.renderPair} fromLabel={fromLabel} toLabel={toLabel} />
          ) : null
        ) : diff?.identical ? (
          // AS-012 / C-005: identical text versions show a "No differences" state in the Source tab
          // body (NOT replacing the whole overlay — the Rendered tab is still reachable above), with
          // the two version labels and change count 0. Prototype `.no-diff` (`.t`/`.s`).
          <div
            data-testid="no-diff"
            className="grid flex-1 place-items-center px-6 py-[60px] text-center"
          >
            <div>
              <Icon name="check" size={26} className="mx-auto text-accent-ink" />
              <div className="mt-2 text-[15px] font-semibold text-ink">No differences</div>
              <div className="mt-1.5 text-[12px] text-subtle">
                {fromLabel} and {toLabel} are identical.
              </div>
            </div>
          </div>
        ) : (
          // AS-007 / C-004: the Source line-diff.
          <SourceLineDiff lines={diff?.lines ?? []} fromLabel={fromLabel} toLabel={toLabel} />
        )}
      </div>
    </div>
  );
}
