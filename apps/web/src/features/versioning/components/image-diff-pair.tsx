import { useBreakpoint } from "@/hooks/use-breakpoint";
import { renderedPairStacks } from "@/features/versioning/components/rendered-pair";

// ImageDiffPair (S-004 / AS-013 / C-005) — the image-doc diff body: the two versions' images placed
// side-by-side (before = from | after = to), each fed a per-version content reference from the diff
// read's `renderPair` (each url a `/v/<versionId>` the existing `/v/:id` route serves). An image doc
// has NO source line-diff and NO Source tab (C-005) — the overlay drops the tabs and renders this pair
// directly. This branch is NOT in the prototype DiffView (new `[N]` per the spec UI Notes); it mirrors
// `rendered-pair.tsx`'s layout (two labelled `.rp-col` panes) but shows an <img> per pane instead of a
// sandbox iframe — an image render has no scripts to isolate.
//
// Responsive (C-006 / AS-010): side-by-side on wide viewports; ≤760px STACKS vertically (before above
// after). Reuses the pure `renderedPairStacks(width)` contract so the breakpoint stays one source.

function ImagePane({ label, version, src }: { label: string; version: string; src: string }) {
  return (
    <div
      data-testid={`idp-col-${label.toLowerCase()}`}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <div className="flex flex-none items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] text-subtle">
        <span className="rounded bg-elev px-1.5 py-0.5 font-mono text-[10px] text-ink">{version}</span>
        {label}
      </div>
      <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-elev p-4">
        <img
          data-testid={`idp-img-${label.toLowerCase()}`}
          className="max-w-full"
          src={src}
          alt={`${label} image (${version})`}
        />
      </div>
    </div>
  );
}

export function ImageDiffPair({
  renderPair,
  fromLabel,
  toLabel,
}: {
  /** [beforeUrl, afterUrl] from the diff read — each a per-version `/v/<id>` image reference. */
  renderPair: [string, string];
  fromLabel: string;
  toLabel: string;
}) {
  const tier = useBreakpoint();
  // useBreakpoint gives the tier, not the raw width; the live shell stacks at tablet + mobile (≤899),
  // which covers the ≤760 mandate. The pure renderedPairStacks(width) is the testable contract.
  const stacks = tier === "mobile" || tier === "tablet";

  return (
    <div
      data-testid="image-diff-pair"
      data-stacked={stacks ? "1" : undefined}
      className={`flex min-h-0 flex-1 ${stacks ? "flex-col" : "flex-row"} divide-line ${
        stacks ? "divide-y" : "divide-x"
      }`}
    >
      <ImagePane label="Before" version={fromLabel} src={renderPair[0]} />
      <ImagePane label="After" version={toLabel} src={renderPair[1]} />
    </div>
  );
}

// Re-export the pure stack predicate so an image-pair test asserts the same ≤760 contract as S-003.
export { renderedPairStacks };
