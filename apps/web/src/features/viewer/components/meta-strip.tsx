import { Icon } from "@/components/icon";
import type { SpecMeta } from "@/features/viewer/types";

export type { SpecMeta };

// MetaStrip (S-005, AS-013): a thin strip BELOW the top bar, shown ONLY for spec-type docs on
// desktop. It mirrors the prototype's `.meta-strip` (viewer-shell.jsx MetaStrip): slug · version ·
// updated · stories · AS · url, plus a Draft badge when the doc is a draft.
//
// PAYLOAD GAP (noted, not blocked): the S-001 doc read (`GET …/docs/:slug`) returns only
// { title, kind, version, status, generalAccess } — it does NOT carry a spec flag, slug, updated,
// story/AS counts, url, or draft. So the strip can't be fabricated from that payload. This
// component takes an explicit `spec` prop: when the caller has spec meta it renders, otherwise it
// renders nothing (`spec === null`). The `SpecMeta` shape now lives in `../types` (shared with
// viewer-screen.tsx); re-exported here so existing importers of `./meta-strip` keep working.

export function MetaStrip({ spec }: { spec: SpecMeta | null }) {
  // Non-spec / plain doc (or no spec meta available) → render nothing (AS-013 negative case).
  if (!spec) return null;

  return (
    <div
      data-testid="meta-strip"
      className="flex flex-none items-center gap-3 overflow-x-auto border-b border-line bg-sunken px-4 py-1.5 text-[11.5px] text-subtle"
    >
      <span className="whitespace-nowrap">
        <b className="font-semibold text-ink">spec</b> · {spec.slug}
      </span>
      <span className="whitespace-nowrap">v{spec.version}</span>
      {spec.updated != null && <span className="whitespace-nowrap">updated {spec.updated}</span>}
      {spec.stories != null && (
        <span data-testid="meta-stories" className="whitespace-nowrap">
          <b className="font-semibold text-ink">{spec.stories}</b> stories
        </span>
      )}
      {spec.asCount != null && (
        <span data-testid="meta-as" className="whitespace-nowrap">
          <b className="font-semibold text-ink">{spec.asCount}</b> AS
        </span>
      )}
      {spec.draft && (
        <span
          data-testid="meta-draft"
          className="rounded-full border border-amber/40 bg-amber/10 px-1.5 py-px text-[10.5px] font-medium text-amber"
        >
          Draft
        </span>
      )}
      <span className="ml-auto flex items-center gap-1 whitespace-nowrap">
        <Icon name="link" size={12} />
        {spec.url}
      </span>
    </div>
  );
}
