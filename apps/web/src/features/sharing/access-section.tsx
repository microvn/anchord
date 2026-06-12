import { useState } from "react";
import { toast } from "sonner";
import { Icon } from "../../components/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  setAccess,
  type GeneralAccessLevel,
  type ShareRole,
  type ShareState,
} from "./client";
import type { EffectiveRole } from "../viewer/client";

// AccessSection (sharing-permissions-ui S-002) — the General-access section of the ShareDialog.
// It owns the editable general-access controls the S-001 shell left as read-only prefill:
//   - a segmented control (Restricted · Anyone in workspace · Anyone with link) — `.ga-seg`
//   - a role Select (viewer | commenter | editor only — owner is NEVER an option, C-004)
//   - a guest-commenting toggle (`.switch`), ENABLED only for anyone-with-link (C-001)
//   - an editors_can_share toggle, EDITABLE by the OWNER only (C-003), read-only/absent otherwise
//   - the per-level access hint (`.access-hint`)
//
// Every mutation persists via PUT …/access and is OPTIMISTIC: the control flips immediately, and on
// a refused/failed write it ROLLS BACK to the prior value + shows an error toast (C-005, mirroring
// the viewer's use-compose optimistic-then-revert). The selected `level` is lifted to the parent via
// `onLevelChange` so the Link section can appear/disappear (C-007) with the optimistic state.

const ACCESS_OPTS: { id: GeneralAccessLevel; label: string }[] = [
  { id: "restricted", label: "Restricted" },
  { id: "anyone_in_workspace", label: "Anyone in workspace" },
  { id: "anyone_with_link", label: "Anyone with link" },
];

const ROLE_OPTS: ShareRole[] = ["viewer", "commenter", "editor"];

const ACCESS_HINT: Record<GeneralAccessLevel, string> = {
  restricted: "Only people invited below can open this doc.",
  anyone_in_workspace: "Everyone in this workspace can open this doc.",
  anyone_with_link: "Anyone with the link can open this doc — no sign-in needed.",
};

const ACCESS_ICON: Record<GeneralAccessLevel, "shield" | "members" | "link"> = {
  restricted: "shield",
  anyone_in_workspace: "members",
  anyone_with_link: "link",
};

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function AccessSection({
  workspaceId,
  slug,
  initial,
  effectiveRole,
  onLevelChange,
}: {
  workspaceId: string;
  slug: string;
  /** the prefill state read on dialog open (S-001 / AS-018) — seeds the optimistic local state. */
  initial: ShareState;
  /** the session's own role — only the OWNER can edit editors_can_share (C-003). */
  effectiveRole: EffectiveRole | undefined;
  /** lift the selected level so the parent can show/hide the Link section (C-007). */
  onLevelChange?: (level: GeneralAccessLevel) => void;
}) {
  const [level, setLevel] = useState<GeneralAccessLevel>(initial.level);
  const [role, setRole] = useState<ShareRole>(initial.role);
  const [guestCommenting, setGuestCommenting] = useState(initial.guestCommenting);
  const [editorsCanShare, setEditorsCanShare] = useState(initial.editorsCanShare);
  const [saving, setSaving] = useState(false);

  const isLink = level === "anyone_with_link";
  const isOwner = effectiveRole === "owner"; // C-003

  // One optimistic-with-rollback writer for every access mutation (C-005). It applies the next
  // values locally, fires PUT …/access, and on a refused/failed write reverts to the captured prior
  // snapshot + shows an error toast. No partial state survives a refusal.
  async function persist(next: {
    level: GeneralAccessLevel;
    role: ShareRole;
    guestCommenting: boolean;
    editorsCanShare: boolean;
  }) {
    const prev = { level, role, guestCommenting, editorsCanShare };

    // optimistic apply
    setLevel(next.level);
    setRole(next.role);
    setGuestCommenting(next.guestCommenting);
    setEditorsCanShare(next.editorsCanShare);
    onLevelChange?.(next.level);
    setSaving(true);

    try {
      const res = await setAccess(workspaceId, slug, {
        level: next.level,
        role: next.role,
        guestCommenting: next.guestCommenting,
        // editors_can_share is owner-only — never send it for a non-owner (C-003).
        ...(isOwner ? { editorsCanShare: next.editorsCanShare } : {}),
      });
      if (res.error || !res.data) {
        rollback(prev);
        return;
      }
    } catch {
      rollback(prev);
    } finally {
      setSaving(false);
    }
  }

  function rollback(prev: {
    level: GeneralAccessLevel;
    role: ShareRole;
    guestCommenting: boolean;
    editorsCanShare: boolean;
  }) {
    setLevel(prev.level);
    setRole(prev.role);
    setGuestCommenting(prev.guestCommenting);
    setEditorsCanShare(prev.editorsCanShare);
    onLevelChange?.(prev.level);
    toast.error("Couldn't update access");
  }

  function chooseLevel(nextLevel: GeneralAccessLevel) {
    if (nextLevel === level) return;
    // Leaving anyone-with-link forces guest commenting off (it's only meaningful for link, C-001).
    const nextGuest = nextLevel === "anyone_with_link" ? guestCommenting : false;
    void persist({ level: nextLevel, role, guestCommenting: nextGuest, editorsCanShare });
  }

  function chooseRole(nextRole: ShareRole) {
    if (nextRole === role) return;
    void persist({ level, role: nextRole, guestCommenting, editorsCanShare });
  }

  function toggleGuest() {
    if (!isLink) return; // C-001: gated to anyone-with-link
    void persist({ level, role, guestCommenting: !guestCommenting, editorsCanShare });
  }

  function toggleEditorsCanShare() {
    if (!isOwner) return; // C-003: owner-only
    void persist({ level, role, guestCommenting, editorsCanShare: !editorsCanShare });
  }

  return (
    <>
      {/* General access — segmented control + role select + per-level hint */}
      <section data-testid="share-sec-access" className="flex flex-col gap-2">
        <span className="text-[12px] font-medium text-muted">General access</span>
        <div className="flex items-center gap-2">
          <div
            data-testid="share-access-seg"
            role="radiogroup"
            aria-label="General access"
            className="flex flex-1 gap-0.5 rounded-md border border-line bg-sunken p-0.5"
          >
            {ACCESS_OPTS.map((o) => {
              const active = o.id === level;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  data-testid={`share-access-opt-${o.id}`}
                  data-active={active ? "1" : "0"}
                  disabled={saving}
                  onClick={() => chooseLevel(o.id)}
                  className={
                    "h-[30px] flex-1 whitespace-nowrap rounded-[6px] px-2 text-[12px] font-medium transition-colors " +
                    (active
                      ? "bg-surface font-semibold text-accent-ink shadow-sm"
                      : "text-muted hover:text-ink")
                  }
                >
                  {o.label}
                </button>
              );
            })}
          </div>
          <Select value={role} onValueChange={(v) => chooseRole(v as ShareRole)} disabled={saving}>
            <SelectTrigger data-testid="share-access-role-trigger" className="h-8" aria-label="Access role">
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
        <p data-testid="share-access-hint" className="flex items-center gap-1.5 text-[11.5px] text-subtle">
          <Icon name={ACCESS_ICON[level]} size={13} />
          {ACCESS_HINT[level]}
        </p>
      </section>

      {/* Guest commenting — ENABLED only for anyone-with-link (C-001) */}
      <section data-testid="share-sec-guest" className="flex items-center gap-2.5">
        <div className="min-w-0">
          <div className="text-[13px] text-ink">Allow guest commenting</div>
          <div className="text-[11.5px] text-subtle">
            {isLink
              ? "Link visitors can comment without an account."
              : "Available only for Anyone with link."}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={guestCommenting}
          aria-label="Allow guest commenting"
          data-testid="share-guest-toggle"
          data-on={guestCommenting ? "1" : "0"}
          disabled={!isLink || saving}
          onClick={toggleGuest}
          className={
            "relative ml-auto h-[19px] w-[34px] flex-none rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
            (guestCommenting ? "bg-accent" : "bg-faint")
          }
        >
          <span
            aria-hidden="true"
            className={
              "absolute top-0.5 left-0.5 h-[15px] w-[15px] rounded-full bg-white shadow-sm transition-transform " +
              (guestCommenting ? "translate-x-[15px]" : "")
            }
          />
        </button>
      </section>

      {/* editors_can_share — EDITABLE by the owner only (C-003); read-only for an editor */}
      <section data-testid="share-sec-editors-can-share" className="flex items-center gap-2.5">
        <div className="min-w-0">
          <div className="text-[13px] text-ink">Editors can change sharing</div>
          <div className="text-[11.5px] text-subtle">
            {isOwner
              ? "Let editors manage who can access this doc."
              : "Only the owner can change this."}
          </div>
        </div>
        {isOwner ? (
          <button
            type="button"
            role="switch"
            aria-checked={editorsCanShare}
            aria-label="Editors can change sharing"
            data-testid="share-editors-can-share-toggle"
            data-on={editorsCanShare ? "1" : "0"}
            disabled={saving}
            onClick={toggleEditorsCanShare}
            className={
              "relative ml-auto h-[19px] w-[34px] flex-none rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
              (editorsCanShare ? "bg-accent" : "bg-faint")
            }
          >
            <span
              aria-hidden="true"
              className={
                "absolute top-0.5 left-0.5 h-[15px] w-[15px] rounded-full bg-white shadow-sm transition-transform " +
                (editorsCanShare ? "translate-x-[15px]" : "")
              }
            />
          </button>
        ) : (
          <span
            data-testid="share-editors-can-share-readonly"
            data-on={editorsCanShare ? "1" : "0"}
            className="ml-auto flex-none rounded-md border border-line px-2 py-0.5 text-[11px] font-medium text-muted"
          >
            {editorsCanShare ? "On" : "Off"}
          </span>
        )}
      </section>
    </>
  );
}
