import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { useDismissOnOutsideAndEscape } from "@/features/viewer/hooks/use-dismiss";

// SelectionPopover (S-001 — annotation-core-ui-types-modes): the floating Markup popover that
// appears over a live text selection on a rendered Markdown doc. Mirrors the prototype `viewer.jsx`
// SelectionPopover. It is the SINGLE entry that maps a selection to one create path: the chosen
// action sets the annotation `type`/`label`. It offers the five annotation types
// Comment · Like · Label · Redline · Suggest (+ Dismiss).
//
// S-006 reframe (2026-06-15): this surface is now the MARKUP TOOL's surface — it is shown ONLY when
// the Markup tool is active (the other tools route the selection directly, viewer-screen/C-009). Its
// buttons carry the SAME compact icon → hover-expand + per-type hue treatment as the toolbar tool
// chips (DESIGN.md "Annotation type / tool colors"): each button is ICON-ONLY, tinted its type hue so
// the surface reads by colour (PO 2026-06-15 — no verbose text). The type name is the accessible name
// (aria-label + title tooltip); hover deepens the hue + adds a soft bg tint.
//
// SCOPE (S-001): this surface only DISPATCHES the chosen intent — Comment keeps its own dedicated
// `onComment` seam (the built commenting create path); Like/Label/Redline/Suggest fire `onSelectType`
// with the type, which the later stories (S-002 Redline / S-003 Like / S-004 Label, and the suggest-
// image sibling for Suggest) consume to open the labeled-create / picker / redline paths. This file
// does NOT build the LabelPicker, the redline strike, or any client create call.
//
// C-001 gate is upstream (the viewer only mounts this for a comment-capable role); C-003/C-008 are
// also upstream (the viewer only sets a selection when selectionToAnchor returned a real block-scoped
// range). So this component is a pure presentational affordance — if it's rendered, the selection is
// real and the role may comment; clicking a type dispatches an intent, it never touches the anchor.
//
// MƯỢT TASK 1: on mount/update the popover MEASURES itself (getBoundingClientRect) and reports its
// size up via `onMeasure`, so use-compose's placePopover can flip/clamp against the real width/height
// (happy-dom returns 0 — the hook falls back to a default size). `rect` is the ALREADY-positioned
// {top,left} from placePopover; this component just renders at it.
//
// MƯỢT TASK 4: outside-click + Escape dismiss via useDismissOnOutsideAndEscape (the multi-click guard
// keeps a triple-click paragraph selection alive — adopted from Plannotator, Apache-2.0).

/** The Markup types this popover dispatches via `onSelectType` (Comment rides its own `onComment`
 *  seam). The chosen action sets the annotation `type`/`label` downstream (S-002/S-003/S-004). */
export type MarkupType = "like" | "label" | "redline" | "suggest";

// DESIGN.md "Annotation type / tool colors" — the per-type hue applied on hover (the compact
// icon→hover-expand+colour affordance, shared with the toolbar tool chips). Comment amber · Redline
// red · Label gold · Like green · Suggest teal (the parent Markup accent).
const TYPE_HUE: Record<string, string> = {
  comment: "#d68a3e",
  like: "#43b873",
  label: "#cbb24a",
  redline: "#f1655d",
  suggest: "#37b3bd",
};

// One popover button: ICON-ONLY, tinted with its type hue so the surface reads by colour, not by
// text (PO 2026-06-15 — "icon + màu, no long labels"). The label is the accessible name (aria-label +
// native title tooltip on hover) so the popover still "offers Comment/Like/Label/Redline/Suggest"
// (AS-001) without verbose text. Hover deepens the hue + adds a soft bg tint (the affordance pattern).
function PopoverButton({
  type,
  testId,
  icon,
  label,
  onClick,
}: {
  type: string;
  testId: string;
  icon: string;
  label: string;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const hue = TYPE_HUE[type];
  return (
    <button
      type="button"
      data-testid={testId}
      data-type={type}
      data-hovered={hovered ? "true" : undefined}
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="inline-flex items-center justify-center rounded-[5px] p-1.5 transition-colors"
      // icon coloured its type hue at rest; hover → soft bg tint of the same hue (DESIGN.md affordance).
      style={{ color: hue, background: hovered && hue ? `${hue}24` : undefined }}
    >
      <Icon name={icon} size={16} />
    </button>
  );
}

export function SelectionPopover({
  rect,
  onComment,
  onSelectType,
  onDismiss,
  onMeasure,
}: {
  /** the already-positioned {top,left,centered} (placePopover output). When `centered`, `left` is
   *  the CENTER x of the selection → apply translateX(-50%) (above-centered, Plannotator). */
  rect: { top: number; left: number; centered?: boolean };
  /** Comment keeps its dedicated handler — the built commenting create path (not a type intent). */
  onComment: () => void;
  /** Like/Label/Redline/Suggest dispatch the chosen type intent for the later create paths to consume. */
  onSelectType?: (type: MarkupType) => void;
  onDismiss: () => void;
  /** MƯỢT TASK 1: report the popover's measured size so the positioner can flip/clamp. */
  onMeasure?: (size: { width: number; height: number }) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Measure after layout so the next reposition uses the real size.
  useEffect(() => {
    const el = ref.current;
    if (!el || !onMeasure) return;
    const r = el.getBoundingClientRect();
    onMeasure({ width: r.width, height: r.height });
  }, [onMeasure]);

  useDismissOnOutsideAndEscape(ref, onDismiss);

  // MƯỢT (S-006 polish): Plannotator's popover entrance — scale(0.95)→1 + opacity 0→1, 0.15s ease-out,
  // origin top-center (it floats ABOVE the selection). The scale rides an inner wrapper's `animation`
  // so it never fights the outer `translateX(-50%)` centering transform (the two transforms live on
  // different elements). Reduced-motion → no animation (the keyframes are gated by the media query).
  return (
    <>
      <style>{`
        @keyframes anchord-popover-in {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        @media (prefers-reduced-motion: no-preference) {
          [data-testid="selection-popover"] > [data-popover-anim] {
            animation: anchord-popover-in 0.15s ease-out;
            transform-origin: top center;
          }
        }
      `}</style>
      <div
        ref={ref}
        data-testid="selection-popover"
        role="toolbar"
        aria-label="Selection actions"
        // centered: `left` is the selection's center x → translateX(-50%) centers the popover over it
        // (above-centered tooltip, Plannotator center-above, Apache-2.0). The entrance scale lives on
        // the inner wrapper below, so it composes with this centering translate instead of fighting it.
        className="absolute z-40"
        style={{ top: rect.top, left: rect.left, transform: rect.centered ? "translateX(-50%)" : undefined }}
      >
        {/* Inner wrapper carries the scale-in entrance + the visual surface (.selection-popover: floats
            over the range; elev surface, line border, r-md). */}
        <div
          data-popover-anim
          className="flex items-center gap-0.5 rounded-md border border-line bg-elev p-1 shadow-lg"
        >
      <PopoverButton type="comment" testId="popover-comment" icon="inbox" label="Comment" onClick={onComment} />
      <PopoverButton type="like" testId="popover-like" icon="check" label="Like" onClick={() => onSelectType?.("like")} />
      <PopoverButton type="label" testId="popover-label" icon="pin" label="Label" onClick={() => onSelectType?.("label")} />
      <PopoverButton type="redline" testId="popover-redline" icon="trash" label="Redline" onClick={() => onSelectType?.("redline")} />
      <PopoverButton type="suggest" testId="popover-suggest" icon="pencil" label="Suggest" onClick={() => onSelectType?.("suggest")} />
      <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
      <button
        type="button"
        data-testid="popover-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="inline-flex items-center rounded-[5px] p-1 text-subtle hover:bg-sunken hover:text-ink"
      >
          <Icon name="x" size={14} />
        </button>
        </div>
      </div>
    </>
  );
}
