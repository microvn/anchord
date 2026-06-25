import { Icon } from "@/components/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AccessControls } from "@/features/sharing/hooks/use-access-controls";
import type { AxisRole, ShareRole } from "@/features/sharing/services/client";

// AccessSection (doc-access-two-axis S-007) — the "Who can read?" zone of the Sharing tab. The
// access model is TWO INDEPENDENT axes (C-001), so this renders TWO self-contained controls:
//   • Workspace access — the role every workspace member gets, or Off.
//   • Link access      — the role anyone holding the link gets, or Off.
// Each control is {Off, Viewer, Commenter, Editor}; each reads + writes ONLY its own axis (AS-023),
// so setting one lower than the other persists both independently (AS-024 / C-001). Presentational:
// all state + the per-axis PUT …/access live in `useAccessControls`; this component only reads
// `controls` and calls `chooseWorkspaceRole` / `chooseLinkRole`. Owner is NEVER an option (C-004/C-009).

// The OFF sentinel for a Select — Radix Select can't carry a real `null` value, so off is a string
// the chooser maps back to `null`. (`""` is rejected by Radix; use a non-empty token.)
const OFF = "off";

type AxisOption = { value: string; label: string };
const AXIS_OPTIONS: AxisOption[] = [
  { value: OFF, label: "Off" },
  { value: "viewer", label: "Viewer" },
  { value: "commenter", label: "Commenter" },
  { value: "editor", label: "Editor" },
];

const toValue = (role: AxisRole): string => role ?? OFF;
const fromValue = (v: string): AxisRole => (v === OFF ? null : (v as ShareRole));

function AxisControl({
  axis,
  icon,
  title,
  desc,
  role,
  saving,
  onChoose,
}: {
  axis: "workspace" | "link";
  icon: string;
  title: string;
  desc: string;
  role: AxisRole;
  saving: boolean;
  onChoose: (next: AxisRole) => void;
}) {
  const on = role != null;
  return (
    <div
      data-testid={`share-axis-${axis}`}
      data-on={on ? "1" : "0"}
      className={
        "flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors " +
        (on ? "border-accent bg-accent-soft" : "border-line")
      }
    >
      <span
        className={
          "grid size-8 flex-none place-items-center rounded-md " +
          (on ? "bg-surface text-accent-ink" : "bg-sunken text-subtle")
        }
      >
        <Icon name={icon} size={15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-ink">{title}</span>
        <span
          data-testid={`share-axis-desc-${axis}`}
          className="block text-[11.5px] text-subtle"
        >
          {desc}
        </span>
      </span>
      <Select
        value={toValue(role)}
        onValueChange={(v) => onChoose(fromValue(v))}
        disabled={saving}
      >
        <SelectTrigger
          data-testid={`share-axis-${axis}-trigger`}
          className="h-8 w-[130px] flex-none"
          aria-label={`${title} role`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent data-testid={`share-axis-${axis}-options`}>
          {AXIS_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value} data-testid={`share-axis-${axis}-opt-${o.value}`}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function AccessSection({ controls }: { controls: AccessControls }) {
  const { workspaceRole, linkRole, saving, chooseWorkspaceRole, chooseLinkRole, editorsCanShare } =
    controls;
  // Footgun guard: a link shared at the EDITOR role hands sharing control to whoever opens the link
  // (an editor may manage sharing while editors_can_share is on — the default). Surface it so the
  // choice is deliberate. Keyed on the LINK axis (C-001) — independent of the workspace axis.
  const editorLinkWarning = linkRole === "editor" && editorsCanShare;

  return (
    <section data-testid="share-sec-access" className="flex flex-col gap-3">
      <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-subtle">· Who can read?</span>

      <div className="flex flex-col gap-1.5">
        <AxisControl
          axis="workspace"
          icon="members"
          title="Workspace access"
          desc="The role every member of this workspace gets."
          role={workspaceRole}
          saving={saving}
          onChoose={chooseWorkspaceRole}
        />
        <AxisControl
          axis="link"
          icon="link"
          title="Link access"
          desc="The role anyone with the link gets — no sign-in needed."
          role={linkRole}
          saving={saving}
          onChoose={chooseLinkRole}
        />
      </div>

      {editorLinkWarning ? (
        <p
          data-testid="share-access-editor-warning"
          className="flex items-start gap-1.5 text-[11.5px] text-subtle"
        >
          <Icon name="alert" size={13} />
          <span>
            Editors can change sharing — anyone who opens this link can manage who has access. Turn it
            off under Options, or grant Commenter instead.
          </span>
        </p>
      ) : null}
    </section>
  );
}
