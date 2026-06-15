import { useState } from "react";
import { Icon } from "@/components/icon";

// DocModeToolbar (annotation-core-ui-types-modes S-001 + S-006, UI Notes §Component Tree): the sticky
// toolbar at the top of the doc pane, mirroring the Anchord-Design viewer prototype. Left→right:
//   • Select | Pinpoint — Select is the active read/selection mode owned HERE. Pinpoint (the whole-
//     block element picker) is Phase 2, so it surfaces a "coming" note instead of dead UI (kept
//     visible so the shell matches the prototype).
//   • a markup TOOL GROUP — Markup · Comment · Redline · Label (S-006/C-009). Exactly ONE tool is
//     active; the ACTIVE tool routes a text selection (the routing lives in viewer-screen): Markup →
//     the 5-type popover, Comment → the composer directly, Redline → a red strike directly, Label →
//     the picker directly. Each chip is COLLAPSED to an icon at rest and EXPANDS to icon + label + its
//     per-type hue (DESIGN.md "Annotation type / tool colors") when active OR hovered; inactive chips
//     stay icon-only + muted.
//   • Wide | Focus — pushed to the FAR RIGHT — the doc measure (Wide = full column width, Focus =
//     800px capped), driven via `data-doc-width` on the docpane (widths live in styles.css .doc-prose).

export type MarkupTool = "markup" | "comment" | "redline" | "label";
type DocWidth = "wide" | "focus";

// DESIGN.md "Annotation type / tool colors" (PO-approved 2026-06-15): Markup teal · Comment amber ·
// Redline red · Label gold. The hue tints a tool affordance ONLY (active/hover), never general chrome.
const TOOL_META: Record<MarkupTool, { label: string; icon: string; hue: string }> = {
  markup: { label: "Markup", icon: "pencil", hue: "#37b3bd" },
  comment: { label: "Comment", icon: "inbox", hue: "#d68a3e" },
  redline: { label: "Redline", icon: "trash", hue: "#f1655d" },
  label: { label: "Label", icon: "pin", hue: "#cbb24a" },
};

const TOOL_ORDER: MarkupTool[] = ["markup", "comment", "redline", "label"];

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

// A single markup tool chip (S-006/C-009): collapsed to an icon at rest; expands to icon + label + its
// hue (soft bg tint + coloured icon/text) when active OR hovered. The expand/colour is visual ([→MANUAL]
// pixel-match), but we expose a data-active hook + a data-expanded hook + the hue via inline style so a
// test can assert the active tool carries its label + colour and inactive tools are icon-only.
function ToolChip({
  tool,
  active,
  onSelect,
}: {
  tool: MarkupTool;
  active: boolean;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const meta = TOOL_META[tool];
  const expanded = active || hovered;
  return (
    <button
      type="button"
      data-testid={`markup-tool-${tool}`}
      data-tool={tool}
      data-active={active ? "true" : undefined}
      data-expanded={expanded ? "true" : undefined}
      aria-pressed={active}
      aria-label={meta.label}
      title={meta.label}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={[
        // transition-all so the padding + bg + colour ease together with the label reveal below.
        // DESIGN.md motion: short 150ms, ease-out; respect reduced-motion.
        "inline-flex h-7 items-center rounded-md text-[12px] font-medium transition-all duration-150 ease-out motion-reduce:transition-none",
        expanded ? "px-2" : "px-1.5 text-subtle",
      ].join(" ")}
      // Active/hover → the tool's hue (coloured icon/text + a soft bg tint, DESIGN.md affordance
      // pattern). Inactive/resting → icon-only + muted (the className handles the muted colour).
      style={
        expanded
          ? { color: meta.hue, background: `${meta.hue}1f` }
          : undefined
      }
    >
      <Icon name={meta.icon} size={14} />
      {/* The label is ALWAYS mounted and animated open/closed (max-width + opacity + the icon gap),
          so the chip expands/collapses smoothly instead of the label popping in/out. Collapsed →
          clipped to 0 width, faded out, aria-hidden (the button's aria-label keeps the a11y name). */}
      <span
        data-testid={`markup-tool-${tool}-label`}
        data-collapsed={expanded ? undefined : "true"}
        aria-hidden={!expanded}
        className="overflow-hidden whitespace-nowrap transition-all duration-150 ease-out motion-reduce:transition-none"
        style={{
          maxWidth: expanded ? "6rem" : 0,
          opacity: expanded ? 1 : 0,
          marginLeft: expanded ? "0.375rem" : 0,
        }}
      >
        {meta.label}
      </span>
    </button>
  );
}

export function DocModeToolbar({
  width,
  onWidth,
  onPinpointUnavailable,
  activeTool = "markup",
  onTool,
}: {
  width: DocWidth;
  onWidth: (w: DocWidth) => void;
  /** Pinpoint mode is Phase 2 — surface a "coming" note instead of a no-op toggle. */
  onPinpointUnavailable: () => void;
  /** S-006/C-009: the active markup tool — exactly one. Defaults to Markup (preserves S-001: Markup +
   *  select → the 5-type popover). The ACTIVE tool routes the selection (the routing is in viewer-screen). */
  activeTool?: MarkupTool;
  /** S-006: choose a markup tool (the chip click). Absent → the tool group renders read-only (e.g. an
   *  early shell before the doc resolves); but normally the viewer wires this to its activeTool state. */
  onTool?: (tool: MarkupTool) => void;
}) {
  return (
    <div
      data-testid="doc-mode-toolbar"
      className="sticky top-0 z-[5] flex h-11 items-center gap-2.5 border-b border-line-soft bg-paper/85 px-5 backdrop-blur"
    >
      <Seg
        options={[
          { key: "select", label: "Select" },
          { key: "pinpoint", label: "Pinpoint" },
        ]}
        value="select"
        onChange={(k) => {
          // Pinpoint (whole-block element picker) is Phase 2 — never becomes the active mode; it
          // surfaces a "coming" note so the shell matches the prototype without dead UI.
          if (k === "pinpoint") onPinpointUnavailable();
        }}
      />

      {/* S-006/C-009: the markup tool palette. Exactly one tool active; the active tool routes the
          selection (Markup → popover, Comment → composer, Redline → strike, Label → picker). */}
      <div
        data-testid="markup-tool-group"
        role="group"
        aria-label="Markup tool"
        className="inline-flex items-center gap-0.5 rounded-md border border-line bg-sunken p-0.5"
      >
        {TOOL_ORDER.map((tool) => (
          <ToolChip
            key={tool}
            tool={tool}
            active={tool === activeTool}
            onSelect={() => onTool?.(tool)}
          />
        ))}
      </div>

      {/* Wide | Focus — pushed to the FAR RIGHT (ml-auto), the doc measure. */}
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
    </div>
  );
}
