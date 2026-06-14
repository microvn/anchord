import { Badge } from "@/components/ui/badge";
import { initials, avatarColor } from "@/lib/initials";
import { relativeTime } from "@/features/versioning/lib/relative-time";
import type { VersionHistoryItem } from "@/features/versioning/services/client";

// VersionItem (S-001) — one row of the version timeline (prototype `.vh-item`, styled
// viewer-dialogs.css `.vh-rail`/`.vh-dot`/`.vh-line`/`.vh-main`/`.vh-top`/`.vh-ver`/`.vh-time`/
// `.vh-author`/`.vh-actions`). The current row carries `.current` (teal dot + "Current" badge) and
// offers Compare ONLY — restoring the current version is a no-op, so Restore is not shown (C-002 /
// AS-002). A non-current row offers Compare AND Restore. The prototype's `.vh-note` (commit message)
// is DROPPED — the backend has no version note (GAP-004).
export function VersionItem({
  item,
  isLast,
  onCompare,
  onRestore,
}: {
  item: VersionHistoryItem;
  /** the last (oldest) row hides its connecting timeline line (prototype `:last-child .vh-line`). */
  isLast: boolean;
  onCompare: (version: number) => void;
  /** absent on the current row — Restore is not offered there (C-002). */
  onRestore?: (version: number) => void;
}) {
  const label = `v${item.version}`;
  const name = item.publishedBy.name || "Unknown";

  return (
    <div
      data-testid={`vh-item-${item.version}`}
      data-current={item.isCurrent ? "1" : undefined}
      className="relative flex gap-3 rounded-md p-[11px] hover:bg-elev"
    >
      {/* timeline rail: a dot (teal when current) + a connecting line (hidden on the last row). */}
      <div className="flex flex-none flex-col items-center pt-[3px]" aria-hidden="true">
        <span
          className={`h-2.5 w-2.5 flex-none rounded-full border-2 ${
            item.isCurrent ? "border-accent bg-accent" : "border-faint bg-surface"
          }`}
        />
        {!isLast && <span className="-mb-[11px] mt-1 w-0.5 flex-1 bg-line" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] font-semibold text-ink">{label}</span>
          {item.isCurrent && (
            <Badge
              data-testid={`vh-current-${item.version}`}
              className="bg-accent-soft px-1.5 py-0 text-[9px] text-accent-ink"
            >
              Current
            </Badge>
          )}
          <span className="font-mono text-[10.5px] tabular-nums text-subtle">
            {relativeTime(item.createdAt)}
          </span>
        </div>

        <div className="mt-[5px] flex items-center gap-1.5 text-[11.5px] text-subtle">
          <span
            aria-hidden="true"
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-semibold text-white"
            style={{ background: avatarColor(name) }}
          >
            {initials(name)}
          </span>
          by {name}
        </div>

        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            data-testid={`vh-compare-${item.version}`}
            className="rounded text-[12px] font-medium text-accent hover:underline"
            onClick={() => onCompare(item.version)}
          >
            Compare
          </button>
          {/* C-002 / AS-002: Restore is hidden on the current row (restoring current is a no-op). */}
          {!item.isCurrent && onRestore && (
            <button
              type="button"
              data-testid={`vh-restore-${item.version}`}
              className="rounded text-[12px] font-medium text-subtle hover:text-ink hover:underline"
              onClick={() => onRestore(item.version)}
            >
              Restore
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
