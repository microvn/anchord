import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// sharing-permissions-ui S-002 — the Options tab UI: guest commenting (gated to anyone-with-link,
// C-001 / AS-008) and editors-can-share (owner-editable / read-only for an editor, C-003 / AS-009),
// plus the link-protection sub-section that only shows the chips when shared by link. The mutation
// logic is unit-tested in use-access-controls.test; here we assert the rendered controls + that a
// toggle drives the write. Fed through a harness that wires the real hook.

import * as sharingClient from "@/features/sharing/services/client";

const setAccess = mock(async () => ({ data: OK, error: null as unknown }));
const setLinkControls = mock(async () => ({ data: { hasPassword: true, url: "x" }, error: null as unknown }));
mock.module("@/features/sharing/services/client", () => ({ ...sharingClient, setAccess, setLinkControls }));
mock.module("sonner", () => ({ toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: mock(() => {}) }) }));

const OK = { level: "anyone_with_link" as const, role: "commenter" as const, guestCommenting: false, editorsCanShare: false };
const LINK = { hasPassword: false, url: "anchord.local/d/web-core" };
const base = (over = {}) => ({ level: "restricted" as const, role: "viewer" as const, guestCommenting: false, editorsCanShare: false, people: [], link: LINK, ...over });

const { OptionsPanel } = await import("@/features/sharing/components/options-panel");
const { useAccessControls } = await import("@/features/sharing/hooks/use-access-controls");

function Harness({ initial, effectiveRole = "owner" as "owner" | "editor" | undefined }: { initial: ReturnType<typeof base>; effectiveRole?: "owner" | "editor" | undefined }) {
  const controls = useAccessControls("ws", "doc", initial, effectiveRole);
  return <OptionsPanel workspaceId="ws" slug="doc" controls={controls} link={initial.link} />;
}

beforeEach(() => {
  setAccess.mockClear();
  setAccess.mockImplementation(async () => ({ data: OK, error: null }));
});

describe("sharing-permissions-ui S-002 — Options tab", () => {
  it("AS-008: guest toggle is disabled (with the gated hint) off anyone-with-link", () => {
    render(<Harness initial={base({ level: "restricted" })} />);
    expect(screen.getByTestId("share-guest-toggle")).toBeDisabled();
    expect(screen.getByTestId("share-sec-guest")).toHaveTextContent(/available only for anyone with link/i);
    // link chips are hidden; a hint explains why
    expect(screen.queryByTestId("share-sec-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("share-link-options-disabled")).toBeInTheDocument();
  });

  it("AS-008: on anyone-with-link the guest toggle is enabled and sends guestCommenting:true", async () => {
    render(<Harness initial={base({ level: "anyone_with_link" })} />);
    const guest = screen.getByTestId("share-guest-toggle");
    expect(guest).not.toBeDisabled();
    // link chips now visible
    expect(screen.getByTestId("share-sec-link")).toBeInTheDocument();
    await userEvent.click(guest);
    await waitFor(() =>
      expect(setAccess).toHaveBeenLastCalledWith("ws", "doc", expect.objectContaining({ guestCommenting: true })),
    );
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
