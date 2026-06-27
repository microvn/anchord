import { describe, it, expect, mock } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// annotation-core-ui-types-modes S-001 + S-006 (C-009) — the DocModeToolbar.
//
// Left→right: Select | Pinpoint (Select active; Pinpoint disabled/coming — Phase 2 — now rendered as
// the SAME expanding chip system as the markup tools, Plannotator parity) · a markup TOOL PALETTE
// (Markup · Comment · Redline · Label — exactly one active, the active tool routes the selection) ·
// Wide | Focus pushed to the FAR RIGHT. Each tool chip is collapsed to an icon at rest and expands to
// icon + label + its per-type hue when active or hovered (the collapse/expand colour is visual
// [→MANUAL] — here we assert the active chip carries its label + a colour hook, inactive chips are
// icon-only). This is a presentational shell — no anchor-model change (C-008).

import { DocModeToolbar } from "./doc-mode-toolbar";

describe("DocModeToolbar pinpoint S-001 mode toggle", () => {
  it("the mode switch reads Select / Pinpoint (not a Select / Markup MODE)", () => {
    render(<DocModeToolbar width="wide" onWidth={() => {}} inputMode="select" onModeChange={() => {}} />);
    const toolbar = screen.getByTestId("doc-mode-toolbar");
    expect(toolbar).toHaveTextContent("Select");
    expect(toolbar).toHaveTextContent("Pinpoint");
    // Markup is no longer a MODE in the Select|Pinpoint group — it's a TOOL in the markup palette.
    const modeGroup = screen.getByTestId("input-mode-group");
    expect(modeGroup).not.toHaveTextContent("Markup");
  });

  it("AS-001: Select is the active mode by default (inputMode=select)", () => {
    render(<DocModeToolbar width="wide" onWidth={() => {}} inputMode="select" onModeChange={() => {}} />);
    const select = screen.getByTestId("input-mode-select");
    const pinpoint = screen.getByTestId("input-mode-pinpoint");
    expect(select.getAttribute("data-active")).toBe("true");
    expect(pinpoint.getAttribute("data-active")).not.toBe("true");
  });

  it("AS-001: activating the Pinpoint chip switches the active mode to pinpoint (no 'coming soon' notice)", async () => {
    // The chip is now a real toggle: clicking it asks the parent to switch mode. There is NO
    // onPinpointUnavailable "coming soon" path anymore (C-001 — Pinpoint is a live mode).
    const onModeChange = mock((_m: "select" | "pinpoint") => {});
    const { rerender } = render(
      <DocModeToolbar width="wide" onWidth={() => {}} inputMode="select" onModeChange={onModeChange} />,
    );
    await userEvent.click(screen.getByTestId("input-mode-pinpoint"));
    // The chip drives the parent's mode state (the parent OWNS inputMode — viewer-screen).
    expect(onModeChange).toHaveBeenCalledWith("pinpoint");
    // Once the parent flips inputMode to pinpoint, the Pinpoint chip reads active and Select does not.
    rerender(<DocModeToolbar width="wide" onWidth={() => {}} inputMode="pinpoint" onModeChange={onModeChange} />);
    expect(screen.getByTestId("input-mode-pinpoint").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("input-mode-select").getAttribute("data-active")).not.toBe("true");
  });

  it("AS-001: clicking Select while in Pinpoint mode switches back to select", async () => {
    const onModeChange = mock((_m: "select" | "pinpoint") => {});
    render(<DocModeToolbar width="wide" onWidth={() => {}} inputMode="pinpoint" onModeChange={onModeChange} />);
    await userEvent.click(screen.getByTestId("input-mode-select"));
    expect(onModeChange).toHaveBeenCalledWith("select");
  });

  it("C-009: the Wide / Focus measure switch sits at the far right and still works", async () => {
    const onWidth = mock((_w: string) => {});
    render(<DocModeToolbar width="wide" onWidth={onWidth} inputMode="select" onModeChange={() => {}} />);
    const toolbar = screen.getByTestId("doc-mode-toolbar");
    // Pushed to the far right (ml-auto wrapper) — last interactive group in the toolbar.
    const widthSeg = screen.getByTestId("doc-width-seg");
    expect(widthSeg.className).toContain("ml-auto");
    await userEvent.click(within(toolbar).getByRole("button", { name: "Focus" }));
    expect(onWidth).toHaveBeenCalledWith("focus");
  });

  it("hides the Wide / Focus measure switch when showWidth is false (HTML/image docs)", () => {
    render(<DocModeToolbar width="wide" onWidth={() => {}} showWidth={false} inputMode="select" onModeChange={() => {}} />);
    // The column measure does not apply to a sandbox-framed doc — the segment is gone entirely.
    expect(screen.queryByTestId("doc-width-seg")).toBeNull();
    expect(screen.queryByRole("button", { name: "Wide" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Focus" })).toBeNull();
  });
});

describe("DocModeToolbar S-006 markup tool palette (C-009)", () => {
  it("C-009: the palette lists Markup · Comment · Redline · Label", () => {
    render(<DocModeToolbar width="wide" onWidth={() => {}} inputMode="select" onModeChange={() => {}} />);
    const group = screen.getByTestId("markup-tool-group");
    expect(within(group).getByTestId("markup-tool-markup")).toBeTruthy();
    expect(within(group).getByTestId("markup-tool-comment")).toBeTruthy();
    expect(within(group).getByTestId("markup-tool-redline")).toBeTruthy();
    expect(within(group).getByTestId("markup-tool-label")).toBeTruthy();
  });

  it("C-009: Markup is the default active tool (preserves S-001 Markup+select → popover)", () => {
    render(<DocModeToolbar width="wide" onWidth={() => {}} inputMode="select" onModeChange={() => {}} />);
    expect(screen.getByTestId("markup-tool-markup").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("markup-tool-comment").getAttribute("data-active")).not.toBe("true");
  });

  it("C-009: exactly one tool is active — clicking a tool calls onTool with its key", async () => {
    const onTool = mock((_t: string) => {});
    render(
      <DocModeToolbar
        width="wide"
        onWidth={() => {}}
        inputMode="select" onModeChange={() => {}}
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
        inputMode="select" onModeChange={() => {}}
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
