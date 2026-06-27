import { describe, it, expect, afterEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";

// pinpoint S-002 (AS-003/AS-004/AS-006b): block-pick targeting on a markdown doc — hover-outline +
// click → {blockId, element, rect}. A block click is the Pinpoint create gesture (vs a text drag).
// resolvePickableBlock is the PURE resolver (an empty block is never a target); useBlockPick is the
// hover-outline + click hook, active only in Pinpoint mode.

import {
  resolvePickableBlock,
  useBlockPick,
  type BlockPick,
} from "@/features/viewer/components/annotation-marks";

function mountPane(html: string): HTMLElement {
  const pane = document.createElement("main");
  pane.innerHTML = html;
  document.body.appendChild(pane);
  return pane;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("resolvePickableBlock (pinpoint S-002)", () => {
  it("AS-004: resolves the nearest block id from a click on inline content inside it", () => {
    const pane = mountPane(`<p data-block-id="block-p-7">Out of <strong>scope</strong> here.</p>`);
    const inline = pane.querySelector("strong")!;
    const pick = resolvePickableBlock(inline);
    expect(pick).not.toBeNull();
    expect(pick!.blockId).toBe("block-p-7");
    expect(pick!.element).toBe(pane.querySelector("p"));
  });

  it("AS-004: resolves a block by the id=\"block-…\" form as well as data-block-id", () => {
    const pane = mountPane(`<h2 id="block-h2-3">Heading text</h2>`);
    const pick = resolvePickableBlock(pane.querySelector("h2"));
    expect(pick!.blockId).toBe("block-h2-3");
  });

  it("AS-006b: an empty / zero-length block is NOT a pick target (null)", () => {
    const pane = mountPane(
      `<p data-block-id="block-p-1"></p><hr data-block-id="block-hr-1"><p data-block-id="block-p-2">   </p>`,
    );
    expect(resolvePickableBlock(pane.querySelector('[data-block-id="block-p-1"]'))).toBeNull(); // empty
    expect(resolvePickableBlock(pane.querySelector("hr"))).toBeNull(); // image-only-ish / no text
    expect(resolvePickableBlock(pane.querySelector('[data-block-id="block-p-2"]'))).toBeNull(); // whitespace
  });

  it("AS-006b: an adjacent NON-empty block still resolves while a sibling empty one does not", () => {
    const pane = mountPane(
      `<p data-block-id="block-p-1"></p><p data-block-id="block-p-2">real text</p>`,
    );
    expect(resolvePickableBlock(pane.querySelector('[data-block-id="block-p-1"]'))).toBeNull();
    expect(resolvePickableBlock(pane.querySelector('[data-block-id="block-p-2"]'))!.blockId).toBe("block-p-2");
  });

  it("returns null when the target is outside any block", () => {
    const pane = mountPane(`<div>bare</div>`);
    expect(resolvePickableBlock(pane.querySelector("div"))).toBeNull();
    expect(resolvePickableBlock(null)).toBeNull();
  });
});

describe("useBlockPick (pinpoint S-002)", () => {
  it("AS-003: hovering a block in Pinpoint mode outlines it; leaving removes the outline", () => {
    const pane = mountPane(`<p data-block-id="block-p-7">A paragraph block.</p>`);
    const block = pane.querySelector("p")!;
    renderHook(() => useBlockPick(pane, true, () => {}));

    act(() => {
      block.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(block.classList.contains("anno-block-hover")).toBe(true);

    // Move off the block (relatedTarget outside any block) → outline removed.
    act(() => {
      block.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: pane }));
    });
    expect(block.classList.contains("anno-block-hover")).toBe(false);
  });

  it("AS-006b: hovering an EMPTY block never outlines it (no pick target)", () => {
    const pane = mountPane(`<p data-block-id="block-p-1"></p>`);
    const empty = pane.querySelector("p")!;
    renderHook(() => useBlockPick(pane, true, () => {}));
    act(() => {
      empty.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(empty.classList.contains("anno-block-hover")).toBe(false);
  });

  it("AS-004: clicking a block reports the pick (blockId + element + rect)", () => {
    const pane = mountPane(`<h2 data-block-id="block-h2-3">Heading</h2>`);
    const block = pane.querySelector("h2")!;
    let picked: BlockPick | null = null;
    renderHook(() => useBlockPick(pane, true, (p) => (picked = p)));
    act(() => {
      block.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(picked).not.toBeNull();
    expect(picked!.blockId).toBe("block-h2-3");
    expect(picked!.element).toBe(block);
    expect(picked!.rect).toBeDefined();
    // AS-004: the picked block stays outlined while the popover is open.
    expect(block.classList.contains("anno-block-hover")).toBe(true);
  });

  it("AS-006b: clicking an EMPTY block is a NO-OP (no pick reported)", () => {
    const pane = mountPane(
      `<p data-block-id="block-p-1"></p><p data-block-id="block-p-2">real</p>`,
    );
    let count = 0;
    renderHook(() => useBlockPick(pane, true, () => count++));
    act(() => {
      pane.querySelector('[data-block-id="block-p-1"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(count).toBe(0);
    // The adjacent non-empty block still picks.
    act(() => {
      pane.querySelector('[data-block-id="block-p-2"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(count).toBe(1);
  });

  it("C-001: when DISABLED (Select mode) a block click reports nothing and never outlines", () => {
    const pane = mountPane(`<p data-block-id="block-p-7">A paragraph block.</p>`);
    const block = pane.querySelector("p")!;
    let count = 0;
    renderHook(() => useBlockPick(pane, false, () => count++));
    act(() => {
      block.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      block.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(count).toBe(0);
    expect(block.classList.contains("anno-block-hover")).toBe(false);
  });

  it("clearHoverOutline removes a lingering outline (dismiss lifecycle)", () => {
    const pane = mountPane(`<p data-block-id="block-p-7">A paragraph block.</p>`);
    const block = pane.querySelector("p")!;
    const { result } = renderHook(() => useBlockPick(pane, true, () => {}));
    act(() => {
      block.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(block.classList.contains("anno-block-hover")).toBe(true);
    act(() => result.current.clearHoverOutline());
    expect(block.classList.contains("anno-block-hover")).toBe(false);
  });
});
