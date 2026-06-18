import { useTheme, type Theme } from "@/app/theme-provider";

// account-settings S-003: the Appearance section body. A theme picker that reflects the active
// theme and lets the user pick light or dark; the choice applies immediately and persists on
// this device (via the shared ThemeProvider → localStorage). The provider is the single source
// of truth, so this picker and the header theme toggle always agree (C-005).
//
// Canonical shape: Anchord-Design/settings.jsx `AppearanceSection` (the theme-grid of swatch
// buttons). The prototype shows THREE options (Light / Dark / System); System is OUT of v0
// scope (deferred), so this slice ships only Light and Dark.

const OPTIONS: { id: Theme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

// A small theme preview — a tinted side with a few bars, mirroring the prototype swatch.
function Swatch({ id }: { id: Theme }) {
  const dark = id === "dark";
  const bg = dark ? "#0c1012" : "#fbfbfa";
  const bar = dark ? "#2b343a" : "#d7dbdb";
  const accent = dark ? "#37b3bd" : "#0b6b73";
  return (
    <div className="flex h-16 items-stretch" aria-hidden="true">
      <div className="flex flex-1 flex-col gap-[5px] p-[9px]" style={{ background: bg }}>
        <span className="h-[5px] w-4/5 rounded-[3px]" style={{ background: bar }} />
        <span className="h-[5px] w-[55%] rounded-[3px]" style={{ background: accent }} />
        <span className="h-[5px] w-[55%] rounded-[3px]" style={{ background: bar }} />
      </div>
    </div>
  );
}

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex flex-col gap-5">
      <div className="rounded-[12px] border border-line bg-elev">
        <div className="p-5">
          <div className="mb-3 text-[12.5px] font-medium text-ink">Theme</div>
          <div className="grid grid-cols-2 gap-3" role="radiogroup" aria-label="Theme">
            {OPTIONS.map((o) => {
              const active = theme === o.id;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`theme-opt-${o.id}`}
                  onClick={() => setTheme(o.id)}
                  className={`overflow-hidden rounded-[10px] border bg-surface text-left transition-colors ${
                    active ? "border-accent shadow-[0_0_0_3px_var(--accent-soft)]" : "border-line hover:border-subtle"
                  }`}
                >
                  <Swatch id={o.id} />
                  <div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
                    <span className="text-[12.5px] font-semibold text-ink">{o.label}</span>
                    <span
                      className={`ml-auto grid size-[15px] place-items-center rounded-full border-[1.5px] ${
                        active ? "border-accent" : "border-faint"
                      }`}
                    >
                      {active && <span className="size-2 rounded-full bg-accent" />}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
          <div className="mt-3.5 text-[11.5px] text-subtle">
            Applies across anchord&rsquo;s chrome. Also toggleable from the header.
          </div>
        </div>
      </div>
    </div>
  );
}
