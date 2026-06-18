import { Icon } from "@/components/icon";
import { ThreadCard, DetachedCard } from "./thread-card";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

// AnnotationsRail (S-003): the right-hand pane. Splits the annotation list into anchored threads
// (rail threads paired 1:1 to in-text highlights, C-003) and detached/orphaned annotations (the
// amber DetachedSection, C-004 — shown separately, never as anchored). Clicking a thread focuses +
// scrolls to its highlight (AS-009) — the parent wires onFocusThread.
//
// S-007 (C-009): the header summarizes the ACTIVE set as three status chips (Open · Resolved ·
// Suggestion — icon + count) that PARTITION it, replacing the single total. Each chip is an
// independent multi-toggle, all active by default. Toggling a chip OFF hides its group from the
// thread list AND dims its in-text highlights (the dim rides the placer's `filtered` flag, wired in
// viewer-screen); toggling ON restores both. The detached section ALWAYS renders regardless of chip
// state (C-004). No chip selected → a distinct no-match state (≠ the empty-doc state, AS-025).

// S-007 (C-009): the three status-chip buckets. A chip is keyed on identity, not the noun: the chips
// PARTITION the active set so the counts always sum to the active total.
export type ChipKey = "open" | "resolved" | "suggestion";

// Partition an annotation into exactly one chip (C-009 ordering): Suggestion FIRST (type=suggestion,
// ANY lifecycle — a decided/resolved suggestion still partitions as Suggestion, never Resolved),
// then Resolved (not a suggestion, status resolved), then Open (everything else). Detached/orphaned
// items partition by the SAME rule (they're counted into their chip; the detached section is C-004).
export function annotationBucket(a: Pick<ViewerAnnotation, "type" | "status">): ChipKey {
  if (a.type === "suggestion") return "suggestion";
  if (a.status === "resolved") return "resolved";
  return "open";
}

// Count the active set by chip — the three counts sum to the active total (the partition invariant).
export function bucketCounts(
  annotations: Pick<ViewerAnnotation, "type" | "status">[],
): Record<ChipKey, number> {
  const counts: Record<ChipKey, number> = { open: 0, resolved: 0, suggestion: 0 };
  for (const a of annotations) counts[annotationBucket(a)] += 1;
  return counts;
}

// The default chip filter — all three active (every group shown).
export const ALL_CHIPS_ACTIVE: ReadonlySet<ChipKey> = new Set<ChipKey>(["open", "resolved", "suggestion"]);

// Chip display metadata (DESIGN.md: compact icon + count; existing glyphs, no new SVG):
//   Open       → `clock` (an unresolved/pending thread)
//   Resolved   → `check` (closed)
//   Suggestion → `highlight` (the annotate/proposal glyph; distinct from edit/email)
const CHIP_META: Record<ChipKey, { label: string; icon: string }> = {
  open: { label: "Open", icon: "clock" },
  resolved: { label: "Resolved", icon: "check" },
  suggestion: { label: "Suggestion", icon: "highlight" },
};
const CHIP_ORDER: ChipKey[] = ["open", "resolved", "suggestion"];

export function AnnotationsRail({
  annotations,
  focusedId,
  unplaceableIds,
  currentUserId,
  isOwner,
  activeChips = ALL_CHIPS_ACTIVE,
  onToggleChip,
  onFocusThread,
  onReply,
  onResolve,
  onDecide,
  onDelete,
}: {
  annotations: ViewerAnnotation[];
  focusedId: string | null;
  /** S-007 (C-009): which status chips are active (their groups shown). Defaults to all three. The
   *  parent (viewer-screen) owns this so the SAME set also drives the in-text mark dimming. */
  activeChips?: ReadonlySet<ChipKey>;
  /** S-007 (C-009): toggle a chip on/off. Absent → the chips render but are inert (read-only). */
  onToggleChip?: (chip: ChipKey) => void;
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
  const anchored = annotations.filter((a) => !a.isOrphaned);
  const detached = annotations.filter((a) => a.isOrphaned);
  // #3 (2026-06-12): the composer moved to an inline popover at the selection — the rail no longer
  // hosts the composing UI, so the empty state is purely a function of the annotation count.
  const isEmpty = annotations.length === 0;

  // S-007 (C-009): the chip counts PARTITION the ACTIVE set (anchored + detached — a detached item is
  // counted into its chip too, AND still shows in the detached section). The thread list, by
  // contrast, only shows the ANCHORED threads whose chip is active.
  const counts = bucketCounts(annotations);
  const visibleAnchored = anchored.filter((a) => activeChips.has(annotationBucket(a)));
  // No chip selected → the no-match state (distinct from the empty-doc state). Only when the doc HAS
  // annotations (an empty doc shows the empty state regardless of chip selection).
  const noMatch = !isEmpty && activeChips.size === 0;

  return (
    <div data-testid="annotations-rail" className="flex h-full flex-col">
      {/* S-007: the header summarizes the active set as three status chips, replacing the single
          total. An empty doc shows just the label (nothing to summarize). */}
      <div className="flex h-11 flex-none items-center gap-1.5 border-b border-line px-3.5">
        {/* #3 (2026-06-12): the rail hosts ALL annotation types globally — label "Annotations". */}
        <span className="text-[13px] font-semibold text-ink">Annotations</span>
        {!isEmpty && (
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="Filter annotations by status">
            {CHIP_ORDER.map((chip) => {
              const meta = CHIP_META[chip];
              const active = activeChips.has(chip);
              return (
                <button
                  key={chip}
                  type="button"
                  data-testid={`chip-${chip}`}
                  data-count={counts[chip]}
                  aria-pressed={active}
                  aria-label={`${meta.label} ${counts[chip]}`}
                  title={`${meta.label} · ${counts[chip]}`}
                  onClick={() => onToggleChip?.(chip)}
                  className={[
                    "inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-1 font-mono text-[11px] font-semibold transition-colors",
                    onToggleChip ? "cursor-pointer" : "cursor-default",
                    active
                      ? "border-accent/40 bg-accent-soft text-accent"
                      : "border-line bg-transparent text-subtle hover:text-ink",
                  ].join(" ")}
                >
                  <Icon name={meta.icon} size={12} />
                  <span>{counts[chip]}</span>
                </button>
              );
            })}
          </div>
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
        // AS-025: no chip selected → a no-match state DISTINCT from the empty-doc state. The detached
        // section still renders below (C-004 — toggles never hide it).
        <div className="flex flex-1 flex-col gap-[10px] overflow-auto p-3">
          <div
            data-testid="rail-no-match"
            className="flex flex-col items-center justify-center gap-2 px-6 py-[30px] text-center text-muted"
          >
            <Icon name="search" size={24} className="text-subtle" />
            <div className="text-[13px] font-semibold text-ink">No annotations match the filter</div>
            <div className="text-[12px] leading-[1.5]">Turn a status chip back on to see its annotations.</div>
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
// anchored. S-007 (C-009): it ALWAYS renders regardless of chip state (the chips filter only the
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
