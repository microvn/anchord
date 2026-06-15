import { useState } from "react";
import { toast } from "sonner";
import {
  setAccess,
  type GeneralAccessLevel,
  type ShareRole,
  type ShareState,
} from "@/features/sharing/services/client";
import type { EffectiveRole } from "@/features/viewer/services/client";

// useAccessControls (sharing-permissions-ui S-002) — the shared access state + mutation engine for
// the ShareDialog. Lifted out of AccessSection so the controls can live in DIFFERENT tabs (the
// general-access radio rows on the "Sharing" tab; guest-commenting + editors-can-share on the "Link
// options" tab) while still sharing ONE `PUT …/access` writer — because guest/editors are sent
// together with level/role in the same request.
//
// Every mutation is OPTIMISTIC with ROLLBACK (C-005): the value flips immediately, PUT …/access
// fires, and a refused/failed write reverts to the captured prior snapshot + an error toast. No
// partial state survives a refusal. `editors_can_share` is owner-only (C-003) — never sent for a
// non-owner. Leaving anyone-with-link forces guest commenting off (only meaningful for link, C-001).

export interface AccessControls {
  level: GeneralAccessLevel;
  role: ShareRole;
  guestCommenting: boolean;
  editorsCanShare: boolean;
  saving: boolean;
  isLink: boolean;
  isOwner: boolean;
  chooseLevel: (next: GeneralAccessLevel) => void;
  chooseRole: (next: ShareRole) => void;
  toggleGuest: () => void;
  toggleEditorsCanShare: () => void;
}

export function useAccessControls(
  workspaceId: string,
  slug: string,
  initial: ShareState,
  effectiveRole: EffectiveRole | undefined,
): AccessControls {
  const [level, setLevel] = useState<GeneralAccessLevel>(initial.level);
  const [role, setRole] = useState<ShareRole>(initial.role);
  const [guestCommenting, setGuestCommenting] = useState(initial.guestCommenting);
  const [editorsCanShare, setEditorsCanShare] = useState(initial.editorsCanShare);
  const [saving, setSaving] = useState(false);

  const isLink = level === "anyone_with_link";
  // C-003 owner-only gate. Prefer the caller's role from the share read (`viewerRole`) — it's
  // present regardless of entry point — and fall back to the passed `effectiveRole` (the viewer
  // supplies it; the docs-list ⋯ does not). Without the read fallback the owner saw editors-can-share
  // as read-only when opening Share from the docs list (AS-009 gap).
  const isOwner = (initial.viewerRole ?? effectiveRole) === "owner";

  type Snapshot = {
    level: GeneralAccessLevel;
    role: ShareRole;
    guestCommenting: boolean;
    editorsCanShare: boolean;
  };

  function rollback(prev: Snapshot) {
    setLevel(prev.level);
    setRole(prev.role);
    setGuestCommenting(prev.guestCommenting);
    setEditorsCanShare(prev.editorsCanShare);
    toast.error("Couldn't update access");
  }

  async function persist(next: Snapshot) {
    const prev = { level, role, guestCommenting, editorsCanShare };
    setLevel(next.level);
    setRole(next.role);
    setGuestCommenting(next.guestCommenting);
    setEditorsCanShare(next.editorsCanShare);
    setSaving(true);
    try {
      const res = await setAccess(workspaceId, slug, {
        level: next.level,
        role: next.role,
        guestCommenting: next.guestCommenting,
        // editors_can_share is owner-only — never send it for a non-owner (C-003).
        ...(isOwner ? { editorsCanShare: next.editorsCanShare } : {}),
      });
      if (res.error || !res.data) rollback(prev);
    } catch {
      rollback(prev);
    } finally {
      setSaving(false);
    }
  }

  return {
    level,
    role,
    guestCommenting,
    editorsCanShare,
    saving,
    isLink,
    isOwner,
    chooseLevel: (next) => {
      if (next === level) return;
      // Leaving anyone-with-link forces guest off (only meaningful for link, C-001).
      const nextGuest = next === "anyone_with_link" ? guestCommenting : false;
      void persist({ level: next, role, guestCommenting: nextGuest, editorsCanShare });
    },
    chooseRole: (next) => {
      if (next === role) return;
      void persist({ level, role: next, guestCommenting, editorsCanShare });
    },
    toggleGuest: () => {
      if (!isLink) return; // C-001
      void persist({ level, role, guestCommenting: !guestCommenting, editorsCanShare });
    },
    toggleEditorsCanShare: () => {
      if (!isOwner) return; // C-003
      void persist({ level, role, guestCommenting, editorsCanShare: !editorsCanShare });
    },
  };
}
