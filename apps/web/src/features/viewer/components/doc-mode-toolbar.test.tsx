import { describe, it, expect, mock } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// annotation-core-ui-types-modes S-001 + S-006 (C-009) — the DocModeToolbar.
//
// Left→right: Select | Pinpoint (Select active; Pinpoint disabled/coming — Phase 2) · a markup TOOL
// PALETTE (Markup · Comment · Redline · Label — exactly one active, the active tool routes the
// selection) · Wide | Focus pushed to the FAR RIGHT. Each tool chip is collapsed to an icon at rest
// and expands to icon + label + its per-type hue when active or hovered (the collapse/expand colour is
// visual [→MANUAL] — here we assert the active chip carries its label + a colour hook, inactive chips
// are icon-only). This is a presentational shell — no anchor-model change (C-008).

import { DocModeToolbar } from "./doc-mode-toolbar";

describe("DocModeToolbar S-001 mode relabel", () => {
  it("AS-001: the mode switch reads Select / Pinpoint (not a Select / Markup MODE)", () => {
    render(<DocModeToolbar width="wide" onWidth={() => {}} onPinpointUnavailable={() => {}} />);
    const toolbar = screen.getByTestId("doc-mode-toolbar");
    expect(toolbar).toHaveTextContent("Select");
    expect(toolbar).toHaveTextContent("Pinpoint");
    // Markup is no longer a MODE in the Select|Pinpoint segment — it's a TOOL in the markup palette.
    const modeSeg = within(toolbar).getByRole("button", { name: "Select" }).parentElement!;
    expect(modeSeg).not.toHaveTextContent("Markup");
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

  it("C-009: the Wide / Focus measure switch sits at the far right and still works", async () => {
    const onWidth = mock((_w: string) => {});
    render(<DocModeToolbar width="wide" onWidth={onWidth} onPinpointUnavailable={() => {}} />);
    const toolbar = screen.getByTestId("doc-mode-toolbar");
    // Pushed to the far right (ml-auto wrapper) — last interactive group in the toolbar.
    const widthSeg = screen.getByTestId("doc-width-seg");
    expect(widthSeg.className).toContain("ml-auto");
    await userEvent.click(within(toolbar).getByRole("button", { name: "Focus" }));
    expect(onWidth).toHaveBeenCalledWith("focus");
  });
});

describe("DocModeToolbar S-006 markup tool palette (C-009)", () => {
  it("C-009: the palette lists Markup · Comment · Redline · Label", () => {
    render(<DocModeToolbar width="wide" onWidth={() => {}} onPinpointUnavailable={() => {}} />);
    const group = screen.getByTestId("markup-tool-group");
    expect(within(group).getByTestId("markup-tool-markup")).toBeTruthy();
    expect(within(group).getByTestId("markup-tool-comment")).toBeTruthy();
    expect(within(group).getByTestId("markup-tool-redline")).toBeTruthy();
    expect(within(group).getByTestId("markup-tool-label")).toBeTruthy();
  });

  it("C-009: Markup is the default active tool (preserves S-001 Markup+select → popover)", () => {
    render(<DocModeToolbar width="wide" onWidth={() => {}} onPinpointUnavailable={() => {}} />);
    expect(screen.getByTestId("markup-tool-markup").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("markup-tool-comment").getAttribute("data-active")).not.toBe("true");
  });

  it("C-009: exactly one tool is active — clicking a tool calls onTool with its key", async () => {
    const onTool = mock((_t: string) => {});
    render(
      <DocModeToolbar
        width="wide"
        onWidth={() => {}}
        onPinpointUnavailable={() => {}}
        activeTool="markup"
        onTool={onTool}
      />,
    );
    await userEvent.click(screen.getByTestId("markup-tool-redline"));
    expect(onTool).toHaveBeenCalledWith("redline");
  });

  it("C-009: the ACTIVE tool is expanded (shows its label + a colour hook); inactive tools are icon-only", () => {
    render(
      <DocModeToolbar
        width="wide"
        onWidth={() => {}}
        onPinpointUnavailable={() => {}}
        activeTool="redline"
      />,
    );
    const redline = screen.getByTestId("markup-tool-redline");
    // Active → expanded: its label shows and it carries a colour hook (its hue via inline style).
    expect(redline.getAttribute("data-expanded")).toBe("true");
    expect(within(redline).getByTestId("markup-tool-redline-label")).toHaveTextContent(/redline/i);
    expect(redline.getAttribute("style") ?? "").toContain("color");
    // Inactive (Comment) → collapsed: the label is mounted (so it can animate open/closed) but
    // hidden — clipped + aria-hidden, the chip not expanded. Icon-only to the eye + to a11y.
    const comment = screen.getByTestId("markup-tool-comment");
    expect(comment.getAttribute("data-expanded")).not.toBe("true");
    const commentLabel = within(comment).getByTestId("markup-tool-comment-label");
    expect(commentLabel.getAttribute("data-collapsed")).toBe("true");
    expect(commentLabel.getAttribute("aria-hidden")).toBe("true");
  });
});
