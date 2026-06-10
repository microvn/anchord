import { Brandmark, Icon } from "@/components/icon";

// AuthAside — the right brand pane of the two-pane auth layout (Anchord-Design AuthAside).
// A gridded background (the ONE bespoke one-off: a CSS-grid line pattern with a radial mask
// that can't be expressed as a Tailwind utility), the Fraunces marketing headline with
// "self-hosted" in teal, a 3-item feature list with teal icon chips, and a mono footer.
// Collapses below ~820px (max-[820px]:hidden) so mobile shows the form alone.
const FEATURES: ReadonlyArray<readonly [string, string]> = [
  ["shield", "Self-hosted, single binary"],
  ["docs", "HTML · Markdown · images"],
  ["share", "Versioned, threaded annotations"],
];

export function AuthAside() {
  return (
    <aside className="relative hidden flex-col justify-center overflow-hidden border-l border-line bg-sunken p-14 min-[820px]:flex">
      {/* Bespoke one-off: the gridded backdrop. A line grid masked to a corner glow — not a
          Tailwind utility, so it lives as an inline background. The only allowed CSS pile. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage:
            "linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px)",
          backgroundSize: "30px 30px",
          maskImage: "radial-gradient(120% 90% at 80% 20%, #000 30%, transparent 75%)",
          WebkitMaskImage: "radial-gradient(120% 90% at 80% 20%, #000 30%, transparent 75%)",
        }}
      />
      <div className="relative">
        <div className="mb-[34px] flex items-center gap-2.5">
          <Brandmark size={24} />
          <span className="font-serif text-[19px] font-medium tracking-[-0.03em] text-ink">
            anchord
          </span>
        </div>

        <p className="max-w-[420px] font-serif text-[26px] font-medium leading-[1.3] tracking-[-0.015em] text-ink">
          Share and annotate AI-generated docs, <span className="text-accent">self-hosted</span> —
          the data stays in your hands.
        </p>

        <div className="mt-[30px] flex flex-col gap-[13px]">
          {FEATURES.map(([icon, label]) => (
            <div key={label} className="flex items-center gap-[11px] text-[12.5px] text-muted">
              <span className="grid size-7 flex-none place-items-center rounded-sm border border-line bg-surface text-accent">
                <Icon name={icon} size={15} />
              </span>
              {label}
            </div>
          ))}
        </div>

        <div className="mt-5 font-mono text-[11px] uppercase tracking-[0.1em] text-subtle">
          v1.0 · your server
        </div>
      </div>
    </aside>
  );
}
