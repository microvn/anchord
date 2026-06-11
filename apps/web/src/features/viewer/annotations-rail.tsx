import { Icon } from "../../components/icon";
import { ThreadCard, DetachedCard } from "./thread-card";
import type { ViewerAnnotation } from "./client";

// AnnotationsRail (S-003): the right-hand pane. Splits the annotation list into anchored threads
// (rail threads paired 1:1 to in-text highlights, C-003) and detached/orphaned annotations (the
// amber DetachedSection, C-004 — shown separately, never as anchored). Header shows the anchored
// thread count; an empty list shows the "no comments yet" empty state (AS-015). Clicking a thread
// focuses + scrolls to its highlight (AS-009) — the parent wires onFocusThread.

export function AnnotationsRail({
  annotations,
  focusedId,
  unplaceableIds,
  onFocusThread,
  onReply,
  composer,
}: {
  annotations: ViewerAnnotation[];
  focusedId: string | null;
  /** ids the FE couldn't anchor at runtime (GAP-005) — flagged, no scroll target. */
  unplaceableIds: Set<string>;
  onFocusThread: (id: string) => void;
  /** S-003: send a reply to a specific anchored thread. The rail binds this per-thread to the
   *  ThreadCard's onReply(body); the consumer wires addComment({ body, parentId }) with parentId =
   *  the annotation's first/root comment. Returns false on a refused/failed write so the card rolls
   *  back its optimistic reply (no ghost). Absent → a read-only rail (viewer role, C-004). */
  onReply?: (annotation: ViewerAnnotation, body: string) => Promise<boolean>;
  /** S-001: the compose box (Composer) when a comment is in progress; mounts at the TOP of the
   *  rail so the in-progress comment + its new thread read top-down. Absent on a read-only rail
   *  (viewer role / no active selection) — the rail stays read-only (C-004). */
  composer?: React.ReactNode;
}) {
  const anchored = annotations.filter((a) => !a.isOrphaned);
  const detached = annotations.filter((a) => a.isOrphaned);
  // The composer (when present) keeps the rail out of its empty state — there's something to show.
  const isEmpty = annotations.length === 0 && !composer;

  return (
    <div data-testid="annotations-rail" className="flex h-full flex-col">
      <div className="flex flex-none items-center gap-2 border-b border-line px-4 py-3">
        <Icon name="inbox" size={15} />
        <span className="text-[13px] font-semibold text-ink">Comments</span>
        <span
          data-testid="rail-count"
          className="ml-auto rounded-full bg-sunken px-2 py-0.5 text-[11px] font-medium text-subtle"
        >
          {anchored.length}
        </span>
      </div>

      {isEmpty ? (
        <div
          data-testid="rail-empty"
          className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-subtle"
        >
          <Icon name="inbox" size={24} />
          <div className="text-[13px] font-medium text-ink">No comments yet</div>
          <div className="text-[12px]">Comments will appear here.</div>
        </div>
      ) : (
        <div className="flex-1 space-y-2 overflow-auto p-3">
          {composer}
          {anchored.map((a) => (
            <ThreadCard
              key={a.id}
              annotation={a}
              focused={focusedId === a.id}
              unplaceable={unplaceableIds.has(a.id)}
              onFocus={onFocusThread}
              // S-003: bind the rail reply to THIS thread; the card hands us only the body.
              onReply={onReply ? (body) => onReply(a, body) : undefined}
            />
          ))}

          {detached.length > 0 && (
            <section data-testid="detached-section" className="space-y-2 pt-2">
              <div className="flex items-center gap-1.5 px-1 text-[11px] font-medium text-amber">
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
