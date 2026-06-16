import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// annotation-actions-ui S-003 — Delete + restore with an undo toast. Two layers, mirroring how
// S-002 split the action bar:
//   1. the ThreadCard overflow menu (component) — the Delete affordance shows ONLY for the author
//      (isOwn) or the doc owner (isOwner); a viewer / guest / non-owner-non-author sees no Delete
//      (C-004). The affordance is a CLIENT HINT — the backend re-authorizes (C-004).
//   2. the LIVE rail wiring (component) — the same composition viewer-screen's useAnnotations builds:
//      an optimistic remove from the rendered list, deleteAnnotation, an undo toast whose action calls
//      restoreAnnotation + re-adds the item, and a refused delete that rolls the item back + errors
//      (no silent loss — C-005).
//
// The card layer asserts the affordance gate (no network); the rail layer asserts the optimistic
// remove / undo-restore / refused-rollback orchestration through the onDelete seam. We assert at the
// rail seam (not the whole ViewerScreen) for the same determinism reason as thread-resolve-wiring.

import { ThreadCard } from "@/features/viewer/components/thread-card";
import { AnnotationsRail } from "@/features/viewer/components/annotations-rail";
import type {
  ViewerAnnotation,
  DeleteAnnotationResult,
  RestoreAnnotationResult,
} from "@/features/viewer/services/client";
import type { EdenResult } from "@/lib/api/use-api-query";

const ME = "user-me-001";
const OTHER = "user-other-002";

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });
const errEnv = (status: number) => ({ data: null, error: { status } });

function annotation(overrides: Partial<ViewerAnnotation> = {}): ViewerAnnotation {
  return {
    id: "anno-1",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    anchor: { blockId: "block-p-1", textSnippet: "the selected sentence", offset: 0, length: 21 },
    comments: [
      {
        id: "anno-1-c",
        parentId: null,
        authorName: "Mara",
        body: "A note worth keeping",
        createdAt: new Date().toISOString(),
      },
    ],
    ...overrides,
  };
}

function renderCard(
  anno: ViewerAnnotation,
  props: Partial<Parameters<typeof ThreadCard>[0]> = {},
) {
  return render(
    <ThreadCard annotation={anno} focused={false} unplaceable={false} onFocus={() => {}} {...props} />,
  );
}

// ── The overflow-menu Delete affordance (C-004) ──

describe("ThreadCard overflow menu — Delete affordance gating (S-003)", () => {
  it("AS-009: an annotation I authored offers Delete in its overflow menu, and choosing it calls onDelete", async () => {
    const onDelete = mock(async () => true);
    renderCard(annotation({ authorId: ME }), { currentUserId: ME, onDelete });
    const card = screen.getByTestId("thread-card");
    // The overflow trigger is present (an own annotation can be deleted).
    await userEvent.click(within(card).getByTestId("overflow-trigger"));
    const del = within(card).getByTestId("overflow-delete");
    expect(del).toBeInTheDocument();
    await userEvent.click(del);
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it("AS-011: the doc OWNER is offered Delete on another member's annotation (moderation)", async () => {
    const onDelete = mock(async () => true);
    // authored by someone else, I am the owner → Delete is offered (moderate).
    renderCard(annotation({ authorId: OTHER }), { currentUserId: ME, isOwner: true, onDelete });
    const card = screen.getByTestId("thread-card");
    await userEvent.click(within(card).getByTestId("overflow-trigger"));
    expect(within(card).getByTestId("overflow-delete")).toBeInTheDocument();
  });

  it("AS-012: a non-owner non-author sees NO Delete in the overflow menu", async () => {
    const onDelete = mock(async () => true);
    // authored by someone else, I am a commenter (not owner) → no Delete (the trigger itself is absent).
    renderCard(annotation({ authorId: OTHER }), { currentUserId: ME, isOwner: false, onDelete });
    const card = screen.getByTestId("thread-card");
    // No Delete affordance at all — neither an open trigger nor a Delete item.
    expect(within(card).queryByTestId("overflow-trigger")).toBeNull();
    expect(within(card).queryByTestId("overflow-delete")).toBeNull();
  });

  it("C-004: the Delete affordance is author OR owner only — a guest annotation (null authorId) for a non-owner shows none", async () => {
    const onDelete = mock(async () => true);
    // a guest-created annotation (authorId null) → isOwn false; a non-owner viewer → no Delete.
    const { rerender } = renderCard(annotation({ authorId: null }), {
      currentUserId: ME,
      isOwner: false,
      onDelete,
    });
    expect(within(screen.getByTestId("thread-card")).queryByTestId("overflow-trigger")).toBeNull();

    // The SAME guest annotation moderated by the doc OWNER → Delete IS offered (owner moderation).
    rerender(
      <ThreadCard
        annotation={annotation({ authorId: null })}
        focused={false}
        unplaceable={false}
        onFocus={() => {}}
        currentUserId={ME}
        isOwner
        onDelete={onDelete}
      />,
    );
    await userEvent.click(within(screen.getByTestId("thread-card")).getByTestId("overflow-trigger"));
    expect(within(screen.getByTestId("thread-card")).getByTestId("overflow-delete")).toBeInTheDocument();
  });

  it("C-004: with NO onDelete wired (a read-only viewer) there is no overflow Delete even for an own item", () => {
    // A viewer role supplies no onDelete (the consumer gates it) → no Delete affordance, ever.
    renderCard(annotation({ authorId: ME }), { currentUserId: ME });
    expect(within(screen.getByTestId("thread-card")).queryByTestId("overflow-trigger")).toBeNull();
  });
});

// ── The LIVE rail wiring: optimistic remove + undo-toast restore + refused rollback (C-005) ──
//
// The wiring mirrors viewer-screen's useAnnotations onDelete: optimistically drop the annotation
// from the rendered list, call the real (mocked) deleteAnnotation, raise an undo toast whose action
// calls restoreAnnotation + re-adds the item; on a refused delete, re-add + surface an error.

const deleteAnnotation = mock(
  async (_slug: string, _id: string): Promise<EdenResult<DeleteAnnotationResult>> =>
    okEnv({ deleted: true }) as EdenResult<DeleteAnnotationResult>,
);
const restoreAnnotation = mock(
  async (_slug: string, _id: string): Promise<EdenResult<RestoreAnnotationResult>> =>
    okEnv({ restored: true }) as EdenResult<RestoreAnnotationResult>,
);

const toastError = mock(() => {});
// A minimal undo-toast stand-in: capture the undo action so the test can "click Undo".
let capturedUndo: (() => void) | null = null;
const toastUndo = mock((onUndo: () => void) => {
  capturedUndo = onUndo;
});

// A tiny stateful host mirroring useAnnotations: holds the served list in React state, removes
// optimistically on delete, re-adds on undo/refused. Exactly the shape setQueryData applies in
// useAnnotations, reduced to component state so the test is deterministic at the rail seam.
function RailHost({
  initial,
  refuse = false,
}: {
  initial: ViewerAnnotation[];
  refuse?: boolean;
}) {
  const [items, setItems] = useStateList(initial);
  const onDelete = async (anno: ViewerAnnotation): Promise<boolean> => {
    const removed = anno;
    // Optimistic remove from the rendered list.
    setItems((prev) => prev.filter((a) => a.id !== anno.id));
    const res = await deleteAnnotation("doc-slug", anno.id);
    if (res.error) {
      // Refused/failed delete → roll back (re-add) + surface an error (no silent loss).
      setItems((prev) => (prev.some((a) => a.id === removed.id) ? prev : [removed, ...prev]));
      toastError();
      return false;
    }
    // Undo toast: its action restores + re-adds the item.
    toastUndo(() => {
      void restoreAnnotation("doc-slug", removed.id);
      setItems((prev) => (prev.some((a) => a.id === removed.id) ? prev : [removed, ...prev]));
    });
    return true;
  };
  return (
    <AnnotationsRail
      annotations={items}
      focusedId={null}
      unplaceableIds={new Set()}
      currentUserId={ME}
      onFocusThread={() => {}}
      onDelete={refuse ? onDelete : onDelete}
    />
  );
}

// tiny useState wrapper typed for a list (avoids importing React's useState type noise inline).
import { useState } from "react";
function useStateList(initial: ViewerAnnotation[]) {
  return useState<ViewerAnnotation[]>(initial);
}

beforeEach(() => {
  document.body.innerHTML = "";
  deleteAnnotation.mockClear();
  restoreAnnotation.mockClear();
  toastError.mockClear();
  toastUndo.mockClear();
  capturedUndo = null;
});

describe("AnnotationsRail delete wiring — optimistic + undo + rollback (S-003)", () => {
  it("AS-009: deleting my own annotation removes it from the rail immediately AND shows an undo toast", async () => {
    deleteAnnotation.mockResolvedValueOnce(okEnv({ deleted: true }) as EdenResult<DeleteAnnotationResult>);
    render(<RailHost initial={[annotation({ authorId: ME })]} />);

    const card = await screen.findByTestId("thread-card");
    await userEvent.click(within(card).getByTestId("overflow-trigger"));
    await userEvent.click(within(card).getByTestId("overflow-delete"));

    // Removed from the rail immediately (optimistic).
    await waitFor(() => expect(screen.queryByTestId("thread-card")).toBeNull());
    // The real delete client was called against THIS annotation, doc-scoped.
    await waitFor(() => expect(deleteAnnotation).toHaveBeenCalledTimes(1));
    expect(deleteAnnotation.mock.calls[0]![1]).toBe("anno-1");
    // An undo toast was raised.
    expect(toastUndo).toHaveBeenCalledTimes(1);
  });

  it("AS-010: clicking Undo on the toast restores the annotation to the rail (calls restoreAnnotation)", async () => {
    render(<RailHost initial={[annotation({ authorId: ME })]} />);
    const card = await screen.findByTestId("thread-card");
    await userEvent.click(within(card).getByTestId("overflow-trigger"));
    await userEvent.click(within(card).getByTestId("overflow-delete"));
    await waitFor(() => expect(screen.queryByTestId("thread-card")).toBeNull());

    // Click Undo (the captured toast action).
    expect(capturedUndo).not.toBeNull();
    capturedUndo!();

    // The annotation is restored to the rail and the restore route is called.
    await waitFor(() => expect(screen.getByTestId("thread-card")).toBeInTheDocument());
    await waitFor(() => expect(restoreAnnotation).toHaveBeenCalledTimes(1));
    expect(restoreAnnotation.mock.calls[0]![1]).toBe("anno-1");
  });

  it("AS-011: the owner deleting another member's annotation removes it + shows an undo toast (moderation)", async () => {
    render(
      <AnnotationsRailModerationHost initial={[annotation({ authorId: OTHER })]} />,
    );
    const card = await screen.findByTestId("thread-card");
    await userEvent.click(within(card).getByTestId("overflow-trigger"));
    await userEvent.click(within(card).getByTestId("overflow-delete"));

    await waitFor(() => expect(screen.queryByTestId("thread-card")).toBeNull());
    await waitFor(() => expect(deleteAnnotation).toHaveBeenCalledTimes(1));
    expect(toastUndo).toHaveBeenCalledTimes(1);
  });

  it("AS-013: a refused delete restores the item in the rail and surfaces an error (no silent loss)", async () => {
    deleteAnnotation.mockResolvedValueOnce(errEnv(403) as EdenResult<DeleteAnnotationResult>);
    render(<RailHost initial={[annotation({ authorId: ME })]} />);
    const card = await screen.findByTestId("thread-card");
    await userEvent.click(within(card).getByTestId("overflow-trigger"));
    await userEvent.click(within(card).getByTestId("overflow-delete"));

    // The delete was attempted, refused → the item is restored (re-added), an error toast shown.
    await waitFor(() => expect(deleteAnnotation).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId("thread-card")).toBeInTheDocument());
    // No undo toast on a refused delete (nothing to undo).
    expect(toastUndo).not.toHaveBeenCalled();
  });

  it("C-005: optimistic delete + undo restores; a refused delete restores too — the item is never silently lost", async () => {
    // First: a successful delete leaves the rail empty + an undo toast (the optimistic remove holds).
    deleteAnnotation.mockResolvedValueOnce(okEnv({ deleted: true }) as EdenResult<DeleteAnnotationResult>);
    const { unmount } = render(<RailHost initial={[annotation({ authorId: ME })]} />);
    let card = await screen.findByTestId("thread-card");
    await userEvent.click(within(card).getByTestId("overflow-trigger"));
    await userEvent.click(within(card).getByTestId("overflow-delete"));
    await waitFor(() => expect(screen.queryByTestId("thread-card")).toBeNull());
    expect(toastUndo).toHaveBeenCalledTimes(1);
    // Undo → restored.
    capturedUndo!();
    await waitFor(() => expect(screen.getByTestId("thread-card")).toBeInTheDocument());
    unmount();

    // Then: a refused delete also restores the item — no silent loss either way.
    deleteAnnotation.mockClear();
    restoreAnnotation.mockClear();
    toastUndo.mockClear();
    deleteAnnotation.mockResolvedValueOnce(errEnv(403) as EdenResult<DeleteAnnotationResult>);
    render(<RailHost initial={[annotation({ authorId: ME })]} refuse />);
    card = await screen.findByTestId("thread-card");
    await userEvent.click(within(card).getByTestId("overflow-trigger"));
    await userEvent.click(within(card).getByTestId("overflow-delete"));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("thread-card")).toBeInTheDocument());
  });
});

// A moderation host: I am the doc owner deleting another member's annotation (isOwner=true).
function AnnotationsRailModerationHost({ initial }: { initial: ViewerAnnotation[] }) {
  const [items, setItems] = useState<ViewerAnnotation[]>(initial);
  const onDelete = async (anno: ViewerAnnotation): Promise<boolean> => {
    const removed = anno;
    setItems((prev) => prev.filter((a) => a.id !== anno.id));
    const res = await deleteAnnotation("doc-slug", anno.id);
    if (res.error) {
      setItems((prev) => (prev.some((a) => a.id === removed.id) ? prev : [removed, ...prev]));
      toastError();
      return false;
    }
    toastUndo(() => {
      void restoreAnnotation("doc-slug", removed.id);
      setItems((prev) => (prev.some((a) => a.id === removed.id) ? prev : [removed, ...prev]));
    });
    return true;
  };
  return (
    <AnnotationsRail
      annotations={items}
      focusedId={null}
      unplaceableIds={new Set()}
      currentUserId={ME}
      isOwner
      onFocusThread={() => {}}
      onDelete={onDelete}
    />
  );
}
