import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";

// pinpoint S-002: the WHOLE-BLOCK create path in use-compose — buildBlockAnchor (offset 0, capped
// snippet, UTF-16 length), beginBlockCompose (synthesize the popover from a block click), and the
// create carrying type=block. A block click is NOT a text selection, so it bypasses the selection→
// commit path and feeds the 5-type chooser a synthesized anchor + rect directly.

const createAnnotation = mock(async () => ({ data: { annotationId: "a-block-1", commentId: "c-1" }, error: null }));
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) }),
  Toaster: () => null,
}));
mock.module("@/features/viewer/services/client", () => ({
  createAnnotation,
  addComment: mock(async () => ({ data: {}, error: null })),
  deleteAnnotation: mock(async () => ({ data: {}, error: null })),
  restoreAnnotation: mock(async () => ({ data: {}, error: null })),
  dismissAnnotation: mock(async () => ({ data: {}, error: null })),
  reattachAnnotation: mock(async () => ({ data: {}, error: null })),
}));

const { useCompose, buildBlockAnchor, capBlockSnippet, MAX_BLOCK_SNIPPET } = await import(
  "@/features/viewer/hooks/use-compose"
);

beforeEach(() => {
  createAnnotation.mockClear();
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("buildBlockAnchor (pinpoint S-002 — C-002)", () => {
  it("C-002 / AS-005.T1: builds a whole-block anchor — full text, offset 0, UTF-16 length, no segments", () => {
    const el = { textContent: "Out of scope here." };
    const anchor = buildBlockAnchor("block-p-7", el)!;
    expect(anchor.blockId).toBe("block-p-7");
    expect(anchor.textSnippet).toBe("Out of scope here.");
    expect(anchor.offset).toBe(0);
    expect(anchor.length).toBe("Out of scope here.".length);
    expect(anchor.segments).toBeUndefined();
  });

  it("AS-006b: an empty / whitespace-only block builds NO anchor (null → no-op pick)", () => {
    expect(buildBlockAnchor("block-p-1", { textContent: "" })).toBeNull();
    expect(buildBlockAnchor("block-p-2", { textContent: "   \n\t " })).toBeNull();
    expect(buildBlockAnchor("block-hr-1", { textContent: null })).toBeNull();
  });

  it("AS-006c: a LARGE block is capped (head+tail+hash, < whole) but length stays the FULL UTF-16 count", () => {
    const big = "x".repeat(MAX_BLOCK_SNIPPET + 5000); // > cap
    const anchor = buildBlockAnchor("block-pre-1", { textContent: big })!;
    // textSnippet is capped — NOT the whole block verbatim.
    expect(anchor.textSnippet.length).toBeLessThan(big.length);
    expect(anchor.textSnippet.length).toBeLessThanOrEqual(MAX_BLOCK_SNIPPET + 64); // head+tail+hash marker
    expect(anchor.textSnippet).toContain("…"); // the head…hash…tail cap marker
    // length is the FULL block length in UTF-16 units so offsets don't desync.
    expect(anchor.length).toBe(big.length);
  });

  it("AS-006c: length counts UTF-16 code units for an emoji/CJK-heavy block (matches the matcher)", () => {
    // "👍" is 2 UTF-16 code units; "日本語" is 3. String.length is the matcher's unit.
    const text = "👍 日本語 mix";
    const anchor = buildBlockAnchor("block-p-3", { textContent: text })!;
    expect(anchor.length).toBe(text.length); // === 9 (2 + 1 + 3 + 1 + 1 + 1) UTF-16 units
    expect(anchor.textSnippet).toBe(text); // under cap → verbatim
  });

  it("capBlockSnippet leaves a small block verbatim and caps a large one", () => {
    expect(capBlockSnippet("small")).toBe("small");
    const big = "a".repeat(MAX_BLOCK_SNIPPET + 100);
    expect(capBlockSnippet(big).length).toBeLessThan(big.length);
  });

  it("AS-006 / C-003: HTML-like block text is carried VERBATIM (literal data, never interpreted)", () => {
    const markup = `<img onerror="alert(1)"> & <script>`;
    const anchor = buildBlockAnchor("block-p-9", { textContent: markup })!;
    // The anchor stores the literal characters — no escaping, no stripping. Rendering inertness is
    // the ThreadCard/peek plaintext rule (C-008, tested there); the data itself is the raw text.
    expect(anchor.textSnippet).toBe(markup);
  });
});

describe("beginBlockCompose + block create (pinpoint S-002)", () => {
  function paneWithBlock(): { pane: HTMLElement; block: HTMLElement } {
    const pane = document.createElement("main");
    pane.innerHTML = '<p data-block-id="block-p-7">Out of scope here.</p>';
    document.body.appendChild(pane);
    return { pane, block: pane.querySelector("p")! };
  }

  it("AS-004: beginBlockCompose raises the popover for a clicked block (synthesized, no selection)", () => {
    const { pane, block } = paneWithBlock();
    const { result } = renderHook(() =>
      useCompose("doc", pane, true, null, () => {}, undefined, null, false, undefined, null, "pinpoint"),
    );
    expect(result.current.popover).toBeNull();
    act(() => {
      const ok = result.current.beginBlockCompose("block-p-7", block, { top: 10, bottom: 30, left: 5, right: 80 });
      expect(ok).toBe(true);
    });
    // AS-004: the 5-type popover anchor is raised even in Pinpoint mode (the selection path is inert).
    expect(result.current.popover).not.toBeNull();
  });

  it("AS-006b: beginBlockCompose on an empty block returns false and raises nothing", () => {
    const pane = document.createElement("main");
    pane.innerHTML = '<p data-block-id="block-p-1"></p>';
    document.body.appendChild(pane);
    const empty = pane.querySelector("p")!;
    const { result } = renderHook(() =>
      useCompose("doc", pane, true, null, () => {}, undefined, null, false, undefined, null, "pinpoint"),
    );
    act(() => {
      const ok = result.current.beginBlockCompose("block-p-1", empty, { top: 0, bottom: 0, left: 0, right: 0 });
      expect(ok).toBe(false);
    });
    expect(result.current.popover).toBeNull();
  });

  it("C-004: a viewer-only role (canCompose=false) cannot block-pick (no popover)", () => {
    const { pane, block } = paneWithBlock();
    const { result } = renderHook(() =>
      useCompose("doc", pane, false, null, () => {}, undefined, null, false, undefined, null, "pinpoint"),
    );
    act(() => {
      const ok = result.current.beginBlockCompose("block-p-7", block, { top: 10, bottom: 30, left: 5, right: 80 });
      expect(ok).toBe(false);
    });
    expect(result.current.popover).toBeNull();
  });

  it("AS-005.T1/T2/T3: picking Comment on a block creates type=block, whole-block anchor, label carried; lands in the rail", async () => {
    const { pane, block } = paneWithBlock();
    const created: unknown[] = [];
    const { result } = renderHook(() =>
      useCompose(
        "doc",
        pane,
        true,
        null,
        (real) => created.push(real), // onCreatedAnnotation → the screen prepends into the rail
        undefined,
        { id: "u1", name: "Jane" },
        false,
        undefined,
        null,
        "pinpoint",
      ),
    );
    // Block click → popover; choose a Label preset (carries label), then send the body.
    act(() => {
      result.current.beginBlockCompose("block-p-7", block, { top: 10, bottom: 30, left: 5, right: 80 });
    });
    act(() => {
      result.current.startLabel("out-of-scope", "Out of scope");
    });
    act(() => {
      result.current.send("Out of scope");
    });

    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    const [, body] = createAnnotation.mock.calls[0]!;
    // AS-005.T1: type=block + whole-block anchor (offset 0, full text).
    expect(body.type).toBe("block");
    expect(body.anchor.offset).toBe(0);
    expect(body.anchor.textSnippet).toBe("Out of scope here.");
    expect(body.anchor.length).toBe("Out of scope here.".length);
    expect(body.anchor.segments).toBeUndefined();
    // AS-005.T2: the chosen label rides the create.
    expect(body.label).toBe("out-of-scope");

    // AS-005.T3: the created annotation reaches the rail (onCreatedAnnotation) as type=block.
    await waitFor(() => expect(created.length).toBe(1));
    expect((created[0] as { type: string }).type).toBe("block");
    expect((created[0] as { label?: string }).label).toBe("out-of-scope");
  });

  it("AS-005.T1: a plain Comment block-pick (no label) also creates type=block", async () => {
    const { pane, block } = paneWithBlock();
    const { result } = renderHook(() =>
      useCompose("doc", pane, true, null, () => {}, undefined, { id: "u1", name: "Jane" }, false, undefined, null, "pinpoint"),
    );
    act(() => {
      result.current.beginBlockCompose("block-p-7", block, { top: 10, bottom: 30, left: 5, right: 80 });
    });
    act(() => result.current.startComment());
    act(() => result.current.send("A whole-block comment"));
    await waitFor(() => expect(createAnnotation).toHaveBeenCalledTimes(1));
    expect(createAnnotation.mock.calls[0]![1].type).toBe("block");
  });
});
