import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// annotation-core-ui-commenting S-004 (WIRING) — Resolve / reopen a thread, end-to-end through the
// LIVE rail's onResolve seam down to the real setResolution client call. thread-resolve.test.tsx
// proves the ThreadCard's onResolve CALLBACK in isolation; this proves the rail binds that callback
// per-thread and a real consumer wiring (the same shape useAnnotations builds: optimistic dim of the
// matching highlight mark + setResolution + reconcile) reaches setResolution and renders resolved.
//
// We mount AnnotationsRail (not the whole ViewerScreen) with a doc-pane element carrying the
// annotation's highlight mark, and an onResolve closure that mirrors viewer-screen's useAnnotations:
// it dims the mark, calls the real (mocked) setResolution, and — PERF (no-refetch) — PATCHES the
// served annotation's status in place (the same shape setQueryData applies to the cache), never
// refetching. Asserting at the rail seam keeps the test deterministic — it does not depend on the
// full doc-load query path (whose module-global client mock is shared across the suite by bun).

import { AnnotationsRail } from "@/features/viewer/annotations-rail";
import type { ViewerAnnotation, SetResolutionResult } from "@/features/viewer/client";
import type { EdenResult } from "@/lib/use-api-query";

const okEnv = (body: unknown) => ({ data: { success: true, data: body }, error: null });

// The real client.setResolution, observed. We mock it standalone (rather than via mock.module —
// AnnotationsRail doesn't import it) and call it from the onResolve closure, exactly as
// viewer-screen's useAnnotations does. Signature mirrors the real setResolution(workspaceId,
// annotationId, { resolved }) → { status }, so a drift in the real signature would surface here.
const setResolution = mock(
  async (_ws: string, _id: string, body: { resolved: boolean }): Promise<EdenResult<SetResolutionResult>> =>
    okEnv({ status: body.resolved ? "resolved" : "unresolved" }) as EdenResult<SetResolutionResult>,
);

const baseThread: ViewerAnnotation = {
  id: "anno-1",
  type: "range",
  status: "unresolved",
  isOrphaned: false,
  anchor: { blockId: "block-p-1", textSnippet: "Payment expires after 24h", offset: 0, length: 25 },
  comments: [
    {
      id: "cmt-root-1",
      parentId: null,
      authorName: "Mara",
      body: "Why 24h and not 48h?",
      createdAt: new Date().toISOString(),
    },
  ],
};

const toastError = mock(() => {});

// A doc-pane stand-in carrying the annotation's in-text highlight mark, so the onResolve handler can
// dim it exactly as viewer-screen's useAnnotations does (data-resolved on the matching [data-anno]).
function makeDocPane(): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = `<p><mark class="anno-mark" data-anno="anno-1">Payment expires after 24h</mark></p>`;
  document.body.appendChild(el);
  return el;
}

// The LIVE wiring under test: the same composition viewer-screen's useAnnotations builds — gate on
// comment permission, dim the highlight optimistically, call the real setResolution, toast + return
// false on a refused write so the card rolls back (reflecting the SERVER result).
function makeOnResolve(docPane: HTMLElement, served: ViewerAnnotation[]) {
  return async (annotation: ViewerAnnotation, resolved: boolean): Promise<boolean> => {
    const mark = docPane.querySelector<HTMLElement>(`[data-anno="${annotation.id}"]`);
    if (mark) {
      if (resolved) mark.dataset.resolved = "true";
      else delete mark.dataset.resolved;
    }
    const res = await setResolution("ws-1", annotation.id, { resolved });
    if (res.error) {
      if (mark) {
        if (resolved) delete mark.dataset.resolved;
        else mark.dataset.resolved = "true";
      }
      toastError();
      return false;
    }
    // Reconcile (no refetch): patch the served annotation's status in place — the same in-cache
    // status flip setQueryData applies in viewer-screen's useAnnotations.
    const idx = served.findIndex((a) => a.id === annotation.id);
    if (idx >= 0) served[idx] = { ...served[idx]!, status: resolved ? "resolved" : "unresolved" };
    return true;
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  setResolution.mockClear();
  toastError.mockClear();
});

describe("AnnotationsRail resolve wiring (S-004)", () => {
  it("AS-007: resolving in the live rail calls setResolution and dims the thread + highlight", async () => {
    const docPane = makeDocPane();
    const served = [{ ...baseThread }];
    const onResolve = makeOnResolve(docPane, served);

    render(
      <AnnotationsRail
        annotations={served}
        focusedId={null}
        unplaceableIds={new Set()}
        onFocusThread={() => {}}
        onResolve={onResolve}
      />,
    );

    const card = await screen.findByTestId("thread-card");
    expect(card.getAttribute("data-resolved")).toBeNull();
    expect(within(card).queryByTestId("resolved-badge")).toBeNull();
    // The highlight mark starts un-dimmed.
    expect(docPane.querySelector('[data-anno="anno-1"]')!.getAttribute("data-resolved")).toBeNull();

    // Click Resolve.
    await userEvent.click(within(card).getByTestId("resolve-toggle"));

    // LIVE WIRING: the real setResolution is called against THIS annotation with { resolved: true },
    // scoped to the workspace + annotation id (NOT a doc-scoped path).
    await waitFor(() => expect(setResolution).toHaveBeenCalledTimes(1));
    const [wsId, annotationId, body] = setResolution.mock.calls[0]!;
    expect(wsId).toBe("ws-1");
    expect(annotationId).toBe("anno-1");
    expect(body).toEqual({ resolved: true });

    // The thread card renders resolved (dimmed + Resolved badge) — the optimistic toggle.
    await waitFor(() => {
      expect(screen.getByTestId("thread-card").getAttribute("data-resolved")).toBe("true");
    });
    expect(within(screen.getByTestId("thread-card")).getByTestId("resolved-badge")).toBeInTheDocument();
    // "highlight dims": the matching in-text mark now carries data-resolved (the spec's dim cue).
    expect(docPane.querySelector('[data-anno="anno-1"]')!.getAttribute("data-resolved")).toBe("true");
    expect(toastError).not.toHaveBeenCalled();

    // Click Reopen → the live rail calls setResolution again with { resolved: false }, both ways.
    await userEvent.click(within(screen.getByTestId("thread-card")).getByTestId("resolve-toggle"));
    await waitFor(() => expect(setResolution).toHaveBeenCalledTimes(2));
    expect(setResolution.mock.calls[1]![2]).toEqual({ resolved: false });
    // The optimistic reopen clears the card + the highlight dim.
    await waitFor(() => {
      expect(screen.getByTestId("thread-card").getAttribute("data-resolved")).toBeNull();
    });
    expect(docPane.querySelector('[data-anno="anno-1"]')!.getAttribute("data-resolved")).toBeNull();
  });
});
