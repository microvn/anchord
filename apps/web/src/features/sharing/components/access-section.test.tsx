import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// sharing-permissions-ui S-002 — the "Who can read?" radio rows + role (the presentational half).
// AccessSection is now fed by `useAccessControls` (the mutation engine is unit-tested in
// use-access-controls.test). Here we exercise the rendered rows through a small harness that wires
// the real hook, so a row click still drives the optimistic PUT …/access (AS-005), a refused write
// reverts the active row (AS-006), and the role dropdown offers only viewer|commenter|editor (AS-007,
// C-004). Guest (AS-008) + editors-can-share (AS-009) live on the Options tab now — see
// options-panel.test. Pixel/responsive layout is [→MANUAL].

import * as sharingClient from "@/features/sharing/services/client";

const setAccess = mock(async () => ({ data: OK_RESULT, error: null as unknown }));
mock.module("@/features/sharing/services/client", () => ({ ...sharingClient, setAccess }));

const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }),
}));

const OK_RESULT = { level: "anyone_with_link" as const, role: "commenter" as const, guestCommenting: false, editorsCanShare: false };
const RESTRICTED_STATE = {
  level: "restricted" as const,
  role: "viewer" as const,
  guestCommenting: false,
  editorsCanShare: false,
  people: [],
  link: { hasPassword: false, url: "anchord.local/d/web-core" },
};

const { AccessSection } = await import("@/features/sharing/components/access-section");
const { useAccessControls } = await import("@/features/sharing/hooks/use-access-controls");

function Harness({ initial = RESTRICTED_STATE, effectiveRole = "owner" as "owner" | "editor" | undefined }) {
  const controls = useAccessControls("ws-acme", "web-core", initial, effectiveRole);
  return <AccessSection controls={controls} />;
}

function renderSection(initialOverrides: Partial<typeof RESTRICTED_STATE> = {}) {
  return render(<Harness initial={{ ...RESTRICTED_STATE, ...initialOverrides }} />);
}

beforeEach(() => {
  setAccess.mockClear();
  toastError.mockClear();
  setAccess.mockImplementation(async () => ({ data: OK_RESULT, error: null }));
});

describe("sharing-permissions-ui S-002 — who-can-read access rows", () => {
  it("AS-005: selecting Anyone-with-link calls PUT /access and the row becomes active", async () => {
    renderSection();
    await userEvent.click(screen.getByTestId("share-access-opt-anyone_with_link"));
    await waitFor(() =>
      expect(setAccess).toHaveBeenCalledWith("ws-acme", "web-core", expect.objectContaining({ level: "anyone_with_link" })),
    );
    expect(screen.getByTestId("share-access-opt-anyone_with_link")).toHaveAttribute("data-active", "1");
    // the row self-describes — no separate hint line needed
    expect(screen.getByTestId("share-access-desc-anyone_with_link")).toHaveTextContent(/no sign-in needed/i);

    // change role to commenter via the Select
    await userEvent.click(screen.getByTestId("share-access-role-trigger"));
    await userEvent.click(await screen.findByRole("option", { name: "Commenter" }));
    await waitFor(() =>
      expect(setAccess).toHaveBeenLastCalledWith("ws-acme", "web-core", expect.objectContaining({ role: "commenter" })),
    );
  });

  it("AS-006: a refused PUT /access reverts the active row and shows an error toast", async () => {
    setAccess.mockImplementation(async () => ({ data: null, error: { status: 403 } }));
    renderSection();
    await userEvent.click(screen.getByTestId("share-access-opt-anyone_with_link"));
    await waitFor(() =>
      expect(screen.getByTestId("share-access-opt-restricted")).toHaveAttribute("data-active", "1"),
    );
    expect(screen.getByTestId("share-access-opt-anyone_with_link")).toHaveAttribute("data-active", "0");
    expect(toastError).toHaveBeenCalledWith("Couldn't update access");
  });

  it("AS-007: the access role dropdown offers ONLY viewer | commenter | editor — never owner", async () => {
    renderSection();
    await userEvent.click(screen.getByTestId("share-access-role-trigger"));
    await screen.findByRole("option", { name: "Viewer" });
    expect(screen.getByRole("option", { name: "Commenter" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Editor" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Owner" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });
});
