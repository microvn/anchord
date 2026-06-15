import { describe, it, expect, mock } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// annotation-core-ui-types-modes S-001 — the Markup popover surface. A single-subject render test
// of SelectionPopover: given a real text selection (this component is mounted ONLY for a real
// selection + a comment-capable role — both gated upstream in useCompose, see commenting.test.tsx),
// the popover offers the five annotation types Comment · Like · Label · Redline · Suggest, and the
// chosen action dispatches the matching intent (the single entry → one create path; the create paths
// themselves are S-002/S-003/S-004, not this story).
//
// AS-001 the popover lists Comment · Like · Label · Redline · Suggest.
// C-001  (client gate) — covered at the viewer-integration level (AS-002): this surface is presentational.
// C-008.T1 — the popover operates on the existing block-scoped selection; it does NOT compute or
//            mutate the anchor model (it only dispatches a type intent), proven by the intent payload.

import { SelectionPopover } from "./selection-popover";

const rect = { top: 100, left: 200, centered: true as const };

function noop() {}

describe("SelectionPopover S-001", () => {
  it("AS-001: the Markup popover offers Comment, Like, Label, Redline, and Suggest", () => {
    render(
      <SelectionPopover
        rect={rect}
        onComment={noop}
        onSelectType={noop}
        onDismiss={noop}
      />,
    );

    const popover = screen.getByTestId("selection-popover");
    // All five annotation types are offered by the single popover entry. The buttons are icon-only
    // (PO 2026-06-15) — the type name is the accessible name (aria-label), not visible text.
    expect(within(popover).getByTestId("popover-comment").getAttribute("aria-label")).toMatch(/comment/i);
    expect(within(popover).getByTestId("popover-like").getAttribute("aria-label")).toMatch(/like/i);
    expect(within(popover).getByTestId("popover-label").getAttribute("aria-label")).toMatch(/label/i);
    expect(within(popover).getByTestId("popover-redline").getAttribute("aria-label")).toMatch(/redline/i);
    expect(within(popover).getByTestId("popover-suggest").getAttribute("aria-label")).toMatch(/suggest/i);
  });

  it("AS-001: Comment keeps its dedicated handler (the existing create path)", async () => {
    const onComment = mock(() => {});
    const onSelectType = mock((_t: string) => {});
    render(
      <SelectionPopover
        rect={rect}
        onComment={onComment}
        onSelectType={onSelectType}
        onDismiss={noop}
      />,
    );
    await userEvent.click(screen.getByTestId("popover-comment"));
    expect(onComment).toHaveBeenCalledTimes(1);
    // Comment uses its own seam (the built commenting create path), not the new type intent.
    expect(onSelectType).not.toHaveBeenCalled();
  });

  it("AS-001 / C-008.T1: each new type dispatches its intent on the existing selection (single entry → one create path)", async () => {
    const onSelectType = mock((_t: string) => {});
    render(
      <SelectionPopover
        rect={rect}
        onComment={noop}
        onSelectType={onSelectType}
        onDismiss={noop}
      />,
    );

    await userEvent.click(screen.getByTestId("popover-like"));
    await userEvent.click(screen.getByTestId("popover-label"));
    await userEvent.click(screen.getByTestId("popover-redline"));
    await userEvent.click(screen.getByTestId("popover-suggest"));

    // The chosen action sets the type — it dispatches the intent, it does NOT compute/mutate the
    // block-scoped anchor here (C-008: the anchor model stays untouched by this surface).
    const types = onSelectType.mock.calls.map((c) => c[0]);
    expect(types).toEqual(["like", "label", "redline", "suggest"]);
  });

  it("AS-001: the popover still offers Dismiss", async () => {
    const onDismiss = mock(() => {});
    render(
      <SelectionPopover
        rect={rect}
        onComment={noop}
        onSelectType={noop}
        onDismiss={onDismiss}
      />,
    );
    await userEvent.click(screen.getByTestId("popover-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
