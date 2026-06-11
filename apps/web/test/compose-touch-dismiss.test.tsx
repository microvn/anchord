import { describe, it, expect, mock, afterEach } from "bun:test";
import { renderHook, act, render, waitFor } from "@testing-library/react";
import { useRef } from "react";

// MƯỢT TASK 2 (touch selection) + TASK 4 (multi-click dismiss guard).
//
// TASK 2: on a coarse pointer (touch), use-compose listens to `selectionchange` (debounced) instead
// of mouseup. We stub matchMedia('(pointer: coarse)') → matches:true, build a real happy-dom
// selection, dispatch selectionchange, advance the debounce, and assert the popover opens. A
// collapsed selection must be a no-op (C-003). The exact debounce TIMING is [→MANUAL] — here we just
// drive the timer.
//
// TASK 4: useDismissOnOutsideAndEscape ignores a multi-click (event.detail >= 2) so a triple-click
// paragraph selection survives, dismisses on a single outside mousedown, and dismisses on Escape.

mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) }),
  Toaster: () => null,
}));
// Keep the network client inert — these tests only exercise selection→popover + dismiss, not writes.
mock.module("../src/features/viewer/client", () => ({
  createAnnotation: mock(async () => ({ data: { annotationId: "a1" }, error: null })),
  addComment: mock(async () => ({ data: {}, error: null })),
}));

const { useCompose } = await import("../src/features/viewer/use-compose");
const { useDismissOnOutsideAndEscape } = await import("../src/features/viewer/use-dismiss");

const realMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

function stubCoarse(coarse: boolean) {
  window.matchMedia = ((q: string) =>
    ({
      matches: q.includes("coarse") ? coarse : false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

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

describe("MƯỢT TASK 2 — touch selection via selectionchange", () => {
  it("coarse pointer: a debounced selectionchange commits the selection → popover opens", async () => {
    stubCoarse(true);
    const pane = buildPaneWithSelection(8, 15); // "expires"
    const { result } = renderHook(() =>
      useCompose("ws-1", "doc", pane, true, () => {}),
    );
    expect(result.current.popover).toBeNull();

    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    // Drive the ~380ms debounce.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 420));
    });
    expect(result.current.popover).not.toBeNull();
    pane.remove();
  });

  it("coarse pointer: a collapsed/empty selection is a no-op (C-003)", async () => {
    stubCoarse(true);
    const pane = buildPaneWithSelection(5, 5); // collapsed
    const { result } = renderHook(() => useCompose("ws-1", "doc", pane, true, () => {}));
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 420));
    });
    expect(result.current.popover).toBeNull();
    pane.remove();
  });

  it("fine pointer: selectionchange is NOT wired (mouseup path instead)", async () => {
    stubCoarse(false);
    const pane = buildPaneWithSelection(8, 15);
    const { result } = renderHook(() => useCompose("ws-1", "doc", pane, true, () => {}));
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 420));
    });
    // No selectionchange listener on a fine pointer → still no popover.
    expect(result.current.popover).toBeNull();
    // The mouseup path still commits.
    act(() => {
      pane.dispatchEvent(new Event("mouseup", { bubbles: true }));
    });
    expect(result.current.popover).not.toBeNull();
    pane.remove();
  });
});

describe("MƯỢT TASK 4 — useDismissOnOutsideAndEscape", () => {
  function Harness({ onDismiss }: { onDismiss: () => void }) {
    const ref = useRef<HTMLDivElement>(null);
    useDismissOnOutsideAndEscape(ref, onDismiss);
    return (
      <div>
        <div ref={ref} data-testid="inside">
          popover
        </div>
        <button data-testid="outside">outside</button>
      </div>
    );
  }

  it("dismisses on a single outside mousedown", () => {
    const onDismiss = mock(() => {});
    const { getByTestId } = render(<Harness onDismiss={onDismiss} />);
    getByTestId("outside").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 1 }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("IGNORES a multi-click (detail >= 2) so triple-click selection survives", () => {
    const onDismiss = mock(() => {});
    const { getByTestId } = render(<Harness onDismiss={onDismiss} />);
    getByTestId("outside").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 3 }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("does NOT dismiss when the click is inside the ref", () => {
    const onDismiss = mock(() => {});
    const { getByTestId } = render(<Harness onDismiss={onDismiss} />);
    getByTestId("inside").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, detail: 1 }));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses on Escape", () => {
    const onDismiss = mock(() => {});
    render(<Harness onDismiss={onDismiss} />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
