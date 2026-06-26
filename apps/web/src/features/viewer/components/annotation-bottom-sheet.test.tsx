import { describe, it, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { AnnotationBottomSheet } from "@/features/viewer/components/annotation-bottom-sheet";
import { useHoverPin } from "@/features/viewer/hooks/use-hover-pin";
import { useAnnotationMarks, type PlaceableAnnotation } from "@/features/viewer/components/annotation-marks";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

// S-004 — tap a marker on mobile to open a thread sheet. On a touch / narrow (drawer-mode) device
// there is no hover, so tapping a marker opens a BOTTOM SHEET hosting the full interactive ThreadCard
// (reused verbatim) — the mobile/touch counterpart of the desktop pinned card. The desktop hover-peek
// never appears on touch (AS-019). At most one sheet/pin open at a time (C-002). Actions are role-gated
// by reusing the ThreadCard's own per-role gating (C-005 → AS-020).
//
// happy-dom has no layout (getBoundingClientRect → 0), so these tests assert the COMPONENT content +
// the open/close WIRING + the drawer-mode tap routing — not live slide animation (that's [→MANUAL]).

beforeEach(() => {
  document.body.innerHTML = "";
});

const comment = (id: string, body: string, author: string, createdAt = "1h") => ({
  id,
  parentId: null as string | null,
  authorName: author,
  body,
  createdAt,
});

function annotation(over: Partial<ViewerAnnotation> = {}): ViewerAnnotation {
  return {
    id: "a1",
    type: "range",
    status: "unresolved",
    isOrphaned: false,
    anchor: { blockId: "block-p-1", textSnippet: "tokens before the refresh", offset: 0, length: 25 },
    comments: [
      comment("c1", "Root note.", "Jane Smith", "2h"),
      comment("c2", "First reply.", "Bob Lee", "1h"),
    ],
    authorId: "user-jane",
    ...over,
  };
}

// Commenter wiring — Reply + Resolve present (matches the rail's commenter bindings).
function commenterProps() {
  return {
    focused: false,
    unplaceable: false,
    onFocus: () => {},
    currentUserId: "user-bob",
    isOwner: false,
    onReply: async () => true,
    onResolve: async () => true,
  };
}

describe("AnnotationBottomSheet (S-004)", () => {
  it("AS-018: a tapped marker opens a bottom sheet hosting the full thread card for that annotation", () => {
    // Data: viewport 375px (drawer mode); annotation by Jane Smith with an open thread.
    render(
      <AnnotationBottomSheet
        annotation={annotation()}
        onClose={() => {}}
        {...commenterProps()}
      />,
    );
    // The sheet surface itself slid up + hosts the FULL reused ThreadCard.
    expect(screen.getByTestId("annotation-bottom-sheet")).toBeInTheDocument();
    expect(screen.getByTestId("thread-card")).toBeInTheDocument();
    // The full thread: root + the (one) reply for that annotation.
    expect(screen.getByText("Root note.")).toBeInTheDocument();
    expect(screen.getAllByTestId("reply")).toHaveLength(1);
    // The sheet chrome: a grab handle + the wrapper-owned ✕ (not on ThreadCard).
    expect(screen.getByTestId("bottom-sheet-handle")).toBeInTheDocument();
    expect(screen.getByTestId("bottom-sheet-close")).toBeInTheDocument();
  });

  it("AS-020 (C-005): commenter sees Reply + Resolve; a viewer role sees the thread READ-ONLY", () => {
    // Data: commenter session → Reply + Resolve shown.
    const { unmount } = render(
      <AnnotationBottomSheet
        annotation={annotation()}
        onClose={() => {}}
        {...commenterProps()}
      />,
    );
    expect(screen.getByTestId("reply-open")).toBeInTheDocument();
    expect(screen.getByTestId("resolve-toggle")).toBeInTheDocument();
    unmount();
    document.body.innerHTML = "";

    // Data: viewer session → no action callbacks → read-only (no Reply / Resolve / Accept / Reject).
    render(
      <AnnotationBottomSheet
        annotation={annotation()}
        onClose={() => {}}
        focused={false}
        unplaceable={false}
        onFocus={() => {}}
        currentUserId="user-bob"
        isOwner={false}
      />,
    );
    expect(screen.getByTestId("thread-card")).toBeInTheDocument();
    expect(screen.queryByTestId("reply-open")).toBeNull();
    expect(screen.queryByTestId("resolve-toggle")).toBeNull();
    expect(screen.queryByTestId("redline-decide")).toBeNull();
    // The close (✕) is always available regardless of role.
    expect(screen.getByTestId("bottom-sheet-close")).toBeInTheDocument();
  });

  it("AS-018: the sheet's ✕ control fires onClose", () => {
    let closed = 0;
    render(
      <AnnotationBottomSheet
        annotation={annotation()}
        onClose={() => (closed += 1)}
        {...commenterProps()}
      />,
    );
    fireEvent.click(screen.getByTestId("bottom-sheet-close"));
    expect(closed).toBe(1);
  });
});

// AS-018 / AS-019 — the drawer-mode marker-tap ROUTING. viewer-screen reroutes the marker tap in
// drawer mode to open the sheet for THAT thread (instead of the old rail-drawer-open), and feeds NO
// hover-peek option in drawer mode (touch → no peek). We reproduce that routing decision over the real
// useAnnotationMarks delegated listener + the real useHoverPin sheet-state hook.
describe("drawer-mode marker tap routing (S-004 / AS-018 / AS-019)", () => {
  function TapHarness({
    drawerMode,
    onSheetOpen,
    onPeek,
  }: {
    drawerMode: boolean;
    onSheetOpen: (id: string) => void;
    onPeek: (id: string | null) => void;
  }) {
    const [el, setEl] = useState<HTMLElement | null>(null);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (ref.current) setEl(ref.current);
    }, []);
    const annos: PlaceableAnnotation[] = [
      { id: "a1", anchor: { blockId: "block-p-1", textSnippet: "tokens", offset: 0, length: 6 } },
    ];
    // AS-019: in drawer mode the shell passes NO hover option (touch → no peek). On a pointer device
    // it would pass one; here we prove the touch path never raises a peek.
    const hover = drawerMode ? undefined : { onHoverPeek: (p: unknown) => onPeek(p ? "a1" : null) };
    useAnnotationMarks(
      el,
      annos,
      null,
      (id) => {
        // AS-018: in drawer mode a marker tap opens the sheet for THAT thread (the reroute). On a
        // pointer device the focus path would feed the pin instead.
        if (drawerMode) onSheetOpen(id);
      },
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hover as any,
      undefined,
    );
    // eslint-disable-next-line react/no-danger
    return <div ref={ref} dangerouslySetInnerHTML={{ __html: `<p id="block-p-1">tokens here.</p>` }} />;
  }

  it("AS-018: tapping a marker in drawer mode opens the sheet for that thread", async () => {
    const opened: string[] = [];
    render(<TapHarness drawerMode={true} onSheetOpen={(id) => opened.push(id)} onPeek={() => {}} />);
    const mark = await waitFor(() => {
      const m = document.querySelector('[data-anno="a1"]');
      if (!m) throw new Error("not placed");
      return m as HTMLElement;
    });
    fireEvent.click(mark);
    expect(opened).toEqual(["a1"]); // the sheet opens for the tapped annotation
  });

  it("AS-019: a touch tap shows NO hover-peek — only the sheet opens", async () => {
    const opened: string[] = [];
    const peeks: (string | null)[] = [];
    render(
      <TapHarness drawerMode={true} onSheetOpen={(id) => opened.push(id)} onPeek={(p) => peeks.push(p)} />,
    );
    const mark = await waitFor(() => {
      const m = document.querySelector('[data-anno="a1"]');
      if (!m) throw new Error("not placed");
      return m as HTMLElement;
    });
    // A touch interaction: a mouseover then the tap. In drawer mode no hover option is wired, so the
    // dwell never arms and no peek ever shows — only the sheet opens.
    fireEvent.mouseOver(mark);
    fireEvent.click(mark);
    expect(peeks).toEqual([]); // the desktop hover-peek never appears on touch (AS-019)
    expect(opened).toEqual(["a1"]); // only the sheet opens
  });
});

// C-002 — at most one sheet/pin at a time, consistent with the pin's one-at-a-time. The sheet reuses
// the SAME useHoverPin pin state (pinMark replaces / toggles), so opening a new sheet closes the prior.
describe("bottom sheet is one-at-a-time, consistent with the pin (S-004 / C-002)", () => {
  const VP = { width: 375, height: 720 };

  it("C-002: opening the sheet for a second annotation replaces the first (never two open)", () => {
    const { result } = renderHook(() => useHoverPin(VP));
    const rect = { top: 10, bottom: 30, left: 20, right: 100 } as DOMRect;
    act(() => void result.current.pinMark({ annoId: "A", rect }));
    expect(result.current.pinnedId).toBe("A");
    act(() => void result.current.pinMark({ annoId: "B", rect }));
    expect(result.current.pinnedId).toBe("B"); // A replaced — at most one open (C-002)
    // Tapping the same id again toggles the sheet closed (consistent with the pin).
    act(() => void result.current.pinMark({ annoId: "B", rect }));
    expect(result.current.pinnedId).toBeNull();
  });
});
