import { Icon } from "@/components/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AccessControls } from "@/features/sharing/hooks/use-access-controls";
import type { GeneralAccessLevel, ShareRole } from "@/features/sharing/services/client";

// AccessSection (sharing-permissions-ui S-002) — the "Who can read?" zone of the Sharing tab.
// Presentational: it renders the three general-access levels as self-DESCRIBING radio rows (icon +
// title + one-line consequence) so the choice needs no separate hint to read (Krug: don't make me
// think), plus a role Select (viewer | commenter | editor — owner is NEVER an option, C-004). All
// state + the optimistic PUT …/access live in `useAccessControls` (lifted, shared with the Options
// tab); this component only reads `controls` and calls its `chooseLevel` / `chooseRole`.

const ROWS: { id: GeneralAccessLevel; icon: string; title: string; desc: string }[] = [
  { id: "restricted", icon: "shield", title: "Restricted", desc: "Only people you invite below can open this doc." },
  { id: "anyone_in_workspace", icon: "members", title: "Anyone in workspace", desc: "Every member of this workspace can open it." },
  { id: "anyone_with_link", icon: "link", title: "Anyone with the link", desc: "No sign-in needed — anyone with the URL can open it." },
];

const ROLE_OPTS: ShareRole[] = ["viewer", "commenter", "editor"];
const roleLabel = (r: string) => r.charAt(0).toUpperCase() + r.slice(1);

export function AccessSection({ controls }: { controls: AccessControls }) {
  const { level, role, saving, chooseLevel, chooseRole } = controls;

  return (
    <section data-testid="share-sec-access" className="flex flex-col gap-3">
      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-subtle">· Who can read?</span>

      <div
        role="radiogroup"
        aria-label="General access"
        data-testid="share-access-seg"
        className="flex flex-col gap-1.5"
      >
        {ROWS.map((r) => {
          const active = r.id === level;
          return (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={active}
              data-testid={`share-access-opt-${r.id}`}
              data-active={active ? "1" : "0"}
              disabled={saving}
              onClick={() => chooseLevel(r.id)}
              className={
                "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-60 " +
                (active ? "border-accent bg-accent-soft" : "border-line hover:border-accent")
              }
            >
              <span
                className={
                  "grid size-8 flex-none place-items-center rounded-md " +
                  (active ? "bg-surface text-accent-ink" : "bg-sunken text-subtle")
                }
              >
                <Icon name={r.icon} size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink">{r.title}</span>
                <span data-testid={`share-access-desc-${r.id}`} className="block text-[11.5px] text-subtle">
                  {r.desc}
                </span>
              </span>
              <span
                aria-hidden="true"
                className={
                  "grid size-[18px] flex-none place-items-center rounded-full border-2 " +
                  (active ? "border-accent bg-accent text-on-accent" : "border-line")
                }
              >
                {active && <Icon name="check" size={11} />}
              </span>
            </button>
          );
        })}
      </div>

      {/* Role granted for the chosen access level (never owner, C-004). */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-muted">Role granted</span>
        <Select value={role} onValueChange={(v) => chooseRole(v as ShareRole)} disabled={saving}>
          <SelectTrigger data-testid="share-access-role-trigger" className="h-8 w-[140px]" aria-label="Access role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent data-testid="share-access-role-options">
            {ROLE_OPTS.map((r) => (
              <SelectItem key={r} value={r} data-testid={`share-access-role-opt-${r}`}>
                {roleLabel(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}
