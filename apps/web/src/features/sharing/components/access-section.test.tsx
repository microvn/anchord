import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// doc-access-two-axis S-007 — the "Who can read?" zone, now TWO INDEPENDENT controls (C-001):
// Workspace access + Link access, each {Off, Viewer, Commenter, Editor}. AccessSection is fed by
// `useAccessControls` (the mutation engine is unit-tested in use-access-controls.test); here we
// exercise the rendered controls through a harness that wires the real hook, so a role pick on the
// LINK axis drives PUT …/access with ONLY the link axis (AS-024 / C-011), and each axis offers
// off/viewer/commenter/editor — never owner (AS-023 / C-004/C-009). Pixel/responsive layout is [→MANUAL].

import * as sharingClient from "@/features/sharing/services/client";

const setAccess = mock(async () => ({ data: OK_RESULT, error: null as unknown }));
mock.module("@/features/sharing/services/client", () => ({ ...sharingClient, setAccess }));

const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: mock(() => {}), error: toastError }),
}));

const OK_RESULT = { workspaceRole: "commenter" as const, linkRole: "viewer" as const, level: "anyone_with_link" as const, editorsCanShare: false };
// A doc shared with the workspace at commenter, no public link (the new-doc default).
const WORKSPACE_STATE = {
  workspaceRole: "commenter" as const,
  linkRole: null,
  level: "anyone_in_workspace" as const,
  role: "viewer" as const,
  editorsCanShare: false,
  people: [],
  link: { hasPassword: false, url: "anchord.local/d/web-core" },
};

const { AccessSection } = await import("@/features/sharing/components/access-section");
const { useAccessControls } = await import("@/features/sharing/hooks/use-access-controls");

function Harness({ initial = WORKSPACE_STATE, effectiveRole = "owner" as "owner" | "editor" | undefined }) {
  const controls = useAccessControls("ws-acme", "web-core", initial, effectiveRole);
  return <AccessSection controls={controls} />;
}

function renderSection(initialOverrides: Partial<typeof WORKSPACE_STATE> = {}) {
  return render(<Harness initial={{ ...WORKSPACE_STATE, ...initialOverrides }} />);
}

async function chooseAxisRole(axis: "workspace" | "link", label: string) {
  await userEvent.click(screen.getByTestId(`share-axis-${axis}-trigger`));
  await userEvent.click(await screen.findByRole("option", { name: label }));
}

beforeEach(() => {
  setAccess.mockClear();
  toastError.mockClear();
  setAccess.mockImplementation(async () => ({ data: OK_RESULT, error: null }));
});

describe("doc-access-two-axis S-007 — two independent access controls", () => {
  it("AS-023: renders a Workspace access control AND a Link access control, prefilled from the two-axis state", async () => {
    renderSection();
    // Two distinct controls — workspace ON at commenter, link OFF.
    expect(screen.getByTestId("share-axis-workspace")).toHaveAttribute("data-on", "1");
    expect(screen.getByTestId("share-axis-workspace-trigger")).toHaveTextContent(/commenter/i);
    expect(screen.getByTestId("share-axis-link")).toHaveAttribute("data-on", "0");
    expect(screen.getByTestId("share-axis-link-trigger")).toHaveTextContent(/off/i);
    // Each control self-describes.
    expect(screen.getByTestId("share-axis-desc-workspace")).toHaveTextContent(/every member of this workspace/i);
    expect(screen.getByTestId("share-axis-desc-link")).toHaveTextContent(/no sign-in needed/i);
  });

  it("AS-023: each axis offers Off | Viewer | Commenter | Editor — never Owner (C-004/C-009)", async () => {
    renderSection();
    await userEvent.click(screen.getByTestId("share-axis-workspace-trigger"));
    await screen.findByRole("option", { name: "Off" });
    expect(screen.getByRole("option", { name: "Viewer" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Commenter" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Editor" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Owner" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(4);
  });

  it("AS-024: picking a link role fires PUT /access with ONLY the link axis (workspace untouched)", async () => {
    renderSection();
    await chooseAxisRole("link", "Viewer");
    await waitFor(() => expect(setAccess).toHaveBeenCalled());
    const body = setAccess.mock.calls.at(-1)?.[2] as Record<string, unknown>;
    expect(body).toHaveProperty("linkRole", "viewer");
    expect(body).not.toHaveProperty("workspaceRole");
    // The link control becomes ON; the workspace control is unchanged.
    await waitFor(() => expect(screen.getByTestId("share-axis-link")).toHaveAttribute("data-on", "1"));
    expect(screen.getByTestId("share-axis-workspace-trigger")).toHaveTextContent(/commenter/i);
  });

  it("a refused PUT reverts the changed axis and shows an error toast (C-005)", async () => {
    setAccess.mockImplementation(async () => ({ data: null, error: { status: 403 } }));
    renderSection();
    await chooseAxisRole("link", "Viewer");
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("Couldn't update access"));
    expect(screen.getByTestId("share-axis-link")).toHaveAttribute("data-on", "0");
  });
});
