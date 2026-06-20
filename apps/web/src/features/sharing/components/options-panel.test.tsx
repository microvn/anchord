import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// sharing-permissions-ui S-002 — the Options tab UI: editors-can-share (owner-editable /
// read-only for an editor, C-003 / AS-009). The guest-commenting toggle was REMOVED 2026-06-20
// (a commenter+ link role IS the guest grant — Google-Docs model — so there is no toggle).
// Link protection moved to the Sharing tab (inline under access, AS-005) — covered by
// share-dialog.test + link-controls.test, not here. The mutation logic is unit-tested in
// use-access-controls.test; here we assert the rendered controls + that a toggle drives the write.

import * as sharingClient from "@/features/sharing/services/client";

const setAccess = mock(async () => ({ data: OK, error: null as unknown }));
const setLinkControls = mock(async () => ({ data: { hasPassword: true, url: "x" }, error: null as unknown }));
mock.module("@/features/sharing/services/client", () => ({ ...sharingClient, setAccess, setLinkControls }));
mock.module("sonner", () => ({ toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) }) }));

const OK = { level: "anyone_with_link" as const, role: "commenter" as const, editorsCanShare: false };
const LINK = { hasPassword: false, url: "anchord.local/d/web-core" };
const base = (over = {}) => ({ level: "restricted" as const, role: "viewer" as const, editorsCanShare: false, people: [], link: LINK, ...over });

const { OptionsPanel } = await import("@/features/sharing/components/options-panel");
const { useAccessControls } = await import("@/features/sharing/hooks/use-access-controls");

function Harness({ initial, effectiveRole = "owner" as "owner" | "editor" | undefined }: { initial: ReturnType<typeof base>; effectiveRole?: "owner" | "editor" | undefined }) {
  const controls = useAccessControls("ws", "doc", initial, effectiveRole);
  return <OptionsPanel controls={controls} />;
}

beforeEach(() => {
  setAccess.mockClear();
  setAccess.mockImplementation(async () => ({ data: OK, error: null }));
});

describe("sharing-permissions-ui S-002 — Options tab", () => {
  it("reversal 2026-06-20: there is NO guest-commenting toggle in the Options tab", () => {
    render(<Harness initial={base({ level: "anyone_with_link" })} />);
    expect(screen.queryByTestId("share-guest-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("share-sec-guest")).not.toBeInTheDocument();
    // link protection no longer lives here either — it moved to the Sharing tab (AS-005).
    expect(screen.queryByTestId("share-sec-link")).not.toBeInTheDocument();
  });

  it("AS-009: editors-can-share is an editable toggle for the owner and sends editorsCanShare", async () => {
    render(<Harness initial={base()} effectiveRole="owner" />);
    const toggle = screen.getByTestId("share-editors-can-share-toggle");
    await userEvent.click(toggle);
    await waitFor(() =>
      expect(setAccess).toHaveBeenLastCalledWith("ws", "doc", expect.objectContaining({ editorsCanShare: true })),
    );
  });

  it("AS-009: editors-can-share is read-only for an editor (no toggle, never sends editorsCanShare)", () => {
    render(<Harness initial={base({ editorsCanShare: true })} effectiveRole="editor" />);
    expect(screen.queryByTestId("share-editors-can-share-toggle")).not.toBeInTheDocument();
    expect(screen.getByTestId("share-editors-can-share-readonly")).toBeInTheDocument();
  });
});
