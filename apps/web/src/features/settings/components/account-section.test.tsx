import { describe, it, expect, mock, beforeEach, afterAll } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// account-settings S-002 — the Account section: identity readout (read-only), display-name
// edit (non-empty, ≤80), and sign out.
//
// The auth-client is MOCKED (the seam the component reads, mirroring the repo's auth-mock
// pattern). bun's mock.module is process-wide, so we mirror EVERY export of the real module.
// Mutable handles let each test assert calls / control return values; reset in afterAll to
// avoid leaking into sibling test files (the documented bun mock.module leak).

let session: {
  user: { name: string; email: string; emailVerified?: boolean; createdAt?: string };
} | null = null;

const signOutMock = mock(async () => ({ data: { success: true }, error: null }));
const updateUserMock = mock(async (_args: { name: string }) => ({ data: {}, error: null }));
const listAccountsMock = mock(async () => ({ data: [{ providerId: "google" }], error: null }));

const toastSuccess = mock((_m: string) => {});
const toastError = mock((_m: string) => {});

mock.module("@/lib/api/auth-client", () => ({
  authClient: {
    updateUser: updateUserMock,
    listAccounts: listAccountsMock,
  },
  signIn: { email: mock(async () => ({})), social: mock(async () => ({})) },
  signUp: { email: mock(async () => ({ data: { user: {} }, error: null })) },
  signOut: signOutMock,
  sendVerificationEmail: mock(async () => ({ data: {}, error: null })),
  verifyEmail: mock(async () => ({ data: {}, error: null })),
  getSession: mock(async () => ({ data: session, error: null })),
  useSession: () => ({ data: session, isPending: false }),
  updateUser: updateUserMock,
  listAccounts: listAccountsMock,
}));

mock.module("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

const { AccountSection } = await import("@/features/settings/components/account-section");

function renderAccount() {
  return render(
    <MemoryRouter initialEntries={["/settings"]}>
      <Routes>
        <Route path="/settings" element={<AccountSection />} />
        <Route path="/signin" element={<div>sign in screen</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  session = {
    user: {
      name: "Hoang Nguyen",
      email: "hoang@mobilefolk.com",
      emailVerified: true,
      createdAt: "2026-06-10T00:00:00.000Z",
    },
  };
  signOutMock.mockClear();
  updateUserMock.mockClear();
  updateUserMock.mockImplementation(async () => ({ data: {}, error: null }));
  listAccountsMock.mockClear();
  listAccountsMock.mockImplementation(async () => ({ data: [{ providerId: "google" }], error: null }));
  toastSuccess.mockClear();
  toastError.mockClear();
});

afterAll(() => {
  // Reset shared mutable mock state so it doesn't leak into other test files.
  session = null;
  signOutMock.mockClear();
  updateUserMock.mockClear();
  listAccountsMock.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});

describe("account-settings S-002 — Account section", () => {
  it("AS-005: identity readout shows email, provider, verified, join date; email is not editable", async () => {
    renderAccount();

    // Email + join date come from the session user.
    expect(screen.getByTestId("account-identity-line")).toHaveTextContent("hoang@mobilefolk.com");
    expect(screen.getByTestId("account-identity-line")).toHaveTextContent(/joined June 2026/i);
    // Verified badge from emailVerified.
    expect(screen.getByTestId("account-verified-badge")).toHaveTextContent(/verified/i);
    // Provider from the account record (listAccounts → google), resolved async.
    await waitFor(() =>
      expect(screen.getByTestId("account-provider-badge")).toHaveTextContent(/google/i),
    );
    // Email is read-only (C-003) — the input carries the readonly attribute.
    expect(screen.getByTestId("account-email")).toHaveAttribute("readonly");
  });

  it("AS-006: editing and saving the display name persists it (calls updateUser with the new name)", async () => {
    const user = userEvent.setup();
    renderAccount();

    const input = screen.getByTestId("account-display-name") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Hoang N.");
    await user.click(screen.getByTestId("account-save"));

    await waitFor(() => expect(updateUserMock).toHaveBeenCalledTimes(1));
    expect(updateUserMock).toHaveBeenCalledWith({ name: "Hoang N." });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("AS-007: clearing the display name and saving is refused; the stored name is unchanged (no updateUser)", async () => {
    const user = userEvent.setup();
    renderAccount();

    const input = screen.getByTestId("account-display-name") as HTMLInputElement;
    await user.clear(input);
    // The Save button is disabled for an empty name → it cannot persist.
    expect(screen.getByTestId("account-save")).toBeDisabled();
    // A clear error message is shown and nothing is written.
    expect(screen.getByTestId("account-name-error")).toHaveTextContent(/empty/i);
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("AS-013: an 81-character display name is refused; the stored name is unchanged (no updateUser)", async () => {
    const user = userEvent.setup();
    renderAccount();

    const input = screen.getByTestId("account-display-name") as HTMLInputElement;
    const tooLong = "a".repeat(81);
    await user.clear(input);
    await user.type(input, tooLong);

    expect(screen.getByTestId("account-save")).toBeDisabled();
    expect(screen.getByTestId("account-name-error")).toHaveTextContent(/80 characters or fewer/i);
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("C-004: an exactly-80-character display name is accepted (boundary)", async () => {
    const user = userEvent.setup();
    renderAccount();

    const input = screen.getByTestId("account-display-name") as HTMLInputElement;
    const exactly80 = "b".repeat(80);
    await user.clear(input);
    await user.type(input, exactly80);

    expect(screen.getByTestId("account-save")).not.toBeDisabled();
    await user.click(screen.getByTestId("account-save"));
    await waitFor(() => expect(updateUserMock).toHaveBeenCalledWith({ name: exactly80 }));
  });

  it("AS-008: activating sign out ends the session and returns to the signed-out entry", async () => {
    const user = userEvent.setup();
    renderAccount();

    await user.click(screen.getByTestId("account-sign-out"));

    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/sign in screen/i)).toBeInTheDocument();
  });

  it("AS-005: the readout still renders identity fields when the provider source is unavailable", async () => {
    listAccountsMock.mockImplementation(async () => {
      throw new Error("no provider surface");
    });
    renderAccount();

    // Email/verified still render even though the provider badge is absent.
    expect(screen.getByTestId("account-identity-line")).toHaveTextContent("hoang@mobilefolk.com");
    expect(screen.getByTestId("account-verified-badge")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("account-provider-badge")).not.toBeInTheDocument());
  });
});
