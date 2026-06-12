import { describe, it, expect, mock, beforeEach } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// sharing-permissions-ui S-005 — Link controls. The sharing client (`setLinkControls`) is MOCKED so
// the optimistic-then-revert path is deterministic. LinkControls is exercised directly: Copy writes
// the URL to the clipboard + toasts (AS-015); setting a control sends ONLY that control + marks the
// chip "set", others independent (AS-016/C-001); a refused write reverts the chip + errors (AS-017).

import * as sharingClient from "@/features/sharing/client";

const setLinkControls = mock(async () => ({ data: OK_LINK, error: null as unknown }));
mock.module("@/features/sharing/client", () => ({ ...sharingClient, setLinkControls }));

const toastSuccess = mock(() => {});
const toastError = mock(() => {});
mock.module("sonner", () => ({
  toast: Object.assign(mock(() => {}), { success: toastSuccess, error: toastError }),
}));

const OK_LINK = { hasPassword: true, url: "anchord.local/d/web-core", expiresAt: null, viewLimit: null, viewCount: 0 };
const UNSET_LINK = { hasPassword: false, url: "anchord.local/d/web-core", expiresAt: null, viewLimit: null, viewCount: 0 };

const { LinkControls } = await import("@/features/sharing/components/link-controls");

beforeEach(() => {
  setLinkControls.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  setLinkControls.mockImplementation(async () => ({ data: OK_LINK, error: null }));
});

function renderLink() {
  return render(<LinkControls workspaceId="ws-1" slug="web-core" link={UNSET_LINK} />);
}

describe("Sharing S-005 — link controls", () => {
  it("AS-015: Copy writes the share URL to the clipboard and shows a toast", async () => {
    const user = userEvent.setup();
    renderLink();
    await user.click(screen.getByTestId("share-link-copy"));
    // happy-dom has a real in-memory clipboard — assert the URL round-trips through it.
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("anchord.local/d/web-core"),
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("AS-016 / C-001: setting the password sends ONLY that control and marks the chip set", async () => {
    const user = userEvent.setup();
    renderLink();

    await user.click(screen.getByTestId("share-link-password")); // open the inline editor
    await user.type(screen.getByTestId("share-link-editor-input"), "s3cret");
    await user.click(screen.getByTestId("share-link-editor-set"));

    await waitFor(() => expect(setLinkControls).toHaveBeenCalledTimes(1));
    // independence (C-001): only `password` is in the payload — not expiry/viewLimit.
    const [, , body] = setLinkControls.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(body).toEqual({ password: "s3cret" });
    // the chip reads "set".
    await waitFor(() => expect(screen.getByTestId("share-link-password")).toHaveAttribute("data-on", "1"));
    // expiry + view-limit remain independent/unset.
    expect(screen.getByTestId("share-link-expiry")).toHaveAttribute("data-on", "0");
    expect(screen.getByTestId("share-link-limit")).toHaveAttribute("data-on", "0");
  });

  it("AS-017 / C-005: a refused link-control change reverts the chip and shows an error", async () => {
    setLinkControls.mockImplementation(async () => ({ data: null, error: { status: 403 } }));
    const user = userEvent.setup();
    renderLink();

    await user.click(screen.getByTestId("share-link-password"));
    await user.type(screen.getByTestId("share-link-editor-input"), "s3cret");
    await user.click(screen.getByTestId("share-link-editor-set"));

    await waitFor(() => expect(setLinkControls).toHaveBeenCalledTimes(1));
    // chip reverts to unset; error toast fired.
    await waitFor(() => expect(screen.getByTestId("share-link-password")).toHaveAttribute("data-on", "0"));
    expect(toastError).toHaveBeenCalled();
  });
});
