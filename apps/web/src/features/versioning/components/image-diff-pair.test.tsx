import { describe, it, expect } from "bun:test";
import { render, screen, within, act } from "@testing-library/react";

// versioning-diff-ui S-004 — the ImageDiffPair: an image doc's diff body. Pure presentation off the
// diff read's `renderPair` (two `/v/<versionId>` image refs); no fetching, so nothing to mock. Mirrors
// rendered-pair.tsx but renders an <img> per pane instead of a sandbox iframe.
//
// AS-013 / C-005: the two images show side-by-side (before=v3 | after=v4), each fed its renderPair url.
// AS-010 / C-006 (folded in): the pair stacks vertically ≤760 — asserted via the pure renderedPairStacks
//   contract and via the live `data-stacked` flag when the viewport is narrow.

const { ImageDiffPair, renderedPairStacks } = await import(
  "@/features/versioning/components/image-diff-pair"
);

function setWidth(w: number) {
  act(() => {
    (window as unknown as { innerWidth: number }).innerWidth = w;
    window.dispatchEvent(new Event("resize"));
  });
}

describe("versioning-diff-ui S-004 — ImageDiffPair", () => {
  it("AS-013: shows two image panes side-by-side (before=v3 | after=v4), each fed its renderPair url", () => {
    setWidth(1440);
    render(<ImageDiffPair renderPair={["/v/imgA", "/v/imgB"]} fromLabel="v3" toLabel="v4" />);

    const pair = screen.getByTestId("image-diff-pair");
    const before = within(pair).getByTestId("idp-img-before");
    const after = within(pair).getByTestId("idp-img-after");

    expect(before).toHaveAttribute("src", "/v/imgA");
    expect(after).toHaveAttribute("src", "/v/imgB");

    // each pane carries its version label, in before|after order.
    expect(within(pair).getByTestId("idp-col-before")).toHaveTextContent("v3");
    expect(within(pair).getByTestId("idp-col-after")).toHaveTextContent("v4");

    // wide viewport → side-by-side (not stacked).
    expect(pair).not.toHaveAttribute("data-stacked", "1");
  });

  it("AS-010 / C-006: the image pair stacks vertically ≤760 (pure contract + live flag)", () => {
    // pure contract (the single ≤760 source of truth, shared with the rendered pair).
    expect(renderedPairStacks(360)).toBe(true);
    expect(renderedPairStacks(760)).toBe(true);
    expect(renderedPairStacks(761)).toBe(false);

    // live: a narrow viewport flips the rendered pane to stacked.
    setWidth(360);
    render(<ImageDiffPair renderPair={["/v/imgA", "/v/imgB"]} fromLabel="v3" toLabel="v4" />);
    expect(screen.getByTestId("image-diff-pair")).toHaveAttribute("data-stacked", "1");
  });
});
