import type { ViewerAnnotation } from "@/features/viewer/services/client";

// annotation-filter (S-007 — annotation-core-ui): the TWO-AXIS rail filter engine. Replaces the old
// single-axis status chips. There are two ORTHOGONAL axes:
//   • Status {Open, Resolved}
//   • Type   {Markup, Comment, Redline, Label}
// A thread is SHOWN iff its status facet AND its type facet are BOTH selected (OR within an axis,
// AND across axes — C-009). Both axes default all-selected. The predicate here drives BOTH the rail
// thread list AND the in-text mark dimming (the same set is lifted in viewer-screen).
//
// This module is the pure logic (no React) — derivation, the predicate, and the DYNAMIC count rule
// (C-010). The popover UI + the rail consume it.

export type StatusFacet = "open" | "resolved";
// "Suggestion" is NOT a status facet anymore (C-009). Type comes from the mark-hue rule below.
export type TypeFacet = "markup" | "comment" | "redline" | "label";

// The annotation fields the partition reads — kept narrow so callers can pass a Pick.
type Facetable = Pick<ViewerAnnotation, "type" | "status" | "suggestion" | "label">;

// Status partition: resolved → Resolved, everything else → Open. (C-009 — drop the old Suggestion bucket.)
export function statusFacet(a: Pick<ViewerAnnotation, "status">): StatusFacet {
  return a.status === "resolved" ? "resolved" : "open";
}

// Type partition (TOTAL — every annotation maps to exactly ONE type), using the SAME logic the
// `placeable` hue computation uses (viewer-screen):
//   Redline = a delete-kind suggestion       (type==="suggestion" && suggestion.kind==="delete")
//   Label   = anything carrying a label       (label != null — incl. the Like "looks-good" preset)
//   Comment = a plain annotation              (no label, no suggestion)
//   Markup  = the catch-all                   (everything else — i.e. a replace-kind suggestion)
export function typeFacet(a: Facetable): TypeFacet {
  if (a.type === "suggestion" && a.suggestion?.kind === "delete") return "redline";
  if (a.label != null) return "label";
  if (a.suggestion == null) return "comment";
  return "markup";
}

export const ALL_STATUS: ReadonlySet<StatusFacet> = new Set<StatusFacet>(["open", "resolved"]);
export const ALL_TYPE: ReadonlySet<TypeFacet> = new Set<TypeFacet>(["markup", "comment", "redline", "label"]);

// The DEFAULT (baseline) selection (C-009, 2026-06-21): Type defaults to all-selected, but Status
// defaults to Open ONLY — resolved threads are hidden (and their marks dimmed) until the reviewer
// enables Resolved. Reset returns here, and `isFilterActive` measures deviation from HERE (not from
// all-selected), so the control reads inactive on the default view.
export const DEFAULT_STATUS: ReadonlySet<StatusFacet> = new Set<StatusFacet>(["open"]);
export const DEFAULT_TYPE: ReadonlySet<TypeFacet> = ALL_TYPE;

export const STATUS_ORDER: StatusFacet[] = ["open", "resolved"];
export const TYPE_ORDER: TypeFacet[] = ["markup", "comment", "redline", "label"];

// The combine predicate (C-009): shown iff the annotation's status facet ∈ activeStatus AND its type
// facet ∈ activeType. Either axis empty → nothing matches (the no-match state, AS-026).
export function isShown(
  a: Facetable,
  activeStatus: ReadonlySet<StatusFacet>,
  activeType: ReadonlySet<TypeFacet>,
): boolean {
  return activeStatus.has(statusFacet(a)) && activeType.has(typeFacet(a));
}

// DYNAMIC facet counts (C-010 / AS-025): a facet's count = the number of annotations matching THAT
// facet combined with the OTHER axis's current selection, IGNORING this facet's own axis selection.
//   • Status-facet counts are scoped to annotations whose TYPE is in activeType.
//   • Type-facet counts are scoped to annotations whose STATUS is in activeStatus.
// With both axes fully selected, each facet equals its whole-doc per-facet total. A zero-yield facet
// reads 0 (never hidden).
export function statusCounts(
  annotations: Facetable[],
  activeType: ReadonlySet<TypeFacet>,
): Record<StatusFacet, number> {
  const counts: Record<StatusFacet, number> = { open: 0, resolved: 0 };
  for (const a of annotations) {
    if (activeType.has(typeFacet(a))) counts[statusFacet(a)] += 1;
  }
  return counts;
}

export function typeCounts(
  annotations: Facetable[],
  activeStatus: ReadonlySet<StatusFacet>,
): Record<TypeFacet, number> {
  const counts: Record<TypeFacet, number> = { markup: 0, comment: 0, redline: 0, label: 0 };
  for (const a of annotations) {
    if (activeStatus.has(statusFacet(a))) counts[typeFacet(a)] += 1;
  }
  return counts;
}

function sameFacets<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// Is the selection at its DEFAULT baseline? → the filter is INACTIVE (header reads the default total,
// Filter control reads inactive). Any deviation from the default (e.g. enabling Resolved, dropping a
// Type) → the filter is active (C-011, 2026-06-21 — measured vs DEFAULT, not vs all-selected).
export function isFilterActive(
  activeStatus: ReadonlySet<StatusFacet>,
  activeType: ReadonlySet<TypeFacet>,
): boolean {
  return !sameFacets(activeStatus, DEFAULT_STATUS) || !sameFacets(activeType, DEFAULT_TYPE);
}
