import { useRef } from "react";
import { Icon } from "@/components/icon";
import { useDismissOnOutsideAndEscape } from "@/features/viewer/hooks/use-dismiss";
import { LABEL_PRESETS, type LabelPreset } from "@/features/viewer/lib/label-presets";

// LabelPicker (S-004 — annotation-core-ui-types-modes): the dropdown that opens when the user picks
// Label in the SelectionPopover. It lists the v0 FIXED shared preset set (C-004 — LABEL_PRESETS, NOT
// a per-workspace table); each row is an icon + a preset colour swatch + the display text (UI Notes).
// Choosing a row dispatches `onPick(preset)` — the consumer then runs the labeled-create (open the
// composer pre-filled with the preset text, carrying `label=<presetId>`, the same path as Like).
//
// AS-013: the picker lists the default set. AS-012: choosing "Out of scope" sends the `out-of-scope`
// id up. The display text is a CONSTANT (not user input) so it's inert by construction; it still
// renders via React children. This component does NOT create the annotation — it only emits the id.
//
// Dismiss: outside-click + Escape (shared useDismissOnOutsideAndEscape) so the picker closes like the
// selection popover/composer; the multi-click guard keeps a live selection alive (Plannotator).

export function LabelPicker({
  rect,
  onPick,
  onDismiss,
}: {
  /** the already-positioned {top,left,centered} (the selection popover's anchor). When `centered`,
   *  `left` is the selection's CENTER x → apply translateX(-50%) (above-centered, like the popover). */
  rect: { top: number; left: number; centered?: boolean };
  /** the chosen preset — the consumer opens the composer pre-filled with `preset.text`, carrying
   *  `label=preset.id` (the one labeled-create path). The picker only ever emits a REAL preset id. */
  onPick: (preset: LabelPreset) => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutsideAndEscape(ref, onDismiss);

  return (
    <div
      ref={ref}
      data-testid="label-picker"
      role="menu"
      aria-label="Choose a label"
      // A floating dropdown over the selection — elev surface, line border, r-md, like the popover.
      className="absolute z-40 flex w-[208px] flex-col gap-0.5 rounded-md border border-line bg-elev p-1 shadow-lg"
      style={{ top: rect.top, left: rect.left, transform: rect.centered ? "translateX(-50%)" : undefined }}
    >
      {LABEL_PRESETS.map((preset) => (
        <button
          key={preset.id}
          type="button"
          role="menuitem"
          data-testid={`label-option-${preset.id}`}
          data-label={preset.id}
          onClick={() => onPick(preset)}
          className="flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-left text-[12.5px] font-medium text-ink hover:bg-sunken"
        >
          {/* the preset's identity colour swatch + its line glyph (UI Notes: icon + colour + text). */}
          <span
            aria-hidden
            className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-[4px]"
            style={{ color: preset.color, background: `${preset.color}1f` }}
          >
            {preset.emoji ? (
              <span className="text-[12px]">{preset.emoji}</span>
            ) : (
              <Icon name={preset.icon} size={13} />
            )}
          </span>
          {/* inert plaintext via React children (the text is a constant, C-006). */}
          <span className="min-w-0 flex-1 truncate">{preset.text}</span>
        </button>
      ))}
    </div>
  );
}
