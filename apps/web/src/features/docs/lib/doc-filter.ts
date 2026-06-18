import type { DocRow, DocStatus, DocKind, GeneralAccess } from "@/features/docs/types";

// doc-filter (workspace-project-browse S-002): the FACETED doc-browse filter engine. Mirrors the
// annotation-rail two-axis engine (viewer/lib/annotation-filter.ts), widened to FOUR axes:
//   • Status {live, draft}                                   — multi-select
//   • Format {html, markdown, image}                         — multi-select
//   • Access {restricted, anyone_in_workspace, anyone_with_link} — multi-select
//   • Updated {any, 7d, 30d}                                 — single-select (a recency window)
// A doc is SHOWN iff it matches a selected value in EVERY axis (OR within an axis, AND across axes —
// C-003), and falls inside the Updated window. The three multi axes default all-selected; Updated
// defaults to "any". This is the pure logic (no React): partitions, the predicate, dynamic counts
// (C-004), and the active-state test. The popover UI + both browse screens consume it.

export type StatusFacet = DocStatus; // "live" | "draft"
export type FormatFacet = DocKind; // "html" | "markdown" | "image"
export type AccessFacet = GeneralAccess;
export type UpdatedWindow = "any" | "7d" | "30d";

// The doc fields the filter reads — kept narrow so callers can pass a Pick.
type Facetable = Pick<DocRow, "status" | "kind" | "generalAccess" | "updatedAt">;

export const ALL_STATUS: ReadonlySet<StatusFacet> = new Set<StatusFacet>(["live", "draft"]);
export const ALL_FORMAT: ReadonlySet<FormatFacet> = new Set<FormatFacet>(["html", "markdown", "image"]);
export const ALL_ACCESS: ReadonlySet<AccessFacet> = new Set<AccessFacet>([
  "restricted",
  "anyone_in_workspace",
  "anyone_with_link",
]);

export const STATUS_ORDER: StatusFacet[] = ["live", "draft"];
export const FORMAT_ORDER: FormatFacet[] = ["html", "markdown", "image"];
export const ACCESS_ORDER: AccessFacet[] = ["restricted", "anyone_in_workspace", "anyone_with_link"];
export const UPDATED_ORDER: UpdatedWindow[] = ["any", "7d", "30d"];

/** Human labels for the Status + Updated facets (Format/Access reuse FORMAT_META/ACCESS_META). */
export const STATUS_LABEL: Record<StatusFacet, string> = { live: "Live", draft: "Draft" };
export const UPDATED_LABEL: Record<UpdatedWindow, string> = {
  any: "Any time",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

const DAY_MS = 86_400_000;
const WINDOW_DAYS: Record<UpdatedWindow, number> = { any: Infinity, "7d": 7, "30d": 30 };

/** Is the doc inside the chosen recency window? "any" always true; otherwise updatedAt must be within
 *  N days of `now`. A doc with no `updatedAt` is only inside the "any" window (it can't be dated). */
export function withinWindow(d: Pick<DocRow, "updatedAt">, window: UpdatedWindow, now: number): boolean {
  if (window === "any") return true;
  if (!d.updatedAt) return false;
  const t = Date.parse(d.updatedAt);
  if (Number.isNaN(t)) return false;
  return t >= now - WINDOW_DAYS[window] * DAY_MS;
}

// The combine predicate (C-003): shown iff status ∈ activeStatus AND format ∈ activeFormat AND
// access ∈ activeAccess AND within the Updated window. Any multi axis empty → nothing matches.
export function isShown(
  d: Facetable,
  activeStatus: ReadonlySet<StatusFacet>,
  activeFormat: ReadonlySet<FormatFacet>,
  activeAccess: ReadonlySet<AccessFacet>,
  window: UpdatedWindow,
  now: number,
): boolean {
  return (
    activeStatus.has(d.status) &&
    activeFormat.has(d.kind) &&
    activeAccess.has(d.generalAccess) &&
    withinWindow(d, window, now)
  );
}

/** Apply the full filter to a doc list, preserving order. */
export function applyDocFilter<T extends Facetable>(
  docs: T[],
  activeStatus: ReadonlySet<StatusFacet>,
  activeFormat: ReadonlySet<FormatFacet>,
  activeAccess: ReadonlySet<AccessFacet>,
  window: UpdatedWindow,
  now: number,
): T[] {
  return docs.filter((d) => isShown(d, activeStatus, activeFormat, activeAccess, window, now));
}

// DYNAMIC facet counts (C-004): a value's count = the docs matching THAT value combined with the
// OTHER axes' current selection, IGNORING this value's own axis. With everything selected each value
// equals its whole-browse per-value total. A zero-yield value reads 0 (never hidden).

export function statusCounts(
  docs: Facetable[],
  activeFormat: ReadonlySet<FormatFacet>,
  activeAccess: ReadonlySet<AccessFacet>,
  window: UpdatedWindow,
  now: number,
): Record<StatusFacet, number> {
  const counts: Record<StatusFacet, number> = { live: 0, draft: 0 };
  for (const d of docs) {
    if (activeFormat.has(d.kind) && activeAccess.has(d.generalAccess) && withinWindow(d, window, now)) {
      counts[d.status] += 1;
    }
  }
  return counts;
}

export function formatCounts(
  docs: Facetable[],
  activeStatus: ReadonlySet<StatusFacet>,
  activeAccess: ReadonlySet<AccessFacet>,
  window: UpdatedWindow,
  now: number,
): Record<FormatFacet, number> {
  const counts: Record<FormatFacet, number> = { html: 0, markdown: 0, image: 0 };
  for (const d of docs) {
    if (activeStatus.has(d.status) && activeAccess.has(d.generalAccess) && withinWindow(d, window, now)) {
      counts[d.kind] += 1;
    }
  }
  return counts;
}

export function accessCounts(
  docs: Facetable[],
  activeStatus: ReadonlySet<StatusFacet>,
  activeFormat: ReadonlySet<FormatFacet>,
  window: UpdatedWindow,
  now: number,
): Record<AccessFacet, number> {
  const counts: Record<AccessFacet, number> = {
    restricted: 0,
    anyone_in_workspace: 0,
    anyone_with_link: 0,
  };
  for (const d of docs) {
    if (activeStatus.has(d.status) && activeFormat.has(d.kind) && withinWindow(d, window, now)) {
      counts[d.generalAccess] += 1;
    }
  }
  return counts;
}

/** Updated is single-select: each window's count = docs matching the THREE multi axes AND inside
 *  that window (ignoring the current window choice). The windows nest (7d ⊆ 30d ⊆ any). */
export function updatedCounts(
  docs: Facetable[],
  activeStatus: ReadonlySet<StatusFacet>,
  activeFormat: ReadonlySet<FormatFacet>,
  activeAccess: ReadonlySet<AccessFacet>,
  now: number,
): Record<UpdatedWindow, number> {
  const counts: Record<UpdatedWindow, number> = { any: 0, "7d": 0, "30d": 0 };
  for (const d of docs) {
    if (!(activeStatus.has(d.status) && activeFormat.has(d.kind) && activeAccess.has(d.generalAccess))) {
      continue;
    }
    for (const w of UPDATED_ORDER) {
      if (withinWindow(d, w, now)) counts[w] += 1;
    }
  }
  return counts;
}

// ── Sort (workspace-project-browse S-003) ───────────────────────────────────────────────────────
// The browse offers a Sort control beside the Filter (C-007): Updated (default) / Created / Title.
// Updated + Created order DESCENDING (newest first); Title orders ASCENDING (A→Z). Sort is orthogonal
// to the filter — it reorders, the filter subsets. A row missing the timestamp sorts last.
export type SortKey = "updated" | "created" | "title";
export const SORT_ORDER: SortKey[] = ["updated", "created", "title"];
export const SORT_LABEL: Record<SortKey, string> = {
  updated: "Updated",
  created: "Created",
  title: "Title",
};

type Sortable = Pick<DocRow, "title" | "createdAt" | "updatedAt">;

// Descending by an ISO timestamp; undefined/unparseable sorts last (treated as -Infinity).
function byTimeDesc(a: string | undefined, b: string | undefined): number {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  const va = Number.isNaN(ta) ? -Infinity : ta;
  const vb = Number.isNaN(tb) ? -Infinity : tb;
  return vb - va;
}

/** Reorder a copy of `docs` by the sort key (does not mutate the input). */
export function sortDocs<T extends Sortable>(docs: T[], key: SortKey): T[] {
  const out = docs.slice();
  if (key === "title") {
    out.sort((a, b) => a.title.localeCompare(b.title));
  } else if (key === "created") {
    out.sort((a, b) => byTimeDesc(a.createdAt, b.createdAt));
  } else {
    out.sort((a, b) => byTimeDesc(a.updatedAt, b.updatedAt));
  }
  return out;
}

// Are all three multi axes fully selected AND Updated = "any"? → the filter is INACTIVE (header reads
// the full total, Filter control reads inactive). Any value off / a narrower window → active (C-004).
export function isFilterActive(
  activeStatus: ReadonlySet<StatusFacet>,
  activeFormat: ReadonlySet<FormatFacet>,
  activeAccess: ReadonlySet<AccessFacet>,
  window: UpdatedWindow,
): boolean {
  return (
    activeStatus.size < ALL_STATUS.size ||
    activeFormat.size < ALL_FORMAT.size ||
    activeAccess.size < ALL_ACCESS.size ||
    window !== "any"
  );
}
