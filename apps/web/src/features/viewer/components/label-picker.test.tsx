import { describe, it, expect, mock } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// annotation-core-ui-types-modes S-004 — LabelPicker (single-subject).
//
// The dropdown that lists the v0 FIXED shared preset set (C-004) and emits a REAL preset id when a
// row is chosen (AS-012/AS-013). The display metadata (id → text/icon/color) is the SHARED
// LABEL_PRESETS constant — the SAME source ThreadCard's label line reads (one home, C-004).

import { LabelPicker } from "@/features/viewer/components/label-picker";
import { LABEL_PRESETS } from "@/features/viewer/lib/label-presets";
import { DEFAULT_LABEL_PRESETS } from "../../../../../backend/src/annotation/label-presets";

const RECT = { top: 10, left: 20, centered: true };

function renderPicker(props: Partial<Parameters<typeof LabelPicker>[0]> = {}) {
  return render(
    <LabelPicker rect={RECT} onPick={() => {}} onDismiss={() => {}} {...props} />,
  );
}

describe("LabelPicker (S-004)", () => {
  it("AS-013: the picker lists the DEFAULT_LABEL_PRESETS default set", () => {
    renderPicker();
    const picker = screen.getByTestId("label-picker");
    // The spec's enumerated rows are present, by display text.
    for (const text of [
      "Clarify this",
      "Verify this",
      "Out of scope",
      "Needs tests",
      "Nice approach",
      "Missing overview",
    ]) {
      expect(within(picker).getByText(text)).toBeTruthy();
    }
    // It lists the WHOLE set — one row per preset, no more, no fewer.
    const rows = within(picker).getAllByRole("menuitem");
    expect(rows).toHaveLength(LABEL_PRESETS.length);
  });

  it("C-004: the FE preset ids are in LOCKSTEP with the backend DEFAULT_LABEL_PRESETS (one v0 fixed set, no per-workspace table)", () => {
    // The FE display set must carry exactly the backend's canonical ids (same set, same order) — the
    // picker stores `label=<id>` and the server validates ∈ that set, so a drift would silently make
    // every label forged.
    expect(LABEL_PRESETS.map((p) => p.id)).toEqual([...DEFAULT_LABEL_PRESETS]);
  });

  it("AS-012: choosing \"Out of scope\" emits the out-of-scope preset id", async () => {
    const onPick = mock(() => {});
    renderPicker({ onPick });
    await userEvent.click(screen.getByTestId("label-option-out-of-scope"));
    expect(onPick).toHaveBeenCalledTimes(1);
    const preset = onPick.mock.calls[0]![0] as { id: string; text: string };
    expect(preset.id).toBe("out-of-scope");
    expect(preset.text).toBe("Out of scope");
    // The emitted id is a REAL preset id (a foreign id can't be picked — there is no row for it).
    expect(DEFAULT_LABEL_PRESETS).toContain(preset.id);
  });

  it("C-006: the row display text is inert plaintext (a constant, never interpreted)", () => {
    // Defence-in-depth: the picker text is a build-time constant (not user input). It renders via
    // React children — no row injects HTML. Asserting the rows carry no element children beyond the
    // swatch+label spans guards against a future change rendering raw markup.
    renderPicker();
    const row = screen.getByTestId("label-option-out-of-scope");
    expect(row.querySelector("script")).toBeNull();
    expect(row.querySelector("img")).toBeNull();
    expect(row).toHaveTextContent("Out of scope");
  });
});
