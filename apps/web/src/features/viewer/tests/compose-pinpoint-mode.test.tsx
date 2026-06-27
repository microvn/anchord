import { describe, it, expect, mock, afterEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";

// pinpoint S-001 (AS-002 / C-001): in Pinpoint mode a text drag-selection NEVER raises the
// selection→create popover — only a block click creates (block-pick is S-002). The suppression
// gate lives in use-compose (NOT the toolbar): the mouseup/selectionchange commit path only opens
// the popover when inputMode === "select". Switching back to Select restores the normal create.
//
// The toolbar owns the chip; viewer-screen OWNS the inputMode state and threads it into useCompose.
// This file exercises the gate at the hook seam (the toolbar test cannot reach it).

mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) }),
  Toaster: () => null,
}));
mock.module("@/features/viewer/services/client", () => ({
  createAnnotation: mock(async () => ({ data: { annotationId: "a1" }, error: null })),
  addComment: mock(async () => ({ data: {}, error: null })),
  deleteAnnotation: mock(async () => ({ data: { success: true, data: { deleted: true } }, error: null })),
  restoreAnnotation: mock(async () => ({ data: { success: true, data: { restored: true } }, error: null })),
  dismissAnnotation: mock(async () => ({ data: { success: true, data: { dismissed: true } }, error: null })),
  reattachAnnotation: mock(async () => ({ data: { success: true, data: { isOrphaned: false } }, error: null })),
}));

const { useCompose } = await import("@/features/viewer/hooks/use-compose");

const realMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

/** Build a doc pane with one block, select chars [start,end), return the pane element. */
function buildPaneWithSelection(start: number, end: number): HTMLElement {
  const pane = document.createElement("main");
  pane.innerHTML = '<p id="block-p-1">Payment expires after 24h</p>';
  document.body.appendChild(pane);
  const p = pane.querySelector("p")!;
  const range = document.createRange();
  range.setStart(p.firstChild!, start);
  range.setEnd(p.firstChild!, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
  return pane;
}

describe("pinpoint S-001 — selection suppressed in Pinpoint mode (AS-002 / C-001)", () => {
  it("AS-002: a non-empty text drag in Pinpoint mode does NOT raise the create popover", () => {
    const pane = buildPaneWithSelection(8, 15); // "expires"
    // inputMode = "pinpoint" → the selection commit is inert for annotation create.
    const { result } = renderHook(() =>
      useCompose("doc", pane, true, null, () => {}, undefined, null, false, undefined, null, "pinpoint"),
    );
    expect(result.current.popover).toBeNull();
    act(() => {
      pane.dispatchEvent(new Event("mouseup", { bubbles: true }));
    });
    // C-001: the drag is inert in Pinpoint — no popover, nothing to create.
    expect(result.current.popover).toBeNull();
    pane.remove();
  });

  it("AS-002: switching back to Select restores the normal text-selection create", () => {
    const pane = buildPaneWithSelection(8, 15); // "expires"
    const { result, rerender } = renderHook(
      ({ mode }: { mode: "select" | "pinpoint" }) =>
        useCompose("doc", pane, true, null, () => {}, undefined, null, false, undefined, null, mode),
      { initialProps: { mode: "pinpoint" as "select" | "pinpoint" } },
    );
    // In Pinpoint, the drag is inert.
    act(() => {
      pane.dispatchEvent(new Event("mouseup", { bubbles: true }));
    });
    expect(result.current.popover).toBeNull();

    // Toggle to Select → the listener now commits the selection on the next mouseup.
    rerender({ mode: "select" });
    act(() => {
      pane.dispatchEvent(new Event("mouseup", { bubbles: true }));
    });
    expect(result.current.popover).not.toBeNull();
    pane.remove();
  });

  it("AS-002: in Select mode (default) a text drag raises the popover as before (no regression)", () => {
    const pane = buildPaneWithSelection(8, 15); // "expires"
    const { result } = renderHook(() =>
      useCompose("doc", pane, true, null, () => {}, undefined, null, false, undefined, null, "select"),
    );
    act(() => {
      pane.dispatchEvent(new Event("mouseup", { bubbles: true }));
    });
    expect(result.current.popover).not.toBeNull();
    pane.remove();
  });
});
