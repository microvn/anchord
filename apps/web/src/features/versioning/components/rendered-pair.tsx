import { useBreakpoint, tierForWidth } from "@/hooks/use-breakpoint";

// RenderedPair (S-003 / AS-008 / AS-010 / C-006) — the Rendered tab body: the two versions' renders
// placed side-by-side (before = from | after = to), each in its own sandboxed iframe whose `src` is a
// per-version content reference from the diff read's `renderPair` (the backend SHIPPED the per-version
// route — GAP-002 is stale; each url is a `/v/<versionId>` the existing `/v/:id` route serves). A thin
// local iframe wrapper is used instead of the viewer's HtmlSandboxFrame: that component layers its own
// sandbox-header chrome + the selection bridge (parent↔iframe MessageChannel) which a read-only diff
// pane neither needs nor wants. We keep the SAME isolation contract — `sandbox="allow-scripts"` (no
// allow-same-origin) keeps each render on an opaque origin (render-publish C-001/C-002).
//
// Responsive (C-006 / AS-010): the pair is side-by-side on wide viewports; at ≤760px it STACKS
// vertically (before above after). The breakpoint is the pure `renderedPairStacks` so AS-010 can
// assert it deterministically (mirrors S-001's `versionPanelIsFullWidth`).

/** ≤760px → stack the rendered pair vertically (before above after); >760px → side-by-side. The
 *  ≤760 cutoff is below DESIGN.md's 600 mobile/900 tablet boundaries, so it maps to the tablet tier
 *  and below (tablet starts at 600; a 600–760 window still stacks). C-006 / AS-010. */
export function renderedPairStacks(width: number): boolean {
  if (width <= 760) return true;
  // 761–899 is the upper slice of the tablet tier (600–899) — wide enough to stay side-by-side.
  return false;
}

function RenderPane({ label, version, src }: { label: string; version: string; src: string }) {
  return (
    <div data-testid={`rp-col-${label.toLowerCase()}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-2 border-b border-line px-3 py-1.5 text-[11px] text-subtle">
        <span className="rounded bg-elev px-1.5 py-0.5 font-mono text-[10px] text-ink">{version}</span>
        {label}
      </div>
      <iframe
        data-testid={`rp-frame-${label.toLowerCase()}`}
        className="min-h-0 w-full flex-1 border-0 bg-white"
        sandbox="allow-scripts"
        src={src}
        title={`${label} render (${version})`}
      />
    </div>
  );
}

export function RenderedPair({
  renderPair,
  fromLabel,
  toLabel,
}: {
  /** [beforeUrl, afterUrl] from the diff read — each a per-version `/v/<id>` content reference. */
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
      data-testid="rendered-pair"
      data-stacked={stacks ? "1" : undefined}
      className={`flex min-h-0 flex-1 ${stacks ? "flex-col" : "flex-row"} divide-line ${
        stacks ? "divide-y" : "divide-x"
      }`}
    >
      <RenderPane label="Before" version={fromLabel} src={renderPair[0]} />
      <RenderPane label="After" version={toLabel} src={renderPair[1]} />
    </div>
  );
}

// Re-export the tier helper so a test that wants to assert the live mapping has a single source.
export { tierForWidth };
