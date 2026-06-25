import { describe, it, expect, mock, beforeEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";

// doc-access-two-axis S-007 — the access-controls mutation engine, now TWO INDEPENDENT axes (C-001).
// This unit-tests the mutation logic: a workspace-axis change sends ONLY { workspaceRole }, a link-
// axis change sends ONLY { linkRole } (C-011 — so one axis never reverts the other), a refused write
// rolls the changed axis back + toasts (C-005), and editorsCanShare stays owner-only (C-003). The
// access write carries no guestCommenting / no level (removed with the single-level model).

import * as sharingClient from "@/features/sharing/services/client";

const setAccess = mock(async () => ({ data: OK, error: null as unknown }));
mock.module("@/features/sharing/services/client", () => ({ ...sharingClient, setAccess }));

const toastError = mock(() => {});
mock.module("sonner", () => ({ toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }) }));

const OK = { workspaceRole: null, linkRole: "commenter" as const, level: "anyone_with_link" as const, editorsCanShare: false };
// A doc shared with the workspace at commenter, no public link (the new-doc default).
const WORKSPACE = {
  workspaceRole: "commenter" as const,
  linkRole: null,
  level: "anyone_in_workspace" as const,
  role: "viewer" as const,
  editorsCanShare: false,
  people: [],
  link: { hasPassword: false, url: "x" },
};
const RESTRICTED = {
  workspaceRole: null,
  linkRole: null,
  level: "restricted" as const,
  role: "viewer" as const,
  editorsCanShare: false,
  people: [],
  link: { hasPassword: false, url: "x" },
};

const { useAccessControls } = await import("@/features/sharing/hooks/use-access-controls");

beforeEach(() => {
  setAccess.mockClear();
  toastError.mockClear();
  setAccess.mockImplementation(async () => ({ data: OK, error: null }));
});

function setup(initial = RESTRICTED, role: "owner" | "editor" | undefined = "owner") {
  return renderHook(() => useAccessControls("ws", "doc", initial, role));
}

describe("useAccessControls — two independent axes (S-007)", () => {
  it("AS-024: chooseLinkRole fires PUT /access with ONLY the link axis — the workspace axis is not sent (C-001/C-011)", async () => {
    // Workspace is already commenter; turning the link axis on must not touch the workspace axis.
    const { result } = setup(WORKSPACE);
    act(() => result.current.chooseLinkRole("viewer"));
    await waitFor(() => expect(setAccess).toHaveBeenCalled());
    const body = setAccess.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(body).toHaveProperty("linkRole", "viewer");
    expect(body).not.toHaveProperty("workspaceRole");
    // Local state reflects BOTH independently — workspace stays commenter, link becomes viewer.
    expect(result.current.workspaceRole).toBe("commenter");
    expect(result.current.linkRole).toBe("viewer");
  });

  it("chooseWorkspaceRole fires PUT /access with ONLY the workspace axis (C-001/C-011)", async () => {
    const { result } = setup(RESTRICTED);
    act(() => result.current.chooseWorkspaceRole("editor"));
    await waitFor(() => expect(setAccess).toHaveBeenCalled());
    const body = setAccess.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(body).toHaveProperty("workspaceRole", "editor");
    expect(body).not.toHaveProperty("linkRole");
    expect(result.current.workspaceRole).toBe("editor");
    expect(result.current.linkRole).toBeNull();
  });

  it("a chooser can turn an axis OFF (null) — and only that axis is sent", async () => {
    const { result } = setup(WORKSPACE);
    act(() => result.current.chooseWorkspaceRole(null));
    await waitFor(() => expect(setAccess).toHaveBeenCalled());
    const body = setAccess.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(body).toHaveProperty("workspaceRole", null);
    expect(body).not.toHaveProperty("linkRole");
    expect(result.current.workspaceRole).toBeNull();
  });

  it("a refused write rolls back the changed axis + shows an error toast (C-005)", async () => {
    setAccess.mockImplementation(async () => ({ data: null, error: { status: 403 } }));
    const { result } = setup(WORKSPACE);
    act(() => result.current.chooseLinkRole("editor"));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // Both axes revert to the prior snapshot — workspace commenter, link still off.
    expect(result.current.workspaceRole).toBe("commenter");
    expect(result.current.linkRole).toBeNull();
  });

  it("the access write never carries a guestCommenting or level field", async () => {
    const { result } = setup(RESTRICTED);
    act(() => result.current.chooseLinkRole("commenter"));
    await waitFor(() => expect(setAccess).toHaveBeenCalled());
    const body = setAccess.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(body).not.toHaveProperty("guestCommenting");
    expect(body).not.toHaveProperty("level");
  });

  it("editorsCanShare is owner-only — sent for owner, never for an editor (C-003)", async () => {
    const owner = setup(RESTRICTED, "owner");
    act(() => owner.result.current.toggleEditorsCanShare());
    await waitFor(() => expect(setAccess).toHaveBeenLastCalledWith("ws", "doc", expect.objectContaining({ editorsCanShare: true })));

    setAccess.mockClear();
    const editor = setup(RESTRICTED, "editor");
    // an editor can't toggle it (no-op)
    act(() => editor.result.current.toggleEditorsCanShare());
    expect(setAccess).not.toHaveBeenCalled();
    // and a different change as an editor never carries editorsCanShare
    act(() => editor.result.current.chooseLinkRole("commenter"));
    await waitFor(() => expect(setAccess).toHaveBeenCalled());
    expect(setAccess.mock.calls[0]?.[2]).not.toHaveProperty("editorsCanShare");
  });

  it("owner-ness comes from the read's viewerRole when effectiveRole is absent (docs-list entry)", async () => {
    const fromRead = { ...RESTRICTED, viewerRole: "owner" as const };
    const { result } = setup(fromRead, undefined);
    act(() => result.current.toggleEditorsCanShare());
    await waitFor(() =>
      expect(setAccess).toHaveBeenLastCalledWith("ws", "doc", expect.objectContaining({ editorsCanShare: true })),
    );
  });

  it("derives isLink + the legacy level summary from the two axes", () => {
    expect(setup(RESTRICTED).result.current.level).toBe("restricted");
    expect(setup(WORKSPACE).result.current.level).toBe("anyone_in_workspace");
    const linkOnly = { ...RESTRICTED, linkRole: "viewer" as const };
    const r = setup(linkOnly).result.current;
    expect(r.level).toBe("anyone_with_link");
    expect(r.isLink).toBe(true);
    expect(setup(WORKSPACE).result.current.isLink).toBe(false);
  });
});
