import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type LucideIcon,
  MousePointer2,
  SquareDashedMousePointer,
  Highlighter,
  MessageSquareText,
  Eraser,
  Zap,
} from "lucide-react";

// DocModeToolbar (annotation-core-ui-types-modes S-001 + S-006, UI Notes §Component Tree): the sticky
// toolbar at the top of the doc pane, mirroring the Anchord-Design viewer prototype. Left→right:
//   • Select | Pinpoint — Select is the active read/selection mode owned HERE. Pinpoint (the whole-
//     block element picker) is Phase 2, so it surfaces a "coming" note instead of dead UI (kept
//     visible so the shell matches the prototype). Rendered with the SAME expanding chip system as
//     the markup tools (Plannotator's input-method group uses identical expanding buttons).
//   • a markup TOOL GROUP — Markup · Comment · Redline · Label (S-006/C-009). Exactly ONE tool is
//     active; the ACTIVE tool routes a text selection (the routing lives in viewer-screen): Markup →
//     the 5-type popover, Comment → the composer directly, Redline → a red strike directly, Label →
//     the picker directly. Each chip is COLLAPSED to an icon at rest and EXPANDS to icon + label + its
//     per-type hue (DESIGN.md "Annotation type / tool colors") when active OR hovered; inactive chips
//     stay icon-only + muted.
//   • Wide | Focus — pushed to the FAR RIGHT — the doc measure (Wide = full column width, Focus =
//     800px capped), driven via `data-doc-width` on the docpane. Stays a plain text segmented toggle.
//
// MƯỢT (S-006 polish): the chips port Plannotator's AnnotationToolstrip ToolstripButton smoothness —
// an EXPLICIT measured pixel width is animated (not a max-width guess). Each chip measures its label
// off-screen, then `width = expanded ? (H_PAD + ICON_INNER + GAP + labelWidth + H_PAD) : ICON_SIZE`
// eases over DURATION with a cubic-bezier; the label fades in just AFTER the width starts opening.
// A `mounted` flag suppresses transitions until after first paint (no mount flash); reduced-motion
// disables all of it. MIT/Apache technique mirrored from Plannotator.

// The runtime list is the single source of truth; the type derives from it so the persisted-state
// allow-list (usePersistentState) and the union can never drift apart.
export const MARKUP_TOOLS = ["markup", "comment", "redline", "label"] as const;
export type MarkupTool = (typeof MARKUP_TOOLS)[number];
// pinpoint S-001 (C-001): the two mutually-exclusive INPUT modes. Select = drag-select text → range
// annotation (the default read/select state); Pinpoint = hover-outline a block + click it → whole-
// block annotation (block-pick is S-002). ViewerScreen OWNS this state; the toolbar only reflects it
// + asks the parent to switch via onModeChange.
export const INPUT_MODES = ["select", "pinpoint"] as const;
export type InputMode = (typeof INPUT_MODES)[number];
type DocWidth = "wide" | "focus";

// DESIGN.md "Annotation type / tool colors" (PO-approved 2026-06-15): Markup teal · Comment amber ·
// Redline red · Label gold. The hue tints a tool affordance ONLY (active/hover), never general chrome.
const TOOL_META: Record<MarkupTool, { label: string; icon: LucideIcon; hue: string }> = {
  markup: { label: "Markup", icon: Highlighter, hue: "#37b3bd" },
  comment: { label: "Comment", icon: MessageSquareText, hue: "#d68a3e" },
  redline: { label: "Redline", icon: Eraser, hue: "#f1655d" },
  label: { label: "Label", icon: Zap, hue: "#cbb24a" },
};

const TOOL_ORDER: MarkupTool[] = ["markup", "comment", "redline", "label"];

// Plannotator ToolstripButton geometry — the measured-width recipe.
const ICON_SIZE = 28; // collapsed square width (px)
const H_PAD = 8;
const GAP = 6;
const ICON_INNER = 14;
const DURATION = 180; // within DESIGN.md "short 150–200ms"
const EASE = "cubic-bezier(0.25,0.46,0.45,0.94)";

// One expanding chip — the shared affordance for BOTH the Select|Pinpoint input-method group and the
// markup tool group (parameterised by hue / active / onClick so both groups animate identically). It
// measures its label off-screen and animates an explicit pixel width (Plannotator's technique), so the
// expand/collapse is smooth instead of a max-width guess. Collapsed → icon-only square; expanded
// (active OR hovered OR touch) → icon + label + its hue. `data-expanded` + `data-active` + the label's
// `data-collapsed`/`aria-hidden` are the test hooks; the visual pixel-match is [→MANUAL].
function ToolChip({
  testId,
  labelTestId,
  tool,
  icon: IconCmp,
  label,
  hue,
  active,
  mounted,
  reduceMotion,
  ariaPressed,
  onClick,
}: {
  testId: string;
  labelTestId: string;
  tool?: string;
  icon: LucideIcon;
  label: string;
  hue: string;
  active: boolean;
  mounted: boolean;
  reduceMotion: boolean;
  ariaPressed?: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [labelWidth, setLabelWidth] = useState(0);

  // Measure the label width off-screen so the expanded width is exact (Plannotator step 1).
  useLayoutEffect(() => {
    if (measureRef.current) setLabelWidth(measureRef.current.offsetWidth);
  }, [label]);

  const isTouch =
    typeof window !== "undefined" &&
    ("ontouchstart" in window || (navigator?.maxTouchPoints ?? 0) > 0);
  const expanded = active || hovered || isTouch;

  const expandedWidth = H_PAD + ICON_INNER + GAP + labelWidth + H_PAD;
  const width = expanded ? expandedWidth : ICON_SIZE;

  const animate = mounted && !reduceMotion;
  const widthTransition = animate
    ? `width ${DURATION}ms ${EASE}, background-color ${DURATION}ms ease, color ${DURATION}ms ease, box-shadow ${DURATION}ms ease`
    : "none";
  const padTransition = animate ? `padding-left ${DURATION}ms ${EASE}` : "none";
  const labelTransition = animate
    ? `opacity ${expanded ? DURATION : DURATION * 0.6}ms ease ${expanded ? "60ms" : "0ms"}`
    : "none";

  // Active = full hue (coloured icon/text + hue bg). Inactive+hovered = a lighter hue HINT (so hover
  // reads warmer than rest). Resting inactive = muted, icon-only (no inline colour). The ACTIVE bg is
  // a clearly-visible tint (`33` ≈ 20%), not the old faint `1f` ≈ 12% — a selected tool now reads.
  let chipStyle: React.CSSProperties = { width, transition: widthTransition };
  if (active) {
    chipStyle = { ...chipStyle, color: hue, background: `${hue}33` };
  } else if (hovered) {
    chipStyle = { ...chipStyle, color: `${hue}cc`, background: `${hue}1f` };
  }

  return (
    <button
      type="button"
      data-testid={testId}
      data-tool={tool}
      data-active={active ? "true" : undefined}
      data-expanded={expanded ? "true" : undefined}
      aria-pressed={ariaPressed}
      aria-label={label}
      title={label}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={[
        "relative flex h-7 items-center overflow-hidden rounded-md text-[12px] font-medium",
        active ? "shadow-sm" : hovered ? "" : "text-subtle",
      ].join(" ")}
      style={chipStyle}
    >
      {/* Inner wrapper: paddingLeft centers the icon when collapsed, opens to H_PAD when expanded. */}
      <div
        className="flex items-center whitespace-nowrap"
        style={{
          paddingLeft: expanded ? H_PAD : (ICON_SIZE - ICON_INNER) / 2,
          gap: GAP,
          transition: padTransition,
        }}
      >
        <IconCmp size={ICON_INNER} strokeWidth={2} className="shrink-0" />
        {/* Label fades in slightly AFTER the width opens (60ms delay), fades out faster on collapse.
            Always mounted + aria-hidden when collapsed so the chip animates instead of popping. */}
        <span
          data-testid={labelTestId}
          data-collapsed={expanded ? undefined : "true"}
          aria-hidden={!expanded}
          style={{ opacity: expanded ? 1 : 0, transition: labelTransition }}
        >
          {label}
        </span>
      </div>
      {/* Off-screen measurer (Plannotator): gives the exact expanded width. */}
      <span
        ref={measureRef}
        aria-hidden
        className="text-[12px] font-medium"
        style={{ visibility: "hidden", position: "absolute", left: -9999, whiteSpace: "nowrap" }}
      >
        {label}
      </span>
    </button>
  );
}

function Seg({
  options,
  value,
  onChange,
}: {
  options: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="inline-flex gap-0.5 rounded-md border border-line bg-sunken p-0.5">
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            data-active={active ? "true" : undefined}
            onClick={() => onChange(o.key)}
            className={[
              "h-6 rounded px-2.5 text-[12px] font-medium transition-colors",
              active
                ? "bg-surface font-semibold text-accent-ink shadow-sm"
                : "text-muted hover:text-ink",
            ].join(" ")}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function DocModeToolbar({
  width,
  onWidth,
  showWidth = true,
  inputMode,
  onModeChange,
  activeTool = "markup",
  onTool,
}: {
  width: DocWidth;
  onWidth: (w: DocWidth) => void;
  /** Show the Wide|Focus measure toggle. Only meaningful for markdown (the .doc-prose column);
   *  an HTML/image doc renders in its own sandbox frame, so the caller hides it there. Default true. */
  showWidth?: boolean;
  /** pinpoint S-001 (C-001): the active input mode, OWNED by ViewerScreen. The Select|Pinpoint chips
   *  reflect it (the active chip reads active) and request a switch via onModeChange — Pinpoint is now
   *  a live toggle, not a "coming soon" note. */
  inputMode: InputMode;
  /** pinpoint S-001: switch the input mode (the chip click). The parent flips its state, which flows
   *  back in as `inputMode` and gates the selection→create path in use-compose. */
  onModeChange: (mode: InputMode) => void;
  /** S-006/C-009: the active markup tool — exactly one. Defaults to Markup (preserves S-001: Markup +
   *  select → the 5-type popover). The ACTIVE tool routes the selection (the routing is in viewer-screen). */
  activeTool?: MarkupTool;
  /** S-006: choose a markup tool (the chip click). Absent → the tool group renders read-only (e.g. an
   *  early shell before the doc resolves); but normally the viewer wires this to its activeTool state. */
  onTool?: (tool: MarkupTool) => void;
}) {
  // `mounted` gate: transitions stay 'none' until after first paint so chips don't flash open on mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const r = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(r);
  }, []);

  // Reduced-motion respected once (guard for happy-dom: matchMedia may be undefined → default false).
  const reduceMotion =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

  return (
    <div
      data-testid="doc-mode-toolbar"
      className="sticky top-0 z-[5] flex h-11 items-center gap-2.5 border-b border-line-soft bg-paper/85 px-5 backdrop-blur"
    >
      {/* Select | Pinpoint — the input-method group, SAME expanding chip system as the markup tools
          (Plannotator parity). pinpoint S-001 (C-001): these are now MUTUALLY-EXCLUSIVE live modes —
          exactly one is active, driven by the parent's `inputMode`. Select = drag-select text →
          range annotation; Pinpoint = hover-outline a block + click → whole-block annotation. Each
          chip requests its mode via onModeChange (no more "coming soon" no-op). */}
      <div
        data-testid="input-mode-group"
        role="group"
        aria-label="Input mode"
        className="inline-flex items-center gap-0.5 rounded-md border border-line bg-sunken p-0.5"
      >
        <ToolChip
          testId="input-mode-select"
          labelTestId="input-mode-select-label"
          icon={MousePointer2}
          label="Select"
          hue="#37b3bd"
          active={inputMode === "select"}
          mounted={mounted}
          reduceMotion={reduceMotion}
          ariaPressed={inputMode === "select"}
          onClick={() => onModeChange("select")}
        />
        <ToolChip
          testId="input-mode-pinpoint"
          labelTestId="input-mode-pinpoint-label"
          icon={SquareDashedMousePointer}
          label="Pinpoint"
          hue="#37b3bd"
          active={inputMode === "pinpoint"}
          mounted={mounted}
          reduceMotion={reduceMotion}
          ariaPressed={inputMode === "pinpoint"}
          onClick={() => onModeChange("pinpoint")}
        />
      </div>

      {/* S-006/C-009: the markup tool palette. Exactly one tool active; the active tool routes the
          selection (Markup → popover, Comment → composer, Redline → strike, Label → picker). */}
      <div
        data-testid="markup-tool-group"
        role="group"
        aria-label="Markup tool"
        className="inline-flex items-center gap-0.5 rounded-md border border-line bg-sunken p-0.5"
      >
        {TOOL_ORDER.map((tool) => {
          const meta = TOOL_META[tool];
          const active = tool === activeTool;
          return (
            <ToolChip
              key={tool}
              testId={`markup-tool-${tool}`}
              labelTestId={`markup-tool-${tool}-label`}
              tool={tool}
              icon={meta.icon}
              label={meta.label}
              hue={meta.hue}
              active={active}
              mounted={mounted}
              reduceMotion={reduceMotion}
              ariaPressed={active}
              onClick={() => onTool?.(tool)}
            />
          );
        })}
      </div>

      {/* Wide | Focus — pushed to the FAR RIGHT (ml-auto), the doc measure. Plain text segmented
          toggle (kept on transition-colors — NOT converted to chips). Hidden for non-markdown docs
          (HTML/image render in a sandbox frame where the column measure does not apply). */}
      {showWidth && (
        <div data-testid="doc-width-seg" className="ml-auto">
          <Seg
            options={[
              { key: "wide", label: "Wide" },
              { key: "focus", label: "Focus" },
            ]}
            value={width}
            onChange={(k) => onWidth(k as DocWidth)}
          />
        </div>
      )}
    </div>
  );
}
