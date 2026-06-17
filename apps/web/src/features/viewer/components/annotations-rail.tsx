import { Icon } from "@/components/icon";
import { ThreadCard, DetachedCard } from "./thread-card";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

// AnnotationsRail (S-003): the right-hand pane. Splits the annotation list into anchored threads
// (rail threads paired 1:1 to in-text highlights, C-003) and detached/orphaned annotations (the
// amber DetachedSection, C-004 — shown separately, never as anchored). Header shows the anchored
// thread count; an empty list shows the "no comments yet" empty state (AS-015). Clicking a thread
// focuses + scrolls to its highlight (AS-009) — the parent wires onFocusThread.

export function AnnotationsRail({
  annotations,
  focusedId,
  unplaceableIds,
  currentUserId,
  isOwner,
  onFocusThread,
  onReply,
  onResolve,
  onDecide,
  onDelete,
}: {
  annotations: ViewerAnnotation[];
  focusedId: string | null;
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

  return (
    <div data-testid="annotations-rail" className="flex h-full flex-col">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-line px-3.5">
        <Icon name="highlight" size={15} />
        {/* #3 (2026-06-12): the rail hosts ALL annotation types globally, not just comments —
            user-visible label renamed "Comments" → "Annotations" (internal ids/APIs unchanged). */}
        <span className="text-[13px] font-semibold text-ink">Annotations</span>
        <span
          data-testid="rail-count"
          className="ml-auto font-mono text-[11px] text-subtle"
        >
          {anchored.length}
        </span>
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
      ) : (
        <div className="flex flex-1 flex-col gap-[10px] overflow-auto p-3">
          {anchored.map((a) => (
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

          {detached.length > 0 && (
            <section data-testid="detached-section" className="flex flex-col gap-[10px] pt-1">
              <div className="flex items-center gap-[7px] px-0.5 py-1 font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-amber">
                <Icon name="alert" size={12} />
                <span data-testid="detached-count">{detached.length} detached</span>
              </div>
              {detached.map((a) => (
                <DetachedCard key={a.id} annotation={a} />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
