import { useState } from "react";
import { Icon } from "@/components/icon";
import { ThreadCard, DetachedCard } from "./thread-card";
import { FilterPopover } from "./filter-popover";
import {
  type StatusFacet,
  type TypeFacet,
  ALL_STATUS,
  ALL_TYPE,
  isShown,
  statusCounts as computeStatusCounts,
  typeCounts as computeTypeCounts,
  isFilterActive,
} from "@/features/viewer/lib/annotation-filter";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

// AnnotationsRail (S-003): the right-hand pane. Splits the annotation list into anchored threads
// (rail threads paired 1:1 to in-text highlights, C-003) and detached/orphaned annotations (the
// amber DetachedSection, C-004 — shown separately, never as anchored). Clicking a thread focuses +
// scrolls to its highlight (AS-009) — the parent wires onFocusThread.
//
// S-007 (REWORKED 2026-06-16): the header carries the doc total + a "showing X of N" signal + a
// Filter control that opens a TWO-AXIS filter popover (Status {Open, Resolved} × Type {Markup,
// Comment, Redline, Label}). A thread shows iff its status facet AND its type facet are both selected
// (OR within an axis, AND across — C-009); both axes default all-selected. Toggling a facet OFF hides
// its threads from the list AND dims their in-text highlights (the dim rides the placer's `filtered`
// flag, wired in viewer-screen); the detached section ALWAYS renders regardless of facet state
// (C-004). Any axis fully empty → a distinct no-match state (≠ the empty-doc state, AS-026). The
// facet SETS + toggles are lifted to viewer-screen so the SAME selection drives the mark dimming;
// the popover open/close is local rail state.

export function AnnotationsRail({
  annotations,
  focusedId,
  unplaceableIds,
  currentUserId,
  isOwner,
  activeStatus = ALL_STATUS,
  activeType = ALL_TYPE,
  onToggleStatus,
  onToggleType,
  onResetFilter,
  onFocusThread,
  onReply,
  onResolve,
  onDecide,
  onDelete,
}: {
  annotations: ViewerAnnotation[];
  focusedId: string | null;
  /** S-007 (C-009): which Status / Type facets are active (their threads shown). Default all-selected.
   *  The parent (viewer-screen) owns these so the SAME selection also drives the in-text mark dimming. */
  activeStatus?: ReadonlySet<StatusFacet>;
  activeType?: ReadonlySet<TypeFacet>;
  /** S-007 (C-011): toggle a facet on/off (applies LIVE). Absent → the Filter control is read-only. */
  onToggleStatus?: (f: StatusFacet) => void;
  onToggleType?: (f: TypeFacet) => void;
  /** S-007 (AS-027): Reset re-selects every facet on both axes. */
  onResetFilter?: () => void;
  /** ids the FE couldn't anchor at runtime (GAP-005) — flagged, no scroll target. */
  unplaceableIds: Set<string>;
  /** annotation-actions-ui S-001 (C-001): the current session user id, forwarded to each ThreadCard
   *  so it can mark own-vs-others from the durable `authorId`. Null/undefined for a signed-out
   *  viewer (owns nothing). */
  currentUserId?: string | null;
  /** annotation-actions-ui S-002 (C-002): the session is the doc OWNER. Forwarded to each ThreadCard
   *  so the proposal close family (Accept/Reject pending, Reopen decided) shows only to the owner. A
   *  client hint; the backend re-authorizes. Default false (non-owner / read-only rail). */
  isOwner?: boolean;
  onFocusThread: (id: string) => void;
  /** S-002: OWNER-only accept/reject of a redline. The rail binds it per-thread to the ThreadCard's
   *  onDecide(decision); the consumer wires decideSuggestion. Absent → no Accept/Reject row (non-
   *  owner, C-002). Deciding auto-resolves the thread. */
  onDecide?: (annotation: ViewerAnnotation, decision: "accept" | "reject") => Promise<boolean>;
  /** S-003: send a reply to a specific anchored thread. The rail binds this per-thread to the
   *  ThreadCard's onReply(body); the consumer wires addComment({ body, parentId }) with parentId =
   *  the annotation's first/root comment. Returns false on a refused/failed write so the card rolls
   *  back its optimistic reply (no ghost). Absent → a read-only rail (viewer role, C-004). */
  onReply?: (annotation: ViewerAnnotation, body: string) => Promise<boolean>;
  /** S-004: resolve / reopen a specific anchored thread. The rail binds this per-thread to the
   *  ThreadCard's onResolve(resolved); the consumer wires setResolution({ resolved }). Returns false
   *  on a refused/failed write so the card rolls back its optimistic toggle. Absent → no Resolve
   *  control (viewer role, C-004/C-006 — resolve is comment-gated, not author-gated). */
  onResolve?: (annotation: ViewerAnnotation, resolved: boolean) => Promise<boolean>;
  /** annotation-actions-ui S-003 (C-004/C-005): delete a specific anchored thread. The rail binds
   *  this per-thread to the ThreadCard's onDelete(); the consumer (viewer-screen) owns the optimistic
   *  remove + undo toast + restore. The ThreadCard only shows the Delete affordance for the author or
   *  the doc owner (canDelete) AND when this is wired. Absent → no Delete affordance (read-only / a
   *  rail with no delete capability). */
  onDelete?: (annotation: ViewerAnnotation) => unknown | Promise<unknown>;
}) {
  const [filterOpen, setFilterOpen] = useState(false);

  const anchored = annotations.filter((a) => !a.isOrphaned);
  const detached = annotations.filter((a) => a.isOrphaned);
  // #3 (2026-06-12): the composer moved to an inline popover at the selection — the rail no longer
  // hosts the composing UI, so the empty state is purely a function of the annotation count.
  const isEmpty = annotations.length === 0;

  // S-007 (C-009): the rail thread list shows only the ANCHORED threads whose status AND type facets
  // are both selected (the combine predicate). The "showing X of N" header counts the ANCHORED set
  // (detached lives in its own always-rendered section, C-004): N = anchored total, X = matched.
  const visibleAnchored = anchored.filter((a) => isShown(a, activeStatus, activeType));
  const showing = visibleAnchored.length;
  const total = anchored.length;

  // C-010: the DYNAMIC facet counts — each axis scoped to the OTHER axis's current selection, over the
  // WHOLE active set (anchored + detached: a detached item is counted into its facets too, C-009).
  const statusCounts = computeStatusCounts(annotations, activeType);
  const typeCounts = computeTypeCounts(annotations, activeStatus);
  const filterActive = isFilterActive(activeStatus, activeType);

  // AS-026: an axis fully deselected → no thread can match → the no-match state (distinct from the
  // empty-doc state). Only when the doc HAS annotations (an empty doc shows the empty state).
  const noMatch = !isEmpty && showing === 0;

  return (
    <div data-testid="annotations-rail" className="flex h-full flex-col">
      {/* S-007: the header — the label, the "showing X of N" total signal, and a Filter control that
          opens the two-axis popover. An empty doc shows just the label (nothing to filter). */}
      <div className="relative flex h-11 flex-none items-center gap-2 border-b border-line px-3.5">
        {/* #3 (2026-06-12): the rail hosts ALL annotation types globally — label "Annotations". */}
        <span className="text-[13px] font-semibold text-ink">Annotations</span>
        {!isEmpty && (
          <>
            {/* C-011: "showing X of N" while narrowed; just the total when the filter is inactive. */}
            <span data-testid="rail-showing" className="font-mono text-[11px] text-subtle">
              {filterActive ? `showing ${showing} of ${total}` : total}
            </span>
            <button
              type="button"
              data-testid="filter-control"
              aria-haspopup="dialog"
              aria-expanded={filterOpen}
              // C-011: the Filter control reads ACTIVE while the filter is narrowed (any facet off).
              data-active={filterActive ? "true" : undefined}
              aria-label={filterActive ? "Filter (active)" : "Filter"}
              onClick={() => setFilterOpen((o) => !o)}
              className={[
                "ml-auto inline-flex items-center gap-1 rounded-[6px] border px-2 py-1 text-[11px] font-semibold transition-colors",
                filterActive
                  ? "border-accent/40 bg-accent-soft text-accent"
                  : "border-line bg-transparent text-subtle hover:text-ink",
              ].join(" ")}
            >
              <Icon name="list" size={12} />
              <span>Filter</span>
            </button>
            {filterOpen && (
              <FilterPopover
                activeStatus={activeStatus}
                activeType={activeType}
                statusCounts={statusCounts}
                typeCounts={typeCounts}
                onToggleStatus={(f) => onToggleStatus?.(f)}
                onToggleType={(f) => onToggleType?.(f)}
                onReset={() => onResetFilter?.()}
                onDismiss={() => setFilterOpen(false)}
              />
            )}
          </>
        )}
      </div>

      {isEmpty ? (
        <div
          data-testid="rail-empty"
          className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-[30px] text-center text-muted"
        >
          <Icon name="highlight" size={24} className="text-subtle" />
          <div className="text-[13px] font-semibold text-ink">No annotations yet</div>
          <div className="text-[12px] leading-[1.5]">Annotations will appear here.</div>
        </div>
      ) : noMatch ? (
        // AS-026: no thread matches → a no-match state DISTINCT from the empty-doc state. The detached
        // section still renders below (C-004 — the filter never hides it).
        <div className="flex flex-1 flex-col gap-[10px] overflow-auto p-3">
          <div
            data-testid="rail-no-match"
            className="flex flex-col items-center justify-center gap-2 px-6 py-[30px] text-center text-muted"
          >
            <Icon name="search" size={24} className="text-subtle" />
            <div className="text-[13px] font-semibold text-ink">No annotations match the filter</div>
            <div className="text-[12px] leading-[1.5]">Turn a facet back on, or Reset the filter.</div>
          </div>
          {detached.length > 0 && <DetachedSection detached={detached} />}
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-[10px] overflow-auto p-3">
          {visibleAnchored.map((a) => (
            <ThreadCard
              key={a.id}
              annotation={a}
              focused={focusedId === a.id}
              unplaceable={unplaceableIds.has(a.id)}
              onFocus={onFocusThread}
              // S-001: forward the session user id so the card derives own-vs-others from authorId.
              currentUserId={currentUserId}
              // S-002: forward owner-ness so the proposal close family (Accept/Reject / Reopen) gates.
              isOwner={isOwner}
              // S-003: bind the rail reply to THIS thread; the card hands us only the body.
              onReply={onReply ? (body) => onReply(a, body) : undefined}
              // S-004: bind resolve/reopen to THIS thread; the card hands us only the next state.
              onResolve={onResolve ? (resolved) => onResolve(a, resolved) : undefined}
              // S-002: bind owner accept/reject to THIS thread; the card hands us only the decision.
              onDecide={onDecide ? (decision) => onDecide(a, decision) : undefined}
              // S-003: bind delete to THIS thread; the card surfaces the overflow Delete (canDelete).
              onDelete={onDelete ? () => onDelete(a) : undefined}
            />
          ))}

          {detached.length > 0 && <DetachedSection detached={detached} />}
        </div>
      )}
    </div>
  );
}

// S-004/C-004: the amber detached section — orphaned annotations, shown separately, never as
// anchored. S-007 (C-009): it ALWAYS renders regardless of filter state (the filter narrows only the
// anchored thread list), so it's a shared component used by both the normal and the no-match body.
function DetachedSection({ detached }: { detached: ViewerAnnotation[] }) {
  return (
    <section data-testid="detached-section" className="flex flex-col gap-[10px] pt-1">
      <div className="flex items-center gap-[7px] px-0.5 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-amber">
        <Icon name="alert" size={12} />
        <span data-testid="detached-count">{detached.length} detached</span>
      </div>
      {detached.map((a) => (
        <DetachedCard key={a.id} annotation={a} />
      ))}
    </section>
  );
}
