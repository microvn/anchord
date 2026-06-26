import { describe, it, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { PinnedCardPopover } from "@/features/viewer/components/pinned-card-popover";
import { useHoverPin } from "@/features/viewer/hooks/use-hover-pin";
import { useAnnotationMarks, type PlaceableAnnotation } from "@/features/viewer/components/annotation-marks";
import { isRectOutOfViewport, type Placement } from "@/features/viewer/lib/place-popover";
import type { ViewerAnnotation } from "@/features/viewer/services/client";

// S-002 — click a marker to PIN the full thread card. The pinned card hosts the FULL interactive
// ThreadCard (reused verbatim) in a floating wrapper with a wrapper-owned ✕. The pin state is a
// `pinnedId` distinct from `focusedId` (C-004); at most one pin (C-002); the click that opens it is
// gated on TEXT-SELECTION (C-001/AS-013), excluded from the outside-dismiss (AS-011), and dismissed
// via outside-click (AS-008) / Escape (AS-009) / ✕ (AS-010) / auto-close (AS-021/AS-026).
//
// happy-dom has no layout (getBoundingClientRect → 0), so the PLACEMENT math is the pure placePopover
// path (place-popover.test.ts); these tests assert the state machine + content + dismiss WIRING.

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
      comment("c3", "Second reply.", "Jane Smith", "30m"),
    ],
    authorId: "user-jane",
    ...over,
  };
}

const PLACEMENT: Placement = { top: 100, left: 200, side: "below", centered: true };
const RECT = (over: Partial<DOMRect> = {}): DOMRect =>
  ({ top: 10, bottom: 30, left: 20, right: 100, width: 80, height: 20, x: 20, y: 10, toJSON() {} }) as DOMRect;
const peek = (annoId: string) => ({ annoId, rect: RECT() });

// Full set of ThreadCard action bindings (commenter — reply + resolve; owner adds decide; author adds
// delete). Each is a no-op spy so we can assert presence/absence by data-testid.
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

describe("PinnedCardPopover (S-002)", () => {
  it("AS-006: renders the FULL thread card (root + replies) with Reply/Resolve, prefer-below placement", () => {
    // Data: unresolved comment annotation, root + 2 replies, commenter.
    render(
      <PinnedCardPopover
        annotation={annotation()}
        placement={PLACEMENT}
        onClose={() => {}}
        {...commenterProps()}
      />,
    );
    // The full thread: the reused ThreadCard, the root body + both replies.
    expect(screen.getByTestId("thread-card")).toBeInTheDocument();
    expect(screen.getByText("Root note.")).toBeInTheDocument();
    expect(screen.getAllByTestId("reply")).toHaveLength(2);
    // The interactive affordances a commenter gets (Reply + Resolve).
    expect(screen.getByTestId("reply-open")).toBeInTheDocument();
    expect(screen.getByTestId("resolve-toggle")).toBeInTheDocument();
    // Prefer-below placement is applied from the (pure) placePopover output.
    const wrapper = screen.getByTestId("pinned-card-popover");
    expect(wrapper.style.top).toBe("100px");
    expect(wrapper.style.left).toBe("200px");
    // The wrapper-owned close control (✕) — not on ThreadCard.
    expect(screen.getByTestId("pinned-close")).toBeInTheDocument();
  });

  it("AS-014 (C-005): a viewer role (no action callbacks) renders the thread READ-ONLY", () => {
    // Data: viewer-role session — no onReply/onResolve/onDecide/onDelete wired.
    render(
      <PinnedCardPopover
        annotation={annotation()}
        placement={PLACEMENT}
        onClose={() => {}}
        focused={false}
        unplaceable={false}
        onFocus={() => {}}
        currentUserId="user-bob"
        isOwner={false}
      />,
    );
    expect(screen.getByTestId("thread-card")).toBeInTheDocument();
    // No Reply / Resolve / Accept / Reject controls for a read-only role.
    expect(screen.queryByTestId("reply-open")).toBeNull();
    expect(screen.queryByTestId("resolve-toggle")).toBeNull();
    expect(screen.queryByTestId("redline-decide")).toBeNull();
    // The close (✕) still exists — closing is always available.
    expect(screen.getByTestId("pinned-close")).toBeInTheDocument();
  });

  it("AS-010: the wrapper close (✕) control fires onClose", () => {
    let closed = 0;
    render(
      <PinnedCardPopover
        annotation={annotation()}
        placement={PLACEMENT}
        onClose={() => (closed += 1)}
        {...commenterProps()}
      />,
    );
    fireEvent.click(screen.getByTestId("pinned-close"));
    expect(closed).toBe(1);
  });
});

// The pin STATE machine (C-002/C-004): pinnedId distinct, at-most-one, same-id toggle.
describe("useHoverPin pin state (S-002)", () => {
  const VP = { width: 1000, height: 800 };

  it("AS-007 / C-004: pinMark sets a pinnedId + a prefer-below placement, distinct from the peek", () => {
    // Data: pinning marker #5 — its id becomes pinnedId; the caller pairs it with focusedId.
    const { result } = renderHook(() => useHoverPin(VP));
    expect(result.current.pinnedId).toBeNull();
    let returned: string | null = "unset";
    act(() => {
      returned = result.current.pinMark(peek("anno-5"));
    });
    expect(result.current.pinnedId).toBe("anno-5");
    expect(returned).toBe("anno-5"); // the caller uses this to set focusedId in sync (C-004)
    expect(result.current.pinPlacement).not.toBeNull();
    expect(result.current.pinPlacement!.side).toBe("below"); // pin prefers below (UI Notes)
    // The peek state is independent (C-004) — pinning didn't touch it.
    expect(result.current.peekId).toBeNull();
  });

  it("AS-011 / C-004: pinning the SAME id again toggles it closed exactly once", () => {
    const { result } = renderHook(() => useHoverPin(VP));
    act(() => void result.current.pinMark(peek("anno-1")));
    expect(result.current.pinnedId).toBe("anno-1");
    let toggled: string | null = "unset";
    act(() => {
      toggled = result.current.pinMark(peek("anno-1")); // same id → close
    });
    expect(result.current.pinnedId).toBeNull();
    expect(result.current.pinPlacement).toBeNull();
    expect(toggled).toBeNull(); // signals the caller to clear, not re-set
  });

  it("AS-012 / C-002: pinning a SECOND id closes the first (at most one pinned)", () => {
    const { result } = renderHook(() => useHoverPin(VP));
    act(() => void result.current.pinMark(peek("A")));
    expect(result.current.pinnedId).toBe("A");
    act(() => void result.current.pinMark(peek("B")));
    expect(result.current.pinnedId).toBe("B"); // A replaced — never two at once
  });

  it("AS-021 / C-004: closePin clears the pin; a scrolled-out rect is the close trigger", () => {
    // happy-dom has no layout: the AUTO-CLOSE decision is pure (isRectOutOfViewport over the mark
    // rect, re-read on a throttled scroll). Prove the decision + that closePin clears the state.
    const { result } = renderHook(() => useHoverPin(VP));
    act(() => void result.current.pinMark(peek("anno-1")));
    expect(result.current.pinnedId).toBe("anno-1");
    // A rect scrolled ABOVE the viewport top → out of view → the scroll handler would close.
    const goneRect = { top: -200, bottom: -180, left: 0, right: 80 };
    expect(isRectOutOfViewport(goneRect, VP)).toBe(true);
    act(() => result.current.closePin());
    expect(result.current.pinnedId).toBeNull();
    expect(result.current.pinPlacement).toBeNull();
    // An in-view rect stays (repositionPin keeps the pin open).
    const { result: r2 } = renderHook(() => useHoverPin(VP));
    act(() => void r2.current.pinMark(peek("anno-2")));
    expect(isRectOutOfViewport({ top: 100, bottom: 120, left: 0, right: 80 }, VP)).toBe(false);
    act(() => r2.current.repositionPin({ top: 300, bottom: 320, left: 0, right: 80 }));
    expect(r2.current.pinnedId).toBe("anno-2"); // still pinned, just repositioned
  });
});

// The SELECTION-based suppression of the pin click (C-001/AS-013), tested on the real
// useAnnotationMarks delegated click listener with a synthetic selection probe (mirrors S-001).
describe("useAnnotationMarks click-to-pin suppression (S-002)", () => {
  function ClickHarness({
    selectionActive,
    onPin,
    onFocus,
  }: {
    selectionActive: boolean;
    onPin: (peek: { annoId: string; rect: DOMRect }) => void;
    onFocus: (id: string) => void;
  }) {
    const [el, setEl] = useState<HTMLElement | null>(null);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (ref.current) setEl(ref.current);
    }, []);
    const annos: PlaceableAnnotation[] = [
      { id: "a1", anchor: { blockId: "block-p-1", textSnippet: "tokens", offset: 0, length: 6 } },
    ];
    useAnnotationMarks(el, annos, null, onFocus, undefined, undefined, {
      isSelectionActive: () => selectionActive,
      onPinMark: onPin,
    });
    // eslint-disable-next-line react/no-danger
    return <div ref={ref} dangerouslySetInnerHTML={{ __html: `<p id="block-p-1">tokens here.</p>` }} />;
  }

  it("AS-013 / C-001: an in-progress selection suppresses the pin; no selection pins (any tool)", async () => {
    // Data: a drag-selection ending on a marker, Comment tool selected → focus but NO pin.
    const suppressedPins: string[] = [];
    const suppressedFocus: string[] = [];
    const { unmount } = render(
      <ClickHarness
        selectionActive={true}
        onPin={(p) => suppressedPins.push(p.annoId)}
        onFocus={(id) => suppressedFocus.push(id)}
      />,
    );
    const mark = await waitFor(() => {
      const m = document.querySelector('[data-anno="a1"]');
      if (!m) throw new Error("not placed");
      return m as HTMLElement;
    });
    fireEvent.click(mark);
    expect(suppressedFocus).toEqual(["a1"]); // focus still happens
    expect(suppressedPins).toEqual([]); // but NO pin — annotate-create owns the gesture
    unmount();
    document.body.innerHTML = "";

    // No selection (Comment tool would still be active) → clicking the marker DOES pin.
    const pins: string[] = [];
    render(<ClickHarness selectionActive={false} onPin={(p) => pins.push(p.annoId)} onFocus={() => {}} />);
    const mark2 = await waitFor(() => {
      const m = document.querySelector('[data-anno="a1"]');
      if (!m) throw new Error("not placed");
      return m as HTMLElement;
    });
    fireEvent.click(mark2);
    expect(pins).toEqual(["a1"]); // pins regardless of the active tool
  });
});

// The dismiss WIRING (AS-008/009/023/024/026) — exercised through a host that reproduces the C-004
// dismiss contract (marker-excluded outside-click, layered Escape) the same way viewer-screen wires it.
// We mount the PinnedCardPopover under that host with a real doc-pane marker so the marker-exclusion
// can be asserted against a real DOM element.
function DismissHarness({
  annotation: anno,
  onClose,
  threadProps = commenterProps(),
}: {
  annotation: ViewerAnnotation;
  onClose: () => void;
  threadProps?: Record<string, unknown>;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const annoId = anno.id;
  useEffect(() => {
    const handleMouseDown = (event: MouseEvent) => {
      if (event.detail >= 2) return;
      const target = event.target as Node | null;
      if (!target) return;
      if (wrapperRef.current?.contains(target)) return;
      const el = target instanceof Element ? target : (target as Node).parentElement;
      const mark = el?.closest?.(`[data-anno="${annoId}"]`);
      if (mark && paneRef.current?.contains(mark)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [annoId, onClose]);
  return (
    <div>
      <div ref={paneRef} data-testid="doc-pane">
        <p id="block-p-1">
          plain text <mark data-anno={annoId}>tokens</mark> away
        </p>
      </div>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <PinnedCardPopover annotation={anno} placement={PLACEMENT} onClose={onClose} wrapperRef={wrapperRef} {...(threadProps as any)} />
    </div>
  );
}

describe("PinnedCardHost dismiss (S-002)", () => {
  it("AS-008: a click on plain doc text (not the card, not the marker) closes the pin", () => {
    let closed = 0;
    render(<DismissHarness annotation={annotation()} onClose={() => (closed += 1)} />);
    const plain = document.querySelector("#block-p-1")!;
    fireEvent.mouseDown(plain); // outside the card AND not the marker
    expect(closed).toBe(1);
  });

  it("AS-011: a re-click on the PINNED MARKER is excluded from outside-dismiss (one toggle-close)", () => {
    let closed = 0;
    render(<DismissHarness annotation={annotation()} onClose={() => (closed += 1)} />);
    const mark = document.querySelector('[data-anno="a1"]')!;
    fireEvent.mouseDown(mark); // the marker that opened the card — must NOT auto-dismiss
    expect(closed).toBe(0); // the doc-pane click owns the single toggle; no double-fire
  });

  it("AS-008: a mousedown INSIDE the card does not close it", () => {
    let closed = 0;
    render(<DismissHarness annotation={annotation()} onClose={() => (closed += 1)} />);
    fireEvent.mouseDown(screen.getByTestId("thread-card"));
    expect(closed).toBe(0);
  });

  it("AS-009: Escape with no inner editor open closes the pin", () => {
    let closed = 0;
    render(<DismissHarness annotation={annotation()} onClose={() => (closed += 1)} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(1);
  });

  it("AS-024: Escape cancels an OPEN reply first (card stays); a second Escape closes the card", () => {
    let closed = 0;
    render(<DismissHarness annotation={annotation()} onClose={() => (closed += 1)} />);
    // Open the reply composer and type a draft.
    fireEvent.click(screen.getByTestId("reply-open"));
    const input = screen.getByTestId("reply-input") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "needs a rethink" } });
    expect(input.value).toBe("needs a rethink");
    // First Escape: the reply textarea cancels (stopPropagation) — the card does NOT close.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(closed).toBe(0);
    expect(screen.queryByTestId("reply-composer")).toBeNull(); // composer cancelled, draft cleared
    // Second Escape (no composer open) reaches the window listener → closes the card.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(1);
  });

  it("AS-026: deleting from inside the pinned card invokes the consumer's delete (pin then closes)", async () => {
    // Data: own annotation; the consumer (viewer-screen) owns the optimistic remove → the
    // auto-close-on-orphan effect closes the pin when the annotation leaves the loaded set. Here we
    // assert the card surfaces Delete for the author + invokes the wired onDelete (the consumer then
    // drops the annotation, which the host's resolve-from-list closes — covered by the state test).
    const own = annotation({ authorId: "user-jane" });
    let deleted = 0;
    render(
      <DismissHarness
        annotation={own}
        onClose={() => {}}
        threadProps={{
          ...commenterProps(),
          currentUserId: "user-jane", // author → Delete offered
          onDelete: async () => {
            deleted += 1;
          },
        }}
      />,
    );
    fireEvent.click(screen.getByTestId("overflow-trigger"));
    fireEvent.click(screen.getByTestId("overflow-delete"));
    await waitFor(() => expect(deleted).toBe(1));
  });
});

// AS-023 — the pin-aware rail focus: focusing a DIFFERENT thread closes the pin; focusing the pinned
// thread leaves it open. This is the wrapper viewer-screen applies; tested directly as a pure rule.
describe("pin-aware rail focus (S-002 / AS-023 / C-002)", () => {
  it("AS-023: focusing a DIFFERENT thread closes the pin; focusing the SAME thread leaves it open", () => {
    // Reproduce viewer-screen's onRailFocusThread wrapper over useHoverPin.
    function focusWrapper(pinnedId: string | null, closePin: () => void) {
      return (id: string) => {
        if (pinnedId != null && id !== pinnedId) closePin();
      };
    }
    const { result } = renderHook(() => useHoverPin({ width: 1000, height: 800 }));
    act(() => void result.current.pinMark(peek("A")));
    expect(result.current.pinnedId).toBe("A");
    // Focus B (different) → close.
    act(() => focusWrapper(result.current.pinnedId, result.current.closePin)("B"));
    expect(result.current.pinnedId).toBeNull();
    // Re-pin A, focus A (same) → stays.
    act(() => void result.current.pinMark(peek("A")));
    act(() => focusWrapper(result.current.pinnedId, result.current.closePin)("A"));
    expect(result.current.pinnedId).toBe("A");
  });
});

// C-007 — the pinned card and the rail card are TWO independent optimistic views of one thread: the
// pinned card mounts its OWN ThreadCard with its own optimistic state, so a reply made in the pin does
// not mutate the rail's copy (refetch reconciles). Prove the pinned ThreadCard owns its own optimistic
// reply locally.
describe("pinned card is an independent optimistic view (S-002 / C-007)", () => {
  it("C-007: a reply sent inside the pinned card shows flat in THAT card without mutating shared data", async () => {
    const anno = annotation();
    const replied: string[] = [];
    render(
      <PinnedCardPopover
        annotation={anno}
        placement={PLACEMENT}
        onClose={() => {}}
        focused={false}
        unplaceable={false}
        onFocus={() => {}}
        currentUserId="user-bob"
        currentAuthorName="Bob Lee"
        isOwner={false}
        onReply={async (body: string) => {
          replied.push(body);
          return true;
        }}
        onResolve={async () => true}
      />,
    );
    fireEvent.click(screen.getByTestId("reply-open"));
    const input = screen.getByTestId("reply-input");
    fireEvent.change(input, { target: { value: "pinned-card reply" } });
    fireEvent.click(screen.getByTestId("reply-send"));
    await waitFor(() => expect(replied).toEqual(["pinned-card reply"]));
    // The optimistic reply appears in THIS card (2 server replies + 1 optimistic = 3). The shared
    // fixture object is unchanged — the optimistic state lives in the card's own useState (C-007).
    await waitFor(() => expect(screen.getAllByTestId("reply")).toHaveLength(3));
    expect(anno.comments).toHaveLength(3); // the source data is NOT mutated
  });
});
