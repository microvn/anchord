// Shared viewer types that more than one viewer file consumes but that don't belong to a
// specific module (the bridge/selection-anchor/place-popover types stay with their own modules;
// the wire shapes stay in client.ts). Per the feature contract (FRONTEND.md): a type used by 2+
// files lives in types.ts; a single-component prop type stays co-located.

/**
 * Spec-meta the MetaStrip renders below the top bar for spec-type docs. Defined here (not inline
 * in meta-strip.tsx) because viewer-screen.tsx builds/holds it and meta-strip.tsx consumes it.
 *
 * PAYLOAD GAP (noted, not blocked): the S-001 doc read returns only
 * { title, kind, version, status, generalAccess } — no spec flag, slug, updated, counts, or url.
 * So every field beyond slug/version/url is OPTIONAL and omitted (never fabricated) when absent.
 */
export interface SpecMeta {
  /** the doc slug (also the route param) — always present when this is a spec doc. */
  slug: string;
  /** current version number (rendered as `v<n>`). */
  version: number;
  /** the doc's public url, e.g. `anchord.local/d/<slug>` (derivable from slug). */
  url: string;
  /** relative "updated" label — optional (omitted if the payload lacks it). */
  updated?: string;
  /** story count — optional; omitted (not fabricated) when the backend doesn't supply it. */
  stories?: number;
  /** acceptance-scenario count — optional; omitted when absent. */
  asCount?: number;
  /** draft flag — shows an amber Draft badge when true. */
  draft?: boolean;
}
