import { useState } from "react";
import { toast } from "sonner";
import {
  setAccess,
  type AccessResult,
  type AxisRole,
  type GeneralAccessLevel,
  type ShareState,
} from "@/features/sharing/services/client";
import type { EffectiveRole } from "@/features/viewer/services/client";
import { unwrapEnvelope } from "@/features/workspaces/hooks/use-bootstrap";

// useAccessControls (doc-access-two-axis S-007) — the shared access state + mutation engine for the
// ShareDialog. The access model is now TWO INDEPENDENT axes (C-001): a workspace axis (the role
// every workspace member gets) and a link axis (the role anyone holding the link gets). Each axis is
// a share role or `null` (off). The hook holds both and exposes a per-axis chooser; the derived
// legacy `level` is still surfaced for displays that consume the 3-value summary.
//
// Each axis is written with a COLUMN-SCOPED PUT (C-011): `chooseWorkspaceRole` sends ONLY
// `{ workspaceRole }`, `chooseLinkRole` sends ONLY `{ linkRole }`. Setting one never touches the
// other in the UI or the request (C-001 / AS-024) — so two managers editing different axes never
// clobber each other, and setting the link role lower than the workspace role persists both.
//
// Every mutation is OPTIMISTIC with ROLLBACK (C-005): the value flips immediately, PUT …/access
// fires, and a refused/failed write reverts to the captured prior snapshot + an error toast. No
// partial state survives a refusal. `editors_can_share` is owner-only (C-003) — never sent for a
// non-owner.

/** Derive the legacy 3-value summary from the two axes — mirrors the backend `deriveLevel`
 *  ({null,null}=restricted, {set,null}=anyone_in_workspace, {*,set}=anyone_with_link). */
function deriveLevel(workspaceRole: AxisRole, linkRole: AxisRole): GeneralAccessLevel {
  if (linkRole != null) return "anyone_with_link";
  if (workspaceRole != null) return "anyone_in_workspace";
  return "restricted";
}

export interface AccessControls {
  /** The two raw axes — each control in AccessSection reads + sets its own. */
  workspaceRole: AxisRole;
  linkRole: AxisRole;
  /** The derived 3-value summary (kept for the editor-link warning + any summary display). */
  level: GeneralAccessLevel;
  editorsCanShare: boolean;
  saving: boolean;
  /** Is the doc shared by link (linkRole set)? Drives the inline link-protection section. */
  isLink: boolean;
  isOwner: boolean;
  /** the live external capability link (`/s/<token>`) — the SINGLE authoritative source the dialog
   *  renders. Seeded from the dialog-open read (`initial.capabilityUrl`) and refreshed from every
   *  successful PUT …/access response so turning the link axis on/off IN-SESSION surfaces / clears
   *  the link without a re-open. */
  capabilityUrl: string | null;
  /** Set the workspace axis (a role or null=off). Sends ONLY the workspace axis (C-011). */
  chooseWorkspaceRole: (next: AxisRole) => void;
  /** Set the link axis (a role or null=off). Sends ONLY the link axis (C-011). */
  chooseLinkRole: (next: AxisRole) => void;
  toggleEditorsCanShare: () => void;
}

export function useAccessControls(
  workspaceId: string,
  slug: string,
  initial: ShareState,
  effectiveRole: EffectiveRole | undefined,
): AccessControls {
  const [workspaceRole, setWorkspaceRole] = useState<AxisRole>(initial.workspaceRole ?? null);
  const [linkRole, setLinkRole] = useState<AxisRole>(initial.linkRole ?? null);
  const [editorsCanShare, setEditorsCanShare] = useState(initial.editorsCanShare);
  // The live capability link. Seeded from the dialog-open read, then overwritten by each PUT
  // …/access response — the single authoritative source for the dialog.
  const [capabilityUrl, setCapabilityUrl] = useState<string | null>(initial.capabilityUrl ?? null);
  const [saving, setSaving] = useState(false);

  const isLink = linkRole != null;
  const level = deriveLevel(workspaceRole, linkRole);
  // C-003 owner-only gate. Prefer the caller's role from the share read (`viewerRole`) — present
  // regardless of entry point — falling back to the passed `effectiveRole` (the viewer supplies it;
  // the docs-list ⋯ does not).
  const isOwner = (initial.viewerRole ?? effectiveRole) === "owner";

  // The rollback snapshot carries BOTH axes + editorsCanShare + capabilityUrl, so a refused write
  // restores the exact prior state (C-005) — never a half-applied axis.
  type Snapshot = {
    workspaceRole: AxisRole;
    linkRole: AxisRole;
    editorsCanShare: boolean;
    capabilityUrl: string | null;
  };

  function rollback(prev: Snapshot) {
    setWorkspaceRole(prev.workspaceRole);
    setLinkRole(prev.linkRole);
    setEditorsCanShare(prev.editorsCanShare);
    setCapabilityUrl(prev.capabilityUrl);
    toast.error("Couldn't update access");
  }

  /**
   * Persist a per-axis change. `patch` carries ONLY the field(s) that changed — the PUT body is
   * built from it, so an untouched axis is NEVER sent (C-001/C-011): setting the link axis cannot
   * revert the workspace axis (or vice versa). `next` is the resulting local state to flip to.
   */
  async function persist(
    next: { workspaceRole: AxisRole; linkRole: AxisRole; editorsCanShare: boolean },
    patch: { workspaceRole?: AxisRole; linkRole?: AxisRole; editorsCanShare?: boolean },
  ) {
    const prev: Snapshot = { workspaceRole, linkRole, editorsCanShare, capabilityUrl };
    setWorkspaceRole(next.workspaceRole);
    setLinkRole(next.linkRole);
    setEditorsCanShare(next.editorsCanShare);
    setSaving(true);
    try {
      const res = unwrapEnvelope<AccessResult>(await setAccess(workspaceId, slug, patch));
      if (res.error || !res.data) {
        rollback(prev);
      } else {
        // The authoritative capability link AFTER the write — set from the response so a refused
        // write rolls both axes AND capabilityUrl back.
        setCapabilityUrl(res.data.capabilityUrl ?? null);
      }
    } catch {
      rollback(prev);
    } finally {
      setSaving(false);
    }
  }

  return {
    workspaceRole,
    linkRole,
    level,
    editorsCanShare,
    saving,
    isLink,
    isOwner,
    capabilityUrl,
    chooseWorkspaceRole: (next) => {
      if (next === workspaceRole) return;
      // C-001/C-011: send ONLY the workspace axis — the link axis is untouched in the request.
      void persist({ workspaceRole: next, linkRole, editorsCanShare }, { workspaceRole: next });
    },
    chooseLinkRole: (next) => {
      if (next === linkRole) return;
      // C-001/C-011: send ONLY the link axis — the workspace axis is untouched in the request.
      void persist({ workspaceRole, linkRole: next, editorsCanShare }, { linkRole: next });
    },
    toggleEditorsCanShare: () => {
      if (!isOwner) return; // C-003
      void persist(
        { workspaceRole, linkRole, editorsCanShare: !editorsCanShare },
        { editorsCanShare: !editorsCanShare },
      );
    },
  };
}
