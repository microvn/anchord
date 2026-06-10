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
}: {
  annotations: ViewerAnnotation[];
  focusedId: string | null;
  /** ids the FE couldn't anchor at runtime (GAP-005) — flagged, no scroll target. */
  unplaceableIds: Set<string>;
  onFocusThread: (id: string) => void;
}) {
  const anchored = annotations.filter((a) => !a.isOrphaned);
  const detached = annotations.filter((a) => a.isOrphaned);
  const isEmpty = annotations.length === 0;

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
          {anchored.map((a) => (
            <ThreadCard
              key={a.id}
              annotation={a}
              focused={focusedId === a.id}
              unplaceable={unplaceableIds.has(a.id)}
              onFocus={onFocusThread}
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
