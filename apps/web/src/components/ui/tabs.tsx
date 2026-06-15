import { Icon } from "@/components/icon";

// Minimal controlled tab bar (no radix dep — the codebase keeps deps lean). Renders the row of tab
// triggers; the parent conditionally renders the active panel. A disabled tab is shown but inert
// (e.g. "Link options" before the doc is shared by link). Underline-on-active, accent ink — chrome
// recedes per DESIGN.md.

export interface TabItem<T extends string = string> {
  id: T;
  label: string;
  icon?: string;
  disabled?: boolean;
}

export function TabBar<T extends string>({
  tabs,
  value,
  onChange,
  "aria-label": ariaLabel,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  "aria-label"?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex items-center gap-1 border-b border-line"
    >
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={t.disabled}
            data-testid={`share-tab-${t.id}`}
            data-active={active ? "1" : "0"}
            onClick={() => !t.disabled && onChange(t.id)}
            className={
              "inline-flex items-center gap-1.5 border-b-2 px-1 pb-2 text-[12.5px] font-medium transition-colors -mb-px disabled:cursor-not-allowed disabled:opacity-40 " +
              (active
                ? "border-accent text-accent-ink"
                : "border-transparent text-muted hover:text-ink")
            }
          >
            {t.icon && <Icon name={t.icon} size={13} />}
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
