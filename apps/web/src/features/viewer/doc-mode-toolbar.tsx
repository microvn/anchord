// DocModeToolbar (annotation-core-ui S-001, UI Notes §Component Tree): the sticky toolbar at the
// top of the doc pane, mirroring Anchord-Design viewer.css `.doc-toolbar`. Two segmented controls:
//   • Select | Markup — Select is the read/selection mode owned HERE; Markup (compose-on-the-doc)
//     belongs to the commenting spec and is not built yet, so it surfaces a "later" toast instead
//     of dead UI (kept visible so the shell matches the prototype).
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
  onMarkupUnavailable,
}: {
  width: DocWidth;
  onWidth: (w: DocWidth) => void;
  /** Markup mode is the commenting spec — surface a note instead of a no-op toggle. */
  onMarkupUnavailable: () => void;
}) {
  return (
    <div
      data-testid="doc-mode-toolbar"
      className="sticky top-0 z-[5] flex h-11 items-center gap-2.5 border-b border-line-soft bg-paper/85 px-5 backdrop-blur"
    >
      <Seg
        options={[
          { key: "select", label: "Select" },
          { key: "markup", label: "Markup" },
        ]}
        value="select"
        onChange={(k) => {
          if (k === "markup") onMarkupUnavailable();
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
