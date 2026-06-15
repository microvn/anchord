import { describe, it, expect, mock } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// annotation-core-ui-types-modes S-001 (UI Notes) — the DocModeToolbar mode switch is relabelled
// Select / Pinpoint (was Select / Markup). Select is the active read/selection mode owned here;
// Pinpoint is the whole-block element picker deferred to Phase 2, so it surfaces disabled/coming
// rather than dead UI. This is a presentational relabel — no anchor-model change (C-008).

import { DocModeToolbar } from "./doc-mode-toolbar";

describe("DocModeToolbar S-001 mode relabel", () => {
  it("AS-001: the mode switch reads Select / Pinpoint (not Select / Markup)", () => {
    render(<DocModeToolbar width="wide" onWidth={() => {}} onPinpointUnavailable={() => {}} />);
    const toolbar = screen.getByTestId("doc-mode-toolbar");
    expect(toolbar).toHaveTextContent("Select");
    expect(toolbar).toHaveTextContent("Pinpoint");
    expect(toolbar).not.toHaveTextContent("Markup");
  });

  it("AS-001: Select is the active mode", () => {
    render(<DocModeToolbar width="wide" onWidth={() => {}} onPinpointUnavailable={() => {}} />);
    const select = screen.getByRole("button", { name: "Select" });
    expect(select.getAttribute("data-active")).toBe("true");
  });

  it("AS-001: Pinpoint is disabled/coming — choosing it surfaces a note, does not switch mode", async () => {
    const onPinpoint = mock(() => {});
    render(<DocModeToolbar width="wide" onWidth={() => {}} onPinpointUnavailable={onPinpoint} />);
    const pinpoint = screen.getByRole("button", { name: /pinpoint/i });
    await userEvent.click(pinpoint);
    expect(onPinpoint).toHaveBeenCalledTimes(1);
    // It never becomes the active mode (Phase 2 work).
    expect(pinpoint.getAttribute("data-active")).not.toBe("true");
  });

  it("the Wide / Focus measure switch still works", async () => {
    const onWidth = mock((_w: string) => {});
    render(<DocModeToolbar width="wide" onWidth={onWidth} onPinpointUnavailable={() => {}} />);
    const toolbar = screen.getByTestId("doc-mode-toolbar");
    await userEvent.click(within(toolbar).getByRole("button", { name: "Focus" }));
    expect(onWidth).toHaveBeenCalledWith("focus");
  });
});
