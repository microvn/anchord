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
// S-007 third axis (C-009, 2026-06-21): the suggestion DECISION lifecycle, read from `suggestionStatus`.
// PARTIAL axis — applies ONLY to suggestions (Redline / Markup); a Comment / Label has no decision.
export type DecisionFacet = "pending" | "accepted" | "rejected" | "stale";

// The annotation fields the partition reads — kept narrow so callers can pass a Pick.
type Facetable = Pick<ViewerAnnotation, "type" | "status" | "suggestion" | "label" | "suggestionStatus">;

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

// Decision partition (PARTIAL — C-009): the suggestion's lifecycle, or `null` for a non-suggestion. Only
// suggestions carry `suggestionStatus` (the read leaves it absent on comments/labels), so reading it is a
// total, safe partition: a `null` here means "no decision" → the annotation PASSES the Decision axis
// vacuously (it is never hidden by it — the standard faceted-search rule for an attribute an item lacks).
export function decisionFacet(a: Pick<ViewerAnnotation, "suggestionStatus">): DecisionFacet | null {
  return a.suggestionStatus ?? null;
}

export const ALL_STATUS: ReadonlySet<StatusFacet> = new Set<StatusFacet>(["open", "resolved"]);
export const ALL_TYPE: ReadonlySet<TypeFacet> = new Set<TypeFacet>(["markup", "comment", "redline", "label"]);
export const ALL_DECISION: ReadonlySet<DecisionFacet> = new Set<DecisionFacet>(["pending", "accepted", "rejected", "stale"]);

// The DEFAULT (baseline) selection (C-009, 2026-06-21): Type defaults to all-selected, but Status
// defaults to Open ONLY — resolved threads are hidden (and their marks dimmed) until the reviewer
// enables Resolved. Reset returns here, and `isFilterActive` measures deviation from HERE (not from
// all-selected), so the control reads inactive on the default view.
export const DEFAULT_STATUS: ReadonlySet<StatusFacet> = new Set<StatusFacet>(["open"]);
export const DEFAULT_TYPE: ReadonlySet<TypeFacet> = ALL_TYPE;
// Decision defaults to all-selected (C-009, 2026-06-21) — like Type, not like Status. The Status
// Open-only default already hides the bulk of decided (resolved) suggestions, so Decision starts open.
export const DEFAULT_DECISION: ReadonlySet<DecisionFacet> = ALL_DECISION;

export const STATUS_ORDER: StatusFacet[] = ["open", "resolved"];
export const TYPE_ORDER: TypeFacet[] = ["markup", "comment", "redline", "label"];
export const DECISION_ORDER: DecisionFacet[] = ["pending", "accepted", "rejected", "stale"];

// The Decision-axis term (C-009). A SUGGESTION must have its decision ∈ activeDecision. A NON-suggestion
// (decisionFacet === null) has no decision: it passes ONLY while the Decision axis is at its default
// (every facet selected) — once the reviewer NARROWS the axis (deselects any facet) they are filtering by
// decision, so comments/labels (which have none) drop out. This makes "select Rejected" yield exactly the
// rejected suggestions (no comment/label bleed-through), and makes emptying the axis a no-match like the
// other two axes. A full set means "not filtering on decision" → non-suggestions pass.
function decisionAllows(a: Facetable, activeDecision: ReadonlySet<DecisionFacet>): boolean {
  const df = decisionFacet(a);
  if (df !== null) return activeDecision.has(df);
  return activeDecision.size === ALL_DECISION.size; // non-suggestion: only when Decision is un-narrowed
}

// The combine predicate (C-009): shown iff the annotation's status facet ∈ activeStatus AND its type
// facet ∈ activeType AND the Decision-axis term holds (see decisionAllows). Emptying ANY axis → nothing
// matches (no-match, AS-026/AS-030). activeDecision defaults to all so a caller that doesn't filter on
// decision behaves exactly as the prior two-axis predicate.
export function isShown(
  a: Facetable,
  activeStatus: ReadonlySet<StatusFacet>,
  activeType: ReadonlySet<TypeFacet>,
  activeDecision: ReadonlySet<DecisionFacet> = ALL_DECISION,
): boolean {
  if (!activeStatus.has(statusFacet(a)) || !activeType.has(typeFacet(a))) return false;
  return decisionAllows(a, activeDecision);
}

// DYNAMIC facet counts (C-010 / AS-025): a facet's count = the number of annotations matching THAT
// facet combined with the OTHER axes' current selection, IGNORING this facet's own axis selection.
//   • Status-facet counts are scoped to annotations whose TYPE ∈ activeType AND whose DECISION passes.
//   • Type-facet counts are scoped to annotations whose STATUS ∈ activeStatus AND whose DECISION passes.
//   • Decision-facet counts are over SUGGESTIONS only, scoped to STATUS ∈ activeStatus AND TYPE ∈ activeType.
// The decision term follows decisionAllows: a non-suggestion counts toward Status/Type only while the
// Decision axis is un-narrowed (full); once narrowed, it drops out of these counts too — so the counts
// track what the rail actually shows. With every axis fully selected the Status/Type counts equal their
// whole-doc totals. A zero-yield facet reads 0. activeDecision defaults to all so a two-axis caller is unchanged.
export function statusCounts(
  annotations: Facetable[],
  activeType: ReadonlySet<TypeFacet>,
  activeDecision: ReadonlySet<DecisionFacet> = ALL_DECISION,
): Record<StatusFacet, number> {
  const counts: Record<StatusFacet, number> = { open: 0, resolved: 0 };
  for (const a of annotations) {
    if (activeType.has(typeFacet(a)) && decisionAllows(a, activeDecision)) counts[statusFacet(a)] += 1;
  }
  return counts;
}

export function typeCounts(
  annotations: Facetable[],
  activeStatus: ReadonlySet<StatusFacet>,
  activeDecision: ReadonlySet<DecisionFacet> = ALL_DECISION,
): Record<TypeFacet, number> {
  const counts: Record<TypeFacet, number> = { markup: 0, comment: 0, redline: 0, label: 0 };
  for (const a of annotations) {
    if (activeStatus.has(statusFacet(a)) && decisionAllows(a, activeDecision)) counts[typeFacet(a)] += 1;
  }
  return counts;
}

// Decision counts are over SUGGESTIONS only (a comment/label has decisionFacet === null → contributes to
// no Decision facet), scoped to the Status + Type selections. So the Decision group sums to the number of
// visible suggestions, not the whole doc — that asymmetry with Status/Type is by design (C-010).
export function decisionCounts(
  annotations: Facetable[],
  activeStatus: ReadonlySet<StatusFacet>,
  activeType: ReadonlySet<TypeFacet>,
): Record<DecisionFacet, number> {
  const counts: Record<DecisionFacet, number> = { pending: 0, accepted: 0, rejected: 0, stale: 0 };
  for (const a of annotations) {
    const df = decisionFacet(a);
    if (df === null) continue;
    if (activeStatus.has(statusFacet(a)) && activeType.has(typeFacet(a))) counts[df] += 1;
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
  activeDecision: ReadonlySet<DecisionFacet> = ALL_DECISION,
): boolean {
  return (
    !sameFacets(activeStatus, DEFAULT_STATUS) ||
    !sameFacets(activeType, DEFAULT_TYPE) ||
    !sameFacets(activeDecision, DEFAULT_DECISION)
  );
}
