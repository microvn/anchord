import { describe, it, expect, mock, beforeEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";

// sharing-permissions-ui S-002 — the access-controls mutation engine (lifted from AccessSection so
// the controls can span two tabs but share ONE PUT …/access). This unit-tests the mutation logic:
// AS-005 (level change fires the write), AS-006 (refused write rolls back + toast), AS-009 (editors
// owner-only + omitted for an editor). The guest-commenting toggle was REMOVED 2026-06-20 (a
// commenter+ link role IS the guest grant — no toggle), so the access write no longer carries
// guestCommenting.

import * as sharingClient from "@/features/sharing/services/client";

const setAccess = mock(async () => ({ data: OK, error: null as unknown }));
mock.module("@/features/sharing/services/client", () => ({ ...sharingClient, setAccess }));

const toastError = mock(() => {});
mock.module("sonner", () => ({ toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }) }));

const OK = { level: "anyone_with_link" as const, role: "commenter" as const, editorsCanShare: false };
const RESTRICTED = { level: "restricted" as const, role: "viewer" as const, editorsCanShare: false, people: [], link: { hasPassword: false, url: "x" } };

const { useAccessControls } = await import("@/features/sharing/hooks/use-access-controls");

beforeEach(() => {
  setAccess.mockClear();
  toastError.mockClear();
  setAccess.mockImplementation(async () => ({ data: OK, error: null }));
});

function setup(initial = RESTRICTED, role: "owner" | "editor" | undefined = "owner") {
  return renderHook(() => useAccessControls("ws", "doc", initial, role));
}

describe("useAccessControls", () => {
  it("AS-005: chooseLevel fires PUT /access with the new level", async () => {
    const { result } = setup();
    act(() => result.current.chooseLevel("anyone_with_link"));
    await waitFor(() => expect(setAccess).toHaveBeenCalledWith("ws", "doc", expect.objectContaining({ level: "anyone_with_link" })));
    expect(result.current.level).toBe("anyone_with_link");
  });

  it("AS-006: a refused write rolls back the level + shows an error toast", async () => {
    setAccess.mockImplementation(async () => ({ data: null, error: { status: 403 } }));
    const { result } = setup();
    act(() => result.current.chooseLevel("anyone_with_link"));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(result.current.level).toBe("restricted"); // reverted
  });

  it("reversal 2026-06-20: the access write never carries a guestCommenting field", async () => {
    const { result } = setup();
    act(() => result.current.chooseLevel("anyone_with_link"));
    await waitFor(() => expect(setAccess).toHaveBeenCalled());
    expect(setAccess.mock.calls[0]?.[2]).not.toHaveProperty("guestCommenting");
  });

  it("AS-009: editorsCanShare is owner-only — sent for owner, omitted for editor", async () => {
    const owner = setup(RESTRICTED, "owner");
    act(() => owner.result.current.toggleEditorsCanShare());
    await waitFor(() => expect(setAccess).toHaveBeenLastCalledWith("ws", "doc", expect.objectContaining({ editorsCanShare: true })));

    setAccess.mockClear();
    const editor = setup(RESTRICTED, "editor");
    // an editor can't toggle it (no-op)
    act(() => editor.result.current.toggleEditorsCanShare());
    expect(setAccess).not.toHaveBeenCalled();
    // and a different change as an editor never carries editorsCanShare
    act(() => editor.result.current.chooseLevel("anyone_with_link"));
    await waitFor(() => expect(setAccess).toHaveBeenCalled());
    expect(setAccess.mock.calls[0]?.[2]).not.toHaveProperty("editorsCanShare");
  });

  it("AS-009: owner-ness comes from the read's viewerRole when effectiveRole is absent (docs-list entry)", async () => {
    // The docs-list ⋯ entry preloads no effectiveRole — owner-ness must come from the share read's
    // `viewerRole`, else the owner can't toggle editors_can_share there.
    const fromRead = { ...RESTRICTED, viewerRole: "owner" as const };
    const { result } = setup(fromRead, undefined);
    act(() => result.current.toggleEditorsCanShare());
    await waitFor(() =>
      expect(setAccess).toHaveBeenLastCalledWith("ws", "doc", expect.objectContaining({ editorsCanShare: true })),
    );
  });

});
