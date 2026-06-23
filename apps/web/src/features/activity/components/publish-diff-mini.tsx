import { Icon } from "@/components/icon";
import { Skeleton } from "@/components/skeleton";
import { useDiff } from "@/features/versioning/hooks/use-diff";
import { SourceLineDiff } from "@/features/versioning/components/source-line-diff";
import type { ActivityPublishMeta } from "@/features/activity/types";

// PublishDiffMini (workspace-activity S-004 / AS-015): the publish event detail's source diff.
//
// REUSES the existing versioning-diff (useDiff → the doc-addressed GET /api/docs/:slug/diff, and the
// SourceLineDiff renderer) rather than re-implementing a diff — the publish event's meta carries the
// from/to version LABELS (e.g. "v3"→"v4") + the computed add/remove counts, and the real v3→v4 line
// diff is fetched by slug. The header always shows the +adds/−dels counts (from meta); the line-diff
// body fills in once loaded. If the diff read fails OR there is no slug (deleted doc), the mini
// DEGRADES to the counts header alone (C-001 — never a broken/blank diff).

/** Parse a version label ("v4", "4") into its number; null if unparseable. */
function versionNumber(label: string | undefined): number | null {
  if (!label) return null;
  const n = Number.parseInt(label.replace(/^v/i, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function PublishDiffMini({ slug, meta }: { slug: string | null | undefined; meta: ActivityPublishMeta }) {
  const from = versionNumber(meta.from);
  const to = versionNumber(meta.to);
  // Fetch the real source diff only when we have a live doc slug AND a parseable v-range (AS-015).
  const canDiff = Boolean(slug) && from != null && to != null;
  const query = useDiff(slug ?? "", from ?? 0, to ?? 0, canDiff);
  const lines = query.data?.lines ?? [];

  return (
    <div data-testid="publish-diff-mini" className="mt-3 overflow-hidden rounded-[9px] border border-line">
      <div className="flex items-center gap-1.5 border-b border-line bg-elev px-3 py-1.5 font-mono text-[11px] text-subtle">
        <Icon name="list" size={13} />
        <span>
          Source · {meta.from ?? "?"} → {meta.to ?? "?"}
        </span>
        <span className="ml-auto flex items-center gap-2 tabular-nums">
          {meta.adds != null && <span className="text-success">+{meta.adds}</span>}
          {meta.dels != null && <span className="text-error">−{meta.dels}</span>}
        </span>
      </div>
      {/* C-001: degrade to the counts header alone when the diff can't be fetched/loaded. */}
      {!canDiff ? null : query.isPending ? (
        <div className="p-3">
          <Skeleton rows={3} delayMs={0} />
        </div>
      ) : query.isError || lines.length === 0 ? null : (
        <SourceLineDiff lines={lines} fromLabel={meta.from ?? "from"} toLabel={meta.to ?? "to"} />
      )}
    </div>
  );
}
