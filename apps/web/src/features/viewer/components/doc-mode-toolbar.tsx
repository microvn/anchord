// DocModeToolbar (annotation-core-ui-types-modes S-001, UI Notes §Component Tree): the sticky
// toolbar at the top of the doc pane, mirroring Anchord-Design viewer.css `.doc-toolbar`. Two
// segmented controls:
//   • Select | Pinpoint — Select is the active read/selection mode owned HERE (Markup is now the
//     popover-on-a-selection, not a toolbar mode). Pinpoint (the whole-block element picker) is
//     deferred to Phase 2, so it surfaces a "coming" note instead of dead UI (kept visible so the
//     shell matches the prototype).
//   • Wide | Focus — the doc measure (Wide = full column width, Focus = 800px capped), driven via
//     `data-doc-width` on the docpane (widths live in styles.css .doc-prose).

type DocWidth = "wide" | "focus";

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
  onPinpointUnavailable,
}: {
  width: DocWidth;
  onWidth: (w: DocWidth) => void;
  /** Pinpoint mode is Phase 2 — surface a "coming" note instead of a no-op toggle. */
  onPinpointUnavailable: () => void;
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
      <Seg
        options={[
          { key: "wide", label: "Wide" },
          { key: "focus", label: "Focus" },
        ]}
        value={width}
        onChange={(k) => onWidth(k as DocWidth)}
      />
    </div>
  );
}
